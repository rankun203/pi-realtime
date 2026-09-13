# pi-realtime — configurable OpenAI & Azure voice

Talk to [Pi](https://pi.dev/) while you code: speak requests, let Pi work on your project, and hear acknowledgements, progress updates, and replies.

This is a community fork of **[transcendr/pi-realtime](https://github.com/transcendr/pi-realtime)**, based on upstream **v0.2.0**. It adds automatic global configuration and Azure OpenAI GA endpoint support without changing Pi's coding provider. It is not the upstream npm release or an official OpenAI/Microsoft integration.

> Preview software. The browser companion has been tested through Chromium's real WebRTC stack and Azure `gpt-realtime-2.1-mini`: synthetic speech triggered `post_message`, the real Pi SDK (with a synthetic coding model) completed work, and the voice model spoke the observed result. A second device took over and recalled the result after context restoration; provider hangup was verified. Physical microphone/speaker, Cloudflare deployment, and the larger 2.1 model remain unvalidated.

## What this fork changes

- **One-command voice chat:** `/realtime` starts agent mode and browser audio when idle; when a session is running, it shows status and options without reconnecting it.
- **Automatic global settings:** reads the `pi-realtime.openai` section of Pi's `settings.json`.
- **Separate realtime credentials in Pi's existing `auth.json`:** uses `pi-realtime:openai`, leaving `openai` and other coding credentials untouched.
- **Configurable endpoint and authentication:** preserves OpenAI defaults; supports Azure `/openai/v1` endpoints and `api-key` auth for both HTTP and WebSocket connections.
- **Server-owned browser voice companion:** one logical companion per Pi session, private voice handover, automatic observation of Pi output, bounded read-only history tools, and `post_message` for queued communication. Devices explicitly take over; disconnect/restart leaves Pi working.
- **Server-owned provider negotiation:** the helper negotiates WebRTC and controls that same provider session through a sideband connection. Companion-mode browsers receive SDP and a device lease, not provider credentials. Legacy eco keeps its ephemeral-token path.
- **Additional model profiles:** `gpt-realtime-2.1-mini` and `gpt-realtime-2.1`, plus support for a custom deployment name configured as the default model.
- **Installed-package asset fix:** browser HTML/JavaScript resolve relative to the extension, not the project you happen to launch Pi from.
- **Native-audio agent turns:** the realtime model responds through native turn detection and calls Pi tools, without waiting for a separate transcription service. Optional transcripts never trigger duplicate responses.
- **Visible transcription errors:** failures such as `DeploymentNotFound` are shown in the browser and Pi rather than silently stalling eco mode.
- **Server/phone deployment:** a configurable loopback port, mobile audio controls, and an authenticated HTTPS reverse-proxy example.
- **Regression tests and an opt-in live connectivity check.**

Legacy raw/eco modes retain their upstream routing and speech-rendering behavior. Browser agent mode uses the new companion architecture, described in the [design and validation plan](apps/pi-agents/VOICE-PLAN.md). Cost estimates use verified list rates where available; unpriced models remain explicitly unknown.

## Requirements

- Pi (upstream targets `^0.74.0`; this fork has also been load-tested with the installed newer Pi).
- Node.js 22+ for development and validation.
- An OpenAI API key or an Azure OpenAI resource key and an available realtime deployment.
- A browser with microphone permission for the recommended WebRTC path.
- `ffmpeg` and `ffplay` only for optional raw-audio troubleshooting.

## Install this fork

Remove the upstream package first if it is already installed, to avoid duplicate commands/tools:

```bash
pi remove npm:pi-realtime
pi install git:github.com/rankun203/pi-realtime@azure-global-config
```

Only run the removal command if you have that package installed. If you previously installed a local copy, remove its registered path before adding the GitHub package. Then restart Pi or run `/reload`.

Installing `npm:pi-realtime` installs the **upstream release**, not these changes. Pi's git package installer handles runtime dependencies automatically.

## Global configuration

Merge the examples below into your existing files. **Do not overwrite other settings or credentials.**

Paths default to `~/.pi/agent/`. If you set `PI_CODING_AGENT_DIR`, the extension reads `settings.json` and `auth.json` from that directory instead.

### Azure OpenAI

In **`~/.pi/agent/settings.json`**:

```json
{
	"pi-realtime": {
		"openai": {
			"baseUrl": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
			"authMode": "api-key",
			"model": "gpt-realtime-2.1-mini"
		}
	}
}
```

In **`~/.pi/agent/auth.json`**:

```json
{
	"pi-realtime:openai": {
		"type": "api_key",
		"key": "YOUR-AZURE-RESOURCE-KEY"
	}
}
```

`model` must be your **Azure deployment name**, which may differ from the underlying model name. Use the resource's HTTPS API root ending in `/openai/v1`; do not append `/realtime`, a legacy preview route, or an `api-version` query parameter.

The provider command stays `--provider openai`: it identifies the compatible realtime protocol, not a hardcoded host. Azure's `.openai.azure.com` hostname automatically selects `api-key` authentication. Set `authMode` explicitly for custom domains or proxies.

### OpenAI

Use the same credential entry with your OpenAI key:

```json
{
	"pi-realtime:openai": {
		"type": "api_key",
		"key": "YOUR-OPENAI-API-KEY"
	}
}
```

No realtime settings section is necessary for OpenAI defaults. If switching back from Azure, update or remove the Azure settings:

```json
{
	"pi-realtime": {
		"openai": {
			"baseUrl": "https://api.openai.com/v1",
			"authMode": "bearer",
			"model": "gpt-realtime-mini"
		}
	}
}
```

### Credential safety

```bash
chmod 600 ~/.pi/agent/auth.json ~/.pi/agent/settings.json
```

- Keep the key in `auth.json`, not `settings.json`, Git, screenshots, or issue reports.
- This extension currently reads **literal API keys** from its namespaced auth entry. Pi's command-based/interpolated credential features and OAuth are not implemented for this entry.
- Credentials are stored as plaintext with filesystem permissions, not in an encrypted vault.
- File-based values are not exported into `process.env`, so other Pi providers do not inherit this extension's configuration.
- The browser gets an ephemeral token, not the resource key. Debug traces may contain conversation text: inspect and redact them before sharing.
- The local WebRTC helper is for a trusted workstation. Do not expose its HTTP port publicly.

### Optional environment overrides

Existing environment-variable workflows remain supported:

| Variable                              | Setting              | Default                                                 |
| ------------------------------------- | -------------------- | ------------------------------------------------------- |
| `OPENAI_BASE_URL`                     | `baseUrl`            | `https://api.openai.com/v1`                             |
| `OPENAI_AUTH_MODE`                    | `authMode`           | `api-key` for Azure hosts, otherwise `bearer`           |
| `OPENAI_REALTIME_MODEL`               | `model`              | `gpt-realtime-mini`                                     |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | `transcriptionModel` | Off in agent mode; `gpt-4o-mini-transcribe` in eco mode |
| `OPENAI_API_KEY`                      | credential           | No default                                              |

For this extension, precedence is **shell environment → project `.env` → global files → defaults**. This is extension-specific; it is not Pi's core credential precedence. Project `.env` loading remains supported for compatibility, but global files are recommended when working across projects.

Generic exported `OPENAI_*` variables can affect other programs launched from your shell. Prefer the namespaced global files when isolation matters.

Configuration files are read for new connections. Stop and restart the voice session after changing credentials or endpoints. Model selection follows: explicit `--model` → persisted `/realtime openai model ...` preference → configured model/default.

## Agent mode versus eco mode

**Agent mode** sends audio directly to the realtime model. Native voice activity detection triggers the model's response, and the model decides when to call Pi's `request` tool. Auxiliary transcription is off by default; it is not required for the model to understand you or call tools. Native turns can also react to background speech/noise, so use appropriate microphone settings and headphones.

**Eco mode** sends completed transcripts to Pi instead of asking the realtime model to call tools. It requires a working separate transcription model. On the Azure resource used to validate this fork, `gpt-4o-mini-transcribe` failed with `DeploymentNotFound`, while `whisper-1` successfully transcribed the same sample. This is a resource-specific observation, not a claim that the model is unavailable everywhere.

To select a transcription model for eco mode, or enable optional transcripts in agent mode, add this field inside `pi-realtime.openai` in global settings:

```json
"transcriptionModel": "whisper-1"
```

Omit it to use mode defaults. `"off"` explicitly disables auxiliary transcription for agent mode; it is rejected for eco mode. Agent mode still responds natively when optional transcription fails, and transcript completion never creates a second response. Keep `model` set to your **realtime deployment**—the transcription model is a separate setting.

## Start talking

After configuring your credentials once, the normal startup is just:

```text
/realtime
```

When a session is already active, starting, or stopping, `/realtime` instead shows status, browser-helper status, and available commands without changing the session. `/realtime start` explicitly starts or resumes browser voice. `/realtime chat` remains an alias for that explicit action; you do not need it. `/realtime status` always gives a read-only overview, even when idle.

It uses your configured model for a new session, selects **agent mode**, starts the browser helper, and prints its URL. Repeating `/realtime` shows status and options instead of creating another session or interrupting connected audio. Use `/realtime start` to attach the helper to an existing raw agent session or resume browser voice. Other sessions are left running; stop them explicitly if you no longer need them. To change an existing chat's model, stop it, change the model setting, then run `/realtime` again.

The extension footer shows `pi-realtime: idle` or the active-session count, plus separate voice token usage and an estimated cost once usage arrives. Unknown model/deployment prices show **cost unknown**, not zero; mixed priced/unpriced usage is labelled partial. These are local estimates, not Azure/OpenAI invoices. `/realtime usage --details` shows the breakdown; `/realtime usage reset` resets the extension's counters without deleting history.

Pi's main `$… (sub)` figure is separate: it totals coding-session usage, including cached tokens and compaction. The subscription marker does not make it an invoice or an additional charge. Realtime usage is stored as extension events and is not added to that total; coding work requested through voice still counts as normal Pi work.

Stopped sessions are kept as history, not running threads; view them with `/realtime status` instead of a persistent session-list widget.

Stop with `/realtime stop`: this shuts down all realtime sessions and shared media/helper components, removes discovery registration, and clears the realtime footer/widget. Saved history and usage remain available on demand; they do not keep an idle status bar entry visible. Use `/realtime stop --session <id>` to stop only one session while leaving others running. `/reload` is only needed after installing/updating extension code—not each time you chat. On a server, your SSH tunnel or HTTPS proxy is a separate one-time networking setup; open the printed session path through that connection.

For advanced startup, both `/realtime start --provider openai` and `/realtime openai start` honor the WebRTC preference. `/realtime webrtc on` sets the preference for future starts; to attach the browser helper to an already-active session, run `/realtime openai webrtc start`.

The browser opens a **WebRTC helper** chat page branded **Pi Agents**. It shows recorded Pi messages and voice replies, with technical events hidden under **Debug events**. You can type to Pi without microphone access. Tap **Start call** to enable voice; **End call** releases the microphone while keeping chat open. The browser can apply echo cancellation, noise suppression, and automatic gain control; use headphones if your browser/device does not provide reliable echo cancellation.

Native agent audio does not automatically create a transcript of your spoken words. Assistant speech appears as text; user speech transcripts appear only when optional transcription is configured. Pi text messages refresh as they are recorded, not token-by-token. Voice transcripts are bounded, in-memory helper history; Pi messages follow the current session branch.

Use agent mode when you want the realtime model to hear you and decide when to involve Pi. If you prefer direct transcript routing and have a working transcription model, select eco mode explicitly:

```text
/realtime start --provider openai --mode eco
```

Pi's coding model/provider is selected independently with Pi's normal model controls.

### Useful commands

```text
/realtime
/realtime status
/realtime openai model
/realtime openai model gpt-realtime-2.1-mini
/realtime openai model gpt-realtime-2.1
/realtime start --provider openai --mode eco --model YOUR-DEPLOYMENT
/realtime usage --details
/realtime stop
```

The built-in speech profiles cover `gpt-realtime-mini`, `gpt-realtime-2`, `gpt-realtime-2.1-mini`, and `gpt-realtime-2.1`. A custom deployment configured in settings is also accepted by model selection, but an unknown name uses the default behavior profile rather than assuming which model it represents.

`gpt-realtime-2.1-mini` now has verified Azure **Global Standard USD list estimates**, including historical observations previously marked unpriced. Per million tokens: text input/cached/output **$0.60/$0.06/$2.40**; audio **$10/$0.30/$20**; image input/cached **$0.80/$0.08**. [Azure meter evidence](.ai/validation/azure-mini-pricing.json). Data Zone, negotiated rates and actual invoices may differ. Other unknown models/custom deployment names remain explicitly unpriced rather than guessed.

## Pi Agents dashboard

For a single bookmarked site with a project/session picker, chat messages and voice calls, run `corepack pnpm dashboard`. See [Pi Agents setup and Cloudflare Access guide](apps/pi-agents/README.md). The dashboard discovers helper-enabled Pi sessions on this server and proxies them through one **loopback-only** port, `8877`. No public deployment is created automatically.

## Server and phone access over HTTPS

You can run **Pi and the realtime bridge entirely on a server** and use your phone as the microphone/speaker. An SSH tunnel is convenient for a laptop; a phone can instead open an authenticated HTTPS URL.

```text
Phone browser -- HTTPS --> authenticated reverse proxy -- loopback HTTP --> Pi helper
Phone browser -- WebRTC audio --> OpenAI / Azure
```

The browser fetches helper routes on the same origin using relative paths, so no public-base-URL setting is required. Keep the complete `/pi-realtime/...` paths intact. The proxy carries the UI, token requests, events, and polling; audio travels directly between the phone and the provider.

### 1. Give the helper a fixed local port

Merge a `web` section into `~/.pi/agent/settings.json`, alongside `openai`:

```json
{
	"pi-realtime": {
		"web": { "port": 8787 }
	}
}
```

`PI_REALTIME_WEB_PORT` can override this setting (shell or project `.env`). The default `0` selects a random available port. The helper **always binds to `127.0.0.1`**, even when a fixed port is configured. Restart the helper after changing the port; use different ports for multiple Pi processes.

### 2. Put authenticated HTTPS in front of it

The helper itself has no public authentication layer. **Never forward it to the public Internet without authentication.** Its endpoints can expose conversation context, issue ephemeral provider credentials, and inject requests into Pi. A session URL is not an adequate access-control boundary.

An example is provided in [`examples/Caddyfile`](examples/Caddyfile). On a server with Caddy installed:

1. Point a hostname such as `voice.example.com` at your server.
2. Generate a dedicated login password hash with `caddy hash-password` (interactive; avoid putting the password in shell history).
3. Replace the example hostname, username, and password-hash placeholder in the Caddyfile. This is a **web login password**, not the Azure/OpenAI API key.
4. Configure Caddy with that file and validate it using `caddy validate --config /path/to/Caddyfile --adapter caddyfile` before reloading it. Caddy automatically obtains and renews HTTPS certificates for a reachable hostname.
5. Allow inbound HTTPS and the certificate validation traffic Caddy needs (normally TCP 443 and 80). **Do not open port 8787 publicly.**

Protect **all routes**, not just the HTML page: `/config`, `/client-secret`, `/event`, `/outbox`, and the browser script must remain behind authentication. The helper also rejects cross-origin browser requests to session APIs; the reverse proxy must preserve the public `Host` header, as Caddy does by default. This check is CSRF protection, not a replacement for proxy authentication. Restrict access to people you trust to operate your Pi agent. An identity-aware proxy can replace Caddy's basic authentication if it protects the same routes. Use a dedicated hostname; serving beneath an extra URL prefix is not supported by the browser's root-relative paths.

### 3. Open the session on your phone

In Pi:

```text
/realtime
```

Use the session URL shown by Pi, replacing only `http://127.0.0.1:8787` with your public HTTPS origin:

```text
https://voice.example.com/pi-realtime/openai/SESSION_ID
```

Log in at the proxy, grant microphone permission, and keep the page in the foreground. Use Safari or Chrome directly rather than an embedded app browser. Mobile browsers may block automatic playback: tap **Play** in the audio controls. The page logs a warning when autoplay is blocked. Locking the phone or backgrounding the browser can suspend audio/networking. Your phone also needs direct network access to the provider's WebRTC service.

When the Pi voice session changes, open its new session URL. The fixed server port and proxy configuration can stay the same. This repository supplies deployment support and examples; it does not automatically publish your server or provision DNS/TLS/access-control credentials.

## Development

Use nvm, Corepack, and the pinned pnpm version:

```bash
git clone --branch azure-global-config https://github.com/rankun203/pi-realtime.git
cd pi-realtime
nvm install 22
nvm use 22
corepack enable
pnpm install --frozen-lockfile
pnpm format:check
pnpm run gates:typecheck
pnpm test
pnpm run gates:deslop
pi install .
```

The repository retains upstream history, changelog, and validation probes. New tests cover precedence, credential isolation, URL/auth validation, HTTP headers, ephemeral-token routing, WebSocket auth options, model profiles, and browser asset resolution.

`pnpm format` (or `npm run format`) applies the locally installed Prettier; `pnpm format:check` checks formatting without changing files. Commit functional changes before a project-wide formatting pass.

`pnpm test` runs the fork's deterministic tests. The broader upstream `gates:validation` command is retained, but one probe references a design document absent from the upstream v0.2.0 Git tree (`.ai/docs/realtime-voice/pi-to-realtime-context-and-tool-response-policy-goal-plan.md`). The other upstream probes can be run individually with Node.

The upstream `gates:quality` command additionally requires **sentrux** and the author's `pi-extension-dev` tooling. These gates are retained, not silently weakened; a clean checkout cannot complete them without the missing prerequisites. `scans:deslop` is an advisory scan. Passing deterministic checks is not proof of live microphone/audio behavior.

### Opt-in Azure connectivity smoke test

After configuring your global files:

```bash
pnpm exec tsx .ai/validation/live-azure-smoke.ts
```

This contacts the configured provider, creates an ephemeral token, opens a short-lived WebSocket session, and validates a session update. It sends no microphone audio and requests no generated response. It uses your configured model and may incur provider charges. It prints only a small status summary, never the key or ephemeral token.

This does **not** test browser SDP negotiation, audio capture/playback, interruption, or a complete voice conversation.

## Attribution and licensing

Original extension: [transcendr/pi-realtime](https://github.com/transcendr/pi-realtime), distributed as [`pi-realtime`](https://www.npmjs.com/package/pi-realtime). This fork's changes are maintained by [rankun203](https://github.com/rankun203).

The upstream v0.2.0 source and npm package did not include a declared license. This GitHub fork preserves attribution and does **not** assert a new license over upstream code. Public availability is not a general redistribution/license grant; clarify licensing with the upstream author before redistributing outside GitHub or incorporating it into another product.
