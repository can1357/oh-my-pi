---
description: "Retrieve full texts for screened-in records via the OA-first cascade: OpenAlex, Unpaywall, arXiv, local corpus, then a web-search candidate for human review."
---

Retrieve full texts. Refinements: **$ARGUMENTS**

1. Resolve the active project. Targets: `python3 <skill>/scripts/review.py --project <slug> list --state screened_included` (add `--state fulltext_not_retrieved` records when $ARGUMENTS says "retry"). Skill = literature-search, resolved via `$RESEARCH_HARNESS_HOME` or glob.
2. For each target run `python3 <skill>/scripts/fetch_paper.py resolve --id <id> --project <slug> --fetch`. The cascade tries, in order: OpenAlex OA location, Unpaywall, arXiv, the local corpus (`RESEARCH_CORPUS_DIR`, read-only), and web search LAST. Outcomes (state, `pdf_path`, `oa_source`, `oa_status`) are written back to review.db automatically; already-retrieved records are skipped, so re-running is idempotent.
3. Unpaywall requires a contact email: it is skipped with a stderr notice when neither `UNPAYWALL_EMAIL` nor `OPENALEX_MAILTO` is set. If you see that notice, tell the user how to enable it — never a fake address.
4. The web-search step only RETURNS a `candidate_url` for human review — never download from an arbitrary host. Present candidates to the user; only after they approve a specific OA URL, fetch it with `fetch_paper.py fetch --url <url> --out <project>/papers/<id>.pdf` and record it: `review.py set-state --id <id> --state fulltext_retrieved --pdf-path <path> --oa-source web_search`. Open-access sources only — never shadow libraries.
5. Report a table: id, retrieved/not-retrieved, `oa_source`, `oa_status`, and the not-retrieved reasons. Finish with `review.py --project <slug> stats` and propose `/screen fulltext`, then `/prisma`.
