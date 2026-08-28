# Shared State Broker

The shared-state broker extends `omp auth-broker serve` from a credential vault into a full replication hub for everything under `~/.omp/agent/`. It lets prompt history, session titles, model/command usage ranking, agent config, and session bodies follow you across machines while every read stays local, synchronous, and offline-capable.

It reuses the same broker host, bearer token, and transport-security model as the [auth broker and gateway](./auth-broker-gateway.md); the state surface is mounted on the same listener under `/v1/state`.

Source: `packages/coding-agent/src/state-broker/`, `packages/ai/src/auth-broker/server.ts`, `packages/coding-agent/src/session/{history-storage,title-index,agent-storage,blob-store}.ts`.

## Design: local SQLite stays authoritative

The local SQLite databases remain the authoritative, synchronous read path. This is the load-bearing decision, not an implementation detail.

The TUI render paths call into these stores **synchronously**:

- `HistoryStorage.getRecent()` / `HistoryStorage.search()` — prompt history recall
- `lookupSessionTitle()` — resolving a session's current title
- `AgentStorage.getModelUsageOrder()` — most-recently-used model ordering
- `AgentStorage.listCommandUsage()` — slash-command frequency ordering

Making any of these remote or async would force a refactor of the render loop. So the broker is **not** a remote read path. It is a background replication hub:

- **Reads** are unchanged: local, synchronous, straight off the local DB.
- **Writes** are unchanged: local first; a background loop then pushes deltas to the broker.
- A background loop **pulls** remote deltas and merges them into the local DB.
- The system is fully functional offline. Sync is best-effort and never throws into a caller — failures are logged and the process degrades to local-only operation.

This mirrors the proven shape of `RemoteAuthCredentialStore`: background sync, local cache, best-effort convergence.

Replication is **off by default**. With `state.sync.enabled: false` (the default) behavior is byte-identical to a build without this feature: no new files are created, no new databases are opened, and there is no added startup cost. Turning it on adds only the background push/pull loop and a small `state-sync.db` holding replication cursors — the replicated databases themselves are never altered, never gain columns, and never bump their schema version.

## Two counters: `rev` versus `seq`

Replication tracks two independent counters. Conflating them corrupts convergence.

