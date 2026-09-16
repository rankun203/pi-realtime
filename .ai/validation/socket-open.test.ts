import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
	awaitRealtimeSocketOpen,
	realtimeHandshakeError,
} from "../../.pi/extensions/pi-realtime/providers/openai/socket-open";

async function serverTest(run: (url: string, server: ReturnType<typeof createServer>) => Promise<void>) {
	const server = createServer();
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`ws://127.0.0.1:${(server.address() as any).port}`, server);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("realtime handshake: initial DNS failure retains the hostname and cause without exposing secrets", async () => {
	const socket = new WebSocket("wss://example.test/realtime?token=private-token", {
		lookup(_hostname, _options, callback) {
			callback(Object.assign(new Error("DNS failed private-token"), { code: "ENOTFOUND" }), "", 4);
		},
	});
	await assert.rejects(awaitRealtimeSocketOpen(socket, "private-token"), (error: Error) => {
		assert.match(error.message, /Open realtime connection.*example.test.*ENOTFOUND/);
		assert.doesNotMatch(error.message, /private-token/);
		return true;
	});
	assert.notEqual(socket.readyState, WebSocket.CONNECTING);
});

test("realtime handshake: reports Azure rejection details and closes the failed socket", async () => {
	await serverTest(async (url, server) => {
		const body = JSON.stringify({
			error: { code: "OperationNotSupported", message: "Unsupported model. secret-fixture-key" },
		});
		server.on("upgrade", (_req, socket) =>
			socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
		);
		const socket = new WebSocket(url);
		await assert.rejects(awaitRealtimeSocketOpen(socket, "secret-fixture-key"), (error: Error) => {
			assert.match(error.message, /HTTP 400.*OperationNotSupported/);
			assert.match(error.message, /supported realtime deployment/);
			assert.doesNotMatch(error.message, /secret-fixture-key/);
			return true;
		});
		assert.notEqual(socket.readyState, WebSocket.CONNECTING);
	});
});

test("realtime handshake: does not expose HTML, oversized responses, or authentication hints as model errors", async () => {
	assert.doesNotMatch(
		realtimeHandshakeError(401, "<html>private proxy diagnostics</html>"),
		/private|supported realtime deployment/,
	);
	await serverTest(async (url, server) => {
		const body = "private".repeat(2000);
		server.on("upgrade", (_req, socket) =>
			socket.end(`HTTP/1.1 500 Error\r\nContent-Length: ${body.length}\r\n\r\n${body}`),
		);
		const socket = new WebSocket(url);
		await assert.rejects(awaitRealtimeSocketOpen(socket, undefined), (e: Error) => {
			assert.match(e.message, /HTTP 500/);
			assert.doesNotMatch(e.message, /private/);
			return true;
		});
	});
});

test("realtime handshake: a successful connection remains open for its caller", async () => {
	await serverTest(async (url, server) => {
		const wss = new WebSocketServer({ server });
		const socket = new WebSocket(url);
		try {
			await awaitRealtimeSocketOpen(socket, undefined);
			assert.equal(socket.readyState, WebSocket.OPEN);
			assert.equal(socket.listenerCount("unexpected-response"), 0);
		} finally {
			socket.terminate();
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
	});
});

test("realtime handshake: timeout releases a pending upgrade", async () => {
	await serverTest(async (url, server) => {
		server.on("upgrade", () => {});
		const socket = new WebSocket(url);
		await assert.rejects(awaitRealtimeSocketOpen(socket, undefined, 50), /Timed out/);
		assert.notEqual(socket.readyState, WebSocket.CONNECTING);
	});
});
