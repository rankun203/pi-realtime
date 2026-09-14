import assert from "node:assert/strict";
import { test } from "node:test";
import { createService } from "../../.pi/extensions/pi-realtime/service";
import { handleRealtimeCommand } from "../../.pi/extensions/pi-realtime/commands";
import { applyEvent, createInitialState } from "../../.pi/extensions/pi-realtime/events";
import { emptyUsageBreakdown } from "../../.pi/extensions/pi-realtime/usage";
import { statusText } from "../../.pi/extensions/pi-realtime/view";

function fixture(autoMediaMode?: string) {
	const calls: any[] = [],
		messages: { text: string; level?: string }[] = [];
	const ctx = {
		ui: {
			notify(text: string, level?: string) {
				messages.push({ text, level });
			},
		},
	} as any;
	const service = {
		refresh() {},
		state() {
			return { sessions: new Map() };
		},
		defaultModelFor() {
			return "test-deployment";
		},
		defaultInteractionMode() {
			return "eco";
		},
		providerPreference() {
			return { autoMediaMode };
		},
		providerWarning() {
			return "Raw mode warning";
		},
		async startSession(input: any) {
			calls.push({ action: "start", input });
			return "test-session";
		},
		async startSessionMedia(id: string, mode: string) {
			calls.push({ action: "media", id, mode });
			return "http://127.0.0.1:8787/pi-realtime/openai/test-session";
		},
	} as any;
	return { calls, messages, ctx, service };
}

test("bare stop shuts down every session and shared media; explicit session stop stays scoped", async () => {
	for (const command of ["stop", "stop --session first"]) {
		const f = fixture();
		f.service.state = () => ({
			sessions: new Map([
				["first", { providerSessionId: "first", status: "active" }],
				["second", { providerSessionId: "second", status: "active" }],
				["old", { providerSessionId: "old", status: "stopped" }],
			]),
		});
		f.service.stopSession = async (id: string) => {
			f.calls.push(id);
		};
		f.service.stopSessionMedia = async () => {
			f.calls.push("shared media");
		};
		await handleRealtimeCommand(command, f.ctx, f.service);
		assert.deepEqual(f.calls, command === "stop" ? ["first", "second", "shared media"] : ["first"]);
	}
});

test("stop still cleans shared components when idle, and attempts remaining cleanup after a failure", async () => {
	const f = fixture();
	f.service.stopSessionMedia = async () => {
		f.calls.push("shared media");
	};
	await handleRealtimeCommand("stop", f.ctx, f.service);
	assert.deepEqual(f.calls, ["shared media"]);
	f.calls.length = 0;
	f.service.state = () => ({
		sessions: new Map([
			["bad", { providerSessionId: "bad", status: "active" }],
			["good", { providerSessionId: "good", status: "active" }],
		]),
	});
	f.service.stopSession = async (id: string) => {
		f.calls.push(id);
		if (id === "bad") throw new Error("teardown failed");
	};
	await handleRealtimeCommand("stop", f.ctx, f.service);
	assert.deepEqual(f.calls, ["bad", "good", "shared media"]);
	assert.match(f.messages.at(-1)!.text, /cleanup needs attention/);
});

test("generic and provider-specific start both honor automatic WebRTC", async () => {
	for (const command of ["start --provider openai", "openai start"]) {
		const f = fixture("webrtc");
		await handleRealtimeCommand(command + " --mode agent --model custom --persona voice --secondary", f.ctx, f.service);
		assert.deepEqual(f.calls, [
			{
				action: "start",
				input: { provider: "openai", model: "custom", personaId: "voice", primary: false, interactionMode: "agent" },
			},
			{ action: "media", id: "test-session", mode: "webrtc" },
		]);
		assert.match(f.messages[0].text, /http:\/\/127\.0\.0\.1:8787/);
	}
});

test("disabled/raw media and fake provider keep existing behavior", async () => {
	for (const preference of [undefined, "none", "raw"]) {
		const f = fixture(preference);
		await handleRealtimeCommand("start --provider openai --secondary", f.ctx, f.service);
		assert.equal(f.calls.length, 1);
		assert.match(f.messages[0].text, /Not primary/);
		assert.equal(f.messages[1].level, "warning");
	}
	const f = fixture();
	await handleRealtimeCommand("start --provider fake", f.ctx, f.service);
	assert.equal(f.calls[0].input.provider, "fake");
});

