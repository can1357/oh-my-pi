# Lane D — Spawn-only router adapter [parallel-builder+remediation]

## 1. Mission + read-first

You are the parallel-builder+remediation sub-agent for oh-my-pi-fork at `C:/dev/desktop-projects/oh-my-pi-fork`. Add an optional, disabled-by-default llm-router policy adapter that can classify one eligible child spawn with the local Qwen endpoint without switching a live coding session per turn.

**Read first** (each in full):
- `.prd/small-model-orchestration-overview.md`
- `.prd/small-model-orchestration-A-foundations.md`
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md` — INV-09
- `packages/llm-router-agent/src/extension.ts`
- `packages/llm-router-agent/src/policy.ts`
- `packages/coding-agent/src/extensibility/extensions/types.ts` — read-only future hook seam; do not edit

## 2. Owned files

You may ONLY edit these files:
- `packages/llm-router-agent/src/qwen-client.ts` (new)
- `packages/llm-router-agent/src/task-spawn-policy.ts` (new)
- `packages/llm-router-agent/src/types.ts` (existing)
- `packages/llm-router-agent/src/config.ts` (existing)
- `packages/llm-router-agent/src/validation.ts` (existing)
- `packages/llm-router-agent/src/telemetry.ts` (existing)
- `packages/llm-router-agent/tsconfig.json` (existing)
- `packages/llm-router-agent/tests/qwen-client.test.mjs` (new)
- `packages/llm-router-agent/tests/task-spawn-policy.test.mjs` (new)

You may NOT edit coding-agent extension/task/settings code, global `modelRoles`, existing serving docs/model artifacts, package manifests other than the owned `tsconfig.json`, policy/training/features modules, changelogs, or Lane B/C/E files.

## 3. Gap (verbatim from the table)

> D — Spawn-only router adapter: Reuse llm-router policy/config/validation/telemetry for one optional local `light|mid|heavy` decision per eligible child spawn, with safe mid fallback and no per-turn/global-role mutation (0% complete). [MEDIUM] depends on: A | files: llm-router task-spawn policy/Qwen client/types/config/validation/telemetry and focused tests; Lane E owns event registration

## 4. What to build

### Qwen client

Implement a small Bun/fetch client against a configurable OpenAI-compatible chat-completions endpoint (development example: `http://127.0.0.1:8901/v1/chat/completions`):

```ts
export type RouteLabel = "light" | "mid" | "heavy";
export interface QwenClassifierConfig { endpoint: string; timeoutMs: number; systemPrompt: string; }
export interface QwenClassification { label: RouteLabel; source: "classifier" | "fallback"; reason?: string; latencyMs: number; }
export async function classifySpawnDifficulty(input: string, config: QwenClassifierConfig, signal?: AbortSignal): Promise<QwenClassification>;
```

Contract:
- one non-streaming chat-completions request;
- request body uses `stream: false`, `temperature: 0`, `max_tokens: 4`, a configured system prompt, and the assignment/classification input as the user message;
- accept only a normalized exact `light|mid|heavy` label;
- malformed JSON/label, HTTP failure, connection/TLS failure, or timeout returns `mid` with a typed fallback reason;
- a caller-supplied abort propagates as abort and MUST NOT fall back or spawn; only the client's own timeout becomes typed `mid` fallback;
- never log assignment contents or secrets; telemetry records label/source/reason/latency only;
- no retry loop—the task recovery/provider policy handles later failures.

### Spawn policy adapter

Define a package-local wire contract that Lane E explicitly adapts to Lane A's core hook types; do not import coding-agent task internals:

```ts
export type RouterWorkClass = "mechanical" | "judgment";
export type RouterAutonomy = "bound" | "supervised" | "independent";
export interface RouterSpawnRouteCandidate { selector: string; tier: "light" | "mid" | "frontier"; provider?: string; modelId?: string; maxRequests: number; maxRuntimeMs: number; }
export interface RouterSpawnPolicyInput { correlationId: string; agentName: string; assignment: string; workClass: RouterWorkClass; autonomy: RouterAutonomy; eligible: readonly RouterSpawnRouteCandidate[]; requestedModel?: string; fusionSidekick: boolean; manualModelSelection: boolean; }
export interface RouterSpawnPolicyResult { allow: boolean; routeLabel?: RouteLabel; candidateSelectors?: readonly string[]; maxRequests?: number; maxRuntimeMs?: number; reasonCode?: string; }
export type RouterTaskSpawnPolicy = (input: Readonly<RouterSpawnPolicyInput>, signal?: AbortSignal) => Promise<RouterSpawnPolicyResult>;
export function createTaskSpawnPolicy(config: RouterConfig): RouterTaskSpawnPolicy;
```

