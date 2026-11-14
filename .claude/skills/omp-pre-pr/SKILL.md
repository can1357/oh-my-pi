---
name: omp-pre-pr
description: >-
  Pre-PR checks for an omp2 slice: just lint/check/test, lintx ratchets, ADR 0035
  error discipline, native naming, additive-only rule, and diff review.
  Development aid only.
---

# omp-pre-pr

Run this on a slice's branch before opening or updating its PR. Authority:
`justfile`, `AGENTS.md` (Editing Discipline, Conventions, Allocation/Error
rules), ADR 0035, and the slice's acceptance criteria from `omp-slice-plan`.

## Diff review (before commands)

Confirm the diff is confined to the slice:

1. **Additive-only** — no behaviour/name/schema/revision change to existing
   tools, skills, convars, hooks, URL schemes, or CLI unless the ADR explicitly
   authorizes that slice.
2. **Native naming** — no `pi-*`, `pi_`, `PI_*`, `.pi` paths, or pi-era settings
   keys. New crates are `omp-*`; convars `sv_*` / `cl_*`.
3. **ADR 0035 errors** — `thiserror` with `#[error("…")]`; no string-payload
   error variants; no `sf!("…: {error}")` / `.to_string()` of inner errors;
   carry typed `#[source]` / `#[from]` and identifying fields.
4. **Enum↔string** — derived strum, not hand-written match tables.
5. **Unicode/hash** — `xutf` only; discretionary hashes via `omp-core`
   (`Hash32` / `FastHash*`), no new hasher crates.
6. **Deps** — workspace `[workspace.dependencies]` only; no lockfile churn
   unrelated to the slice.
7. **Docs ledgers** — if Status moved, `STATUS.md` / `TASKS.md` / ADR
   `Status in omp` updated in the same change.
8. **Editing discipline** — no `sed`/`perl`/`python` rewrites of tracked
   sources; edits via the editing tools (AGENTS.md).

## Commands (in order)

Prefer `just` over raw cargo. Focused first, then broaden.

```sh
just check-pkg <touched-crates…>
just test-pkg <touched-crates…>
just lintx-ratchet          # must not raise error-formatting baselines
just lint-editing-discipline
# when the slice touches workspace-wide surfaces:
just lint                   # fmt-check clippy proto-lint locked-maps lintx-ratchet editing-discipline
just check-minimal-caps     # if cap-* / omp-app features changed
just check-extensions       # if extension manifests / frozen API changed
```

E2E only when the slice claims a gated proof or user-visible joined behaviour
named in the acceptance criteria (`just e2e-…`). TUI slices need real-PTY proof.

Hosted CI runners may be offline; still run the local checks above and treat
green local focused proof as the merge assumption only when the slice's named
tests pass. Do not wait on remote runners to finish the slice.

## PR shape

- Branch: one slice, descriptive name.
- Title: area-scoped (`feat(adr0050): …`, `fix(…): …`, `chore(skills): …`).
- Body: link ADR + slice id, acceptance criteria, commands run with pass/fail,
  explicit non-goals left for later slices.
- Do not merge to `omp2` yourself; leave merging to repo rules.
- Do not force-push or rewrite history on shared branches.

## Fail closed

If a named acceptance test is missing, a lintx ratchet rises, or an additive-only
violation appears, stop and fix before opening the PR. A clean compile alone is
not acceptance.
