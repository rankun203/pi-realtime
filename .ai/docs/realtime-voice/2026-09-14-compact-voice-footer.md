---
date: 2026-09-14
status: implemented
---

# Compact voice footer

The user approved an inline active-model label instead of replacing Pi's built-in footer for right alignment. They then requested Pi-style compact token counters and the cost label `$0.0123 (api)`.

The status line now displays uncached input (`↑`), output (`↓`), cached input (`R` when nonzero), the latest response's cache-hit percentage (`CH` when input is known), four-decimal API cost, and distinct active/starting model names. Counts use Pi-style k/M formatting and cover text, audio, and image tokens. Input excludes cache reads to avoid double counting. Multiple active sessions retain an explicit count; inactive sessions and future model preferences do not affect the model labels.

The shared cost formatter uses `(api)` rather than `est.`. Costs remain list-price estimates, not invoice totals; unknown/partial pricing labels and full accounting precision are preserved. No subscription, auto-compaction, or context-window indicators are fabricated. Pi's built-in footer and audio behavior remain unchanged.

Regression coverage includes model labels/deduplication, inactive sessions, no usage, compact counts, cache accounting, latest-response selection with out-of-order observations, reset boundaries, unknown pricing, and precision. No new compatibility or pricing debt. Existing quality-infrastructure blockers remain documented in prior notes.
