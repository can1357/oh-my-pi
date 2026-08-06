# Prime Agent control-plane adaptation

Verified architecture and implementation plan for adapting Prime Agent's durable
control-plane and lifecycle patterns into Oh My PK (OMPK) without replacing
OMPK's existing execution harness. Status: plan — nothing here is implemented
yet, and each phase must end verified before the next begins.

## Repository identities

| Repo | Remote | Branch | Commit inspected | Inspection date |
| ---- | ------ | ------ | ---------------- | --------------- |
| Prime Agent | `github.com/PrimeIntellect-ai/prime-agent` | `main` | `c22549a37b73cc603c6f0d202517cb0ca856c7d3` | 2026-08-06 |
| Oh My PK | `origin: kingkillery/oh-my-pk`, `upstream: can1357/oh-my-pi` | `main` | `77a10a5d89d7e05aa7e4344c27ea46f3e2a9cbe6` | 2026-08-06 |

Prime's default branch was confirmed live via `git ls-remote --symref`
(`HEAD` = `c22549a`, `refs/heads/main`). All Prime quotes are from that
commit; all OMPK quotes are from the checked-out `77a10a5`.

## Hard constraint

Nothing in this plan replaces OMPK's execution harness.
[`AgentSession`](../packages/coding-agent/src/session/agent-session.ts),
[`agent-harness.ts`](../packages/coding-agent/src/orchestration/agent-harness.ts)
(harness selection),
[`task/executor.ts`](../packages/coding-agent/src/task/executor.ts),
[`goals/runtime.ts`](../packages/coding-agent/src/goals/runtime.ts), and the
rest of `src/orchestration/` remain the only code that runs model turns,
tools, and skills. The adapted layer sits _above and beside_ them, and one
contract test enforces this boundary (§ Validation plan).

## Baseline verification of prior findings

The prior review's claims are restated below and re-verified against primary
sources. Every classification is based on code at the recorded commits, not
on the review summary.

