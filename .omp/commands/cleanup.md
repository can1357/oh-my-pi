# Cleanup Command

Autonomous cleanup-loop iteration: discover ONE target → complete execution → verify → report. Runs stateless: derive from current tree; assume prior runs left it consistent.

<critical>
- Behavior-preserving ONLY: CLI, SDK, RPC surface, rendered output NEVER change.
- Every iteration MUST yield a named concrete quality win: duplicate implementation gone, responsibility extracted, dead cluster removed, guard clutter deleted. Deletion favored: net-negative LOC expected and candidate tie-breaker; justified net-neutral/positive split or hierarchy fix acceptable only with real win. Report LOC delta either way.
- NEVER commit; NEVER touch generated or vendored code.
- Complete cutover this run: migrate every copy and callsite; delete originals. NEVER half-migrate.
- No target above bar → output exactly `CLEAN: no target above threshold` and stop.
</critical>

## Scope

TypeScript only. Package priority: `packages/coding-agent`, `packages/ai`, `packages/catalog`, `packages/utils`. Other packages MAY change only when callsite migration requires.

NEVER touch: `**/*-gen/**`, `**/vendor/**`, generated JSON catalogs, `.d.ts`, test fixtures/snapshots, lockfiles, non-TS.

## 1. Discover

First run `bun scripts/cleanup-scan.ts`; `--json`: machine output; `--pkg=<a,b>|all`: widen scope. It reports god-object candidates, clone clusters/line ranges, junk drawers, tiered dead-export candidates, deep relative imports, defensive-check hotspots. Output is EVIDENCE, not verdict: read every entry before action. Where scanner misses semantic duplication or wrong-home modules with shallow imports, use `lsp references` and targeted grep.

Candidate classes:

**Dead weight** — highest value/risk
- `dead-exports`: exported symbols with zero repo non-test references. `barrel-public`: re-exported via explicit `exports`-map entry or public barrel; published surface, PROTECTED—tools cannot see external consumers. `wildcard-only`: importable only through `./*` subpath pattern; internal-by-default, deletable once proven.
- Unpassed options/parameters; unreachable branches.
- Compatibility shims, deprecated aliases, re-export indirection from past refactors.
- Runtime checks duplicating type-system guarantees.

**Duplication**
- `clones` gives exact ranges. Literal-heavy schema tables/registry descriptors intentionally repeat; extract only if a helper genuinely simplifies every site.
- Helper reimplemented in 2+ files; copies differing only by literal/flag.
- Inline reimplementation of central path-shortening, truncation, spawning, stream-reading, or caching utility.
- Parallel switch/if chains dispatching on one discriminant in multiple locations.

**God objects**
- File dwarfs siblings AND mixes responsibilities: state + IO + rendering + parsing; or class methods span domains.
- Size alone no smell: retain large coherent files.

**Hierarchy rot**
- Domainless junk drawers: `utils`, `helpers`, `misc`, `common` with unrelated accretions.
- `../../..` imports: wrong module home.
- Directories grouped by kind (`types/`, `constants/`, `interfaces/`) rather than domain.
- Unused barrels; single-file directories; names no longer describing contents.

## 2. Select

Score `(quality win × confidence) / blast radius`. Pick exactly ONE cluster, roughly ≤12 touched files. Tie-break: deletion > dedup > split > move; equals → larger LOC reduction.

Worth-doing bar: name win in one sentence, e.g. entire duplicate implementation or ≥100 duplicated/dead lines removed; oversized, multi-responsibility package file split; junk drawer, dead-export cluster, or guard-clutter hotspot eliminated; module cluster moved so tree reads designed, not accreted.

## 3. Execute

**Dead weight / type checks**
- Delete dead exports and tests only mirroring them. Export deletion requires BOTH: (1) `lsp references`: no callsites—missed callsites are bugs; (2) `wildcard-only`: no direct/transitive re-export through explicit `exports`-map entry or public barrel. Either fails → retain.
- Narrow once at IO boundary; internal code receives narrowed type. Delete downstream `?.` on non-nullable values, `?? fallback` on non-optional values, `typeof`/`Array.isArray` re-narrowing, and `as` casts papering over flow.
- Genuinely sometimes-absent value → fix TYPE upstream; NEVER add downstream guards.
- Swallow-and-limp `try/catch` → delete or propagate error. Precise catches only, e.g. ENOENT.

**Dedup**
- 2+ copies → one function in nearest common domain module; cross-package → shared utils package. NEVER create a junk drawer.
- Literal/flag variants → one function with options object; NEVER boolean positionals.
- Keep hardened copy—timeouts, caps, sanitization—not fresh copies that lack hardening.

**God objects**
- Split on existing seams into domain-named, single-responsibility modules.
- Extraction = MOVEMENT: code verbatim except imports/visibility; rewriting while moving hides regressions.
- Update every importer; NEVER retain re-export shim. Split introducing interface, base class, event bus, or DI where direct call existed = failed split.

**Hierarchy**
- Use `lsp rename_file` to move files and rewrite imports everywhere.
- Group by domain, not kind; collapse single-file directories; delete empty barrels.
- Resulting tree MUST read as always designed.

**Perf** — opportunistic; only code already touched
- Hoist loop invariants; precompile regexes; use one pass rather than chained filter/map on hot paths; remove intermediate arrays/strings/copies.
- NEVER trade cold-path clarity for micro-perf; NEVER add caching layers.

## 4. Prohibitions

- NEVER add dependencies, config/options, feature flags, wrapper layers, one-implementation abstractions, or "future-proofing".
- NEVER rename or alter public surface: CLI plus symbols reachable from explicit non-wildcard `exports`-map entry or public barrel. External consumers exceed repo references. Wildcard `./*` exposes files mechanically, not contractually; explicit entries/barrels define contract.
- NEVER reformat/restyle outside touched cluster.
- NEVER drive-by comment/doc sweep; comment only new non-obvious code.
- NEVER add tests for moved-but-unchanged code; retain passing tests, relocating them with subject.

## 5. Verify

1. `bun check`: clean.
2. Run touched package tests scoped to affected areas.
3. Renderer/TUI touched → confirm sanitization helpers wrap every render path.

## 6. Report

- Target: choice and smell class.
- Actions: deleted/merged/split/moved; named quality win; LOC delta.
- Verification: exact commands and results.
- Risk: reviewer checks.

<critical>
One target/run; complete migration; originals deleted; `bun check` clean. Named quality win; identical behavior; no new abstractions or shims. Deletion-leaning: justify net-positive delta. Nothing above bar → `CLEAN: no target above threshold`.
</critical>
