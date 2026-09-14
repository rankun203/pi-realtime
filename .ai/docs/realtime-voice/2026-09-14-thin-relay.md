---
date: 2026-09-14
status: implemented locally; quality infrastructure blocked; live WebRTC acceptance pending
---

# Thin voice relay

## User feedback and goal

Supersedes the earlier shortened-readback/local-history-answer policy. Forward intentional user speech faithfully, including greetings, corrections, and follow-ups. Read normal Pi progress and results nearly verbatim, without independent investigation, reconstructed requirements, or commentary. Ignore side conversations where recognizable. Preserve Pi behavior, native interruption, and direct browser-to-Azure WebRTC. Close all paid-test connections.

## Evidence and decisions

- Incident traces showed roughly 1.3 seconds of detected speech interrupting a readback, followed by tool-call turns reconstructing a request. No retained audio/transcription proves what the user said or heard. Speech detection is not proof of assistant-directed intent.
- Azure handshake checks rejected `gpt-realtime-2` on this resource with HTTP 400 `OperationNotSupported`; `gpt-realtime-2.1-mini` connected. Deployment compatibility is resource-specific, not inferred from a generic model list.
- Real Mini evaluations rejected the prompt-only approach: a side-directed Chinese text turn was ignored, but the same synthetic audio was posted; other runs produced a preamble or independently answered a follow-up from history.
- Requiring tools on native input prevented tool bypass but was insufficient by itself. Default-conversation readback, including a response-specific instruction attempt, sometimes answered an outstanding project question instead of speaking the provided Pi update. This does not establish a general Azure API defect; it establishes that this fixture's mixed conversation was unreliable.
- Separating native routing from explicitly scoped, tool-free, out-of-band audio responses passed subsequent evaluations. Readback receives only the new text, not the original user's outstanding goal. This is an API/data-path separation, not a cooldown, audio mute, or prompt-only symptom patch.

## Implementation

- `companion/prompt.ts`: input routing policy requires a tool and uses text output, eliminating independent native-turn speech. `post_message` accepts only `message`; `wait_for_user` silently handles overheard/unclear turns. Remove independent status/history tools. Readback requests use `conversation: none`, `tool_choice: none`, explicit input, and audio output. Preserve substantive wording and language; adapt formatting for speech.
- `companion/runtime.ts`: posts are server-labeled `user`; follow-ups remain queued, not steering. Bounded pending Pi text is passed explicitly to readback. Receipts, waiting, and private memory do not schedule speech or erase pending progress. Actual request failures receive a separate readback. Lifecycle restart remains an explicit tool-capable spoken exception. Pi configuration, prompts, tools, conversation output, VAD settings, and browser media routing are unchanged.
- `providers/openai/socket-open.ts`, provider adapter, and `service.ts`: bounded JSON handshake diagnostics expose status/code/message, redact the configured key, omit raw HTML, and terminate failed/timed-out upgrades. Failed starts clean their adapter and mark the session stopped. No deployment fallback or silent model switch.
- Helper traces include tool names, call/item/response IDs, completion status/reason, and error codes, without tool arguments, audio, or credentials.

## Validation

- 64 deterministic tests pass: existing lifecycle/branch/native-ordering regressions plus reduced tools, enforced user origin, silent waiting, preserved progress, isolated tool-free readbacks, Azure rejection formatting, timeout/oversized-body cleanup, successful socket ownership, and failed-start cleanup.
- Typecheck, formatting, offline Pi extension loading, and the error-level deslop gate pass. Advisory scan findings were reviewed; existing optional-callback/argument-count/delay findings do not require a new abstraction or suppression for this change.
- Mocked-provider Chromium integration passed using the real Pi SDK/control plane: queued work, observation, takeover, handover, restart, tab close, and uninterrupted Pi work. Approximately 10 seconds; browser and fixture exited.
- Live Azure Mini WebSocket tests passed near-verbatim progress, faithful Chinese request forwarding, English follow-up delegation, Pi's timing answer, and silent side-directed Chinese text. Two synthetic Chinese side-conversation samples chose `wait_for_user`, including a held-out dinner/kitchen conversation without an explicit computer disclaimer. A subsequent synthetic Chinese follow-up—“刚才的单元测试花了多长时间？”—was forwarded without a wake word or added requirements. Successful runs took approximately 17–23 seconds; the combined audio run generated 780,000 audio bytes. All sockets closed in `finally`, including failed evaluations.
- A spoken “14 point 3” rendering initially failed an overly literal numeric assertion; the assertion now accepts equivalent numeric speech, not changed factual content.
- `gates:quality` remains blocked by missing `sentrux`. Running `gates:validation` independently reproduces its preexisting missing `pi-to-realtime-context-and-tool-response-policy-goal-plan.md` reference. The required `pi-extension-dev` skill/protocol is also absent. No gate was weakened, fabricated, or bypassed as a pass.

## Limits and next acceptance

- Intent recognition remains probabilistic. Passing synthetic samples does not guarantee arbitrary background filtering; native VAD may interrupt playback before the model determines addressee. Unintelligible audio waits silently rather than inventing words. No wake word, blanket mute, cooldown, or custom interruption mechanism was added.
- Existing bounds retain up to eight recent messages/8,000 characters, with a 2,000-character per-message cap; pending readback is similarly bounded. Long messages/backlogs can therefore be truncated or older pending content evicted. Full unbounded spoken fidelity is not claimed. Reassess with long-report acceptance; a future explicit chunk/queue policy must avoid silent loss without modifying Pi's original output.
- Out-of-band audio was verified on Azure WebSocket, not in the user's physical phone/WebRTC session. Verify native barge-in/playback, intermediate progress, follow-ups, and side conversation on the working phone network after stop/reload/start. The Mac media-route restriction remains unresolved; no security settings were changed.
- The user subsequently reported substantially improved phone behavior and authorized committing/pushing after disclosure of the quality-infrastructure blockers. The separate [voice-cost footer fix](2026-09-14-voice-cost-footer.md) records that follow-up. No active user call was restarted, no provider default was changed, and no proxy target was silently repointed.

## Official references

- [Realtime conversations: response configuration and out-of-band responses](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime prompting guide](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
- [Voice prompting](https://developers.openai.com/api/docs/guides/voice-prompting)
- [Realtime 2.1 Mini model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
- [Azure WebRTC same-session sideband control](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc)

OpenAI guidance informs the design; actual Azure requests establish the tested resource's support. No reasoning-effort, VAD, temperature, or deployment-compatibility assumptions were added.