| # | Prior review claim (restated) | Classification | Verdict with evidence |
| - | ----------------------------- | -------------- | --------------------- |
| 1 | Prime's daemon/worker/supervisor architecture is real and durable (journaling, leases, scheduling, crash recovery, worker adoption) | ✅ Confirmed | Verified in Prime `src/modes/daemon/` (24 files, 91 B–242 KB): `daemon-supervisor.ts`, `daemon-supervisor-ownership.ts`, `daemon-worker-protocol.ts`, `command-recovery-journal.ts`, `worker-recovery-journal.ts`, `daemon-client.ts`. Mechanics quoted in § State and protocol contracts. |
| 2 | Prime's reconnect model uses event cursors, generations, sequences, snapshot replay, recoverable vs fatal errors | ✅ Confirmed | Prime `src/modes/agent-connection/daemon-agent-connection.ts` (70.7 KB): snapshot assembly (`session_snapshot_begin/chunk/end/failed`), purposes `attach\|replacement\|catchup`, `recoverFailedSnapshot`, `isStaleSequencedMessage`, `ignoredSnapshotIds`, exponential reconnect `100 * 2**attempt` capped at 2000 ms. |
| 3 | Prime has a Windows-specific stale-lease defect (issue #667, `EPERM` on directory replacement) | ✅ Confirmed, still present at HEAD | Prime `src/core/session-lease.ts`: `reclaimStaleLease` renames a directory over an existing one and catches only `ENOENT`; the acquisition path catches only `EEXIST`/`ENOTEMPTY` before reclaim. On Windows, `renameSync` over an existing directory raises `EPERM`, so a stale lease _blocks_ acquisition. The file even encodes Windows PID-reuse identity upstream (`getWindowsProcessStartId` via PowerShell `GetProcessById(pid).StartTime…Ticks`) — the maintainers care about Windows identity, but the rename path is still fragile. PR #664 (`windowsHide`, 27 files) confirms Windows console-window flashing is a live problem. |
| 4 | OMPK has no GitHub App / account-wide entry point (review searched and found nothing) | ❌ Outdated / ⚠️ search failure | [`packages/ompk-linear-agent/`](../packages/ompk-linear-agent/README.md) is a deployed Cloudflare Worker ("ompk" Linear agent) **with a fully built GitHub adapter**: `src/github.ts` (App JWT + installation tokens), `src/github-dispatch.ts` (issue/PR mention triggers, trusted associations `OWNER/MEMBER/COLLABORATOR`, trusted permissions `admin/maintain/write`, redelivery-stable `dedupeId`), env `GITHUB_APP_ID/PRIVATE_KEY/INSTALLATION_ID/ACCOUNT_LOGIN/MENTION_HANDLE/MODEL`, `wrangler.toml`. The earlier search failed on wording (`hub`/`broker`/`installation`); `github`/`linear`/`GITHUB_` resolve everything. |

| 5 | OMPK has no Agent Hub | ❌ Incorrect | [`src/modes/components/agent-hub.ts`](../packages/coding-agent/src/modes/components/agent-hub.ts) (`AgentHubOverlayComponent`) + `agent-hub-kanban-sync.ts` + 8 dedicated tests (`agent-hub-activate/advisor-scroll/backgrounds/kanban-sync/keybindings/ordering/remove/rename`). Separate cloud hub: [`src/session/hub-service.ts`](../packages/coding-agent/src/session/hub-service.ts) (AES-256-GCM-sealed `snapshotForReplication()`, cross-device publish/resume). |
| 6 | OMPK has no auth broker / credential-hiding layer | ❌ Incorrect | `packages/ai/src/auth-broker/` (client, wire schemas, `RemoteAuthCredentialStore` — tests `auth-broker-remote-store/wire/snapshot-cache/refresher/oauth-extra-fields`), forward-proxy auth gateway (`auth-gateway-*` tests incl. cross-protocol caching), [`auth-broker-gateway.md`](auth-broker-gateway.md), TUI/CLI wiring (`commands/auth-broker.ts`, `auth-gateway.ts`). Clients never see access tokens; endpoints `/v1/snapshot`, `/v1/credential/:id/refresh`, `/v1/credential/:id/disable`. |
| 7 | OMPK has no goals / root completion-and-continuation contract | ⚠️ Partially outdated | [`src/goals/`](../packages/coding-agent/src/goals/) _exists_: `GoalStatus = "active"\|"paused"\|"budget-limited"\|"complete"\|"dropped"`; `GoalRuntimeHost.persist("goal"\|"goal_paused"\|"none")`; `sendHiddenMessage({ deliverAs: "steer"\|"followUp"\|"nextTurn" })`; token/time budgets with `cacheWrite` accounting ("Diverges from codex-rs"). BUT the completion-gate side is real yet unwired — [`task-contract-orchestration.md`](task-contract-orchestration.md) states compiled root contracts "do **not** call `setActiveTaskContract()` … do **not** enable evidence-backed completion gating". Continuation contract = present; evidence-gated root completion = present as modules, not enabled by default. |
| 8 | OMPK lacks task orchestration / work contracts / acceptance criteria | ❌ Outdated | [`src/orchestration/`](../packages/coding-agent/src/orchestration/) (16 files): `task-contract.ts` (`TaskContractV1` with `completionCriteria`, `nonSolutions`, `verificationPolicy.requireTargetedChecks`, `evidenceRequirements`), `completion-gate.ts` (`pass/recoverable/blocked`), `root-completion-gate.ts` (derives evidence from `toolResult` signals, not prose), `intent-compiler.ts` (gap scoring `S = 0.25I + 0.20U + 0.20B + 0.25R + 0.10(1−E)`, material ≥ 0.60, one-question policy), `agent-harness.ts`, `evidence-ledger.ts`, `collaboration-policy.ts`. Plus [`multi-agent-fork-collaboration.md`](multi-agent-fork-collaboration.md) defines the full work-contract schema (objective / `allowedPaths` / ≤10 acceptance items / `verification` commands / `dependsOn` / `mergeOwner`) and the Linear queue-state contract. |

| 9 | OMPK has no durable session store with cross-process locking/journaling | ⚠️ Partially outdated | Persistent JSONL (v3) + blob externalization ([`session.md`](session.md), `session-entries.ts`, `blob-store.ts`) exist, and [`session-writer-guard.ts`](../packages/coding-agent/src/session/session-writer-guard.ts) is a genuine cross-process single-writer lock via SQLite (`writer_guard` singleton=1, `SessionAlreadyOwnedError`, `sameProcessOwner: "reject"\|"share"`). **Absent: heartbeats, lease TTL, stale-lock reclaim, and PID/process-start identity** — exactly what Prime's `session-lease.ts` adds. |
| 10 | OMPK has no live reconnect protocol (attach/resync to a running agent with cursor/generation semantics) | ⚠️ Partially outdated | Resume paths exist but are _not_ live-reconnect: hub publish/resume (`hub-service.ts` snapshot blob), session JSONL replay (`session-loader`, breadcrumbs for `continueRecent()`), and a session-observer registry (`src/modes/session-observer-registry.ts`). There is **no** daemon-resident session to reattach to, hence no event cursor, no generation fencing, no snapshot assembly of an in-flight run. Prime's `daemon-agent-connection.ts` model has no OMPK counterpart. |
| 11 | OMPK lacks worker-style session-owned scheduling | ⚠️ Partially outdated | In-process lifecycle exists ([`registry/agent-lifecycle.ts`](../packages/coding-agent/src/registry/agent-lifecycle.ts): idle → parked → revived with TTL; `task/executor.ts` adoption) and external scheduling exists (`ompk-linear-agent` queue: fenced `attemptId`+`leaseToken`, 10-min heartbeats, 30-min leases, reconcile parking, 5 attempts, backoff 30s/2m/5m/15m/30m, `failureClass transient/permanent`). **Gap:** no _resident_ owner-of-record that holds leases on interactive/repository sessions across process restarts. |
| 12 | OMPK has no autonomous mode with gates | ⚠️ Partially outdated | OMPK has approval gates ([`approval-mode.md`](approval-mode.md): `always-ask/write/yolo` tiers, read/write/exec, safety `override` forcing prompts), `turn-budget.ts`, `loop-limit.ts`, and goals `budget-limited` steering — functionally similar to Prime's autonomous gates (PR #278). Missing: evidence-gate _enforcement_ on root contracts (see #7) and Prime's detached-worker kill-tree plumbing. |

**Net correction to the prior review:** findings 1–3 are the durable, verified
core; findings 4–8 largely _under-counted_ OMPK; findings 9–12 are real gaps
but smaller than claimed (building blocks exist, the _durability/ownership_
layer doesn't).

## Capability matrix

| Capability | Prime Agent (verified) | Oh My PK (verified) | Gap | Adapt? |
| ---------- | ---------------------- | ------------------- | --- | ------ |
| Session persistence (append-only, crash-safe) | `<state>/sessions/**` + compactable stream (`compact-session-stream.ts`) | JSONL v3 + content-addressed blobs + truncation (`session-persistence.ts`); file/sql/redis/indexeddb backends | None (OMPK richer) | Keep OMPK; don't port |
| Cross-process single-writer lock | `session-lease.ts` (lease dir + `owner.json` + `proper-lockfile` guard) | [`session-writer-guard.ts`](../packages/coding-agent/src/session/session-writer-guard.ts) (SQLite singleton) | OMPK lacks PID/start-time identity, heartbeat, stale reclaim | Port Prime's owner-record + Windows-safe reclaim **onto** the SQLite guard |
| Supervisor / worker adoption | `daemon-supervisor.ts` + `daemon-supervisor-ownership.ts` (generation, startup fence, shutdown admission, orphan journal) | [`AgentLifecycleManager`](../packages/coding-agent/src/registry/agent-lifecycle.ts) (in-process only) + [`gopk-clips/daemon.ts`](../packages/coding-agent/src/gopk-clips/daemon.ts) (single-instance `ingest.pid`) | No cross-process supervisor for sessions | Port supervisor-ownership; worker = an `omp` `AgentSession` process |
| Idempotent command journal | `command-recovery-journal.ts` (`received/result/acknowledged`, fsync per append, compact at 4096, "missing result = uncertain, never replayed") | `ompk-linear-agent` queue fencing (different layer: Linear jobs) | No command-boundary journal | Port minimally into the new RPC path only |
| Reconnect generations/sequences | `daemon-agent-connection.ts` (cursor, snapshot assembly, stale rejection) | Hub blob resume (cross-device, not live) | No live attach/resync | Port cursor + snapshot channels; reuse hub `snapshotForReplication()` as snapshot payload |
| Session-owned scheduling | Supervisor holds workers per session; ephemeral worker adoption (PR #506) | Goals runtime + Linear queue + in-process lifecycle manager | No resident scheduler of record | Port worker descriptor registry (`DaemonWorkerDescriptor`, env-injected role/token) |
| Goals + continuation | `goal` mode with owned-session budget | [`goals/runtime.ts`](../packages/coding-agent/src/goals/runtime.ts) (better than Prime: `steer/followUp/nextTurn`, cacheWrite accounting) | None | Keep OMPK |
| Task contracts + acceptance gates | Autonomous gates (PR #278) | `task-contract.ts` + `completion-gate.ts` (present, disabled for compiled root contracts) | Enable wiring | Keep OMPK; flip on M2 wiring (phase P4) |
| GitHub App entry | n/a (Linear-first) | [`ompk-linear-agent`](../packages/ompk-linear-agent/README.md) GitHub adapter (verified) | None | Keep; see § GitHub App flow |
| Auth brokerage | n/a | auth-broker + gateway (verified) | None | Keep |
| Windows process hygiene | PR #664 `windowsHide` (open), #687 portable sockets (open), #667 EPERM (open) | Undocumented | Must design in | Adopt as hard requirements (§ Cross-platform) |

## Target architecture

The ported layer sits _above and beside_ the harness — it owns process
lifecycle, leases, and recovery, never model turns:

```text
┌─────────────────────────────────────────────────────────────────────┐
│  omp CLI / TUI / ACP (interactive-mode.ts, print-mode.ts)           │
└───────────────┬─────────────────────────────────────────────────────┘
                │ attach / resume / commands (JSON-RPC frames)
┌───────────────▼─────────────────────────────────────────────────────┐
│  omp supervisor process  (NEW: src/supervisor/)                     │
│   • ownership: registry dir + owner.json + generation               │
│     (port of Prime daemon-supervisor-ownership.ts)                  │
│   • command journal: received → result → acknowledged, fsync,       │
│     compact (port of Prime command-recovery-journal.ts)             │
│   • session workers: spawn `omp --worker` per session path          │
│   • reconnect: event cursors + snapshot assembly (attach/           │
│     replacement) (port of Prime daemon-agent-connection.ts)         │
│   • shutdown admission file (drain latch), startup fence            │
└───────┬─────────────────────────────────────────────────────────────┘
        │ env: role / token / session-id / supervisor-socket /
        │      journal / startup-gate-fd
┌───────▼───────────────────────────────┐  ┌──────────────────────────┐
│ Session worker process (`omp`,        │  │ ompk-linear-agent        │
│ unchanged harness): AgentSession +    │  │ Cloudflare Worker queue  │
│ goals + orchestration; state via the  │  │ (leases + reconcile      │
│ existing session-writer-guard +       │  │ contract) — unchanged    │
│ JSONL + blobs                         │  └──────────────────────────┘
└───────────────────────────────────────┘
  cross-platform leases (§ Cross-platform requirements) reuse Prime's
  session-lease.ts owner model wrapped around the existing SQLite guard
```

Three ownership layers, mirroring Prime:

1. **Supervisor-of-record** — registry, generation, fences
   (ports `daemon-supervisor-ownership.ts`).
2. **Session lease** — who may append to a session; wraps the existing
   SQLite writer guard with owner identity + heartbeat + reclaim
   (ports `session-lease.ts` semantics).
3. **Job lease** — already implemented in `ompk-linear-agent`; untouched.

## State and protocol contracts

Prime source files are the spec; quoted constants and comments are verbatim
from commit `c22549a`.

### 4.1 Session lease (augments, does not replace, the writer guard)

Add to the existing `writer_guard` row: `pid`, `process_start_id`,
`last_heartbeat_at`, `lease_ttl_ms` (the row already carries `guard_id`,
`session_id`, `transcript_path`, `acquired_at`). Semantics copied from Prime
`src/core/session-lease.ts`:

- On contention, read the holder record; live-if `pid` alive **and**
  `process_start_id` matches (Windows PID-reuse protection via PowerShell
  start ticks — § Cross-platform requirements).
- Dead holder → reclaim; live holder → the equivalent of Prime's
  `SessionAlreadyActiveError` (OMPK already has `SessionAlreadyOwnedError`).
- Prime's liveness probe detail to copy: `process.kill(pid, 0)` raising
  `EPERM` means the process is **alive** (exists but inaccessible), not dead.
- Recovery gates stay sound because, per the current guard's docs,
  "acquisition succeeding is proof that no live writer exists."

### 4.2 Supervisor ownership (port of `daemon-supervisor-ownership.ts`)

Constants: `REGISTRY_LOCK_STALE_MS = 5000`, `REGISTRY_LOCK_UPDATE_MS = 1000`,
`REGISTRY_LOCK_RETRIES = 500` (10 ms spacing), shutdown-admission lease
5000 ms / refresh 1000 ms / wait 50 ms, startup-fence poll 250 ms. Atomic
JSON writes via temp + `renameSync`. Owner record:

```ts
interface SupervisorOwnerRecord {
  version: 1;
  role: "supervisor";
  token: string;
  generation: string;
  socketPath: string;
  descriptorDir: string;
  agentDir: string;
  appVersion: string;
  phase: "starting" | "owner" | "stopping";
  createdAt: string;
  updatedAt: string;
}
```

Error codes: `daemon_supervisor_already_running`,
`supervisor_generation_stale`, `daemon_shutdown_in_progress`.

### 4.3 Worker handshake (port of `daemon-worker-protocol.ts`)

Env contract (Prime names → OMPK names):

| Prime env | OMPK env (proposed) | Purpose |
| --------- | ------------------- | ------- |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER` | `OMPK_INTERNAL_WORKER` | Worker role flag (`"1"`) |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN` | `OMPK_INTERNAL_WORKER_TOKEN` | Auth token for `worker_auth` |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID` | `OMPK_INTERNAL_WORKER_ACTIVE_SESSION_ID` | Root active session id |
| `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` | `OMPK_INTERNAL_SUPERVISOR_SOCKET` | Supervisor socket path |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL` | `OMPK_INTERNAL_WORKER_RECOVERY_JOURNAL` | Worker recovery journal path |
| `PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD` | `OMPK_INTERNAL_WORKER_STARTUP_GATE_FD` | Inherited fd; worker blocks until supervisor writes `start\n` |

Frames: `worker_auth { token, supervisorGeneration, supervisorPid,
supervisorProcessStartId, supervisorSocketPath }` then `worker_subscribe
{ activeSessionId, capabilities }`. Worker descriptor lifecycle
`starting | ready | recovering | failed`; a durable `stopRequestedAt` is
written _before_ root termination so, in Prime's words, "replacement
supervisors never recover it"; plus `archiveOnStop`, `consecutiveFailures`,
`orphanProcessJournalPath`.

### 4.4 Command journal (port of `command-recovery-journal.ts`)

JSONL with `fsync` per append; record types `received → result →
acknowledged`; idempotency key `JSON.stringify([clientId, commandId])`;
compaction at 4096 records via temp + rename; truncated tail on load is
skipped. The load-bearing rule (verbatim Prime comment): "A received record
is durable before a mutating command is dispatched; a missing result after a
crash is therefore treated as uncertain and is never replayed."

### 4.5 Reconnect (port of the `daemon-agent-connection.ts` surface)

Event cursor + replay info (`generation`, `sequence`); snapshot purposes
`attach | replacement | catchup`; assembly via `session_snapshot_begin /
chunk / end / failed`; superseded snapshots tracked in `ignoredSnapshotIds`;
stale sequenced events rejected (`isStaleSequencedMessage`); reconnect
backoff `min(remaining, 2000, 100 * 2**min(attempt, 5))`; verdicts
recoverable (resync snapshot) vs fatal (replacement required). The snapshot
payload is OMPK's own — the existing JSONL entries and, for cross-device
cases, `snapshotForReplication()` from `hub-service.ts` — not Prime's
transcript format.

### 4.6 Do not touch

`GoalStatus` / `deliverAs` / budget accounting (OMPK goals are superior),
the `ompk-linear-agent` Job schema (`attemptId`, `leaseToken`,
`logicalAttemptKey`, `failureClass`, reconcile parking) — already correctly
fenced — and everything in `src/orchestration/` that runs turns.

## Implementation map

All paths relative to `packages/coding-agent/`. Read
[`packages/coding-agent/AGENTS.md`](../packages/coding-agent/AGENTS.md)
before editing this package.

| New/changed file | Derives from | Responsibility |
| ---------------- | ------------ | -------------- |
| `src/supervisor/ownership.ts` (new) | Prime `daemon-supervisor-ownership.ts` | Registry, generation, fences, shutdown admission. Locking: verify `proper-lockfile` is already in the dependency tree (Prime uses it); otherwise use a Bun-native lock. |
| `src/supervisor/command-recovery-journal.ts` (new) | Prime `command-recovery-journal.ts` | Idempotent RPC journal. Keep sync `fs` + `fsync` per append, as Prime does, for crash safety. |
| `src/supervisor/worker-protocol.ts` (new) | Prime `daemon-worker-protocol.ts` | Env contract, frame types, descriptor type. |
| `src/supervisor/session-worker.ts` (new) | Prime `daemon-worker-client.ts` + `worker-recovery-journal.ts` | Spawns `omp` session processes with `--worker`; startup gate; orphan-process journal. |
| `src/supervisor/reconnect/session-replay.ts` (new) | Prime `daemon-agent-connection.ts` | Cursor + snapshot assembly over existing JSONL / hub snapshot. |
| `src/supervisor/cli.ts` (new) | — | `omp supervisor start|status|stop`, `omp attach`. `interactive-mode.ts` remains the UI. |
| `src/session/session-writer-guard.ts` (modify) | Prime `session-lease.ts` | Add `pid` / `process_start_id` / `last_heartbeat_at` / `lease_ttl_ms` + Windows-safe reclaim. |
| `src/gopk-clips/daemon.ts` (precedent only) | OMPK pattern | Its `ingest.pid` single-instance + `--stop`/`--once` style is the in-repo precedent for daemon processes; do not add a second ingester (per its own header). |
| `src/orchestration/agent-harness.ts` | — | **Unchanged.** Harness stays the only execution face. |

## GitHub App flow

OMPK **already implements** the account-wide GitHub entry point — this flow
is de-risked and needs no port. Verified end-to-end in
[`packages/ompk-linear-agent`](../packages/ompk-linear-agent/README.md)
(worker routes in `src/worker.ts`, `src/github.ts`, `src/github-dispatch.ts`,
relay in `relay/relay.ts`):

1. GitHub App webhook (`push`, `issues`, `issue_comment`) → signature
   verified against `GITHUB_WEBHOOK_SECRET`.
2. `github-dispatch.ts` filters: mention of `GITHUB_MENTION_HANDLE`; actor is
   `OWNER`/`MEMBER`/`COLLABORATOR` (or holds `admin`/`maintain`/`write`);
   installation matches `GITHUB_INSTALLATION_ID` and account login matches
   `GITHUB_ACCOUNT_LOGIN`; model label in `GITHUB_MODEL`.
3. Dedupe on redelivery-stable ids (comment/review id — never
   `X-GitHub-Delivery`, which changes per retry); at most one active job per
   issue; missing allowlist configuration fails closed.
4. `github.ts` mints an App JWT (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`)
   and exchanges it for an installation token; resolves target repo/branch/PR
   metadata into `GitHubJobTarget`.
5. Job enters the Durable Object queue (`queue-core.ts` / `queue-do.ts`):
   fenced `attemptId` + `leaseToken`, 10-min heartbeats re-arming a 30-min
   lease, reconcile parking after two missed beats, 5 attempts with backoff
   30s/2m/5m/15m/30m, `failureClass transient/permanent` retry taxonomy.
6. The Windows relay long-polls `/poll`, runs `omp --print --yolo` in a
   dedicated scratch workspace (`OMPK_RELAY_WORKSPACE`) with a model
   allowlist (`OMPK_RELAY_MODELS`), and posts `/result`. Success → issue/PR
   comment; failure → `failureClass` + budget/dead-letter comment.
7. Administrative status via the separate `STATUS_TOKEN` (never the relay or
   webhook secret); `redactJob()` never carries prompts or output.

**Adaptation deltas (only these):**

- Relay target-host field so a job can dispatch to another mesh host (declared
  gap in the package README; wrap the argv-based spawn in an SSH exec per the
  `pkmesh` skill).
- Optionally run goal-mode/budget envelopes in relay-attached jobs.
- Keep or implement the `Queue/Reconcile` / `Queue/Dead Letter` label
  mirroring (comments only today, per the README's automation boundary).

No reconciliation-protocol work is needed.

## Cross-platform requirements

All Windows-specific requirements below are verified against Prime's open
issues/PRs at commit `c22549a` and must be designed in, not retrofitted:

1. **Directory-replacement leases must never `renameSync` over an existing
   directory on Windows** (Prime issue #667, `EPERM`). Pattern: acquire →
   `mkdir` candidate with `owner.json` → rename candidate onto target; on
   `EEXIST`/`ENOTEMPTY`/`EPERM` read the existing owner; live → error;
   stale → **delete the target first, then rename** — never rename-over-dir.
   This is the single highest-risk fork point and must ship with a Windows CI
   job that creates a stale lease and asserts acquisition succeeds.
2. **PID-reuse protection**: store `processStartId` beside `pid`; on Windows
   obtain it via PowerShell
   `([Diagnostics.Process]::GetProcessById(N)).StartTime.ToUniversalTime().Ticks`
   (Prime's exact approach in `getWindowsProcessStartId`) so a
   reboot-recycled PID cannot hold a lease.
3. **`isProcessAlive` must treat `EPERM` as alive** (Prime does): a refused
   `process.kill(pid, 0)` means the process exists, not that it is dead.
4. **No console flashing** for spawned workers: `windowsHide: true` on all
   background child processes (Prime PR #664 is a ready fix across 27 files;
   bake it in from day one).
5. **Portable socket paths** (Prime PR #687): use short, hash-derived socket
   names under `%TEMP%`/agent dir (the sha256-keyed dir pattern both repos
   already use); never embed long session paths in socket names — Windows
   `AF_UNIX` path limits are much shorter than POSIX.
6. **Startup gate via inherited fd, not a file** (Prime
   `DAEMON_WORKER_STARTUP_GATE_FD`): avoids earliest-opportunity races on
   Windows file-locking semantics. Verify Bun can spawn workers with
   inherited fds on Windows before committing to this design.
7. **Working-dir naming**: `session-paths.ts` already encodes dirs
   Windows-safely (`:`/`\`/`/` replaced); keep, and test sessions under
   non-ASCII and `C:\`-rooted paths.

## Validation plan

- **Contract tests (new)**: `supervisor/ownership.test.ts` — generation
  staleness (`supervisor_generation_stale`), shutdown-admission expiry,
  startup-fence rejection, double-start `daemon_supervisor_already_running`.
  `command-recovery-journal.test.ts` — crash-without-result is never
  replayed; truncated tail tolerated; compaction at 4096; acknowledged
  entries gone after reload.
- **Lease tests (extend existing)**: foreign-process
  `SessionAlreadyOwnedError`; stale lease reclaimed after TTL + dead PID;
  simulated PID reuse (mismatched `process_start_id`) rejects;
  `sameProcessOwner: "share"` still works.
- **Cross-platform matrix**: full suite on Windows (this machine) + CI
  Linux/macOS; the dedicated Windows stale-lease regression test above.
- **Reconnect tests**: attach to a running worker mid-turn → snapshot
  identical to the JSONL tail; stale sequenced events dropped; a replacement
  snapshot supersedes an in-flight attach (`ignoredSnapshotIds` behavior).
- **Harness-invariance gate**: a contract test asserting supervisor code
  never calls `AgentSession` / `agent-harness.ts` directly — only through the
  worker's normal entrypoint. This enforces the hard constraint.
- **Existing suites stay green**: `bun check` (never `tsc`/`npx tsc`) plus
  package test suites; follow the testing rules in `AGENTS.md` (behavioral
  tests only, no mocks/placeholders, spies restored per test, no
  `mock.module()`).
- **Blue/green run**: supervisor + lease layer against a scratch repo while a
  normal `omp` session runs concurrently; prove both writers cannot append to
  the same session.

## Phased plan

Each phase ends verified before the next begins.

| Phase | Scope | Exit criteria |
| ----- | ----- | ------------- |
| **P0 — Leases & reclaim** | Augment `session-writer-guard.ts` with owner identity/heartbeat/TTL + Windows-safe reclaim (semantics from Prime `session-lease.ts`) | Lease tests green on Windows + CI; #667 regression test in suite |
| **P1 — Supervisor ownership** | Port `daemon-supervisor-ownership.ts` (registry, generation, fences, admission) + `omp supervisor status` | Ownership + fence tests green; double-supervisor rejected |
| **P2 — Worker handshake + journal** | Port worker-protocol env contract, startup gate, command journal; spawn `omp --worker` sessions | Two concurrent `omp` CLI attach/command flows; journal idempotency tests green |
| **P3 — Reconnect** | Port cursor/snapshot assembly over existing JSONL + `snapshotForReplication()`; recoverable vs fatal verdicts | Reconnect suite green; attach survives worker restart with generation bump |
| **P4 — Gating wiring** | Flip M2: compiled root contracts → `setActiveTaskContract()` → evidence-backed completion gate (per [`task-contract-orchestration.md`](task-contract-orchestration.md)) | Task-contract + completion-gate tests pass; goals unaffected |
| **P5 — GitHub deltas** | Relay target-host field; optional label mirroring of `Queue/Reconcile` / `Queue/Dead Letter` | Linear/GitHub smoke passes (incl. real-scratch-issue mode) |

## Reject list

Prime artifacts deliberately **not** ported, with verified reasons:

| Prime artifact | Why rejected |
| -------------- | ------------ |
| `daemon-supervisor.ts` (242 KB monolith session runtime) | It is Prime's _whole in-process session executor_; OMPK already has one (`AgentSession`). Importing it would replace the harness — prohibited. Only the ownership/journal/protocol _files_ are adapted. |
| `compact-session-stream.ts` | OMPK JSONL v3 + blob externalization + truncation is richer and already crash-tested. |
| Prime session transcript/snapshot wire format | OMPK must replay from its own JSONL + hub snapshot payload; translating formats doubles attack surface. |
| Prime goal/budget accounting | OMPK goals exceed it (`deliverAs` modes, `cacheWrite` accounting — explicitly "Diverges from codex-rs" in a good way). |
| Prime's `proper-lockfile` dependency in OMPK's lease path | `writer_guard` already provides cross-process mutual exclusion via SQLite; a second lock regime invites deadlock. Reuse the guard; add identity/heartbeat columns. |
| Replacing `ompk-linear-agent` queue semantics | Already fenced correctly (`attemptId`/`leaseToken`/heartbeats/reconcile). Replacing it would be regressive. |
| Prime's detached-child kill-tree default UX | Adopt only for supervisor-spawned workers, with `windowsHide` and portable sockets; never for interactive `omp` runs. |

## Evidence index

### Prime Agent (`PrimeIntellect-ai/prime-agent`, commit `c22549a`, 2026-08-06)

- Daemon tree: `packages/coding-agent/src/modes/daemon/` →
  `active-session-state.ts`, `command-recovery-journal.ts`,
  `compact-session-stream.ts`, `daemon-catalog-process.ts`,
  `daemon-client-env.ts`, `daemon-client.ts`, `daemon-errors.ts`,
  `daemon-extension-binding.ts`, `daemon-mode.ts`, `daemon-protocol.ts`,
  `daemon-runtime-identity.ts`, `daemon-session-id.ts`,
  `daemon-session-list.ts`, `daemon-session-summarizer.ts`,
  `daemon-socket.ts`, `daemon-supervisor-ownership.ts`,
  `daemon-supervisor.ts`, `daemon-worker-client.ts`,
  `daemon-worker-protocol.ts`, `heartbeat-catalog.ts`,
  `mutation-drain-latch.ts`, `saved-session-catalog.ts`,
  `saved-session-info.ts`, `snapshot-transcript-cache.ts`,
  `worker-recovery-journal.ts`
- Leases: `src/core/session-lease.ts` (owner record, acquire/reclaim,
  PowerShell start ticks, `EPERM`-as-alive)
- Reconnect: `src/modes/agent-connection/daemon-agent-connection.ts`
  (snapshot assembly, cursors, `recoverFailedSnapshot`, stale-sequence
  rejection) + `docs/agent-connection.md`, `docs/daemon.md`
- Public issues/PRs: #667 (Windows stale-lease `EPERM`), #664
  (`windowsHide`), #687 (portable sockets), #278 (autonomous gates, merged),
  #506 (ephemeral workers, merged)

### Oh My PK (commit `77a10a5`, 2026-08-06)

- Session durability: `src/session/session-writer-guard.ts`,
  `session-storage.ts`, `session-manager.ts`, `session-entries.ts`,
  `session-persistence.ts`, `blob-store.ts`, `hub-service.ts`,
  `yield-queue.ts`, `client-bridge.ts` (+ `sql-session-storage.ts`,
  `redis-session-storage.ts`, `indexed-session-storage.ts` backends)
- Goals: `src/goals/state.ts`, `src/goals/runtime.ts`
- Orchestration: `src/orchestration/*` (16 files incl. `agent-harness.ts`,
  `completion-gate.ts`, `root-completion-gate.ts`, `task-contract.ts`,
  `intent-compiler.ts`, `evidence-ledger.ts`, `collaboration-policy.ts`)
- Lifecycle: `src/registry/agent-registry.ts`,
  `src/registry/agent-lifecycle.ts`
- Agent Hub: `src/modes/components/agent-hub.ts`,
  `agent-hub-kanban-sync.ts`, `test/agent-hub-*.test.ts` (8 tests)
- Daemon precedent: `src/gopk-clips/daemon.ts` (`ingest.pid`,
  Windows pid-recycling check)
- GitHub/Linear bridge: `packages/ompk-linear-agent/` (`src/worker.ts`,
  `src/github.ts`, `src/github-dispatch.ts`, `src/queue-core.ts`,
  `src/queue-do.ts`, `src/types.ts`, `relay/relay.ts`, `wrangler.toml`,
  `README.md`)
- Auth: `packages/ai/src/auth-broker/`, auth-gateway tests,
  `docs/auth-broker-gateway.md`, `src/cli/auth-broker-cli.ts`,
  `src/cli/auth-gateway-cli.ts`
- Docs: [`session.md`](session.md), [`approval-mode.md`](approval-mode.md),
  [`task-contract-orchestration.md`](task-contract-orchestration.md),
  [`multi-agent-fork-collaboration.md`](multi-agent-fork-collaboration.md)

---

_Bottom line:_ Prime's durable control-plane patterns (leases with process
identity, supervisor generations, idempotent command journaling,
cursor-based reconnect) are the right things to adapt — but OMPK is far
ahead of where the prior review left it. GitHub App entry, Agent Hub, auth
broker, goals, orchestration, work contracts, and a fenced Linear queue all
already exist in verified code. The adaptation is surgical: add the
**durability/ownership layer** around OMPK's existing `AgentSession`
harness, solve the Windows `EPERM`/console issues up front, and leave
OMPK's superior goals/auth/hub/GitHub subsystems untouched.
