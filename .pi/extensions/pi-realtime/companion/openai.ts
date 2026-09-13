import WebSocket from "ws";
import { openAIConnectionConfig } from "../providers/openai/connection";
import { buildOpenAIRealtimeAudioConfig, openAIRealtimeAudioInput } from "../providers/openai/session-config";
import { providerInteractionFor } from "../domain/interaction-modes";
import type { VoiceTransport } from "./types";

/** Server negotiation and sideband control of the SAME WebRTC model session. */
export function openAIVoiceTransport(): VoiceTransport {
 return {
  async connect(input) {
   const config = openAIConnectionConfig();
   if (!config.apiKey) throw new Error("Realtime credential missing");
   const headers: Record<string, string> = config.authMode === "api-key" ? { "api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` };
   const session = { type: "realtime", model: input.model, instructions: input.instructions, tools: input.tools, tool_choice: "auto", output_modalities: ["audio"], audio: buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("agent"))) };
   let callHeaders = headers;
   let body: string | FormData;
   if (config.authMode === "api-key") {
    // Azure's documented flow accepts ephemeral Bearer + raw SDP, not resource-key multipart.
    const secretResponse = await fetch(`${config.baseURL}/realtime/client_secrets`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ session, expires_after: { anchor: "created_at", seconds: 600 } }), signal: AbortSignal.timeout(15000) });
    if (!secretResponse.ok) throw new Error(`Realtime session setup failed (${secretResponse.status})`);
    const secret = await secretResponse.json() as { value?: string };
    if (!secret.value) throw new Error("Provider returned no ephemeral credential");
    callHeaders = { Authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" };
    body = input.sdp;
   } else {
    const form = new FormData(); form.set("sdp", input.sdp); form.set("session", JSON.stringify(session)); body = form;
   }
   const response = await fetch(config.callsUrl, { method: "POST", headers: callHeaders, body, signal: AbortSignal.timeout(25000) });
   if (!response.ok) throw new Error(`Realtime negotiation failed (${response.status})`);
   const answer = await response.text();
   const location = response.headers.get("location");
   const callId = location ? new URL(location, config.callsUrl).pathname.split("/").filter(Boolean).pop() : undefined;
   if (!callId || !/^[a-zA-Z0-9_-]+$/.test(callId)) throw new Error("Provider did not return a valid WebRTC call identifier");
   const hangup = async () => {
    const result = await fetch(`${config.callsUrl}/${encodeURIComponent(callId)}/hangup`, { method: "POST", headers, signal: AbortSignal.timeout(10000) });
    if (!result.ok && ![404, 410].includes(result.status)) throw new Error(`Provider hangup failed (${result.status})`);
   };
   const url = new URL(`${config.baseURL}/realtime`); url.protocol = "wss:"; url.searchParams.set("call_id", callId);
   const ws = new WebSocket(url, { headers, handshakeTimeout: 10000 });
   let closing = false;
   ws.on("message", data => { try { input.onEvent(JSON.parse(data.toString())); } catch { /* Malformed provider event is not a user instruction. */ } });
   ws.on("close", () => { if (!closing) input.onClose(); });
   ws.on("error", () => { if (!closing && ws.readyState === WebSocket.OPEN) input.onClose(); });
   try {
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("close", () => reject(new Error("Provider control connection closed"))); });
   } catch (error) { closing = true; ws.terminate(); await hangup(); throw error; }
   return {
    answer,
    send(event) { if (ws.readyState !== WebSocket.OPEN) throw new Error("Provider control connection is not open"); ws.send(JSON.stringify(event)); },
    async close() { closing = true; try { await hangup(); } finally { ws.terminate(); } },
   };
  },
 };
}
