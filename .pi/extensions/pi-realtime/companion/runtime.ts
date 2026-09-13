import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedMessages, companionInstructions, companionTools, startupContext } from "./prompt";
import type { CompanionOptions, PiSnapshot, VoiceConnection, VoiceEvent, VoiceMemory } from "./types";

type Lease = {
	token: string;
	seenAt: number;
	startedAt: number;
	connection?: VoiceConnection;
	speaking: boolean;
	responding: boolean;
	playing: boolean;
	awaitingNative: boolean;
	pending: boolean;
	restart: boolean;
	noticeSent: boolean;
	toolIds: Set<string>;
	toolsPending: number;
};
export class VoiceCompanion {
	private lease?: Lease;
	private operations: Promise<unknown> = Promise.resolve();
	private memory: VoiceMemory;
	private readonly path: string;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly now: () => number;
	private snapshot: PiSnapshot;
	private closed = false;
	constructor(private readonly options: CompanionOptions) {
		this.now = options.now ?? Date.now;
		const initial = options.bridge.snapshot();
		this.snapshot = { ...initial, messages: [...initial.messages] };
		mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
		this.path = join(
			options.stateDirectory,
			`${createHash("sha256").update(this.snapshot.sessionId).digest("hex")}.json`,
		);
		this.memory = this.emptyMemory(this.snapshot);
		try {
			const data = JSON.parse(readFileSync(this.path, "utf8"));
			if (
				data.version === 1 &&
				data.sessionId === this.snapshot.sessionId &&
				data.branchId === this.snapshot.branchId &&
				typeof data.summary === "string" &&
				data.summary.length <= 4000 &&
				Array.isArray(data.turns) &&
				Array.isArray(data.observedIds)
			) {
				this.memory = {
					...this.memory,
					summary: data.summary,
					turns: data.turns
						.filter(
							(m: any) =>
								typeof m.id === "string" && ["user", "assistant"].includes(m.role) && typeof m.text === "string",
						)
						.slice(-24),
					observedIds: data.observedIds.filter((id: unknown) => typeof id === "string").slice(-200),
				};
			}
		} catch {
			/* First use or an invalid handover: rebuild from authoritative Pi state. */
		}
		this.timer = setInterval(() => {
			void this.tick()
				.catch(() => this.detach())
				.catch(() => {});
		}, 1000);
		this.timer.unref();
	}
	private emptyMemory(pi: PiSnapshot): VoiceMemory {
		return { version: 1, sessionId: pi.sessionId, branchId: pi.branchId, summary: "", turns: [], observedIds: [] };
	}
	private save(): void {
		const temp = `${this.path}.${randomUUID()}.tmp`;
		writeFileSync(temp, JSON.stringify(this.memory), { mode: 0o600, flag: "wx" });
		renameSync(temp, this.path);
	}
	status() {
		return {
			connected: !!this.lease,
			restart:
				!!this.lease?.restart &&
				((!this.lease.responding && !this.lease.playing && !this.lease.speaking && !this.lease.awaitingNative) ||
					this.now() - this.lease.startedAt > 59 * 60000),
			model: this.options.model,
		};
	}
	messages() {
		return this.memory.turns;
	}
	async connect(sdp: string, takeover = false): Promise<{ answer: string; lease: string }> {
		const operation = this.operations.then(async () => {
			if (this.closed) throw new Error("Voice companion closed");
			if (this.lease && !takeover)
				throw Object.assign(new Error("Another device owns this voice conversation. Explicit takeover required."), {
					statusCode: 409,
				});
			await this.detach();
			await this.observe();
			if (this.closed) throw new Error("Pi session changed; open its own voice companion");
			const lease: Lease = {
				token: randomUUID(),
				seenAt: this.now(),
				startedAt: this.now(),
				speaking: false,
				responding: false,
				playing: false,
				awaitingNative: false,
				pending: false,
				restart: false,
				noticeSent: false,
				toolIds: new Set(),
				toolsPending: 0,
			};
			this.lease = lease;
			try {
				const connection = await this.options.transport.connect({
					sdp,
					model: this.options.model,
					instructions: companionInstructions(),
					tools: companionTools(),
					onEvent: (event) => this.onEvent(lease, event),
					onClose: () => {
						if (this.lease === lease) void this.detach();
					},
				});
				if (this.lease !== lease || this.closed) {
					await connection.close();
					throw new Error("Voice connection superseded");
				}
				lease.connection = connection;
				this.send({
					type: "conversation.item.create",
					item: {
						type: "message",
						role: "system",
						content: [{ type: "input_text", text: startupContext(this.snapshot, this.memory) }],
					},
				});
				this.memory.observedIds = this.snapshot.messages.map((m) => m.id).slice(-200);
				this.save();
				this.options.bridge.lifecycle(
					"Voice device connected. Continue normal work; voice observes your ordinary visible output. No acknowledgement or special speech tools are needed.",
				);
				return { answer: connection.answer, lease: lease.token };
			} catch (error) {
				if (this.lease === lease) await this.detach();
				throw error;
			}
		});
		this.operations = operation.catch(() => {});
		return operation;
	}
	heartbeat(token: string) {
		if (!this.lease || this.lease.token !== token)
			throw Object.assign(new Error("Device lease expired or taken over"), { statusCode: 409 });
		this.lease.seenAt = this.now();
		return this.status();
	}
	async release(token: string): Promise<void> {
		if (this.lease?.token === token) await this.detach();
	}
	async detach(): Promise<void> {
		const lease = this.lease;
		this.lease = undefined;
		if (!lease) return;
		try {
			this.save();
		} finally {
			try {
				await lease.connection?.close();
			} finally {
				this.options.bridge.lifecycle(
					"Voice device disconnected. Continue normal work uninterrupted. No acknowledgement needed.",
				);
			}
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		await this.detach();
	}
	async tick(): Promise<void> {
		await this.observe();
		const lease = this.lease;
		if (!lease) return;
		if (this.now() - lease.seenAt > 45000) {
			await this.detach();
			return;
		}
		const age = this.now() - lease.startedAt;
		if (age > 58 * 60000) {
			lease.restart = true;
			return;
		}
		if (age > 55 * 60000 && !lease.noticeSent && !lease.responding && !lease.speaking) this.requestRestart();
		this.flush();
	}
	private async observe(): Promise<void> {
		const pi = this.options.bridge.snapshot();
		if (pi.sessionId !== this.memory.sessionId) {
			await this.close();
			return;
		}
		if (pi.branchId !== this.memory.branchId) {
			await this.detach();
			this.memory = this.emptyMemory(pi);
			this.save();
		}
		const changed = pi.messages.filter((m) => !this.snapshot.messages.some((previous) => previous.id === m.id));
		this.snapshot = { ...pi, messages: [...pi.messages] };
		if (!this.lease?.connection || !changed.length) return;
		const recent = boundedMessages(changed, 8, 8000);
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "system",
				content: [
					{ type: "input_text", text: JSON.stringify({ type: "pi_observation", busy: pi.busy, messages: recent }) },
				],
			},
		});
		this.memory.observedIds = [...this.memory.observedIds, ...recent.map((m) => m.id)].slice(-200);
		this.save();
		if (recent.some((m) => m.role === "assistant")) this.lease.pending = true;
	}
	private requestRestart(): void {
		const lease = this.lease;
		if (!lease || lease.noticeSent) return;
		lease.noticeSent = true;
		this.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "system",
				content: [
					{
						type: "input_text",
						text: JSON.stringify({
							type: "service_notice",
							action: "restart",
							text: "Prepare a fresh voice session. Briefly tell the user you need to reconnect, then invoke restart_voice with a concise handover.",
						}),
					},
				],
			},
		});
		lease.pending = true;
	}
	private send(event: VoiceEvent): void {
		this.lease?.connection?.send(event);
	}
	private flush(): void {
		const lease = this.lease;
		if (
			!lease?.connection ||
			!lease.pending ||
			lease.responding ||
			lease.speaking ||
			lease.awaitingNative ||
			lease.playing ||
			lease.restart ||
			lease.toolsPending
		)
			return;
		lease.pending = false;
		lease.responding = true;
		this.send({ type: "response.create", response: { output_modalities: ["audio"] } });
	}
	private onEvent(lease: Lease, event: VoiceEvent): void {
		if (this.lease !== lease) return;
		this.options.onEvent?.(event);
		if (event.type === "input_audio_buffer.speech_started") {
			lease.speaking = true;
			lease.awaitingNative = true;
		}
		if (event.type === "input_audio_buffer.speech_stopped") lease.speaking = false;
		if (event.type === "response.created") {
			lease.responding = true;
			lease.awaitingNative = false;
		}
		if (event.type === "output_audio_buffer.started") lease.playing = true;
		if (["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(event.type)) lease.playing = false;
		if (event.type === "error") {
			lease.responding = false;
			lease.awaitingNative = false;
			if (String(event.error?.code).includes("context_length")) {
				lease.restart = true;
				lease.playing = false;
			}
		}
		if (event.type === "response.done") {
			lease.responding = false;
			if (Number(event.response?.usage?.input_tokens) > 16000) this.requestRestart();
		}
		if (
			event.type === "response.output_audio_transcript.done" ||
			event.type === "conversation.item.input_audio_transcription.completed"
		) {
			const id = String(event.item_id ?? event.event_id ?? randomUUID());
			if (typeof event.transcript === "string" && !this.memory.turns.some((m) => m.id === id)) {
				this.memory.turns.push({
					id,
					role: event.type.startsWith("response.") ? "assistant" : "user",
					text: event.transcript.slice(0, 12000),
					at: this.now(),
					source: "Voice",
				});
				this.memory.turns = this.memory.turns.slice(-24);
				this.save();
			}
		}
		if (
			event.type === "response.function_call_arguments.done" &&
			typeof event.call_id === "string" &&
			!lease.toolIds.has(event.call_id)
		) {
			lease.toolIds.add(event.call_id);
			lease.toolsPending++;
			void this.runTool(lease, event).finally(() => {
				lease.toolsPending--;
			});
		}
	}
	private async runTool(lease: Lease, event: VoiceEvent): Promise<void> {
		let result: unknown;
		try {
			const args = JSON.parse(event.arguments ?? "{}");
			if (this.lease !== lease) return;
			if (event.name === "post_message") {
				if (
					typeof args.message !== "string" ||
					!args.message.trim() ||
					args.message.length > 12000 ||
					!["user", "voice"].includes(args.origin)
				)
					throw new Error("Expected message (1–12000 characters) and origin=user|voice");
				await this.options.bridge.postMessage(args.message, args.origin);
				this.memory.turns.push({
					id: `post-${event.call_id}`,
					role: args.origin === "user" ? "user" : "assistant",
					text: args.message,
					at: this.now(),
					source: "Voice → Pi",
				});
				this.memory.turns = this.memory.turns.slice(-24);
				this.save();
				result = { posted: true, delivery: "queued", note: "Pi continues normally. Observe its forthcoming output." };
			} else if (event.name === "get_pi_status") {
				const pi = this.options.bridge.snapshot();
				result = {
					sessionId: pi.sessionId,
					branchId: pi.branchId,
					busy: pi.busy,
					recent: pi.messages.slice(-4).map((m) => ({ ...m, text: m.text.slice(0, 2000) })),
				};
			} else if (event.name === "read_pi_history") {
				result = boundedMessages(
					this.options.bridge.history(
						typeof args.before_id === "string" ? args.before_id : undefined,
						Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 10))),
					),
					20,
					8000,
				);
			} else if (["save_voice_memory", "restart_voice"].includes(event.name)) {
				if (typeof args.summary !== "string" || args.summary.length > 4000)
					throw new Error("Handover must be a string of at most 4000 characters");
				this.memory.summary = args.summary;
				this.save();
				result = { saved: true };
				if (event.name === "restart_voice") lease.restart = true;
			} else throw new Error("Unknown voice tool");
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		if (this.lease !== lease) return;
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(result) },
		});
		lease.pending = true;
	}
}
