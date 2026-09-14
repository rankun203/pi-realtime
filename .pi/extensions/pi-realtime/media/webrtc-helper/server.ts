import { homedir } from "node:os";
import { VoiceCompanion } from "../../companion/runtime";
import { openAIVoiceTransport } from "../../companion/openai";
import type { VoiceTransport } from "../../companion/types";
import { createHelperDiscovery } from "./discovery";
import type { ChatMessage, DashboardBridge } from "../../dashboard";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRealtimeWebPort } from "../../env";
import {
	createOutboxPollTraceState,
	describeRealtimePayload,
	nextOutboxPollTrace,
	type DebugTraceRecorder,
	type OutboxPollTraceState,
} from "../../debug-trace";
import type { NormalizedProviderEvent, ProviderSessionId, ProviderKind } from "../../types";
import type {
	WebRTCHelperInboundEvent,
	WebRTCHelperOutboundEvent,
	WebRTCHelperRegistrationConfig,
	WebRTCHelperServer,
	WebRTCHelperSessionConfig,
	WebRTCHelperSink,
} from "./protocol";

export type { WebRTCHelperServer } from "./protocol";

const HOST = "127.0.0.1";
const CLIENT_HTML = join(__dirname, "client.html");
const CLIENT_JS = join(__dirname, "client.js");

type HelperSession = {
	config: WebRTCHelperSessionConfig;
	createClientSecret(): Promise<unknown>;
	normalizeUsageEvent?: WebRTCHelperRegistrationConfig["normalizeUsageEvent"];
	trace?: DebugTraceRecorder;
	sink: WebRTCHelperSink;
	outbox: WebRTCHelperOutboundEvent[];
	messages: ChatMessage[];
	seq: number;
	lastSeenAt: number;
	deliveredOutboxId: number;
	outboxPollTrace: OutboxPollTraceState;
};

type HelperOptions = { voiceTransport?: VoiceTransport; stateDirectory?: string };
export function createWebRTCHelperServer(options: HelperOptions = {}): WebRTCHelperServer {
	return new LocalWebRTCHelperServer(options);
}

class LocalWebRTCHelperServer implements WebRTCHelperServer {
	private companion: VoiceCompanion | undefined;
	private readonly pendingClosures = new Set<Promise<void>>();
	private companionOwner: string | undefined;
	constructor(private readonly options: HelperOptions) {}
	private server: Server | undefined;
	private port: number | undefined;
	private dashboard: DashboardBridge | undefined;
	setDashboard(bridge: DashboardBridge): void {
		this.dashboard = bridge;
	}
	private readonly sessions = new Map<ProviderSessionId, HelperSession>();
	private readonly discovery = createHelperDiscovery();

