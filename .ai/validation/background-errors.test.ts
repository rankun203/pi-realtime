import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createService } from "../../.pi/extensions/pi-realtime/service";

function harness() {
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const service = createService(
		{
			hydrate() {},
			append() {},
			state: () => ({ sessions: new Map() }),
		} as any,
		{} as any,
	);
	service.refresh({
		ui: {
			notify: (text: string) => notifications.push(text),
			setStatus: (key: string, value?: string) =>
				value === undefined ? statuses.delete(key) : statuses.set(key, value),
		},
	} as any);
	return { service, statuses, notifications, internal: service as any };
}

test("background error bursts log every occurrence but replace one footer slot", async () => {
	const { service, internal, statuses, notifications } = harness();
	const id = `error-test-${randomUUID()}`;
	let path: string | undefined;
	try {
		for (let index = 0; index < 100; index++) {
			internal.providerSink.onProviderEvent({
				type: "error",
				provider: "fake",
				providerSessionId: id,
				message: `failure ${index}\n${"long detail ".repeat(100)}`,
				recoverable: true,
				localSeq: index,
			});
		}
		internal.handleAudioError(id, "microphone", new Error("capture failed\nsecond line"));
		path = internal.debugTraces.recorderFor(id).path;
		const rows = readFileSync(path!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(rows.length, 101);
		assert.equal(rows[99].localSeq, 99);
		assert.equal(rows[99].recoverable, true);
		assert.match(rows[99].message, /^failure 99\n/);
		assert.equal(rows[100].message, "capture failed\nsecond line");
		assert.deepEqual(notifications, []);
		assert.equal(statuses.size, 1);
		const latest = [...statuses.values()][0];
		assert.match(latest, /microphone/);
		assert(!latest.includes("\n"));
		assert(latest.length < 100);
		assert(service.debugText().includes(path!));
		await service.shutdown();
		assert.equal(statuses.size, 0);
	} finally {
		if (path) rmSync(path, { force: true });
	}
});

test("failed error logging does not escape into Pi's repeated exception notifications", async () => {
	const { service, internal, statuses, notifications } = harness();
	internal.debugTraces.create = () => {
		throw new Error("disk full");
	};
	for (let i = 0; i < 100; i++) {
		internal.providerSink.onProviderEvent({
			type: "error",
			provider: "fake",
			providerSessionId: "unwritable",
			message: "provider failed",
			recoverable: true,
			localSeq: i,
		});
	}
	assert.deepEqual(notifications, []);
	assert.equal(statuses.size, 1);
	assert.match([...statuses.values()][0], /log unavailable/);
	await service.shutdown();
});
