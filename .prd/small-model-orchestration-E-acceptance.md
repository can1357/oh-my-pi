# Lane E — Runtime integration and acceptance [acceptance-gate]

## 1. Mission + read-first

You are the acceptance-gate sub-agent for oh-my-pi-fork in the dependency-bearing primary checkout at `C:/dev/desktop-projects/oh-my-pi-fork`. Integrate merged A–D exports into task/Fusion/tool/IRC/extension/SDK runtime, preserve legacy behavior, run the complete evidence matrix, and commit the final report.

**Read first** (each in full):
- `.prd/small-model-orchestration-overview.md`
- `.prd/small-model-orchestration-A-foundations.md`
- `.prd/small-model-orchestration-B-contracts-recovery.md`
- `.prd/small-model-orchestration-C-tool-collaboration.md`
- `.prd/small-model-orchestration-D-router-adapter.md`
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md` — INV-10
- every Lane A–D final report and any `findings-*.md` fragment in the worktree
- `AGENTS.md` — repository development and verification rules

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/task/index.ts` (existing)
- `packages/coding-agent/src/task/executor.ts` (existing)
- `packages/coding-agent/src/task/types.ts` (existing)
- `packages/coding-agent/src/task/render.ts` (existing)
- `packages/coding-agent/src/task/subprocess-tool-registry.ts` (existing)
- `packages/coding-agent/src/task/persisted-revive.ts` (existing)
- `packages/coding-agent/src/tools/yield.ts` (existing)
- `packages/coding-agent/src/tools/index.ts` (existing)
- `packages/coding-agent/src/tools/irc.ts` (existing)
- `packages/coding-agent/src/prompts/system/context-layer-compress.md` (existing, prompt-format acceptance cleanup)
- `packages/coding-agent/src/session/agent-session.ts` (existing)
- `packages/coding-agent/src/session/session-entries.ts` (existing)
- `packages/coding-agent/src/session/session-manager.ts` (existing)
- `packages/coding-agent/src/session/fusion-sidekick.ts` (existing)
- `packages/coding-agent/src/registry/agent-registry.ts` (existing)
- `packages/coding-agent/src/registry/agent-lifecycle.ts` (existing)
- `packages/coding-agent/src/irc/bus.ts` (existing)
- `packages/coding-agent/src/extensibility/extensions/types.ts` (existing)
- `packages/coding-agent/src/extensibility/extensions/runner.ts` (existing)
- `packages/llm-router-agent/src/extension.ts` (existing)
- `packages/llm-router-agent/src/defaults.ts` (existing, acceptance formatting only)
- `packages/llm-router-agent/src/features.ts` (existing, acceptance formatting only)
- `packages/llm-router-agent/src/policy.ts` (existing, acceptance formatting only)
- `packages/llm-router-agent/src/step-context.ts` (existing, acceptance formatting only)
- `packages/coding-agent/src/sdk.ts` (existing)
- `packages/coding-agent/test/task/task-spawn.test.ts` (existing)
- `packages/coding-agent/test/tools/task-async-fallback.test.ts` (existing)
- `packages/coding-agent/test/tools/yield.test.ts` (existing)
- `packages/coding-agent/test/tools/irc.test.ts` (existing)
- `packages/coding-agent/test/session/fusion-sidekick.test.ts` (existing)
- `packages/coding-agent/test/agent-session-mcp-discovery.test.ts` (existing, runtime ceiling regression)
- `packages/coding-agent/test/fast-context-model-role.test.ts` (existing, acceptance formatting only)
- `packages/coding-agent/test/task/task-render.test.ts` (new)
- `packages/coding-agent/test/sdk-startup-validation.test.ts` (new)
- `packages/coding-agent/test/extensibility/task-spawn-policy.test.ts` (new)
- `packages/coding-agent/test/task/task-spawn-profile-integration.test.ts` (new)
- `packages/coding-agent/test/task/task-recovery-integration.test.ts` (new)
- `packages/coding-agent/test/tools/tool-profile-integration.test.ts` (new)
- `packages/coding-agent/test/task/persisted-profile-revive.test.ts` (new)
- `packages/coding-agent/test/orchestration/small-model-orchestration-report.md` (new final evidence)
- `packages/coding-agent/CHANGELOG.md` (existing, Unreleased only)
- `.prd/findings-*.md` (temporary fragments, delete only)
- `packages/coding-agent/test/findings-*.md` (temporary fragments, delete only)