	async start(): Promise<void> {
		if (this.server) return;
		const port = loadRealtimeWebPort();
		const server = createServer((req, res) => void this.handle(req, res));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, HOST, () => {
				server.off("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") return reject(new Error("Could not bind WebRTC helper server."));
				this.port = address.port;
				resolve();
			});
		}).catch((error) => {
			this.server = undefined;
			throw error;
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		const closures = await Promise.allSettled([...this.pendingClosures, this.companion?.close() ?? Promise.resolve()]);
		this.pendingClosures.clear();
		this.companion = undefined;
		this.companionOwner = undefined;
		this.sessions.clear();
		this.discovery.remove();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		this.server = undefined;
		this.port = undefined;
		const failures = closures.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"Voice provider cleanup failed",
			);
	}

	registerSession(config: WebRTCHelperRegistrationConfig, sink: WebRTCHelperSink): void {
		const { createClientSecret, normalizeUsageEvent, trace, ...sessionConfig } = config;
		const session = {
			config: { ...sessionConfig, debugTracePath: trace?.path },
			createClientSecret,
			normalizeUsageEvent,
			trace,
			sink,
			outbox: [],
			messages: [],
			seq: 0,
			lastSeenAt: Date.now(),
			deliveredOutboxId: 0,
			outboxPollTrace: createOutboxPollTraceState(),
		};
		if (config.interaction?.mode === "agent" && this.dashboard?.pi) {
			if (this.companion)
				throw new Error("This Pi session already has a voice companion. Reuse it or stop it before starting another.");
			this.companionOwner = config.providerSessionId;
			this.companion = new VoiceCompanion({
				bridge: this.dashboard.pi,
				model: config.model,
				transport: this.options.voiceTransport ?? openAIVoiceTransport(),
				stateDirectory:
					this.options.stateDirectory ??
					join(
						(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")).replace(/^~(?=\/|$)/, homedir()),
						"pi-realtime",
						"companions",
					),
				onEvent: (event) => {
					trace?.write({
						source: "voice_companion",
						eventType: event.type,
						providerEventId: event.event_id,
						toolName: event.type === "response.function_call_arguments.done" ? event.name : undefined,
						callId: event.call_id,
						itemId: event.item_id,
						responseId: event.response?.id ?? event.response_id,
						responseStatus: event.type === "response.done" ? event.response?.status : undefined,
						responseReason: event.type === "response.done" ? event.response?.status_details?.reason : undefined,
						errorCode: event.error?.code ?? event.response?.status_details?.error?.code,
						reason: event.type === "voice.detached" ? event.reason : undefined,
					});
					const source =
						event.type === "response.done"
							? "response"
							: event.type === "conversation.item.input_audio_transcription.completed"
								? "input_transcription"
								: undefined;
					if (!source || !normalizeUsageEvent) return;
					const observation = normalizeUsageEvent({
						source,
						realtimeEvent: event,
						providerEventId: event.event_id,
						at: Date.now(),
					});
					if (observation)
						sink.onProviderEvent({
							type: "usage",
							provider: "openai",
							providerSessionId: config.providerSessionId,
							localSeq: Date.now(),
							at: Date.now(),
							observation,
						});
				},
			});
		}
		this.sessions.set(config.providerSessionId, session);
		if (this.port) this.discovery.publish(this.port);
		trace?.write({ source: "helper_server", direction: "lifecycle", action: "registerSession", model: config.model });
	}

	unregisterSession(providerSessionId: ProviderSessionId, reason: string): void {
		const session = this.sessions.get(providerSessionId);
		if (!session) return;
		if (this.companionOwner === providerSessionId) {
			const closing = this.companion?.close();
			if (closing) {
				this.pendingClosures.add(closing);
				void closing.catch(() => {}); // Observed and reported by stop(), even after unregistering.
			}
			this.companion = undefined;
			this.companionOwner = undefined;
		}
		this.enqueueForSession(session, { type: "pi.helper.close", reason });
		session.trace?.write({ source: "helper_server", direction: "lifecycle", action: "unregisterSession", reason });
		session.sink.onProviderEvent(this.normalize(session, { type: "disconnected", reason }) as NormalizedProviderEvent);
		setTimeout(() => {
			if (this.sessions.get(providerSessionId) === session) this.sessions.delete(providerSessionId);
		}, 5000).unref();
	}

	isCompanion(providerSessionId: ProviderSessionId): boolean {
		return this.companionOwner === providerSessionId && !!this.companion;
	}
	enqueue(providerSessionId: ProviderSessionId, event: Record<string, unknown>): void {
		if (this.isCompanion(providerSessionId)) return;
		this.enqueueForSession(this.requireSession(providerSessionId), event);
	}

	private enqueueForSession(session: HelperSession, event: Record<string, unknown>): void {
		const id = ++session.seq;
		session.outbox.push({ id, event });
		session.outbox = session.outbox.slice(-200);
		session.trace?.write({
			source: "helper_server",
			direction: "outbox_enqueue",
			outboxId: id,
			...describeRealtimePayload(event),
		});
	}

	urlFor(providerSessionId: ProviderSessionId): string {
		if (!this.port) throw new Error("WebRTC helper server is not running.");
		return `http://${HOST}:${this.port}/pi-realtime/openai/${encodeURIComponent(providerSessionId)}`;
	}

	status(): string {
		if (!this.server || !this.port) return "webrtc helper: stopped";
		const rows = [...this.sessions.values()].map(
			(session) =>
				`- ${session.config.providerSessionId} ${session.config.model} lastSeen=${Date.now() - session.lastSeenAt}ms outbox=${session.outbox.length}`,
		);
		return [`webrtc helper: http://${HOST}:${this.port}`, ...rows].join("\n");
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", `http://${HOST}`);
			if (req.method === "GET" && url.pathname === "/pi-realtime/discovery") {
				if (!sameOriginRequest(req)) return this.respond(res, 403, { error: "cross_origin_request_denied" });
				return this.respond(res, 200, {
					id: this.discovery.id,
					project: this.dashboard?.snapshot().project ?? process.cwd(),
					sessions: [...this.sessions.values()].map((session) => ({
						id: session.config.providerSessionId,
						model: session.config.model,
						mode: session.config.interaction?.mode ?? "agent",
					})),
				});
			}
			if (this.tryServeStatic(req, res, url)) return;
			const route = this.sessionRoute(url);
			if (!route) return this.respond(res, 404, { error: "not_found" });
			if (!sameOriginRequest(req)) return this.respond(res, 403, { error: "cross_origin_request_denied" });
			await this.handleSessionRoute(req, res, url, route);
		} catch (error) {
			this.respond(res, (error as { statusCode?: number }).statusCode ?? 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private tryServeStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
		if (req.method === "GET" && /^\/pi-realtime\/openai\/[^/]+$/.test(url.pathname)) {
			this.serveFile(res, CLIENT_HTML, "text/html; charset=utf-8");
			return true;
		}
		if (req.method === "GET" && url.pathname === "/pi-realtime/webrtc/client.js") {
			this.serveFile(res, CLIENT_JS, "text/javascript; charset=utf-8");
			return true;
		}
		return false;
	}

	private sessionRoute(url: URL): { providerSessionId: ProviderSessionId; action: string } | undefined {
		const match =
			/^\/pi-realtime\/openai\/([^/]+)\/(config|client-secret|event|outbox|messages|message|voice-connect|voice-heartbeat|voice-disconnect)$/.exec(
				url.pathname,
			);
		return match ? { providerSessionId: decodeURIComponent(match[1] ?? ""), action: match[2] ?? "" } : undefined;
	}

	private async handleSessionRoute(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		route: { providerSessionId: ProviderSessionId; action: string },
	): Promise<void> {
		const session = this.requireSession(route.providerSessionId);
		session.lastSeenAt = Date.now();
		const companion = this.companionOwner === route.providerSessionId ? this.companion : undefined;
		if (companion && req.method === "POST" && route.action.startsWith("voice-")) {
			const body = await readJson<{ sdp?: unknown; takeover?: boolean; lease?: string }>(req);
			if (route.action === "voice-connect") {
				if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0") || body.sdp.length > 100000)
					return this.respond(res, 400, { error: "invalid_sdp" });
				const result = await companion.connect(body.sdp, body.takeover === true);
				if (res.destroyed) {
					await companion.release(result.lease);
					return;
				}
				return this.respond(res, 200, result);
			}
			if (typeof body.lease !== "string") return this.respond(res, 400, { error: "lease_required" });
			if (route.action === "voice-disconnect") {
				await companion.release(body.lease);
				return this.respond(res, 200, { ok: true });
			}
			return this.respond(res, 200, companion.heartbeat(body.lease));
		}
		if (companion && ["client-secret", "event", "outbox"].includes(route.action))
			return this.respond(res, 409, { error: "Voice companion is controlled server-side" });
		if (req.method === "GET" && route.action === "messages") {
			const snapshot = this.dashboard?.snapshot() ?? { messages: [], project: "Pi", usage: "cost pending" };
			return this.respond(res, 200, {
				...snapshot,
				messages: [...snapshot.messages, ...(companion?.messages() ?? session.messages)]
					.sort((a, b) => a.at - b.at)
					.slice(-150),
			});
		}
		if (req.method === "POST" && route.action === "message") {
			if (!this.dashboard) return this.respond(res, 503, { error: "chat_unavailable" });
			const body = await readJson<{ text?: unknown }>(req);
			if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20000)
				return this.respond(res, 400, { error: "text_required_max_20000" });
			await this.dashboard.sendMessage(body.text.trim());
			return this.respond(res, 202, { ok: true });
		}
		if (req.method === "GET" && route.action === "config")
			return this.respond(res, 200, {
				...session.config,
				companion: !!companion,
				resumeOutboxAfter: session.deliveredOutboxId,
			});
		if (req.method === "POST" && route.action === "client-secret")
			return this.respond(res, 200, await session.createClientSecret());
		if (req.method === "POST" && route.action === "event") return this.handleInboundEvent(req, res, session);
		if (req.method === "GET" && route.action === "outbox") return this.respondOutbox(res, url, session);
		return this.respond(res, 405, { error: "method_not_allowed" });
	}

	private async handleInboundEvent(req: IncomingMessage, res: ServerResponse, session: HelperSession): Promise<void> {
		const inbound = await readJson<WebRTCHelperInboundEvent>(req);
		if (inbound.type === "trace") {
			session.trace?.write({ source: "browser", ...inbound.trace, providerEventId: inbound.providerEventId });
			return this.respond(res, 200, { ok: true });
		}
		if (inbound.type === "outbox_ack") {
			session.deliveredOutboxId = Math.max(session.deliveredOutboxId, inbound.outboxId);
			session.trace?.write({
				source: "helper_server",
				direction: "outbox_ack",
				outboxId: inbound.outboxId,
				deliveredOutboxId: session.deliveredOutboxId,
			});
			return this.respond(res, 200, { ok: true });
		}
		session.trace?.write({
			source: "helper_server",
			direction: "inbound_normalize",
			inboundType: inbound.type,
			providerEventId: inbound.providerEventId,
		});
		const event = this.normalize(session, inbound);
		if (event) {
			if (
				(event.type === "assistant_transcript" || event.type === "user_transcript") &&
				event.final &&
				event.text.trim()
			) {
				const id = `voice-${event.providerEventId ?? Date.now()}`;
				if (!session.messages.some((message) => message.id === id))
					session.messages.push({
						id,
						role: event.type === "user_transcript" ? "user" : "assistant",
						text: event.text.slice(0, 20000),
						at: event.at,
						source: "Voice",
					});
				session.messages = session.messages.slice(-100);
			}
			session.trace?.write({
				source: "helper_server",
				direction: "normalized_event",
				eventType: event.type,
				providerEventId: event.providerEventId,
				localSeq: event.localSeq,
			});
			session.sink.onProviderEvent(event);
		}
		this.respond(res, 200, { ok: true });
	}

	private respondOutbox(res: ServerResponse, url: URL, session: HelperSession): void {
		const after = Number(url.searchParams.get("after") ?? "0");
		const events = session.outbox.filter((event) => event.id > after);
		const returnedIds = events.map((event) => event.id);
		this.traceOutboxPoll(session, after, returnedIds);
		this.respond(res, 200, { events, resumeOutboxAfter: session.deliveredOutboxId });
	}

	private traceOutboxPoll(session: HelperSession, after: number, returnedIds: readonly number[]): void {
		const record = nextOutboxPollTrace(session.outboxPollTrace, after, returnedIds);
		if (record) session.trace?.write({ source: "helper_server", ...record });
	}

	private normalize(session: HelperSession, inbound: WebRTCHelperInboundEvent): NormalizedProviderEvent | undefined {
		const providerSessionId = session.config.providerSessionId;
		const provider = session.config.provider;
		const base = {
			provider,
			providerSessionId,
			providerEventId: inbound.providerEventId,
			localSeq: Date.now(),
			at: Date.now(),
		};
		if (inbound.type === "tool_call")
			return {
				...base,
				type: "tool_call",
				call: { ...inbound.call, provider, providerSessionId, status: "pending", createdAt: Date.now() },
			};
		if (inbound.type === "usage") {
			if (!session.normalizeUsageEvent) return undefined;
			const observation = session.normalizeUsageEvent({
				source: inbound.source,
				realtimeEvent: inbound.realtimeEvent,
				providerEventId: inbound.providerEventId,
				at: base.at,
			});
			return observation ? { ...base, type: "usage", observation } : undefined;
		}
		return { ...base, ...inbound } as NormalizedProviderEvent;
	}

	private requireSession(providerSessionId: ProviderSessionId): HelperSession {
		const session = this.sessions.get(providerSessionId);
		if (!session) throw new Error(`No WebRTC helper session for ${providerSessionId}`);
		return session;
	}

	private serveFile(res: ServerResponse, path: string, contentType: string): void {
		res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
		res.end(readFileSync(path));
	}

	private respond(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}
}

export { openHelperUrl } from "./browser-open";

// Browsers must use the helper's own origin, including behind a reverse proxy.
// Caddy preserves the public Host header. This is CSRF protection, not authentication.
function sameOriginRequest(req: IncomingMessage): boolean {
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	if (!req.headers.origin) return true; // CLI/proxy health checks and trusted local clients.
	try {
		const origin = new URL(req.headers.origin);
		return (origin.protocol === "https:" || origin.protocol === "http:") && origin.host === req.headers.host;
	} catch {
		return false;
	}
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += Buffer.byteLength(chunk);
		if (size > 256 * 1024) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
