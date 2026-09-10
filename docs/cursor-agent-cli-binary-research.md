# Cursor agent CLI binary deep dive

Research date: 2026-09-03. Analyzed release: `2026.09.02-c22c1a3` on macOS arm64.

## Executive conclusions

1. `agent` is not a self-contained native CLI. The installed entrypoint is a small Bash launcher that runs a bundled Node executable over a webpack application (`index.js` plus lazy chunks). The large SEA executables are used for signed computer-use workers, not normal CLI startup.
2. Cursor's model surface is a three-source join:
   - `AgentService/GetUsableModels` supplies the credential-scoped list of legacy wire slugs the account may use.
   - `AiService/AvailableModels` supplies rich base-model metadata, parameter definitions, complete variant combinations, capabilities, context limits, aliases, and data-retention restrictions.
   - `AgentService/GetDefaultModelForCli` supplies the account's default.
3. The official client sends both identities: legacy `model_details.model_id` retains the account-usable slug, while `requested_model.model_id` carries the rich base id plus string-valued parameters. Sending the rich base in both fields produces `BAD_MODEL_NAME`; requests cannot infer one field from the other.
4. The live rich catalog contained 37 base models and 363 variants. The same account had 217 usable legacy slugs. Joining the two admitted 336 variants across 35 base models. Every usable slug mapped to rich metadata.
5. The rich catalog did not populate its optional `price` field for any of the 37 models. It is authoritative for model capability and routing, while Cursor's first-party [`models-and-pricing.md`](https://cursor.com/docs/models-and-pricing.md) document, advertised through `llms.txt`, is the machine-readable token-rate source.
6. `claude-fable-5` and `claude-fable-5-1` explicitly report `requires_data_retention = true`. OMP forces `x-ghost-mode: true`, so discovery must omit both instead of advertising routes every invocation rejects. The observed `MODEL_BLOCKED` response is a privacy-policy mismatch, not an invalid model id.
7. OMP already has the hard part worth retaining: typed Cursor exec-channel messages are bridged into OMP tools, paired into OMP transcripts, and answered in band. Replacing this with a subprocess wrapper around the official CLI would discard that integration.
8. The Devin implementation provides the right architectural template for Cursor: centralized wire identity, credential-scoped authoritative discovery, server-declared family collapse, exact request routing, and fixture/live protocol verification. Cursor differs in one important respect: model routing comes from authenticated RPCs, while token rates refresh independently from its public first-party pricing document.

## Method and boundaries

The investigation used the locally installed Cursor agent package, authenticated read-only model and pricing RPCs, Cursor's public model API documentation, and Cursor's public pricing document. It did not modify Cursor state, start an agent turn, execute a model tool, or retain credentials. The catalog probe read the access token from the macOS Keychain inside the probe process and sent it only to Cursor's authenticated API hosts. No token, account identity, email, or authorization header is present in this document.

The minified webpack sources retain original module keys such as `./src/client.ts`, `./src/models/model-service.ts`, and `../agent-client/dist/index.js`. Formatting the bundle and extracting modules made those boundaries readable without changing behavior.

## Installed package anatomy

Resolved launcher:

```text
~/.local/bin/agent
  -> ~/.local/share/cursor-agent/versions/2026.09.02-c22c1a3/cursor-agent
```

| Artifact                   | Role                                                                             | Approximate size |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------: |
| `cursor-agent`             | Bash launcher                                                                    |           1.1 KB |
| bundled `node`             | Normal runtime                                                                   |           139 MB |
| `index.js`                 | Main webpack bundle                                                              |           9.1 MB |
| numbered `.index.js` files | About 75 lazy webpack chunks                                                     |           varies |
| `cursor-agent-sea`         | Colocated SEA executable used by computer-use flow                               |           146 MB |
| signed worker SEA          | Downloaded/validated worker package                                              |         155.5 MB |
| native modules and helpers | SQLite, PTY, tree-sitter, file service, merkle tree, sandbox, `rg`, spawn helper |           varies |

The launcher:

- records the invoked name in `CURSOR_INVOKED_AS`;
- resolves its version directory;
- sets `NODE_COMPILE_CACHE` under the platform cache directory;
- runs bundled Node with `--use-system-ca` unless `AGENT_CLI_CREDENTIAL_STORE=file`;
- falls back to bundled Node without that flag if necessary.

`package.json` identifies the application as private `@anysphere/agent-cli-runtime`.

### SEA and computer-use security path

The normal launcher does not execute `cursor-agent-sea`. On macOS the computer-use worker resolves or downloads a signed package from Cursor's agent download endpoint. The worker path checks:

