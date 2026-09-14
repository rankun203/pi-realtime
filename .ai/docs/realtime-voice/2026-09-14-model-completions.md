---
date: 2026-09-14
status: implemented
---

# Realtime model command discoverability

The user could not select the larger 2.1 model from command suggestions. Direct Azure handshake checks accepted `gpt-realtime-2.1` and `gpt-realtime-2.1-mini`, while `gpt-realtime-2` returned HTTP 400 OperationNotSupported. All check sockets were closed; no audio response was requested and no settings changed. Catalog listing alone was not treated as deployment availability.

The provider catalog already contained both 2.1 names, but command completions and two help strings duplicated an older two-model list. They now derive from `OPENAI_REALTIME_MODELS`, with a regression test covering all three surfaces. Help distinguishes model/deployment names from endpoint availability. No model fallback, pricing assumptions, audio changes, or compatibility debt were introduced.

After reload, select `/realtime openai model gpt-realtime-2.1`; this applies to future calls. Full voice behavior on the larger deployment remains unverified. Existing quality-gate infrastructure blockers remain documented in the thin-relay notes.
