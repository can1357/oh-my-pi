# Lane A — Per-task cost/latency ledger [[pre-phase]]

## 1. Mission + read-first

You are the `[pre-phase]` sub-agent for oh-my-pk at `C:/dev/infra/oh-my-pk`.
Establish the frozen ledger contract every downstream lane consumes.

**Read first** (each in full):
- `.prd/exomode-orchestration.md` — pipeline context
- `.prd/exomode-decision.md` — frozen contract section (binding record shape)
- `packages/stats/src/types.ts` — `MessageStats`, `UserMessageLink`
- `packages/stats/src/db.ts`, `packages/stats/src/index.ts` — storage + export pattern
- `packages/stats/README.md` — programmatic import pattern

## 2. Owned files

You may ONLY edit these files:
- `packages/stats/src/task-aggregator.ts` (new)
- `packages/stats/src/db.ts` (existing — read/query additions only)
- `packages/stats/src/types.ts` (existing — type additions only)
- `packages/stats/src/index.ts` (existing — export additions only)
- `packages/stats/test/task-ledger.test.ts` (new)

You may NOT edit any other file, including `packages/coding-agent/**`,
`packages/stats/src/parser.ts`, or any test outside your owned test file.

## 3. Gap (verbatim from the table)

> A — Per-task cost/latency ledger: Build task-span aggregation on top of
> the existing per-request substrate. The parser already emits MessageStats
> (duration, ttft, usage.cost.total per request) and UserMessageLink pairs
> (assistant→anchor user message, packages/stats/src/types.ts) — task span =
> anchor user message through all assistant requests until the next
> non-toolResult user message. Deliver the exact record + query API below,
> exported from the package entry (README-documented programmatic import
> pattern), with a fixture-session test asserting { wallMs, ttftMs,
> inputTokens, outputTokens, costUsd }. Must not touch routing or session
> assembly (per PRD ownership row). (0% complete) [MEDIUM] depends on: none
> | files: packages/stats/src/task-aggregator.ts (new), db.ts, types.ts,
> index.ts, test/task-ledger.test.ts (new)

## 4. What to build

In `task-aggregator.ts` (new), implement exactly the frozen contract from
`.prd/exomode-decision.md`:
- `aggregateTasks(requests: MessageStats[], users: UserMessageStats[]): TaskLedgerRecord[]`
- `getRecentTaskStats(opts?: { limit?: number; cutoffMs?: number; folder?: string }): Promise<TaskLedgerRecord[]>`
- `getTaskEconomicsByModel(windowMs?: number): Promise<ModelEconomics[]>`
- `TaskLedgerRecord` + `ModelEconomics` types (declare in `types.ts`, re-export
  via `index.ts`).
- `wallMs` = SUM of per-request duration, EXCLUDING idle between requests.
  `taskId` = `${sessionFile}#${anchorUserEntryId}`.
- Test file asserts `{ wallMs, ttftMs, inputTokens, outputTokens, costUsd }`
  on a fixture session, including an idle gap proving exclusion, plus a
  multi-task fixture proving span boundaries at the next anchor.

## 5. Hard constraints

1. No new npm dependencies.
2. `bun run check` in `packages/stats` must pass at the end.
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. No breaking changes to existing exports. Additive extensions only.
5. Parser (`parser.ts`) is read-only input — do not modify it.
6. OMP subagent hint: skip project-wide build/test/lint/format. Only run the
   verification commands listed in section 6. Main agent runs project-wide
   checks once at the end.

## 6. Verification

Run before declaring done:
```bash
cd packages/stats && bun test test/task-ledger.test.ts
cd packages/stats && bun run check
git diff --name-only
```

Expected:
- test exit 0 with idle-exclusion and span-boundary assertions passing
- check exit 0
- `git diff --name-only` lists ONLY the 5 owned files

## 7. Commit message

`feat(stats): per-task cost/latency ledger aggregation (Gap A)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane A final report
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): none expected
- Lines added / removed:
- Verification:
  - bun test test/task-ledger.test.ts exit: ___
  - bun run check (packages/stats) exit: ___
  - git diff --name-only: ___
- Flags / blockers:
```
