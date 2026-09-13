import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRealtimeEnv } from "../../.pi/extensions/pi-realtime/env";
import { createOpenAIRealtimeClient, openAIConnectionConfig, openAIWebSocketOptions } from "../../.pi/extensions/pi-realtime/providers/openai/connection";
import { OPENAI_REALTIME_MODELS, openAIBehaviorProfileForModel } from "../../.pi/extensions/pi-realtime/providers/openai/model-profiles";
import { createOpenAIWebRTCClientSecret } from "../../.pi/extensions/pi-realtime/providers/openai/webrtc";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";
import { createWebRTCHelperServer } from "../../.pi/extensions/pi-realtime/media/webrtc-helper/server";

const root = mkdtempSync(join(tmpdir(), "pi-realtime-config-"));
const agentDir = join(root, ".pi", "agent");
const cwd = join(root, "workspace");
mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd);
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const azure = "https://example.openai.azure.com/openai/v1";
function settings(openai: object) { writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-realtime": { openai } })); }

// Sequential tests: never read real user credentials or contact a provider.
test("realtime configuration and transports", async (t) => {
 process.chdir(cwd);
 process.env.PI_CODING_AGENT_DIR = agentDir;
 for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_AUTH_MODE", "OPENAI_REALTIME_MODEL"]) delete process.env[key];
 try {
  await t.test("OpenAI defaults with no files", () => {
   const config = openAIConnectionConfig();
   assert.equal(config.baseURL, "https://api.openai.com/v1"); assert.equal(config.authMode, "bearer");
   assert.equal(config.model, "gpt-realtime-mini");
  });
  await t.test("global namespaced settings and isolated auth entry", () => {
   settings({ baseUrl: azure + "/", model: "gpt-realtime-2.1-mini" });
   writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "unrelated-coding-key" }, "pi-realtime:openai": { type: "api_key", key: "test-azure-key" } }));
   const config = openAIConnectionConfig();
   assert.equal(config.apiKey, "test-azure-key"); assert.equal(config.authMode, "api-key");
   assert.equal(config.baseURL, azure); assert.equal(config.model, "gpt-realtime-2.1-mini");
   assert.equal(process.env.OPENAI_API_KEY, undefined);
  });
  await t.test("shell > project dotenv > global, reloads without process mutation", () => {
   writeFileSync(join(cwd, ".env"), 'export OPENAI_API_KEY="project-key"\nOPENAI_REALTIME_MODEL=deployment-custom # comment\n');
   const env = { PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "shell-key" };
   assert.equal(loadRealtimeEnv(env).OPENAI_API_KEY, "shell-key");
   assert.equal(loadRealtimeEnv(env).OPENAI_REALTIME_MODEL, "deployment-custom");
   assert.deepEqual(env, { PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: "shell-key" });
   assert.equal(loadRealtimeEnv({ PI_CODING_AGENT_DIR: agentDir }).OPENAI_API_KEY, "project-key");
   rmSync(join(cwd, ".env"));
   assert.equal(loadRealtimeEnv().OPENAI_API_KEY, "test-azure-key");
   assert.equal(loadRealtimeEnv({}, cwd, root).OPENAI_API_KEY, "test-azure-key");
   assert.equal(loadRealtimeEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent" }, cwd, root).OPENAI_API_KEY, "test-azure-key");
  });
  await t.test("validates config without echoing secrets", () => {
   writeFileSync(join(agentDir, "settings.json"), '{"secret":"do-not-echo",');
   assert.throws(() => openAIConnectionConfig(), (error: Error) => !error.message.includes("do-not-echo") && error.message.includes("Invalid JSON"));
   settings({ baseUrl: azure, authMode: "invalid" }); assert.throws(() => openAIConnectionConfig(), /authMode/);
   for (const baseUrl of ["not-a-url", "http://example.com/v1", "https://secret@example.com/v1", azure + "?key=secret", azure + "#fragment"]) {
    settings({ baseUrl }); assert.throws(() => openAIConnectionConfig());
   }
   settings({ baseUrl: azure, model: 42 }); assert.throws(() => openAIConnectionConfig(), /model must be/);
   settings({ baseUrl: azure, model: "gpt-realtime-2.1-mini" });
  });
  await t.test("HTTP Azure uses api-key only; OpenAI uses Bearer", async () => {
   for (const authMode of ["api-key", "bearer"]) {
    const config = { ...openAIConnectionConfig(), authMode };
    const client = createOpenAIRealtimeClient(config);
    client.fetch = async (url, init) => {
     assert.equal(String(url), azure + "/realtime/client_secrets");
     const headers = new Headers(init?.headers);
     assert.equal(headers.get("api-key"), authMode === "api-key" ? "test-azure-key" : null);
     assert.equal(headers.get("authorization"), authMode === "bearer" ? "Bearer test-azure-key" : null);
     return Response.json({ value: "ek_test" });
    };
    await client.realtime.clientSecrets.create({ session: { type: "realtime", model: "test" } });
   }
  });
  await t.test("WebRTC returns matching calls URL and only ephemeral credential", async () => {
   globalThis.fetch = async (url, init) => {
    assert.equal(String(url), azure + "/realtime/client_secrets");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(new Headers(init?.headers).get("api-key"), "test-azure-key");
    const body = JSON.parse(String(init?.body)); assert.equal(body.session.model, "gpt-realtime-2.1-mini");
    return Response.json({ value: "ek_test", expires_at: 123 });
   };
   const response = await createOpenAIWebRTCClientSecret({ model: "gpt-realtime-2.1-mini", instructions: "Test", interaction: providerInteractionFor("eco") });
   assert.equal(response.callsUrl, azure + "/realtime/calls");
   assert.equal(response.value, "ek_test"); assert.ok(!JSON.stringify(response).includes("test-azure-key"));
   globalThis.fetch = originalFetch;
  });
  await t.test("WebSocket strips SDK Bearer header for api-key authentication", () => {
   const options = openAIWebSocketOptions(openAIConnectionConfig());
   assert.equal((options.headers as Record<string, string>)["api-key"], "test-azure-key");
   let removed = "", ended = false;
   options.finishRequest!({ removeHeader(name: string) { removed = name; }, end() { ended = true; } } as any, {} as any);
   assert.equal(removed, "Authorization"); assert.equal(ended, true);
   assert.deepEqual(openAIWebSocketOptions({ ...openAIConnectionConfig(), authMode: "bearer" }), {});
  });
  await t.test("new models use existing speech profiles", () => {
   assert.ok(OPENAI_REALTIME_MODELS.includes("gpt-realtime-2.1"));
   assert.equal(openAIBehaviorProfileForModel("gpt-realtime-2.1-mini"), openAIBehaviorProfileForModel("gpt-realtime-mini"));
   assert.equal(openAIBehaviorProfileForModel("gpt-realtime-2.1"), openAIBehaviorProfileForModel("gpt-realtime-2"));
  });
  await t.test("browser assets work outside extension checkout", async () => {
   const helper = createWebRTCHelperServer(); await helper.start();
   try {
    const url = helper.urlFor("test");
    assert.equal((await fetch(url)).status, 200);
    const js = await fetch(new URL("/pi-realtime/webrtc/client.js", url)).then(r => r.text());
    assert.match(js, /fetch\(secret.callsUrl/); assert.ok(!js.includes("https://api.openai.com/v1/realtime/calls"));
   } finally { await helper.stop(); }
  });
 } finally {
  globalThis.fetch = originalFetch; process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv); rmSync(root, { recursive: true, force: true });
 }
});
