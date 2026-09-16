// Opt-in: real voice model, synthetic Pi messages/tools; incurs provider token charges.
// PI_READBACK_SIDE_AUDIO optionally supplies 24 kHz mono signed-16-bit LE PCM of a side conversation.
// This is a WebSocket model/audio test, not a physical microphone or WebRTC network test.
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { openAIConnectionConfig } from "../../.pi/extensions/pi-realtime/providers/openai/connection";
import { awaitRealtimeSocketOpen } from "../../.pi/extensions/pi-realtime/providers/openai/socket-open";
import {
	companionInstructions,
	companionTools,
	readbackResponse,
	nativeInputResponsePolicy,
} from "../../.pi/extensions/pi-realtime/companion/prompt";
import {
	buildOpenAIRealtimeAudioConfig,
	openAIRealtimeAudioInput,
} from "../../.pi/extensions/pi-realtime/providers/openai/session-config";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";

async function main() {
	const config = openAIConnectionConfig();
	if (!config.apiKey) throw new Error("Realtime credential missing");
	const url = new URL(config.baseURL + "/realtime");
	url.protocol = "wss:";
	url.searchParams.set("model", config.model);
	const headers =
		config.authMode === "api-key" ? { "api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` };
	const ws = new WebSocket(url, { headers, handshakeTimeout: 10000 });
	const events: any[] = [];
	let fatal = "";
	let audioBytes = 0;
	const send = (event: any) => ws.send(JSON.stringify(event));
	ws.on("error", () => {
		fatal = "Provider WebSocket failure";
	});
	ws.on("message", (data) => {
		const event = JSON.parse(data.toString());
		if (event.type === "response.output_audio.delta") {
			audioBytes += Buffer.from(event.delta, "base64").length;
			return; // Do not retain generated audio in diagnostic output.
		}
		events.push(event);
		if (event.type === "error") fatal = `Provider error: ${event.error?.code}`;
		if (event.type !== "response.function_call_arguments.done") return;
		const result =
			event.name === "post_message"
				? { posted: true, delivery: "queued" }
				: event.name === "wait_for_user"
					? { waiting: true }
					: event.name === "save_voice_memory"
						? { saved: true }
						: { error: "Unexpected fixture tool" };
		send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(result) },
		});
	});
	const wait = async (predicate: () => boolean) => {
		const end = Date.now() + 20000;
		while (!predicate()) {
			if (fatal) throw Error(fatal);
			if (Date.now() > end) throw Error("Provider evaluation timed out");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const item = (role: string, text: string) =>
		send({
			type: "conversation.item.create",
			item: { type: "message", role, content: [{ type: "input_text", text }] },
		});
	const response = async (readback?: string, latestUserText?: string) => {
		const start = events.length;
		send({
			type: "response.create",
			response: readback
				? readbackResponse([{ id: "fixture", role: "assistant", text: readback, at: 0 }], latestUserText)
				: {},
		});
		await wait(() => events.slice(start).some((event) => event.type === "response.done"));
		return events.slice(start);
	};
	const audioTurn = async (path: string) => {
		const pcm = readFileSync(path);
		const start = events.length;
		for (let offset = 0; offset < pcm.length; offset += 4800) {
			send({ type: "input_audio_buffer.append", audio: pcm.subarray(offset, offset + 4800).toString("base64") });
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await wait(() => events.slice(start).some((event) => event.type === "response.done"));
		return events.slice(start);
	};
	const calls = (turn: any[]) => turn.filter((event) => event.type === "response.function_call_arguments.done");
	const transcript = (turn: any[]) =>
		turn
			.filter((event) => event.type === "response.output_audio_transcript.done")
			.map((event) => event.transcript)
			.join(" ");
	const assertForward = (turn: any[], words: string) => {
		const posts = calls(turn).filter((event) => event.name === "post_message");
		assert.equal(
			posts.length,
			1,
			JSON.stringify(
				turn.filter((event) => ["response.done", "response.function_call_arguments.done"].includes(event.type)),
			),
		);
		assert.deepEqual(
			JSON.parse(posts[0].arguments),
			{ message: words },
			"Relay added interpretation or model-selected origin",
		);
		assert.equal(transcript(turn), "", "Relay spoke independently instead of waiting for Pi");
	};
	const assertWait = (turn: any[]) => {
		assert(
			calls(turn).some((event) => event.name === "wait_for_user"),
			JSON.stringify(calls(turn)),
		);
		assert(!calls(turn).some((event) => event.name === "post_message"), "Side conversation created Pi work");
		assert.equal(transcript(turn), "", "Side conversation caused speech");
	};
	try {
		await awaitRealtimeSocketOpen(ws, config.apiKey);
		await wait(() => events.some((event) => event.type === "session.created"));
		send({
			type: "session.update",
			session: {
				type: "realtime",
				instructions: companionInstructions(),
				tools: companionTools(),
				...nativeInputResponsePolicy(),
				audio: buildOpenAIRealtimeAudioConfig({
					...openAIRealtimeAudioInput(providerInteractionFor("agent")),
					includeRawPcmFormat: true,
					includeRawPcmOutputFormat: true,
				}),
			},
		});
		await wait(() => events.some((event) => event.type === "session.updated"));
		const request = "你能看到这个项目吗？这个项目是干啥的？";
		item("user", request);
		assertForward(await response(), request);
		const count = events.filter((event) => event.type === "response.created").length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(
			events.filter((event) => event.type === "response.created").length,
			count,
			"Receipt triggered another response",
		);
		console.log("PASS: Chinese request forwarded faithfully; receipt stayed silent");

		const progressText =
			"Unit tests, all nine workspace type checks, lint, formatting, and the production build passed. Unit validation took 14.3 seconds. I am committing locally; nothing will be pushed.";
		item(
			"system",
			JSON.stringify({
				type: "pi_observation",
				busy: true,
				messages: [{ id: "progress", role: "assistant", text: progressText }],
			}),
		);
		const progress = await response(progressText);
		const text = transcript(progress);
		assert.equal(calls(progress).length, 0, "Reading progress must not trigger tools");
		for (const fact of [
			/unit tests/i,
			/nine|9/i,
			/type checks/i,
			/lint/i,
			/formatting/i,
			/production build/i,
			/(?:14|fourteen)(?:\.| point )(?:3|three)/i,
			/local/i,
			/push/i,
		])
			assert.match(text, fact);
		assert.doesNotMatch(text, /\bcommitted\b/i, "Planned commit became a completed commit");
		console.log("LIVE readback:", text);

		const technical = await response(
			'I will search the web using the Jina skill. Nothing has run yet.\nCommand: node ~/.pi/agent/skills/jina-api/scripts/jina.mjs search "Pi MCP integration"\n```js\nconst result = await fetch(url);\nconsole.log(await result.json());\n```',
			"Search for Pi MCP integration and show the command.",
		);
		const technicalSpeech = transcript(technical);
		assert.equal(calls(technical).length, 0);
		assert.match(technicalSpeech, /search/i);
		assert.match(technicalSpeech, /not|nothing|yet/i);
		assert.doesNotMatch(
			technicalSpeech,
			/\bconst\b|console\s*(?:\.|dot)|fetch\s*\(|\.mjs|\bslash\b|homedir|~\/|node /i,
		);
		console.log("LIVE purpose-based speech:", technicalSpeech);
		const literal = await response("The command is `pnpm test`.", "Please read the exact command aloud.");
		assert.equal(calls(literal).length, 0);
		assert.match(transcript(literal), /p[\s.]*n[\s.]*p[\s.]*m.*test/i);
		console.log("LIVE requested dictation:", transcript(literal));

		const followUp = "How long did unit validation take?";
		item("user", followUp);
		assertForward(await response(), followUp);
		item(
			"system",
			JSON.stringify({
				type: "pi_observation",
				busy: false,
				messages: [{ id: "detail", role: "assistant", text: "Unit validation took 14.3 seconds." }],
			}),
		);
		const detail = await response("Unit validation took 14.3 seconds.");
		assert.equal(calls(detail).length, 0);
		assert.match(transcript(detail), /(?:14|fourteen)(?:\.| point )(?:3|three)/i);
		console.log("PASS: follow-up delegated to Pi; its answer read aloud:", transcript(detail));

		item("user", "老王，帮我拿一下杯子。我在跟你说话，不是在跟电脑说。");
		assertWait(await response());
		console.log("PASS: explicitly side-directed Chinese text chose silent wait");
		if (process.env.PI_READBACK_SIDE_AUDIO) {
			assertWait(await audioTurn(process.env.PI_READBACK_SIDE_AUDIO));
			console.log("PASS: synthetic Chinese side-conversation audio chose silent wait under native VAD");
		}
		if (process.env.PI_READBACK_USER_AUDIO) {
			const turn = await audioTurn(process.env.PI_READBACK_USER_AUDIO);
			const posts = calls(turn).filter((event) => event.name === "post_message");
			assert.equal(posts.length, 1, JSON.stringify(calls(turn)));
			const args = JSON.parse(posts[0].arguments);
			assert.deepEqual(Object.keys(args), ["message"]);
			assert.match(args.message, /单元测试.*多长时间/);
			assert(args.message.length < 50, "Audio follow-up was expanded into a reconstructed request");
			assert.equal(transcript(turn), "");
			console.log("PASS: native Chinese audio follow-up resumed forwarding without a wake word:", args.message);
		}
		assert(audioBytes > 0);
		console.log("PASS: real model generated audio; bytes:", audioBytes);
	} finally {
		await new Promise<void>((resolve) => {
			if (ws.readyState === WebSocket.CLOSED) return resolve();
			const timer = setTimeout(() => {
				ws.terminate();
				resolve();
			}, 2000);
			ws.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			if (ws.readyState === WebSocket.OPEN) ws.close();
			else ws.terminate();
		});
		console.log("CLEANUP provider socket closed");
	}
}
main().catch((error) => {
	console.error(String(error.message || error.name));
	process.exitCode = 1;
});
