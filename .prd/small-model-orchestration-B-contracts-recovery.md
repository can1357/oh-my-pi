# Lane B — Contracts, recovery, and eval evidence [parallel-builder+remediation]

## 1. Mission + read-first

You are the parallel-builder+remediation sub-agent for oh-my-pi-fork at `C:/dev/desktop-projects/oh-my-pi-fork`. Build self-verifiable assignment contracts, deterministic terminal-recovery policy, and actionable eval/Python failure evidence on top of Lane A's frozen profile types.

**Read first** (each in full):
- `.prd/small-model-orchestration-overview.md`
- `.prd/small-model-orchestration-A-foundations.md`
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md` — INV-04, INV-05, INV-08
- `packages/coding-agent/src/task/executor.ts` — read-only integration seam; do not edit
- `packages/coding-agent/src/tools/yield.ts` — read-only integration seam; do not edit
- `packages/coding-agent/src/eval/backend.ts`
- `packages/coding-agent/src/eval/py/runner.py`

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/task/assignment-contract.ts` (new)
- `packages/coding-agent/src/task/assignment-verifier.ts` (new)
- `packages/coding-agent/src/task/recovery-policy.ts` (new)
- `packages/coding-agent/src/prompts/system/assignment-contract.md` (new)
- `packages/coding-agent/src/tools/eval.ts` (existing)
- `packages/coding-agent/src/tools/tool-timeouts.ts` (existing)
- `packages/coding-agent/src/eval/backend.ts` (existing)
- `packages/coding-agent/src/eval/types.ts` (existing)
- `packages/coding-agent/src/eval/py/runner.py` (existing)
- `packages/coding-agent/src/eval/py/kernel.ts` (existing)
- `packages/coding-agent/src/eval/py/executor.ts` (existing)
- `packages/coding-agent/src/eval/py/index.ts` (existing)
- `packages/coding-agent/src/prompts/tools/eval.md` (existing)
- `packages/coding-agent/test/task/assignment-verifier.test.ts` (new)
- `packages/coding-agent/test/task/recovery-policy.test.ts` (new)
- `packages/coding-agent/test/tools/eval-observability.test.ts` (new)
- `packages/coding-agent/src/eval/py/__tests__/called-process-error.test.ts` (new)

You may NOT edit task index/executor/types/render, Yield, tools factory, settings/config, Fusion, registry/IRC, extensions, package manifests, changelogs, or Lane C/D/E files. Python eval adapter `src/eval/py/index.ts` is explicitly Lane B-owned.

## 3. Gap (verbatim from the table)

> B — Contracts, recovery, and eval evidence: Make bound work self-verifiable, classify terminal failures, plan fresh-child escalation after existing request fallback, and expose timeout/CalledProcessError evidence without changing global Bash semantics (0% complete). [LARGE] depends on: A | files: assignment contract/verifier/recovery modules, eval backend/Python runtime/prompt, focused tests

## 4. What to build

### Assignment contract

Export versioned, transport-neutral types:

```ts
export interface AssignmentContractV1 {
  version: "assignment-contract/v1";
  id: string;
  revision: number;
  digest: string;
  role: string;
  workClass: WorkClass;
  autonomy: AgentAutonomy;
  objective: string;
  deliverables: readonly string[];
  scope: AssignmentScope;
  procedures?: readonly AssignmentProcedure[];
  acceptance: readonly AcceptanceCriterion[];
  reporting: "assignment-result/v1";
}

export interface AssignmentResultV1 { /* digest-bound status, changed files, evidence, blockers */ }
```

Parent computes the digest over canonical immutable fields. A child may report evidence but may not alter acceptance, scope, or commands. Provide parse/validate helpers with typed diagnostics.

### Semantic verifier

`assignment-verifier.ts` must:
- reject wrong id/revision/digest;
- reject missing or duplicate criterion ids;
- reject placeholder-only narrative (`test`, `todo`, `tbd`, `n/a`, template markers, repeated filler);
- reject changed paths outside declared scope;
- execute only parent-authored immutable checks through injected runners;
- support command exit/timeout/captured-stream, artifact existence/size/hash, content/JSON schema, and changed-file-scope evidence;
- return a typed verification result and failure class; never throw ordinary child data as control flow.