- **`rev`** — a **per-entry logical clock** (epoch milliseconds). It is the last-writer-wins merge key: an incoming entry is accepted only when its `rev` is strictly greater than the stored `rev` for that key. Every domain reuses a column that **already exists** in its table (`history.created_at`, `session_titles.updated_at`, `model_usage.last_used_at`, or a file's mtime), so replication adds no columns and bumps no schema version. An entry whose `value` is `null` is a **tombstone**.
- **`seq`** — a **per-domain monotonic broker sequence**. It is only a delta cursor: a client passes the `seq` from its last pull as the next `since=`, and the broker returns everything accepted after it. `seq` says nothing about which write is newer; only `rev` decides that.

`changedSince(afterRev, limit)` returns entries ordered by **ascending `rev`**, because the sync engine advances its watermark to the last entry's `rev` — an out-of-order page would permanently skip rows. An empty return means "nothing to send", which leaves the watermark where it is, so a domain must never hand back a page it filtered to empty: eligible rows sitting beyond the limit would then never replicate. Filter **during** the scan (project scoping in SQL, before `LIMIT`), and where a predicate cannot be expressed in the query — `history`'s 4096-unit key cap, an unresolvable cwd — scan **forward** to the next page instead of returning nothing. `applyRemote` is idempotent (LWW makes replays safe) and drops a single malformed entry with a log line rather than aborting the batch.

The outbound watermark only ever moves on the **push** path, and never past the local clock. Merging a remote entry deliberately leaves it alone: remote `rev`s carry the originating machine's clock, so letting one drag the watermark forward would mute every local write below it until this machine's clock caught up. Echoes are suppressed with a per-key ledger instead, which is an optimization — losing it costs a redundant push that the broker rejects, never a lost row.

## Replicated domains

Each domain is a thin adapter over an existing local store. It answers exactly two questions — "which of my rows changed after `rev` X?" and "merge these rows into me" — and owns no sync bookkeeping (cursors live in `state-sync.db`).

| Domain          | Replicates                              | Local store                    | `rev` column               | Merge rule                                                        |
| --------------- | --------------------------------------- | ------------------------------ | -------------------------- | ---------------------------------------------------------------- |
| `history`       | Prompt history entries                  | `history.db` (`HistoryStorage`)| `history.created_at`       | LWW by `rev`; no delete path, so tombstones are ignored           |
| `titles`        | Session current titles                  | `title-index` (`agent.db`)     | `session_titles.updated_at`| LWW by `rev`; a `user` title is never overwritten by an `auto` one|
| `model-usage`   | Most-recently-used model ordering       | `agent.db` (`AgentStorage`)    | `model_usage.last_used_at` | LWW by `rev` (keep the greater last-used timestamp)              |
| `command-usage` | Slash-command usage counts/recency      | `agent.db` (`AgentStorage`)    | usage `last_used_at`       | LWW by `rev`                                                     |
| `config`        | Agent config files (see exclusions)     | files under `~/.omp/agent/`    | file mtime                 | LWW by `rev`; inbound keys re-checked against the replicable set; deleting a file publishes a tombstone |
| `sessions`      | Session JSONL index rows                | session index (`agent.db`)     | file mtime                 | LWW by `rev`; bodies replicate out-of-band via the object store |

### What is intentionally NOT replicated

- **`model-perf`** — model throughput/latency measurements. These measure the **local network path** from *this* machine to each provider and feed TPS-based model selection. Copying another machine's timings would poison ranking with numbers that don't describe the local link, so `model-perf` stays strictly local.
- **`models.db`** — a pure derived cache of the bundled/discovered model catalog. It is rebuilt on demand and `omp models` already documents deleting it as a supported reset, so there is nothing worth shipping across the wire.
- **`cache/`** — derived caches (including the encrypted auth-broker snapshot). Everything here is reconstructable from an authoritative source; replicating it would only move stale derived bytes around.

### Config-domain exclusions

The `config` domain replicates hand-editable agent configuration (for example `config.yml`, `models.yml`, and similar declarative files), but deliberately **excludes secret-bearing files**:

- **`.env`** — process/provider secrets and API keys.
- **`secrets.yml`** — configured secret-obfuscation material.
- **`secret-placeholder.key`** — the local key protecting obfuscated secrets.

These are never pushed and never accepted on merge. Secrets stay machine-local by design: the broker already owns OAuth/API credentials through the auth surface, and per-machine `.env`/secret material is exactly what should *not* fan out to every peer. `applyRemote` on the config domain additionally guards against path traversal so a remote entry can never escape the agent directory (see [Security](#security)).

## Project scoping

Replication is **per-project**, not per-machine. This section covers how a session recorded on one machine finds its way to the *same logical project* on another, even when the two checkouts live at different absolute paths.

### The portability problem

Two identifiers the local stores rely on are meaningless on another machine:

- **Session directory names are path-derived.** `session-paths.ts:getDefaultSessionDirName` encodes the home-relative cwd into the directory name, so a project at `~/projects/foo` becomes `-projects-foo` while the *same* project checked out at `~/dev/foo` becomes `-dev-foo`. Ship the bytes verbatim and they land in the wrong directory.
- **`history.cwd` is an absolute local path.** `/home/alice/projects/foo` says nothing about where `/home/bob/dev/foo` keeps the same repo.

Neither survives a machine hop. Everything crossing the replication boundary is therefore rewritten through a portable *logical project id* instead.

### Logical project ids and `projects.yml`

Each machine keeps a small registry at `~/.omp/agent/projects.yml` mapping a logical project id to *this machine's* checkout path plus a per-project sync toggle. The id is shared verbatim by every machine that holds the project; the path is local and differs between machines.

```yaml
version: 1
projects:
  - id: "git:github.com/octocat/foo" # shared, machine-independent
    path: /home/alice/projects/foo # this machine's checkout
    sync: true # replicate this project's sessions and history
```

The shape is defined by `config/projects-config.ts`: a `ProjectEntry` is exactly `{ id, path, sync }`, wrapped in `{ version, projects }` (`PROJECTS_CONFIG_VERSION` is `1`). A missing or malformed registry loads as an empty list — an unreadable registry degrades to "nothing is synced", never a crashed session. Writes are atomic (temp-file + rename) so a crash mid-write cannot strand a half-serialized registry that would silently stop all replication.

### Identity derivation

A project id is resolved **once, at registration time, by the `omp project` CLI** — never on a sync path:

1. An explicit `--id` wins.
2. Otherwise the git origin remote is normalized by `projectIdFromRemoteUrl`. Both `git@github.com:octocat/foo.git` and `https://github.com/octocat/foo` collapse to `git:github.com/octocat/foo`, so two machines that cloned the same repo over different transports still agree. Registration records the **repository root**, not the subdirectory you ran the command in.
3. A repo with no usable remote and no `--id` is an error — better to make you name the project than to invent an id that will not match the other machine.

Git is consulted **only** here. The replication hot path (`ReplicatedDomain.changedSince`) is **synchronous** and must never shell out; it reads only the already-resolved `projects.yml` snapshot (cached with a short TTL so `omp project enable` in another terminal is picked up without re-reading YAML on every row). Path resolution uses canonicalized paths (symlinks resolved), the same normalization the session directory naming applies, and the deepest matching project wins so a nested checkout beats its parent.

### Fail closed

Resolution fails **closed**. A cwd that does not resolve to a registered project — or resolves to one with `sync: false` — replicates **nothing**: no sessions, no prompt history, no titles, no blob uploads. The scope helpers enforce this: `toWirePath` (and the `resolveProject` it wraps) returns `undefined` for any path outside a `sync: true` project so outbound domains skip those rows; `fromWirePath` / `projectById` return `undefined` for any wire id this machine has not mapped (or has disabled) so inbound domains drop those rows. An un-namespaced wire key (one lacking the `\u0000` id/path separator) is rejected rather than treated as a bare path, so a pre-scoping or corrupt peer can never write remote data into an unmapped location.

### `projects.yml` is never replicated

The registry itself is deliberately **not** a replicated domain and is excluded from the `config` domain's file set. It is inherently machine-specific — the `path` field names *this* host's checkout, which is wrong everywhere else — and fanning it out would also let one machine flip another's `sync` toggle. Each machine declares its own mapping locally; only the shared *id* travels.

### Per-domain scoping

| Domain          | Project-scoped?                     | Outbound (push)                                                                                             | Inbound (merge)                                                                                                              |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `history`       | **yes**                             | The prompt stays the merge key; entries are filtered by `cwd` to synced-project path prefixes **in SQL, before the page limit**, and the absolute `cwd` in the value is replaced with `{projectId, rel}` (a null `cwd` is excluded). | The local `cwd` is reconstructed from `projectId` + `rel`; rows for an unknown or `sync: false` project are skipped. A legacy value carrying a bare `cwd` string and no `project` is accepted with `cwd` dropped, not rejected. |
| `titles`        | **yes** (strict out / permissive in)| Only titles whose session id belongs to a `sync: true` project's session directory are pushed, intersected **before the page limit**. Titles carry no path, so there is nothing to translate — scoping is purely by session-id membership. | Accepted permissively (see below).                                                                                          |
| `sessions`      | **yes**                             | Only sessions whose directory belongs to a `sync: true` project are scanned and uploaded; index wire rows are keyed `<id>\u0000<file>.jsonl` (bare filename, the directory implied by the project). | Wire key resolved to the local project path; the downloaded body's header `cwd` is rewritten to that path (see below).       |
| `model-usage`   | **no** — global user preference     | Replicated wholesale, unchanged.                                                                           | Replicated wholesale, unchanged.                                                                                            |
| `command-usage` | **no** — global user preference     | Replicated wholesale, unchanged.                                                                           | Replicated wholesale, unchanged.                                                                                            |
| `config`        | **no** — global user preference     | Replicated wholesale, unchanged.                                                                           | Replicated wholesale, unchanged.                                                                                            |

Most-recently-used model ordering, slash-command frequency, and hand-edited agent config describe **you**, not a repository, so they intentionally stay global and are never keyed by project. Only history, titles, and session bodies — the things anchored to a working directory — are scoped.

### Titles: strict outbound, permissive inbound

The `titles` domain is keyed by session id, and the direction of scoping is asymmetric on purpose:

- **Outbound is strict** (fail closed): a title is pushed only when its session id belongs to a `sync: true` project's session directory, so a title for an unregistered or disabled project never leaks to the broker. The synced-session-id set is intersected before the page limit so a filtered page never stalls the delta cursor.
- **Inbound is permissive**: a well-formed remote title is merged even if the session body has not arrived yet and even if this machine has no local mapping for that project. A title is a short display string carrying no path — storing it leaks nothing — and a peer often receives the title before the session it labels; refusing would drop a title it cannot recover. Merge stays last-writer-wins by `rev`.

### Cross-machine session bodies

Session JSONL bodies replicate out-of-band through the object store (see below), but the body carries the recording machine's absolute cwd in its header. On download the header line is rewritten in place: `cwd` is set to **this machine's project path** and `additionalDirectories` under the origin root are remapped onto the local root, so resuming a session pulled from another machine adopts it and enters the right directory rather than degrading to `fallbackRuntimeOnly` — the runtime-only state `SessionManager` falls into when a header cwd is not enterable. The 256-byte title slot on the first line is preserved byte-for-byte.

Project-scoped bodies live under a per-project slug in the object store:

```text
<keyPrefix>/sessions/<projectObjectSlug>/<file>.jsonl
```

`projectObjectSlug(projectId)` returns `readable-<hash16>` — a sanitized readable fragment plus the first 16 hex chars of the id's SHA-256. Project ids contain `/` and `:` (`git:github.com/octocat/foo`), which would otherwise explode into unintended key hierarchy; the digest guarantees two distinct ids can never collide on the readable fragment alone.

### Worked example: two machines, one project

Machine **A** holds the project at `~/projects/foo`; machine **B** holds the same repo at `~/dev/foo`.

On **A**, enable sync from inside the checkout — the derived id is printed so you can carry it to the other machine:

```bash
cd ~/projects/foo
omp project enable
# registered git:github.com/octocat/foo (sync on) -> /home/alice/projects/foo
```

On **B**, declare that the same shared id maps to the local path, then turn sync on:

```bash
omp project add --id git:github.com/octocat/foo ~/dev/foo
omp project enable ~/dev/foo
```

Both machines now agree on `git:github.com/octocat/foo`. A session recorded in `~/projects/foo` on A replicates its history, title, and body; on B the wire key resolves to `~/dev/foo`, the downloaded body's header cwd is rewritten there, and resume works as if the session had been local. See [Settings](./settings.md#per-project-sync-scoping-omp-project) for the full `omp project` command reference.

## Wire surface

The state surface is mounted on the auth-broker listener under `/v1/state`. Bearer auth is enforced by the listener before any state handler runs — the same token that guards `/v1/snapshot`.

| Method | Path                                             | Auth   | Purpose                                                              |
| ------ | ------------------------------------------------ | ------ | ------------------------------------------------------------------- |
| `GET`  | `/v1/state`                                      | bearer | `StateSummaryResponse` — per-domain `seq`/entry counts; a cheap "anything changed?" probe |
| `GET`  | `/v1/state/:domain?since=<seq>&wait=<ms>&limit=<n>` | bearer | `StateDeltaResponse` — entries accepted after `since`, ascending by `rev` |
| `POST` | `/v1/state/:domain`                              | bearer | `StatePushRequest` → `StatePushResponse` — merge entries, report how many won LWW |

A delta response carries the broker `seq` after the last returned entry (pass it as the next `since`) and a `more` flag set when `limit` truncated the page — pull again immediately when it is true. `limit` is capped at `STATE_PAGE_LIMIT` (1000) entries per delta or push, and `wait` is clamped to `STATE_MAX_WAIT_MS` (30000 ms) for long-poll, matching the credential snapshot route. `:domain` must be one of `history`, `titles`, `model-usage`, `command-usage`, `config`, or `sessions`.

## Bulk content: session bodies and blobs go to S3

Session JSONL bodies and content-addressed blob bytes do **not** travel over the JSON broker. They are large and append-heavy — the wrong shape for a JSON HTTP delta protocol. Instead they replicate to an S3-compatible object store through Bun's builtin `Bun.S3Client` (no extra npm dependency; MinIO, Garage, and R2 work by pointing `objects.s3.endpoint` at them with `pathStyle: true`).

Key layout under the configured `keyPrefix` (default `omp`):

```text
<keyPrefix>/sessions/<projectObjectSlug>/<file>.jsonl  # session JSONL body, namespaced by logical project (see Project scoping)
<keyPrefix>/blobs/<sha256>       # one object per content-addressed blob
```

The object store is a **replicated archive, not the live write path**. S3 has no append operation, so the local JSONL file stays the authoritative, appendable log that the session runtime writes to; the archive is reconciled in the background. Blobs are content-addressed by `sha256`, so an upload is idempotent and a missing blob is fetched by hash on demand. Body/blob replication is gated by `objects.sessions` and `objects.blobs` respectively and requires `objects.backend: s3`.

## Setup

### On the broker host

Run the broker exactly as for credentials — the state surface mounts automatically on the same listener:

```bash
omp auth-broker serve --bind=0.0.0.0:8765
```

The bearer token is ensured at `<config-dir>/auth-broker.token` (mode `0600`). Object bytes go to whichever S3/MinIO endpoint the clients are configured for; the broker host itself needs no extra object-store setup.

### On each client

Point the client at the broker and the object store in `~/.omp/agent/config.yml`:

```yaml
state:
  broker:
    url: https://broker.tailnet:8765 # falls back to auth.broker.url when unset
    token: !cat ~/.omp/auth-broker.token # falls back to auth.broker.token when unset
  sync:
    enabled: true # off by default; nothing replicates until this is true
    domains: [history, titles, model-usage, command-usage, config, sessions]
    intervalMs: 30000

objects:
  backend: s3 # off by default
  sessions: true
  blobs: true
  s3:
    bucket: omp-state
    endpoint: https://minio.tailnet:9000 # MinIO/Garage/R2 endpoint
    region: us-east-1
    pathStyle: true # required for MinIO/Garage
    keyPrefix: omp
    accessKeyId: !cat ~/.omp/minio-access-key
    secretAccessKey: !cat ~/.omp/minio-secret-key
```

`state.broker.url` / `state.broker.token` fall back to `auth.broker.url` / `auth.broker.token` when unset, so a single broker URL/token pair configures both the credential and state surfaces. When `state.sync.enabled` is left `false` (or omitted) nothing above takes effect and behavior is identical to today. See [Settings](./settings.md#shared-state-and-object-store) for the full key reference and defaults.

## Security

The broker is a **trusted-ish peer**, not an adversary — the same trust model the auth broker already documents. The bearer token authenticates clients, and clients receive raw broker responses. Two guards apply regardless:

- **Path traversal on the config domain.** `applyRemote` on the `config` domain rejects any entry whose key would resolve outside the agent directory, so a compromised or buggy peer cannot write arbitrary paths on the host. Secret-bearing files (`.env`, `secrets.yml`, `secret-placeholder.key`) are excluded from replication entirely, so they are neither pushed nor accepted.
- **Path traversal on the session index.** The `sessions` wire key carries a filename and its value carries a project-relative cwd, both joined into a local path by the receiver. `applyRemote` accepts only a bare `*.jsonl` filename and a cwd with no `..` segment, and the resume picker independently re-checks that each rebuilt path stays inside the sessions directory — so an index file written by an older build cannot name a path outside it either.
- **Transport TLS is the operator's responsibility.** As with the auth broker and gateway, encryption between clients and the broker (and to the object-store endpoint) is delegated to the operator — Tailscale, WireGuard, or a reverse proxy terminating TLS. The broker itself binds plain HTTP.

## See also

- [`auth-broker-gateway.md`](./auth-broker-gateway.md) — the credential vault and gateway that share this listener, bearer token, and transport model.
- [`settings.md`](./settings.md#shared-state-and-object-store) — `state.*` and `objects.*` config keys and defaults.
- [`session.md`](./session.md) — session JSONL format, the blob store, and the local layout the `sessions` domain and object store replicate.
