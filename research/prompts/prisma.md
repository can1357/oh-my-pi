---
description: "Show the PRISMA-ScR flow diagram derived from the review store (text/mermaid/svg/html), or the legacy manual count ledger."
---

PRISMA flow: **$ARGUMENTS**

Scripts live in the literature-search skill (`<skill>/scripts/`, resolved via `$RESEARCH_HARNESS_HOME` or glob). Resolve the active project first.

- **`<project>/review.db` exists (the normal case):** the derived diagram is authoritative. Run
  `python3 <skill>/scripts/prisma_scr.py --project <slug> --format text`
  and print the diagram verbatim in a code block. `--format mermaid|svg|html` when the argument asks for a manuscript/GitHub flavor; `svg`/`html` take `--out <file>`. Every count is computed from record states in review.db, so the arithmetic reconciles by construction — never hand-type a number over it. `NOTE:` lines mean pending work (unscreened records, retrieval in flight); propose the command that clears them (`/screen`, `/fulltext`).
- **No review.db** (legacy or manual-count review): fall back to the `prisma.py` ledger — dedupe JSONL records with `prisma.py dedupe --records`, apply manual corrections via `identify`/`exclude`/`include`, and finish with `prisma.py show` printed verbatim. If it prints an arithmetic WARNING, diagnose which count is stale and fix it now.
- Corrections to a derived diagram belong in the store (`review.py verdict` / `set-state` / `dedupe`), never in the diagram output.
- State what the numbers came from (review.db states, or which ledger entries) so the flow is reproducible, then propose the next step (`/screen` if unscreened, `/fulltext` if retrieval pending, `/review` if screened).