- allowed HTTPS hosts and redirect targets;
- tar member paths before extraction;
- Apple code-signing identity (Team ID `DCNK4UB866`);
- bundle identifier `com.anysphere.cursor-agent-worker`;
- notarization/signature state.

The worker cache lives under `~/.cursor/cursor-agent-sea/`. Environment overrides exist for the signed CLI path, unsigned computer use, download base, and channel.

The ordinary CLI updater is less strict. Static inspection found TLS download plus staged/atomic installation, but no in-client archive checksum or code-signature verification on the regular update path. This is distinct from the signed computer-use worker path.

## CLI, configuration, and lifecycle

The public CLI surface includes interactive and print modes, JSON/stream-JSON output, model selection, parameter overrides, plan/ask modes, resume/continue, approvals and sandbox controls, MCP, worktrees, login/logout, status, models, Bedrock, update, chat creation, rules, and worker commands.

Additional bundled handlers cover automation CRUD/runs, cloud transcripts, remote environments, semantic search/status, local workers, ACP, channel installation, worker debugging, and controller/server modes. Some are hidden or gated and should not be treated as stable public API.

### Configuration layering

The official config provider composes:

1. built-in defaults;
2. global `cli-config.json` (`$CURSOR_CONFIG_DIR` or the platform Cursor config directory);
3. project `.cursor/cli.json` files from Git root to current directory, shallow to deep.

Project config is deliberately narrow; permissions are the principal project-owned surface. Global config stores selected model details, parameter values by model, a bounded 32-entry model history, approval/sandbox/network settings, privacy/server caches, and legacy max-mode fields. Writes use temp-file rename and a serialized transform lock. Invalid global config is backed up with a `.bad` suffix and repaired from defaults.

### Authentication

Credential-store selection is controlled by `AGENT_CLI_CREDENTIAL_STORE=file|memory|default`:

- macOS default: Keychain;
- Linux/Windows default: file;
- memory: process-local.

Keychain service names include `cursor-access-token`, `cursor-refresh-token`, and `cursor-api-key` under the `cursor` domain and `cursor-user` account. File storage uses platform config directories with directory mode `0700` and file mode `0600`.

Browser login uses a 32-byte base64url PKCE verifier, SHA-256 challenge, and UUID. It opens `loginDeepControl` with CLI redirect parameters, then polls `/auth/poll` for up to 150 attempts using 1-second exponential delay (factor 1.2, capped at 10 seconds). A 404 means pending; repeated non-pending failures terminate after three consecutive errors. The official client also supports selected-team login, proxy settings, and managed sign-in policy checks.

API-key login posts to `/auth/exchange_user_api_key`. Proactive token refresh in this release re-exchanges the stored API key and treats a JWT as expiring within 300 seconds. OMP's Cursor OAuth adapter mirrors most of the browser flow, but does not currently mirror selected-team login, managed policy, abort-aware polling, or the official API-key refresh distinction.

### Updating

The update path obtains a URL from the dashboard API or `AGENT_CLI_UPDATE_CHECK_URL`, compares date-shaped versions (`YYYY.MM.DD`), stages into a hidden directory, atomically renames, and updates `agent`/`cursor-agent` symlinks under `~/.local/bin`. A lock becomes stale after 60 seconds. Cleanup retains two newest inactive versions and honors in-use markers.

## Model protocol

### RPCs and timing

The official model service starts three calls concurrently:

| RPC                                           | Purpose                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| `agent.v1.AgentService/GetUsableModels`       | Credential-scoped legacy slugs and display aliases           |
| `agent.v1.AgentService/GetDefaultModelForCli` | Account default                                              |
| `aiserver.v1.AiService/AvailableModels`       | Rich base models, parameters, variants, capabilities, policy |

The rich request sets `use_model_parameters=true`, `do_not_use_markdown=true`, and `use_cloud_agent_effort_modes=true`. It intentionally leaves `variants_will_be_shown_in_exploded_list` unset: a live probe showed that setting it returns only 37 default variants instead of all 363 combinations. The rich result has a 2-second soft timeout so legacy models can initialize even if rich metadata is slow. The model manager refreshes every 10 minutes.

The official `agent models` command intentionally prints `GetUsableModels`; it does not print all rich variants. The interactive model picker uses the rich catalog.

### Live catalog measurements

Read-only probes using both the official version header (`cli-2026.09.02-c22c1a3`) and OMP's older discovery header (`cli-2026.02.13-41ac335`) returned byte-identical responses for all three model RPCs. The catalog is not currently gated on that version header, although other protocol behavior can still be version-sensitive.

