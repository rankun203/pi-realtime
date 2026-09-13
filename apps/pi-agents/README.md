# Pi Agents

Private, chat-first dashboard for Pi instances running pi-realtime on **one server / one OS account**. Uses Node's built-in HTTP server, no frontend framework or separate database.

## Run locally

From this repository:

```bash
corepack pnpm dashboard
```

Open `http://127.0.0.1:8877`. `PI_AGENTS_PORT` changes the port; the listener always stays on IPv4 loopback. Use the same port on both sides of a laptop SSH tunnel.

After updating the extension, `/reload` once in each Pi and run `/realtime` (or `/realtime start` to attach browser audio to an existing session). Helpers register private metadata under `~/.pi/agent/pi-realtime/helpers/`. The dashboard verifies each live helper before listing/proxying it. `PI_CODING_AGENT_DIR` must match between Pi and the dashboard when customized. Stale/dead registrations are ignored. Selecting an agent does not start a provider connection or request the microphone.

- Select an agent/project from the top picker. Each session keeps its own chat context.
- Type messages without granting microphone access. They are sent as ordinary Pi user messages, queued as follow-ups when busy.
- Start/end a voice call inside the chat. Switching releases the previous page's microphone and peer connection; active calls prompt before switching.
- Pi's recorded user/assistant text and voice replies appear in chat. Tool output, hidden reasoning and system context are excluded. Debug events are collapsed by default.
- Pi messages refresh when recorded, not token-by-token. Voice transcript history is bounded and in memory; Pi messages follow the current branch. Native voice mode does not manufacture transcripts for user audio: optional transcription must be configured if you want those words displayed.
- Voice costs are local estimates, independent of Pi coding costs. Mini uses verified Azure Global Standard USD list rates; check your deployment tier and invoice.

This first version lists **helper-enabled sessions**, not every arbitrary Pi process. Start it in each Pi you want available. It does not launch agents remotely, migrate histories, or coordinate simultaneous callers on different devices. Use one voice browser per session.

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
