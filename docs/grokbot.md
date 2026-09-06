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

## Catalog (live AvailableModels)

Do not rely on the six offline seeds (`sand-default`, `sand-cua`, `sand-automation`, `default`, `auto`, `grok-4.6`). With a valid renewer + machine id, discovery refreshes `POST /aiserver.v1.AiService/AvailableModels` and unions the sand routers.

```sh
omp models grokbot
omp models grokbot --json
omp models refresh grokbot
```

Treat that live list as the matrix. Recent fetches are ~200–270 ids after router union (Claude, OpenAI/GPT, Gemini, Grok, Composer/Kimi/GLM, sand routers).

## How tools work per family

omp tools are named `bash` / `read` / `write` (and `edit` / `grep` / `glob`). Sand does not accept the same field-2 shape for every family.

| Family (catalog class) | Default wire (`GROKBOT_ANTHROPIC_TOOLS_WIRE=auto`) | Advertised tools | `requestedModel` |
| --- | --- | --- | --- |
| Anthropic (`claude-*`, fable/opus/sonnet/haiku) | **keep-model** | Product PascalCase `Shell` / `Read` / `Write` with `{ jsonSchema: … }` | Original Anthropic id (backend stays Claude/Fable) |
| Grok / GPT / Gemini / Kimi / GLM / Composer | **native** (matrix `wire`, not `error`) | omp `bash` / `read` / `write` | Original id |
| `sand-default`, `sand-cua`, `default`, `default[]`, `auto` | catalog `sand-tools-wire=parent-chat` | Product tools + `SendToUser` | Router id (often routes to grok; native tools on `default` hit grok-4.5 HTTP 422) |
| `sand-automation` | catalog `sand-tools-wire=automation` | Product `Shell` / `Read` / `Write` | `sand-automation` (often routes to grok) |
| `grok-4.5*` | **disabled** | none | Text-only. Any tools payload is upstream HTTP 422; catalog `supports-tools: false` |

Identity comes from `classifyModel()` (taxonomy class), not `id.includes("claude")`. Router product wire comes from KDL `sand-tools-wire`, not TypeScript id tables.

`edit` shares the product `Write` slot with `write` (write wins). Stream decode maps `Shell`/`Read`/`Write` back to omp `bash`/`read`/`write` without storing those aliases on `customWireName`.

### Env knobs

| Variable | Values | Effect |
| --- | --- | --- |
| `GROKBOT_ANTHROPIC_TOOLS_WIRE` | `auto` (default) | Anthropic+tools → keep-model; routers follow catalog `sand-tools-wire`; everyone else native |
| | `keep-model` / `keep-id` / `keep` | Product tools on the original Anthropic `requestedModel` |
| | `automation` / `product` | Rewrite Anthropic ids to `sand-automation` + `generalPurpose` (often `cursor-grok-*`, **not** a verified Anthropic worker) |
| | `parent-chat` / `parent` | Product parent-chat tools; Anthropic ids rewrite to `sand-default` |
| | `sand-default-fallback` | Keep raw tools; rewrite Anthropic `requestedModel` to `sand-default` (model not guaranteed) |
| | `native` | Raw omp `bash` / `read` / `write` (default for grok/gpt/gemini/…) |
| | `error` | No rewrite. Explicit Anthropic id + raw omp field-2 tools → HTTP 400 |

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

Expect the printed assistant text to contain `pong42`.

## (b) Tools round-trip (bash / read / write)

`--auto-approve` is required in `-p` mode or the turn stops on the approval prompt.

```sh
# Native wire (grok / gpt / gemini / composer / kimi / glm)
omp -p --no-session --auto-approve --no-extensions --no-skills --no-rules \
  --model grokbot/grok-4.6 \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."

# Anthropic keep-model (default auto). omp still says bash; the wire sends Shell.
omp -p --no-session --auto-approve --no-extensions --no-skills --no-rules \
  --model grokbot/claude-opus-5 \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."

# Sand routers (product parent-chat / automation; often land on grok)
omp -p --no-session --auto-approve --no-extensions --no-skills --no-rules \
  --model grokbot/sand-default \
  "Use the bash tool to run: echo tools-pong42. Then reply with the exact stdout."
```

