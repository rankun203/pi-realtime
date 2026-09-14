import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { VoiceCompanion } from "../../.pi/extensions/pi-realtime/companion/runtime";
import { startupContext } from "../../.pi/extensions/pi-realtime/companion/prompt";
import type {
	PiBridge,
	PiSnapshot,
	VoiceEvent,
	VoiceTransport,
} from "../../.pi/extensions/pi-realtime/companion/types";

function fixture(directory = mkdtempSync(join(tmpdir(), "pi-companion-test-"))) {
	let now = 0;
	const pi: PiSnapshot = { sessionId: "pi-session", branchId: "root", project: "/demo", busy: false, messages: [] };
	const posted: unknown[] = [],
		lifecycle: string[] = [],
		connections: {
			sent: VoiceEvent[];
			emit: (event: VoiceEvent) => void;
			providerClose: (reason?: string) => void;
			closed: boolean;
			closeWait?: Promise<void>;
		}[] = [];
	const bridge: PiBridge = {
		snapshot: () => pi,
		history: (_before, limit) => pi.messages.slice(-(limit ?? 10)),
		async postMessage(message, origin) {
			posted.push({ message, origin });
		},
		lifecycle: (text) => lifecycle.push(text),
	};
	const transport: VoiceTransport = {
		async connect(input) {
			const connection: (typeof connections)[number] = {
				sent: [],
				emit: input.onEvent,
				providerClose: input.onClose,
				closed: false,
			};
			connections.push(connection);
			return {
				answer: "v=0\r\n",
				send: (event) => connection.sent.push(event),
				async close() {
					await connection.closeWait;
					connection.closed = true;
				},
			};
		},
	};
	const companion = new VoiceCompanion({ bridge, transport, model: "test", stateDirectory: directory, now: () => now });
	return {
		directory,
		pi,
		posted,
		lifecycle,
		connections,
		bridge,
		companion,
		advance(value: number) {
			now += value;
		},
		async cleanup() {
			await companion.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
const tool = (name: string, args: unknown, id = "tool-1") => ({
	type: "response.function_call_arguments.done",
	name,
	arguments: JSON.stringify(args),
	call_id: id,
});

test("companion: explicit takeover invalidates old tools and release tokens", async () => {
	const f = fixture();
	try {
		const first = await f.companion.connect("v=0");
		await assert.rejects(f.companion.connect("v=0"), /takeover/);
		const second = await f.companion.connect("v=0", true);
		assert.ok(f.connections[0].closed);
		await f.companion.release(first.lease);
		assert.ok(f.companion.heartbeat(second.lease).connected);
		f.connections[0].emit(tool("post_message", { message: "stale", origin: "user" }));
		f.connections[1].emit(tool("post_message", { message: "Please inspect tests", origin: "user" }));
		f.connections[1].emit(tool("post_message", { message: "Please inspect tests", origin: "user" }));
		await settle();
		assert.deepEqual(f.posted, [{ message: "Please inspect tests", origin: "user" }]);
	} finally {
		await f.cleanup();
	}
});

test("companion: queued receipts stay silent, but intermediate and final Pi messages speak once", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		const c = f.connections[0];
		c.emit(tool("post_message", { message: "Run the checks", origin: "user" }));
		await settle();
		await f.companion.tick();
		assert.ok(c.sent.some((e) => e.item?.type === "function_call_output" && JSON.parse(e.item.output).posted));
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 0, "receipt must not solicit speculation");
		f.pi.busy = true;
		f.pi.messages.push({
			id: "progress",
			role: "assistant",
			text: "Tests passed. I am committing locally; nothing will be pushed.",
			at: 1,
		});
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 1, "progress is spoken while Pi is busy");
		assert.ok(
			c.sent.some((e) => e.item?.content?.[0]?.text.includes(f.pi.messages[0].text)),
			"the original Pi message reaches voice unchanged",
		);
		c.emit({ type: "response.done" });
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 1, "unchanged progress is not repeated");
		f.pi.busy = false;
		f.pi.messages.push({ id: "final", role: "assistant", text: "Committed locally. Nothing was pushed.", at: 2 });
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 2);
		assert.equal(f.posted.length, 1, "observations never trigger new Pi work");
	} finally {
		await f.cleanup();
	}
});

