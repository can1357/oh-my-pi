# Lane A — Foundations and selector validation [pre-phase]

## 1. Mission + read-first

You are the pre-phase sub-agent for oh-my-pi-fork at `C:/dev/desktop-projects/oh-my-pi-fork`. Establish the immutable execution-profile, allocation-free spawn-plan, and canonical selector contracts consumed by every downstream lane.

**Read first** (each in full):
- `.prd/small-model-orchestration-overview.md` — pipeline context
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md` — INV-01 and INV-02 evidence
- `.ompk/mapreduce/small-model-orchestration/small-model-orchestration.selectors.md` — coverage contract
- `packages/coding-agent/src/config/model-resolver.ts`
- `packages/coding-agent/src/task/index.ts` — read-only consumer; do not edit
- `packages/coding-agent/src/session/fusion-sidekick.ts` — read-only consumer; do not edit

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/orchestration/agent-execution-profile.ts` (new)
- `packages/coding-agent/src/task/spawn-plan.ts` (new)
- `packages/coding-agent/src/config/spawn-selector-validation.ts` (new)
- `packages/coding-agent/src/config/model-resolver.ts` (existing)
- `packages/coding-agent/src/config/subagent-model-aliases.ts` (existing)
- `packages/coding-agent/src/config/settings-schema.ts` (existing)
- `packages/coding-agent/src/config/settings.ts` (existing)
- `packages/coding-agent/test/orchestration/agent-execution-profile.test.ts` (new)
- `packages/coding-agent/test/task/spawn-plan.test.ts` (new)
- `packages/coding-agent/test/config/spawn-selector-validation.test.ts` (new)
- `packages/coding-agent/test/subagent-model-aliases.test.ts` (existing)

You may NOT edit `task/index.ts`, `task/executor.ts`, `task/types.ts`, `sdk.ts`, Fusion, tools, IRC/registry, extension files, package manifests, changelogs, or any Lane B–E file.

## 3. Gap (verbatim from the table)

> A — Foundations and selector validation: Freeze tier/autonomy/work-class/collaboration contracts, resolve an allocation-free spawn plan, canonicalize role/alias selectors, and provide structural plus post-provider validation primitives (0% complete). [LARGE] depends on: none | files: orchestration profile, spawn plan, config resolver/aliases/settings/validation and focused tests

## 4. What to build

### `agent-execution-profile.ts`

Export actual named types—never `ReturnType<>`:

```ts
export type AgentTier = "light" | "mid" | "frontier";
export type AgentAutonomy = "bound" | "supervised" | "independent";
export type CollaborationMode = "report-only" | "message-peers" | "self-coordinate";
export type WorkClass = "mechanical" | "judgment";
export type AgentEditMode = "none" | "replace" | "hashline" | "apply-patch";

export interface AgentExecutionProfile { /* immutable resolved envelope */ }
export interface AgentExecutionProfileInput { /* settings/agent/workflow inputs */ }
export function resolveAgentExecutionProfile(input: AgentExecutionProfileInput): AgentExecutionProfile;
```

Required invariants:
- tier, autonomy, collaboration, and work class are independent axes;
- `workClass: "judgment"` has minimum tier `mid`;
- restrictive inputs compose by intersection/minimum, never widen;
- legacy/no-policy defaults preserve current behavior;
- resolved arrays/records are frozen or copied so downstream mutation cannot change a running child;
- `independent` does not imply `frontier`, and `frontier` does not imply `independent`.

### `spawn-plan.ts`

Build a pure, allocation-free plan. It must not allocate ids, jobs, worktrees, sessions, or mutate settings/global model roles.