test("bare command, start and legacy chat alias all start/resume voice", async () => {
	for (const command of ["", "  ", "start", "chat"]) {
		const f = fixture();
		f.service.startChat = async () => {
			f.calls.push({ action: "chat" });
			return "http://127.0.0.1:8787/pi-realtime/openai/test";
		};
		await handleRealtimeCommand(command, f.ctx, f.service);
		assert.deepEqual(f.calls, [{ action: "chat" }]);
		assert.match(f.messages[0].text, /Voice chat ready.*http/);
		await handleRealtimeCommand("chat --mode eco", f.ctx, f.service);
		assert.equal(f.calls.length, 1);
		assert.match(f.messages[1].text, /Usage/);
	}
});

test("explicit status and help never start voice", async () => {
	const f = fixture();
	f.service.statusText = () => "session history";
	await handleRealtimeCommand("status", f.ctx, f.service);
	await handleRealtimeCommand("help", f.ctx, f.service);
	assert.equal(f.calls.length, 0);
	assert.equal(f.messages[0].text, "session history");
	assert.match(f.messages[1].text, /start voice when idle; otherwise show status and options/);
});

test("bare command shows status and options without starting or reconnecting live sessions", async () => {
	for (const status of ["active", "starting", "stopping"]) {
		for (const command of ["", "  "]) {
			const f = fixture();
			f.service.state = () => ({ sessions: new Map([["existing", { status }]]) });
			f.service.statusText = () => `existing session: ${status}`;
			f.service.mediaStatus = () => "browser helper status";
			f.service.startChat = async () => {
				throw new Error("must not start or reconnect");
			};
			await handleRealtimeCommand(command, f.ctx, f.service);
			assert.equal(f.calls.length, 0);
			assert.equal(f.messages.length, 1);
			assert.match(f.messages[0].text, /existing session:/);
			assert.match(f.messages[0].text, /browser helper status/);
			assert.match(f.messages[0].text, /Options:[\s\S]*\/realtime stop[\s\S]*\/realtime help/);
		}
	}
});

test("stopped and failed history does not prevent bare command starting voice", async () => {
	const f = fixture();
	f.service.state = () => ({
		sessions: new Map([
			["old", { status: "stopped" }],
			["failed", { status: "error" }],
		]),
	});
	f.service.startChat = async () => {
		f.calls.push("chat");
		return "test-url";
	};
	await handleRealtimeCommand("", f.ctx, f.service);
	assert.deepEqual(f.calls, ["chat"]);
});

test("a rejected provider handshake cleans its adapter and records a stopped session", async () => {
	const events: any[] = [];
	const calls: string[] = [];
	const service: any = createService(
		{ append: (event: any) => events.push(event), state: () => ({ sessions: new Map() }) } as any,
		{} as any,
	);
	service.buildPackets = () => [{}];
	service.providers = {
		get: () => ({
			assertCredentials() {},
			createAdapter: () => ({
				provider: "openai",
				async connect() {
					throw new Error("HTTP 400 OperationNotSupported");
				},
				async disconnect() {
					calls.push("closed");
				},
			}),
		}),
	};
	await assert.rejects(
		service.startSession({ provider: "openai", model: "unavailable", interactionMode: "agent" }, {}),
		/OperationNotSupported/,
	);
	assert.deepEqual(calls, ["closed"]);
	assert.equal(service.adapters.size, 0);
	assert.equal(events.at(-1).kind, "session_stopped");
	assert.equal(events.at(-1).reason, "connection failed");
});

test("WebRTC handoff ignores retired raw lifecycle events without losing cost accounting", async () => {
	const state = createInitialState();
	const footers: (string | undefined)[] = [];
	let rawSink: any;
	const raw = {
		provider: "openai",
		async connect(_config: unknown, sink: unknown) {
			rawSink = sink;
		},
	};
	const service: any = createService(
		{ state: () => state, append: (event: any) => applyEvent(state, event) } as any,
		{ sendSessionAwareness() {} } as any,
		() => footers.push(statusText(state)),
	);
	service.buildPackets = () => [{}];
	service.providers = { get: () => ({ assertCredentials() {}, createAdapter: () => raw }) };
	const id = await service.startSession(
		{ provider: "openai", model: "gpt-realtime-2.1-mini", interactionMode: "agent" },
		{},
	);
	let seq = 0;
	const event = (type: string, extra = {}) => ({
		type,
		provider: "openai",
		providerSessionId: id,
		localSeq: ++seq,
		at: seq,
		...extra,
	});
	rawSink.onProviderEvent(event("connected"));
	rawSink.onProviderEvent(event("disconnected", { reason: "user" }));
	service.setAdapter(id, { provider: "openai", mediaMode: "webrtc" });
	service.providerSink.onProviderEvent(event("connected"));
	// Reproduce the recorded ordering: the old ws close arrives AFTER bridge connected.
	rawSink.onProviderEvent(event("disconnected", { reason: "socket closed" }));
	rawSink.onProviderEvent(event("error", { message: "retired socket", recoverable: true }));
	assert.equal(state.sessions.get(id)?.status, "active");
	assert.equal(state.sessions.get(id)?.lastError, undefined);
	const usage = (cost: number) =>
		event("usage", {
			observation: {
				provider: "openai",
				providerSessionId: id,
				model: "gpt-realtime-2.1-mini",
				source: "response",
				at: seq,
				input: emptyUsageBreakdown(),
				output: emptyUsageBreakdown(),
				totalTokens: 100,
				estimatedCostUsd: cost,
			},
		});
	service.providerSink.onProviderEvent(usage(0.02));
	rawSink.onProviderEvent(usage(0.01));
	assert.equal(state.usage.length, 2, "late billable usage from the retired socket must still count");
	assert.match(footers.at(-1)!, /200 voice tokens.*\$0\.0300 est/);
	service.providerSink.onProviderEvent(event("disconnected", { reason: "user" }));
	assert.equal(statusText(state), undefined, "a genuine current-session stop still hides the footer");
	rawSink.onProviderEvent(event("connected"));
	assert.equal(statusText(state), undefined, "retired transport cannot revive a stopped session");
});

