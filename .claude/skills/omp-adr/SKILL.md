---
name: omp-adr
description: >-
  Author or amend an Architecture Decision Record under docs/adr/ using this
  repo's format, numbering, status vocabulary, and STATUS.md / TASKS.md ledger
  rows. Development aid only.
---

# omp-adr

Authority: `docs/adr/README.md`, existing ADRs, `docs/adr/STATUS.md`,
`docs/adr/TASKS.md`, and `AGENTS.md` locked deviations. Do not invent a second
format.

## Numbering

- Next free number = highest existing `docs/adr/NNNN-*.md` + 1 (zero-padded to 4).
- One decision per file: `docs/adr/NNNN-kebab-title.md`.
- Revising a decision in place keeps the number and adds
  `## Amendment (YYYY-MM-DD)`; supersession gets a new record and a
  `Superseded by` line.

## Status vocabulary (ADR header)

Use the same spellings the ledger already uses:

- `proposed` / `Proposed YYYY-MM-DD`
- `accepted` / `accepted by the owner on YYYY-MM-DD, with conditions …`
- `accepted YYYY-MM-DD` with phase notes when partial
- `superseded by NNNN`

Implementation labels in `## Status in omp` and `STATUS.md`:

- **Implemented** — decision realized; remaining limits listed in the ADR
- **Partially implemented** — named parts missing
- **Not started** — not yet started or not authorized
- **Superseded or diverged** — rare; prefer "Gap or divergence" column instead

## ADR body shape

```markdown
# NNNN. Title

Status: …
Date: YYYY-MM-DD
Area: foundations | state | runtime | control-plane | inference | tools | interface | stack

## Context
Evidence with path:line. Forces, not opinion.

## Decision
Normative MUST/NEVER rules (D1, D2, …). Call sites and shapes where useful.

## Alternatives considered
| Alternative | Why not |

## Consequences
Easier / Prohibited / Costs accepted.

## Implementation gate
What authorizes production change (owner acceptance, conditions, slice order).

## Status in omp
Status: Implemented | Partially implemented | Not started | …
Evidence bullets (paths, symbols). Gaps marked plainly.

## References
Related ADRs, code, research notes.
```

Optional after EGM review: `## What the review changed` listing each finding,
whether confirmed against source (`path:line`), and what changed.

## Ledger rows (same change)

1. **STATUS.md** — one table row: ADR link, title, Status, Gap or divergence,
   Owner decision.
2. **TASKS.md** — when the ADR has an active queue: section `## ADR NNNN — …`
   with DONE / OPEN / BLOCKED / PARTIAL items and slice sequencing.
3. Update `docs/adr/README.md` index only when adding a permanent area entry
   that other ADRs already follow.

## Rules

- `Decision` is normative; `Context` is evidence.
- Cite real paths; lead Status in omp with one status label.
- Do not reopen locked ADRs (0036 Python-only, 0024 latched roster, 0006 sandbox,
  …). Record "not adopted" with reason if a gap collides.
- Proposed ADRs with open owner questions (O1, O2, …) must not claim
  implementation authorization. Accepted-with-conditions ADRs may start only
  the slices the gate names (example: ADR 0050 S1/S2).
- Hand off slicing to `omp-slice-plan`. Do not implement in this skill.
