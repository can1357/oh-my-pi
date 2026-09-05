# Lane D — Cost policy + exomode config plumbing [[parallel-builder]]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for oh-my-pk at
`C:/dev/infra/oh-my-pk`. Register exomode config and feed ledger economics
into pool selection as the lowest-precedence tiebreak.

**Read first** (each in full):
- `.prd/exomode-orchestration.md` — pipeline context + ownership matrix
- `.prd/lane-a-ledger.md` — the query API you bind to
  (`getTaskEconomicsByModel`, `ModelEconomics`; read-only import, fail-open
  on empty/missing db)
- `.prd/exomode-decision.md` — frozen precedence chain
- `packages/coding-agent/src/config/settings-schema.ts` fusion block
  (~lines 898-1016, the exact pattern to mirror)
- `packages/coding-agent/src/routing/types.ts` (`DynamicRoutingConfig`),
  `pool-manager.ts` (`selectTarget` ~line 189),
  `fast-stream-router.ts` (`streamWithRouting` ~line 126)
- `packages/coding-agent/src/sdk.ts` `CreateAgentSessionOptions` (~line 491),
  MOA settings-group read (~lines 2869-2882), streamFn wrapper (~line 2914)

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/config/settings-schema.ts` (existing)
- `packages/coding-agent/src/routing/types.ts` (existing)
- `packages/coding-agent/src/routing/pool-manager.ts` (existing)
- `packages/coding-agent/src/routing/fast-stream-router.ts` (existing)
- `packages/coding-agent/src/sdk.ts` (existing — SOLE owner per matrix)
- `packages/coding-agent/src/routing/__tests__/cost-policy.test.ts` (new)

You may NOT edit any other file, including `session/*`, `secrets/*`,
`system-prompt.ts`, `packages/stats/*` (import the query API read-only —
no schema edits; richer queries go back to lane A as a follow-up, never a
local db.ts edit).

## 3. Gap (verbatim from the table)

> D — Cost policy + exomode config plumbing: Register the exomode block in
> settings-schema.ts exactly like the fusion master-switch +
> conditional-subkey pattern (condition: "exomodeEnabled", subkeys
> ledger/promptCache/sealedSecrets/costPolicy each defaulting true under
> the master — fusion precedent at settings-schema.ts:898-1016). Add the
> ExomodeConfig shape to routing/types.ts mirroring DynamicRoutingConfig.
> Feed lane-A economics into ModelPoolManager.selectTarget
> (routing/pool-manager.ts:189) as the LOWEST-precedence tiebreak after
> preferredModel/affinity — called from FastStreamRouter.streamWithRouting
> (routing/fast-stream-router.ts:126) — enforcing 'explicit user selection
> > pool affinity > exomode suggestion', fail-open to affinity when the
> ledger is empty. Wire cost-policy params through
> CreateAgentSessionOptions → Agent construction → streamFn wrapper
> (sdk.ts:491+, 2869-2914), following the MOA settings-group-read-before-Agent
> precedent (sdk.ts:2869-2882). D solely owns sdk.ts and settings-schema.ts
> (see overlap risks). (0% complete) [MEDIUM] depends on: A
> (getTaskEconomicsByModel / getRecentTaskStats query API, fail-open on
> empty db) | files: settings-schema.ts, routing/types.ts, pool-manager.ts,
> fast-stream-router.ts, sdk.ts, routing/__tests__/cost-policy.test.ts (new)

## 4. What to build

1. `settings-schema.ts`: `exomode` block mirroring fusion (master
   `enabled` + conditional subkeys, ~120 lines).
2. `routing/types.ts`: `ExomodeConfig` mirroring `DynamicRoutingConfig`.
3. `pool-manager.ts`: append economics tiebreak at the END of
   `selectTarget`'s decision order (after preferredModel/affinity).
4. `fast-stream-router.ts`: pass economics into selection from
   `streamWithRouting`; fail open when ledger empty.
5. `sdk.ts`: `CreateAgentSessionOptions` field + MOA-style settings read +
   streamFn wiring.
6. Test file: ledger-driven choice asserted; precedence test proving an
   explicit selection survives an exomode suggestion; empty-db fail-open
   test (defers to affinity).

## 5. Hard constraints

1. No new npm dependencies.
2. Lane-scoped typecheck must pass (no repo-wide gates from this lane).
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. No breaking changes to existing exports. Additive extensions only.
5. Precedence chain is inviolable: explicit > affinity > exomode. The
   precedence test is the crux — do not ship without it green.
6. OMP subagent hint: skip project-wide build/test/lint/format. Only run
   the verification commands in section 6.

## 6. Verification

Run before declaring done:
```bash
bun test packages/coding-agent/src/routing/__tests__/cost-policy.test.ts
git diff --name-only
```

Expected:
- test exit 0 (choice + precedence + fail-open assertions)
- `git diff --name-only` lists ONLY the 6 owned files

## 7. Commit message

`feat(routing): ledger-driven cost policy + exomode config (Gap D)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane D final report
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports — remove before merge if bridge):
- Lines added / removed:
- Verification:
  - bun test (lane file) exit: ___
  - git diff --name-only: ___
- Flags / blockers:
```
