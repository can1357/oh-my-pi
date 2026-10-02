# task

> Spawn subagents — one per call, or a `tasks[]` batch per call (`task.batch`, default on). With `async.enabled=true`, ordinary spawns run in the background; otherwise the call blocks until they finish. Execution mode is per item: an item whose custom agent type declares `blocking: true` runs inline while non-blocking items in the same call still spawn as background jobs. No bundled agent currently declares `blocking: true`.

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts` — dynamic schema, agent definitions, output caps.
  - `packages/tui/src/tools/task.ts` — progress/result and tool-details types.
  - `packages/coding-agent/src/task/structured-subagent.ts` — shared task/eval preflight, model/schema policy, artifact retention, execution.
  - `packages/coding-agent/src/task/isolation-runner.ts` — isolation capture, merge, recovery, and lifecycle ownership.
  - `packages/coding-agent/src/task/eval-tools.ts` — expose parent-kernel tools to a child.
  - `packages/coding-agent/src/task/discovery.ts` — discover project/user/plugin/bundled agents.
  - `packages/coding-agent/src/task/agents.ts` — bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts` — create child sessions, run subagents, collect output, hand finished sessions to the lifecycle manager.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — idle-TTL parking and revival of finished subagents.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory (`running | idle | parked | aborted`).
  - `packages/coding-agent/src/async/job-manager.ts` — background job registration, progress, and result delivery.
  - `packages/coding-agent/src/task/parallel.ts` — `Semaphore` used for the session-scoped concurrency bound.
  - `@oh-my-pi/pi-natives` (`crates/pi-iso`) — isolation PAL: `isoResolve` / `isoStart` / `isoStop` backend resolution and fallback.
  - `packages/coding-agent/src/task/worktree.ts` — isolation backend mapping (`parseIsolationBackend`) and lifecycle (`ensureIsolation`/`cleanupIsolation`), patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts` — session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/name-generator.ts` — default AdjectiveNoun agent ids.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/internal-urls/history-protocol.ts` — resolve `history://<id>` to a concise transcript.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk.ts` — child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/task-agent-discovery.md` — deeper discovery and precedence notes.

## Inputs

The wire schema is shape-swapped by `task.batch` (default on). One unit of work is `{ name?, agent?, task, solutionSpace, effort?, outputSchema?, schemaMode?, tools?, isolated? }`. `isolated` exists only when `task.isolation.enabled` is true **and plan mode is disabled**; `effort` requires `task.enableEffort=true` (default off), and `tools` requires `eval.tools.enabled` (default on).

