# Server-owned voice companion

## Contract

One logical companion follows one open Pi session and its active branch. Pi owns work; voice owns its spoken interaction and chooses what to say. Devices are interchangeable and a new device must explicitly take over. Losing voice never interrupts Pi.

## Implementation batches

1. **Runtime and provider transport.** Add a server-owned companion with bounded voice handover, Pi-output observations, `post_message(message)` with server-owned user origin, silent `wait_for_user`, one active device lease, restart supervision, and durable private state. Use server-owned WebRTC negotiation and an authenticated sideband connection to the _same_ provider session. Azure uses server-minted ephemeral credentials plus raw SDP; OpenAI uses its multipart interface. Keep credentials and tool execution out of the browser. Azure documents this observer/controller architecture: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc .
2. **Pi and device wiring.** Host the runtime in the existing loopback helper process (a server module, not another model/Pi agent), behind the existing Pi Agents gateway. Observe ordinary Pi output, queue voice-originated messages without steering, and send non-turn-triggering lifecycle notices. Browser becomes audio/UI only in companion mode. Keep legacy eco/raw transports compatible. Device detach closes provider resources; reconnect restores compact voice-side state and current Pi context. Enforce leases, including disappearance without an unload event.
3. **Validation and handoff.** Deterministic lifecycle, tool-origin, branch, bounded-context, disconnect-race, and persistence tests; browser tests through the real gateway/helper with mocked provider; live Azure negotiation/sideband/tool/result/cleanup checks when available. Report physical-device validation separately. Commit and secret-scan each batch before pushing.

## Context and safety

- Pi gets only posted messages and lifecycle notices, never the entire voice transcript/handover.
- Pi history retrieval is bounded, session/branch scoped, and excludes private reasoning, tool results, and system instructions.
- Resume context contains recent voice turns, any model-written handover, current Pi briefing and bounded new visible output. Follow-ups are forwarded to Pi, not independently answered through voice history/status tools.
- The service owns IDs, deduplication, branch invalidation, lease expiry, and connection teardown. The model does not decide whether a stale device remains authorized.
- Voice cannot initiate work. Intentional speech and follow-ups become queued custom user-origin messages, not steering interrupts. Native input turns require tools and produce no independent audio; Pi readbacks use tool-free out-of-band audio responses containing the new Pi text. Silent waiting is model-classified and does not disable native VAD/barge-in.
- Restart at a quiet boundary before provider session/context limits. A short model-delivered reconnect notice plus handover is best effort; hard expiry/disconnect must still close resources. Failed/abrupt sessions resume from saved recent turns, without claiming an unheard answer was heard.
- Detached mode records Pi state without model inference. Connected idle mode has no application-imposed silence timeout; provider limits still require rollover.

## Implemented verification

- Deterministic tests cover explicit takeover, stale-device rejection, duplicate tool events, server-owned origin, absent investigation tools, isolated readback, silent waiting, native VAD ordering, detached operation, private persistence, restart/playback ordering, branch invalidation, and bounded startup context.
- An opt-in browser fixture runs the real Pi SDK and control plane with a synthetic coding model. Browser tests cover posting to Pi, ordinary Pi-output observation, device takeover, private handover, provider restart, tab closure while Pi works, and reconnect.
- Live Azure testing uses a synthetic spoken WAV through Chromium's real WebRTC stack, real provider tool decisions, the real Pi SDK with a synthetic coding model, and a real spoken result. It verifies server-side hangup. This is not a physical microphone or Cloudflare deployment test.
- The first live negotiation exposed Azure rejecting resource-key multipart SDP (401). The transport now follows Microsoft's documented two-step Azure flow; credentials remain entirely server-side.

## Known prerequisites/limits

The required `~/.codex/skills/pi-extension-dev` skill is absent in this environment. Full quality gate has an existing missing `sentrux` dependency; an existing probe references a missing design note. No claim of live browser/phone success will be based solely on mocks. Cloudflare Access must protect the complete hostname; origin checking is not authentication.
