# Voice failure diagnostics

## Problem and evidence

The reported call reached the extension's 55-minute refresh policy, completed its announcement, and released its local lease. Disconnect and subsequent connect requests returned only `500 {"error":"fetch failed"}`. The trace did not retain their underlying causes. A separate contemporaneous Node request to the configured Azure hostname failed with ENOTFOUND; local DNS returned NXDOMAIN while Google and Cloudflare DNS-over-HTTPS resolved it. This supports a current DNS failure, not retrospective proof of the original request's cause. No recorded provider timeout or context exhaustion established the rollover cause; the local timer explains the announcement.

## Implementation and reasoning

- Wrap companion provider operations with stage, hostname, recognized nested network cause codes, HTTP rejection status, and timeout/invalid-response distinctions. Do not log provider bodies, credentials, SDP, raw error messages, URL paths, or query strings. Unrecognized causes stay unknown.
- Record helper request failures with a correlation ID returned to the client. Ensure registered helper sessions have a trace even when a caller did not supply a recorder.
- Record companion background connection/control/cleanup/supervision failures as structured events. Preserve the primary connection error if cleanup also fails; record cleanup separately.
- Display the server's readable explanation and error ID, not a long route and raw JSON. Distinguish browser-to-helper connectivity failure from helper-to-provider failure.
- Keep native audio, the refresh policy, and DNS settings unchanged. Do not retry around or bypass DNS failures.

## Validation and limitations

Deterministic coverage includes nested/aggregate causes, credential exclusion, actual transport creation/negotiation failures and HTTP rejection, HTTP-client-to-trace correlation, cleanup/shutdown logging, retry without a stale device lease, and browser error presentation. All 79 tests, type-checking, formatting of changed files, error-level deslop scanning, diff checks, and the offline extension-load check pass. No physical microphone or live WebRTC rollover claim is made.

The full quality gate is blocked by existing missing `sentrux` tooling; the validation runner separately stops at its missing context-policy probe document after the 79 tests pass. The required extension-development skill/protocol path is absent in this environment. Speech-policy changes from the preceding task are included in the requested extension commit; their live model validation is documented separately.

## Technical debt

Unknown error messages are deliberately not copied to logs because they may contain credentials. The diagnostic allowlist may need new platform/provider codes over time. Existing non-diagnostic traces may contain conversation text and still require redaction before sharing. DNS remediation remains an operator action; no environment settings were changed.
