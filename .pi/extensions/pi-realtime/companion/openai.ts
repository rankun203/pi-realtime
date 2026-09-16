import WebSocket from "ws";
import { openAIConnectionConfig } from "../providers/openai/connection";
import { buildOpenAIRealtimeAudioConfig, openAIRealtimeAudioInput } from "../providers/openai/session-config";
import { providerInteractionFor } from "../domain/interaction-modes";
import type { VoiceTransport } from "./types";
import { nativeInputResponsePolicy } from "./prompt";
import { VoiceTransportError, safeErrorDetails, voiceOperation, voiceErrorRecord } from "./errors";

async function requireOk(response: Response): Promise<void> {
	if (response.ok) return;
	// Do not log provider bodies: authentication errors may echo sensitive request data.
	await response.body?.cancel().catch(() => {}); // Preserve the provider's rejection if draining also fails.
	throw Object.assign(new Error("Provider HTTP failure"), { status: response.status });
}

/** Server negotiation and sideband control of the SAME WebRTC model session. */
export function openAIVoiceTransport(): VoiceTransport {
	return {
		async connect(input) {
			const config = openAIConnectionConfig();
			if (!config.apiKey) throw new Error("Realtime credential missing");
			const headers: Record<string, string> =
				config.authMode === "api-key" ? { "api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` };
			const session = {
				type: "realtime",
				model: input.model,
				instructions: input.instructions,
				tools: input.tools,
				...nativeInputResponsePolicy(),
				audio: buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("agent"))),
			};
			let callHeaders = headers;
			let body: string | FormData;
			if (config.authMode === "api-key") {
				// Azure's documented flow accepts ephemeral Bearer + raw SDP, not resource-key multipart.
				const secretUrl = `${config.baseURL}/realtime/client_secrets`;
				const secret = await voiceOperation("Create realtime session", secretUrl, async () => {
					const response = await fetch(secretUrl, {
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({ session, expires_after: { anchor: "created_at", seconds: 600 } }),
						signal: AbortSignal.timeout(15000),
					});
					await requireOk(response);
					const value = (await response.json()) as { value?: string };
					if (!value.value) throw new SyntaxError("Missing ephemeral credential");
					return value;
				});
				callHeaders = { Authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" };
				body = input.sdp;
			} else {
				const form = new FormData();
				form.set("sdp", input.sdp);
				form.set("session", JSON.stringify(session));
				body = form;
			}
			const { answer, callId } = await voiceOperation("Negotiate voice call", config.callsUrl, async () => {
				const response = await fetch(config.callsUrl, {
					method: "POST",
					headers: callHeaders,
					body,
					signal: AbortSignal.timeout(25000),
				});
				await requireOk(response);
				const answer = await response.text();
				const location = response.headers.get("location");
				const callId = location
					? new URL(location, config.callsUrl).pathname.split("/").filter(Boolean).pop()
					: undefined;
				if (!callId || !/^[a-zA-Z0-9_-]+$/.test(callId))
					throw new SyntaxError("Provider did not return a valid WebRTC call identifier");
				return { answer, callId };
			});
			const hangupUrl = `${config.callsUrl}/${encodeURIComponent(callId)}/hangup`;
			const hangup = () =>
				voiceOperation("Close voice call", hangupUrl, async () => {
					const result = await fetch(hangupUrl, {
						method: "POST",
						headers,
						signal: AbortSignal.timeout(10000),
					});
					if (![404, 410].includes(result.status)) await requireOk(result);
					await result.body?.cancel();
				});
			const url = new URL(`${config.baseURL}/realtime`);
			url.protocol = "wss:";
			url.searchParams.set("call_id", callId);
			const ws = new WebSocket(url, { headers, handshakeTimeout: 10000 });
			let closing = false;
			ws.on("message", (data) => {
				try {
					input.onEvent(JSON.parse(data.toString()));
				} catch {
					/* Malformed provider event is not a user instruction. */
				}
			});
			ws.on("close", (code, reason) => {
				if (!closing)
					input.onClose(
						`Provider control connection closed (${code}): ${
							reason
								.toString()
								.replace(/[\r\n\t]/g, " ")
								.slice(0, 200) || "no reason supplied"
						}`,
					);
			});
			ws.on("error", (error) => {
				if (closing) return;
				const failure = new VoiceTransportError("Voice control channel", url.hostname, safeErrorDetails(error));
				input.onEvent({ type: "voice.error", action: "control", ...voiceErrorRecord(failure) });
				if (ws.readyState === WebSocket.OPEN) input.onClose(failure.message);
			});
			try {
				await voiceOperation(
					"Connect voice control channel",
					url.toString(),
					() =>
						new Promise<void>((resolve, reject) => {
							ws.once("open", resolve);
							ws.once("error", reject);
							ws.once("unexpected-response", (_request, response) => {
								response.resume();
								reject(
									Object.assign(new Error("Provider rejected control connection"), { status: response.statusCode }),
								);
							});
							ws.once("close", () => reject(new Error("Provider control connection closed")));
						}),
				);
			} catch (error) {
				closing = true;
				ws.terminate();
				try {
					await hangup();
				} catch (cleanupError) {
					// A failed cleanup must not replace the original connection failure.
					input.onEvent({ type: "voice.error", action: "cleanup", ...voiceErrorRecord(cleanupError) });
				}
				throw error;
			}
			return {
				answer,
				send(event) {
					if (ws.readyState !== WebSocket.OPEN) throw new Error("Provider control connection is not open");
					ws.send(JSON.stringify(event));
				},
				async close() {
					closing = true;
					try {
						await hangup();
					} finally {
						ws.terminate();
					}
				},
			};
		},
	};
}
