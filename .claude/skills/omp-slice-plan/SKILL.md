---
name: omp-slice-plan
description: >-
  Slice an accepted or proposed ADR into one-PR units with acceptance criteria
  and the test kinds this repo uses (unit, e2e crate, golden journal).
  Development aid only.
---

# omp-slice-plan

Authority: the ADR's Implementation gate and slice table (if any),
`docs/adr/TASKS.md`, `AGENTS.md` Testing & QA, `crates/e2e/README.md`, and
`justfile` recipes. Prefer the ADR's own sequencing when it already names
slices (example: ADR 0050 S1–S5).

## Slice size

- One PR per slice. A slice is small enough to review and revert alone.
- Name slices `S1`, `S2`, … or short kebab ids the ADR already uses.
- Each slice lists: owning crates/files, candidate API boundary, dependencies
  on earlier slices, acceptance criteria, tests, risks, relative complexity.
- Default-off `cap-*` feature or convar until acceptance tests pass, unless the
  ADR already authorizes a different gate (example: ADR 0050 S1 inert surface).

## Acceptance criteria

Write criteria as observable behaviour, not "code exists":

- Named test id when the ADR requires one (example:
  `declared_scheme_fold_refuses_builtin_and_unclaimed`).
- Invariants that must not change (built-in `Scheme` enum, latched roster,
  `url-vocab.json`, existing URL schemes).
- Explicit non-goals for the slice (leave S3/S4 work out of an S2 PR).

## Test kinds (this repo)

| Kind | When | How |
| --- | --- | --- |
| **Unit** (colocated `src` or `crates/*/tests`) | Private behaviour, parsers, pure fold/refuse logic | `just test-pkg <crate>` (nextest + doctests) |
| **Contract / py** | Frozen Python surface, packed vocab | `just test-pkg omp-py` and related |
| **Golden journal** | Durable session/DOM fold behaviour | fixtures under session corpus; see ADR 0048 B5 |
| **E2E** (`crates/e2e`) | Joined-system proofs, PTY lifecycle, approvals | `just e2e-*` only when the slice changes a gated proof surface |
| **Real-PTY** | TUI / chat input, resize, quit | `.omp/tools/tui.ts` or `OMP_TUI_DEBUG` / `OMP_TTY` |
| **Extension conformance** | First-party extension manifests | `just check-extensions` |

Do not invent a coverage percentage. Defend the changed observable behaviour:
branch edges, precedence, malformed input, cancellation, recovery.

## Plan artifact

Update the ADR slice table and/or `TASKS.md` section in the same change that
locks the plan. Example row:

| Slice | PR | Exit |
| --- | --- | --- |
| S2 | Fold claims into `set_host_uri_schemes` generation | named refuse test; read returns handler body; `pr://` intact |

## Sequencing rules

- Respect BLOCKED prerequisites in TASKS (example: ADR 0050 S3 blocked on D5
  effect-judgment fix).
- Do not merge slices the owner left separate unless the ADR records that
  option as adopted.
- Hand off implementation to coding agents; close with `omp-pre-pr` before
  opening the PR.