- **Batch shape** (`task.batch` on): `{ context, tasks: item[] }` — one subagent per item, all run under the same fan-out rules; there is no top-level agent field. `context` is **required** shared background rendered into every spawned subagent's system prompt (`CONTEXT` section); `agent`, `outputSchema`, and `schemaMode` are per item. `effort` is added only when its setting enables it; `isolated` additionally requires plan mode to be disabled.
- **Flat shape** (`task.batch` off): `{ ...item }` — exactly one spawn per call. Shared background goes into a `local://` file (e.g. `local://ctx.md`) that each spawn's `task` references; subagents share the parent's `local://` root.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | `string` | Yes (batch) | Shared background prepended to every spawn of the call via the subagent system prompt. Rejected when `task.batch` is off. |
| `tasks` | `array` | Yes (batch) | One task item per subagent. Provided names must be unique within the call (case-insensitive). Rejected when `task.batch` is off. |
| `name` | `string` | No | Stable agent name — becomes the registry/IRC id. The prompt requests CamelCase, at most 32 characters; the wire schema only requires a string. Defaults to a generated AdjectiveNoun name and is uniquified per session by `AgentOutputManager`. Item field in batch shape, top-level in flat shape. |
| `agent` | `string` | No | Agent type to run this item (e.g. `scout`). Defaults to the spawn policy's default agent (usually `task`); items in one batch call may use different agent types. Item field in batch shape, top-level in flat shape. |
| `task` | `string` | Yes | The work — complete, self-contained instructions. Empty-after-trim is rejected. Item field in batch shape, top-level in flat shape. |
| `solutionSpace` | `string` | Yes | How open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open (e.g. `one fix: rename, names given`; `deadlock cause open, no repro`). Volume of work does not widen it. Rides the child's first prompt into the `auto` thinking classifier as its sole input — the judge sees this field, not the `task` text; ignored when the child's thinking selector is not `auto` or `effort` overrides it. Blank or missing values fall back to classifying the `task` text: the schema advertises it as required, but the tool's lenient argument validation still spawns a call that omits it. Item field in batch shape, top-level in flat shape. |
| `effort` | `"lo" \| "med" \| "hi"` | No | Present only with `task.enableEffort=true`. Per-spawn thinking effort, mapped onto the resolved model's supported range (lowest/middle/highest level it tops out at, e.g. `high`/`xhigh`/`max`). Overrides the agent's default selector, including `auto`; omitting it keeps the agent's configured selector — automatic per-prompt classification only for agents configured `auto` (e.g. the bundled `task`); `scout`/`sonic` configure `medium`. Item field in batch shape, top-level in flat shape. |
| `outputSchema` | JSON Schema (`object \| boolean \| string \| null` at the coarse wire-validation layer) | No | Invocation-specific structured-output contract. Takes precedence over agent frontmatter `output` and the inherited parent session schema. Item field in batch shape, top-level in flat shape. |
| `schemaMode` | `"permissive" \| "strict"` | No | Validation mode for the effective output schema. Overrides the parent mode; defaults to `permissive`. After schema-retry exhaustion, permissive mode can accept invalid payloads with a warning; strict mode fails. Invalid caller schemas fail preflight in either mode. |
| `tools` | `string[]` | No | Named tools already defined in the parent's Python or JS eval kernel. Present when `eval.tools.enabled=true`; child calls execute in the parent kernel, not the child's. Rejected in plan mode. Item field in batch shape, top-level in flat shape. |
| `isolated` | `boolean` | No | Run in an isolated workspace and capture patches/branch changes. Present only when `task.isolation.enabled` is true and plan mode is disabled. Kept-alive task agents retain their workspace through idle/parked transitions and can be revived; release captures final changes and cleans the workspace. |

There is no wire label field: the one-line UI label shown in the TUI/registry is generated automatically from the `task` text by the tiny/title model (fire-and-forget), so callers never provide it.

