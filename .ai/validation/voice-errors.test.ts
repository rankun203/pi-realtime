import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VoiceTransportError,
	safeErrorDetails,
	voiceOperation,
} from "../../.pi/extensions/pi-realtime/transport-errors";
import { openAIVoiceTransport } from "../../.pi/extensions/pi-realtime/companion/openai";
import { createWebRTCHelperServer } from "../../.pi/extensions/pi-realtime/media/webrtc-helper/server";

const secret = "DO_NOT_LOG_CREDENTIAL_OR_SDP";
const dnsFailure = () =>
	new TypeError(`fetch failed ${secret}`, {
		cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${secret}`), { code: "ENOTFOUND" }),
	});

test("voice diagnostics retain nested causes without leaking raw messages or arbitrary codes", async () => {
	const error = new TypeError(secret, {
		cause: new AggregateError([
			Object.assign(new Error(secret), { code: "ECONNRESET" }),
			Object.assign(new Error(secret), { code: "ETIMEDOUT" }),
			Object.assign(new Error(secret), { code: secret }),
		]),
	});
	assert.deepEqual(safeErrorDetails(error).codes, ["ECONNRESET", "ETIMEDOUT"]);
	await assert.rejects(
		voiceOperation("Create realtime session", `https://user:${secret}@example.test/path?token=${secret}`, async () => {
			throw dnsFailure();
		}),
		(e: any) => {
			assert(e instanceof VoiceTransportError);
			assert.match(e.message, /Create realtime session.*example.test.*DNS.*ENOTFOUND/);
			assert(!JSON.stringify(e).includes(secret));
			return true;
		},
	);
	await assert.rejects(
		voiceOperation("Close voice call", "https://example.test", async () => {
			throw new DOMException(secret, "TimeoutError");
		}),
		/timed out/,
	);
});

test("actual transport labels session creation and negotiation failures and omits provider bodies", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-voice-errors-"));
	const env = { ...process.env };
	const originalFetch = globalThis.fetch;
	Object.assign(process.env, {
		PI_CODING_AGENT_DIR: directory,
		OPENAI_API_KEY: secret,
		OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1",
		OPENAI_AUTH_MODE: "api-key",
	});
	const input = { sdp: "v=0 " + secret, model: "test", instructions: "", tools: [], onEvent() {}, onClose() {} };
	try {
		globalThis.fetch = async () => {
			throw dnsFailure();
		};
		await assert.rejects(openAIVoiceTransport().connect(input), /Create realtime session.*ENOTFOUND/);
		globalThis.fetch = async () => new Response(secret, { status: 401 });
		await assert.rejects(openAIVoiceTransport().connect(input), (e: any) => {
			assert.match(e.message, /HTTP 401/);
			assert(!JSON.stringify(e).includes(secret));
			return true;
		});
		let calls = 0;
		globalThis.fetch = async () => {
			if (++calls === 1) return Response.json({ value: secret });
			throw dnsFailure();
		};
		await assert.rejects(openAIVoiceTransport().connect(input), /Negotiate voice call.*ENOTFOUND/);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
		process.env = env;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("helper correlates client failures with server trace and logs detached cleanup errors", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-helper-errors-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const records: any[] = [];
	let failConnect = true;
	const helper = createWebRTCHelperServer({
		stateDirectory: directory,
		voiceTransport: {
			async connect() {
				if (failConnect)
					return voiceOperation("Create realtime session", "https://example.test", async () => {
						throw dnsFailure();
					});
				return {
					answer: "v=0",
					send() {},
					close: () =>
						voiceOperation("Close voice call", "https://example.test", async () => {
							throw dnsFailure();
						}),
				};
			},
		},
	});
	helper.setDashboard!({
		snapshot: () => ({ project: "demo", usage: "none", messages: [] }),
		async sendMessage() {},
		pi: {
			snapshot: () => ({ sessionId: "test", branchId: "root", project: "demo", busy: false, messages: [] }),
			history: () => [],
			async postMessage() {},
			lifecycle() {},
		},
	});
	try {
		await helper.start();
		helper.registerSession(
			{
				provider: "openai",
				providerSessionId: "errors",
				model: "test",
				interaction: { mode: "agent" },
				createClientSecret: async () => ({}),
				trace: { path: "fixture", createdAt: 0, write: (record: any) => records.push(record) },
			} as any,
			{ onProviderEvent() {} },
		);
		const base = helper.urlFor("errors");
		const post = (action: string, body: unknown) =>
			fetch(`${base}/${action}`, { method: "POST", body: JSON.stringify(body) });
		const failed = await post("voice-connect", { sdp: "v=0 " + secret });
		assert.equal(failed.status, 500);
		const body = await failed.json();
		assert.match(body.error, /Create realtime session.*example.test.*ENOTFOUND/);
		const logged = records.find((r) => r.errorId === body.errorId);
		assert.equal(logged.action, "voice-connect");
		assert.deepEqual(logged.codes, ["ENOTFOUND"]);
		failConnect = false;
		const { lease } = await (await post("voice-connect", { sdp: "v=0" })).json();
		const disconnect = await post("voice-disconnect", { lease });
		assert.equal(disconnect.status, 500);
		assert.match((await disconnect.json()).error, /Close voice call.*ENOTFOUND/);
		assert(records.some((r) => r.eventType === "voice.error" && r.action === "disconnect"));
		// Failed provider cleanup must not leave a stale device lock.
		const next = await post("voice-connect", { sdp: "v=0" });
		assert.equal(next.status, 200);
		// Shutdown failures have no HTTP caller, but must still appear in the same trace.
		await assert.rejects(helper.stop(), /cleanup failed/);
		assert(records.filter((r) => r.eventType === "voice.error" && r.action === "disconnect").length >= 2);
		assert(!JSON.stringify(records).includes(secret));
	} finally {
		await helper.stop();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("stale browser polling logs to a helper file, never the Pi terminal, even if logging fails", async (t) => {
	const helper = createWebRTCHelperServer();
	const stderr = t.mock.method(console, "error", () => {});
	let logPath: string | undefined;
	try {
		await helper.start();
		const base = helper.urlFor("legacy-session");
		const ids = [];
		for (let i = 0; i < 20; i++) {
			const response = await fetch(`${base}/messages`);
			assert.equal(response.status, 410);
			const body = await response.json();
			assert.match(body.error, /Open the current URL from Pi/);
			ids.push(body.errorId);
		}
		logPath = helper.status().match(/helper error log: (.+)/)?.[1];
		assert(logPath);
		const records = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			records.map((record) => record.errorId),
			ids,
		);
		assert(records.every((record) => record.action === "messages" && record.providerSessionId === "legacy-session"));
		// A malformed route has no session either and must use the same file-only fallback.
		assert.equal((await fetch(`${base.replace("legacy-session", "%E0%A4")}/messages`)).status, 500);
		(helper as any).errorTrace.write = () => {
			throw new Error("disk full");
		};
		const response = await fetch(`${base}/messages`);
		assert.equal(response.status, 410);
		assert((await response.json()).errorId);
		assert.equal(stderr.mock.callCount(), 0);
	} finally {
		await helper.stop();
		if (logPath) rmSync(logPath, { force: true });
	}
});
