export type VisibleMessage = { id: string; role: "user" | "assistant"; text: string; at: number; source?: string };
export type PiSnapshot = {
	sessionId: string;
	branchId: string;
	project: string;
	busy: boolean;
	messages: VisibleMessage[];
};
export type PiBridge = {
	snapshot(): PiSnapshot;
	history(before?: string, limit?: number): VisibleMessage[];
	postMessage(message: string, origin: "user" | "voice"): Promise<void>;
	lifecycle(text: string): void;
};
export type VoiceEvent = Record<string, any>;
export type VoiceConnection = { answer: string; send(event: VoiceEvent): void; close(): Promise<void> };
export type VoiceTransport = {
	connect(input: {
		sdp: string;
		model: string;
		instructions: string;
		tools: VoiceEvent[];
		onEvent(event: VoiceEvent): void;
		/** Reports why the provider control connection ended; never include credentials. */
		onClose(reason?: string): void;
	}): Promise<VoiceConnection>;
};
export type VoiceMemory = {
	version: 1;
	sessionId: string;
	branchId: string;
	summary: string;
	turns: VisibleMessage[];
	observedIds: string[];
};
export type CompanionOptions = {
	bridge: PiBridge;
	transport: VoiceTransport;
	model: string;
	stateDirectory: string;
	now?: () => number;
	onEvent?(event: VoiceEvent): void;
};
