// Opt-in live prompt evaluation: real voice model, synthetic Pi messages/tools.
// Generates audio over WebSocket (not a browser microphone/WebRTC test); incurs token charges.
import WebSocket from "ws";
import { openAIConnectionConfig } from "../../.pi/extensions/pi-realtime/providers/openai/connection";
import { companionInstructions, companionTools } from "../../.pi/extensions/pi-realtime/companion/prompt";
import assert from "node:assert/strict";
async function main() {
	const c = openAIConnectionConfig();
	const url = new URL(c.baseURL + "/realtime");
	url.protocol = "wss:";
	url.searchParams.set("model", c.model);
	if (!c.apiKey) throw new Error("Realtime credential missing");
	const headers = c.authMode === "api-key" ? { "api-key": c.apiKey } : { Authorization: `Bearer ${c.apiKey}` };
	const ws = new WebSocket(url, { headers, handshakeTimeout: 10000 });
	const events: any[] = [];
	let fatal = "";
	const progressText =
		"The narrowed change passed unit tests, all nine workspace type checks, lint, formatting, and the production build. Unit validation took 14.3 seconds, type checks 6.3 seconds, and the build 14.9 seconds. Only the user form, its schema, shared validation support, and supporting tests/docs remain changed. I am recording the results and committing locally; nothing will be pushed yet.";
	const send = (v: any) => ws.send(JSON.stringify(v));
	const wait = async (predicate: () => boolean) => {
		const end = Date.now() + 20000;
		while (!predicate()) {
			if (fatal) throw Error(fatal);
			if (Date.now() > end) throw Error("Timed out");
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	const item = (role: string, text: string) =>
		send({
			type: "conversation.item.create",
			item: { type: "message", role, content: [{ type: "input_text", text }] },
		});
	ws.on("error", () => {
		fatal = "WebSocket failure";
	});
	ws.on("message", (data) => {
		const e = JSON.parse(data.toString());
		events.push(e);
		if (e.type === "error") fatal = "Provider error: " + e.error?.code;
		if (e.type === "response.function_call_arguments.done")
			send({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: e.call_id,
					output: JSON.stringify(
						e.name === "post_message"
							? { posted: true, delivery: "queued", note: "Pi continues normally. Observe its forthcoming output." }
							: e.name === "read_pi_history"
								? [{ id: "progress", role: "assistant", text: progressText }]
								: { busy: true, recent: [{ id: "progress", role: "assistant", text: progressText }] },
					),
				},
			});
	});
	const response = async () => {
		const start = events.length;
		send({ type: "response.create", response: { output_modalities: ["audio"] } });
		await wait(() => events.slice(start).some((e) => e.type === "response.done"));
		return events.slice(start);
	};
	try {
		await wait(() => events.some((e) => e.type === "session.created"));
		send({
			type: "session.update",
			session: {
				type: "realtime",
				instructions: companionInstructions(),
				tools: companionTools(),
				tool_choice: "auto",
				output_modalities: ["audio"],
			},
		});
		await wait(() => events.some((e) => e.type === "session.updated"));
		item("user", "Please run the checks and commit locally. Do not push.");
		const initial = await response();
		assert(initial.some((e) => e.type === "response.function_call_arguments.done" && e.name === "post_message"));
		const count = events.filter((e) => e.type === "response.created").length;
		await new Promise((r) => setTimeout(r, 1800));
		assert.equal(
			events.filter((e) => e.type === "response.created").length,
			count,
			"Queued receipt started an extra response",
		);
		console.log("PASS: posted request; queue receipt did not trigger a new response");
		item(
			"system",
			JSON.stringify({
				type: "pi_observation",
				busy: true,
				messages: [{ id: "progress", role: "assistant", text: progressText }],
			}),
		);
		const progress = await response();
		const text = progress
			.filter((e) => e.type === "response.output_audio_transcript.done")
			.map((e) => e.transcript)
			.join(" ");
		assert(text.length > 0);
		assert(
			!progress.some((e) => e.type === "response.function_call_arguments.done"),
			"Progress triggered an unnecessary tool",
		);
		assert(/pass/i.test(text) && /local/i.test(text) && /push/i.test(text), text);
		assert(!/\b(committed|pushed successfully)\b/i.test(text), text);
		console.log("LIVE progress:", text);
		item("user", "How long did unit validation take?");
		const detail = await response();
		if (
			detail.some(
				(e) =>
					e.type === "response.function_call_arguments.done" && ["get_pi_status", "read_pi_history"].includes(e.name),
			)
		)
			detail.push(...(await response()));
		const answer = detail
			.filter((e) => e.type === "response.output_audio_transcript.done")
			.map((e) => e.transcript)
			.join(" ");
		assert(
			!detail.some((e) => e.type === "response.function_call_arguments.done" && e.name === "post_message"),
			"Existing detail caused unnecessary Pi work",
		);
		assert(/14\.3|fourteen.point.three/i.test(answer), answer);
		console.log("LIVE detail:", answer);
		console.log("PASS: concise progress and follow-up detail from unchanged original message");
	} finally {
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				ws.terminate();
				resolve();
			}, 2000);
			ws.once("close", () => {
				clearTimeout(t);
				resolve();
			});
			if (ws.readyState === WebSocket.OPEN) ws.close();
			else ws.terminate();
		});
		console.log("CLEANUP provider socket closed");
	}
}
main().catch((e) => {
	console.error(String(e.message || e.name));
	process.exitCode = 1;
});