You may NOT edit Lane A–D owned modules. Any defect in those modules returns to its owner before acceptance. Do not edit remote collaboration host/Agent Hub, package manifests, model catalog generated files, or unrelated code.

Main acceptance amendment: post-merge adversarial review required tool-level IRC and MCP runtime-ceiling fixes in central integration seams. The global `check:tools` gate also required formatter-only cleanup in the listed router/context files; no behavior was changed in those cleanup-only paths.

## 3. Gap (verbatim from the table)

> E — Runtime integration and acceptance: Wire one preallocation execution plan through task/Fusion/tools/results/collaboration/extensions/startup, preserve existing request fallback and Fusion liveness, verify legacy plus profiled behavior end-to-end, and commit concrete evidence (0% complete). [LARGE] depends on: A, B, C, D | files: central task/tool/session/persistence/registry/IRC/extension/SDK seams, llm-router registration, integration tests, changelog, acceptance report

## 4. What to build

### Preallocation spawn planning

Refactor task execution so effective agent, assignment contract metadata, selector intent, execution profile, hard eligibility, optional spawn-policy transforms, and semantic diagnostics resolve **before** async id/job/worktree/session allocation. One frozen `SpawnPlan` crosses every later boundary. Invalid plans return one structured task error and create no registry/job/worktree artifact.

Keep batch behavior and launch timing observable. Do not duplicate model resolution in sync/async paths. Explicit manual model selection remains authoritative within hard eligibility. Preserve the existing ordered request-level fallback chain in executor.

### Typed extension hook

Add one transforming `task_spawn_policy` extension event and runner dispatch. Adapt Lane A's core `TaskSpawnPolicyInput/Result` to Lane D's package-local wire types field-for-field. Requirements:
- called after hard eligibility/profile resolution and before AgentOutputManager/registry/job allocation;
- use Lane A's pre-allocation `correlationId`, never an agent/spawn id;
- sequential composition: deny is sticky, selectors intersect eligibility, budgets decrease only, unknown selectors reject;
- caller abort before/during hooks propagates and creates no spawn; Lane D's own classifier timeout may return typed `mid` fallback;
- llm-router `taskSpawn.enabled` is the sole enable flag; missing/default/false registers no spawn handler, performs zero fetch, receives no assignment, and emits no assignment-derived telemetry;
- hook absent = zero behavior change;
- when enabled, register Lane D's exported handler in `packages/llm-router-agent/src/extension.ts`; no suppression bridge is allowed.

Do not reuse the per-input model-setting event or mutate global `modelRoles`.

### SDK/config validation

Call Lane A's structural validation after settings merge and semantic validation only after built-in/custom/extension providers and agents are available. Required active lanes fail startup with one aggregated diagnostic; optional disabled lanes warn or remain dormant according to the typed policy. Never silently replace malformed policy with unrestricted defaults.

### Executor/result/contract integration

Extend existing `TaskItem`, progress, and `SingleResult` with actual named profile/contract/failure/attempt/verification fields. Do not use `any` or `ReturnType<>`.

For explicit contract mode:
- render/import the Lane B assignment prompt;
- bind result to contract digest/revision;
- `yield` schema retries fail closed—no fourth-attempt override success;
- no-yield raw JSON/text cannot become verified success;
- run only parent-authored immutable acceptance checks through the verifier;
- terminal states are `submitted → verifying → verified | verification_failed`;
- outer task result sets machine `isError` for failed/blocked/exhausted outcomes.

