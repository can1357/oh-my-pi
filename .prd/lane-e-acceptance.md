# Lane E — Acceptance gate + evidence [[acceptance-gate]]

## 1. Mission + read-first

You are the `[acceptance-gate]` sub-agent for oh-my-pk at
`C:/dev/infra/oh-my-pk`. Integrate all lane outputs, verify the checklist,
commit the evidence document.

**Read first** (each in full):
- `.prd/exomode-orchestration.md` — acceptance criteria checklist (§6)
- `.prd/exomode-decision.md` — gates + frozen contract
- `.prd/lane-a-ledger.md`, `.prd/lane-b-prompt-cache.md`,
  `.prd/lane-c-sealed-secrets.md`, `.prd/lane-d-cost-policy.md` —
  lane final reports (files + test paths, not narratives)
- Any `findings-*.md` fragments present in the tree

## 2. Owned files

You may ONLY create/edit:
- `evidence/exomode-evidence.md` (new, docs only)

You may DELETE `findings-*.md` fragments. You may NOT edit any `src/` or
`test/` file. Remediation needs go back to the orchestrator as findings —
do not fix src/ yourself.

## 3. Gap (verbatim from the table)

> E — Acceptance gate + evidence: Author the evidence doc citing each
> lane's test output; delete all findings-*.md fragments; verify per-lane
> git diff --name-only matches the ownership rows; confirm bun run
> check:types exits 0 post-merge. Touches no src/ file. (0% complete)
> [TINY] depends on: A, B, C, D (all merged) | files:
> evidence/exomode-evidence.md (new, docs only)

## 4. What to build

`evidence/exomode-evidence.md` containing, one bullet per claim, each linked
to a concrete file or test name:
- Lane A test path + asserted record fields (wallMs idle-exclusion)
- Lane B test path + byte-identity + TTFT-delta results
- Lane C test path + fake-token absence result
- Lane D test path + precedence + fail-open results
- `git diff --name-only` per lane vs ownership matrix (match/mismatch)
- `bun run check` post-merge exit code
- Deleted fragments list

## 5. Hard constraints

1. Every checklist item links to a concrete file path, test name, or command
   output. No unverifiable claims.
2. Delete every `findings-*.md` fragment; list deletions in the evidence doc.
3. No `src/` or `test/` edits. Findings needing src/ changes go in the
   evidence doc under "Remediation requested" for the orchestrator.
4. OMP subagent hint: you MAY run the repo-wide gates (you are the gate).

## 6. Verification

Run before declaring done:
```bash
bun run check
bun test packages/stats/test/task-ledger.test.ts packages/coding-agent/src/session/__tests__/prompt-view-cache.test.ts packages/coding-agent/src/secrets/__tests__/sealed-secrets.test.ts packages/coding-agent/src/routing/__tests__/cost-policy.test.ts
git diff --name-only
ls findings-*.md 2>/dev/null || echo "no fragments remain"
```

Expected:
- check exit 0; all four lane test files exit 0
- diff lists only lane-owned files + evidence doc
- no fragments remain

## 7. Commit message

`docs(evidence): exomode acceptance evidence (Gap E)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane E final report
- Evidence doc path:
- Fragments deleted:
- Verification:
  - bun run check exit: ___
  - lane tests exit: ___
  - git diff --name-only: ___
- Remediation requested (if any):
- Flags / blockers:
```