Lane E maps core candidates to this wire shape and maps the result back. The shapes intentionally share field semantics but remain package-local to avoid a new package dependency.

Composition rules:
- hard eligibility and judgment minimum happen before classifier;
- denial is sticky;
- model patterns intersect; never add an ineligible selector;
- budgets only decrease;
- fallback `mid` selects only a prevalidated mid candidate; if absent, preserve the already eligible deterministic default rather than inventing a selector;
- skip classifier for Fusion warm-sidekick, ordinary user input/turn, IRC wake/revive, compaction, and explicit manual model selection;
- never mutate `settings.modelRoles` or the parent session model.

### Config and validation

Add one authoritative `taskSpawn.enabled` flag to llm-router config, default `false`; core has no competing enable flag. Validate endpoint URL, positive bounded timeout, and label mappings. Retain existing per-input routing as a separate legacy/general feature, but task-spawn enablement never turns it on.

### Extension integration export

Export the spawn-policy handler from `task-spawn-policy.ts` without registering it against the coding-agent extension API. Lane E exclusively owns `packages/llm-router-agent/src/extension.ts` and registers the handler after adding the typed core event. This keeps Lane D independently type-safe and avoids a cross-lane `@ts-expect-error` bridge.

The exported handler returns narrowed eligibility and telemetry only; it never allocates, sets a live model, or mutates settings.

### Telemetry

Record pre-allocation `correlationId` (never a spawn/agent id), agent type, work class, autonomy, eligible tier count, selected label, classifier/fallback source, reason code, latency, and applied narrowing. Do not store raw assignment text. Existing input-hook telemetry remains distinguishable by surface.

### Tests

Cover exact label parsing, malformed body/non-2xx/TLS/timeout, no-mid fallback, judgment floor, sticky deny, candidate intersection/order, budget minima, `agentName` telemetry/mapping, Fusion/manual skip, and one-call cardinality. Missing/default/disabled config performs zero fetches, emits no assignment-derived telemetry, and returns unchanged ordering/budgets. Caller abort before/during classification propagates and never returns fallback. Mock fetch with spies and restore all mocks.

## 5. Hard constraints

1. No new dependencies; use Bun/fetch and existing router utilities.
2. Post-merge package type/test gates must pass; do not run package-manager commands in a dependency-less worktree.
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. Existing exports and per-input router behavior remain compatible; new feature is additive and disabled by default.
5. Tests assert observable labels, narrowing, call count, privacy, and fallback—not implementation internals.
6. `[parallel-builder+remediation]`: add only the named Qwen/policy modules and scoped router config/validation/telemetry changes; no coding-agent hook, task allocation, Fusion, tool, contract, collaboration, or unrelated refactor.
7. No `any`, `ReturnType<>`, inline imports, per-turn coding-session routing, global model-role mutation, prompt-content telemetry, or classifier retry loop.
8. Do NOT run npm/yarn/pnpm/Bun project commands, project-wide build/test/lint/format, or `tsc` in this worktree.

## 6. Verification

Run before declaring done:

```bash
git diff --check
git diff --name-only
git status --short
```

Expected:
- `git diff --check` exits 0.
- `git diff --name-only` may omit new files; the union of `git diff --name-only` and `git status --short` lists ONLY the nine owned files.
- No `@ts-expect-error` suppressor is permitted; Lane E owns event registration.
- Main later runs both router tests, package checks, and Lane E's core hook integration test.

## 7. Commit message

`feat(router): add optional spawn-only Qwen policy (Gap D)`

## 8. Final report

```text
### Lane D final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): <or "none">
- Lines added / removed:
- Verification:
  - git diff --check: ___
  - classifier call/fallback contract implemented: ___
  - deferred Bun/type gates: listed for Main
  - git diff --name-only: ___
- Flags / blockers:
```
