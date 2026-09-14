---
date: 2026-09-14
status: implemented; live reload acceptance pending
---

# Voice cost footer after WebRTC handoff

## Problem and feedback

The user reported that the thin relay was substantially better, but Pi's footer showed only the coding-model cost during an active voice call. They requested a fix and explicitly authorized committing and pushing the extension repository after the existing quality-infrastructure blockers had been disclosed.

## Evidence and root cause

The current Pi session persisted 47 voice usage observations totaling approximately $0.18948 estimated at inspection. Accounting and pricing were working, including text-only routing turns and audio readbacks.

The recorded transport sequence was raw `connected`, explicit raw `disconnected`, WebRTC bridge `connected`, then a delayed raw `disconnected: socket closed` about 300 milliseconds later. Both transports use the same logical provider-session ID. The retired socket's event incorrectly changed the active session to `stopped`; `statusText()` correctly hides the footer for stopped sessions. Subsequent usage events did not restore active state. This was transport ownership, not missing Azure pricing or lost usage delivery.

## Fix and verification

`service.ts` binds the initial adapter's event sink to its adapter identity. After replacement/removal, its events cannot mutate the current transport's lifecycle or post stale work. Late usage observations remain accepted for accurate billing estimates; they do not reactivate stopped sessions. No cost calculation, footer visibility rule, Pi work behavior, or audio semantics changed.

A regression test reproduces the recorded ordering through the service and real state reducer, verifies the new session remains active, verifies late billable usage still updates the footer, and verifies genuine stop events hide it without stale reconnection reviving it.

65 deterministic tests and TypeScript validation pass. The prior full-gate blockers remain: missing `sentrux`, an absent validation design-note reference, and the absent required extension-development skill. No gate was disabled or reported as passing despite those blockers.

## Limitations and handoff

No persisted history was rewritten and the live user call was not disrupted. Existing incorrectly stopped session state needs a fresh call after `/realtime stop`, `/reload`, and `/realtime`. `/realtime usage` can display already-recorded estimates in the meantime. Estimates remain list-price estimates, not an Azure invoice. The fix adds no compatibility bridge or new pricing debt.