Legacy non-contract tasks keep current Yield/raw fallback semantics and existing tests.

### Assignment recovery

Wrap terminal assignment outcomes—not individual model requests—with Lane B's recovery policy:
1. existing in-session request fallback runs first;
2. classify typed terminal failure;
3. if policy allows, allocate a fresh child and pass a recovery capsule, not its transcript;
4. suppress failed provider/endpoint deterministically and follow the configured tier ladder;
5. retain intermediate attempts in `agent://`/history; deliver only the final verified result;
6. timeout always wins over late yield.

Expose attempt/tier/provider/failure/next-action in progress and renderer without parsing error strings. Keep current retry UI detail.

### Hard tool envelope

Thread the frozen tool profile through `ToolSession`, `createTools()`, active-tool mutation, restored/forced tools, BM25/MCP activation, extension/custom tools, and persisted revival. Use `(source,name)` identity. Lane C owns runtime read/edit grammar selectors; pass the profile into those selectors so light/mid/frontier schemas match enforcement. Explicit empty tools remains deny-all except classified control tools.

If Lane C recorded `SOFT-SPOT(WIN-HEREDOC-PARSER)`, preserve that explicit deferment in the evidence report; do not replace it with regex. Otherwise thread the profile into parser-backed bound-Windows admission and its tests.

### Collaboration policy

Persist a versioned snapshot of execution profile, collaboration policy, and source-qualified tool ceiling in session-init entries via `session-entries.ts` / `session-manager.ts`. Hydrate it before a parked/cold agent is registered as visible or eligible for IRC wake. Older session files without fields receive explicit legacy self-coordinate/current-tool behavior.

Enforce policy in registry visibility, IRC delivery/broadcast/wake reservation, AgentSession busy-side reply, and persisted revive. `report-only` may report/block to parent only; no-policy and `self-coordinate` preserve today's flat swarm. Do not change remote room-token owner behavior.

### Fusion integration

Use the same allocation-free plan and policy/budget types for Fusion sidekick spawn. Preserve both existing fixes: stale/missing/aborted id clearing and registry-registration confirmation before retaining the id. Add only bounded lifecycle retry with visible attempt/tier/next-retry state; never return a phantom id or create an unbounded wake/spawn loop. Skip the optional Qwen classifier for a Fusion warm-sidekick spawn.

### Tests and final evidence

Build one end-to-end matrix across the owned existing/new test files. It must prove every checklist item in the overview with concrete test names. Include regressions for today's failures:
- alias-less `smol` rejected/normalized before allocation;
- TLS-dead cheap lane falls back/provider-suppresses then escalates;
- literal `"test"` review result fails semantic verification;
- Fusion phantom id cannot latch and bounded retry is visible;
- eval/Colab failure includes streams/status and explicit timeout;
- bound Windows heredoc is parser-rejected or explicitly documented as `SOFT-SPOT(WIN-HEREDOC-PARSER)`.
- missing/default/disabled task-spawn router performs zero fetch, emits no assignment-derived telemetry, and leaves plan ordering/budgets unchanged;
- cold revival restores report-only policy and source-qualified tool ceiling before visibility, including an extension tool shadowing a built-in name.

Write the evidence report with exact commands, statuses, and test links. Find/delete only `.prd/findings-*.md` and `packages/coding-agent/test/findings-*.md`. Update only `## [Unreleased]` in the coding-agent changelog.

## 5. Hard constraints

