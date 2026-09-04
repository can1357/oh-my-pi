# Auth Broker and Auth Gateway

The auth broker and auth gateway are two cooperating HTTP services that move OAuth refresh tokens and provider access tokens off developer laptops and into a single broker host.

- **`omp auth-broker serve`** holds the canonical SQLite credential vault, performs OAuth refreshes, and exposes snapshot, credential, block, usage, and health APIs under `/v1`.
- **`omp auth-gateway serve`** is a forward-proxy. It accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and pi-native stream requests, resolves the broker-backed credential, and dispatches through `pi-ai` provider logic. Clients (containerised omp, llm-git, the macOS usage widget, …) never see the access token.

Transport security between operator, broker, and gateway is delegated to the operator (Tailscale / Wireguard / reverse proxy + TLS). Every endpoint except `/v1/healthz` (broker) and `/healthz` (gateway) requires a bearer token.

Source: `packages/ai/src/auth-broker/`, `packages/ai/src/auth-gateway/`, `packages/coding-agent/src/cli/auth-broker-cli.ts`, `packages/coding-agent/src/cli/auth-gateway-cli.ts`, `packages/coding-agent/src/session/auth-broker-config.ts`.

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

The broker is the only writer of OAuth refresh tokens. Clients (including the gateway itself) load a redacted snapshot in which every `refresh` field has been replaced with `REMOTE_REFRESH_SENTINEL`; when an access token expires the client calls `POST /v1/credential/:id/refresh` and the broker performs the refresh server-side. `RemoteAuthCredentialStore` rejects local replace/upsert/delete-by-provider mutations, with errors pointing at `omp auth-broker login` / `omp auth-broker logout`.

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port]                    # boot the broker
omp auth-broker token     [--regenerate] [--json]               # print or rotate the bearer token
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` opens the local SQLite store at `getAgentDbPath()` and binds an HTTP listener (default `127.0.0.1:8765`). On startup a token is ensured at `<config-dir>/auth-broker.token` (mode `0600`, `0700` parent dir). The background refresher refreshes any OAuth credential whose `expires - Date.now() < refreshSkewMs` (default 5 min) every `refreshIntervalMs` (default 60 s).
- `token` prints the cached bearer or generates a new one. `--regenerate` rotates it.
- `login [<provider>]` runs the per-provider OAuth flow locally — when no provider is supplied, it falls back to an interactive numbered picker. With `--via=user@host` it shells out `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host omp auth-broker login <provider>` so the OAuth callback hits the local browser but the credential is written on the broker host (`--via` requires `<provider>`). Built-in callback ports: `anthropic:54545`, `openai-codex:1455`, `google-gemini-cli:8085`, `google-antigravity:51121`, `gitlab-duo:8080`, `devin:59653`, `gitlab-duo-agent:8080`, `zai-coding-plan:9999`. The OAuth dance is driven in-process via `AuthStorage.login()` — there is no longer a `pi-ai` bin to spawn.
- `logout [<provider>]` deletes every credential row for `<provider>`. With no argument it shows an interactive numbered picker of currently-stored providers.
- `list` enumerates every registered OAuth provider id/name (the union of built-ins + `registerOAuthProvider` custom providers). `--json` emits a machine-readable array.
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
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | Delete all rate-limit blocks for a credential                      |
| `GET`    | `/v1/usage`                  | bearer | Aggregate current `UsageReport[]` across credentials               |
| `GET`    | `/v1/usage/history`          | bearer | Persisted usage history; optional `sinceMs` and `provider` filters |
| `POST`   | `/v1/usage/observed`         | bearer | Record usage observed by a broker client                           |
| `GET`    | `/v1/usage/clients`          | bearer | Summarize client-observed usage since optional `sinceMs`           |
| `POST`   | `/v1/usage/stale`            | bearer | Invalidate the broker's current usage cache                        |

Requests use `Authorization: Bearer <token>`. The server compares against an in-memory token allow-list; the gateway’s implementation uses a timing-safe comparison.

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

Every `200`, `304`, and `499` snapshot response carries the current generation
as a quoted `ETag`, plus `Cache-Control: no-store` and
`Vary: OMP-Auth-Broker-Capabilities`.

### Codex block-scope compatibility

Clients that understand per-meter Codex blocks send `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`. Snapshot responses then carry the canonical `chat` and `spark` scopes. Without that capability, the broker projects those rows to the legacy `shared` scope on the wire.

Local SQLite schema 7 keeps `chat` and `spark` as the canonical scopes exposed by current store APIs. It also maintains a physical `shared` compatibility mirror for pre-meter binaries that read `agent.db` directly. SQLite triggers derive that mirror's deadline and update time independently from the meter rows, and copy a legacy process's `shared` writes back to both meters. Current store APIs omit the physical mirror, so broker snapshots and model selection do not double-count it.

Clients released before this capability, including 17.1.4, receive the conservative `shared` projection until they are upgraded. Those clients are indistinguishable on the existing wire, so mixed-version deployments favor keeping a rate-limited credential blocked over allowing repeated provider requests and 429 responses.

Capability-dependent responses include `Vary: OMP-Auth-Broker-Capabilities` so intermediaries do not reuse one representation for another client. The encrypted client snapshot cache also uses a new format version: older cache files are ignored and fetched again, preventing legacy and meter-scoped representations from being mixed across client versions.

### Background refresher

`AuthBrokerRefresher` iterates active OAuth credentials at `refreshIntervalMs` cadence and refreshes any within `refreshSkewMs` of expiry. Refreshes are single-flighted per credential id so a slow refresh cannot be retriggered. The refresher distinguishes:

- **definitive failures** (`invalid_grant`, `invalid_token`, `revoked`, unauthorized refresh-token, 401/403 not from a network blip) — credentials are passed to `AuthStorage.disableCredentialById(id, cause)` so the next snapshot pull surfaces a clean delete on the client;
- **transient failures** (timeout / ECONNREFUSED / fetch failed) — left in place for the next sweep.

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth]
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` requires `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) — the gateway is itself a broker client. It calls `AuthBrokerClient.fetchSnapshot()`, wraps it in `RemoteAuthCredentialStore`, and constructs an `AuthStorage` that resolves access tokens through the broker. Default bind is `127.0.0.1:4000`. The gateway token is stored at `<config-dir>/auth-gateway.token` (`0600`); `--no-auth` disables the bearer check entirely (loopback-only use).
- `token` / `status` manage and inspect the gateway bearer token and upstream broker readiness.
- `check` probes broker-backed credentials through the gateway store. Without `--strict` it uses provider usage probes; `--strict` also exercises each credential against its chat-completion endpoint and can consume a small amount of quota.

### Endpoints

| Method | Path                    | Auth   | Purpose                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | none   | Liveness + version                                           |
| `GET`  | `/v1/usage`             | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`)    |
| `GET`  | `/v1/models`            | bearer | Bundled-model catalog filtered to providers with credentials |
| `GET`  | `/v1/credentials/check` | bearer | Per-credential auth health probe                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions wire format                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages wire format                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses wire format                                 |
| `POST` | `/v1/pi/stream`         | bearer | Native `pi-ai` stream wire format                            |

