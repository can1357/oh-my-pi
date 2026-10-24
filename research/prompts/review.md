---
description: "Synthesize a cited review from the project's included papers."
---

Synthesize the review. Emphasis/refinements: **$ARGUMENTS**

1. Resolve the active project; collect the included records — `python3 <skill>/scripts/review.py --project <slug> list --state included` (plus `--state fulltext_retrieved` when full-text screening hasn't run), else legacy `records/screened-*.jsonl`, else ask to run `/screen` first — the scope, and the PRISMA counts (`prisma_scr.py --format text`, or `prisma.py show` when no review.db).
2. Records with a `pdf_path` need no fetching. For the rest, run the OA cascade: `python3 <skill>/scripts/fetch_paper.py resolve --id <id> --project <slug> --fetch` (or `/fulltext`). Never substitute shadow-library sources; a failed fetch is noted, not fatal.
3. Spawn the `synthesizer` agent via the task tool with the question, criteria, PRISMA counts, included metadata, and local PDF paths. It writes `review-<slug>.md` — have it write into the project directory.
4. Report the review path and its citation count, then propose next: `/graph` to file the included papers, `/export` for Covidence/Zotero, `/prisma` for the final ledger.
