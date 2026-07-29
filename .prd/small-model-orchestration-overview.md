# Small-model orchestration — parallel implementation overview

## 1. Purpose

Implement a boundary-resolved orchestration layer so light models operate inside a deterministic exoskeleton while frontier models retain broad planning and swarm autonomy. Parallel dispatch is justified because the MapReduce audit isolated three disjoint feature bundles—contracts/recovery/observability, tool/collaboration policy, and optional spawn-only routing—behind one solo contract phase and one serial runtime-integration gate.

Authoritative inputs:
- `.ompk/mapreduce/small-model-orchestration/small-model-orchestration.selectors.md`
- `.ompk/mapreduce/small-model-orchestration/small-model-orchestration.batches.json`
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md`
- `.prd/small-model-orchestration-ownership.json`

Coverage: 26 deterministic signals; 4 cleared and 22 confirmed. Remote owner semantics (INV-07) are deferred until product policy is chosen. Per-turn routing remains a non-goal.

Before worktree dispatch:
1. Commit this `.prd/` set and `.ompk/mapreduce/small-model-orchestration/` artifacts so every worktree can read them.
2. Record the committed baseline with `git update-ref refs/omp/orchestration/small-model-baseline HEAD`; final union audits use this ref.
3. Run `git config core.longpaths true` on Windows.
4. Place A–D worktrees beside the repo, e.g. `C:/dev/desktop-projects/_wt-omp-orch-a`, not inside nested artifact directories.
5. Do not install dependencies in A–D worktrees. Lane agents run only dependency-free checks; Main merges their commits, then Lane E runs in the dependency-bearing primary checkout.

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Remaining work | Effort | Depends on | Primary files | PRD |
|---|---|---|---|---|---|---|---|
| A | Foundations and selector validation | `[pre-phase]` | Freeze tier/autonomy/work-class/collaboration contracts, resolve an allocation-free spawn plan, canonicalize role/alias selectors, and provide structural plus post-provider validation primitives (0% complete). | LARGE | none | orchestration profile, spawn plan, config resolver/aliases/settings/validation and focused tests | `.prd/small-model-orchestration-A-foundations.md` |
| B | Contracts, recovery, and eval evidence | `[parallel-builder+remediation]` | Make bound work self-verifiable, classify terminal failures, plan fresh-child escalation after existing request fallback, and expose timeout/CalledProcessError evidence without changing global Bash semantics (0% complete). | LARGE | A | assignment contract/verifier/recovery modules, eval backend/Python runtime/prompt, focused tests | `.prd/small-model-orchestration-B-contracts-recovery.md` |
| C | Tool and collaboration policy | `[parallel-builder+remediation]` | Convert agent tool lists from seeds into immutable source-aware ceilings, constrain model-facing grammar by tier/autonomy, and define report-only/message-peers/self-coordinate authorization for discovery/wake/reply (0% complete). | LARGE | A | tool/collaboration policy modules, discovery/BM25/read/edit/bash admission, prompt assets, focused tests | `.prd/small-model-orchestration-C-tool-collaboration.md` |
| D | Spawn-only router adapter | `[parallel-builder+remediation]` | Reuse llm-router policy/config/validation/telemetry for one optional local `light|mid|heavy` decision per eligible child spawn, with safe mid fallback and no per-turn/global-role mutation (0% complete). | MEDIUM | A | llm-router task-spawn policy/Qwen client/types/config/validation/telemetry and focused tests; Lane E owns event registration | `.prd/small-model-orchestration-D-router-adapter.md` |
| E | Runtime integration and acceptance | `[acceptance-gate]` | Wire one preallocation execution plan through task/Fusion/tools/results/collaboration/extensions/startup, preserve existing request fallback and Fusion liveness, verify legacy plus profiled behavior end-to-end, and commit concrete evidence (0% complete). | LARGE | A, B, C, D | central task/tool/session/registry/IRC/extension/SDK seams, llm-router registration, integration tests, changelog, acceptance report | `.prd/small-model-orchestration-E-acceptance.md` |

## 3. Five-row dispatch table (operational form)

| Lane | Gap letters | Owned files | Effort | Model | Subagent | Isolation | Depends on | Verify commands |
|---|---|---|---|---|---|---|---|---|
| Foundations | A / INV-01+02 | profile/spawn-plan modules; model resolver/aliases/settings/validation; focused tests | LARGE | `pi/max-intelligence` | `task` | worktree, blocking | none | `git diff --check`, ownership audit; post-merge Bun tests |
| Contracts/recovery | B / INV-04+05+08 | assignment contract/verifier/recovery; eval backend/Python evidence; focused tests | LARGE | `pi/max-intelligence` | `task` | worktree, blocking | A | `python -m py_compile .../runner.py`, `git diff --check`, ownership audit; post-merge Bun tests |
| Tool/collaboration | C / INV-03+06 | tool/collaboration policy; discovery/BM25/read/edit/bash admission; prompts/tests | LARGE | `pi/max-intelligence` | `task` | worktree, blocking | A | `git diff --check`, ownership audit; post-merge Bun tests |
| Router adapter | D / INV-09 | llm-router spawn policy/Qwen client/config/telemetry/tests | MEDIUM | `pi/task` | `task` | worktree, blocking | A | `git diff --check`, ownership audit; post-merge package gates |
| Acceptance | E / INV-10 | all central task/tool/session/persistence/registry/IRC/extension/SDK wiring plus llm-router event registration; integration tests; changelog/evidence | LARGE | `pi/max-intelligence` | `task` | primary checkout, blocking | A,B,C,D | targeted Bun tests, package type gates, Biome, `omp --smoke-test` |

Routing rule: contract, recovery, tool-policy, collaboration, and integration lanes require frontier judgment; only the bounded MEDIUM router-adapter lane uses efficient `pi/task`. No lane uses `quick_task` for review, architecture, or acceptance.

`[parallel-builder+remediation]` is an explicit hybrid: the lane may add the named pure module(s) and patch only its listed existing files, inherits the no-refactor/no-scope-expansion rules of remediation, and remains merge-safe through disjoint ownership.

## 4. File-ownership matrix

Parallel-lane intersections B∩C, B∩D, and C∩D are empty. A is merged before parallel dispatch; E starts only after all parallel branches merge.

| File group | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|
| `src/orchestration/agent-execution-profile.ts`, `src/task/spawn-plan.ts` | own | – | – | – | – |
| config resolver/aliases/settings/schema/validation | own | – | – | – | – |
| profile/config unit tests | own | – | – | – | – |
| assignment contract/verifier/recovery modules + prompt | – | own | – | – | – |
| eval tool/backend/types/Python runtime/prompt + tests | – | own | – | – | – |
| tool/collaboration policy modules | – | – | own | – | – |
| discovery/BM25/read/edit/bash admission, grammar prompts, and tests | – | – | own | – | – |
| `packages/llm-router-agent/src/` Qwen/policy/config/types/validation/telemetry files + tests | – | – | – | own | – |
| task index/executor/types/render/subprocess registry | – | – | – | – | own |
| tools factory/yield; AgentSession/Fusion | – | – | – | – | own |
| AgentRegistry/lifecycle/IRC/persisted revive/session-init persistence | – | – | – | – | own |
| extension types/runner; SDK | – | – | – | – | own |
| `packages/llm-router-agent/src/extension.ts` event registration | – | – | – | – | own |
| exact central integration tests, changelog, evidence report, findings cleanup | – | – | – | – | own |

The mechanically authoritative manifest is `.prd/small-model-orchestration-ownership.json`: A–D §2 paths equal `lanes.<id>.files`; E §2 equals `lanes.E.files + lanes.E.cleanupGlobs`. Final changed paths must be a subset of union(`files`), every top-level `requiredDeliverables` path must exist, and every cleanup-glob expansion must be empty. Broad groups above are explanatory only.

Lane E may import and wire A–D exports but MUST NOT edit their owned modules. Any defect in an A–D module returns to that owner before acceptance; E changes only its manifest-listed central wiring files.

## 5. Execution sequence

1. **Bootstrap:** commit `.prd/` and `.ompk/mapreduce/small-model-orchestration/`; confirm every existing owned path is tracked, then run `git update-ref refs/omp/orchestration/small-model-baseline HEAD`.
2. **Phase 0:** dispatch Lane A alone. Block, review its exported contracts, commit, merge/fast-forward into `main`.
3. **Phase 1:** create three worktrees from the post-A commit. Dispatch B, C, and D in one `task` call. Each agent receives its lane PRD and overview; no dependency-backed gates.
4. **Phase 1.5:** merge B, C, D sequentially with `git merge --no-ff`. Disjoint ownership means any conflict is a planning failure. Reconcile exports only by returning a defect to its owner; no suppression bridge is expected.
5. **Phase 2:** dispatch E alone in the dependency-bearing primary checkout. E wires central seams, runs all package/integration gates, writes evidence, deletes exact findings patterns, and updates the Unreleased changelog.
6. **Final audit:** compare the complete union with `git diff --name-only refs/omp/orchestration/small-model-baseline...HEAD` plus `git status --short`; after acceptance, remove the temporary ref with `git update-ref -d refs/omp/orchestration/small-model-baseline`.

## 6. Acceptance criteria checklist

- [ ] `packages/coding-agent/test/orchestration/agent-execution-profile.test.ts` proves tier and autonomy are independent and judgment cannot resolve below mid.
- [ ] `packages/coding-agent/test/task/spawn-plan.test.ts` proves pure planning rejects invalid input without invoking injected allocation callbacks; E-owned `task-spawn-profile-integration.test.ts` proves no id/job/worktree/session is created in the real task path.
- [ ] `packages/coding-agent/test/config/spawn-selector-validation.test.ts` proves canonical role/alias resolution, suffix preservation, collision rejection, and aggregated semantic diagnostics.
- [ ] `packages/coding-agent/test/tools/tool-profiles.test.ts` proves pure source-aware policy; E-owned `tool-profile-integration.test.ts` proves construction, automatic/restored/forced tools, BM25/MCP, and extension activation cannot exceed it.
- [ ] `packages/coding-agent/test/task/assignment-verifier.test.ts` proves placeholders, wrong digest/revision, missing/duplicate evidence, undeclared changes, and child-invented checks fail closed.
- [ ] `packages/coding-agent/test/task/recovery-policy.test.ts` proves the pure ladder/provider suppression; E-owned `task-recovery-integration.test.ts` proves existing request fallback terminates before fresh-child recovery.
- [ ] `packages/coding-agent/test/orchestration/collaboration-policy.test.ts`, `test/tools/irc.test.ts`, and E-owned `persisted-profile-revive.test.ts` prove visibility/reach/wake restrictions, no autonomous bound reply, and policy restoration before cold-revived visibility.
- [ ] `packages/coding-agent/test/tools/eval-observability.test.ts` and the Python runner test prove timeout cause/duration and `CalledProcessError` command/returncode/stdout/stderr evidence.
- [ ] Router tests prove missing/default/disabled config performs zero fetch and leaves the plan unchanged; enabled config performs one strict `light|mid|heavy` classification with safe prevalidated-mid fallback; E's hook test proves no per-turn/Fusion/IRC call and caller abort never spawns.
- [ ] Existing Fusion tests preserve stale-id clearing and registry-registration confirmation while adding bounded recovery state.
- [ ] Existing legacy task/yield/IRC behavior remains green when no execution profile or assignment contract is supplied.
- [ ] `bun --cwd=packages/coding-agent run check:types` exits 0.
- [ ] `bun --cwd=packages/llm-router-agent run check` and `bun --cwd=packages/llm-router-agent run test` exit 0 using the package's canonical build/test scripts.
- [ ] Biome check passes on the union of changed TypeScript/JSON files; prompt formatting passes for changed prompt Markdown.
- [ ] `bun --cwd=packages/coding-agent test <all named focused test files>` exits 0, followed by the appropriate coding-agent runtime suite selected by Main.
- [ ] `bun packages/coding-agent/src/cli.ts --smoke-test` exits 0 and Fusion status remains accurate.
- [ ] `packages/coding-agent/test/orchestration/small-model-orchestration-report.md` links every checklist claim to a concrete test and records the exact commands/results.
- [ ] No per-turn coding-session routing, global model-role mutation, global eval-timeout inflation, regex heredoc parser, read-lite/write-lite framework, duplicate retry bus, or remote-collaboration policy change ships in this PRD.
