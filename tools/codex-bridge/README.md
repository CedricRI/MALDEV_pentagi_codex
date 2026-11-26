# PentAGI with a ChatGPT subscription

This fork connects PentAGI's existing custom provider to the official, locally installed Codex CLI app-server. Codex owns authentication and model requests. The bridge requires a ChatGPT login and refuses API-key authentication. It does not read, copy, or export OAuth tokens.

```text
PentAGI agents and Docker tools
        │ local Chat Completions compatibility interface
        ▼
Authenticated Node.js adapter on your computer
        │ JSON-RPC over subprocess stdin/stdout
        ▼
codex app-server → your signed-in ChatGPT account
```

There is still a local HTTP interface for compatibility with PentAGI. Model inference goes through the Codex harness and your subscription rather than a separately billed OpenAI API key. Your account's model availability, subscription limits, and service policies still apply. The bridge does not bypass them.

## Requirements

- Node.js 22 or newer, with no additional npm dependencies.
- Codex CLI installed and signed in using `codex login` with ChatGPT. Tested with `codex-cli 0.171.0-alpha.13`.
- An existing PentAGI deployment. Its backend and frontend do not need rebuilding.

The adapter uses experimental app-server dynamic tools and history injection. A Codex update can change that protocol; run the offline tests and smoke check after updating. See the [official app-server documentation](https://developers.openai.com/codex/app-server).

## Windows host and Ubuntu WSL deployment

Run the bridge in the Windows account that is already signed in to Codex. Run Docker Compose through Ubuntu WSL, where the existing PentAGI deployment lives.

In a Windows PowerShell terminal, from this fork:

```powershell
codex login status
.\tools\codex-bridge\start.ps1 -DockerAccess
```

The launcher keeps the bridge in the foreground and accepts connections from Docker Desktop. The server generates a local authentication token in `.state/codex-bridge/token`; it prints the file path, never the token. `.state` is gitignored. Keep this terminal running while PentAGI uses Codex. Stop with Ctrl+C.

In Ubuntu WSL, validate the combined configuration before activating it:

```bash
bash /mnt/c/Users/ChosenOne/github/MALDEV_pentagi_codex/tools/codex-bridge/pentagi.sh \
  /home/choseone/MALDEV_pentagi config --quiet
```

The helper reads the local token without printing it, uses the deployment's existing `.env`, and adds this fork's Compose override and provider configuration. It does not edit `.env`, replace the image, or create another database. Do not publish the expanded output of `docker compose config`: it includes your existing secrets and the bridge token.

To activate the provider, run the same helper with `up -d pentagi`:

```bash
bash /mnt/c/Users/ChosenOne/github/MALDEV_pentagi_codex/tools/codex-bridge/pentagi.sh \
  /home/choseone/MALDEV_pentagi up -d pentagi
```

This recreates the PentAGI service with the override while retaining the existing Compose project and volumes. Finish or pause active flows before doing this. In PentAGI, select the `custom` provider for a new flow, or create a provider profile named `Codex subscription` using the `custom` type. Existing saved provider profiles can contain their own per-agent model names; use the supplied configuration for Codex instead. The supplied profile inherits `LLM_SERVER_MODEL=codex-default` for every agent, so it follows the signed-in account's default Codex model.

The overlay clears `LLM_FALLBACK_PROVIDER`, disables Graphiti, and disables vector embeddings by default, because Codex does not supply an embeddings endpoint. To retain local Ollama embeddings, set `CODEX_BRIDGE_EMBEDDING_PROVIDER=ollama` and configure the existing `EMBEDDING_*` settings for a running local embedding model before activation. Other optional paid search or third-party tools keep their existing configuration; they are separate from model inference.

To restore the original service configuration:

```bash
cd /home/choseone/MALDEV_pentagi
docker compose up -d pentagi
```

After rollback, select the appropriate original provider profile for subsequent flows.

## Other local deployments

On Linux or macOS, run `node tools/codex-bridge/server.mjs` as the user signed in to Codex. It binds to `127.0.0.1:8765` by default. For Docker, set `CODEX_BRIDGE_HOST=0.0.0.0` and use the Compose override. On Linux, Docker's host-gateway address must reach the host listener. On Windows, prefer the PowerShell launcher with Docker Desktop.

Without Compose, configure PentAGI's custom provider with:

```text
LLM_SERVER_URL=http://127.0.0.1:8765/v1
LLM_SERVER_KEY=<contents of .state/codex-bridge/token>
LLM_SERVER_MODEL=codex-default
LLM_SERVER_API_TYPE=openai
LLM_SERVER_PROVIDER=
LLM_SERVER_CONFIG_PATH=<absolute path to examples/configs/codex-subscription.provider.yml>
LLM_FALLBACK_PROVIDER=
EMBEDDING_PROVIDER=none
GRAPHITI_ENABLED=false
HTTP_CLIENT_TIMEOUT=240
```

For a container, use `host.docker.internal` in the URL and a container-mounted provider configuration path. `LLM_SERVER_KEY` is only the adapter's local access token; it is not an OpenAI API key.

## Verification

Offline tests do not access a model or consume subscription usage:

```bash
cd tools/codex-bridge
node --test test/*.test.mjs
```

With the server running, this smoke check makes three small real requests: an arithmetic tool call, continuation from its external result, and structured JSON output. It does not run a PentAGI flow or execute a target test:

```bash
node tools/codex-bridge/smoke.mjs
```

Check Docker-to-host connectivity without inference:

```bash
docker exec pentagi wget -qO- -T 15 http://host.docker.internal:8765/healthz
```

The included `ctester.yml` is a three-case suite for PentAGI's own `ctester`: text completion, a streaming native function call, and JSON mode. It can be selected with `-tests tools/codex-bridge/ctester.yml -agents simple,simple_json -groups basic,json -workers 1` together with the custom provider environment and configuration above.

### Validation on November 26, 2026

- Offline adapter tests: 17 passed on Windows and in the fork's Ubuntu GitHub Actions job.
- Live ChatGPT Plus smoke checks: native tool call, tool-result continuation, and structured JSON passed using the account's default `gpt-6.2-sol` model.
- PentAGI 2.2.0's own containerized provider tester: 3/3 passed, including streaming function calls.
- Docker-to-host connectivity and the existing WSL deployment's combined Compose configuration passed.
- The unchanged Go `pconfig` tests passed. One unchanged `custom` test failed on French Windows because its assertion requires the English string `connection refused`, while Windows returned its localized equivalent. The adapter does not modify that backend code.

These are provider integration checks, not a complete autonomous assessment. The existing PentAGI service was not switched to the override during validation.

## Supported behavior and limits

- `GET /v1/models` returns the account's startup model catalog plus `codex-default`. Restart the bridge to refresh the catalog after an account or entitlement change.
- `POST /v1/chat/completions` supports text conversations, assistant prefill, native function calls, prior tool results, JSON mode, and JSON Schema output.
- `tool_choice` accepts `auto`, `none`, `required`, or a named function. Required and named choices are enforced by checking the model's response; a text-only response fails instead of silently violating the choice.
- Each completion returns at most one native tool call. PentAGI executes it in its own tool layer. Tool names are internally aliased and restored at the compatibility boundary. The Codex turn is interrupted and its subprocess closed before returning a tool call.
- Each request gets an ephemeral thread and isolated temporary directory. Past messages are replayed as typed history items, preserving roles, call IDs, and tool results. PentAGI remains the source of conversation state. This has more context and startup overhead than a persistent Codex session.
- Codex environments, host shell, patching, agents, configured MCP servers, plugins, hooks, and automatic skill instructions are disabled for these threads. The adapter rejects unexpected server requests. PentAGI's Docker tools remain separate.
- Streaming uses valid SSE, keepalives, function deltas, finish reasons, optional usage, and `[DONE]`. Final answer text is buffered until the turn finishes, so commentary and partial JSON are not exposed as assistant output.
- Usage is reported only when app-server provides it. A tool handoff may finish before token usage arrives. No synthetic token counts or per-token charges are invented; zero prices in the sample profile indicate that this route has no separately metered API bill, not that subscription usage is unlimited.
- Codex controls sampling and output limits. `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `seed`, frequency/presence penalties, and `parallel_tool_calls` are accepted for PentAGI compatibility but not enforced. Their names are disclosed in the `X-Codex-Ignored-Parameters` response header. Hard output-token limits, stop sequences, multiple choices, multimodal messages, logprobs, embeddings, and the Responses HTTP endpoint are not supported.
- The default is one active inference request, with a bounded queue of 24. Client disconnects and timeouts cancel the request and terminate its subprocess. Exhausted subscription quota is surfaced as an error; there is no API-key fallback.

## Server settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BIN` | `codex` from PATH | Codex executable, without shell arguments |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | Listener address; use `0.0.0.0` for Docker access |
| `CODEX_BRIDGE_PORT` | `8765` | Listener port |
| `CODEX_BRIDGE_KEY` | Generated token file | Local bearer token; at least 24 characters |
| `CODEX_BRIDGE_TOKEN_FILE` | `.state/codex-bridge/token` | Alternate local token file |
| `CODEX_BRIDGE_TIMEOUT_MS` | `180000` | Total inference deadline, including queue time |
| `CODEX_BRIDGE_CONCURRENCY` | `1` | Maximum simultaneous inference subprocesses |
| `CODEX_BRIDGE_MODEL` | `codex-default` | Compose provider model; use an ID from `/v1/models` |
| `CODEX_BRIDGE_HTTP_TIMEOUT` | `240` | PentAGI HTTP timeout in seconds |
| `CODEX_BRIDGE_EMBEDDING_PROVIDER` | `none` | Compose embeddings provider; choose `ollama` for local vector memory |
| `CODEX_BRIDGE_PROVIDER_CONFIG` | Fork example path | Compose mount source for the provider YAML |

The health endpoint exposes only readiness and the selected model. All model endpoints require the local token, and browser-origin requests are rejected. Do not expose the listener publicly.
