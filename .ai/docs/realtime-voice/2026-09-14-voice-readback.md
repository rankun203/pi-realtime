---
date: 2026-09-14
status: implemented; phone acceptance pending
---

# Voice connectivity and faithful readback

## Problem and user feedback

Browser voice claimed to connect while media never established. After successful phone access through a private HTTPS route, voice posted a question to Pi, speculated about missing context while waiting, and then repeated Pi's answer. Pi's answer itself was appropriate.

Keep Pi's prompt, tools, output, and work behavior unchanged. Speak its intermediate progress as well as results, with light shortening but no extra investigation or unsolicited questions. Preserve original visible context for follow-up detail. Keep direct browser-provider WebRTC and native interruption; do not add an audio proxy. Close all test provider connections.

## Evidence and implementation

- Isolated Chrome with synthetic microphone audio reproduced ICE `checking`, zero outbound audio packets, unanswered media connectivity checks, and a disconnect about 30 seconds after negotiation. TCP to the advertised Azure media endpoint on port 3478 also timed out. HTTPS authentication succeeded; a separate real Azure WebSocket/443 test generated 103,200 audio bytes. This supports a media-route restriction, not an invalid key or model. It does not identify the blocking network component.
- Browser status now follows real peer state, not SDP acceptance. Failed-media diagnostics include ICE state and packet counters, without SDP, credentials, or device addresses. Native terminal connection failure releases the call; transient disconnection can recover. Provider close reasons survive into the retired device's heartbeat error and trace. The reproduced reason was `1000: observer_writer_exit`; it is not treated as a universal network-error code.
- `companion/runtime.ts` previously set `lease.pending` after every tool result. Successful `post_message` now returns its queue receipt without scheduling an extra model response. It does not clear already-pending Pi output. `observe()` still schedules speech for new assistant messages while Pi is busy. Failed posts and requested history/status results retain their response path.
- Only the voice prompt changes. It distinguishes progress, results, receipts, follow-up detail, and new investigation; asks for faithful, concise first-person readback; and retains the existing context/lifecycle boundaries. No Pi control-plane or coding-agent prompt changes.

## Official guidance consulted

Checked online on 2026-09-14:

1. [GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1): reasoning, tool use, improved interruption/noise handling; configurable reasoning effort can affect latency and usage.
2. [GPT-Realtime-2.1 Mini model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini): the configured model family is a distilled reasoning model supporting WebRTC, WebSocket, and SIP. It is not a transcription-only or non-reasoning model.
3. [Prompting voice models](https://developers.openai.com/api/docs/guides/voice-prompting): the linked guide is labeled Realtime 2, not a dedicated 2.1/Azure tuning guide. It recommends minimal prompts, short labeled sections, explicit trigger/action/exception rules, deliberate short preambles, and response length by task. Applied those principles without copying unrelated customer-service flows or adding unsupported tools.
4. [Realtime prompting cookbook](https://developers.openai.com/cookbook/examples/realtime_prompting_guide): older general Realtime guidance supports short bullets, concrete examples, consistent tool definitions, and evaluation rather than guessing. Do not describe it as 2.1-specific evidence.
5. [Realtime conversations: function calling](https://developers.openai.com/api/docs/guides/realtime-conversations): adding a `function_call_output` and sending `response.create` are distinct operations. This supports returning the queue receipt without requesting another answer from that receipt alone.

No reasoning-effort, temperature, VAD, or phase-processing API settings were added based on assumed Azure parity. No cooldowns, blanket muting, or prompt-only substitute for the scheduling fix.

## Validation

- Deterministic suite: 58 passing tests, including silent successful receipts, unchanged intermediate progress while busy, final output, no repeated observations, progress racing a slow receipt, failed posts, and requested history continuation.
- TypeScript checks and mocked-browser integration pass. The browser integration exercises the actual Pi SDK with a synthetic coding model, takeover, restart, and cleanup.
- Live Azure Mini prompt evaluation passes queued-receipt silence, progress readback, and follow-up retrieval of an original timing value without posting new Pi work. Provider socket closes in `finally`. This is a real model/audio generation test over WebSocket, not a browser media or physical microphone test; model wording remains probabilistic.
- The browser live test now requires real connected state, audio packets in both directions, playback progress, and stability beyond the reproduced failure window. Local end-to-end media remains blocked by the observed route. The user subsequently reported successful phone voice, followed by the readback issue above; phone acceptance of this revision is pending.
- Existing aggregate quality blockers remain: missing `sentrux` and a preexisting validation probe referencing absent `.ai/docs/realtime-voice/pi-to-realtime-context-and-tool-response-policy-goal-plan.md`. Required external `pi-extension-dev` skill/protocol is absent. These were not silently removed or weakened.

## Limitations and follow-up

Original context/history remains bounded by existing retention limits; concise speech does not introduce additional truncation. No architectural workaround for the network restriction was added. Automatic receipt suppression prevents the extra application-requested turn, but is not a blanket prohibition on native user turns or a guarantee against every model-generated preamble. Confirm phrasing, interruptions, progress timing, and follow-up detail in the user's phone session after reload.
