# Pi Agents

Private, chat-first dashboard for Pi instances running pi-realtime on **one server / one OS account**. Uses Node's built-in HTTP server, no frontend framework or separate database.

## Run locally

From this repository:

```bash
corepack pnpm dashboard
```

Open `http://127.0.0.1:8877`. `PI_AGENTS_PORT` changes the port; the listener always stays on IPv4 loopback. Use the same port on both sides of a laptop SSH tunnel.

After updating, restart the dashboard process and `/reload` once in each Pi and run `/realtime` (or `/realtime start` to attach browser audio to an existing session). Helpers register private metadata under `~/.pi/agent/pi-realtime/helpers/`. The dashboard verifies each live helper before listing/proxying it. `PI_CODING_AGENT_DIR` must match between Pi and the dashboard when customized. Stale/dead registrations are ignored. Selecting an agent does not start a provider connection or request the microphone.

- Select an agent/project from the top picker. Switching does not copy context; voice sessions attached to the same Pi still share that Pi's current branch.
- Type messages without granting microphone access. They are sent as ordinary Pi user messages, queued as follow-ups when busy.
- Start/end a voice call inside the chat. Switching releases the previous page's microphone and peer connection; active calls prompt before switching.
- Pi's recorded user/assistant text and voice replies appear in chat. Tool output, hidden reasoning and system context are excluded. Debug events are collapsed by default.
- Pi messages refresh when recorded, not token-by-token. Voice-side history/handover is bounded and privately persisted; Pi messages follow the current branch. Native voice mode does not manufacture transcripts for user audio: optional transcription must be configured if you want those words displayed.
- Voice costs are local estimates, independent of Pi coding costs. Mini uses verified Azure Global Standard USD list rates; check your deployment tier and invoice.

This version lists **helper-enabled sessions**, not every arbitrary Pi process. Start it in each Pi you want available. It does not launch Pi remotely. One voice companion belongs to one Pi session; another device must explicitly take over its audio connection.

## Server-owned voice companion

In browser agent mode, the helper hosts the voice runtime. Pi remains the work authority, and voice independently chooses what to say about Pi's ordinary visible output. Voice uses `post_message(message, origin)` to queue user-directed or voice-initiated messages without steering an active Pi turn; `get_pi_status` and `read_pi_history` inspect work without starting a new turn. Special `realtime_send_*` tools are unnecessary and are skipped in companion mode. Legacy raw/eco transports retain their existing behavior.

- Devices negotiate through the helper; provider credentials and sideband tool execution remain server-side. Audio is still direct WebRTC between device and provider.
- End call, tab closure, or a missing device heartbeat closes provider resources. A takeover revokes the old lease; stale events cannot post new work. Lease expiry is 45 seconds for disappearance without a usable unload notification.
- Pi continues working while voice is detached. Lifecycle notices are queued for the next real Pi turn, with no acknowledgement or new turn triggered.
- Reconnect gets a fresh provider session with bounded Pi context, recent voice turns/posted-message references, and a private voice handover. Older Pi messages remain available through history tools. No entire Pi history is replayed.
- The voice model can save a handover or request a restart. The runtime requests a restart before provider/context limits; the browser reconnects after generated audio finishes. Context exhaustion has a reconnect fallback. A forced disconnect may use a UI notice rather than a completed spoken notice.
- Private state lives under `~/.pi/agent/pi-realtime/companions/` (respects `PI_CODING_AGENT_DIR`), with mode-600 files. Branch navigation clears voice context to avoid cross-branch leakage. Session shutdown closes the runtime; state files remain on disk until explicitly removed.
- Native user audio is not transcribed by default or stored as raw audio. Reconnect continuity uses model-written memory, posted-message references and recent available transcripts. An abrupt disconnect can lose conversational details the voice model has not saved. Generated transcripts are not treated as proof the user heard the entire response.