The model id is read from the top-level `model` field for foreign wire formats and from the pi-native request body for `/v1/pi/stream`. The gateway picks the first bundled `Model<Api>` matching that id, parses the inbound wire format into an omp `Context`, resolves the provider credential from broker-backed `AuthStorage`, dispatches through `streamSimple()`, and re-encodes the result to the inbound format (SSE for streamed responses).

There is no raw provider passthrough path. All supported routes go through `pi-ai` provider logic so credential-specific request shaping, OAuth refresh-on-auth-error, and provider quirks stay centralized.

`idleTimeout` on the underlying `Bun.serve` is set to `255 s` so long thinking-budget calls do not get killed by Bun’s default idle timeout.

## Usage cache: server-side 5-min jitter + client-side 15 s single-flight

Two layers cache the aggregate provider-usage report. Both are intentional and stacked.

### Server-side cache (broker `AuthStorage`)

`AuthStorage` caches each credential’s `UsageReport` in the broker’s SQLite store at a **5-minute per-credential TTL with ±25 % jitter**. Anthropic and OpenAI rate-limit `/usage` aggressively per source IP, and a synchronized 5-credential fan-out trips 429s every cycle; the jitter decorrelates refresh times within a few cycles. On fetch failure the store keeps the **last-good** report for up to 24 h with a short jittered re-poll window — so a transient upstream blip never blanks out the widget.

Constants: `USAGE_REPORT_TTL_MS = 5 * 60_000`, `USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000` (`packages/ai/src/auth-storage.ts`).

### Client-side single-flight (`RemoteAuthCredentialStore`)

