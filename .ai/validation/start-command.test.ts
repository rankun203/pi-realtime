import assert from "node:assert/strict";
import { test } from "node:test";
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
 await handleRealtimeCommand("start", f.ctx, f.service);
 assert.equal(f.calls[0].input.provider, "fake");
});

test("helper startup errors are visible rather than reported as success", async () => {
 const f = fixture("webrtc");
 f.service.startSessionMedia = async () => { throw new Error("EADDRINUSE: test port occupied"); };
 await handleRealtimeCommand("start --provider openai", f.ctx, f.service);
 assert.equal(f.messages.length, 1);
 assert.equal(f.messages[0].level, "warning");
 assert.match(f.messages[0].text, /EADDRINUSE/);
});
