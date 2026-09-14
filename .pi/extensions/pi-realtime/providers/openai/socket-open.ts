import type WebSocket from "ws";
import type { IncomingMessage } from "node:http";

/** Wait for a provider handshake; expose bounded JSON error details, never raw bodies or credentials. */
export function awaitRealtimeSocketOpen(
	socket: WebSocket,
	apiKey: string | undefined,
	timeoutMs = 15000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let response: IncomingMessage | undefined;
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.off("open", opened);
			socket.off("error", failed);
			socket.off("close", closed);
			socket.off("unexpected-response", rejected);
			if (error) {
				// A handled upgrade rejection otherwise leaves ws in CONNECTING.
				socket.once("error", () => {});
				socket.terminate();
				response?.destroy();
				reject(error);
			} else resolve();
		};
		const opened = () => finish();
		const failed = () => finish(new Error("OpenAI realtime socket error before open."));
		const closed = () => finish(new Error("OpenAI realtime socket closed before open."));
		const rejected = (_request: unknown, incoming: IncomingMessage) => {
			response = incoming;
			let body = "";
			const status = incoming.statusCode;
			const report = () => finish(new Error(realtimeHandshakeError(status, body, apiKey)));
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 8192) {
					body = "";
					report();
				}
			});
			incoming.once("end", report);
			incoming.once("error", report);
		};
		const timer = setTimeout(
			() => finish(new Error("Timed out waiting for OpenAI realtime socket to open.")),
			timeoutMs,
		);
		socket.once("open", opened);
		socket.once("error", failed);
		socket.once("close", closed);
		socket.once("unexpected-response", rejected);
	});
}

export function realtimeHandshakeError(status: number | undefined, body: string, apiKey?: string): string {
	let detail = "";
	try {
		const error = JSON.parse(body).error;
		detail = [error?.code, error?.message].filter((v) => typeof v === "string").join(": ");
	} catch {
		/* Proxies can return HTML containing sensitive data; do not echo it. */
	}
	if (apiKey) detail = detail.replaceAll(apiKey, "[REDACTED]");
	detail = detail.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
	const hint =
		status === 400 || status === 404
			? " Check that the selected model is a supported realtime deployment on this endpoint."
			: "";
	return `OpenAI realtime handshake rejected (HTTP ${status ?? "unknown"})${detail ? `: ${detail}` : "."}${hint}`;
}
