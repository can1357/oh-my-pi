# Reduced implementation inventory: small-model orchestration

Source: six `mr-worker` shards reduced by `OrchestrationReducer` at commit `1555ecd899ebf0e0742cd90e0389023b10b82691`.

## Coverage proof

| Shard | Assigned | Cleared | Confirmed |
|---|---:|---:|---:|
| Spawn/model config | 4 | 0 | 4 |
| Tool capability/grammar | 5 | 0 | 5 |
| Assignment/result/recovery | 5 | 2 | 3 |
| Collaboration/lifecycle | 4 | 0 | 4 |
| Execution observability | 4 | 1 | 3 |
| Router extension policy | 4 | 1 | 3 |
| **Total** | **26** | **4** | **22** |

Coverage equation: **26 = 4 + 22**. The finite queue is `.ompk/mapreduce/small-model-orchestration/small-model-orchestration.batches.json`.

## Existing mechanisms to preserve

1. **Model binding:** extend `resolveAgentModelPatterns()` / `resolveModelRoleValue()` in `packages/coding-agent/src/config/model-resolver.ts`; do not replace ordered role resolution.
2. **Request-level fallback:** preserve `resolveSubagentRetryFallbackCandidates()` and `installSubagentRetryFallbackChain()` in `packages/coding-agent/src/task/executor.ts`. Fresh-child recovery starts only after this layer terminates.
3. **Run monitoring/finalization:** extend `createSubagentRunMonitor()`, `finalizeSubprocessOutput()`, and `finalizeRunResult()` in `task/executor.ts`; do not add parallel timers/result buses.
4. **Fusion liveness:** preserve stale-id clearing and registry-registration confirmation in `session/fusion-sidekick.ts` (phantom latch already fixed).
5. **Registry/IRC lifecycle:** gate `AgentRegistry`, `AgentLifecycleManager`, and `IrcBus`; do not replace their stable ids, coalesced revival, mailboxes, or receipts.
6. **Tool catalogs:** retain `createTools()` and discovery callbacks, but enforce one immutable `(source,name)` maximum around construction and all activation.
7. **Legacy result transport:** retain `subprocessToolRegistry` extraction and legacy Yield behavior; fail closed only for explicit contract mode.
8. **Extension/router machinery:** add one typed spawn transform to the existing generic extension handler map; reuse router policy/config/validation/telemetry.
9. **Execution precedent:** Bash already exposes non-zero exit status and retained output. Eval should match that observability without changing global Bash stream semantics.

## Deduplicated implementation inventory

| ID | Priority | Deliverable | Production ownership | Test ownership | Depends on |
|---|---|---|---|---|---|
| INV-01 | P1 | Immutable execution profile + allocation-free spawn plan | new `orchestration/agent-execution-profile.ts`, new `task/spawn-plan.ts` | new profile/spawn-plan tests | INV-02, central wiring |
| INV-02 | P1 | Canonical selectors + two-phase validation | `config/model-resolver.ts`, `subagent-model-aliases.ts`, `settings-schema.ts`, `settings.ts`, new `spawn-selector-validation.ts` | alias tests + new config validation tests | central SDK gate |
| INV-03 | P1 | Hard tool envelope + bound Windows shell discipline | new `tools/tool-profiles.ts`, `search-tool-bm25.ts`, `discovery/helpers.ts`, read/edit/bash prompts, `bash.ts`, `bash-command-fixup.ts` | capability/profile/heredoc tests | INV-01, central wiring |
| INV-04 | P1 | Immutable assignment contract + semantic verifier | new `task/assignment-contract.ts`, `assignment-verifier.ts`, assignment prompt | new verifier tests | INV-01, central wiring |
| INV-05 | P1 | Typed assignment-level recovery | new `task/recovery-policy.ts` | new recovery-policy tests | INV-01/02/04, central wiring |
| INV-06 | P1 | Persisted collaboration authorization | new `orchestration/collaboration-policy.ts` | new collaboration-policy tests | INV-01, central wiring |
| INV-07 | P2/defer | Remote collaboration owner semantics | `collab/host.ts`, Agent Hub | new remote-scope tests | product decision after INV-06 |
| INV-08 | P1 | Eval timeout + Python child-process evidence | `tools/eval.ts`, `tool-timeouts.ts`, eval backend/types/Python runtime, eval prompt | new eval observability/Python error tests | INV-05 consumes typed failures |
| INV-09 | P2/optional | Spawn-only routing hook + Qwen adapter | Lane D owns llm-router task-spawn policy/Qwen client/config/types/validation/telemetry; Lane E exclusively owns `llm-router-agent/src/extension.ts` registration | new router/Qwen tests; core hook test in gate | INV-01/02, central hook |
| INV-10 | P1 | Shared runtime wiring + acceptance | task index/executor/types/render/registry, yield/tools factory, AgentSession/Fusion, registry/lifecycle/IRC/revive, extension types/runner, SDK, and llm-router event registration | task/yield/IRC/Fusion/startup/hook integration matrix | all selected inventories |

