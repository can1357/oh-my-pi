---
description: "Build ready-to-paste, per-database search strings (correct MeSH/Emtree/field-tag syntax) and record them for PRISMA reproducibility."
---

Build search strings. Database(s) or refinements requested: **$ARGUMENTS**

1. Resolve the active project; read `scope.md` and, if present, `searches/00-database-plan.md`. No scope: ask for one or suggest `/scope`.
2. Read `references/DATABASES.md` from the literature-search skill — resolve it RELATIVE to the skill directory (`$RESEARCH_HARNESS_HOME/research/skills/literature-search/references/DATABASES.md`, else glob `**/literature-search/references/DATABASES.md`). Its syntax rules are authoritative: controlled vocabulary (MeSH vs Emtree vs none), field tags, truncation/wildcards, proximity operators, boolean nesting.
3. Decompose the scope into concept blocks (2-4), each an OR-set of synonyms + controlled-vocabulary terms, ANDed together. State the blocks first.
4. For each target database ($ARGUMENTS if it names specific ones, else every database in the plan): emit ONE ready-to-paste string in a fenced code block, using that database's exact syntax. Strings MUST differ where the databases differ (MeSH terms in PubMed, /exp Emtree in Embase, TS= in Web of Science, TITLE-ABS-KEY() in Scopus, "Document Title"/"Abstract" fields in IEEE, no controlled vocabulary in arXiv). Add 1-2 bullets per database on what to check in its query builder (e.g. MeSH term exists, Emtree explosion).
5. Record every string for reproducibility: write `<project>/searches/NN-<database>.md` (NN = next free number) containing database, the exact string, today's date, and `hits: pending`. When the user later reports hit counts, update the file and run the prisma ledger: `python3 <skill>/scripts/prisma.py --project <project> identify --database <db> --count <hits>`.
6. Remind the user: paste each string into the database yourself, report hits, and export results as RIS/BibTeX for `/import`. arXiv/OpenAlex strings can be run directly with `/find`.