Do not execute child-invented shell text. Legacy non-contract yields are Lane E's compatibility responsibility.

### Recovery policy

Build pure assignment-attempt policy, not another inference retry loop. Preserve the existing executor fallback chain by requiring a terminal typed input before recovery:

```ts
export type AssignmentFailureClass = "spawn_config" | "spawn_transport" | "budget" | "timeout" | "acceptance" | "liveness" | "tool_discipline";
export interface RecoveryAttempt { /* candidate, tier/provider, budgets, attempt */ }
export interface RecoveryCapsule { /* contract refs, failure, validator reasons, artifact/history refs; no transcript */ }
export function nextRecoveryAttempt(input: RecoveryPolicyInput): RecoveryDecision;
```

Default ladders:
- mechanical: light provider A ×1 → distinct light provider B ×1 → mid ×1 → frontier ×1;
- judgment: mid ×1 → frontier ×1; light is ineligible.

Provider suppression is deterministic. Each terminal retry requires a fresh child. Carry only the contract, profile, verified artifacts/patches, failure facts, and `history://failed-id`; never inline the failed transcript. Timeout beats a late yield. Keep Fusion retry inputs generic so Lane E can reuse them without weakening the registration barrier.

### Eval/Python observability

Correct the audited gap, not the original report's overbroad proposal:
- omitted eval timeout must come from `TOOL_TIMEOUTS.eval.default`; keep the conservative global default at **30 seconds**;
- timeout/cancellation results name the cause and effective duration;
- Python error frames for `subprocess.CalledProcessError` and timeout expose command, return code, stdout, and stderr, inline or through artifact references;
- preserve the generic traceback for unrelated exceptions;
- do not parse traceback text in TypeScript to invent fields;
- update `eval.md` to explain explicit longer timeout for remote/Colab work (the contract example uses 120 seconds) and captured evidence.

### Prompt

`assignment-contract.md` describes the Role / Task / Scope / Procedure / Acceptance / Reporting contract for bound and supervised workers. Independent agents receive objective/constraints/observable acceptance with minimal scaffolding. Prompts remain Markdown imported as text by Lane E.

### Tests

Use real typed failures and injected runners. Include the observed session cases:
- literal `"test"` review result fails;
- fourth invalid contract yield cannot be represented as verified success;
- Colab-style `CalledProcessError` captures both streams and return code;
- omitted timeout remains 30 from the shared source; explicit 120 is honored;
- recovery does not start while existing request fallback remains available;
- TLS/provider failure suppresses that endpoint and chooses a distinct candidate;
- judgment ladder never selects light.

## 5. Hard constraints

1. No new npm/Python dependencies.
2. Post-merge coding-agent typecheck must pass; do not run it in a dependency-less worktree.
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. Additive exports only; Lane E owns task/Yield integration and legacy compatibility.
5. Tests assert contracts, evidence, state transitions, and parsing boundaries—not private helper shape.
6. `[parallel-builder+remediation]`: add only the named contract/verifier/recovery modules and scoped eval remediation for INV-04/05/08; no remote collaboration, router, tool-profile, or unrelated refactor.
7. No `any`, `ReturnType<>`, inline imports, duplicate retry timers, global eval-timeout inflation, or Bash stream changes.
8. Do NOT run npm/yarn/pnpm/Bun project commands, project-wide build/test/lint/format, or `tsc` in this worktree. Main runs canonical gates after merge.

## 6. Verification

Run before declaring done:

```bash
python -m py_compile packages/coding-agent/src/eval/py/runner.py
git diff --check
git diff --name-only
git status --short
```

Expected:
- Python syntax check exits 0.
- `git diff --check` exits 0.
- `git diff --name-only` may omit new files; the union of `git diff --name-only` and `git status --short` lists ONLY the seventeen owned files.
- Main later runs the four focused tests, prompt formatting, Biome, and coding-agent typecheck.

## 7. Commit message

`feat(task): add verifiable contracts and terminal recovery policy (Gap B)`

## 8. Final report

```text
### Lane B final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): <or "none">
- Lines added / removed:
- Verification:
  - python py_compile exit: ___
  - git diff --check: ___
  - deferred Bun/type gates: listed for Main
  - git diff --name-only: ___
- Flags / blockers:
```
