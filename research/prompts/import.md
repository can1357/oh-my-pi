---
description: "Import RIS/BibTeX/CSV/JSONL exports into the review store (review.db) as identified records, with per-database counts."
---

Import reference export(s): **$ARGUMENTS**

1. Resolve the active project. The argument names one or more files (`.ris`, `.bib`, `.csv`, `.jsonl`) and optionally the source database ("from embase"). No file named: ask for the path.
2. For each file run `python3 <skill>/scripts/review.py --project <slug> import --path <file> --database <database>` (skill = literature-search, resolved via `$RESEARCH_HARNESS_HOME` or glob — never an absolute assumption). `--database` is the database the user named, else the file basename; PRISMA needs per-source identified counts. Records land in `<project>/review.db` in state `identified`; malformed entries are skipped with a stderr note.
3. Imports are idempotent — re-importing the same file reports `already_present`, never duplicate rows. Report each file's JSON summary (added / already_present / skipped) honestly.
4. If a `searches/NN-<database>.md` entry has `hits: pending`, fill in the hits. Then show `review.py --project <slug> stats`.
5. Propose next: `/dedupe` (DOI, then normalized title), then `/screen`.