test("companion: a slow posting receipt cannot erase Pi progress already pending", async () => {
	const f = fixture();
	let release!: () => void;
	try {
		await f.companion.connect("v=0");
		f.bridge.postMessage = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const c = f.connections[0];
		c.emit(tool("post_message", { message: "Run checks", origin: "user" }));
		await settle();
		f.pi.messages.push({ id: "fast-progress", role: "assistant", text: "Checking the tests.", at: 1 });
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 0);
		release();
		await settle();
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 1);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test("companion: failed posts and requested history still schedule a voice response", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		const c = f.connections[0];
		f.bridge.postMessage = async () => {
			throw new Error("Posting failed");
		};
		c.emit(tool("post_message", { message: "Run checks", origin: "user" }));
		await settle();
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 1);
		assert.ok(c.sent.some((e) => e.item?.output?.includes("Posting failed")));
		c.emit({ type: "response.done" });
		c.emit(tool("read_pi_history", { limit: 4 }, "details"));
		await settle();
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 2, "requested details can still be spoken");
	} finally {
		await f.cleanup();
	}
});

test("companion: voice-initiated messages retain origin, history reads do not post work", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		const c = f.connections[0];
		c.emit(tool("post_message", { message: "Which file contains the parser?", origin: "voice" }));
		c.emit(tool("post_message", { message: "invalid", origin: "system" }, "invalid"));
		c.emit(tool("read_pi_history", { limit: 10000 }, "read"));
		await settle();
		assert.deepEqual(f.posted, [{ message: "Which file contains the parser?", origin: "voice" }]);
		assert.ok(c.sent.some((e) => e.item?.call_id === "invalid" && JSON.parse(e.item.output).error));
	} finally {
		await f.cleanup();
	}
});

test("companion: observes Pi while preserving native turns and interruption", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		const c = f.connections[0];
		c.emit({ type: "input_audio_buffer.speech_started" });
		f.pi.messages.push({ id: "a", role: "assistant", text: "Tests reproduce the failure", at: 1 });
		await f.companion.tick();
		c.emit({ type: "input_audio_buffer.speech_stopped" });
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 0, "wait for native VAD response");
		c.emit({ type: "response.created" });
		c.emit({ type: "response.done" });
		await f.companion.tick();
		assert.equal(c.sent.filter((e) => e.type === "response.create").length, 1);
		assert.equal(f.posted.length, 0);
	} finally {
		await f.cleanup();
	}
});

test("companion: detached Pi work continues; private handover and bounded resume survive runtime replacement", async () => {
	const f = fixture();
	try {
		const first = await f.companion.connect("v=0");
		const c = f.connections[0];
		c.emit(tool("save_voice_memory", { summary: "User prefers brief answers; discussed approach A." }));
		c.emit({
			type: "response.output_audio_transcript.done",
			item_id: "spoken",
			transcript: "I’m checking the parser.",
		});
		await settle();
		await f.companion.release(first.lease);
		f.pi.messages.push({ id: "result", role: "assistant", text: "The parser is fixed.", at: 2 });
		await f.companion.tick();
		assert.equal(f.connections.length, 1, "detached observation does not connect a model");
		assert.equal(f.posted.length, 0, "Pi does not receive private handover");
		await f.companion.close();
		const resumed = fixture(f.directory);
		resumed.pi.messages = f.pi.messages;
		try {
			await resumed.companion.connect("v=0");
			const context = resumed.connections[0].sent[0].item.content[0].text;
			assert.match(context, /prefers brief answers/);
			assert.match(context, /parser is fixed/);
			const file = join(f.directory, readdirSync(f.directory)[0]);
			assert.equal(statSync(file).mode & 0o777, 0o600);
		} finally {
			await resumed.companion.close();
		}
	} finally {
		await f.cleanup();
	}
});

