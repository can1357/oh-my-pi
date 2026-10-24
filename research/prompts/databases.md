---
description: "Recommend which literature databases to search for the current scope, with rationale, coverage gaps, and access notes."
---

Recommend databases for the active review. Extra guidance from the user: **$ARGUMENTS**

1. Resolve the active project and read its `scope.md` (no project yet: scope from $ARGUMENTS if it contains a question, else suggest `/scope` and stop).
2. Read the database reference: `references/DATABASES.md` inside the literature-search skill — resolve it RELATIVE to the skill directory (`$RESEARCH_HARNESS_HOME/research/skills/literature-search/references/DATABASES.md`; if the env var is unset, glob for `**/literature-search/references/DATABASES.md`). Never assume an absolute path.
3. Recommend databases FOR THIS QUESTION, not a generic list. Output a table: Database | Why for this question | Coverage gaps | Access (paywalled/free) | Syntax family (MeSH/Emtree/field tags/none). Apply the "no single database is sufficient" rule: a defensible set is usually 2-3 core databases + 1 preprint/grey source, chosen by domain (clinical -> PubMed+Embase(+CENTRAL for RCTs, CINAHL for nursing, PsycINFO for behavioral); computing -> IEEE Xplore+ACM DL+arXiv; cross-disciplinary -> Scopus or Web of Science).
4. Mark which sources this harness can query directly (arXiv, OpenAlex, local corpus) vs which the user must search manually and export RIS/BibTeX from.
5. Save the recommendation to `<project>/searches/00-database-plan.md`.
6. Propose next: `/searchstring` to build the per-database strings.
