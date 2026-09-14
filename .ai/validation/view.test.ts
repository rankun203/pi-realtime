import assert from "node:assert/strict";
import { test } from "node:test";
import { statusText, renderStatusText } from "../../.pi/extensions/pi-realtime/view";
import { registerPiRealtime } from "../../.pi/extensions/pi-realtime/runtime";
import { emptyUsageBreakdown } from "../../.pi/extensions/pi-realtime/usage";
import { openAIContextWindowForModel } from "../../.pi/extensions/pi-realtime/providers/openai/model-profiles";
import type { RealtimeState } from "../../.pi/extensions/pi-realtime/types";

function state(statuses: string[]): RealtimeState {
	return {
		usage: [],
		usageResets: [],
		sessions: new Map(
			statuses.map((status, i) => [
				`session-${i}`,
				{ providerSessionId: `session-${i}`, provider: "openai", model: "test", interactionMode: "agent", status },
			]),
		),
		primaryProviderSessionId: "session-0",
	} as unknown as RealtimeState;
}

test("footer excludes recorded/stopped session totals", () => {
	assert.equal(statusText(state([])), undefined);
	assert.equal(statusText(state(["stopped", "stopped", "stopped"])), undefined);
	assert.equal(statusText(state(["active", "stopped", "error"])), "pi-realtime: 1 active · test");
	assert.equal(statusText(state(["active", "starting", "stopped"])), "pi-realtime: 2 active · test");
});

test("footer lists distinct running models, excluding stopped models and future preferences", () => {
	const current = state(["active", "starting", "stopped"]);
	current.sessions.get("session-0")!.model = "gpt-realtime-2.1";
	current.sessions.get("session-1")!.model = "gpt-realtime-2.1-mini";
	current.sessions.get("session-2")!.model = "retired-model";
	assert.equal(statusText(current), "pi-realtime: 2 active · gpt-realtime-2.1, gpt-realtime-2.1-mini");
	current.sessions.get("session-1")!.model = "gpt-realtime-2.1";
	assert.equal(statusText(current), "pi-realtime: 2 active · gpt-realtime-2.1");
});

test("compact footer separates uncached input, output, cache reads, and latest response hit rate", () => {
	const current = state(["active"]);
	const row = (at: number, input: number, cached: number, output: number, cost: number): any => ({
		at,
		providerSessionId: "session-0",
		source: "response",
		totalTokens: input + output,
		input: { ...emptyUsageBreakdown(), audioTokens: input, cachedAudioTokens: cached },
		output: { ...emptyUsageBreakdown(), audioTokens: output },
		estimatedCostUsd: cost,
	});
	// Deliberately out of order: CH follows the latest response, not array order or cumulative totals.
	current.usage = [row(2, 3000, 2900, 0, 0), row(1, 1000, 600, 200, 0.0123)];
	assert.equal(statusText(current), "pi-realtime: ↑500 ↓200 R3.5k CH96.7% · $0.0123 (api) · test");
	current.usageResets = [{ at: 1 }];
	assert.equal(statusText(current), "pi-realtime: ↑100 ↓0 R2.9k CH96.7% · $0.0000 (api) · test");
	current.usageResets = [];
	current.usage = [row(3, 36605000, 36000000, 99000, 0.0123)];
	assert.equal(statusText(current), "pi-realtime: ↑605k ↓99k R36M CH98.3% · $0.0123 (api) · test");
});

test("short context and countdown indicators use live telemetry and verified model limits", () => {
	assert.equal(openAIContextWindowForModel("gpt-realtime-2.1"), 128000);
	assert.equal(openAIContextWindowForModel("gpt-realtime-2.1-mini"), 128000);
	assert.equal(openAIContextWindowForModel("custom-deployment"), undefined);
	assert.equal(openAIContextWindowForModel("constructor"), undefined);
	const current = state(["active"]);
	const telemetry = {
		providerSessionId: "session-0",
		expiresAt: 3600000,
		contextInputTokens: 83200,
		contextWindowTokens: 128000,
	};
	assert.equal(statusText(current, telemetry, 1062000), "pi-realtime: 1 active · C~65%/128k · T42:18 · test");
	assert.match(statusText(current, telemetry, 1063000)!, /T42:17/);
	assert.match(statusText(current, telemetry, 4000000)!, /T0:00/);
	assert.match(statusText(current, { ...telemetry, contextInputTokens: undefined }, 0)!, /C\?\/128k/);
	assert.doesNotMatch(statusText(current, { ...telemetry, providerSessionId: "retired" }, 0)!, /T60:00|C~/);
});

test("old usage never keeps the stopped footer visible", () => {
	const stopped = state(["stopped"]);
	stopped.usage = [{ totalTokens: 1000 }] as any;
	assert.equal(statusText(stopped), undefined);
});

test("detailed status still retains session history", () => {
	const text = renderStatusText(state(["active", "stopped", "error"]));
	assert.match(text, /session-0.*active/);
	assert.match(text, /session-1.*stopped/);
	assert.match(text, /session-2.*error/);
});

test("startup/reload clears the widget and removes the footer when realtime is inactive", async () => {
	const handlers = new Map<string, Function>();
	const widgets: any[] = [],
		statuses: any[] = [];
	const pi: any = {
		registerCommand() {},
		registerTool() {},
		registerMessageRenderer() {},
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	};
	registerPiRealtime(pi);
	const ctx = {
		sessionManager: { getBranch: () => [] },
		ui: { setWidget: (...args: any[]) => widgets.push(args), setStatus: (...args: any[]) => statuses.push(args) },
	};
	await handlers.get("session_start")!({ reason: "reload" }, ctx);
	assert.deepEqual(widgets, [["pi-realtime.widget", undefined]]);
	assert.deepEqual(statuses, [["pi-realtime", undefined]]);
});
