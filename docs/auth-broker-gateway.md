# Auth Broker and Auth Gateway

The auth broker centralizes credential storage and OAuth refreshes. The auth gateway lets clients make provider requests without receiving provider credentials. Direct broker clients are trusted: snapshots expose OAuth access tokens and stored API keys, but never the real OAuth refresh token.

- **`omp auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes snapshot, credential, block, usage, and health APIs under `/v1`.
- **`omp auth-gateway serve`** is a forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, pi-native stream, TypeSafe System One judgment, and OpenAI/OpenRouter-style image, speech, transcription, embedding, rerank, and video requests, resolves the broker-backed credential, and dispatches through `pi-ai` provider logic. Clients (containerised omp, llm-git, the macOS usage widget, …) never see the access token.
- **`omp auth-gateway stdio`** serves the same routes to its parent process as JSON lines on stdin/stdout, on the CLI's own credentials and model roles; see [stdio](#stdio).

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token by default. The gateway also answers CORS `OPTIONS` preflights without authentication; `--no-auth` disables inbound gateway authentication.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/ai/src/auth/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-stdio.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

## Data flow

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

The broker is the only writer of OAuth refresh tokens. Clients (including the gateway itself) load a redacted snapshot in which every `refresh` field has been replaced with `REMOTE_REFRESH_SENTINEL`; when an access token expires the client calls `POST /v1/credential/:id/refresh` and the broker performs the refresh server-side. Credential writes through `RemoteAuthCredentialStore` await broker persistence and update its local snapshot before returning; the broker remains the authoritative writer.

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port] [--trust-proxy-headers]  # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` opens the local SQLite store at `getAgentDbPath()` and binds an HTTP listener (default `127.0.0.1:8765`). On startup a token is ensured at `<config-dir>/auth-broker.token` (mode `0600`, newly created parent directory `0700`). The background refresher runs immediately and then every `refreshIntervalMs` (default 60 s), targeting OAuth credentials whose expiry is within `refreshSkewMs` (default 5 min).
- Logs attribute requests to the socket peer address. Behind a trusted reverse proxy, pass `--trust-proxy-headers` to use `X-Forwarded-For` / `X-Real-IP` for authenticated requests; unauthorized requests are always logged with the socket peer, and paths outside the broker's routes are logged as `<unrouted>`.
- `token` prints the stored bearer or generates a new one. `--regenerate` replaces the token file; restart a running broker to load the replacement into its in-memory allow-list.
- `login [<provider>]` runs the registered sign-in flow locally (OAuth or a provider's API-key login). With no provider it shows an interactive numbered picker. With `--via=user@host` it runs `ssh -L <callback-port>:127.0.0.1:<callback-port> -o ExitOnForwardFailure=yes user@host omp auth-broker login <provider>`; the credential is written on the remote host (`--via` requires `<provider>`, and `--dry-run` applies only to this remote path). Ports are derived from the auth registry: `anthropic:54545`, `openai-codex:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`, `devin:59653`, `openrouter:54549`, `stencil:54547`. `gitlab-duo-agent` and `zai-coding-plan` use non-loopback/manual callbacks rather than the old `8080`/`9999` listeners; run those flows on the host directly. Login is driven in-process through `AuthStorage.oauth.login()`.
- `logout [<provider>]` disables the provider's active rows with cause `logged out by user`; disabled tombstones remain available through the broker API. With no argument it shows an interactive numbered picker of stored providers.
- `list` enumerates the sign-in providers returned by `getOAuthProviders()` (visible built-ins plus `registerOAuthProvider` custom providers), not the stored accounts. `--json` emits an array of `{ id, name }`.
- `import <file|dir>` imports CLIProxyAPI-style JSON credentials into the local SQLite store. Maps `type` field → omp provider (`claude → anthropic`, `codex → openai-codex`, `gemini → google-gemini-cli`, `antigravity → google-antigravity`, `gemini-cli → google-gemini-cli`).
- `migrate --from-local` uploads local SQLite credentials to the configured broker (`POST /v1/credential`). Local API keys are included by default; local OAuth rows are skipped unless `--include-oauth` is set; environment-derived API keys are skipped unless `--include-env` is set. Re-runs are idempotent against the broker snapshot.
- `status` health-pings the configured remote broker.

### Endpoints

| Method   | Path                         | Auth   | Purpose                                                            |
| -------- | ---------------------------- | ------ | ------------------------------------------------------------------ |
| `GET`    | `/v1/healthz`                | none   | Liveness + version                                                 |
| `GET`    | `/v1/snapshot`               | bearer | Redacted snapshot (refresh tokens replaced by sentinel)            |
| `GET`    | `/v1/snapshot/stream`        | bearer | SSE snapshot stream with delta events and keepalives               |
| `POST`   | `/v1/credential`             | bearer | Upsert one OAuth or API-key credential                             |
| `POST`   | `/v1/credential/:id/refresh` | bearer | Force-refresh one OAuth credential                                 |
| `POST`   | `/v1/credential/:id/disable` | bearer | Disable one credential with a recorded cause                       |
| `GET`    | `/v1/credentials/disabled`   | bearer | List disabled credentials; optional `provider` query filter        |
| `POST`   | `/v1/credential/:id/block`   | bearer | Upsert a provider/scope rate-limit block                           |
| `DELETE` | `/v1/credential/:id/block`   | bearer | Delete one block named by body `providerKey` and `blockScope`       |
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | Delete all rate-limit blocks for a credential                      |
| `GET`    | `/v1/usage`                  | bearer | Aggregate current `UsageReport[]` across credentials               |
| `GET`    | `/v1/usage/history`          | bearer | Persisted usage history; optional `sinceMs` and `provider` filters |
| `POST`   | `/v1/usage/observed`         | bearer | Record usage observed by a broker client                           |
| `GET`    | `/v1/usage/clients`          | bearer | Summarize client-observed usage since optional `sinceMs`           |
| `POST`   | `/v1/usage/stale`            | bearer | Invalidate the broker's usage cache; optional `provider` scope     |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

A snapshot contains `generation`, `generatedAt`, `serverNowMs`, `refresher`
(`enabled`, `intervalMs`, `skewMs`, `nextSweepInMs`), and `credentials`.
Each credential carries its id/provider/redacted credential/`identityKey`,
`rotatesInMs`, and optional rate-limit `blocks`.

The SSE stream starts with a full `snapshot` event, followed by changed `entry`
and deleted/disabled `removed` events. The SSE event name also appears as JSON
`kind`; deltas carry `generation`, `serverNowMs`, and `refresher`, plus `entry`
or the removed `id`. Keepalives are SSE comments, not JSON events.

Direct `POST /v1/credential/:id/refresh` forces a refresh. The
`?reason=auth-recovery` form may reuse a still-usable token that the broker
minted within the preceding five minutes, preventing repeated remints during
an upstream outage.

#### Conditional snapshot long polling

`GET /v1/snapshot?wait=<ms>` supports generation-based conditional polling.
Send the generation from a previous response in `If-None-Match`. The broker
accepts a non-negative integer generation as a bare tag, a quoted tag such as
`"42"`, or a weak quoted tag such as `W/"42"`.

`wait` is parsed as a number, truncated to whole milliseconds, and clamped to
the range 0–30,000 ms; an absent or non-numeric value behaves as `0`. The
response state machine is:

- If the tag is absent/invalid, differs from the current generation, or
  `wait <= 0`, return the current redacted snapshot immediately with `200`.
- If the tag matches and `wait > 0`, wait for the generation to change. Return
  the new snapshot with `200` when it changes, an empty `304` when the wait
  expires unchanged, or an empty `499` when the caller disconnects.

Every `200`, `304`, and `499` snapshot response carries a quoted generation
`ETag`, plus `Cache-Control: no-store` and
`Vary: OMP-Auth-Broker-Capabilities`. A disconnect response uses the generation
captured before waiting.

### Codex block-scope compatibility

Clients that understand per-meter Codex blocks send `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`. Snapshot responses then carry the canonical `chat` and `spark` scopes. Without that capability, the broker projects those rows to the legacy `shared` scope on the wire.

Local SQLite schema 8 keeps `chat` and `spark` as the canonical scopes exposed by current store APIs. It also maintains a physical `shared` compatibility mirror for pre-meter binaries that read `agent.db` directly. SQLite triggers derive that mirror's deadline and update time independently from the meter rows, and copy a legacy process's `shared` writes back to both meters. Current store APIs omit the physical mirror, so broker snapshots and model selection do not double-count it.

Clients released before this capability, including 17.1.4, receive the conservative `shared` projection until they are upgraded. Those clients are indistinguishable on the existing wire, so mixed-version deployments favor keeping a rate-limited credential blocked over allowing repeated provider requests and 429 responses.

Capability-dependent responses include `Vary: OMP-Auth-Broker-Capabilities` so intermediaries do not reuse one representation for another client. The encrypted client snapshot cache also uses a new format version: older cache files are ignored and fetched again, preventing legacy and meter-scoped representations from being mixed across client versions.

### Background refresher

`AuthBrokerRefresher` reloads active credentials before each sweep and does not overlap sweeps. Manual and background refreshes share the per-credential single-flight in `OAuthRefresher`; SQLite refresh leases also coordinate writers across processes.

- **Definitive failures**, as classified by `isDefinitiveOAuthFailure()`, disable only the credential version that failed. Compare-and-set persistence protects a credential rotated by a concurrent login/refresh; the refresher logs the result rather than disabling the row again.
- **Transient failures** (for example network timeouts) leave the credential in place for the next sweep.

The CLI broker refresh hook also handles managed `mcp_oauth:*` credentials using their stored MCP token endpoint/client metadata; it does not need to load the MCP manager.

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth] [--trust-proxy-headers]
omp auth-gateway stdio
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` requires `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) — the gateway is itself a broker client. It fetches a live snapshot, wraps it in `RemoteAuthCredentialStore`, and constructs `AuthStorage` with the configured account pool and account policies. Unlike normal client discovery, gateway startup does not use the encrypted snapshot cache. Default bind is `127.0.0.1:4000`. The gateway token is stored at `<config-dir>/auth-gateway.token` (`0600`); `--no-auth` disables the bearer check entirely. Use that flag only on trusted loopback listeners; it does not enforce a loopback bind.
- Logs attribute requests to the socket peer address. Behind a trusted reverse proxy, pass `--trust-proxy-headers` to use `X-Forwarded-For` / `X-Real-IP` for authenticated requests; unauthorized requests are always logged with the socket peer. An authenticated request that also carries the gateway token in its URL or in a forwarded, logged, or identity header is rejected with `400` before any credential lookup.
- `token` manages the token file; `--regenerate` requires a running gateway to restart before accepting the replacement. `status` checks the local token file and an authenticated broker snapshot; it does not probe the gateway listener.
- `check` constructs its own broker-backed store and probes the credentials the gateway would use, without calling a running gateway. Without `--strict` it uses provider usage probes. `--strict` additionally tries suitable bundled chat models and can consume quota; providers with no suitable candidate (including pi-native forwarding, Bedrock, Vertex, and Cursor transports) cannot be completion-probed.

