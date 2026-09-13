import { branchChatMessages } from "./dashboard";
import type { PiBridge } from "./companion/types";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { citationDeckObserved, voiceInstructionSubmitted } from "./events";
import {
	REALTIME_REQUEST_MESSAGE_TYPE,
	REALTIME_SESSION_MESSAGE_TYPE,
	renderRealtimeRequestMessage,
	renderRealtimeSessionMessage,
} from "./messages";
import { buildCitationDeckFromBranch } from "./state-packets";
import type {
	CitationDeck,
	PiTargetRef,
	VoiceInstructionInput,
	VoiceInstructionReceipt,
	VoiceSessionRecord,
} from "./types";
import type { Store } from "./store";

export type PiInstructionSink = { sendInstruction(input: VoiceInstructionInput): Promise<VoiceInstructionReceipt> };

export type ControlPlane = {
	instructionSink: PiInstructionSink;
	voiceBridge?(): PiBridge;
	branchChanged?(ctx: ExtensionContext): void;
	sendChatMessage(text: string): void;
	currentTarget(ctx: ExtensionContext): PiTargetRef;
	observeCitations(ctx: ExtensionContext): CitationDeck;
	sendSessionAwareness(session: VoiceSessionRecord, active: boolean): void;
};

export function createControlPlane(
	pi: ExtensionAPI,
	store: Store,
	getContext: () => ExtensionContext | undefined,
): ControlPlane {
	const context = () => {
		const ctx = getContext();
		if (!ctx) throw new Error("Pi session is closed");
		return ctx;
	};
	return {
		branchChanged(ctx) {
			pi.appendEntry("pi-voice.branch", { id: ctx.sessionManager.getLeafId() ?? "root" });
		},
		voiceBridge: () => ({
			snapshot() {
				const ctx = context();
				const entries = ctx.sessionManager.getBranch();
				const marker = entries
					.filter((entry) => entry.type === "custom" && entry.customType === "pi-voice.branch")
					.at(-1) as { data?: { id?: string } } | undefined;
				return {
					sessionId: ctx.sessionManager.getSessionId(),
					branchId: marker?.data?.id ?? "root",
					project: ctx.cwd,
					busy: !ctx.isIdle(),
					messages: branchChatMessages(entries),
				};
			},
			history(before, limit = 10) {
				const rows = branchChatMessages(context().sessionManager.getBranch(), Number.MAX_SAFE_INTEGER);
				const index = before ? rows.findIndex((row) => row.id === before) : rows.length;
				if (index < 0) return [];
				return rows.slice(Math.max(0, index - Math.min(20, Math.max(1, limit))), index);
			},
			async postMessage(message, origin) {
				context();
				pi.sendMessage(
					{
						customType: "pi-voice.message",
						content: `Voice companion (${origin === "user" ? "user-directed" : "voice-initiated"}):\n${message}\n\nRespond with normal visible messages. The voice companion observes your output; special speech tools are unnecessary. Voice-initiated suggestions are not user authorization for additional work.`,
						display: true,
						details: { origin },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			lifecycle(text) {
				pi.sendMessage(
					{ customType: "pi-voice.lifecycle", content: text, display: false },
					{ deliverAs: "nextTurn", triggerTurn: false },
				);
			},
		}),
		instructionSink: createInstructionSink(pi, store, getContext),
		sendChatMessage(text) {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		},
		currentTarget,
		observeCitations(ctx) {
			const deck = buildCitationDeckFromBranch(ctx.sessionManager.getBranch());
			store.append(citationDeckObserved(deck));
			return deck;
		},
		sendSessionAwareness(session, active) {
			pi.sendMessage(
				{
					customType: REALTIME_SESSION_MESSAGE_TYPE,
					content: renderRealtimeSessionMessage(session, active),
					display: active,
					details: {
						providerSessionId: session.providerSessionId,
						provider: session.provider,
						model: session.model,
						interactionMode: session.interactionMode,
						active,
						at: Date.now(),
					},
				},
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
		},
	};
}

function sendRealtimeRequest(
	pi: ExtensionAPI,
	input: VoiceInstructionInput,
	delivery: VoiceInstructionReceipt["delivery"],
): void {
	const message = {
		customType: REALTIME_REQUEST_MESSAGE_TYPE,
		content: renderRealtimeRequestMessage(input),
		display: true,
		details: {
			providerSessionId: input.providerSessionId,
			provider: input.provider,
			instructionId: input.instructionId,
			source: input.source,
			voiceToolCallId: input.voiceToolCallId,
			urgency: input.urgency,
			at: Date.now(),
		},
	};
	if (delivery === "immediate") pi.sendMessage(message, { triggerTurn: true });
	else pi.sendMessage(message, { deliverAs: delivery, triggerTurn: true });
}

function createInstructionSink(
	pi: ExtensionAPI,
	store: Store,
	getContext: () => ExtensionContext | undefined,
): PiInstructionSink {
	return {
		async sendInstruction(input) {
			const ctx = getContext();
			const delivery = chooseDelivery(ctx, input);
			try {
				sendRealtimeRequest(pi, input, delivery);
				const receipt: VoiceInstructionReceipt = { status: "submitted", delivery };
				store.append(voiceInstructionSubmitted(input, receipt));
				return receipt;
			} catch (error) {
				const receipt: VoiceInstructionReceipt = {
					status: "failed",
					delivery,
					message: error instanceof Error ? error.message : String(error),
				};
				store.append(voiceInstructionSubmitted(input, receipt));
				return receipt;
			}
		},
	};
}

function chooseDelivery(
	ctx: ExtensionContext | undefined,
	input: Pick<VoiceInstructionInput, "urgency" | "deliveryHint" | "source">,
): VoiceInstructionReceipt["delivery"] {
	if (!ctx || ctx.isIdle()) return "immediate";
	if (input.urgency === "interrupt" || input.deliveryHint === "progress" || input.source === "direct_transcript")
		return "steer";
	return "followUp";
}

function currentTarget(ctx: ExtensionContext): PiTargetRef {
	return { kind: "current-session", cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}