| Measurement                                  |                              Value |
| -------------------------------------------- | ---------------------------------: |
| Usable legacy model slugs                    |                                217 |
| Rich base models                             |                                 37 |
| Base models with parameter definitions       |                                 30 |
| Rich variants                                |                                363 |
| Variants admitted by the usable-slug join    |                                336 |
| Rich bases admitted by the join              |                                 35 |
| Rich legacy slugs not usable by this account |                                 16 |
| Duplicate rich legacy slugs                  | 130, each duplicated exactly twice |
| Rich models carrying `price`                 |                                  0 |

The 130 duplicate slugs are not accidental duplicates. Many Claude and GPT variants reuse one legacy slug for both the normal-context and 1M-context parameter combinations. Therefore a legacy slug is a lossy identifier. The official client maps a legacy slug to the first matching variant, while the rich `RequestedModel` preserves the exact parameter combination.

The live default was:

```text
model_id: default
display_model_id: auto
display_name: Auto
```

Representative rich entries:

- `claude-opus-4-8`: 300K normal / 1M max context; `thinking`, `context`, `effort`, and `fast` parameters; 40 variants.
- `gpt-5.6-sol`: 272K normal / 1M max context; `context`, `reasoning`, and `fast`; 18 variants.
- `claude-fable-5-1`: 300K normal / 1M max context; `thinking`, `context`, and `effort`; 20 variants; requires data retention.
- `default`: aliases `auto`; no meaningful parameter axis; supports agent, images, plan, and sandboxing.

The parameter vocabulary observed across the catalog was `thinking`, `context`, `effort`, `reasoning`, `reasoning_effort`, and `fast`. Values are encoded as strings, including booleans.

### Official selection behavior

The official model manager stores both legacy `ModelDetails` and a richer selected-model record:

```text
selectedModel = {
  modelId,
  parameters: [{ id, value }]
}
```

It resolves input against exact model ids, aliases, legacy slugs, and `variant_string_representation` values such as:

```text
claude-opus-4-8[thinking=true,context=1m,effort=high,fast=false]
```

Parameter sanitation:

1. validates values against server definitions and admin allowlists;
2. fills missing values from the closest/default variant;
3. heals invalid values to default choices unless strict behavior is requested;
4. chooses the closest valid variant after a single-parameter change;
5. falls back to the model's default variant when no exact combination exists.

Every Run request carries both:

- legacy `model_details` for compatibility;
- `requested_model { model_id, max_mode, parameters[] }` for exact selection.

This is a clean protocol transition rather than a model-name parsing scheme.

### Privacy and Fable

The rich catalog marks only these two live bases as requiring retention:

- `claude-fable-5`
- `claude-fable-5-1`

Both report `reason_for_zdr_consent_block = "individual_settings_blocked"`. The official list labels them as non-ZDR but does not hide them. Its Run header follows cached privacy state. OMP hard-codes `x-ghost-mode: true`; its reserved-header sanitizer prevents callers from changing that value. Consequently Fable is structurally discoverable but operationally unusable in OMP until privacy mode is modeled explicitly or retention-required models are filtered.

## Run transport and protocol

### Transport selection

The official client defaults AgentService Run to HTTP/2. A server-config enum can force all or bidi calls on or off; local config can also request HTTP/1. Endpoint selection considers privacy mode, transport, and server-provided agent URL overrides.

HTTP/2 mode:

- uses a configurable connection pool (default 4) with round-robin request selection;
- supports HTTPS proxy tunneling;
- pings every 10 seconds, with a 20-second timeout, including idle connections;
- uses Connect protobuf framing over one bidi stream.

HTTP/1 mode is not a direct POST to `/AgentService/Run`. It emulates bidi transport:

1. open `AgentService/RunSSE` server streaming with a `BidiRequestId`;
2. send each outbound `AgentClientMessage` through unary `aiserver.v1.BidiService/BidiAppend` with request id and monotonically increasing sequence number;
3. use binary payloads when enabled, otherwise hex text;
4. allow at most 16 append requests in flight;
5. apply a 60-second append timeout plus approximately 1 second per 128 KiB.

The official HTTP/1 path adds `x-cursor-streaming: true`. OMP's comment that the Run RPC itself is HTTP/2-only is accurate only for the direct `/Run` endpoint; the official CLI now has this RunSSE/BidiAppend fallback.

### Headers

Common headers include:

- bearer authorization;
- `x-cursor-client-type: cli`;
- `x-cursor-client-version: cli-<release>`;
- `x-ghost-mode` from privacy state;
- random `x-request-id`;
- optional experiment overrides.

Retry attempts receive a new request id while `x-original-request-id` remains stable. Parent/root request and parent agent-tool-call lineage headers are added when applicable.

### Multiplexed stream

`AgentClientMessage` can carry:

