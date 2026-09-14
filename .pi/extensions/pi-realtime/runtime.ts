import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleRealtimeCommand, realtimeCompletions } from "./commands";
import { filterRealtimeContextMessages } from "./context";
import { createControlPlane } from "./control-plane";
import { registerRealtimeMessageRenderers } from "./messages";
import { createService, type Service } from "./service";
import { createStore, type Store } from "./store";
import { registerRealtimeModelTools } from "./tools/pi";
import { statusText } from "./view";

const STATUS_KEY = "pi-realtime";
const WIDGET_KEY = "pi-realtime.widget";
const FOOTER_REFRESH_MS = 1000;

export function registerPiRealtime(pi: ExtensionAPI): void {
	const store = createStore(pi);
	let currentCtx: ExtensionContext | undefined;
	const controlPlane = createControlPlane(pi, store, () => currentCtx);
	const service = createService(store, controlPlane, () => {
		if (currentCtx) syncUi(currentCtx, service);
	});
	// Refresh countdowns without persisting timer ticks or waiting for another paid response.
	let hadVoiceTelemetry = false;
	const footerTimer = setInterval(() => {
		const hasVoiceTelemetry = !!service.voiceTelemetry();
		if (currentCtx && (hasVoiceTelemetry || hadVoiceTelemetry)) syncUi(currentCtx, service);
		hadVoiceTelemetry = hasVoiceTelemetry;
	}, FOOTER_REFRESH_MS);
	footerTimer.unref();
	registerRealtimeMessageRenderers(pi);

	pi.registerCommand("realtime", {
		description: "Manage realtime voice provider sessions for Pi",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			await handleRealtimeCommand(args, ctx, service);
			syncUi(ctx, service);
		},
		getArgumentCompletions: async () => realtimeCompletions().map((value) => ({ value, label: value })),
	});

	registerRealtimeModelTools(pi, service);

	pi.registerCommand("pi-realtime", {
		description: "Alias for /realtime",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			await handleRealtimeCommand(args, ctx, service);
			syncUi(ctx, service);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		hydrate(ctx, store, service);
		syncUi(ctx, service);
	});
	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		controlPlane.branchChanged?.(ctx);
		hydrate(ctx, store, service);
		syncUi(ctx, service);
	});
	pi.on("session_compact", async (_event, ctx) => {
		currentCtx = ctx;
		hydrate(ctx, store, service);
		syncUi(ctx, service);
	});
	pi.on("context", (event) => filterRealtimeContextMessages(event, service.state()));
	pi.on("session_shutdown", async () => {
		clearInterval(footerTimer);
		await service.shutdown();
		currentCtx = undefined;
	});
}

function hydrate(ctx: ExtensionContext, store: Store, service: Service): void {
	store.hydrate(ctx);
	service.refresh(ctx);
}

function syncUi(ctx: ExtensionContext, service: Service): void {
	const state = service.state();
	ctx.ui.setStatus(STATUS_KEY, statusText(state, service.voiceTelemetry()));
	// Clear the legacy session-list widget, including after /reload.
	// History remains available on demand through /realtime status.
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}