```ts
export interface SpawnRouteCandidate {
  selector: string;
  tier: AgentTier;
  provider?: string;
  modelId?: string;
  maxRequests: number;
  maxRuntimeMs: number;
}
export interface TaskSpawnPolicyInput {
  correlationId: string; // generated without AgentOutputManager/registry allocation
  agentName: string;
  assignment: string;
  workClass: WorkClass;
  autonomy: AgentAutonomy;
  eligible: readonly SpawnRouteCandidate[];
  requestedModel?: string;
  fusionSidekick: boolean;
  manualModelSelection: boolean;
}
export interface TaskSpawnPolicyResult {
  allow: boolean;
  reasonCode?: string;
  candidateSelectors?: readonly string[];
  maxRequests?: number;
  maxRuntimeMs?: number;
  routeLabel?: "light" | "mid" | "heavy";
}
export interface TaskSpawnPolicyHook {
  beforeSpawn(input: Readonly<TaskSpawnPolicyInput>, signal?: AbortSignal): Promise<TaskSpawnPolicyResult>;
}
export interface SpawnPlanInput { /* effective agent, assignment metadata, selector intent, registry/settings snapshot */ }
export interface SpawnPlan { /* frozen profile, ordered eligible candidates, budgets, tool/spawn/collab envelope */ }
export type SpawnPlanResult = { ok: true; plan: SpawnPlan } | { ok: false; diagnostics: SpawnPlanDiagnostic[] };
export function createSpawnPlan(input: SpawnPlanInput): SpawnPlanResult;
```

Lane E adapts `SpawnPlan` to hooks and composes hook results: denial is sticky, candidate selectors intersect current eligibility, budgets take the minimum, and unknown selectors are diagnostics. A caller abort propagates and prevents spawn; classifier-internal timeout is a hook-owned fallback result, not an abort.

Keep provider/auth availability injectable; do not import task executor or AgentRegistry. Preserve ordered model patterns for the existing request-level fallback.

### Canonical selector resolution

Unify bare known roles such as `smol` with `pi/smol` without breaking concrete selectors. Preserve thinking suffixes through alias resolution. Detect normalized alias collisions and aliases that shadow a role with a divergent target. Reuse `resolveModelRoleValue()` and existing role priority semantics rather than adding a second resolver.

### `spawn-selector-validation.ts`

Provide two pure validation phases:
- structural validation after settings merge: empty selectors, normalized collisions, role-shadow divergence, malformed profiles/pools;
- semantic validation after providers/agents are known: required selectors unresolved or unauthenticated, returned as one aggregated diagnostic list.

Do not make settings load probe the network. Lane E owns the SDK invocation after provider registration.

### Settings schema

Add typed policy/config shapes required by the profile and spawn plan under one `task.agentPolicies` record (stable agent id → agent type → workflow/default precedence). The optional router enable flag belongs only to the llm-router extension config in Lane D; core dispatch has no competing enable flag. Defaults preserve current unrestricted behavior.

### Tests

Assert every invariant above, especially:
- `smol` and `pi/smol` converge;
- alias thinking suffix survives;
- collisions/divergence reject deterministically;
- invalid profile/model inputs produce diagnostics without invoking allocation callbacks;
- judgment/light resolves to mid or rejects according to explicit policy;
- tier/autonomy combinations remain independent;
- outputs cannot be mutated after resolution.

## 5. Hard constraints

1. No new npm dependencies. Use existing ArkType/settings/model primitives.
2. Post-merge `bun --cwd=packages/coding-agent run check:types` must pass; do not run it in a dependency-less worktree.
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. No breaking changes to existing exports. Additive extensions only; existing role/model resolution remains compatible.
5. Tests must prove observable contracts, not private helper implementation.
6. This is a `[pre-phase]`: do not edit downstream consumers even if wiring is tempting.
7. No `any`, `ReturnType<>`, inline imports, prompt strings in code, global setting mutation, or per-turn routing.
8. Do NOT run `bun install`, npm/yarn/pnpm, project-wide build/test/lint/format, or `tsc`. Main runs canonical gates after merge.

## 6. Verification

Run before declaring done:

```bash
git diff --check
git diff --name-only
git status --short
```

Expected:
- `git diff --check` exits 0.
- `git diff --name-only` may omit new files; the union of `git diff --name-only` and `git status --short` lists ONLY the eleven owned files.
- No `@ts-expect-error` suppressor is permitted.
- Main later runs the four focused Bun test files and coding-agent typecheck from the primary checkout.

## 7. Commit message

`feat(orchestration): establish spawn profiles and selector validation (Gap A)`

## 8. Final report

Fill in and return at the end of your response:

```text
### Lane A final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): <or "none">
- Lines added / removed:
- Verification:
  - dependency-free checks: ___
  - deferred Bun/type gates: listed for Main
  - git diff --name-only: ___
- Flags / blockers:
```