- initial Run request;
- exec result/control messages;
- KV messages;
- conversation actions;
- interaction responses;
- client heartbeats;
- prewarm requests.

`AgentServerMessage` can carry:

- interaction updates;
- exec requests/control;
- conversation checkpoints;
- KV requests;
- interaction queries;
- TTFT breakdown.

Interaction updates include text/thinking/token deltas, partial/started/completed tool calls, summaries, shell output, heartbeats, turn end, step timing, prompt suggestions, branch changes, feedback/comparison state, context injection, and routed-model updates.

Actual local work is requested on the typed exec channel. The server sends a numbered `ExecServerMessage`; the client runs it through a controlled execution manager and streams one or more paired `ExecClientMessage` values back. Multiple exec requests may run concurrently. The UI-oriented tool-call updates are a separate projection of the same activity.

The current protocol includes classic read/write/delete/grep/list/shell/MCP/fetch requests, background shell and subagent operations, allowlist prechecks, hooks, computer use, and explicit `pi_read`, `pi_bash`, `pi_edit`, `pi_write`, `pi_grep`, `pi_find`, and `pi_ls` messages. This validates OMP's decision to bridge the typed exec channel rather than pretending Cursor emits ordinary OpenAI-style tool calls.

### Retry and resume

The official agent client retries at the Run layer:

- exponential backoff from 1 second, capped at 60 seconds, with up to 20% positive jitter;
- a new attempt request id and stable original request id;
- resume from the latest eligible conversation checkpoint using `ResumeAction`;
- transport-error threshold 10 (2 in tests);
- server-error threshold 3 unless endless retries are enabled;
- terminal checkpoints suppress resume;
- two streaming resumes without a new checkpoint stop automatic retry;
- stale tool completions and interaction queries from earlier attempts are discarded/cancelled.

Heartbeats do not count as application progress. A stall detector distinguishes heartbeat-only streams from useful activity and uses a 30-second primary threshold by default.

## Usage and errors

### Token usage

The current `TurnEndedUpdate` schema carries optional:

- input tokens;
- output tokens;
- cache-read tokens;
- cache-write tokens;
- reasoning tokens.

The official app's turn accumulator consumes the first four. It normalizes uncached input as:

```text
max(input_tokens - cache_read_tokens - cache_write_tokens, 0)
```

It aggregates subagent usage into the parent. The schema exposes reasoning tokens, but static inspection of this release's main turn accumulator found no corresponding assignment.

OMP's vendored `TurnEndedUpdate` is empty. OMP currently increments output usage from `TokenDeltaUpdate` and uses checkpoint `used_tokens` only as a context fallback. This misses the authoritative input/cache split and may misstate output usage. Updating the message schema and preferring TurnEnded is a direct correctness improvement.

The model RPCs do not carry usable dollar prices, but Cursor publishes per-million-token input, output, cache-read, and cache-write rates at a first-party Markdown URL listed in `llms.txt`. OMP fetches that document concurrently with official-host discovery, without sending credentials, and joins its table to rich model identities. Explicit variant rows win; otherwise a selected `AvailableModels` parameter's declared numeric cost multiplier applies to the base row. If the document is unavailable or lacks a model, the catalog reuses the corresponding first-party vendor model's bundled list price rather than reporting a known model as free. The credential-scoped cache stores the resulting catalog and uses a new namespace so pre-pricing zero rows cannot survive. `default` remains unpriced because Cursor Router may choose a differently priced model for each request.

#### Pricing source audit

The Markdown is not scraped from rendered page HTML. `models-and-pricing.md` is a public raw-docs response (`content-type: text/markdown`, `x-matched-path: /api/raw`, one-hour cache) linked by the site's `llms.txt` machine index. The HTML page and React Server Component payload contain the same table but add private Next.js serialization and build identifiers, so they are strictly less stable inputs. No JSON rate-card endpoint was requested while loading the page.

The alternatives were tested rather than inferred:

