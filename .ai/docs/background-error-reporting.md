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

Existing temporary-directory traces are not rotated and may include sensitive diagnostic messages. This change reuses their existing lifetime and discovery contract rather than introducing a second logger. A separate trace-storage change should introduce retention and review redaction across all trace producers. Unhandled failures outside the two initially investigated reporting paths were left pending an example of the original error; the supplied example and follow-up fix are recorded below.

## Follow-up: stale browser-session request failures

### Problem and evidence

The user supplied repeated `pi-realtime request failed` JSON lines with `action: messages` and HTTP 500. These match the helper HTTP handler's `console.error` fallback exactly: a legacy URL has no registered session, so `requireSession` throws and the catch block cannot find a session trace. Each browser poll then wrote directly to stderr over the Pi TUI. The first fix did not cover this path.

### Implemented solution and reasoning

Removed terminal logging from the helper request-error handler. Missing-session and malformed-route failures now use a lazily created `helper-errors-*.jsonl` trace, discoverable in the helper status output. Failed session-log writes also fall back to that file. Logging failures never escape the HTTP catch block or trigger console output. Missing sessions return HTTP 410 with recovery instructions instead of an unexplained HTTP 500. Every response retains its error correlation ID. This fixes the actual output source without disabling browser polling or changing voice behavior.

### Validation

A real loopback HTTP regression sends 20 consecutive `messages` requests for a legacy session, verifies HTTP 410, correlates all responses to file records, and asserts no console errors. It also exercises a malformed route and an unwritable fallback logger. All 83 tests pass, along with type-checking, the deslop error scan, and offline extension loading. Full quality and validation gates remain blocked by the same missing `sentrux` executable and policy document noted above. No live provider call was needed or claimed for this HTTP logging regression.

### Technical debt

Retains the existing unrotated temporary trace storage. If both trace destinations are unwritable, the client still receives its error and correlation ID, but diagnostics cannot be persisted; silent terminal behavior is intentional. Future trace-storage work should add retention and an out-of-band log-health status. Old clients can continue polling stale URLs; those requests now receive a recovery response and cannot flood the terminal.
