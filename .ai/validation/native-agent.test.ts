import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";
import { buildOpenAIRealtimeAudioConfig, openAIRealtimeAudioInput } from "../../.pi/extensions/pi-realtime/providers/openai/session-config";
import { OpenAIRealtimeProviderAdapter } from "../../.pi/extensions/pi-realtime/providers/openai/index";

import { defaultVoiceToolSurface, voiceSystemPrompt, voiceSpeechRendererPrompt } from "../../.pi/extensions/pi-realtime/prompt";

test("voice role delegates substantive work to Pi without UI or telephony framing", () => {
 const surface = defaultVoiceToolSurface();
 const prompt = voiceSystemPrompt(surface);
 assert.match(prompt, /conversational voice agent with a Pi coding agent/);
 assert.match(prompt, /listen to the user, invoke Pi to do tasks, and speak the results/);
 assert.match(prompt, /Use the request tool to obtain Pi's work or answer/);
 assert.match(prompt, /Ground substantive answers and completion claims in Pi's returned results/);
 assert.match(prompt, /Submit each user intent once/);
 assert.match(prompt, /authority to begin work comes from the user's current request/);
 assert.match(prompt, /After presenting an update, return to listening/);
 assert.doesNotMatch(prompt, /telephone|phone call|dialing|Start call|End call|text-only chatbot/i);
 assert.deepEqual(surface.tools.map(tool => tool.name), ["request"]);
 for (const mode of ["strict_verbatim", "per_response_rendering"] as const) {
  const renderer = voiceSpeechRendererPrompt(surface, mode);
  assert.doesNotMatch(renderer, /What would you like to work on/);
  assert.match(renderer, /ZERO agency/);
 }
});

const directory = mkdtempSync(join(tmpdir(), "pi-realtime-native-agent-"));
const isolatedEnv = { PI_CODING_AGENT_DIR: directory };

test("agent audio turns do not depend on transcription", async (t) => {
 try {
  await t.test("native VAD creates responses, interrupts, and omits auxiliary transcription", () => {
   const audio = buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("agent"), isolatedEnv));
   assert.equal(audio.input?.transcription, undefined);
   assert.equal(audio.input?.turn_detection?.create_response, true);
   assert.equal(audio.input?.turn_detection?.interrupt_response, true);
   assert.equal(providerInteractionFor("agent").toolChoice, "auto");
   assert.ok(providerInteractionFor("agent").tools.some(tool => tool.name === "request"));
  });
  await t.test("eco still transcribes and never auto-responds", () => {
   const audio = buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("eco"), isolatedEnv));
   assert.equal(audio.input?.transcription?.model, "gpt-4o-mini-transcribe");
   assert.equal(audio.input?.turn_detection?.create_response, false);
   assert.equal(audio.input?.turn_detection?.interrupt_response, true);
   assert.equal(providerInteractionFor("eco").transcriptHandling.backendRoute, "submit_instruction");
  });
  await t.test("optional agent transcript is configurable but not a response gate", () => {
   writeFileSync(join(directory, "settings.json"), JSON.stringify({ "pi-realtime": { openai: { transcriptionModel: "whisper-1" } } }));
   const audio = buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(providerInteractionFor("agent"), isolatedEnv));
   assert.equal(audio.input?.transcription?.model, "whisper-1");
   assert.equal(audio.input?.turn_detection?.create_response, true);
   const override = { ...isolatedEnv, OPENAI_REALTIME_TRANSCRIPTION_MODEL: "off" };
   assert.equal(openAIRealtimeAudioInput(providerInteractionFor("agent"), override).transcriptionModel, null);
   assert.throws(() => openAIRealtimeAudioInput(providerInteractionFor("eco"), override), /requires a transcription model/);
  });
  await t.test("raw optional transcript cannot create a duplicate native response; failures surface", () => {
   const adapter = new OpenAIRealtimeProviderAdapter("test") as any;
   const events: any[] = [];
   let requests = 0;
   adapter.interaction = providerInteractionFor("agent");
   adapter.sink = { onProviderEvent(event: any) { events.push(event); } };
   adapter.requestResponse = async () => { requests++; };
   adapter.handleServerEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "Please ask Pi to list files.", event_id: "completed" });
   assert.equal(requests, 0); assert.ok(events.some(event => event.type === "user_transcript"));
   adapter.handleServerEvent({ type: "conversation.item.input_audio_transcription.failed", error: { code: "DeploymentNotFound", message: "Test failure" }, event_id: "failed" });
   assert.ok(events.some(event => event.type === "error" && event.message.includes("DeploymentNotFound")));
  });
  await t.test("browser optional transcript cannot create duplicate responses; failures are visible", async () => {
   const elements = new Map<string, any>();
   const posts: any[] = [], sent: any[] = [];
   const context = vm.createContext({
    document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, { textContent: "", addEventListener() {} }); return elements.get(id); } },
    location: { pathname: "/pi-realtime/openai/test" },
    fetch: () => new Promise(() => {}), // Hold auto-start; no real network.
    clearInterval() {}, setInterval() {},
    window: { addEventListener() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    posts, sent,
   });
   vm.runInContext(readFileSync(resolve(__dirname, "../../.pi/extensions/pi-realtime/media/webrtc-helper/client.js"), "utf8"), context);
   vm.runInContext(`postEvent = async event => { posts.push(event); }; dc = { readyState: "open", send: data => sent.push(JSON.parse(data)) }; interactionConfig = { transcriptHandling: { response: "native" } };`, context);
   await vm.runInContext(`handleInputAudioTranscription({ transcript: "Please ask Pi to list files.", event_id: "complete" })`, context);
   assert.equal(sent.length, 0); assert.ok(posts.some(event => event.type === "user_transcript"));
   await vm.runInContext(`handleRealtimeEvent({ type: "conversation.item.input_audio_transcription.failed", error: { code: "DeploymentNotFound", message: "Test failure" }, event_id: "failed" })`, context);
   assert.equal(elements.get("status").className, "err");
   assert.match(elements.get("status").textContent, /DeploymentNotFound/);
   assert.ok(posts.some(event => event.type === "error" && event.providerEventId === "failed"));
  });
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
