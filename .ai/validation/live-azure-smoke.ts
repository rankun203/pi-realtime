// Opt-in live check: creates short-lived credentials and a WebSocket session; sends no audio.
import { createOpenAIWebRTCClientSecret } from "../../.pi/extensions/pi-realtime/providers/openai/webrtc";
import { openAIConnectionConfig } from "../../.pi/extensions/pi-realtime/providers/openai/connection";
import { OpenAIRealtimeProviderAdapter } from "../../.pi/extensions/pi-realtime/providers/openai/index";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";

async function main() {
	const config = openAIConnectionConfig();
	const interaction = providerInteractionFor("eco");
	const secret = await createOpenAIWebRTCClientSecret({
		model: config.model,
		instructions: "Connection test only. Do not generate a response.",
		interaction,
	});
	console.log(
		JSON.stringify({
			check: "client-secret",
			ok: Boolean(secret.value),
			model: config.model,
			callsUrl: secret.callsUrl,
		}),
	);
	const adapter = new OpenAIRealtimeProviderAdapter("configuration-smoke-test");
	let receivedUpdate = false;
	let failed = false;
	try {
		await adapter.connect(
			{
				providerSessionId: "configuration-smoke-test",
				provider: "openai",
				model: config.model,
				systemPrompt: "Connection test only. Do not generate a response.",
				toolSurface: { tools: [], revision: 1 } as any,
				initialContext: { channel: "test", revision: 1, summary: "Connectivity test", sections: [] } as any,
				capabilities: {},
				interaction,
			} as any,
			{
				onProviderEvent(event) {
					if (event.type === "error") {
						failed = true;
						console.log(
							JSON.stringify({
								check: "websocket-provider-error",
								message: event.message.replaceAll(config.apiKey || "\0", "[REDACTED]"),
							}),
						);
					}
				},
			},
		);
		// Wait for session.update validation, not just the WebSocket handshake.
		const rt = (adapter as any).socket;
		rt.on("event", (event: any) => {
			if (event.type === "session.updated") receivedUpdate = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 3000));
		console.log(
			JSON.stringify({ check: "websocket-session-update", ok: receivedUpdate && !failed, model: config.model }),
		);
		if (!receivedUpdate || failed) process.exitCode = 1;
	} finally {
		await adapter.disconnect("user");
	}
}
main().catch((error) => {
	// SDK error objects can contain request headers: never print the object or stack.
	const key = openAIConnectionConfig().apiKey;
	console.error(
		JSON.stringify({
			check: "live-smoke",
			ok: false,
			status: error.status,
			message: String(error.message).replaceAll(key || "\0", "[REDACTED]"),
		}),
	);
	process.exitCode = 1;
});