Available tool-using chat models are also exposed automatically as general-purpose agents named by their exact `provider/model` selector. Their pool follows the session picker scope and model availability, including newly discovered models. See [automatic model agents](../task-agent-discovery.md#automatic-model-agents) for filtering, live updates, and nested delegation.

Users can tag models with `^` in the composer. The resulting session-local `m1`, `m2`, … pseudonyms are accepted as `agent` by task, eval `agent()`, and `workpool()`; each uses the bundled task template pinned to the tagged selector. See [user-tagged model agents](../task-agent-discovery.md#user-tagged-model-agents) for persistence, boundaries, and precedence.

Runtime stays permissive: the flat form is accepted even while `task.batch` is on (internal callers such as the commit flow's `analyze_files`, and stale transcripts). The model only ever sees one shape.

There is no legacy per-call `schema` parameter. Use `outputSchema` and optional `schemaMode`; when absent, structured output falls back to the agent definition's `output` frontmatter and then the inherited parent session schema.

## Outputs

The tool returns one text block plus `details: TaskToolDetails`.

Background response (`async.enabled=true`):
- `content`: `` Spawned agent `<id>` (job `<jobId>`). `` plus auto-delivery guidance: use `wait` only when blocked, `read proc://<id>` for non-consuming inspection, `write proc://<id>/kill` to cancel, and `write agent://<id>` to coordinate when peer messaging is enabled. A batch call instead returns `` Spawned N background agents using <agent types>. ... `` (the deduped per-item agent types, comma-joined) with a per-agent `- `<id>` (job `<jobId>`)` listing.
- `details`: `{ projectAgentsDir, results, totalDurationMs, progress: [<AgentProgress per spawn>], async: { state, jobId, type: "task" } }`. The call keeps one shared `progress[]` snapshot; `async.jobId` is the first started job and `async.state` aggregates over the async spawns ("running" until every job settles, "failed" if any spawn failed) — jobs that settled before the call returned are already reflected. A mixed call's `results` carries the blocking spawns' inline `SingleResult`s (pure background calls return `results: []`).
- Live progress streams into the same tool block via `onUpdate(...)`; final results arrive as async-result injections. Non-isolated completions get an idle/follow-up hint when messaging is enabled. Budget-stopped resumable agents get a resume hint; hard aborts point at the transcript. The current `task-follow-up.md` template still labels isolated runs non-resumable, despite the retained-workspace lifecycle described below.

Settled response (`async.enabled=false`, no job manager, every item's agent `blocking: true`, or async job body):
- `content`: summary rendered from `packages/coding-agent/src/prompts/tools/task-summary.md` with a preview capped at 5000 chars; `agent://<id>` holds the full output. A sync batch concatenates the per-spawn summaries.
- `details.results`: one `SingleResult` per spawn; `usage`, `outputPaths` populated (aggregated across spawns for a sync batch).

`SingleResult` includes:
- identity: `index`, `id`, `agent`, `agentSource`, `task`, `description`, optional `assignment` (internal payload names; the wire fields are `name`/`agent`/`task`)
- status: `exitCode`, optional `error`, optional `aborted`, optional `abortReason`, optional `retryFailure`
- output: `output`, `stderr`, `truncated`, `durationMs`, `tokens`, `requests`, optional `contextTokens`/`contextWindow`, `usage`
- model: optional `modelOverride`, `modelRole`, `resolvedModel`, `resolvedModelIdentity`, `resolvedThinkingLevel`, `resolvedModelIsFallback`, `resolvedModelRoute`, `advisor`
- structured result: optional `structuredOutput` with schema source/mode, validation status, parsed `data`, and validation `error`
- artifact metadata: `outputPath?`, `isolated?`, `patchPath?`, `hasRootChanges?`, `branchName?`, `branchBaseSha?`, `nestedPatches?`, `nestedPatchPaths?`, `outputMeta?`
- extracted tool data: `extractedToolData?` from registered subprocess tool handlers such as `yield`

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file.
- Structured payloads with a `data` value also write `<id>.json`, even when schema-invalid. JSON-path reads prefer this sidecar and fall back to parsing `<id>.md`; a later output without structured data removes a stale sidecar.
- A subagent's own children are dot-qualified (`<id>.<child>`); `agent://<id>.<child>` reads that nested output. A slash path is always JSON extraction: `agent://<id>/<key>/<index>/…` extracts that value from a JSON output (e.g. `agent://<id>.<child>/reports/0/data`).
- Each subagent gets `<id>.jsonl` session history when the parent persists artifacts; `history://<id>` renders it as a concise transcript (works for live and parked agents).
- Isolated patch mode writes `<id>.patch` before merge; nested changes write `<id>.nested-<n>-<path>.patch` files in both merge modes.

## Flow
1. `TaskTool.create(...)` discovers agents through a process-level memo keyed by resolved cwd and effective extension roots (`discoverAgentsForCreate`). `refreshAgentDiscovery(...)` replaces the matching description snapshot after explicit reloads.
2. `execute(...)` repairs raw params (`repairTaskParams`), then validates: `schema` is always rejected; `tasks`/`context` are rejected unless `task.batch` is on; batch calls need a non-empty `tasks` (a `task` per item, unique provided names), a non-empty shared `context`, and no top-level `task` alongside `tasks`; flat calls need `task`. The call is then normalized into its spawn list (`resolveSpawnItems`).
   Eval-tool names and every item's effective spawn policy are preflighted before normal dispatch registers jobs. Unknown/disabled agents, invalid caller schemas, depth/spawn-policy violations, and unavailable plan-mode controls fail the call before dispatch.
3. Per-item execution split: items whose agent type declares `blocking: true` run inline; the rest become background jobs. The whole call runs sync when `async.enabled=false`, the session has no `AsyncJobManager` (orphaned host), or every item is blocking; inline spawns run as `SpawnRun`s (`src/task/spawn-run.ts`), each holding a session-scoped semaphore permit until it settles.
4. Background execution (any non-blocking item with `async.enabled=true` and an `AsyncJobManager`):
   - agent ids are allocated up front via `AgentOutputManager.allocate(...)` — each item's `name`, or a generated AdjectiveNoun name — one per spawn;
   - one `type: "task"` job per spawn is registered with `session.asyncJobManager` (`id` = agent id, `queued: true`, `ownerId` = caller agent id) and the tool returns immediately;
   - each job body starts — or adopts, after a speculative launch — a `SpawnRun`, which acquires the session-scoped `Semaphore` (one per `TaskTool` instance, resized in place from the live `task.maxConcurrency` setting before every acquire and release); the job is marked running once the permit is held and reports progress through the shared `buildAsyncDetails`/`onUpdate`;
   - a failed or aborted run throws `TaskJobError` so the job lands `failed`, but the agent itself stays registered and interrogable.
   - a mixed call registers the async jobs first, then runs its blocking items inline and returns once they settle — the text combines the inline summaries with the spawned-job listing, and the block keeps rendering the still-running background rows beside the inline results.
5. Each `SpawnRun` calls `#runSpawn` → `runStructuredSubagent(...)`. Shared policy resolution reloads settings and rediscovers agents from disk, so runtime resolution can differ from the create-time description.
6. It resolves the requested agent, enforces depth/spawn policy and `PI_BLOCKED_AGENT` self-recursion prevention, validates the effective output schema, and applies `before_subagent_spawn` routing/blocking hooks.
7. Model priority: `task.agentModelOverrides` → agent frontmatter → configured task role/session fallback. Output schema priority: per-call `outputSchema` → agent frontmatter `output` → inherited parent session schema.
8. Plan mode supplies `read`, `grep`, `glob`, `web_search`, and any configured `ast_grep`, replaces the agent's spawn/prewalk controls, and disables LSP/IRC. Eval-defined tools and isolation/apply/merge controls are rejected.
9. If `isolated`, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`), maps `isolation.backend` to a backend-kind hint (`parseIsolationBackend`), and materializes the workspace via the natives PAL (`ensureIsolation` → `isoResolve`/`isoStart`), walking the candidate list when a backend is unavailable.
10. Artifacts dir comes from the parent session file when available, otherwise a temp dir. When the session is executing an approved plan, the plan reference is handed to the subagent.
11. Non-isolated spawns call `runSubprocess(...)` with parent cwd. Isolated spawns run in their workspace and capture root/nested patches or a branch. Successful changes apply only when `task.isolation.apply=true`; failed capture/merge paths preserve recovery artifacts. Kept-alive runs transfer workspace cleanup to the lifecycle owner rather than tearing it down at completion.
12. `runSubprocess(...)` creates a child agent session with an isolated settings snapshot (parent settings inherited — `async.enabled` and `bash.autoBackground.enabled` are **inherited** from the parent, not force-disabled; `tier.openai`/`tier.anthropic`/`tier.google` are first re-resolved through `tier.subagent`, then the child session resolves an exact `task.agentServiceTierOverrides[agentName]` entry handed over by task/eval dispatch against its final model and persists the result; `tools.approvalMode` is forced to `yolo` because headless subagents have no UI to confirm prompts against; `advisor.enabled` is forced off unless the spawn opts in per agent; per-spawn overrides may disable read summarization and clear extra workspace roots for isolated runs), child `agentId` equal to the allocated id, child internal URL router/`AgentOutputManager`, output schema, the shared `context` (batch calls) in the system prompt's `CONTEXT` section, and the IRC peer roster in the system prompt.
13. Child tool availability starts from explicit `agent.tools` when provided; auto-add `task` for declared spawns below the depth limit. Explicit lists containing `task`/`bash` gain `wait` unless restricted, and the registry still requires an async/IRC/service wake source. `exec` expands to `bash` plus `eval` when a backend is enabled. Outbound messaging requires explicit `write`, while inbound steering does not. Parent-owned `todo` is stripped unless prewalk is armed.
14. The child must finish through the hidden `yield` tool; up to 3 reminder prompts, the last forcing `toolChoice = yield` when supported. `finalizeSubprocessOutput(...)` reconciles raw text, `yield` payloads, structured schemas, and abort states.
15. End-of-run lifecycle (keep-alive, in the run finalizer):
    - caller signal, wall-clock timeout, or internal hard abort → registry status `aborted`, session disposed — terminal;
    - soft-request-budget abort on a kept-alive agent with a reviver → treated as resumable: the agent becomes `idle` and may receive a follow-up/revival;
    - manager shutdown → dispose/unregister the process-local session without a hard-kill tombstone;
    - isolated kept-alive run → follows the same idle/parking/revival path while retaining its workspace; explicit release captures final patches/branch state and cleans the isolation handle;
    - everything else (success and failure alike) → status `idle` with the live session attached, and `AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` arms the park timer. The reviver reopens the session JSONL.
16. Lifecycle thereafter: `idle` agents are parked after `task.agentIdleTtlMs` (session disposed; `AgentRef` + session file retained); `write agent://<id>` or the Agent Hub revives them back to `idle`. `"Main"` is never parked.

## Modes / Variants
- Execution mode
  - Background job — `async.enabled=true`; non-blocking spawns go through `AsyncJobManager`.
  - Sync inline — `async.enabled=false`, no job manager, or the item's agent declares `blocking: true` (per item: a mixed call runs both modes).
- Batch mode (`task.batch`, default on)
  - on — `{ context, tasks[] }`: one independent spawn per item, required `context` shared across the call's spawns, with `agent`, `outputSchema`, and `schemaMode` per item. `effort` appears only when its setting enables it; `isolated` also requires plan mode to be disabled. Lifecycle, revival, and concurrency semantics match N parallel single calls.
  - off — single spawn per call; `tasks`/`context` are rejected and removed from the schema, with the same conditional `effort`/`isolated` fields.
- Speculative launch (`task.speculativeLaunch`, default on; batch mode only) — while a `{ context, tasks[] }` call streams, the tool's stream session (`src/task/speculative-launch.ts`) starts each item's `SpawnRun` as soon as that item's JSON object closes (`context` must already have closed), and starts the remainder when the call finishes streaming. Dispatch adopts runs whose normalized spawn params still match; an invalid finished call, launched items that differ from the finished call, a blocking hook, or an aborted turn aborts every launched run. Launches need host authorization (`authorizeLaunch`): auto-allowed `task` approval and no extension `tool_call`/`tool_result`/approval lifecycle handlers.
- Isolation is enabled with `task.isolation.enabled`; `isolation.backend` selects `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, or `rcopy`, and the PAL resolves the actual backend with fallback.
- Isolation merge strategy: `task.isolation.merge` selects patch mode (capture/apply root patches) or branch mode (commit to `omp/task/<id>`, cherry-pick into parent). `task.isolation.apply=false` retains captured changes without applying them; nested repositories get separate patch artifacts.
- Eval-defined tools: `tools` resolves names across the parent's retained Python/JS kernels. Unknown names, disabled sharing, or the same name defined in both kernels fail preflight; these tools are not available in plan mode.
- Agent source precedence is first-wins by exact name: project `.omp/agents`; user `.omp/agent/agents`; OMP extension-package `agents/` roots in CLI → project settings → user settings → installed npm/link plugin order; Claude marketplace plugin agents (project before user); then bundled (`scout`, `reviewer`, `security-reviewer`, `task`, `sonic`).
- Prewalk: agent frontmatter `prewalk` or `task.agentPrewalk[agentName]` can start on the normal model and hand off to a cheaper resolved model at the first edit/write. `task.prewalk` (default off) arms this behavior for the bundled generic `task` agent. Missing/unconfigured targets and exact model+effort no-ops skip the handoff rather than failing the spawn.
- Advisor: agent frontmatter `advisor` or `task.agentAdvisor[agentName]` (`"on"` / `"off"` / model pattern) pairs the child session with an advisor; an explicit pattern lands on the child's `modelRoles.advisor`. Subagents default to no advisor.

## Side Effects
- Filesystem
  - Writes `<id>.jsonl` and `<id>.md` under the session artifacts dir or a temp task dir; isolated patch mode writes `<id>.patch`.
  - Creates/removes worktrees or overlay mount directories; branch mode creates temporary worktrees and task branches.
- Network
  - Child sessions may use whichever networked tools/models their active tool set permits.
  - MCP proxy tools can call existing parent MCP connections with a 60_000 ms timeout.
- Subprocesses / native bindings
  - Isolation backends run through the `pi-natives` PAL (`crates/pi-iso`): kernel `overlay` with `fuse-overlayfs`/`fusermount[3]` fallback on Linux, APFS/Btrfs/ZFS/reflink clones, ProjFS on Windows, recursive copy as last resort.
  - Git operations for baseline capture, patch apply, worktrees, branches, stash, cherry-pick, commits.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Creates child `AgentSession` instances with isolated settings snapshots; finished sessions stay registered in the process-global `AgentRegistry` as `idle`/`parked` until process teardown or explicit release.
  - With `async.enabled=true`, registers one async job per spawn in `session.asyncJobManager`; completion is injected into the parent as an async-result message.
  - Arms idle-TTL timers in `AgentLifecycleManager` (unref'd; they never hold the process open).
  - Emits `task:subagent:event`, `task:subagent:progress`, and `task:subagent:lifecycle` on the parent event bus.
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` stays unique across invocations.
  - Shares the parent `local://` root and `ArtifactManager` with subagents.
- Background work / cancellation
  - `write proc://<jobId>/kill` (no `content` needed) or parent tool-call abort cancels background jobs; parent tool-call abort cancels sync runs through the call signal. A hard-aborted run lands `aborted` and is torn down. An owned running subagent without a job can be cancelled through `proc://<agentId>/kill`, which aborts and releases its session.
  - Missing-`yield` recovery sends up to three internal reminder prompts to the child session.

## Limits & Caps
- Tool mode: `approval="exec"`, `strict=false`, `lenientArgValidation=true`, `loadMode="essential"`.
- Per-spawn effort is opt-in: `task.enableEffort` defaults to `false`; when false, `effort` is omitted from the dynamic model-facing schema.
- Concurrency: `task.maxConcurrency` defaults to `32`; `0` means unlimited. One session-scoped `Semaphore` is resized from the live setting before every acquire/release and bounds every `SpawnRun` across task calls, including sync and speculative runs.
- Isolation baseline: each repository's uncommitted snapshot is capped at `1 GiB` (`ISOLATION_BASELINE_MAX_CONTENT_BYTES` in `task/worktree.ts`). Oversized snapshots fail before spawning rather than buffering unbounded content.
- Idle TTL: `task.agentIdleTtlMs`, default `420_000` ms (7 min); `<= 0` disables parking and keeps idle sessions live until exit.
- Per-subagent output truncation: `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5000` in `packages/coding-agent/src/task/types.ts` (overridable via `PI_TASK_MAX_OUTPUT_BYTES` / `PI_TASK_MAX_OUTPUT_LINES`). Full raw output is still written to `<id>.md`.
- Progress coalescing: `PROGRESS_COALESCE_MS = 150`; recent-output tail: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024` (last 8 non-empty lines).
- Missing-`yield` reminder retries: `MAX_YIELD_RETRIES = 3`; MCP proxy timeout: `MCP_CALL_TIMEOUT_MS = 60_000` — both in `packages/coding-agent/src/task/executor.ts`.
- Soft request budget: `task.softRequestBudget` defaults to 200 requests (`0` disables). Crossing it injects a wrap-up notice when `task.softRequestBudgetNotice` is enabled; at 1.5× the budget the run is force-stopped to yield partial findings. Bundled scout/sonic agents may impose a lower built-in cap.
- Hard wall clock: `task.maxRuntimeMs` applies to every spawn; default `0` disables it.
- Recursion depth: `task.maxRecursionDepth` defaults to `2`; negative values disable the cap. The tool registry and shared preflight enforce it, and `runSubprocess(...)` strips child `task` access at max depth.
- Inline summaries use `FULL_OUTPUT_THRESHOLD = 5000` characters in `packages/coding-agent/src/task/result-summary.ts`; truncation requires a full output artifact. `agent://<id>` points to that artifact.

## Errors
- Shape/preflight failures return `isError: true`, explanatory text, and empty `results`:
  - `schema` (never accepted)
  - `tasks` / `context` while `task.batch` is disabled
  - batch calls: missing/empty `tasks`, an item without `task`, duplicate provided names, missing shared `context`, top-level `task` alongside `tasks`
  - flat calls: missing/empty `task`
  - invalid effort, unknown/settings-disabled agents, depth/spawn-policy denial, invalid caller output schemas, disabled isolation, or isolation/eval-tool controls in plan mode
  - unknown eval tools, disabled eval sharing, or a name defined in both parent kernels
- Isolation preparation failures return `Isolated subagent execution could not be prepared: ...`. They distinguish missing Git repositories, pure Jujutsu workspaces without colocated Git, and oversized snapshots. Unavailable backends fall back through the PAL candidate list; other setup/capture failures preserve available output and recovery artifacts.
- Job registration failure returns `Failed to start background task job(s): ...`; a batch that schedules only some jobs reports the failed ids in the immediate text and keeps the started ones running.
- Child failures surface as `SingleResult.exitCode = 1` with `stderr`/`error` populated; the async job is marked failed but the delivery text still carries the output plus a follow-up/transcript hint.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- `agent://<id>` reads report unavailable sessions/artifact directories, missing ids, or invalid JSON for field extraction. `agent://all` is write-only; message targets cannot carry JSON-path suffixes.

## Notes
- Parallelism is parallel `task` calls in one assistant message — or, with `task.batch`, a `tasks[]` batch in one call; either way the session-scoped semaphore bounds the fan-out. With `async.enabled=true`, each spawn is an independent background job.
- Shared background convention without batch mode: write it once to a `local://` file and reference that path in each spawn's `task` — subagents share the parent's `local://` root. With `task.batch`, the required `context` parameter carries the shared background directly into each spawn's system prompt.
- Prefer messaging an existing agent via `write agent://<id>` over a fresh spawn for follow-up work: it already holds the relevant context. Bare `history://` discovers registered transcripts; messaging a parked agent revives it. `history://<id>` shows what an agent has done.
- Peer-messaging availability is derived, not configured (`isIrcEnabled` in the messaging helper): it requires a caller with `write` and someone to message — the session can spawn subagents, or it is a subagent itself. Without peer messaging, the follow-up hint does not suggest it.
- Agent discovery precedence is first-wins by exact name: project `.omp` agents before user `.omp`, then OMP extension-package roots, Claude marketplace plugin agents (project before user), and bundled agents. Direct `.claude/agents`, `.codex/agents`, and `.gemini/agents` roots are skipped. Create-time discovery is memoized per cwd/effective extension roots; execution-time discovery stays fresh.
- Child sessions do not inherit conversation history. Built-in carry-over is the workspace tree/skills/context files, the shared `local://` root, and the approved-plan reference when one exists.
- When the parent passes `mcpManager`, child sessions disable standalone MCP discovery and get proxy tools that reuse parent connections.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking; a stash-pop conflict leaves the landed commits on HEAD and preserves the stash, reported as `stashConflict`. Patch mode uses `repo.canApplyPatch(...)` before applying the root patch; reverse-only applicability is treated as already applied, while failed forward checks retain the artifact for recovery.
- Nested git repos are diffed independently inside isolated workspaces and merged separately with `applyNestedPatches(...)`.
- `agent://` ids are name-based (`Task` first, `Task-2`/`Task-3` only when the name repeats, nested like `Parent.Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested invocations.
