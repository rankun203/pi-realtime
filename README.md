# pi-realtime — configurable OpenAI & Azure voice

Talk to [Pi](https://pi.dev/) while you code: speak requests, let Pi work on your project, and hear acknowledgements, progress updates, and replies.

This is a community fork of **[transcendr/pi-realtime](https://github.com/transcendr/pi-realtime)**, based on upstream **v0.2.0**. It adds automatic global configuration and Azure OpenAI GA endpoint support without changing Pi's coding provider. It is not the upstream npm release or an official OpenAI/Microsoft integration.

> Preview software. Azure token creation and WebSocket session configuration have been tested with `gpt-realtime-2.1-mini`. Browser microphone, speaker, interruption, and end-to-end voice behavior still require live validation. The larger 2.1 model has not been live-tested in this fork.

## What this fork changes

- **Automatic global settings:** reads the `pi-realtime.openai` section of Pi's `settings.json`.
- **Separate realtime credentials in Pi's existing `auth.json`:** uses `pi-realtime:openai`, leaving `openai` and other coding credentials untouched.
- **Configurable endpoint and authentication:** preserves OpenAI defaults; supports Azure `/openai/v1` endpoints and `api-key` auth for both HTTP and WebSocket connections.
- **Configurable browser destination:** the WebRTC helper receives the calls URL associated with its ephemeral token, rather than always calling OpenAI's public endpoint. The resource API key stays server-side.
- **Additional model profiles:** `gpt-realtime-2.1-mini` and `gpt-realtime-2.1`, plus support for a custom deployment name configured as the default model.
- **Installed-package asset fix:** browser HTML/JavaScript resolve relative to the extension, not the project you happen to launch Pi from.
- **Regression tests and an opt-in live connectivity check.**

The original eco/agent interaction modes, transcript routing, spoken updates, and assessment of usage remain upstream features. This fork does not invent prices for the new 2.1 models.

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

| Variable | Setting | Default |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `baseUrl` | `https://api.openai.com/v1` |
| `OPENAI_AUTH_MODE` | `authMode` | `api-key` for Azure hosts, otherwise `bearer` |
| `OPENAI_REALTIME_MODEL` | `model` | `gpt-realtime-mini` |
| `OPENAI_API_KEY` | credential | No default |

For this extension, precedence is **shell environment → project `.env` → global files → defaults**. This is extension-specific; it is not Pi's core credential precedence. Project `.env` loading remains supported for compatibility, but global files are recommended when working across projects.

Generic exported `OPENAI_*` variables can affect other programs launched from your shell. Prefer the namespaced global files when isolation matters.

Configuration files are read for new connections. Stop and restart the voice session after changing credentials or endpoints. Model selection follows: explicit `--model` → persisted `/realtime openai model ...` preference → configured model/default.

## Start talking

Inside Pi:

```text
/realtime webrtc on
/realtime start --provider openai --mode eco
```

The browser opens a **WebRTC helper** page and asks for microphone permission. The browser can apply echo cancellation, noise suppression, and automatic gain control; use headphones if your browser/device does not provide reliable echo cancellation.

**Eco mode** is the recommended starting point: speech is transcribed and routed to Pi; the realtime model speaks Pi's updates. **Agent mode** lets the voice model decide when to request work from Pi:

```text
/realtime start --provider openai --mode agent
```

Pi's coding model/provider is selected independently with Pi's normal model controls.

### Useful commands

```text
/realtime status
/realtime openai model
/realtime openai model gpt-realtime-2.1-mini
/realtime openai model gpt-realtime-2.1
/realtime start --provider openai --mode eco --model YOUR-DEPLOYMENT
/realtime usage --details
/realtime stop
```

The built-in speech profiles cover `gpt-realtime-mini`, `gpt-realtime-2`, `gpt-realtime-2.1-mini`, and `gpt-realtime-2.1`. A custom deployment configured in settings is also accepted by model selection, but an unknown name uses the default behavior profile rather than assuming which model it represents.

The 2.1 models' tokens are tracked, but dollar estimates may be unavailable because their prices have not been added to the pricing table.

## Development

Use nvm, Corepack, and the pinned pnpm version:

```bash
git clone --branch azure-global-config https://github.com/rankun203/pi-realtime.git
cd pi-realtime
nvm install 22
nvm use 22
corepack enable
pnpm install --frozen-lockfile
pnpm run gates:typecheck
pnpm test
pnpm run gates:deslop
pi install .
```

The repository retains upstream history, changelog, and validation probes. New tests cover precedence, credential isolation, URL/auth validation, HTTP headers, ephemeral-token routing, WebSocket auth options, model profiles, and browser asset resolution.

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
