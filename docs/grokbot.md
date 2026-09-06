# Grok Bot (`grokbot` / `grokbot-sand`)

`grokbot` is a sand InferenceService provider. It is **not** Cursor AgentService (`cursor`) and **not** the public xAI API (`xai` / `xai-oauth`). Every grokbot catalog row uses wire API `grokbot-sand` against `https://api2.cursor.sh` (`POST /aiserver.v1.InferenceService/Stream`).

Published npm/global `omp` **18.0.1 does not include this provider**. Run from this checkout (or a later release that ships `grokbot`).

## Auth (no secret values)

Host secrets already live at `~/.omp/agent/secrets/grokbot.env` (profile / `PI_CODING_AGENT_DIR` aware). Required keys:

- `GROKBOT_RENEWAL_CREDENTIAL` (alias: `SAND_INFERENCE_RENEWAL_CREDENTIAL`)
- `GROKBOT_MACHINE_ID`

Optional: `GROKBOT_NAMESPACE` (`prod` / `dev` / `lab`), `GROKBOT_CLIENT_VERSION`, `GROKBOT_ANTHROPIC_TOOLS_WIRE`.

Process env beats the secrets file. Never print these values. `/login grokbot` only shows the host-install prompt; `/grokbot` reports status without secrets.

If `-p` exits with `No API key found for grokbot`, this checkout did not see a renewer (missing `secrets/grokbot.env` or env vars). Published global `omp` 18.0.1 will also fail here because it does not register the provider at all.

## Run from this checkout

```sh
# One-shot from the repo (after bun install + native host build)
bun --cwd=packages/coding-agent src/cli.ts -p --no-session --model grokbot/sand-default "…"

# Same after `bun run setup` (links ~/.bun/bin/omp to this tree)
omp -p --no-session --model grokbot/sand-default "…"

# List grokbot rows (offline seeds always; live catalog when renewer + machine id resolve)
omp models grokbot
```

`--model grokbot/<id>` is the supported selector. `--provider grokbot --model <id>` still works.

Offline seeds always present: `sand-default` (default router), `sand-cua`, `sand-automation`, `default`, `auto`, `grok-4.6`. Live AvailableModels adds the rest when credentials resolve.

## (a) Text-only echo

`--no-tools` keeps field-2 tools off the wire (required for a clean text probe; leaking tools can HTTP 400).

```sh
omp -p --no-session --no-tools --no-extensions --no-skills --no-rules \
  --model grokbot/sand-default \
  "Reply with exactly: pong42"

# Concrete family (not the sand router)
omp -p --no-session --no-tools --no-extensions --no-skills --no-rules \
  --model grokbot/grok-4.6 \
  "Reply with exactly: pong42"
```

From this tree without a linked `omp` binary:

```sh
bun --cwd=packages/coding-agent src/cli.ts -p --no-session --no-tools \
  --no-extensions --no-skills --no-rules \
  --model grokbot/sand-default \
  "Reply with exactly: pong42"
```

Expect the printed assistant text to contain `pong42`.

## (b) Simple tools round-trip

Tools work on non-Anthropic sand models (`grok-4.6`, `composer-2.5`, GPT/Sol, Gemini, Kimi, GLM, …). `--auto-approve` is required in `-p` mode or the turn stops on the approval prompt.

```sh
omp -p --no-session --auto-approve --no-extensions --no-skills --no-rules \
  --model grokbot/grok-4.6 \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."
```

From this tree:

```sh
bun --cwd=packages/coding-agent src/cli.ts -p --no-session --auto-approve \
  --no-extensions --no-skills --no-rules \
  --model grokbot/grok-4.6 \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."
```

Expect a `bash` tool call whose stdout is `tools-pong42`, then a final assistant reply that mentions it.

## Mitmproxy (audit box)

Grokbot mint + stream go through omp's provider `transportFetch`, so the same proxy/CA pattern as host-main applies:

```sh
export HTTPS_PROXY=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080
export NODE_EXTRA_CA_CERTS=/path/to/mitmproxy-ca-cert.pem   # already-trusted CA; do not invent a path
```

Optional provider-scoped override: `PI_PROXY_GROKBOT=http://127.0.0.1:8080` (still set `NODE_EXTRA_CA_CERTS`). Do not log request bodies that contain `Authorization` or renewal material.

Wire to capture: `POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream` (Connect+proto). Renewal is `POST /sand-box/inference-credential`. Discovery is `POST /aiserver.v1.AiService/AvailableModels`.

## Known ceilings vs sand

| Case | What happens |
| --- | --- |
| `grok-4.5` + any tools | Upstream HTTP 422. Catalog `supports-tools: false`. Text-only works. |
| Explicit Anthropic id + raw omp field-2 tools | Upstream HTTP 400 / `ERROR_PROVIDER_ERROR`. |
| Anthropic + tools (default) | `GROKBOT_ANTHROPIC_TOOLS_WIRE=auto` → **keep-model**: product PascalCase tools (Shell/Read/Write) on the original Anthropic `requestedModel`. Backend stays Claude/Fable family. |
| `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` | Rewrites to `sand-automation` + `generalPurpose`. Often routes to `cursor-grok-*`, **not** a verified Anthropic worker. |
| `sand-default` / `sand-cua` / `sand-automation` + tools | Routers; with tools they typically land on the **grok** family. |
| AgentService/Run on a grokbot sand JWT | Not supported (zero mitm hits). InferenceService/Stream only. |

Anthropic+tools keep-model example (optional; not the default tools probe):

```sh
omp -p --no-session --auto-approve --no-extensions --no-skills --no-rules \
  --model grokbot/claude-opus-5:max \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."
```

## Related

- Gate matrix / research scripts: [`GATES.md`](../GATES.md), `scripts/grokbot-matrix.mjs`
- Provider tables: [Providers](./providers.md), [Environment variables](./environment-variables.md)
- In-session: `/grokbot`, `/login grokbot`