## Observable acceptance by inventory

- **INV-01:** invalid plans allocate no id/job/worktree/session; tier and autonomy are independent; judgment has a mid floor; one model/profile is frozen per child; Fusion uses the same plan without losing registry confirmation.
- **INV-02:** `smol` and `pi/smol` agree; alias thinking suffixes survive; normalized collisions/divergent shadowing fail structurally; active unresolved/unauthed selectors produce one aggregated post-provider diagnostic.
- **INV-03:** automatic additions, BM25/MCP/extension activation, restored/forced tools, and extension shadowing cannot exceed a source-aware cap; explicit `tools: []` is deny-all except classified control tools; bound Windows heredocs fail before execution with the prescribed script-file recovery.
- **INV-04:** wrong digest/revision, missing/duplicate evidence, placeholders, and undeclared changed files fail; only parent-authored checks execute; contract-mode schema override/raw fallback fails closed; legacy tasks remain compatible.
- **INV-05:** recovery begins only after request fallback is terminal; attempts use fresh children and deterministic provider suppression/tier-up; timeout beats late yield; intermediate attempts remain in history; only the final verified result is delivered with correct `isError`.
- **INV-06:** report-only agents cannot discover/message/broadcast/wake outside policy; authorization precedes `ensureLive()`; bound/supervised agents do not autonomously busy-reply; cold revival restores policy; no-policy/self-coordinate preserves today's independent swarm.
- **INV-08:** eval omission uses the shared conservative 30-second default; explicit Colab procedures may use 120 seconds; timeout names cause/duration; `CalledProcessError` exposes command, return code, stdout, and stderr inline or by artifact.
- **INV-09:** one classifier call per eligible child spawn after hard eligibility and before allocation; policy composition only narrows; failures choose prevalidated mid; no calls on Fusion warm spawn/ordinary turns/IRC wake and no global role mutation.
- **INV-10:** one integration matrix proves preallocation planning, immutable propagation, hard tools, persisted collaboration, verified completion, fallback-then-recovery ordering, outer `isError`, Fusion state, startup diagnostics, and optional spawn-hook dispatch.

## Dependency graph and scope cuts

- **Pre-phase A:** INV-01 + INV-02 contracts and selector validation.
- **Parallel B:** INV-04 + INV-05 + INV-08 contracts/recovery/eval evidence.
- **Parallel C:** INV-03 + INV-06 tool/collaboration policy and shell admission.
- **Parallel D:** INV-09 optional spawn-only router/Qwen adapter, disabled by default.
- **Acceptance E:** INV-10 exclusively owns every shared runtime seam and all final integration gates.

Defer INV-07 until room-token owner semantics are explicitly chosen. Do not add per-turn routing, globally raise eval timeout, change Bash stream semantics, implement heredoc detection with regex, add read-lite/write-lite, or build a parallel orchestration/retry framework.

## PRD feasibility refinements

- Lane A owns the exact transport-neutral spawn-hook contract and core policy composition; Lane D owns package-local compatible wire types; Lane E performs the explicit adapter. `llm-router.taskSpawn.enabled` is the sole enable flag.
- Lane C owns `tools/read.ts` and `edit/index.ts` so profile-specific grammar is runtime-enforced rather than prompt-only.
- Lane E owns `session/session-entries.ts` and `session/session-manager.ts` so execution/collaboration/tool policy survives cold revival before visibility.
- Lane E runs in the dependency-bearing primary checkout. A–D use isolated worktrees; final union evidence compares against `refs/omp/orchestration/small-model-baseline` and `.prd/small-model-orchestration-ownership.json`.
- Missing/default/disabled router config must register no hook, perform zero fetches, receive no assignment, and emit no assignment-derived telemetry.