| Source | Live evidence on 2026-09-03 | Decision |
|---|---|---|
| `AvailableModels.price` | Zero populated prices across 37 rich models | Capability/routing source only |
| `CheckUsageBasedPrice` | Token-based requests returned a policy message and `price_id`, but no `cents`, even with one million synthetic tokens; non-token requests returned a flat four-cent request price, not token rates | Not a rate card |
| `GetPricingHistory` and usage ledgers | Pricing history was empty; usage rows are retrospective account spend with token totals, discounts, and multiple unknown token-rate dimensions | Unsuitable for prospective per-token prices |
| Cloud Agents `GET /v1/models` | The published OpenAPI schema exposes ids, aliases, parameters, and variants, but no cost fields | Routing source only |
| Shared bundled vendor prices (`pricing-peer`) | Priced 54 of 60 live Cursor lanes, leaving six zero; eleven lanes differed from Cursor's published prices, including Cursor models, Fast variants, Gemini, and Grok cache/output rates | Keep only as outage/missing-row fallback |
| models.dev/Stencil | No Cursor or Composer provider catalog | Already represented by the bundled-vendor fallback |
| OpenRouter and LiteLLM | Contained upstream GPT/Grok entries but no Cursor provider or Composer 2.5 SKU | Third-party fallback would add lag without closing coverage |
| Rendered HTML or Next.js RSC | Same first-party table behind less stable presentation/private-framework formats | Worse than raw Markdown |
| `models-and-pricing.md` | First-party Cursor-specific base, Fast, cache-read, and cache-write rates; priced 59 of 60 live lanes, with only dynamic `default` intentionally unpriced | Primary source |

Therefore the raw Markdown endpoint remains the least fragile authoritative source available. OMP now discovers the table by its required column names plus Markdown separator rather than fixed column positions, so column reordering and unrelated tables do not silently remap prices. Complete-row validation, ambiguity rejection, response-size/time bounds, and bundled-vendor fallback remain the failure boundary.

#### Publication lag and unknown-price semantics

Cursor does not publish revision history for the aggregate Markdown, and no historical captures of the relevant raw or rendered docs routes were available from the public archives checked. Exact aggregate-table insertion timestamps therefore cannot be reconstructed. Contemporaneous Cursor announcements and forum reports still establish useful lower and upper bounds:

| Model/event | Available in Cursor | Pricing evidence | Observed lag |
|---|---|---|---|
| Grok 4 | 2025-07-10 | Users reported it absent from both the docs and editor hover on launch day; Cursor staff said on 2025-07-11 that the docs would be updated soon | At least one day |
| Kimi K2 | No later than 2025-07-20 | Cursor staff said it had just been added and would be documented; on 2025-08-14 users still reported no pricing in the docs or editor | At least 25 days |
| Composer 2.5 | 2026-05-18 | The launch post published exact Standard and Fast rates and linked a model-specific pricing page | Same day for a first-party price source |
| Grok 4.5 / 4.6 | 2026-07-08 / 2026-08-12 | Each launch post linked a live model-specific pricing page on the day availability was announced | Same day for a first-party price source |
| Claude Opus 4.8 | 2026-05-28 | The launch post linked pricing, but a 2026-05-31 report showed Cursor's usage UI still labeling requests `Free` | UI metadata stale for at least three days |

