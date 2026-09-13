import assert from "node:assert/strict";
import { test } from "node:test";
import { statusText, renderStatusText } from "../../.pi/extensions/pi-realtime/view";
import { registerPiRealtime } from "../../.pi/extensions/pi-realtime/runtime";
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
	assert.equal(statusText(state(["active", "stopped", "error"])), "pi-realtime: 1 active");
	assert.equal(statusText(state(["active", "starting", "stopped"])), "pi-realtime: 2 active");
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