1. No new dependencies. Reuse existing task executor, model resolver, AgentRegistry/lifecycle, IRC, Fusion, extension runner, and retry machinery.
2. Coding-agent typecheck and llm-router package `run check`/`run test` must pass. Never invoke `tsc`/`npx tsc` directly; using the package's existing Bun-invoked scripts is the canonical router gate.
3. No edits outside the owned-files/cleanup patterns; no A–D integration exception.
4. Preserve existing exports and legacy/no-policy behavior. New behavior must require an explicit profile/contract or default-preserving resolved policy.
5. Tests cover observable allocation, state, output, authorization, liveness, fallback ordering, and error mapping.
6. `[acceptance-gate]`: no new architecture; wire A–D, remediate integration defects, remove bridges, and collect evidence.
7. No `any`, `ReturnType<>`, inline imports, console usage, per-turn coding-session routing, global role mutation, duplicate retry bus, global eval timeout increase, regex heredoc detection, or remote collaboration scope change.
8. Run project-wide/package gates only after all branches merge. Prompt formatting is check-only; any B/C prompt failure returns to its owning lane instead of mutating outside E ownership.
9. Run here in the primary checkout; do not create a separate Lane E worktree.

## 6. Verification

Run before declaring done (adjust the test file list only to include additional directly relevant tests; never omit a named one):

```bash
bun --cwd=packages/coding-agent test \
  test/orchestration/agent-execution-profile.test.ts \
  test/task/spawn-plan.test.ts \
  test/config/spawn-selector-validation.test.ts \
  test/subagent-model-aliases.test.ts \
  test/task/assignment-verifier.test.ts \
  test/task/recovery-policy.test.ts \
  test/tools/eval-observability.test.ts \
  src/eval/py/__tests__/called-process-error.test.ts \
  test/tools/tool-profiles.test.ts \
  test/orchestration/collaboration-policy.test.ts \
  test/tools/tool-profile-grammar.test.ts \
  test/tools/bash-windows-heredoc.test.ts \
  test/tools/task-agent-capabilities.test.ts \
  test/task/task-spawn.test.ts \
  test/tools/task-async-fallback.test.ts \
  test/tools/yield.test.ts \
  test/tools/irc.test.ts \
  test/session/fusion-sidekick.test.ts \
  test/task/task-render.test.ts \
  test/sdk-startup-validation.test.ts \
  test/extensibility/task-spawn-policy.test.ts \
  test/task/task-spawn-profile-integration.test.ts \
  test/task/task-recovery-integration.test.ts \
  test/tools/tool-profile-integration.test.ts \
  test/task/persisted-profile-revive.test.ts

bun --cwd=packages/llm-router-agent run check
bun --cwd=packages/llm-router-agent run test
bun --cwd=packages/coding-agent run check:types
bun --cwd=packages/coding-agent run format-prompts --check
bun run check:tools
bun packages/coding-agent/src/cli.ts --smoke-test
git diff --check refs/omp/orchestration/small-model-baseline
git diff --name-only refs/omp/orchestration/small-model-baseline
git status --short
```

Expected:
- all focused tests pass with zero skipped acceptance invariants (except explicit heredoc soft spot if parser support is absent);
- typecheck, prompt formatting, Biome, smoke test, and diff check exit 0;
- no `@ts-expect-error` bridge remains;
- final changed paths are a subset of the union of each lane's `files` array plus the manifest's explicit `planAmendments`; every manifest `requiredDeliverables` path exists, no other path appears, and every `cleanupGlobs` expansion is empty.
- evidence report records exact outputs and links every claim to a test;
- no `findings-*.md` remains.

## 7. Commit message

`feat(orchestration): integrate deterministic small-model execution profiles (Gap E)`

## 8. Final report

```text
### Lane E final report
- Worktree path / branch:
- Files modified / created:
- Public exports integrated:
- @ts-expect-error suppressors removed / remaining: ___ / 0
- Lines added / removed:
- Verification:
  - focused coding-agent tests: ___
  - llm-router tests: ___
  - coding-agent check:types: ___
  - prompt formatting / Biome: ___
  - omp --smoke-test: ___
  - git diff --check: ___
  - git diff --name-only: ___
- Acceptance evidence path:
- findings-*.md cleanup:
- Soft spots / deferred product decisions:
- Flags / blockers:
```
