---
date: 2026-09-14
status: implemented; live reload acceptance pending
---

# Compact voice context and connection countdown

The user requested very short context and session-lifetime indicators, and explicitly asked for an extensible model-to-context-window mapping rather than model-name conditionals.

The footer adds `C~65%/128k` and `T42:18` before the model name. `C?/128k` appears before a native response reports input usage. Unknown deployment aliases have no inferred context limit. The mapping lives beside the existing provider model catalog, with verified entries for 2.1 and 2.1-mini.

Official [2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) and [Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) model pages list **128,000 context tokens** and **32,000 maximum output tokens**. The initial conversational example using a 32k context denominator was corrected after checking these fields. These are published model limits, not dynamically measured deployment limits.

Context telemetry uses input tokens from the latest response associated with the native conversation. Out-of-band readback responses have no conversation ID and cannot overwrite it. This includes cached input; it is approximate because later output, observations, and truncation can change resident context. It is neither cumulative billing usage nor Pi's coding-model context.

The [Realtime conversation guide](https://developers.openai.com/api/docs/guides/realtime-conversations) documents a 60-minute session maximum. The countdown uses the provider's session expiry when reported, otherwise a conservative deadline from local voice-lease creation. It starts with a real device connection, not logical helper startup, resets on reconnect, and clamps to zero. Existing proactive restart behavior is unchanged (55-minute notice, 58-minute forced restart, and the retained 16k input-token restart threshold); therefore the timer can reset before reaching zero.

Live telemetry travels through the existing helper/provider/service interfaces. A one-second UI refresh updates the countdown without generating provider requests or persisted timer events, clears stale indicators after disconnect, and is disposed on extension shutdown. Pi's built-in footer is unchanged.

74 deterministic tests pass, along with typecheck, formatting, error-level deslop, offline Pi loading, and the mocked-provider browser integration (approximately 10 seconds, fixture/browser closed). A real Azure 2.1 out-of-band text response also confirmed `conversation_id: null`. Tests cover the context mapping, aliases, short indicators, countdown advancement/expiry, missing context, stale owners, provider expiry, local lease deadlines, readback exclusion, and reconnect reset. The full quality gate remains blocked by missing `sentrux`; prior missing validation-document/skill blockers have not been bypassed. Retained limitations: local expiry is approximate when the provider omits it; model windows are documented rather than endpoint-reported; context is the latest native input snapshot; the older conservative 16k restart policy remains and should be reassessed separately for larger models. No audio/VAD or restart policy changes were bundled into this UI task.