The runtime is a module in the existing helper process, independent of Pi's model turn—not a second Pi coding agent or a new daemon. The gateway remains the stable entry point for devices. See [VOICE-PLAN.md](VOICE-PLAN.md) for decisions and verification scope.

### Companion integration tests

```bash
uv run --no-project --with playwright python -m playwright install chromium
uv run --no-project --with playwright python .ai/validation/companion-browser-smoke.py
```

This uses the real Pi SDK with a synthetic coding model, and mocked provider/audio. To additionally test the actual configured realtime provider through Chromium's real WebRTC stack, supply a WAV containing synthetic speech after about ten seconds of silence:

```bash
PI_COMPANION_LIVE=1 PI_COMPANION_AUDIO=/absolute/path/to/synthetic-request.wav \\
  uv run --no-project --with playwright python .ai/validation/companion-browser-smoke.py
```

The live test incurs provider token charges and checks an utterance asking Pi to inspect files. The fixture Pi model returns `apple.txt` and `pear.txt`; it never runs tools against your real workspace. Tests run isolated temporary sessions, not your active Pi conversation. Chromium requires its normal OS libraries.

## Cloudflare Tunnel + Access

**This app has no standalone login.** Loopback is its trust boundary. Cloudflare Access must protect the entire hostname before exposing it. Same-origin and Host checks are additional protections, not authentication. Local processes with access to your account are trusted.

1. Pick a dedicated hostname, such as `agents.example.com`.
2. Create a Cloudflare Access **self-hosted application for the entire hostname and all paths**. Allow only your identity; require MFA through your identity provider if available. Do not bypass `/api/*`, `/agents/*`, assets, token endpoints or event/message endpoints.
3. Set `PI_AGENTS_PUBLIC_HOST=agents.example.com` for the dashboard. This is a hostname, not a URL.
4. Route a named Cloudflare Tunnel to `http://127.0.0.1:8877`. Preserve the public Host header with `originRequest.httpHostHeader` (see `cloudflared.example.yml`). Do not publish a direct origin, expose helper ports, or enable a temporary public tunnel without Access.
5. Launch the dashboard, for example:

   ```bash
   PI_AGENTS_PUBLIC_HOST=agents.example.com corepack pnpm dashboard
   ```

6. Verify **logged out** in a private browser: `/`, `/api/agents`, and an actual `/agents/.../client-secret` path must be denied or sent to Access login. A GET-only check does not prove a POST endpoint is protected. Confirm no bypass policy grants public access.
7. Log in on your phone, pick an agent, and tap Start call. Microphone access needs HTTPS; keep the page foregrounded. Audio flows directly from the browser to Azure/OpenAI, not through the tunnel. Grant Access to a trusted identity only: this dashboard can instruct your coding agents.

The app does not independently validate Access JWTs: it assumes the only internet ingress is the Access-protected Tunnel and binds exclusively to loopback. If you later expose an origin directly or run a multi-user shared server, add origin authentication/JWT validation and appropriate isolation first.

Run both the dashboard and cloudflared under a process supervisor for persistence; a sample user systemd unit is included. Install/enable only after replacing its hostname and checking paths. No Cloudflare resources, DNS records or services are provisioned automatically.

## Tests

```bash
corepack pnpm test
```

Tests cover helper chat projection, API writes and validation, transcript deduplication, registry verification, proxy path restrictions, cookie stripping, Host/Origin checks and cost estimates. Phone microphone/Cloudflare end-to-end checks still require the deployment and a real device.

An optional Chromium smoke test exercises the real dashboard/helper pages at a phone-sized viewport, typed chat, safe rendering, collapsed debug events and agent switching. WebRTC is mocked (no provider charges); it also checks that ending a pending call cannot be undone by a late SDP response:

```bash
uv run --no-project --with playwright python -m playwright install chromium
uv run --no-project --with playwright python .ai/validation/dashboard-browser-smoke.py
```

Chromium requires its normal OS libraries. The default screenshot is `/tmp/pi-agents-mobile.png`; override with `PI_AGENTS_SCREENSHOT`.
