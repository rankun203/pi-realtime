import { createOpenAIRealtimeClient } from "./connection";
import type { ClientSecretCreateResponse } from "openai/resources/realtime/client-secrets";
import type { ProviderInteractionConfig } from "../../types";
import { buildOpenAIRealtimeAudioConfig, openAIRealtimeAudioInput } from "./session-config";
import { hasOpenAIRealtimeCredentials, toOpenAITool } from "./shared";

/** @deprecated Use hasOpenAIRealtimeCredentials from ./shared instead. */
export const hasOpenAIWebRTCCredentials = hasOpenAIRealtimeCredentials;

export async function createOpenAIWebRTCClientSecret(input: {
	model: string;
	instructions: string;
	interaction: ProviderInteractionConfig;
}): Promise<ClientSecretCreateResponse & { callsUrl: string }> {
	const client = createOpenAIRealtimeClient();
	const secret = await client.realtime.clientSecrets.create({
		expires_after: { anchor: "created_at", seconds: 600 },
		session: {
			type: "realtime",
			model: input.model,
			instructions: input.instructions,
			output_modalities: ["audio"],
			audio: buildOpenAIRealtimeAudioConfig(openAIRealtimeAudioInput(input.interaction)),
			tools: input.interaction.tools.map(toOpenAITool),
			tool_choice: input.interaction.toolChoice,
		},
	});
	return { ...secret, callsUrl: `${client.baseURL}/realtime/calls` };
}
