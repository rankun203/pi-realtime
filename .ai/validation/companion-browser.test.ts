import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { setImmediate as settle } from "node:timers/promises";

function browser() {
	const elements = new Map<string, any>();
	const released: string[] = [];
	const notifications: any[] = [];
	const timers: (() => Promise<void>)[] = [];
	let stopped = 0;
	let peer: any;
	class Peer {
		connectionState = "new";
		iceConnectionState = "new";
		onconnectionstatechange?: () => void;
		oniceconnectionstatechange?: () => void;
		constructor() {
			peer = this;
		}
		addTrack() {}
		createDataChannel() {
			return { close() {} };
		}
		async createOffer() {
			return { sdp: "fixture-sdp" };
		}
		async setLocalDescription() {}
		async setRemoteDescription() {
			this.connectionState = "connecting";
			this.iceConnectionState = "checking";
		}
		async getStats() {
			return new Map([["rtp", { type: "outbound-rtp", packetsSent: 0 }]]);
		}
		close() {
			this.connectionState = "closed";
		}
	}
	const context = vm.createContext({
		document: {
			getElementById(id: string) {
				if (!elements.has(id)) elements.set(id, { textContent: "", addEventListener() {} });
				return elements.get(id);
			},
		},
		location: { pathname: "/pi-realtime/openai/test", origin: "http://localhost" },
		fetch: () => new Promise(() => {}),
		setInterval(fn: () => Promise<void>) {
			timers.push(fn);
			return timers.length;
		},
		clearInterval() {},
		window: {
			addEventListener() {},
			parent: {
				postMessage(message: unknown) {
					notifications.push(message);
				},
			},
		},
		navigator: {
			mediaDevices: {
				async getUserMedia() {
					const track = {
						stop() {
							stopped++;
						},
					};
					return { getAudioTracks: () => [track], getTracks: () => [track] };
				},
			},
			sendBeacon(url: string) {
				released.push(url);
				return true;
			},
		},
		Blob,
		RTCPeerConnection: Peer,
	});
	vm.runInContext(
		readFileSync(resolve(__dirname, "../../.pi/extensions/pi-realtime/media/webrtc-helper/client.js"), "utf8"),
		context,
	);
	vm.runInContext(
		`const requestJson = json; json = async () => ({answer: "fixture-answer", lease: "fixture-lease"});`,
		context,
	);
	return {
		context,
		elements,
		released,
		notifications,
		timers,
		peer: () => peer,
		stopped: () => stopped,
		start: () => vm.runInContext(`startCompanion({model: "test"}, connectionEpoch)`, context),
	};
}

test("browser companion: server diagnostics and error IDs remain readable; local network errors are distinct", async () => {
	const b = browser();
	b.context.fetch = async () => ({
		ok: false,
		status: 500,
		json: async () => ({
			error: "Create realtime session failed for example.test: DNS lookup failed (ENOTFOUND).",
			errorId: "reference-123",
		}),
	});
	await assert.rejects(
		vm.runInContext('requestJson("/long/internal/session/voice-connect")', b.context),
		(error: any) => {
			assert.match(error.message, /DNS lookup failed.*ENOTFOUND/);
			assert.match(error.message, /reference-123/);
			assert.doesNotMatch(error.message, /long\/internal/);
			assert.equal(error.status, 500);
			return true;
		},
	);
	b.context.fetch = async () => {
		throw new TypeError("fetch failed");
	};
	await assert.rejects(vm.runInContext('requestJson("/voice-connect")', b.context), /Cannot reach the Pi voice server/);
});

test("browser companion: SDP success cannot claim connected; native peer state owns status", async () => {
	const b = browser();
	await b.start();
	assert.match(b.elements.get("status").textContent, /Connecting voice media/);
	assert.equal(b.notifications.filter((n) => n.active).length, 0);
	b.peer().connectionState = "connected";
	b.peer().iceConnectionState = "connected";
	b.peer().onconnectionstatechange();
	assert.match(b.elements.get("status").textContent, /Voice connected/);
	assert.equal(b.notifications.filter((n) => n.active).length, 1);
	b.peer().connectionState = "disconnected";
	b.peer().onconnectionstatechange();
	assert.match(b.elements.get("status").textContent, /interrupted/);
	assert.equal(b.released.length, 0, "transient WebRTC disconnection can recover natively");
	vm.runInContext("cleanupCurrentConnection()", b.context);
	b.peer().connectionState = "connected";
	b.peer().onconnectionstatechange();
	assert.equal(b.notifications.filter((n) => n.active).length, 1, "stale peer cannot revive an ended call");
});

test("browser companion: failed ICE releases media and retains packet diagnostics", async () => {
	const b = browser();
	await b.start();
	b.peer().connectionState = "failed";
	b.peer().iceConnectionState = "failed";
	b.peer().onconnectionstatechange();
	await settle();
	assert.equal(b.stopped(), 1);
	assert.equal(b.released.length, 1);
	assert.match(b.elements.get("notice").textContent, /network\/VPN\/firewall/);
	assert.match(b.elements.get("log").textContent, /packetsSent.*0/);
	assert.doesNotMatch(b.elements.get("log").textContent, /fixture-sdp|fixture-lease/);
});

test("browser companion: heartbeat failure preserves provider reason and closes the call", async () => {
	const b = browser();
	await b.start();
	vm.runInContext(
		`json = async () => { throw new Error("Provider control connection closed (1000): observer_writer_exit"); };`,
		b.context,
	);
	await b.timers.at(-1)!();
	assert.match(b.elements.get("status").textContent, /media connection did not establish/);
	assert.match(b.elements.get("notice").textContent, /observer_writer_exit/);
	assert.equal(b.stopped(), 1);
	assert.equal(b.released.length, 1);
});