### stdio

`omp auth-gateway stdio` is the gateway for one trusted parent process (an editor, a terminal's git UI, a script): no listener, no token, no broker requirement. It uses the credentials, models (`models.yml` and extension providers included) and settings any other `omp` command would: the broker when one is configured, else the local store. Requests and responses are JSON lines:

```
→ {"id": 1, "path": "/v1/chat/completions", "body": {"model": "@commit,@smol", "messages": [...]}}
← {"ready": true, "version": "18.4.11"}
← {"id": 1, "status": 200, "body": {"object": "chat.completion", "choices": [...]}}
```

- The first output line is `{"ready": true, "version": …}`. `method` defaults to `POST` when the request has a `body`, else `GET`; every route in [Endpoints](#endpoints-1) except `/healthz` is served.
- Requests run concurrently and answer in completion order; `id` (string or number) matches them up. A line that is not a request answers `400` with its `id` when it had one.
- A JSON response body is embedded as JSON; a text body (the SSE of a `stream: true` request) as one string once the stream ends; anything else (audio, video) as base64 with `"encoding": "base64"`.
- `model` takes any `--model` selector: `provider/id`, a fuzzy name, a role (`@smol`), or a comma list whose first entry that resolves wins. An attempt that fails with a status above `400` (other than `499`) moves on along that model's `retry.fallbackChains`, the role's chain when the entry named a role; the response's `model` names the model that answered.
- The process serves until stdin ends, answers what is in flight, and exits.

### Endpoints

| Method | Path                    | Auth   | Purpose                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | none   | Liveness + version                                           |
| `GET`  | `/v1/usage`             | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`)    |
| `GET`  | `/v1/models`            | bearer | Registry catalog filtered to providers with credentials |
| `GET`  | `/v1/credentials/check` | bearer | Per-credential auth health probe                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions wire format                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages wire format                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses wire format                                 |
| `POST` | `/v1/pi/stream`         | bearer | Native `pi-ai` stream wire format                            |
| `POST` | `/v1/systemone`         | bearer | TypeSafe System One judgments (`judge` models, e.g. `typesafe/jev-latest`); `/alpha/decisions` is the OpenRouter Decisions alias |
| `POST` | `/v1/images/generations` | bearer | Image generation, OpenAI Images JSON wire; `/v1/images` is the OpenRouter alias (`image` models) |
| `POST` | `/v1/images/edits`      | bearer | Image edits: OpenAI multipart or OpenRouter JSON input images |
| `POST` | `/v1/audio/speech`      | bearer | Text-to-speech, OpenAI/OpenRouter JSON wire; answers raw audio bytes (`tts` models: `xai-tts`, `openai-speech`) |
| `POST` | `/v1/audio/transcriptions` | bearer | Speech-to-text, OpenAI multipart `file` or OpenRouter JSON `input_audio` base64 (`stt` models on `openai-transcriptions`; 25 MiB cap) |
| `POST` | `/v1/embeddings`        | bearer | Embeddings, OpenAI wire (`embedding` models on `openai-embeddings`; OpenAI + OpenRouter; 8 MiB cap) |
| `POST` | `/v1/rerank`            | bearer | Rerank, OpenRouter wire (`rerank` models on `openrouter-rerank`) |
| `POST` | `/v1/videos`            | bearer | Submit a video generation job, OpenRouter wire (`video` models on `openrouter-video`); answers `202` with gateway-rewritten polling/content URLs |
| `GET`  | `/v1/videos/:id`        | bearer | Poll a video job. `:id` is gateway-issued and stateless: it encodes provider, model, and upstream job id |
| `GET`  | `/v1/videos/:id/content` | bearer | Stream the finished video bytes with the upstream content type |

The model id is read from the top-level `model` field for foreign wire formats and from the pi-native request body for `/v1/pi/stream`. It may be provider-qualified (`typesafe/jev-latest`) or bare (`jev-latest`). The gateway resolves it against the served catalog — every registry model of a kind the gateway has a route for (`chat`, `judge`, `image`, `tts`, `stt`, `embedding`, `rerank`, `video`), scoped to providers the broker holds credentials for — parses the inbound wire format, resolves the provider credential from broker-backed `AuthStorage`, dispatches through the matching `pi-ai` client (`streamSimple()` for chat, `TypeSafeJudge` for judgments, `generateImage` / `synthesizeSpeech` / `transcribeAudio` / `embed` / `rerank` / `submitVideo` for the modality routes), and re-encodes the result to the inbound format (SSE for streamed chat responses).

Chat routes reject non-chat models with a `400` that names the route to use instead (`Model typesafe/jev-latest is a judge model; use POST /v1/systemone`). `GET /v1/models` marks such rows with `kind` (`judge` | `image` | `tts` | `stt` | `embedding` | `rerank` | `video`); absent means chat.

The served catalog includes bundled, cached, and broker-discovered models. The gateway ignores the host's `models.yml` overrides/custom models so local base URLs, headers, and keys cannot redirect broker-backed traffic. Providers listed in `disabledProviders` of the gateway's effective settings (the same `config.yml` that supplies `auth.accountPolicies`) are neither discovered, advertised, nor routable; `serve` leaves their accounts out of `/v1/usage` and `/v1/credentials/check`, and `check` skips their credentials. The gateway rebuilds the catalog every 15 minutes and checks credential changes every 10 seconds; credential changes force online discovery. Provider-qualified IDs are unambiguous; bare IDs use the first matching registry entry. Model-list rows also include `api`, `display_name`, `input_modalities`, available `context_length`/`max_output_tokens`, and `supports_tools: false` only when the catalog explicitly says tools are unsupported.

Live OpenRouter discovery covers image and Decisions rosters, `/embeddings/models`, `/videos/models`, and rerank-flagged `/models` rows. Speech/transcription models use catalog kinds and seeds. Bundled fallbacks and `kind-apis` runner mappings are authored in `packages/catalog/src/compat/rules/providers/openrouter.kdl`. Per-search, per-second, and per-character billing have no catalog cost axis, so those rows carry zero token cost and the provider-reported `cost` in the response is authoritative.

Inference routes record observed usage against `x-omp-install-id`, `x-omp-hostname`, and `x-omp-app`; unlabeled requests fall back to the gateway host's identity. These attribution headers are not forwarded upstream. Completed non-streaming responses carry computed cost in `x-litellm-response-cost` when known; streaming chat responses send headers before usage arrives and do not include that cost header. Video cost may become available only while polling. Upstreams that report tokens only (TypeSafe) are priced from the catalog model; the response body's own `cost` field (OpenRouter shape) is only present when the upstream billed one.

TypeSafe clients using the default base-URL resolver can set `TYPESAFE_BASE_URL=http://gateway:4000` with `TYPESAFE_API_KEY=<gateway token>`. omp's catalog-backed `judge` role passes the model's explicit `baseUrl`, which takes precedence over that environment fallback; configure the TypeSafe provider's `baseUrl` and `apiKey` in `models.yml` to use the gateway. OpenAI-SDK-style clients use `http://gateway:4000/v1`.

There is no raw provider passthrough path. All supported routes go through `pi-ai` provider logic so credential-specific request shaping, OAuth refresh-on-auth-error, and provider quirks stay centralized.

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches successful per-credential `UsageReport`s in the broker's SQLite store with a **5-minute TTL and ±25 % jitter** to stagger upstream probes. Cached good values receive a 24-hour durable retention window. On fetch failure, providers normally retain the last-good report and apply a short jittered cooldown (default 10 s); a provider can override this policy. Definitive auth failures purge stale usage, and explicit invalidation does not replay invalidated last-good data.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000` in `packages/ai/src/auth/sqlite-credential-store.ts`; `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` and `USAGE_FAILURE_BACKOFF_MS = 10_000` in `packages/ai/src/auth/usage-cache.ts`. Fetch policy is in `packages/ai/src/auth/usage.ts`.

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` coalesces concurrent calls into a single `GET /v1/usage` round-trip and caches the result for **15 s** in memory.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the error is logged and `null` is cached for 15 s, so sequential callers do not immediately retry a failed broker. Aggregate usage returns `null`; a per-credential lookup may still use a fresh client-observed header overlay.
- Fresh provider response-header hints are overlaid on matching reports for up to 15 s.

The client window is shorter than the broker's per-credential cache and coalesces the usage lookups used by `CredentialSelector` (`packages/ai/src/auth/select.ts`) into a single broker round-trip.

## Client snapshot cache

`discoverAuthStorage()` delegates to `packages/ai/src/auth-broker/discover.ts`, which persists the initial live snapshot and later broker-sourced full snapshots to `~/.omp/cache/auth-broker-snapshot.enc` by default. The file is AES-256-GCM encrypted with SHA-256 of the resolved broker bearer token (whether from env, config, or file) and authenticated with the broker URL and cache format metadata. Changing the token or URL makes the cache unreadable. Writes are atomic with mode `0600`.

Freshness is anchored to `snapshot.generatedAt`, not local write time. Default TTL is 1 h (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`); `0` disables cache reads and writes. A fresh cache is used immediately without a blocking revalidation or startup request budget. `RemoteAuthCredentialStore` then synchronizes through SSE/long polling in the background, so one-shot commands are not guaranteed to observe changes made after the cache was written. Revocation of the broker token surfaces through that background path rather than necessarily failing cached startup. Expired OAuth access tokens still require the broker refresh endpoint.

If the broker is down at boot and a fresh cache exists, startup succeeds from the cache. If the cache is missing, expired, corrupt, incompatible, written for another URL, or encrypted with another token, startup requires a live snapshot and fails when that fetch fails; it never silently opens the local credential store instead.

## Client account pools (routing, not authorization)

Broker clients can restrict their visible OAuth accounts by setting `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` to a JSON file. The file maps provider IDs to exact `identityKey` values from the broker snapshot protocol:

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

`identityKey` is the token-free identity field already carried by each authenticated `/v1/snapshot` credential entry. Operator tooling should project only `provider` and `identityKey`; it must not retain or print the accompanying credential payload. A dedicated account-listing CLI is intentionally outside this routing feature's scope.

SDK hosts can supply the same provider-to-identity mapping as `accountPool` in `discoverAuthStorage()` or `RemoteAuthCredentialStore`. An explicit programmatic pool takes precedence over the environment file.

- A missing provider is unrestricted.
- An empty array hides every OAuth credential for that provider.
- A non-empty array exposes only exact identity matches, including organization/workspace qualifiers.
- API-key credentials remain visible; the pool applies only to OAuth accounts.

The file is parsed once when broker-backed auth storage starts. An unreadable file, malformed JSON, or invalid provider entry aborts initialization rather than silently broadening the pool. Full snapshots, SSE updates, refresh responses, and aggregate usage are filtered consistently. For a provider named in the pool, aggregate reports are returned only when they can be attributed to a visible OAuth identity; reports attributable only to an API key or lacking matching identity metadata fail closed. The encrypted snapshot cache remains a raw broker snapshot so trusted processes sharing that cache can apply different pools.

This is a **trusted-client routing policy, not an authorization boundary**. The client still holds a broker bearer token, receives raw broker responses before applying its local view, and can call broker endpoints directly. Use server-side authorization—not account pools—when clients must be prevented from retrieving other credentials.

### Per-agent and per-session pools

A process-wide pool decides which accounts a client sees; a session pool narrows one session further with the same identity keys, which `omp usage accounts` lists for every OAuth account the process sees (with organization names and no tokens). Set `task.agentAccountPools` to pool a task agent by exact name ([Settings](./settings.md#providers-and-services)), pass `oauthAccountPools` to `createAgentSession()`, or call `authStorage.sessions.restrict(provider, sessionId, identityKeys)` directly. For each listed provider the session authenticates only with visible OAuth accounts in its list: selection, pins, fallback passes, and rotation stay inside it, stored, runtime, and environment API keys are never used, and a request fails rather than borrow another account when none can serve. A config key (a `models.yml` `apiKey`, often for a proxy `baseUrl`) also fails a pooled request, so no pooled OAuth token is sent to that endpoint. An empty list allows no account. A session created with `oauthAccountPools` enforces its pools on every key lookup through its model registry, whatever provider session id the lookup carries (title generation, skill compression, advisors, and subagents it spawns without their own entry); a lookup with no session id resolves under the session's own id. It lifts its pools when it is disposed, or, when a run outlives the dispose deadline, once that run settles. A direct `restrict` caller passes the lease that `restrict` returned to `authStorage.sessions.unrestrict(provider, sessionId, lease)` once that session ends; a lease never lifts a restriction installed on the same session since. Session pools are the same trusted-client routing policy as client pools, not an authorization boundary.

## Operator opt-in

Broker-backed credential storage is **off** unless `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in the agent's `config.yml`/`config.yaml`) is set. SDK discovery delegates through `packages/coding-agent/src/session/auth-broker-config.ts` to the shared `pi-ai` resolver and selects `RemoteAuthCredentialStore` instead of local SQLite. Runtime/config/env key overrides still participate in the normal credential ladder; selecting broker storage does not make those keys remote.

### Environment variables

| Variable                            | Purpose                                                                                                                                                                | Required when                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed.                     | Any time the omp client should resolve credentials through a broker (and required by `omp auth-gateway serve`).           |
| `OMP_AUTH_BROKER_TOKEN`             | Bearer token used for every broker endpoint except `/v1/healthz`.                                                                                                      | When `OMP_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`. |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | Freshness window for the encrypted local snapshot cache. Default `3600000` (1 h); `0` disables cache reads and writes.                                                 | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | Path override for the encrypted local snapshot cache. Default `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent).                                       | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | JSON file mapping provider IDs to OAuth `identityKey` values visible to this trusted client. Parsed once; invalid files abort initialization. API keys are unaffected. | Optional in broker mode.                                                                                                  |

Resolution order in `resolveAuthBrokerConfig()`:

1. `OMP_AUTH_BROKER_URL` env (else `auth.broker.url` from `config.yml`, resolved through `resolveConfigValue`);
2. `OMP_AUTH_BROKER_TOKEN` env (else `auth.broker.token` from `config.yml`, else `<config-dir>/auth-broker.token`);
3. URL set but no token resolvable → hard error pointing at the token file path.

The gateway uses the same broker URL/token resolution and account-pool environment file. Its `serve`/`check` commands fetch a live snapshot directly, so the client snapshot-cache path/TTL variables do not affect those commands.

### `config.yml` keys

| Key                 | Default | Purpose                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | unset   | Same as `OMP_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. Values are resolved as a literal, an environment variable name, or `!<shell command>` to use trimmed stdout. |
| `auth.broker.token` | unset   | Same as `OMP_AUTH_BROKER_TOKEN`; env wins. Values are resolved the same way.                                                                                                       |
| `auth.accountPolicies` | `[]` | Per-account OAuth routing rules: `provider`, identity selector `account` (`email`, `accountId`, `projectId`, optional `orgId`), optional `priority`, `reservePct` (0–100), and `taperHours` (≥ 0). |
| `retry.usageReservePct` | `10` | Default protected remaining-quota percentage when an account has no `reservePct` override. |
| `retry.usageReserveTaperHours` | `0` | Default hours before each window's reset over which the reserve releases linearly to 0 when an account has no `taperHours` override; `0` keeps reserves static. |

Broker connection values come from the agent's main config file, not project settings. Account policies/reserve use effective settings (including project/explicit config layers). Long-lived SDK sessions follow policy changes and can replace the credential store in place when effective broker settings change; failed changes leave the current store active.

#### How sessions choose and keep an account

When a provider has account policies, OMP ranks its accounts whenever it selects or reconsiders one (not on every request: a warm explicit pin, or a sole account, skips ranking). In order, an account loses when it is blocked (hit a limit), outside a required plan, past its renewable allowance, or inside its reserve; then Codex accounts with an untouched 5-hour window are preferred, accounts whose 5-hour window is at least 85% used fall back, accounts with a usage report beat accounts whose report could not be fetched, and only then does higher `priority` win. Ties go to the account whose quota would otherwise expire unused soonest. So `priority` orders healthy, measured accounts; it does not override reserve or the safety checks before it.

That ranking picks the account for a **new** session. A running session remembers the account it used last (its pin) and keeps it while the pin is warm, so the provider's prompt cache and signed reasoning stay valid:

- Anthropic pins go cold after an hour without a request; other providers' pins stay warm indefinitely. A cold or blocked pin re-ranks.
- A warm pin moves only away from a bad account: when the pinned account enters its reserve and another account is measured outside its own reserve, or when its allowance is spent and an unblocked sibling still has allowance.
- A warm pin does not move back when a higher-priority account recovers. New sessions use the recovered account; running ones stay where they are until one of the cases above applies.
- An account the user chose explicitly for a session is never moved by ranking or reserve. It is still skipped while blocked, after a failed token refresh, or when it fails a required plan check; the session then falls through to a sibling.
- Pins are saved with the session. A resumed session restores its pin with its original last-use time, and subagents start on their parent's pins. When a parked subagent is revived in the same session, its saved pin wins over the parent's automatic affinity; an explicit parent pin still wins, subject to the child's account pool.

### Token files

| Path                              | Owner                                                | Mode                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker token` or `serve` | `0600`; new parent directory `0700` |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway token` or `serve` (serve skips it under `--no-auth`) | `0600`; new parent directory `0700` |

`<config-dir>` is `getConfigRootDir()`: `~/.omp/` by default, respecting `PI_CONFIG_DIR` and the active profile (`~/.omp/profiles/<name>/` for the default profile layout). Creating a token does not tighten permissions on an already-existing parent directory.

## Interaction with the local API-key resolution order

The broker owns credentials written on its host or uploaded through its API. The standard credential ladder in [models.md](./models.md) is preserved:

- `AuthStorage.keys.setConfig()` / `.removeConfig()` / `.clearConfig()` manage config keys. An explicit `models.yml` `apiKey` beats stored OAuth **without** overriding `--api-key`; `setConfig(..., { fallback: true })` instead ranks a default key reference below stored OAuth and `/login` keys. The gateway deliberately ignores local model-config overrides.

## See also

- [`secrets.md`](./secrets.md) — secret obfuscation around tokens that _do_ leak through (e.g. `OMP_AUTH_BROKER_TOKEN` in shell output).
- [`models.md`](./models.md) — provider auth resolution order; the broker supplies the stored-credential layers.
- [`environment-variables.md`](./environment-variables.md) — full env reference including `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`.
