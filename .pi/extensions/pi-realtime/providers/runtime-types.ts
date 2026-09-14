import type { DashboardBridge } from "../dashboard";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ContextPacket,
	ProviderInteractionConfig,
	ProviderKind,
	ProviderMediaMode,
	ProviderPreferences,
	ProviderSessionId,
	RealtimeBehaviorProfileFragment,
	VoiceSessionRecord,
	VoiceToolSurface,
} from "../types";
import type { ProviderEventSink, RealtimeProviderAdapter } from "./types";

export type ProviderAdapterInput = {
	providerSessionId: ProviderSessionId;
};

export type ProviderMediaStartInput = {
	session: VoiceSessionRecord;
	ctx: ExtensionContext;
	surface: VoiceToolSurface;
	systemPrompt: string;
	interaction: ProviderInteractionConfig;
	sink: ProviderEventSink;
	packets: ContextPacket[];
	currentAdapter?: RealtimeProviderAdapter;
	dashboard?: DashboardBridge;
	setAdapter(adapter: RealtimeProviderAdapter): void;
	stopLocalMedia(providerSessionId: ProviderSessionId): Promise<void>;
	recordContext(packet: ContextPacket, adapter: RealtimeProviderAdapter): Promise<void>;
};

export type VoiceTelemetry = {
	/** Logical session owning the connected voice device. */
	providerSessionId: ProviderSessionId;
	/** Provider expiry in epoch milliseconds, or the local connection's estimated 60-minute deadline. */
	expiresAt: number;
	/** Input tokens reported for the latest native conversation response; absent before one arrives. */
	contextInputTokens?: number;
	/** Published model context window in tokens; absent for unverified models. */
	contextWindowTokens?: number;
};

export type ProviderMediaRuntime = {
	start(input: ProviderMediaStartInput): Promise<string>;
	stop(providerSessionId?: ProviderSessionId): Promise<void>;
	status(): string;
	/** Live device telemetry, absent while disconnected or when this transport cannot report it. */
	voiceTelemetry?(): VoiceTelemetry | undefined;
	urlFor?(providerSessionId: ProviderSessionId): string;
};

export type ProviderRuntime = {
	provider: ProviderKind;
	defaultModel(): string;
	availableModels?(): readonly string[];
	behaviorProfileForModel?(model: string): RealtimeBehaviorProfileFragment;
	assertCredentials(): void;
	createAdapter(input: ProviderAdapterInput): RealtimeProviderAdapter;
	media?: Partial<Record<ProviderMediaMode, ProviderMediaRuntime>>;
	warningForPreferences?(preferences: ProviderPreferences): string | undefined;
};

export type ProviderRuntimeRegistry = {
	get(provider: ProviderKind): ProviderRuntime | undefined;
	list(): ProviderRuntime[];
};
