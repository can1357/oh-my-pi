# SUBAGENT HANDOFF PROMPT

## Role

You are the implementation lead for an **opt-in autonomous Fusion workflow** in OMPK. Integrate existing orchestration components into a coherent, enforceable planner/worker lifecycle. Do not merely add prompts, schemas, or disconnected infrastructure.

## Task

Continue from the current investigation and implement the workflow the user authorized:

- A planning-only root.
- Durable delegated work using existing operational infrastructure.
- Isolated writing workers.
- Bounded but complete handoffs that support replanning.
- Compatible Fusion model routing.
- Visible workflow status, stop controls, and safe recovery.
- Behavioral tests and an end-to-end verification.

Keep ordinary token-saving Fusion behavior unchanged unless the user explicitly selects the new workflow.

## Context

Repository: `C:/dev/infra/oh-my-pk`  
Primary package: `packages/coding-agent/`  
Platform: Windows 11, Bun.

The user compared our multi-agent workflow with Cursor’s *Self-driving codebases* article. The agreed direction is to combine our existing components rather than introduce another scheduler or task ledger.

The distinction driving this work:

- **Autonomous workflow:** owns goals, scopes, task states, handoffs, recovery, and integration.
- **Token-saving Fusion:** selects appropriate model roles and controls context expenditure.
- **Execution infrastructure:** supplies tools, isolated workspaces, durable jobs, leases, and observability.

The user explicitly authorized implementation. They did **not** request a commit, push, release, or changes to hosted automation this turn.

### Current state

Investigation is underway. **No implementation edits have been made for this feature yet.**

The working tree started with three modified binaries from unverified concurrent work:

- `packages/coding-agent/dist/oh-my-pk.exe`
- `packages/coding-agent/dist/omp.exe`
- `packages/coding-agent/dist/ompk.exe`

Do not overwrite, stage, delete, or assume ownership of them. Build verification must use a separate output location if needed.

Shared investigation context:
`local://autonomous-fusion-implementation.txt`

Two read-only advisers are already running:

- **`AutonomousDesign`** — comparing integration architectures and identifying enforcement, lifecycle, routing, and UI contracts.
- **`DurableContract`** — mapping existing durable queue/runner APIs, scoped execution, lease behavior, and safe recovery.

Their start calls returned immediately. The lead may continue independent work while they run. Obtain their findings through the existing task/IRC facilities; do not restart duplicate investigations.

The parent is currently the **sole code writer**. Do not spawn implementation workers or hand off code ownership without satisfying repository collaboration requirements.

### Verified implementation facts

#### Fusion controls and routing

`packages/coding-agent/src/slash-commands/helpers/fusion.ts`:

- Existing modes: `off`, `delegate`, `escalate`, `token-savings`; `savings` is an alias.
- `buildFusionStatusText()` provides status.
- `handleFusionCommand()` handles mode changes.
- Bare `/fusion` has a separate interactive-menu path.
- Argument completions are in `src/slash-commands/builtin-registry.ts`.

`src/session/agent-session.ts`, approximately lines 10689–10808:

- `#maybeApplyFusionTokenSavingsLimit()` counts default-model calls.
- Continuing root work can currently switch to the task model after the configured limit.
- If that switch is unavailable, it injects guidance.
- This is **not** a planning-only role restriction.
- Existing manual model override behavior must remain authoritative. In the new workflow, choosing a model must not implicitly grant implementation-tool access or turn the planner into a worker.

#### Native task execution

`src/task/index.ts`:

- `TaskTool.execute()` validates and prepares every spawn before allocating externally visible work.
- Native tasks support synchronous and asynchronous execution.
- `#runSpawn()` owns worker launch, isolation, result handling, and patch application (`mergeTaskBranches` in branch mode, `applyText` in patch mode).
- `ensureIsolation()` in `src/task/worktree.ts` manages isolated git worktrees, capturing baselines and tearing down worktrees in `finally`.
- Replaying identical agent IDs without state awareness triggers `rm(baseDir)` at `worktree.ts:398-406`, destroying unmerged evidence.
- Integration outcomes (`changesApplied`, `mergeSummary`) are currently local variables in `#runSpawn`; structured integration receipts must be preserved on `SingleResult` to avoid guessing status from text summaries.

