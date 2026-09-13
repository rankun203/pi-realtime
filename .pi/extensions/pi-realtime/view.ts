import type { RealtimeState } from "./types";
import { aggregateUsage, formatUsageCost } from "./usage";

export { aggregateUsage, renderUsageSummary } from "./usage";

export function statusText(state: RealtimeState): string | undefined {
	const sessions = [...state.sessions.values()];
	const active = sessions.filter((session) => session.status === "active" || session.status === "starting");
	if (active.length === 0) return undefined;
	const status = `pi-realtime: ${active.length} active`;
	const usage = aggregateUsage(state.usage, undefined, state.usageResets);
	return usage.observations
		? `${status} · ${usage.totalTokens.toLocaleString("en-US")} voice tokens · ${formatUsageCost(usage)}`
		: status;
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
