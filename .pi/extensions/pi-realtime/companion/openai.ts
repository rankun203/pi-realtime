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
   const form = new FormData();
   form.set("sdp", input.sdp);
   form.set("session", JSON.stringify({ type: "realtime", model: input.model, instructions: input.instructions, tools: input.tools, tool_choice: "auto", output_modalities: ["audio"], audio: buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("agent"))) }));
   const response = await fetch(config.callsUrl, { method: "POST", headers, body: form, signal: AbortSignal.timeout(25000) });
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
