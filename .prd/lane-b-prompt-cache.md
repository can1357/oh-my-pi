# Lane B — Prompt-view cache (byte-identical assembly memo) [[parallel-builder]]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for oh-my-pk at
`C:/dev/infra/oh-my-pk`. Memoize prompt assembly inside the session path.

**Read first** (each in full):
- `.prd/exomode-orchestration.md` — pipeline context + ownership matrix
- `.prd/lane-a-ledger.md` — upstream contract (you consume nothing from it;
  read for context only)
- `packages/coding-agent/src/session/messages.ts` — `convertToLlm` assembly
- `.prd/exomode-decision.md` — frozen contract + gates

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/session/messages.ts` (existing — memo hook only)
- `packages/coding-agent/src/session/prompt-view-cache.ts` (new)
- `packages/coding-agent/src/session/__tests__/prompt-view-cache.test.ts` (new)

You may NOT edit any other file, including `packages/coding-agent/src/sdk.ts`
(D owns it), `settings-schema.ts`, `routing/*`, `secrets/*`,
`system-prompt.ts`, or `packages/stats/*`.

## 3. Gap (verbatim from the table)

> B — Prompt-view cache (byte-identical assembly memo): Implement the
> prompt-view cache wholly inside the session message-assembly path:
> convertToLlm (packages/coding-agent/src/session/messages.ts) is the
> assembly function the agent loop consumes via the wrapper at
> sdk.ts:2760/2889 — memoize its output keyed on message-array
> identity/version so repeated assembly of an unchanged 50k-token
> conversation short-circuits. Tests: byte-identical assembled prompt
> with/without cache (including steering wraps, custom message types,
> compaction summary messages — all handled in messages.ts), plus a
> 50k-token fixture benchmark showing TTFT delta > 0 via
> providerPromptCacheKey/sessionId stability. No sdk.ts edits permitted
> (see overlap risks). (0% complete) [MEDIUM] depends on: A (contract
> only — B consumes nothing; shares no files) | files:
> packages/coding-agent/src/session/messages.ts,
> packages/coding-agent/src/session/prompt-view-cache.ts (new),
> packages/coding-agent/src/session/__tests__/prompt-view-cache.test.ts
> (new, colocated per advisor/__tests__ precedent)

## 4. What to build

- `prompt-view-cache.ts` (new): version-keyed memo for `convertToLlm`
  output. Key on message-array identity/version; any mutation (steering
  wrap, edit, branch restore, compaction summary insert) invalidates.
- `messages.ts`: minimal hook invoking the memo around the existing
  assembly. No signature changes to exported functions.
- Test file: byte-identical output with/without cache across steering
  wraps, custom message types, compaction summaries; 50k-token fixture
  benchmark asserting TTFT delta > 0.

## 5. Hard constraints

1. No new npm dependencies.
2. Lane-scoped typecheck must pass (no repo-wide gates from this lane).
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. No breaking changes to existing exports. Additive extensions only.
5. B caches bytes it does not interpret — never alter prompt content.
6. If you discover a needed `sdk.ts` signature change, DO NOT make it:
   record it in your final report under Flags; it bundles into lane D.
7. OMP subagent hint: skip project-wide build/test/lint/format. Only run
   the verification commands in section 6.

## 6. Verification

Run before declaring done:
```bash
bun test packages/coding-agent/src/session/__tests__/prompt-view-cache.test.ts
git diff --name-only
```

Expected:
- test exit 0 (byte-identity + benchmark assertions)
- `git diff --name-only` lists ONLY the 3 owned files

## 7. Commit message

`perf(session): byte-identical prompt-view assembly memo (Gap B)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane B final report
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): none expected
- Lines added / removed:
- Verification:
  - bun test (lane file) exit: ___
  - git diff --name-only: ___
- Flags / blockers (incl. any sdk.ts change request for lane D):
```
