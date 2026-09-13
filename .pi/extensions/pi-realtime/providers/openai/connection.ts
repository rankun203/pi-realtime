import OpenAI from "openai";
import type { ClientOptions } from "ws";
import { loadRealtimeEnv } from "../../env";

export function openAIConnectionConfig(env: NodeJS.ProcessEnv = process.env) {
	const values = loadRealtimeEnv(env);
	let base: URL;
	try {
		base = new URL(values.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1");
	} catch {
		throw new Error("Invalid realtime baseUrl / OPENAI_BASE_URL.");
	}
	if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
		throw new Error("Realtime baseUrl must be an HTTPS API root without credentials, query parameters, or a fragment.");
	}
	const baseURL = base.toString().replace(/\/+$/, "");
	const authMode = values.OPENAI_AUTH_MODE?.trim() || (base.hostname.endsWith(".openai.azure.com") ? "api-key" : "bearer");
	if (authMode !== "bearer" && authMode !== "api-key") throw new Error("Realtime authMode must be bearer or api-key.");
	return { baseURL, authMode, callsUrl: `${baseURL}/realtime/calls`, apiKey: values.OPENAI_API_KEY?.trim(), model: values.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-mini" };
}

export function createOpenAIRealtimeClient(config = openAIConnectionConfig()): OpenAI {
	const apiKey = config.apiKey;
	if (!apiKey || apiKey === "REPLACE_WITH_YOUR_AZURE_API_KEY") throw new Error("Set the pi-realtime:openai credential in Pi's auth.json or OPENAI_API_KEY.");
	return new OpenAI({
		baseURL: config.baseURL,
		apiKey,
		defaultHeaders: config.authMode === "api-key" ? { "api-key": apiKey, Authorization: null } : undefined,
	});
}

export function openAIWebSocketOptions(config: ReturnType<typeof openAIConnectionConfig>): ClientOptions {
	if (config.authMode !== "api-key") return {};
	if (!config.apiKey) throw new Error("Realtime API key is missing.");
	return {
		headers: { "api-key": config.apiKey },
		// The SDK unconditionally adds Bearer auth for non-AzureOpenAI clients.
		// Use the GA /v1 URL, but remove that header before the handshake is sent.
		finishRequest(request) { request.removeHeader("Authorization"); request.end(); },
	};
}
