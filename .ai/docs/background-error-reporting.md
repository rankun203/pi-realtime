# Background error reporting — 2026-09-16

## Problem and evidence

`service.ts` appended a Pi warning notification for every normalized provider error and every microphone/playback error. A burst therefore grew the transcript without bound. Provider errors were already traced; audio errors were not. The recent local companion traces contained no normalized provider errors, so the user's exact reported burst has not been reproduced or attributed conclusively. A sample error was requested.

## Change

Background errors now write to the existing per-session JSONL trace and replace one stable `pi-realtime.error` footer slot. The compact status identifies the latest error category and points to `/realtime debug`; full multiline messages remain in the log. Provider event metadata is retained. Logging failures update the same slot without throwing; shutdown clears it. Explicit command output, transcripts, and realtime transport behavior are unchanged.

## Validation

- Burst regression: 100 provider errors plus an audio error retain all 101 log records, issue no notifications, occupy one status slot, and clear on shutdown.
- Unwritable-log regression: repeated failures do not escape into Pi exception notifications.
- All 82 TypeScript/Node tests passed, as did type-checking, changed-file formatting, deslop error scan, diff whitespace checks, and offline extension loading.
- Full quality gate blocked: `sentrux` unavailable.
- Validation probes blocked after tests by a pre-existing missing document: `.ai/docs/realtime-voice/pi-to-realtime-context-and-tool-response-policy-goal-plan.md`.
- Referenced pi-extension-dev skill/protocol files are unavailable on this machine; installed Pi extension docs and status-line example were consulted.
- No live voice-session validation or claim of resolving the underlying provider/audio failure.

## Retained debt

Existing temporary-directory traces are not rotated and may include sensitive diagnostic messages. This change reuses their existing lifetime and discovery contract rather than introducing a second logger. A separate trace-storage change should introduce retention and review redaction across all trace producers. Unhandled failures outside the two investigated reporting paths remain outside this fix pending an example of the original error.
