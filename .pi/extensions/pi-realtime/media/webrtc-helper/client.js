const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const startButton = document.getElementById("start");
const remoteAudio = document.getElementById("remote");
const providerSessionId = decodeURIComponent(location.pathname.split("/").pop() || "");
const sessionBase = location.pathname;
let connectionEpoch = 0;
let lastMessages = "";
let messagePollInFlight = false;
const outboxPollTracer = createOutboxPollTracer();
let dc;
let currentPc;
let currentStream;
let lastOutboxId = 0;
let pollTimer;
let pollInFlight = false;
let interactionConfig;
let companionMode = false;
let voiceLease;
let voiceHeartbeat;
let voiceHeartbeatInFlight = false;

function outboxCursorStorageKey() {
	return `pi-realtime:${providerSessionId}:lastOutboxId`;
}

startButton.addEventListener("click", async () => {
	startButton.disabled = true;
	try {
		await start();
	} catch (error) {
		cleanupCurrentConnection();
		reportError(error);
	} finally {
		startButton.disabled = Boolean(currentPc);
	}
});
document.getElementById("hangup").addEventListener("click", () => {
	cleanupCurrentConnection();
	setStatus("Chat ready · voice off", "status");
	postEvent({ type: "disconnected", reason: "call ended" }).catch(reportError);
});
window.addEventListener("pagehide", cleanupCurrentConnection);
window.addEventListener("message", (event) => {
	if (event.origin === location.origin && event.source === window.parent && event.data?.type === "pi-agents-disconnect")
		cleanupCurrentConnection();
});
document.getElementById("composer").addEventListener("submit", sendChatMessage);
pollMessages().catch(showChatError);
const messagePollTimer = setInterval(() => pollMessages().catch(showChatError), 1500);
window.addEventListener("pagehide", () => clearInterval(messagePollTimer));

async function start() {
	document.getElementById("notice").textContent = "";
	setStatus("Connecting…", "warn");
	cleanupCurrentConnection();
	startButton.disabled = true;
	const epoch = connectionEpoch;
	const config = await json(`${sessionBase}/config`);
	if (epoch !== connectionEpoch) return;
	interactionConfig = config.interaction;
	companionMode = Boolean(config.companion);
	if (companionMode) return startCompanion(config, epoch);
	lastOutboxId = initialOutboxCursor(config);
	const secret = await json(`${sessionBase}/client-secret`, { method: "POST" });
	if (epoch !== connectionEpoch) return;
	const pc = new RTCPeerConnection();
	currentPc = pc;
	document.getElementById("hangup").disabled = false;
	pc.ontrack = (event) => {
		if (epoch !== connectionEpoch) return;
		remoteAudio.hidden = false;
		remoteAudio.srcObject = event.streams[0];
		remoteAudio
			.play()
			.catch(() => log("Speaker autoplay was blocked. Tap Play in the audio controls to enable sound."));
	};
	pc.onconnectionstatechange = () => log(`peer: ${pc.connectionState}`);
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			echoCancellation: { ideal: true },
			noiseSuppression: { ideal: true },
			autoGainControl: { ideal: true },
			channelCount: { ideal: 1 },
		},
	});
	if (epoch !== connectionEpoch) {
		for (const track of stream.getTracks()) track.stop();
		return;
	}
	currentStream = stream;
	for (const track of stream.getAudioTracks()) {
		logAudioSettings(track);
		pc.addTrack(track, stream);
	}
	dc = pc.createDataChannel("oai-events");
	dc.addEventListener("open", () => {
		if (epoch !== connectionEpoch) return;
		setStatus(`Voice connected · ${config.model}`, "status");
		window.parent.postMessage({ type: "pi-agents-call", active: true }, location.origin);
		log(`debug trace: ${config.debugTracePath || "not configured"}`);
		postEvent({ type: "connected" });
		sendContext(config.initialContext);
		pollTimer = setInterval(() => pollOutbox().catch((error) => log(`poll failed: ${error.message}`)), 250);
	});
	dc.addEventListener("message", (event) => {
		if (epoch !== connectionEpoch) return;
		trace("openai_inbound_raw", { bytes: event.data.length });
		handleRealtimeEvent(JSON.parse(event.data));
	});
	dc.addEventListener("close", () => {
		if (epoch === connectionEpoch)
			postEvent({ type: "disconnected", reason: "data channel closed" }).catch(reportError);
	});
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	const answerSdp = await fetch(secret.callsUrl, {
		method: "POST",
		body: offer.sdp,
		headers: { authorization: `Bearer ${secret.value}`, "content-type": "application/sdp" },
	}).then(async (response) => {
		if (!response.ok) throw new Error(`OpenAI WebRTC calls offer failed: ${response.status} ${await response.text()}`);
		return response.text();
	});
	if (epoch !== connectionEpoch) return;
	await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

