import assert from "node:assert/strict";
import { test } from "node:test";
import { branchChatMessages } from "../../.pi/extensions/pi-realtime/dashboard";
import { createWebRTCHelperServer } from "../../.pi/extensions/pi-realtime/media/webrtc-helper/server";

test("chat projection excludes system, tool output and reasoning", () => {
	const entries = [
		{ id: "a", type: "message", timestamp: "2026-01-01", message: { role: "user", content: "Hello" } },
		{
			id: "b",
			type: "message",
			timestamp: "2026-01-02",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "Hi" },
					{ type: "toolCall", name: "bash" },
				],
			},
		},
		{ type: "message", message: { role: "system", content: "private system" } },
		{ type: "message", message: { role: "toolResult", content: "private output" } },
	];
	assert.deepEqual(
		branchChatMessages(entries).map((m) => m.text),
		["Hello", "Hi"],
	);
});

test("helper chat works without voice, rejects cross-origin writes and deduplicates voice transcripts", async () => {
	const helper = createWebRTCHelperServer();
	const sent: string[] = [];
	helper.setDashboard!({
		snapshot: () => ({ project: "demo", usage: "$0.01 est.", messages: [] }),
		async sendMessage(text) {
			sent.push(text);
		},
	});
	await helper.start();
	helper.registerSession(
		{
			provider: "openai",
			providerSessionId: "chat-test",
			model: "test",
			createClientSecret: async () => ({ value: "fake" }),
		} as any,
		{ onProviderEvent() {} },
	);
	const base = helper.urlFor("chat-test");
	try {
		assert.equal((await fetch(`${base}/messages`).then((r) => r.json())).project, "demo");
		const post = (text: unknown, origin?: string) =>
			fetch(`${base}/message`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
				body: JSON.stringify({ text }),
			});
		assert.equal((await post("Hello Pi")).status, 202);
		assert.deepEqual(sent, ["Hello Pi"]);
		assert.equal((await post("blocked", "https://evil.example")).status, 403);
		assert.equal((await post(42)).status, 400);
		assert.equal((await post(" ")).status, 400);
		assert.equal((await post("x".repeat(20001))).status, 400);
		for (let i = 0; i < 2; i++)
			await fetch(`${base}/event`, {
				method: "POST",
				body: JSON.stringify({
					type: "assistant_transcript",
					text: "Voice reply",
					final: true,
					providerEventId: "same",
				}),
			});
		const snapshot = await fetch(`${base}/messages`).then((r) => r.json());
		assert.equal(snapshot.messages.length, 1);
		assert.equal(snapshot.messages[0].text, "Voice reply");
		assert.deepEqual(sent, ["Hello Pi"]);
	} finally {
		await helper.stop();
	}
});
