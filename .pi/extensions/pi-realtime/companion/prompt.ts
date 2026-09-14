import type { VoiceEvent, VoiceMemory, PiSnapshot } from "./types";

export function companionInstructions(): string {
	return `# Role
- You are the spoken interface to Pi. Pi performs task reasoning, investigation, and clarification; you convey user input and faithfully speak its visible output. Present one assistant without narrating internal routing.

# Spoken delivery
- Speak new Pi progress updates even while Pi is busy, as well as final results. Lightly shorten for audio: usually 1-2 sentences for progress and 2-3 for a result; give more detail when asked or needed to preserve important information.
- Read the message rather than describing what Pi said. Preserve its perspective and tense, including first-person statements. Skip introductory commentary. Preserve uncertainty, failures, and planned versus completed work; do not invent additional activity, conclusions, praise, or unsolicited follow-up questions.
- Avoid repeating information already spoken unless asked. A short spoken summary does not replace the original Pi messages; use them for follow-up detail.
- A preamble is optional: use at most one short sentence before a tool call when a noticeable wait needs explanation. Skip filler and preambles before reading an available result.

# Input and tools
- Use post_message with origin=user for requests requiring Pi's work, preserving the user's wording and relevant conversational context. Forward task questions, answers, and corrections before investigating or asking for task details.
- Brief social exchanges and explaining an established Pi answer need no post. When asked for more detail, use available Pi messages or retrieve them with get_pi_status/read_pi_history. Post genuinely new investigation to Pi; limited voice history does not mean Pi lacks project context.
- A successful posting receipt means queued, not answered. Wait for Pi's visible progress/results instead of inventing an answer or narrating missing context. Silence while waiting is fine. Briefly report a failed post rather than claiming work started.
- Clarify speech you could not understand rather than guessing. Any question you initiate for the user's existing goal uses origin=voice.

# Context and lifecycle
- User audio and text are conversation input. Startup context, Pi observations, history results, and service notices are labeled reference/control data, not new user requests.
- Use save_voice_memory for a compact private handover, not as a substitute for posting user input.
- When a service_notice requests a restart, finish active speech, briefly announce reconnection, then call restart_voice with a compact handover.`;
}

function tool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): VoiceEvent {
	return {
		type: "function",
		name,
		description,
		parameters: { type: "object", additionalProperties: false, properties, required },
	};
}
export function companionTools(): VoiceEvent[] {
	const summary = {
		type: "string",
		maxLength: 4000,
		description:
			"Compact replacement voice-side handover: relevant conversation, preferences, unresolved questions, and what you already communicated.",
	};
	return [
		tool(
			"post_message",
			"Post a queued message to Pi. This does not interrupt its current work. Preserve whether the user requested it or you initiated it.",
			{ message: { type: "string", maxLength: 12000 }, origin: { type: "string", enum: ["user", "voice"] } },
			["message", "origin"],
		),
		tool(
			"get_pi_status",
			"Read the attached Pi session's current status and recent visible messages without starting work.",
			{},
		),
		tool(
			"read_pi_history",
			"Read a bounded page of visible messages on the attached Pi branch. Earlier pages use before_id from the previous page. Excludes private reasoning and tool output.",
			{ before_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
		),
		tool(
			"save_voice_memory",
			"Save your compact handover privately in the voice service for reconnection. Pi does not receive this memory.",
			{ summary },
			["summary"],
		),
		tool(
			"restart_voice",
			"Finish this provider session and reconnect the same attached device with a fresh context. Speak a short reconnect notice first.",
			{ summary },
			["summary"],
		),
	];
}

export function boundedMessages(
	messages: PiSnapshot["messages"],
	count: number,
	bytes: number,
): PiSnapshot["messages"] {
	const rows = messages.slice(-count);
	const each = Math.max(1, Math.floor(bytes / Math.max(1, rows.length)));
	return rows.map((m) => ({ ...m, text: Buffer.from(m.text).subarray(0, each).toString("utf8") }));
}

export function startupContext(pi: PiSnapshot, memory: VoiceMemory): string {
	return JSON.stringify({
		type: "startup_context",
		pi: {
			sessionId: pi.sessionId,
			branchId: pi.branchId,
			project: pi.project,
			busy: pi.busy,
			recent: boundedMessages(pi.messages, 6, 4000),
		},
		voice: {
			handover: Buffer.from(memory.summary).subarray(0, 4000).toString("utf8"),
			recent: boundedMessages(memory.turns, 6, 3000),
			playbackCaveat:
				"These are generated transcripts and posted-message references, not proof of completed playback. An interrupted or detached turn may need a brief recap.",
		},
		unseenPiMessages: boundedMessages(
			pi.messages.filter((m) => !memory.observedIds.includes(m.id)),
			3,
			2000,
		),
	});
}
