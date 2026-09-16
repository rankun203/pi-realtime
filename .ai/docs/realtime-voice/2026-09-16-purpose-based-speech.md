# Purpose-based spoken updates

## Evidence and cause

The latest completed study-project session (`01a0a8e5-b5a2-73f8-aab9-aa523cb19ec0`) retained voice transcripts that dictated a JavaScript heredoc and later shell commands and temporary-file paths. The user explicitly requested no code readout, yet subsequent commands were still spoken. Companion readback instructions required nearly verbatim speech and prohibited summarization. Out-of-band responses deliberately lacked user conversation context, so an earlier spoken preference could not override that policy.

## Change

Replace the conflicting readback policy with concise purpose-based speech for code, commands, paths, URLs, and identifiers. Preserve substantive facts, warnings, language, and planned/completed distinctions. Keep original Pi messages unchanged. Include only the latest visible user message (bounded to 2,000 bytes) as reference for an explicit request to dictate technical text. Keep tool-free, out-of-band responses and native routing/interruption unchanged. Update current guidance and add runtime coverage and live-model cases.

This addresses the demonstrated policy cause rather than adding regex speech filters or disabling realtime behavior. Model adherence remains probabilistic; the bounded latest-user reference is not a persistent dictation mode or per-work-item intent tracker.

## Validation

- 16 focused companion tests passed, including unchanged source text, bounded latest-user reference, no extra work, and isolated speech.
- Type-check passed.
- Live configured voice-model WebSocket smoke test passed: purpose-based technical speech, explicit command dictation, fact/status preservation, silent receipts, delegated follow-ups, and side-directed text. This is not a physical microphone/WebRTC test.
- An initial live assertion incorrectly rejected the ordinary word “fetches”; narrowed it to syntax rather than banning a legitimate purpose description.
- Validation runner passed 75 tests, then hit the pre-existing missing context-policy design-note fixture.
- Full quality gate blocked by the pre-existing missing `sentrux` executable. Required extension-development skill/protocol path is also absent.

Reload Pi and reconnect voice to use the updated helper code. Legacy raw/eco transports are unchanged.
