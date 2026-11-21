# Brief: radare2 + r2pipe backend parity for oh-my-pi `dsm`

**Date:** 2026-11-17
**Depth mode:** deep (7 round-1 workers, 2 follow-up rounds, 25+ primary sources target)

## Question

What exact radare2 / r2pipe APIs, commands, config variables and persistence semantics are needed to build a Python NDJSON worker backend with parity to oh-my-pi's existing IDA/Ghidra `dsm` adapters?

## Decision

Whether a full-parity radare2 backend is feasible, which commands implement each required operation, and where parity is impossible or awkward (with closest supported alternatives).

## Answer form

Cited technical reference: command/API snippets per operation, a parity matrix, explicit gaps, and gotchas that change adapter design. Not a product recommendation.

## Scope

### In
1. r2pipe Python API: open binary/project, text and JSON commands, quit, one r2 instance per worker; async/interrupt behavior (native vs SIGINT/process-level).
2. Project persistence: `Ps`, `Po`, `Pn`, `r2 -p`, project-dir config / env vars (e.g. `R2_PROJECTS`); files produced; reopen saved project without touching source binary.
3. Analysis commands per view: imports, exports, strings, functions list, pseudocode (`pdc` vs `pdg` / r2ghidra availability), disassembly, xrefs to/from, overview data.
4. Mutations: rename function/flag, comment (normal vs repeatable), set C function type/prototype, make function at address, dirty-state detection, save.
5. Address/symbol resolution: `0x` hex, names, decimals; failure modes for unknown symbols.
6. Constraints/gotchas: headless/noninteractive flags, `r2 -A` auto-analysis cost, project-dir config vars, Windows support, r2pipe installation, whether commands modify the source binary.
7. Parity gaps: items impossible or awkward in radare2; closest supported alternative for each.

### Out
- Implementing the adapter (no repo code edits).
- Benchmark numbers unrelated to analysis cost.
- Third-party tutorials except as leads to primary docs.

## Assumptions

- Worker is a Python process speaking NDJSON over stdio; it owns one long-lived r2 instance.
- "Parity" = same observable operations as IDA/Ghidra adapters, not identical data shape.
- radare2 current stable as of 2026-11-17; note version-dependent behavior and dates.
- Primary sources = official rada.re docs, radare2 GitHub source/wiki, r2pipe source, r2ghidra source.
- Secondary sources only as leads; each must be traced to a primary.

## Angles (flat, 7 workers)

- **F1** r2pipe Python API + process lifecycle + async/interrupt.
- **F2** Project persistence: commands, files, config, reopen behavior.
- **F3** Read-only analysis views: imports, exports, strings, functions, disassembly, xrefs, overview.
- **F4** Decompilation/pseudocode: `pdc`, `pdg`, r2ghidra availability and output.
- **F5** Mutations: rename, comments (normal/repeatable), set_type, make_function, dirty tracking, save.
- **F6** Address/symbol resolution + failure modes + headless/Windows/install/source-modification constraints.
- **F7** Parity gaps, awkward mappings, counter-evidence from official issue trackers; closest alternatives.

## Clusters

None (7 angles, under 12). Flat dispatch.

## Deliverable

`docs/research/radare2-backend-parity/REPORT.md` — single-point synthesis, answer-first, inline citations, sources grouped by weight.
