---
description: "Run the searches this harness CAN run: arXiv + OpenAlex + the local PDF corpus. Saves deduped candidate records to the project."
---

Find candidate papers for: **$ARGUMENTS** (empty: use the active project's scope)

1. Resolve the active project and its `scope.md`. The query is $ARGUMENTS if non-empty, else the scoped question. A candidate cap in the argument ("max N") is honored.
2. Spawn the `scholar` agent via the task tool with the question, cap, and — when `RESEARCH_CORPUS_DIR` is set — the corpus directory (corpus is READ-ONLY). Corpus-only if the user asked for offline; otherwise corpus + arXiv + OpenAlex.
3. Save the returned deduped candidates as JSON lines to `<project>/records/found-<source>-<date>.jsonl`, one file per source actually searched (arxiv, openalex, local-corpus).
4. Import each into the review store so screening and PRISMA derive from it: `python3 <skill>/scripts/review.py --project <slug> import --path <file.jsonl> --database <source>` (idempotent). Record each executed query under `<project>/searches/` (database, string, date, hits) like /searchstring does.
5. Report counts per source and `review.py stats`, then propose next: `/import` for records from manual database searches, then `/dedupe`, then `/screen`.