test("companion: missing devices expire; restarts wait for generated audio to finish", async () => {
	const f = fixture();
	try {
		let lease = (await f.companion.connect("v=0")).lease;
		f.advance(46000);
		await f.companion.tick();
		assert.ok(f.connections[0].closed);
		lease = (await f.companion.connect("v=0")).lease;
		const c = f.connections[1];
		c.emit({ type: "response.created" });
		c.emit({ type: "output_audio_buffer.started" });
		c.emit(tool("restart_voice", { summary: "Continue with the parser." }));
		await settle();
		assert.equal(f.companion.heartbeat(lease).restart, false);
		c.emit({ type: "response.done" });
		assert.equal(f.companion.heartbeat(lease).restart, false);
		c.emit({ type: "output_audio_buffer.stopped" });
		assert.equal(f.companion.heartbeat(lease).restart, true);
	} finally {
		await f.cleanup();
	}
});

test("companion: branch navigation clears private context and disconnects; session replacement cannot reuse binding", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		f.connections[0].emit(tool("save_voice_memory", { summary: "Old branch detail" }));
		await settle();
		f.pi.branchId = "other-branch";
		await f.companion.tick();
		await f.companion.connect("v=0");
		assert.doesNotMatch(f.connections[1].sent[0].item.content[0].text, /Old branch detail/);
		f.pi.sessionId = "other-session";
		await f.companion.tick();
		await assert.rejects(f.companion.connect("v=0"), /closed/);
	} finally {
		await f.cleanup();
	}
});

test("companion: a tool arriving immediately after branch navigation cannot post into the new branch", async () => {
	const f = fixture();
	try {
		await f.companion.connect("v=0");
		f.pi.branchId = "new-branch";
		f.connections[0].emit(tool("post_message", { message: "Stale branch instruction", origin: "user" }));
		await settle();
		assert.equal(f.posted.length, 0);
		assert.ok(f.connections[0].closed);
	} finally {
		await f.cleanup();
	}
});

test("companion: slow old-branch teardown cannot overwrite a fresh device's memory", async () => {
	const f = fixture();
	let release!: () => void;
	try {
		await f.companion.connect("v=0");
		f.connections[0].closeWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.pi.branchId = "new-branch";
		const retiring = f.companion.tick();
		await settle();
		const fresh = await f.companion.connect("v=0");
		f.connections[1].emit(tool("save_voice_memory", { summary: "Fresh branch context" }));
		await settle();
		release();
		await retiring;
		await f.companion.release(fresh.lease);
		await f.companion.connect("v=0");
		assert.match(f.connections[2].sent[0].item.content[0].text, /Fresh branch context/);
	} finally {
		release?.();
		await f.cleanup();
	}
});

test("companion: provider close cause survives heartbeat without affecting a newer device", async () => {
	const f = fixture();
	try {
		const first = await f.companion.connect("v=0");
		f.connections[0].providerClose("Provider control connection closed (1000): media timeout");
		await settle();
		assert.ok(f.connections[0].closed);
		assert.throws(() => f.companion.heartbeat(first.lease), /media timeout/);
		assert.throws(() => f.companion.heartbeat("unknown-token"), /expired or taken over/);
		const second = await f.companion.connect("v=0");
		f.connections[0].providerClose("stale close");
		assert.ok(f.companion.heartbeat(second.lease).connected);
		f.advance(46000);
		await f.companion.tick();
		assert.throws(() => f.companion.heartbeat(second.lease), /heartbeat expired after 45 seconds/);
	} finally {
		await f.cleanup();
	}
});

test("companion: startup never dumps the entire Pi or voice history", () => {
	const messages = Array.from({ length: 500 }, (_, i) => ({
		id: String(i),
		role: "assistant" as const,
		text: "x".repeat(20000),
		at: i,
	}));
	const text = startupContext(
		{ sessionId: "pi", branchId: "root", busy: false, project: "/demo", messages },
		{ version: 1, sessionId: "pi", branchId: "root", summary: "Brief handover", turns: messages, observedIds: [] },
	);
	assert.ok(text.length < 50000);
	assert.doesNotMatch(text, /"id":"0"/);
});