function chatServiceFixture() {
	const state: any = { sessions: new Map(), primaryProviderSessionId: null };
	const service: any = createService({ state: () => state } as any, {} as any);
	const calls: any[] = [];
	service.defaultModelFor = () => "configured-mini";
	service.setPrimary = (id: string) => {
		state.primaryProviderSessionId = id;
	};
	service.providers = { get: () => ({ media: { webrtc: { urlFor: (id: string) => `http://127.0.0.1:8787/${id}` } } }) };
	service.startSession = async (input: any) => {
		calls.push({ action: "session", input });
		state.sessions.set("new-agent", {
			providerSessionId: "new-agent",
			provider: "openai",
			interactionMode: "agent",
			status: "active",
		});
		return "new-agent";
	};
	service.startSessionMedia = async (id: string, mode: string) => {
		calls.push({ action: "media", id, mode });
		service.adapters.set(id, { mediaMode: "webrtc" });
		return `http://127.0.0.1:8787/${id}`;
	};
	return { service, state, calls };
}

test("chat starts agent plus WebRTC once, even for concurrent calls", async () => {
	const f = chatServiceFixture();
	const urls = await Promise.all([f.service.startChat({}), f.service.startChat({})]);
	assert.deepEqual(urls, ["http://127.0.0.1:8787/new-agent", "http://127.0.0.1:8787/new-agent"]);
	assert.equal(f.calls.length, 2);
	assert.equal(f.calls[0].input.interactionMode, "agent");
	assert.equal(f.calls[0].input.model, "configured-mini");
	assert.equal(f.calls[1].mode, "webrtc");
	await f.service.startChat({});
	assert.equal(f.calls.length, 2); // No reconnect or duplicate provider session.
	assert.equal(f.state.primaryProviderSessionId, "new-agent");
});

test("chat attaches to existing agent and leaves other sessions alone", async () => {
	const f = chatServiceFixture();
	f.state.sessions.set("eco", {
		providerSessionId: "eco",
		provider: "openai",
		interactionMode: "eco",
		status: "active",
	});
	f.state.sessions.set("existing-agent", {
		providerSessionId: "existing-agent",
		provider: "openai",
		interactionMode: "agent",
		status: "active",
	});
	await f.service.startChat({});
	assert.deepEqual(f.calls, [{ action: "media", id: "existing-agent", mode: "webrtc" }]);
	assert.equal(f.state.sessions.get("eco").status, "active");
	assert.equal(f.state.primaryProviderSessionId, "existing-agent");
});

test("chat releases its startup lock after failure so it can retry", async () => {
	const f = chatServiceFixture();
	const startMedia = f.service.startSessionMedia;
	f.service.startSessionMedia = async () => {
		throw new Error("test failure");
	};
	await assert.rejects(f.service.startChat({}), /test failure/);
	f.service.startSessionMedia = startMedia;
	await f.service.startChat({});
	assert.equal(f.calls.filter((call) => call.action === "session").length, 1);
	assert.equal(f.calls.filter((call) => call.action === "media").length, 1);
});

test("helper startup errors are visible rather than reported as success", async () => {
	const f = fixture("webrtc");
	f.service.startSessionMedia = async () => {
		throw new Error("EADDRINUSE: test port occupied");
	};
	await handleRealtimeCommand("start --provider openai", f.ctx, f.service);
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].level, "warning");
	assert.match(f.messages[0].text, /EADDRINUSE/);
});
