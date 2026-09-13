// Opt-in fixture: real Pi SDK/control plane + real helper/gateway; synthetic coding model.
// PI_COMPANION_LIVE=1 additionally uses real Azure/OpenAI WebRTC and sideband (token charges).
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createControlPlane } from "../../.pi/extensions/pi-realtime/control-plane";
import { createWebRTCHelperServer } from "../../.pi/extensions/pi-realtime/media/webrtc-helper/server";
import { openAIVoiceTransport } from "../../.pi/extensions/pi-realtime/companion/openai";
import { loadRealtimeEnv } from "../../.pi/extensions/pi-realtime/env";
import type { VoiceEvent, VoiceTransport } from "../../.pi/extensions/pi-realtime/companion/types";

async function main() {
 const directory = process.env.PI_COMPANION_FIXTURE_DIR;
 if (!directory) throw new Error("PI_COMPANION_FIXTURE_DIR must be an isolated temporary directory");
 const live = process.env.PI_COMPANION_LIVE === "1";
 const real = live ? loadRealtimeEnv() : undefined;
 process.env.PI_CODING_AGENT_DIR = directory;
 process.env.PI_REALTIME_WEB_PORT = "0";
 if (real) for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_AUTH_MODE", "OPENAI_REALTIME_MODEL"]) if (real[key]) process.env[key] = real[key];
 const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
 const ai = await import(join(dirname(realpathSync(requireResolve())), "..", "pi-ai", "dist", "index.js"));
 const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const authStorage = AuthStorage.inMemory({ openai: { type: "api_key", key: "fixture-only" } });
 const modelRegistry = ModelRegistry.create(authStorage, join(directory, "models.json"));
 let bridge: any, ctx: any;
 const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [pi => {
  const control = createControlPlane(pi, { append() {} } as any, () => ctx);
  bridge = control.voiceBridge!();
  pi.on("session_start", (_event, context) => { ctx = context; });
 }] });
 await loader.reload();
 const { session } = await createAgentSession({ cwd: directory, agentDir: directory, authStorage, modelRegistry, model: ai.getModel("openai", "gpt-4o"), thinkingLevel: "off", noTools: "all", resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(directory) });
 await session.bindExtensions({});
 let completions = 0;
 session.agent.streamFn = (model: any) => {
  const stream = new ai.AssistantMessageEventStream();
  const out = { role: "assistant", content: [{ type: "text", text: "Fixture work completed. The diagnostic directory contains apple.txt and pear.txt." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
  setTimeout(() => { completions++; stream.push({ type: "done", reason: "stop", message: out }); stream.end(); }, 300);
  return stream;
 };
 const connections: { sent: VoiceEvent[]; events: VoiceEvent[]; closed: boolean; emit: (event: VoiceEvent) => void; send?: (event: VoiceEvent) => void }[] = [];
 const transport: VoiceTransport = { async connect(input) {
  const record = { sent: [] as VoiceEvent[], events: [] as VoiceEvent[], closed: false, emit: input.onEvent };
  connections.push(record);
  const event = (e: VoiceEvent) => { record.events.push({ type: e.type, name: e.name, arguments: e.arguments, transcript: e.transcript, usage: e.response?.usage, error: e.error }); input.onEvent(e); };
  record.emit = event;
  const connection = live ? await openAIVoiceTransport().connect({ ...input, onEvent: event }) : { answer: "v=0\r\n", send(_event: VoiceEvent) {}, async close() {} };
  const send = (e: VoiceEvent) => { record.sent.push(e); connection.send(e); };
  Object.assign(record, { send });
  return { answer: connection.answer, send, async close() { await connection.close(); record.closed = true; } };
 } };
 const helper = createWebRTCHelperServer({ voiceTransport: transport, stateDirectory: join(directory, "memory") });
 helper.setDashboard!({ pi: bridge, snapshot: () => ({ project: "fixture-workspace", messages: bridge.snapshot().messages, usage: "Fixture" }), sendMessage: async text => { await bridge.postMessage(text, "user"); } });
 await helper.start();
 helper.registerSession({ provider: "openai", providerSessionId: "fixture", instructions: "Fixture", toolSurface: { revision: 1, tools: [] }, model: real?.OPENAI_REALTIME_MODEL || "test-mini", interaction: { mode: "agent", tools: [], toolChoice: "auto", transcriptHandling: { response: "native", backendRoute: "none", retention: "retain" }, backendSpeechContext: "default_conversation" }, initialContext: { channel: "state", revision: 1, summary: "test", sections: [] } as any, createClientSecret: async () => { throw new Error("Browser must not request credentials"); } }, { onProviderEvent() {} });
 const dashboardModule = await import("../../apps/pi-agents/server.mjs");
 const dashboard = dashboardModule.createDashboard({ registryDir: join(directory, "pi-realtime", "helpers") });
 await new Promise<void>(resolve => dashboard.listen(0, "127.0.0.1", resolve));
 const control = createServer(async (req, res) => {
  try {
   if (req.method === "POST" && req.url === "/emit" && !live) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    connections.at(-1)?.emit(JSON.parse(Buffer.concat(chunks).toString()));
   }
   if (req.method === "POST" && req.url === "/ask") {
    connections.at(-1)?.send?.({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Remind me of the two filenames we just found. Answer briefly." }] } });
    connections.at(-1)?.send?.({ type: "response.create", response: { output_modalities: ["audio"] } });
   }
   if (req.method === "POST" && req.url === "/pi") void session.prompt("Do the diagnostic work.").catch(console.error);
   res.setHeader("content-type", "application/json");
   res.end(JSON.stringify({ completions, messages: session.messages, connections: connections.map(({ emit: _emit, send: _send, ...record }) => record), busy: session.isStreaming }));
  } catch { res.statusCode = 500; res.end("fixture error"); }
 });
 await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
 console.log(JSON.stringify({ port: (dashboard.address() as any).port, control: (control.address() as any).port, live }));
 process.on("SIGTERM", () => { void (async () => { await helper.stop(); await session.abort(); session.dispose(); dashboard.close(); dashboard.closeAllConnections(); control.close(); control.closeAllConnections(); })().catch(console.error); });
}
function requireResolve() { return join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"); }
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
