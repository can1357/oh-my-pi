# Exomode decision (stub — Phase 0 input, not approved scope)

Single opt-in master switch over four independently-killable optimization
subsystems. Behavior-preserving: identical outputs, lower time/cost per task.

## Inspected integration points

- Master-switch + bulkheads precedent: `DynamicRoutingConfig`
  (`packages/coding-agent/src/routing/types.ts:23-40`) — `enabled`,
  `strategy`, `cooldownDurationMs`, `pools`, `vetoes`. Exomode copies this
  shape: `exomode: { enabled, ledger, promptCache, sealedSecrets,
  costPolicy }`, each defaulting true when the master is on.
- Settings-schema precedent: `fusion.enabled` master with conditional
  subkeys (`packages/coding-agent/src/config/settings-schema.ts:898-1016`,
  `condition: "fusionEnabled"`). Exomode registers the same way.
- Measurement substrate: `packages/stats/README.md:12-21` — per-request
  `duration`, `ttft`, `usage.cost.total`, cache rate already flow into
  `~/.ompk/stats.db`. Missing (lane A builds): per-TASK aggregation
  (wall-time, TTFT, tokens, $/task) queryable by policy code.

## Precedence (non-negotiable)

`explicit user selection > pool affinity > exomode suggestion`.
Exomode fills defaults and fails over; it never overrides a choice.

## Lane file ownership (disjoint)

| Lane | Owns | May not touch |
|---|---|---|
| A ledger (pre-phase) | `packages/stats/*` task aggregation, task-completion hook | routing, session assembly |
| B prompt-view cache | session message assembly only | stats, prompt boundary |
| C sealed secrets | prompt-build boundary filter + tests | stats, assembly internals |
| D cost policy | routing/fusion policy params only | stats schema, prompt boundary |
| E acceptance | evidence doc + `findings-*.md` deletion | all src/ |

## Testable gates (wall-time / accuracy)

- [ ] `bun run check:types` exits 0 (repo gate, orchestrator runs once post-merge)
- [ ] Ledger: per-task record `{ wallMs, ttftMs, inputTokens, outputTokens,
      costUsd }` asserted in a lane-A test against a fixture session log
- [ ] Prompt cache: byte-identical assembled prompt with/without cache
      asserted in a lane-B test; benchmark shows TTFT delta > 0 on a
      50k-token fixture conversation
- [ ] Sealed secrets: test feeds a fake token via auth.json + env and asserts
      it never appears in the assembled prompt (lane C)
- [ ] Cost policy: ledger-driven pool choice asserted in a lane-D test;
      explicit user selection always wins (precedence test)
- [ ] `git diff --name-only` per lane matches its ownership row; E deletes
      all `findings-*.md` fragments

## Frozen contract (superseded by Phase 0 quick-scope — planner read the stats
parser; this is the binding version; lane A delivers it, lanes B/C/D depend on it)

```ts
interface TaskLedgerRecord {
  taskId: string;       // `${sessionFile}#${anchorUserEntryId}` — stable across re-aggregation
  sessionFile: string;  // MessageStats.sessionFile
  folder: string;       // project path from session filename
  agentType: "main" | "subagent" | "advisor";
  model: string;        // responding model of the task's final request
  provider: string;
  startedAt: number;    // anchor user-message timestamp (epoch ms)
  completedAt: number;  // final linked assistant timestamp (epoch ms)
  wallMs: number;       // SUM of per-request duration — EXCLUDES idle (pinned by test)
  ttftMs: number | null;// first-request ttft of the span
  inputTokens: number;  // SUM usage.input
  outputTokens: number; // SUM usage.output
  cacheReadTokens: number;
  requestCount: number;
  costUsd: number;      // SUM usage.cost.total
  stopReason: StopReason;
}
interface ModelEconomics {
  model: string; provider: string; taskCount: number;
  avgCostUsd: number; avgWallMs: number; avgTtftMs: number | null;
}
// Task span: anchor = latest user message in the same sessionFile with
// user.timestamp <= request.timestamp; span ends at the next anchor.
// Anchors resolve INSIDE aggregateTasks against confirmed user rows —
// never by parent chains, never by caller index alignment (the parser emits
// a stat for every assistant but a link only when parentId+model/provider
// exist, so raw link arrays are not 1:1 with requests). No coding-agent
// hook, no new session-log type; lane A stays in packages/stats/*.
function aggregateTasks(requests: MessageStats[], users: UserMessageStats[]): TaskLedgerRecord[];
async function getRecentTaskStats(opts?: { limit?: number; cutoffMs?: number; folder?: string }): Promise<TaskLedgerRecord[]>;
async function getTaskEconomicsByModel(windowMs?: number): Promise<ModelEconomics[]>;
```

Precedence enforcement points (frozen): explicit model param at `streamFn`
entry wins; `pool-manager.selectTarget` affinity applies only when no
explicit selection; cost policy (lane D) may only suggest the initial
target and order failover candidates — never override either of the above.
Lane D must include a precedence test proving an explicit selection survives
an exomode suggestion to the contrary. Lane D imports the query API read-only
and fails open on empty/missing db (no suggestion, defer to affinity).