#### Durable execution infrastructure

`packages/coding-agent/src/operational/`:

- `store.ts` (`OperationalStore`): SQLite-backed persistence for `jobs`, `checkpoints`, `notifications`, and `trajectory_events`.
- `runner.ts` (`DurableRunner`): provides lease-based execution (`DEFAULT_LEASE_MS = 60_000`), atomic claims, heartbeats via lease renewal, checkpoint persistence, and automatic recovery of expired leases.
- `runOnce()` currently claims the oldest queued job globally across all types; session-targeted execution requires scoped claim/await semantics so interactive sessions do not steal unrelated background jobs, and operational CLI workers claim only their designated job types.
- At-least-once execution semantics require checkpointing before starting modifying work, and transitioning to a reconciliation hold on unexpected failure rather than blindly repeating destructive work.

## Scope

- `packages/coding-agent/src/session/agent-session.ts`:
  - Hook `beforeToolCall` to enforce planning-only tool constraints when autonomous mode is active.
  - Expose autonomous workflow mode transitions and status.
  - Wire task completion events to replanning triggers.
- `packages/coding-agent/src/slash-commands/helpers/fusion.ts` & `builtin-registry.ts`:
  - Expose `autonomous` mode in `/fusion mode autonomous` and the interactive menu.
  - Update status reporting to display autonomous planner state, active workers, and durable queue health.
- `packages/coding-agent/src/task/`:
  - Integrate native task execution with `OperationalStore` and `DurableRunner`.
  - Preserve structured integration receipts on `SingleResult`.
  - Ensure isolated writing workers default to worktree isolation and hold for reconciliation on merge failure.
- `packages/coding-agent/test/`:
  - Focused behavioral tests for planning-only enforcement, durable execution adapter, replanning triggers, and recovery.

## Non-goals

- Do not alter or break default Fusion behavior (`off`, `delegate`, `escalate`, `token-savings`).
- Do not make Fusion or autonomous workflow enabled by default.
- Do not overwrite or stage the unverified concurrent binaries (`packages/coding-agent/dist/*.exe`).
- Do not modify or depend on external Linear hosted workflows; keep local execution self-contained.
- Do not create commits, pushes, releases, or git tags.

## Procedure

1. **Autonomous Mode Declaration**:
   - Add `autonomous` to valid `fusion.mode` options in `fusion.ts`, settings schema, and completions.
   - Update `buildFusionStatusText()` to report autonomous workflow metrics.
2. **Planning-Only Root Enforcement**:
   - In `AgentSession`, when `fusion.mode === 'autonomous'` and `agentKind === 'main'`, enforce through `beforeToolCall` that the root agent cannot directly invoke destructive write/edit tools (e.g., `edit`, `write`, destructive `bash` commands).
   - Require modification tasks to be delegated through `task` subagents.
   - Preserve read-only tools (`read`, `grep`, `glob`, inspection `bash`, `todo`) for planning and verification.
3. **Durable Task Execution Adapter**:
   - Wire `task` spawns to enqueue durable jobs in `OperationalStore`.
   - Implement targeted-job claim/await in `DurableRunner` to prevent cross-session job contention.
   - Add structured integration receipts to task results.
4. **Replanning on Task Completion**:
   - On subagent completion or failure, deliver structured handoffs into the planner's context, triggering the next planning evaluation.
5. **Verification**:
   - Write focused unit and integration tests covering mode activation, tool restriction, durable job lifecycles, and replanning triggers.
   - Run package typecheck and test suites.

## Acceptance

- `/fusion mode autonomous` activates the autonomous planner workflow.
- In autonomous mode, direct file modifications by the root agent are blocked with an actionable advisory to delegate to a worker.
- Delegated tasks create durable jobs and report structured completion/merge receipts.
- Existing token-savings and balanced Fusion modes remain 100% functionally identical.
- All focused tests and package `bun check` pass.

## Reporting

Return a concise implementation report detailing:
1. Changed files and lines.
2. Verified behavioral test outputs.
3. Confirmation that existing modes and unverified binaries were untouched.
4. Any remaining edge cases or follow-up opportunities.
