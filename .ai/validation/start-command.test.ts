import assert from "node:assert/strict";
import { test } from "node:test";
import { createService } from "../../.pi/extensions/pi-realtime/service";
import { handleRealtimeCommand } from "../../.pi/extensions/pi-realtime/commands";

function fixture(autoMediaMode?: string) {
 const calls: any[] = [], messages: { text: string; level?: string }[] = [];
 const ctx = { ui: { notify(text: string, level?: string) { messages.push({ text, level }); } } } as any;
 const service = {
  refresh() {},
  defaultModelFor() { return "test-deployment"; },
  defaultInteractionMode() { return "eco"; },
  providerPreference() { return { autoMediaMode }; },
  providerWarning() { return "Raw mode warning"; },
  async startSession(input: any) { calls.push({ action: "start", input }); return "test-session"; },
  async startSessionMedia(id: string, mode: string) { calls.push({ action: "media", id, mode }); return "http://127.0.0.1:8787/pi-realtime/openai/test-session"; },
 } as any;
 return { calls, messages, ctx, service };
}

test("generic and provider-specific start both honor automatic WebRTC", async () => {
 for (const command of ["start --provider openai", "openai start"]) {
  const f = fixture("webrtc");
  await handleRealtimeCommand(command + " --mode agent --model custom --persona voice --secondary", f.ctx, f.service);
  assert.deepEqual(f.calls, [
   { action: "start", input: { provider: "openai", model: "custom", personaId: "voice", primary: false, interactionMode: "agent" } },
   { action: "media", id: "test-session", mode: "webrtc" },
  ]);
  assert.match(f.messages[0].text, /http:\/\/127\.0\.0\.1:8787/);
 }
});

test("disabled/raw media and fake provider keep existing behavior", async () => {
 for (const preference of [undefined, "none", "raw"]) {
  const f = fixture(preference);
  await handleRealtimeCommand("start --provider openai --secondary", f.ctx, f.service);
  assert.equal(f.calls.length, 1);
  assert.match(f.messages[0].text, /Not primary/);
  assert.equal(f.messages[1].level, "warning");
 }
 const f = fixture();
 await handleRealtimeCommand("start --provider fake", f.ctx, f.service);
 assert.equal(f.calls[0].input.provider, "fake");
});

test("bare command, start and legacy chat alias all start/resume voice", async () => {
 for (const command of ["", "  ", "start", "chat"]) {
  const f = fixture();
  f.service.startChat = async () => { f.calls.push({ action: "chat" }); return "http://127.0.0.1:8787/pi-realtime/openai/test"; };
  await handleRealtimeCommand(command, f.ctx, f.service);
  assert.deepEqual(f.calls, [{ action: "chat" }]);
  assert.match(f.messages[0].text, /Voice chat ready.*http/);
  await handleRealtimeCommand("chat --mode eco", f.ctx, f.service);
  assert.equal(f.calls.length, 1); assert.match(f.messages[1].text, /Usage/);
 }
});

test("explicit status and help never start voice", async () => {
 const f = fixture();
 f.service.statusText = () => "session history";
 await handleRealtimeCommand("status", f.ctx, f.service);
 await handleRealtimeCommand("help", f.ctx, f.service);
 assert.equal(f.calls.length, 0);
 assert.equal(f.messages[0].text, "session history");
 assert.match(f.messages[1].text, /\/realtime \(or \/realtime start\)/);
});

function chatServiceFixture() {
 const state: any = { sessions: new Map(), primaryProviderSessionId: null };
 const service: any = createService({ state: () => state } as any, {} as any);
 const calls: any[] = [];
 service.defaultModelFor = () => "configured-mini";
 service.setPrimary = (id: string) => { state.primaryProviderSessionId = id; };
 service.providers = { get: () => ({ media: { webrtc: { urlFor: (id: string) => `http://127.0.0.1:8787/${id}` } } }) };
 service.startSession = async (input: any) => {
  calls.push({ action: "session", input });
  state.sessions.set("new-agent", { providerSessionId: "new-agent", provider: "openai", interactionMode: "agent", status: "active" });
  return "new-agent";
 };
 service.startSessionMedia = async (id: string, mode: string) => {
  calls.push({ action: "media", id, mode });
  service.adapters.set(id, { mediaMode: "webrtc" });
  return `http://127.0.0.1:8787/${id}`;
 };
 return { service, state, calls };
}

test("chat starts agent plus WebRTC once, even for concurrent calls", async () => {
 const f = chatServiceFixture();
 const urls = await Promise.all([f.service.startChat({}), f.service.startChat({})]);
 assert.deepEqual(urls, ["http://127.0.0.1:8787/new-agent", "http://127.0.0.1:8787/new-agent"]);
 assert.equal(f.calls.length, 2);
 assert.equal(f.calls[0].input.interactionMode, "agent");
 assert.equal(f.calls[0].input.model, "configured-mini");
 assert.equal(f.calls[1].mode, "webrtc");
 await f.service.startChat({});
 assert.equal(f.calls.length, 2); // No reconnect or duplicate provider session.
 assert.equal(f.state.primaryProviderSessionId, "new-agent");
});

test("chat attaches to existing agent and leaves other sessions alone", async () => {
 const f = chatServiceFixture();
 f.state.sessions.set("eco", { providerSessionId: "eco", provider: "openai", interactionMode: "eco", status: "active" });
 f.state.sessions.set("existing-agent", { providerSessionId: "existing-agent", provider: "openai", interactionMode: "agent", status: "active" });
 await f.service.startChat({});
 assert.deepEqual(f.calls, [{ action: "media", id: "existing-agent", mode: "webrtc" }]);
 assert.equal(f.state.sessions.get("eco").status, "active");
 assert.equal(f.state.primaryProviderSessionId, "existing-agent");
});

test("chat releases its startup lock after failure so it can retry", async () => {
 const f = chatServiceFixture();
 const startMedia = f.service.startSessionMedia;
 f.service.startSessionMedia = async () => { throw new Error("test failure"); };
 await assert.rejects(f.service.startChat({}), /test failure/);
 f.service.startSessionMedia = startMedia;
 await f.service.startChat({});
 assert.equal(f.calls.filter(call => call.action === "session").length, 1);
 assert.equal(f.calls.filter(call => call.action === "media").length, 1);
});

test("helper startup errors are visible rather than reported as success", async () => {
 const f = fixture("webrtc");
 f.service.startSessionMedia = async () => { throw new Error("EADDRINUSE: test port occupied"); };
 await handleRealtimeCommand("start --provider openai", f.ctx, f.service);
 assert.equal(f.messages.length, 1);
 assert.equal(f.messages[0].level, "warning");
 assert.match(f.messages[0].text, /EADDRINUSE/);
});