Expect a `bash` (or wire `Shell`) tool call whose stdout is `tools-pong42`, then a final assistant reply that mentions it.

## Full live-catalog matrix

The ship-bar harness loads **live** AvailableModels ids (not hardcoded seeds) and records PASS/FAIL with HTTP status / error class / routed upstream model.

```sh
# Every live id: text smoke + bash/read/write round-trips (502/504 retried)
bun scripts/grokbot-catalog-matrix.ts --slice all --mode all --json /tmp/grokbot-matrix.json

# Previously-failed ids
bun scripts/grokbot-catalog-matrix.ts --ids default,default[],gemini-3-flash,gemini-3-flash[],gpt-5-mini,gpt-5.2-fast --mode all

# Representative slice (Anthropic keep-model, grok-4.6, gemini, gpt-sol/luna/terra, composer, kimi, glm, sand routers)
bun scripts/grokbot-catalog-matrix.ts --slice representative --mode all

# Also drive omp -p on the selected slice
bun scripts/grokbot-catalog-matrix.ts --slice representative --omp

# CI / cloud VM without secrets
bun scripts/grokbot-catalog-matrix.ts --allow-missing-creds

# Re-probe catalog-gated grok-4.5 tools (records 422 evidence; prefer fix if it ever succeeds)
bun scripts/grokbot-catalog-matrix.ts --ids grok-4.5 --probe-gated --mode tools
```

Exit codes: `0` all non-skipped tools pass (or missing creds + `--allow-missing-creds`); `1` a non-skipped id failed tools; `2` credentials missing.

The older representative gate (`scripts/grokbot-matrix.mjs --mode text|tools|opus-tools|ompa-smoke|ompa-integration`) still exists for GATES.md G1–G5.

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
| `grok-4.5` + any tools | Upstream HTTP 422. Catalog `supports-tools: false`. Text-only works. Matrix skips tools unless `--probe-gated`. |
| Explicit Anthropic id + raw omp field-2 tools | Upstream HTTP 400 / `ERROR_PROVIDER_ERROR`. |
| Anthropic + tools (default) | `GROKBOT_ANTHROPIC_TOOLS_WIRE=auto` → **keep-model**: product PascalCase tools on the original Anthropic `requestedModel`. Backend stays Claude/Fable. |
| `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` | Rewrites to `sand-automation` + `generalPurpose`. Often routes to `cursor-grok-*`, **not** a verified Anthropic worker. |
| `sand-default` / `sand-cua` / `default` / `default[]` / `sand-automation` + tools | Routers; with tools they typically land on the **grok** family. Product field-2 tools still complete bash/read/write round-trips. Native omp tools on `default`/`default[]` were HTTP 422 (`cursor-grok-4.5-high`) — they now use parent-chat like `sand-default`. `sand-automation` often routes to `cursor-grok-4.5-high`, which may dump a fenced `{"name":"Shell",…}` object — the stream promotes that into a real `toolCall` so bash/Shell still execute. |
| Gemini / GPT-mini empty tool turn | Native schemas are family-normalized (Google keywords stripped; OpenAI `additionalProperties: false`). Thought-only JSON in thinking is promoted. One empty-body retry runs with thinking off and a larger maxTokens. |
| AgentService/Run on a grokbot sand JWT | Not supported (zero mitm hits). InferenceService/Stream only. |

## Related

- Gate matrix / research scripts: [`GATES.md`](../GATES.md), `scripts/grokbot-catalog-matrix.ts`, `scripts/grokbot-matrix.mjs`
- Provider tables: [Providers](./providers.md), [Environment variables](./environment-variables.md)
- In-session: `/grokbot`, `/login grokbot`