Sources: [Grok 4 docs report](https://forum.cursor.com/t/grok-4-missing-hover-info-and-docs-page/116392), [Kimi/DeepSeek pricing report](https://forum.cursor.com/t/missing-pricing-info-for-kimi-and-deepseek/129453), [Composer 2.5 launch](https://forum.cursor.com/t/composer-2-5-is-now-live/160934), [Grok 4.5 launch](https://forum.cursor.com/t/grok-4-5-is-now-available/165158), [Grok 4.6 launch](https://forum.cursor.com/t/grok-4-6-is-now-live/168189), and [Claude Opus 4.8 launch and follow-up](https://forum.cursor.com/t/claude-opus-4-8-out-now/161824).

The history rules out treating a missing rate as zero. Pricing presentation now uses five states:

- `fixed`: at least one published per-token rate is non-zero; show the input/output pair;
- `variable`: a router such as Cursor's `default` selects differently priced backing models; show `varies` / `price varies`;
- `unknown`: neither Cursor's document nor a reviewed vendor peer supplies a rate; show `unknown` / `pricing unknown`;
- `included`: a provider explicitly states that usage is included rather than metered per token;
- `free`: a provider explicitly states that the model has no usage charge.

An all-zero rate card without explicit semantics is `unknown`, never `free`. Positive rates always win over status metadata. The JSON model listing exposes the resolved `pricingStatus`, so automation need not infer semantics from zeros. This keeps the source order honest: Cursor-specific documentation first, reviewed vendor-peer price second, then a visible unknown state rather than invented precision.

### Structured errors

The server's `ErrorDetails.Error` enum now reaches value 65 and distinguishes authentication, rate/usage/payment, policy, provider, model, max-mode, region, outdated-client, and account-closure failures. `CustomErrorDetails` can carry title, detail, retryability, request-id visibility, buttons, plan choices, analytics metadata, and additional information.

The official client maps errors into four behavioral classes:

- `ActionRequiredError`: `login`, `upgrade`, `payment`, `config`, or a server-provided action;
- `NonRetriableError`: explicit `is_retryable=false` or missing conversation data;
- `CancelledError`: user abort/debounce;
- `RetriableError`: transport and remaining server failures.

Inference retry excludes known permanent categories such as image too large, max tokens, conversation too long, content policy, deprecated/model retired, max mode required, unsupported region, and outdated client.

OMP retains useful bounded Connect trailer diagnostics but does not decode Cursor's structured `ErrorDetails` into provider behavior. That loses the official distinctions between login, upgrade, payment, policy, and retryable transport failure.

## OMP comparison

| Surface                          | Official 2026.09.02 behavior                                        | OMP current behavior                                                                                    | Consequence                                                       |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Wire identity                    | One release identity used across clients                            | Run pins `cli-2026.07.23-e383d2b`; discovery pins `cli-2026.02.13-41ac335`                              | Drift and duplicated maintenance                                  |
| Account catalog                  | `GetUsableModels` is authoritative                                  | Dynamic rows merge with bundled rows                                                                    | Retired/unentitled static rows survive                            |
| Rich catalog                     | Server capabilities, contexts, aliases, parameters, policy          | Not fetched; model names/classification drive heuristics                                                | Avoidable guesses and incomplete routing                          |
| Catalog size on measured account | 217 usable legacy rows                                              | 118 bundled; only 81 overlap; successful non-authoritative merge can retain 37 unavailable bundled rows | Picker can expose zombie entries                                  |
| Default                          | Server says `default` / `auto`                                      | Descriptor defaults to `claude-4.6-opus-high`                                                           | OMP does not follow account default                               |
| Model routing                    | Exact base id plus complete parameter set                           | Regex normalization only for OpenAI effort suffixes plus a Composer special case                        | Claude/context/fast/retention axes cannot be represented reliably |
| Privacy                          | Header follows privacy config; catalog marks retention requirements | `x-ghost-mode: true` is forced and reserved                                                             | Fable is advertised but blocked                                   |
| Transport                        | HTTP/2 plus RunSSE/BidiAppend HTTP/1 fallback                       | Direct HTTP/2 only                                                                                      | ALPN-stripping proxies require an external bridge                 |
| Retry                            | Checkpoint-aware in-stream resume                                   | No equivalent provider-level automatic checkpoint resume                                                | Mid-turn transport failure repeats or aborts more work            |
| Usage                            | Authoritative TurnEnded input/output/cache fields                   | Empty TurnEnded schema; TokenDelta output counting                                                      | Incomplete token accounting                                       |
| Errors                           | Typed server details and action categories                          | Generic Connect error plus bounded diagnostic rendering                                                 | Weaker recovery and user guidance                                 |
| Protocol freshness               | Run request fields through 32; interaction/tool/exec additions      | Handwritten consumed subset; newer fields decode unknown                                                | Safe fallback exists, but capability drift is manual              |
| Local tools                      | Controlled typed exec manager                                       | Typed exec frames bridged into OMP tools with transcript pairing                                        | OMP strength; retain it                                           |

The current rich/legacy model endpoints returned byte-identical data under both OMP's old discovery header and the official header. Therefore version skew does not explain today's catalog mismatch. The mismatch comes from not calling the rich endpoint and from non-authoritative merge policy.

## Recommended Devin-style design

### 1. Centralize Cursor wire identity

Add a small `packages/catalog/src/wire/cursor.ts` analogous to `wire/devin.ts` containing:

- default API/agent hosts;
- one reviewed CLI version;
- shared header construction;
- privacy-mode input;
- request-id/lineage helpers where package boundaries permit.

Both catalog discovery and `packages/ai/src/providers/cursor.ts` should consume it. This removes the current seven-month split between discovery and Run version pins.

### 2. Make authenticated Cursor discovery authoritative

Mirror `devinModelManagerOptions`:

- mark Cursor credential-scoped during generation;
- retain a minimal synchronous seed (`default`/Auto and at most one verified fallback);
- set `dynamicModelsAuthoritative: true` when credentials are present;
- treat request/decode/empty failures as `null`, preserving the seed;
- log an empty-200 warning with non-secret wire identity;
- replace the current global `cursor:default-effort-v4` cache namespace with a credential-scoped namespace if multiple Cursor accounts can coexist.

The measured sets make this concrete: 136 usable slugs were absent from the 118-row bundle, while 37 bundled slugs were absent from the account-authoritative list.

### 3. Join usable slugs to rich variants

Vendor only the consumed `AvailableModels`/parameter/variant protobuf fields and fetch the three official RPCs concurrently. Use `GetUsableModels` as the authorization filter and rich metadata as the capability/routing source. Preserve an unmatched usable slug as a conservative legacy row so custom models still work.

Delete the model-id capability heuristics that the rich response replaces: image support, thinking support, normal/max context, max-mode support, aliases, and data-retention policy. Keep KDL only for facts the server does not report or for verified corrections to misreported fields.

### 4. Collapse rich parameters into one OMP-selectable axis

OMP's model abstraction supports one effort axis, while Cursor exposes up to four simultaneous axes. The lossless compromise is the same lane strategy used by Devin:

1. map `thinking=false` and `reasoning=none` to the OMP `off` route;
2. map `effort`, `reasoning`, `reasoning_effort`, and `thinking_effort` values to OMP effort routes;
3. group variants by base model plus the remaining axes (`context`, `fast`) and max-mode state;
4. make each group a logical model lane, suffixing only non-default dimensions such as `-1m` and `-fast`;
5. preserve each route's exact base `model_id`, parameter set, and max-mode bit in `cursorModelRoutes`;
6. use server default flags to select `requestModelId` and the default effort.

On the measured account this converts 336 admitted rich variants into 60 lossless logical lanes with zero routing collisions. It is denser than 217 legacy rows and exact where duplicate legacy slugs would otherwise lose their 1M-context parameter combination. The route keys remain local; requests serialize the authoritative base id and parameters instead of parsing model names.

Different context or fast lanes remain separate because they change request parameters and may change context or billing behavior. The `thinking` boolean does not create a second lane: its false variant is the `off` route and true variants share the lane's effort ladder.

### 5. Refresh first-party pricing independently

Do not pin token rates in KDL or infer them from model names. Fetch Cursor's `models-and-pricing.md` document during official-host discovery; `llms.txt` advertises this Markdown representation as a first-party machine-readable documentation surface. Parse only complete token-rate table rows, normalize presentation-only name differences, and leave conflicting matches unresolved rather than selecting an arbitrary price.

An explicit fast or 1M row takes precedence. When only a base row exists, apply a numeric multiplier solely when the selected rich parameter is marked `increases_model_cost` and its server-supplied tooltip declares that multiplier. Fall back to the bundled first-party vendor price for a missing document row. Never send the Cursor bearer token to the documentation host. Cache the priced catalog under a versioned, credential-scoped namespace.

This removes hand-maintained price values and refreshes rates with normal catalog discovery. It cannot guarantee that a documentation schema will never change; bounded parsing, upstream fallback, credential-scoped caching, and regression fixtures are the durable failure behavior.

### 6. Make privacy explicit and safe

Default OMP to ZDR (`ghostMode=true`). Then choose one explicit contract:

- conservative first step: filter `requires_data_retention` models and produce an actionable preflight error for a manually requested one;
- full support: add an explicit provider privacy option, include retention-required models only when the user has opted out of ZDR, and send the matching header.

Do not silently set `x-ghost-mode:false` to make Fable work. That changes data-retention semantics.

### 7. Sync usage and error schemas before expanding tools

High-value protocol additions:

- `TurnEndedUpdate` fields 1-5;
- structured Cursor `ErrorDetails` and `CustomErrorDetails` decoding;
- `RequestedModel` fields 7-8 for schema parity;
- routed-model update and its client capability flag if Auto attribution is wanted.

Prefer TurnEnded usage; retain TokenDelta only as a fallback for old servers. Normalize input exactly as the official client does. Map structured errors into OMP's existing status/retry vocabulary instead of branching on message text.

### 8. Add checkpoint-aware transport retry

Port the invariants, not the minified implementation:

- stable original request id, new attempt id;
- latest eligible checkpoint;
- `ResumeAction` on retry;
- no retry after terminal checkpoint;
- stale attempt generation guard for exec completions/queries;
- bounded no-progress resumes;
- exponential backoff with cancellation.

This belongs around the existing OMP exec bridge. It should not be delegated to a generic outer retry that lacks Cursor checkpoint and exec-attempt state.

### 9. Add the official HTTP/1 shim only when needed

Implement RunSSE plus BidiAppend from the recovered schema, preferably behind the same transport interface as the current HTTP/2 path. Select it from server config/local policy, not by blindly retrying every H2 failure. The existing ALPN error should then recommend the built-in fallback rather than requiring a local bridge.

This is lower priority than catalog, privacy, usage, and structured errors because the default official path remains HTTP/2.

### 10. Treat protocol evidence as a maintained fixture

Follow the Devin verification pattern:

- sanitized protobuf fixtures for `GetUsableModels`, `AvailableModels`, defaults, TurnEnded, and representative structured errors;
- parser tests on transformation and precedence, not source text;
- a live opt-in model matrix covering Auto, OpenAI reasoning, Claude thinking, 1M context, fast lane, retention-required rejection, and one custom/unmatched model;
- a compatibility inventory that records unknown message field numbers from current official releases;
- update the vendored proto subset from observed wire descriptors before special-casing unknown frames.

The existing OMP behavior for unknown exec variants is correct: answer with an in-band typed throw rather than leaving the server waiting. Keep that invariant.

## Approaches rejected

### Spawn `agent --print` as the provider

This would outsource model routing, transport, retries, and updates, but it would also require a separately installed/authenticated binary and let Cursor's CLI own local execution, approvals, transcript state, and tool rendering. Its stream-JSON interface does not replace OMP's typed exec bridge. Useful as an oracle and smoke target; poor as the primary provider.

### Parse `agent models` output

The command emits only display-oriented legacy rows. It loses parameter definitions, exact variants, context capabilities, retention policy, and duplicate-slug distinctions. Calling the underlying RPCs is both simpler and more complete.

### Import webpack modules from the installed package

Module ids, chunk boundaries, minification names, and package location are release artifacts, not APIs. Direct protobuf calls provide a smaller and more stable boundary.

### Infer every model property from ids

The current heuristics were necessary with `GetUsableModels` alone. The rich endpoint now reports the same facts directly. Continuing to infer them creates a second policy source and repeats the pre-Devin catalog problem.

### Infer prices from the model RPC alone

No model returned `price`. `CheckUsageBasedPrice` returned only the active `price_id` and the statement that token calls are priced per model; synthetic token counters did not produce `cents`. `DashboardService/GetPricingHistory` returned an empty history, and the documented Cloud Agents `GET /v1/models` schema contains routing parameters but no rates. The fast/context flags also do not contain complete base token prices. Treating those rows as free is wrong, so OMP keeps routing metadata sourced from the RPCs and refreshes rates from Cursor's separate first-party pricing document during discovery.

## Evidence manifest

Cryptographic hashes of the principal installed artifacts:

```text
launcher        2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233
index.js        9be0f8f812ee102d237e7b3a55f79cb90ecb15616bc23601598314958445de5c
bundled node    ebd2d552c7bebde593dd0390530963ad28de56bccde6ce387cdbe55fb0b6fb8e
normal SEA      a0aafdee100ecb122782b8155dd378aed5d1fe033b97b4cef6552bc561738873
worker SEA      a4b94d196d76033abbbabf82480b9afa55a10a9bc3f94b1ec4142b97e41d31a7
rich catalog    93731dc5444b3d3b6c4a20570f22c4daec14f99cbf431fe28ac83bd64d60ea0d
usable catalog  8f112b265edd56953ee84aac0fe99a73cbbf00abcb62b61817c6ac1fac2982d4
default model   f49e1750525ef728c009f143c6f34144536f6d2df420d1bee60a1f5b02888ef9
```

Extraction produced:

- formatted main bundle and all 75 lazy chunks;
- 258 first-party modules from the main bundle;
- 341 first-party modules across lazy chunks;
- module manifests with original webpack source keys;
- raw model protobuf responses and a decoded rich-catalog representation;
- exact bundled-versus-usable catalog set comparison.

Most relevant recovered modules:

```text
./src/client.ts
./src/auth-refresh.ts
./src/models/model-service.ts
./src/models/index.ts
../model-selection/dist/index.js
../agent-client/dist/index.js
../proto/dist/generated/agent/v1/agent_service_pb.js
../proto/dist/generated/agent/v1/agent_pb.js
../proto/dist/generated/agent/v1/requested_model_pb.js
../proto/dist/generated/aiserver/v1/aiserver_pb.js
../proto/dist/generated/aiserver/v1/bidi_pb.js
../proto/dist/generated/aiserver/v1/utils_pb.js
```

OMP source surfaces compared:

```text
packages/ai/src/providers/cursor.ts
packages/ai/src/providers/cursor/proto/agent.proto
packages/ai/src/registry/oauth/cursor.ts
packages/catalog/src/discovery/cursor.ts
packages/catalog/src/provider-models/special.ts
packages/catalog/src/provider-models/descriptors.ts
packages/catalog/src/compat/collapse.ts
packages/catalog/src/discovery/devin.ts
packages/catalog/src/wire/devin.ts
```

## Limits

This is static analysis plus read-only model and pricing RPC evidence from one account and one release, supplemented by Cursor's first-party pricing document as read on 2026-09-03. It does not establish undocumented server guarantees, future pricing values, behavior for other account policies, or whether every bundled hidden command is enabled in production. The implementation removes hand-maintained prices, but still depends on the documented Markdown table retaining machine-readable token-rate columns; parser fixtures and upstream-price fallback bound that failure. Exact field numbers and response bytes are evidence for this release, not a promise of protocol stability. The implementation should remain fail-closed for unknown exec requests and retain fallback catalog behavior when rich discovery fails.
