import {
	STRONG_REALTIME_SPEECH_RENDERER_PROFILE,
	WEAK_REALTIME_SPEECH_RENDERER_PROFILE,
} from "../../domain/behavior-profiles";
import type { RealtimeBehaviorProfileFragment } from "../../types";

export const OPENAI_REALTIME_MODELS = [
	"gpt-realtime-mini",
	"gpt-realtime-2",
	"gpt-realtime-2.1-mini",
	"gpt-realtime-2.1",
] as const;

export function openAIBehaviorProfileForModel(model: string): RealtimeBehaviorProfileFragment {
	if (model === "gpt-realtime-mini" || model === "gpt-realtime-2.1-mini") return WEAK_REALTIME_SPEECH_RENDERER_PROFILE;
	if (model === "gpt-realtime-2" || model === "gpt-realtime-2.1") return STRONG_REALTIME_SPEECH_RENDERER_PROFILE;
	return {};
}
