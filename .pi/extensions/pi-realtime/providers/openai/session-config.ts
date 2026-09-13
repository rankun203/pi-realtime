import type { RealtimeAudioConfig } from "openai/resources/realtime/realtime";
import type { ProviderInteractionConfig } from "../../types";
import { loadRealtimeEnv } from "../../env";

export type OpenAINoiseReductionMode = "near_field" | "far_field" | "off";
export type OpenAITurnControlMode = "manual_response_after_turn" | "auto_response";
export type OpenAIVadMode = "semantic" | "server";

export type OpenAIRealtimeAudioConfigInput = {
	turnControl?: OpenAITurnControlMode;
	noiseReduction?: OpenAINoiseReductionMode;
	vadMode?: OpenAIVadMode;
	includeRawPcmFormat?: boolean;
	includeRawPcmOutputFormat?: boolean;
	voice?: string;
	transcriptionModel?: string | null;
};

const DEFAULT_NOISE_REDUCTION: OpenAINoiseReductionMode = "near_field";
const DEFAULT_TURN_CONTROL: OpenAITurnControlMode = "manual_response_after_turn";
const DEFAULT_VAD_MODE: OpenAIVadMode = "server";
const DEFAULT_SERVER_VAD_THRESHOLD = 0.7;
const DEFAULT_SERVER_VAD_SILENCE_DURATION_MS = 700;
const DEFAULT_SERVER_VAD_PREFIX_PADDING_MS = 300;

/** Agent turns are driven by native audio VAD, not auxiliary transcription. */
export function openAIRealtimeAudioInput(
	interaction: ProviderInteractionConfig,
	env: NodeJS.ProcessEnv = process.env,
): OpenAIRealtimeAudioConfigInput {
	const native = interaction.transcriptHandling.response === "native";
	const configured = loadRealtimeEnv(env).OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim();
	if (configured === "off" && !native)
		throw new Error("Eco/manual transcript routing requires a transcription model; transcriptionModel cannot be off.");
	return {
		turnControl: native ? "auto_response" : "manual_response_after_turn",
		transcriptionModel: configured === "off" ? null : configured || (native ? null : "gpt-4o-mini-transcribe"),
	};
}

export function summarizeOpenAIRealtimeAudioConfig(
	input: OpenAIRealtimeAudioConfigInput = {},
): Record<string, unknown> {
	const audio = buildOpenAIRealtimeAudioConfig(input);
	const turnDetection = audio.input?.turn_detection;
	return {
		vadMode: turnDetection?.type,
		transcriptionModel: audio.input?.transcription?.model ?? "off",
		createResponse: isRecord(turnDetection) ? turnDetection.create_response : undefined,
		interruptResponse: isRecord(turnDetection) ? turnDetection.interrupt_response : undefined,
		noiseReduction: audio.input?.noise_reduction?.type ?? "off",
		semanticEagerness: isRecord(turnDetection) ? turnDetection.eagerness : undefined,
		serverVadThreshold: isRecord(turnDetection) ? turnDetection.threshold : undefined,
		serverVadSilenceDurationMs: isRecord(turnDetection) ? turnDetection.silence_duration_ms : undefined,
	};
}

export function buildOpenAIRealtimeAudioConfig(input: OpenAIRealtimeAudioConfigInput = {}): RealtimeAudioConfig {
	const noiseReduction = input.noiseReduction ?? DEFAULT_NOISE_REDUCTION;
	return {
		input: {
			...(input.includeRawPcmFormat ? { format: { type: "audio/pcm", rate: 24000 } } : {}),
			...(input.transcriptionModel === null
				? {}
				: { transcription: { model: input.transcriptionModel ?? "gpt-4o-mini-transcribe" } }),
			...(noiseReduction === "off" ? {} : { noise_reduction: { type: noiseReduction } }),
			turn_detection: turnDetectionConfig(input),
		},
		output: {
			...(input.includeRawPcmOutputFormat ? { format: { type: "audio/pcm", rate: 24000 } } : {}),
			voice: input.voice ?? "marin",
		},
	};
}

export function openAITurnResponseControl(input: OpenAIRealtimeAudioConfigInput = {}): {
	create_response: boolean;
	interrupt_response: true;
} {
	return { create_response: (input.turnControl ?? DEFAULT_TURN_CONTROL) === "auto_response", interrupt_response: true };
}

export function isOpenAITranscriptActionable(transcript: string): boolean {
	return transcript.replace(/[\s\p{P}\p{S}]/gu, "").length >= 4;
}

function turnDetectionConfig(
	input: OpenAIRealtimeAudioConfigInput,
): NonNullable<NonNullable<RealtimeAudioConfig["input"]>["turn_detection"]> {
	const responseControl = openAITurnResponseControl(input);
	if ((input.vadMode ?? DEFAULT_VAD_MODE) === "server") {
		return {
			type: "server_vad",
			threshold: DEFAULT_SERVER_VAD_THRESHOLD,
			silence_duration_ms: DEFAULT_SERVER_VAD_SILENCE_DURATION_MS,
			prefix_padding_ms: DEFAULT_SERVER_VAD_PREFIX_PADDING_MS,
			idle_timeout_ms: null,
			...responseControl,
		};
	}
	return { type: "semantic_vad", ...responseControl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
