import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { loadRealtimeEnv, loadRealtimeWebPort } from "../../.pi/extensions/pi-realtime/env";
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
 for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_AUTH_MODE", "OPENAI_REALTIME_MODEL", "OPENAI_REALTIME_TRANSCRIPTION_MODEL", "PI_REALTIME_WEB_PORT"]) delete process.env[key];
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
    const client = createOpenAIRealtimeClient(config).withOptions({ fetch: async (url, init) => {
     assert.equal(String(url), azure + "/realtime/client_secrets");
     const headers = new Headers(init?.headers);
     assert.equal(headers.get("api-key"), authMode === "api-key" ? "test-azure-key" : null);
     assert.equal(headers.get("authorization"), authMode === "bearer" ? "Bearer test-azure-key" : null);
     return Response.json({ value: "ek_test" });
    } });
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
  await t.test("fixed loopback port configuration validates and can retry a failed bind", async () => {
   assert.equal(loadRealtimeWebPort(), 0);
   writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-realtime": { web: { port: 8787 } } }));
   assert.equal(loadRealtimeWebPort(), 8787);
   assert.equal(loadRealtimeWebPort({ ...process.env, PI_REALTIME_WEB_PORT: "0" }), 0);
   for (const port of ["", "-1", "65536", "1.5", "abc"]) assert.throws(() => loadRealtimeWebPort({ ...process.env, PI_REALTIME_WEB_PORT: port }), /integer/);
   const occupied = createServer();
   await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
   const port = (occupied.address() as { port: number }).port;
   process.env.PI_REALTIME_WEB_PORT = String(port);
   const helper = createWebRTCHelperServer();
   try {
    await assert.rejects(helper.start(), /EADDRINUSE/);
    assert.equal(helper.status(), "webrtc helper: stopped");
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await helper.start();
    assert.equal(new URL(helper.urlFor("test")).port, String(port));
    assert.equal(new URL(helper.urlFor("test")).hostname, "127.0.0.1");
   } finally {
    occupied.close(); await helper.stop(); delete process.env.PI_REALTIME_WEB_PORT;
    settings({ baseUrl: azure, model: "gpt-realtime-2.1-mini" });
   }
  });
  await t.test("browser assets work outside extension checkout", async () => {
   const helper = createWebRTCHelperServer(); await helper.start();
   try {
    const url = helper.urlFor("test");
    assert.equal((await fetch(url)).status, 200);
    let issuedTokens = 0;
    helper.registerSession({ provider: "openai", providerSessionId: "test", model: "test", instructions: "Test", interaction: providerInteractionFor("agent"), toolSurface: { revision: 1, tools: [] }, initialContext: {} as any, async createClientSecret() { issuedTokens++; return { value: "ek_test" }; } }, { onProviderEvent() {} });
    const crossOriginHeaders: Record<string, string>[] = [{ origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of crossOriginHeaders) {
     assert.equal((await fetch(url + "/client-secret", { method: "POST", headers })).status, 403);
    }
    assert.equal(issuedTokens, 0);
    // A reverse proxy preserves the public Host and browser Origin headers.
    const proxyHeaders = { host: "voice.example.com", origin: "https://voice.example.com", "sec-fetch-site": "same-origin" };
    const proxyStatus = (action: string, method: string) => new Promise<number | undefined>((resolve, reject) => {
     const request = httpRequest(url + action, { method, headers: proxyHeaders }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
     });
     request.on("error", reject); request.end();
    });
    assert.equal(await proxyStatus("/config", "GET"), 200);
    assert.equal(await proxyStatus("/client-secret", "POST"), 200);
    assert.equal(issuedTokens, 1);
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
