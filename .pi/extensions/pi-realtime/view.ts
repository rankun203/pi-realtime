import type { RealtimeState } from "./types";
import { aggregateUsage, formatUsageCost } from "./usage";

export { aggregateUsage, renderUsageSummary } from "./usage";

export function statusText(state: RealtimeState): string | undefined {
	const sessions = [...state.sessions.values()];
	const active = sessions.filter((session) => session.status === "active" || session.status === "starting");
	if (active.length === 0) return undefined;
	const status = `pi-realtime: ${active.length} active`;
	const usage = aggregateUsage(state.usage, undefined, state.usageResets);
	const cached = usage.input.cachedTextTokens + usage.input.cachedAudioTokens + usage.input.cachedImageTokens;
	const input = usage.input.textTokens + usage.input.audioTokens + usage.input.imageTokens;
	const output = usage.output.textTokens + usage.output.audioTokens + usage.output.imageTokens;
	const tokens = [`↑${compactTokens(Math.max(0, input - cached))}`, `↓${compactTokens(output)}`];
	if (cached > 0) tokens.push(`R${compactTokens(cached)}`);
	if (usage.lastResponseCacheHitPercent !== undefined)
		tokens.push(`CH${usage.lastResponseCacheHitPercent.toFixed(1)}%`);
	const summary = usage.observations
		? `${active.length > 1 ? `${status} ·` : "pi-realtime:"} ${tokens.join(" ")} · ${formatUsageCost(usage)}`
		: status;
	// Show running models, not the preference used for future calls.
	const models = [...new Set(active.map((session) => session.model))].join(", ");
	return `${summary} · ${models}`;
}

function compactTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function renderStatusText(state: RealtimeState): string {
	const MAX_VISIBLE_SESSIONS = 6;
	const sessions = [...state.sessions.values()];
	if (sessions.length === 0) return "pi-realtime: no provider sessions";
	const active = sessions.filter((session) => session.status === "active" || session.status === "starting");
	const header = `pi-realtime: ${active.length}/${sessions.length} active provider session${sessions.length === 1 ? "" : "s"}`;
	const details = sessions
		.slice(-MAX_VISIBLE_SESSIONS)
		.map(
			(session) =>
				`${state.primaryProviderSessionId === session.providerSessionId ? "*" : "-"} ${session.providerSessionId} ${session.provider}/${session.model} mode=${session.interactionMode} ${session.status}${session.lastError ? ` error=${session.lastError}` : ""}`,
		);
	return [header, ...details].join("\n");
}
