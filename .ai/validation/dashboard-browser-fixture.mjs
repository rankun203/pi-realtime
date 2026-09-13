import { createWebRTCHelperServer } from "../../.pi/extensions/pi-realtime/media/webrtc-helper/server.ts";
import { createDashboard } from "../../apps/pi-agents/server.mjs";
import { join } from "node:path";
if (!process.env.PI_CODING_AGENT_DIR) throw new Error("Fixture requires an isolated PI_CODING_AGENT_DIR");
const helpers = [];
for (const name of ["alpha", "beta"]) {
	const helper = createWebRTCHelperServer();
	const messages = [
		{ id: "hello", role: "assistant", text: `Hello from ${name}. <script>unsafe()</script>`, at: 1, source: "Pi" },
		...Array.from({ length: 40 }, (_, i) => ({
			id: `history-${i}`,
			role: i % 2 ? "user" : "assistant",
			text: `Earlier conversation message ${i + 1}.`,
			at: i + 2,
			source: "Pi",
		})),
	];
	helper.setDashboard({
		snapshot: () => ({ project: `/demo/${name}`, usage: "$0.012 est.", messages }),
		async sendMessage(text) {
			messages.push({ id: `u${messages.length}`, role: "user", text, at: Date.now(), source: "Pi" });
			messages.push({
				id: `a${messages.length}`,
				role: "assistant",
				text: `Received: ${text}`,
				at: Date.now() + 1,
				source: "Pi",
			});
		},
	});
	await helper.start();
	helper.registerSession(
		{
			provider: "openai",
			providerSessionId: name,
			model: "test-mini",
			interaction: { mode: "agent", transcriptHandling: { response: "native" } },
			initialContext: { channel: "state", revision: 1, summary: "test", sections: [] },
			createClientSecret: async () => ({ value: "test-only", callsUrl: "https://voice.invalid/calls" }),
		},
		{ onProviderEvent() {} },
	);
	helpers.push(helper);
}
const server = createDashboard({ registryDir: join(process.env.PI_CODING_AGENT_DIR, "pi-realtime", "helpers") });
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", async () => {
	for (const helper of helpers) await helper.stop();
	server.close();
	server.closeAllConnections();
});