function cleanupCurrentConnection() {
	connectionEpoch++;
	clearInterval(voiceHeartbeat);
	voiceHeartbeat = undefined;
	if (voiceLease) releaseVoiceLease(voiceLease);
	voiceLease = undefined;
	window.parent.postMessage({ type: "pi-agents-call", active: false }, location.origin);
	startButton.disabled = false;
	document.getElementById("hangup").disabled = true;
	clearInterval(pollTimer);
	pollTimer = undefined;
	if (dc) dc.close();
	if (currentPc) currentPc.close();
	if (currentStream) for (const track of currentStream.getTracks()) track.stop();
	dc = undefined;
	currentPc = undefined;
	currentStream = undefined;
	remoteAudio.srcObject = null;
	remoteAudio.hidden = true;
}

function releaseVoiceLease(lease) {
	const body = JSON.stringify({ lease });
	const url = `${sessionBase}/voice-disconnect`;
	if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
	fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(
		() => {},
	);
}

async function startCompanion(config, epoch) {
	const pc = new RTCPeerConnection();
	currentPc = pc;
	let mediaConnected = false;
	const updatePeerState = () => {
		if (epoch !== connectionEpoch) return;
		log(`WebRTC peer=${pc.connectionState} ICE=${pc.iceConnectionState}`);
		if (pc.connectionState === "connected") {
			mediaConnected = true;
			setStatus(`Voice connected · ${config.model}`, "status");
			document.getElementById("notice").textContent = "";
			window.parent.postMessage({ type: "pi-agents-call", active: true }, location.origin);
		} else if (pc.connectionState === "failed") {
			void endFailedCompanion(
				pc,
				epoch,
				"WebRTC media connection failed. Check the network/VPN/firewall path to the provider.",
				mediaConnected,
			);
		} else if (pc.connectionState === "disconnected") {
			setStatus("Voice media interrupted · reconnecting…", "warn");
		} else {
			setStatus("Connecting voice media…", "warn");
		}
	};
	pc.onconnectionstatechange = updatePeerState;
	pc.oniceconnectionstatechange = () => {
		if (epoch === connectionEpoch) log(`WebRTC ICE=${pc.iceConnectionState}`);
	};
	document.getElementById("hangup").disabled = false;
	pc.ontrack = (event) => {
		if (epoch !== connectionEpoch) return;
		remoteAudio.hidden = false;
		remoteAudio.srcObject = event.streams[0];
		remoteAudio.play().catch(() => log("Tap Play to enable speaker audio."));
	};
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});
	if (epoch !== connectionEpoch) {
		for (const track of stream.getTracks()) track.stop();
		return;
	}
	currentStream = stream;
	for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
	dc = pc.createDataChannel("oai-events"); // Audio-session negotiation only; the server owns model events/tools.
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	const negotiate = (takeover) =>
		json(`${sessionBase}/voice-connect`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sdp: offer.sdp, takeover }),
		});
	let result;
	try {
		result = await negotiate(false);
	} catch (error) {
		if (epoch !== connectionEpoch) return;
		if (error.status !== 409 || !confirm("Another device is using this voice conversation. Take over?")) throw error;
		result = await negotiate(true);
	}
	if (epoch !== connectionEpoch) {
		releaseVoiceLease(result.lease);
		return;
	}
	voiceLease = result.lease;
	await pc.setRemoteDescription({ type: "answer", sdp: result.answer });
	if (epoch !== connectionEpoch) return;
	// SDP acceptance only proves signaling worked; media connectivity is a separate handshake.
	updatePeerState();
	voiceHeartbeat = setInterval(async () => {
		if (voiceHeartbeatInFlight || epoch !== connectionEpoch) return;
		voiceHeartbeatInFlight = true;
		try {
			const state = await json(`${sessionBase}/voice-heartbeat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lease: result.lease }),
			});
			if (epoch !== connectionEpoch) return;
			if (state.restart) {
				document.getElementById("notice").textContent = "Refreshing the voice connection. Your Pi work continues.";
				await json(`${sessionBase}/voice-disconnect`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ lease: result.lease }),
				});
				if (epoch !== connectionEpoch) return;
				voiceLease = undefined;
				await start();
			}
		} catch (error) {
			if (epoch === connectionEpoch) await endFailedCompanion(pc, epoch, error.message, mediaConnected);
		} finally {
			voiceHeartbeatInFlight = false;
		}
	}, 3000);
}

async function endFailedCompanion(pc, epoch, reason, connected) {
	const peerState = pc.connectionState;
	const iceState = pc.iceConnectionState;
	try {
		// Packet counts and ICE outcomes suffice; never log SDP, device addresses, or credentials.
		const stats = [...(await pc.getStats()).values()];
		const media = stats
			.filter((s) => ["inbound-rtp", "outbound-rtp", "candidate-pair"].includes(s.type))
			.map((s) => ({
				type: s.type,
				state: s.state,
				packetsSent: s.packetsSent,
				packetsReceived: s.packetsReceived,
				requestsSent: s.requestsSent,
				responsesReceived: s.responsesReceived,
			}));
		if (epoch === connectionEpoch)
			log(`WebRTC diagnostics: ${JSON.stringify({ peer: peerState, ice: iceState, media })}`);
	} catch {
		// Diagnostics must never prevent releasing a failed call.
	}
	if (epoch !== connectionEpoch) return;
	cleanupCurrentConnection();
	setStatus(
		connected ? "Voice disconnected · reconnect when ready" : "Voice disconnected · media connection did not establish",
		"warn",
	);
	document.getElementById("notice").textContent = reason;
	log(reason);
}

async function pollMessages() {
	if (messagePollInFlight) return;
	messagePollInFlight = true;
	try {
		const snapshot = await json(`${sessionBase}/messages`);
		document.getElementById("project").textContent = snapshot.project;
		document.getElementById("conversation-title").textContent =
			snapshot.project.split("/").filter(Boolean).pop() || "Conversation";
		document.getElementById("usage").textContent = `Voice usage: ${snapshot.usage}`;
		const serialized = JSON.stringify(snapshot.messages);
		if (serialized === lastMessages) return;
		lastMessages = serialized;
		const container = document.getElementById("messages");
		const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180;
		container.replaceChildren();
		for (const message of snapshot.messages) {
			const bubble = document.createElement("article");
			bubble.className = `message ${message.role === "user" ? "user" : "assistant"}`;
			const label = document.createElement("span");
			label.className = "label";
			label.textContent = `${message.role === "user" ? "You" : "Assistant"} · ${message.source || "Pi"}`;
			bubble.append(label, document.createTextNode(message.text));
			container.append(bubble);
		}
		if (!snapshot.messages.length) container.textContent = "No messages yet. Send a message or start a call.";
		if (nearBottom) window.scrollTo(0, document.documentElement.scrollHeight);
	} finally {
		messagePollInFlight = false;
	}
}

async function sendChatMessage(event) {
	event.preventDefault();
	const input = document.getElementById("message");
	const text = input.value.trim();
	if (!text) return;
	const button = document.getElementById("send");
	button.disabled = true;
	try {
		await json(`${sessionBase}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		input.value = "";
		document.getElementById("notice").textContent = "Sent to Pi. Replies appear as they are recorded.";
		await pollMessages();
	} catch (error) {
		showChatError(error);
	} finally {
		button.disabled = false;
	}
}

function showChatError(error) {
	document.getElementById("notice").textContent = error.message;
}

function logAudioSettings(track) {
	const settings = track.getSettings ? track.getSettings() : {};
	log(
		`mic settings: echoCancellation=${String(settings.echoCancellation)} noiseSuppression=${String(settings.noiseSuppression)} autoGainControl=${String(settings.autoGainControl)} device=${settings.deviceId ? "set" : "unknown"}`,
	);
	if (settings.echoCancellation !== true)
		log(
			"WARNING: browser did not confirm echoCancellation=true; use headphones or select a browser/device that supports AEC.",
		);
	if (settings.noiseSuppression !== true) log("WARNING: browser did not confirm noiseSuppression=true.");
	if (settings.autoGainControl !== true) log("WARNING: browser did not confirm autoGainControl=true.");
}

function handleRealtimeEvent(event) {
	traceRealtimeEvent("openai_inbound", event);
	if (event.type === "response.function_call_arguments.done")
		return postEvent({
			type: "tool_call",
			providerEventId: event.event_id,
			call: {
				voiceToolCallId: event.call_id,
				providerToolCallId: event.call_id,
				name: event.name,
				arguments: parseArgs(event.arguments),
			},
		});
	if (event.type === "conversation.item.input_audio_transcription.completed")
		return handleInputAudioTranscription(event);
	if (event.type === "conversation.item.input_audio_transcription.failed") {
		const message = `Input transcription failed (${event.error?.code || "unknown"}): ${event.error?.message || "Check the configured transcription model/deployment."}`;
		setStatus(message, "err");
		return postEvent({ type: "error", providerEventId: event.event_id, message, recoverable: true });
	}
	if (event.type === "response.output_audio_transcript.done")
		return postEvent({
			type: "assistant_transcript",
			providerEventId: event.event_id,
			text: event.transcript || "",
			final: true,
		});
	if (event.type === "response.output_text.done")
		return postEvent({
			type: "assistant_transcript",
			providerEventId: event.event_id,
			text: event.text || "",
			final: true,
		});
	if (event.type === "input_audio_buffer.speech_started")
		return postEvent({ type: "turn_signal", providerEventId: event.event_id, signal: "speech_started" });
	if (event.type === "input_audio_buffer.speech_stopped")
		return postEvent({ type: "turn_signal", providerEventId: event.event_id, signal: "speech_stopped" });
	if (event.type === "response.done") {
		logUsage("response", event.response?.usage);
		postEvent({ type: "usage", source: "response", providerEventId: event.event_id, realtimeEvent: event }).catch(
			(error) => log(`usage post failed: ${error.message}`),
		);
		return postEvent({ type: "turn_signal", providerEventId: event.event_id, signal: "turn_complete" });
	}
	if (event.type === "error")
		return postEvent({
			type: "error",
			providerEventId: event.event_id,
			message: event.error?.message || "OpenAI realtime error",
			recoverable: true,
		});
}

async function pollOutbox() {
	if (!dc || dc.readyState !== "open" || pollInFlight) return;
	pollInFlight = true;
	try {
		const after = lastOutboxId;
		const epoch = connectionEpoch;
		const result = await json(`${sessionBase}/outbox?after=${after}`);
		if (epoch !== connectionEpoch || !dc || dc.readyState !== "open") return;
		const returnedIds = (result.events || []).map((item) => item.id);
		outboxPollTracer.record(after, returnedIds);
		for (const item of result.events || []) {
			lastOutboxId = Math.max(lastOutboxId, item.id);
			storeOutboxCursor(lastOutboxId);
			if (item.event?.type === "pi.helper.close") {
				traceRealtimeEvent("helper_close_from_outbox", item.event, { outboxId: item.id });
				postEvent({ type: "outbox_ack", outboxId: item.id }, { log: false }).catch((error) =>
					log(`outbox ack failed: ${error.message}`),
				);
				handleHelperClose(item.event);
				return;
			}
			traceRealtimeEvent("openai_outbound_from_outbox", item.event, { outboxId: item.id });
			dc.send(JSON.stringify(item.event));
			postEvent({ type: "outbox_ack", outboxId: item.id }, { log: false }).catch((error) =>
				log(`outbox ack failed: ${error.message}`),
			);
		}
	} finally {
		pollInFlight = false;
	}
}

function initialOutboxCursor(config) {
	const persisted = Number(sessionStorage.getItem(outboxCursorStorageKey()) || "0");
	const server = Number(config.resumeOutboxAfter || 0);
	const cursor = Math.max(Number.isFinite(persisted) ? persisted : 0, Number.isFinite(server) ? server : 0);
	storeOutboxCursor(cursor);
	return cursor;
}

function storeOutboxCursor(value) {
	sessionStorage.setItem(outboxCursorStorageKey(), String(value));
}

function sendContext(packet) {
	sendRealtime({
		type: "conversation.item.create",
		item: {
			type: "message",
			role: "system",
			content: [
				{
					type: "input_text",
					text: `[pi-realtime:${packet.channel}:rev-${packet.revision}] ${packet.summary}\n\n${packet.sections.map((section) => `${section.title}\n${section.text}`).join("\n\n")}`,
				},
			],
		},
	});
}

function handleInputAudioTranscription(event) {
	const transcript = event.transcript || "";
	logUsage("input transcription", event.usage);
	postEvent({
		type: "usage",
		source: "input_transcription",
		providerEventId: event.event_id,
		realtimeEvent: event,
	}).catch((error) => log(`usage post failed: ${error.message}`));
	postEvent({ type: "user_transcript", providerEventId: event.event_id, text: transcript, final: true }).catch(
		(error) => log(`transcript post failed: ${error.message}`),
	);
	if (!transcript.trim()) {
		trace("response_suppressed", {
			reason: "empty_transcript",
			providerEventId: event.event_id,
			itemId: event.item_id,
			transcriptTextLength: transcript.length,
		});
		return;
	}
	if (!isTranscriptActionable(transcript)) {
		trace("response_suppressed", {
			reason: "low_information_transcript",
			providerEventId: event.event_id,
			itemId: event.item_id,
			transcriptTextLength: transcript.length,
			lexicalLength: lexicalContentLength(transcript),
		});
		return;
	}
	if (interactionConfig?.transcriptHandling?.response !== "model") {
		trace("response_suppressed", {
			reason: "transcript_does_not_trigger_response",
			policy: interactionConfig?.transcriptHandling?.response,
			providerEventId: event.event_id,
			itemId: event.item_id,
			transcriptTextLength: transcript.length,
			lexicalLength: lexicalContentLength(transcript),
		});
		return;
	}
	requestResponse("valid_transcript", event.event_id);
}

function isTranscriptActionable(transcript) {
	return lexicalContentLength(transcript) >= 4;
}

function lexicalContentLength(transcript) {
	return transcript.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

function requestResponse(reason, providerEventId) {
	sendRealtime(
		{ type: "response.create", response: { output_modalities: ["audio"] } },
		{ label: "openai_outbound_response_create", reason, providerEventId },
	);
}

function handleHelperClose(event) {
	const reason = event.reason || "session stopped";
	log(`helper close: ${reason}`);
	setStatus(`Session stopped: ${reason}`, "warn");
	cleanupCurrentConnection();
	postEvent({ type: "disconnected", reason: `helper close: ${reason}` }).catch((error) =>
		log(`disconnect post failed: ${error.message}`),
	);
	// Keep chat/history visible when the voice session ends.
}

function sendRealtime(event, traceOptions = {}) {
	if (!dc || dc.readyState !== "open") return;
	const { label = "openai_outbound_direct", ...extra } = traceOptions;
	traceRealtimeEvent(label, event, extra);
	dc.send(JSON.stringify(event));
}

async function postEvent(event, options = {}) {
	if (companionMode) return; // Provider control and tool execution belong to the server.
	if (options.log !== false) log(event.type);
	await json(`${sessionBase}/event`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(event),
	});
}

async function json(url, options) {
	let response;
	try {
		response = await fetch(url, options);
	} catch {
		throw new Error(
			"Cannot reach the Pi voice server. Check that Pi is running and the network connection is available.",
		);
	}
	if (!response.ok) {
		const failure = await response.json().catch(() => ({}));
		const message = typeof failure.error === "string" ? failure.error : "Voice server request failed";
		const reference = typeof failure.errorId === "string" ? ` · Error ID: ${failure.errorId}` : "";
		throw Object.assign(new Error(`${message} (HTTP ${response.status})${reference}`), { status: response.status });
	}
	return response.json();
}

function trace(label, data = {}) {
	postEvent({ type: "trace", trace: { label, ...data } }, { log: false }).catch((error) =>
		log(`trace post failed: ${error.message}`),
	);
}

function traceRealtimeEvent(label, event, extra = {}) {
	trace(label, { ...extra, ...describeRealtimeEvent(event) });
}

function createOutboxPollTracer() {
	const emptyPollTraceInterval = 40;
	let emptyCount = 0;
	let emptySinceAt;
	return {
		record(after, returnedIds) {
			const now = Date.now();
			if (returnedIds.length > 0) {
				trace("outbox_poll", { after, returnedIds, emptyPollsBeforeResult: emptyCount, emptySinceAt });
				emptyCount = 0;
				emptySinceAt = undefined;
				return;
			}
			emptySinceAt ??= now;
			emptyCount += 1;
			if (emptyCount === 1 || emptyCount % emptyPollTraceInterval === 0)
				trace("outbox_poll_idle", { after, emptyPolls: emptyCount, emptySinceAt, lastAt: now });
		},
	};
}

function describeRealtimeEvent(event) {
	const description = { summary: summarizeRealtimeEvent(event) };
	addTextDetails(description, "content", contentText(event));
	addTextDetails(description, "transcript", transcriptText(event));
	addTextDetails(description, "text", outputText(event));
	addTextDetails(description, "functionArguments", typeof event.arguments === "string" ? event.arguments : undefined);
	const message = event.error?.message || (typeof event.message === "string" ? event.message : undefined);
	if (message !== undefined) description.message = message;
	if (event.error?.code) description.errorCode = event.error.code;
	if (event.error?.type) description.errorType = event.error.type;
	return description;
}

function summarizeRealtimeEvent(event) {
	return {
		type: event.type,
		eventId: event.event_id,
		responseId: event.response?.id || event.response_id,
		itemId: event.item?.id || event.item_id,
		callId: event.call_id,
		name: event.name,
		itemType: event.item?.type,
		role: event.item?.role,
		contentTypes: Array.isArray(event.item?.content)
			? event.item.content.map((part) => part?.type).filter(Boolean)
			: undefined,
	};
}

function addTextDetails(target, prefix, text) {
	if (text === undefined) return;
	target[`${prefix}Text`] = text;
	target[`${prefix}TextLength`] = text.length;
}

function contentText(event) {
	const content = Array.isArray(event.item?.content) ? event.item.content : undefined;
	const parts =
		content?.flatMap((part) => {
			const text =
				typeof part?.text === "string" ? part.text : typeof part?.transcript === "string" ? part.transcript : undefined;
			return text === undefined ? [] : [text];
		}) ?? [];
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function transcriptText(event) {
	if (event.type === "conversation.item.input_audio_transcription.completed") return event.transcript || "";
	if (event.type === "response.output_audio_transcript.done") return event.transcript || "";
	return undefined;
}

function outputText(event) {
	return event.type === "response.output_text.done" ? event.text || "" : undefined;
}

function logUsage(label, usage) {
	if (!usage) return;
	const input = usage.input_token_details || {};
	const output = usage.output_token_details || {};
	log(
		`usage ${label}: total=${usage.total_tokens || 0} input(text=${input.text_tokens || 0},audio=${input.audio_tokens || 0},cached=${input.cached_tokens || 0}) output(text=${output.text_tokens || 0},audio=${output.audio_tokens || 0})`,
	);
}

function parseArgs(raw) {
	try {
		const parsed = JSON.parse(raw || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function reportError(error) {
	setStatus(error.message, "err");
	postEvent({ type: "error", message: error.message, recoverable: true }).catch(() => undefined);
}

function setStatus(text, className) {
	statusEl.textContent = text;
	statusEl.className = className;
	log(text);
}

function log(text) {
	logEl.textContent = `${new Date().toLocaleTimeString()} ${text}\n${logEl.textContent}`.slice(0, 5000);
}
