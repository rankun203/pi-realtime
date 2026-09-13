import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Resolve extension-local settings without changing process.env. Read per connection. */
export function loadRealtimeEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), home = homedir()): NodeJS.ProcessEnv {
	const configuredDir = env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home);
	const settingsPath = resolve(configuredDir || resolve(home, ".pi", "agent"), "settings.json");
	return {
		...readRealtimeSettings(settingsPath),
		...readRealtimeAuth(resolve(settingsPath, "..", "auth.json")),
		...readEnvFile(resolve(cwd, ".env")),
		...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
	};
}

function readOptionalFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readJsonObject(path: string): Record<string, unknown> {
	const content = readOptionalFile(path);
	if (content === undefined) return {};
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		// Do not echo JSON parser excerpts: this file may contain credentials.
		throw new Error(`Invalid JSON in ${path}.`);
	}
	if (!isRecord(value)) throw new Error(`Expected an object in ${path}.`);
	return value;
}

function readRealtimeAuth(path: string): NodeJS.ProcessEnv {
	const entry = readJsonObject(path)["pi-realtime:openai"];
	if (entry === undefined) return {};
	if (!isRecord(entry) || entry.type !== "api_key" || typeof entry.key !== "string" || !entry.key.trim()) {
		throw new Error(`Expected an api_key credential for pi-realtime:openai in ${path}.`);
	}
	return { OPENAI_API_KEY: entry.key.trim() };
}

function readRealtimeSettings(path: string): NodeJS.ProcessEnv {
	const extension = readJsonObject(path)["pi-realtime"];
	if (extension === undefined) return {};
	if (!isRecord(extension)) throw new Error(`pi-realtime must be an object in ${path}.`);
	const openai = extension.openai;
	if (openai === undefined) return {};
	if (!isRecord(openai)) throw new Error(`pi-realtime.openai must be an object in ${path}.`);
	const values: NodeJS.ProcessEnv = {};
	for (const [field, variable] of Object.entries({ baseUrl: "OPENAI_BASE_URL", authMode: "OPENAI_AUTH_MODE", model: "OPENAI_REALTIME_MODEL" })) {
		const value = openai[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim()) throw new Error(`pi-realtime.openai.${field} must be a non-empty string in ${path}.`);
		values[variable] = value.trim();
	}
	return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvFile(path: string): NodeJS.ProcessEnv {
	const content = readOptionalFile(path);
	if (content === undefined) return {};
	const values: NodeJS.ProcessEnv = {};
	for (const line of content.split(/\r?\n/)) {
		const parsed = parseEnvLine(line);
		if (parsed) values[parsed[0]] = parsed[1];
	}
	return values;
}

function parseEnvLine(line: string): [string, string] | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
	if (!match) return undefined;
	return [match[1] ?? "", unquote(match[2] ?? "")];
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	const commentIndex = trimmed.indexOf(" #");
	return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}