When the gateway (or any other broker client) calls `fetchUsageReports()` / `getUsageReport(provider, credential)`, `RemoteAuthCredentialStore` coalesces concurrent calls into a single `GET /v1/usage` round-trip and caches the result for **15 s** in memory.

- `USAGE_CACHE_TTL_MS = 15_000` (`packages/ai/src/auth-broker/remote-store.ts`).
- A single `#usageInflight` promise is shared across all callers; a per-caller `AbortSignal` is **raced** against the shared promise, not threaded into it, so one caller’s abort never cascades into a peer’s in-flight request.
- On fetch failure the rejected promise is logged and the awaited value is `null` — callers (`AuthStorage.fetchUsageReports`, `#getUsageReport`) treat a `null` report as "no usage signal for this cycle" and proceed without it. **This is the 15 s TTL fallback**: the client absorbs transient broker outages by suppressing the error, returning `null` to ranking, and re-attempting after the 15 s window.

The 15 s client window deliberately sits below the broker’s 5 min server cache, so almost every client poll is served from the broker’s already-cached value; the client cache exists to absorb the parallel fan-out generated by `AuthStorage.#rankOAuthSelections` into a single broker round-trip.

## Client snapshot cache

`discoverAuthStorage()` persists the broker snapshot to `~/.omp/cache/auth-broker-snapshot.enc` after the initial `/v1/snapshot` fetch and after later broker-sourced full snapshots. The file is AES-256-GCM encrypted with `SHA-256(OMP_AUTH_BROKER_TOKEN)` and authenticated with the broker URL as additional data, so changing either the token or URL makes the cache unreadable. The file is written atomically with mode `0600`.

Freshness is anchored to the broker-stamped `snapshot.generatedAt`, not local write time. Default TTL is 1 h (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`); `0` disables cache reads and writes. A fresh cache is revalidated against a reachable broker with a 500 ms startup budget, so an imported, revoked, or rotated credential is visible to one-shot commands immediately. If revalidation fails because the broker is unavailable or slow, `omp` starts from the cache and `RemoteAuthCredentialStore` continues normal SSE / long-poll synchronization in the background. Expired OAuth access tokens still refresh through `POST /v1/credential/:id/refresh`.

If the broker is down at boot and a fresh cache exists, startup succeeds from the cached snapshot. Authentication failures (401/403) are not masked by the cache; transient server errors fall back to it. If the cache is missing, expired, corrupt, written for a different URL, or encrypted with a different token, startup falls back to the live fetch and fails if the broker is unreachable.

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

## Operator opt-in

The broker is **off** unless `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) is set. When set, `discoverAuthStorage` in `packages/coding-agent/src/sdk.ts` swaps the local SQLite credential store for `RemoteAuthCredentialStore` and every API call resolves credentials through the broker.

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

The gateway has no dedicated env vars — it inherits `OMP_AUTH_BROKER_*` because it is itself a broker client.

### `config.yml` keys

| Key                 | Default | Purpose                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | unset   | Same as `OMP_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. Values are resolved as a literal, an environment variable name, or `!<shell command>` to use trimmed stdout. |
| `auth.broker.token` | unset   | Same as `OMP_AUTH_BROKER_TOKEN`; env wins. Values are resolved the same way.                                                                                                       |

### Token files

| Path                              | Owner                                                | Mode                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker serve` (created at first start)     | `0600` in a `0700` parent dir |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway serve` (skipped under `--no-auth`) | `0600` in a `0700` parent dir |

`<config-dir>` resolves to `~/.omp/` (respecting `PI_CONFIG_DIR`).

## Interaction with the local API-key resolution order

The broker only owns OAuth credentials and provider-API-key credentials that were uploaded to it. The standard credential ladder in `models.md` (`Auth and API key resolution order`) is preserved, with one addition committed alongside the gateway:

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` let a `models.yml` `apiKey` beat a stored OAuth token **without** overriding an explicit `--api-key`. This is what allows a broker-resolved OAuth credential to be reliably shadowed by a per-environment `models.yml` config key when both are present.

## See also

- [`secrets.md`](./secrets.md) — secret obfuscation around tokens that _do_ leak through (e.g. `OMP_AUTH_BROKER_TOKEN` in shell output).
- [`models.md`](./models.md) — provider auth resolution order; the broker supplies the stored-credential layers.
- [`environment-variables.md`](./environment-variables.md) — full env reference including `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`.
