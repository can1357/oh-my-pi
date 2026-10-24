---
description: "Mark duplicate records in the review store: DOI match first, then normalized title; survivors keep merged metadata."
---

Deduplicate the review's records. **$ARGUMENTS**

1. Resolve the active project (records must already be imported into `<project>/review.db` — else propose `/import`).
2. Run `python3 <skill>/scripts/review.py --project <slug> dedupe` (skill = literature-search, resolved via `$RESEARCH_HARNESS_HOME` or glob). It matches by normalized DOI first, then normalized title (lowercase, non-alphanumerics stripped), marks losers `duplicate` with a pointer to the survivor, and carries missing metadata (doi/url/abstract/pdf) onto the survivor. Records already screened are never demoted.
3. It prints one JSON line per merge (`duplicate`, `survivor`, `via`). Present them as a table. Re-running is idempotent — nothing new is marked.
4. If a merge looks wrong (two genuinely different papers sharing a title), show both with `review.py get --id <id>` and flag it to the user instead of silently accepting it.
5. Finish with `review.py --project <slug> stats` and propose `/screen`.
