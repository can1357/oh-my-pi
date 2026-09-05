# Exomode orchestration — single opt-in master switch for time/cost optimization

## 1. Purpose

Exomode bundles four behavior-preserving optimizations (per-task ledger,
prompt-view cache, sealed secrets, ledger-driven cost policy) behind one
`exomode.enabled` master switch with per-subsystem kill switches. Parallel
dispatch is justified: lanes B/C/D own disjoint files and depend only on
lane A's frozen query contract, so wall time ≈ max(B,C,D) + A + E.

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | File |
|---|---|---|---|---|---|
| A | Per-task cost/latency ledger | `[pre-phase]` | MEDIUM | none | `.prd/lane-a-ledger.md` |
| B | Prompt-view cache | `[parallel-builder]` | MEDIUM | A (contract only) | `.prd/lane-b-prompt-cache.md` |
| C | Sealed secrets | `[parallel-builder]` | SMALL | A (contract only) | `.prd/lane-c-sealed-secrets.md` |
| D | Cost policy + exomode config | `[parallel-builder]` | MEDIUM | A (query API) | `.prd/lane-d-cost-policy.md` |
| E | Acceptance gate + evidence | `[acceptance-gate]` | TINY | A, B, C, D | `.prd/lane-e-acceptance.md` |

## 3. 5-row dispatch table (operational form)

| Lane | Gap letters | Owned files | Effort | Model | Subagent | Isolation | Depends on | Verify commands |
|---|---|---|---|---|---|---|---|---|
| ledger | A | `packages/stats/src/task-aggregator.ts` (new), `db.ts`, `types.ts`, `index.ts`, `test/task-ledger.test.ts` (new) | MEDIUM | sonnet | task | shared checkout | none | `bun test packages/stats/test/task-ledger.test.ts`, `bun run check` in `packages/stats` |
| prompt-cache | B | `packages/coding-agent/src/session/messages.ts`, `prompt-view-cache.ts` (new), `session/__tests__/prompt-view-cache.test.ts` (new) | MEDIUM | sonnet | task | shared checkout | A contract | `bun test` lane test file only |
| sealed-secrets | C | `packages/coding-agent/src/secrets/index.ts`, `obfuscator.ts`, `system-prompt.ts`, `secrets/__tests__/sealed-secrets.test.ts` (new) | SMALL | smol | task | shared checkout | A contract | `bun test` lane test file only |
| cost-policy | D | `settings-schema.ts`, `routing/types.ts`, `pool-manager.ts`, `fast-stream-router.ts`, `sdk.ts`, `routing/__tests__/cost-policy.test.ts` (new) | MEDIUM | sonnet | task | shared checkout | A query API | `bun test` lane test file only |
| acceptance | E | `evidence/exomode-evidence.md` (new) | TINY | smol | task | shared checkout | A–D merged | full suite (orchestrator) |

Shared checkout (no worktrees): disjoint file ownership guarantees no
conflicts. Lanes run ONLY lane-scoped verification; the orchestrator runs
`bun run check`, `bun test`, biome once post-merge.

## 4. File-ownership matrix

| File | A | B | C | D | E |
|---|---|---|---|---|---|
| `packages/stats/*` | own | – | – | read-only import | – |
| `session/messages.ts`, `prompt-view-cache.ts` | – | own | – | – | – |
| `secrets/*`, `system-prompt.ts` | – | – | own | – | – |
| `settings-schema.ts`, `routing/*`, `sdk.ts` | – | – | – | own | – |
| `evidence/exomode-evidence.md` | – | – | – | – | own |

`sdk.ts` owned SOLELY by D. B's wiring stays inside `session/`;
C's sealing stays inside `secrets/*` + `system-prompt.ts`. Any B/C
discovery of a needed `sdk.ts` change is bundled into D — never a second
parallel edit.

## 5. Execution sequence

1. Phase 0: done (quick-scope gaps table; contract frozen in
   `.prd/exomode-decision.md`).
2. Lane A solo via `task`. Block, verify, merge.
3. Lanes B, C, D in one `task` fan-out. No project-wide gates from lanes.
4. Sequential merge (any order — ownership is disjoint). Remove any
   `@ts-expect-error` bridges; reconcile field drift.
5. Lane E solo: evidence doc, delete `findings-*.md`, full verification.

## 6. Acceptance criteria checklist

- [ ] `packages/stats/test/task-ledger.test.ts` exits 0 and asserts
      `{ wallMs, ttftMs, inputTokens, outputTokens, costUsd }` on a fixture
      session (wallMs excludes idle)
- [ ] `session/__tests__/prompt-view-cache.test.ts` exits 0: byte-identical
      prompt with/without cache; 50k-token fixture shows TTFT delta > 0
- [ ] `secrets/__tests__/sealed-secrets.test.ts` exits 0: fake token via
      auth.json + env appears nowhere in assembled Context
- [ ] `routing/__tests__/cost-policy.test.ts` exits 0: ledger-driven choice
      asserted; explicit selection beats exomode suggestion (precedence test)
- [ ] `git diff --name-only` per lane matches its ownership row
- [ ] No `findings-*.md` fragments remain; `evidence/exomode-evidence.md`
      committed referencing concrete test paths
- [ ] `bun run check` (biome + types) exits 0 post-merge
