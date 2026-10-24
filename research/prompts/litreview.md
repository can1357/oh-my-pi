---
description: "Run a mini literature review: search, screen, fetch OA PDFs, synthesize with citations, ingest into the paper graph."
---

Run a mini literature review for: **$ARGUMENTS**

Pipeline — execute in order:

1. **Restate the question.** Extract the research question from the argument above. If the argument also states screening criteria (e.g. after "criteria:"), use them verbatim. If no criteria were given, ask the user for include/exclude criteria; default to relevance-based include/exclude (include = the paper directly addresses the question) if they decline or in headless mode.
2. **Resolve the corpus (optional).** A local corpus is in play when the argument contains `--corpus <dir>` or `corpus: <dir>`, or the `RESEARCH_CORPUS_DIR` environment variable is set. The corpus directory is READ-ONLY — never write, move, or delete anything in it. With a corpus, the review runs fully offline over those PDFs (no web search required) unless the argument explicitly asks to combine corpus and web results.
3. **Search.** Spawn the `scholar` agent via the task tool with the research question (and any candidate cap from the argument). Pass the corpus directory when one was resolved, telling it corpus-only or corpus+web per step 2. It returns deduped candidates with abstracts; local candidates carry a `path`.
4. **Screen.** Spawn the `screener` agent via the task tool with the criteria, `stage=title-abstract`, and the full candidate batch (id, title, abstract per candidate). Criteria methodology (PCC framework, verdict rules) is defined in `research/skills/literature-search/references/SCREENING.md` — the screener reads it; when restating criteria to the user, follow its PCC structure. For local candidates, an optional second `stage=fulltext` pass is available: get full text via `python3 research/skills/literature-search/scripts/local_library.py extract --path <pdf>` and pass it to the screener (verdicts become binary include/exclude).
5. **Present verdicts.** Show a table: title, verdict, rationale. Interactive: ask the user to confirm/adjust includes. Headless/-p mode: proceed with the `include` verdicts automatically (treat `maybe` as exclude).
6. **Fetch OA PDFs.** Local papers need no fetching — their `path` already points at the PDF. For each other included paper with a non-null `pdf_url`/`oa_pdf_url`, run `python3 $RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/fetch_paper.py --url <url> --out ./papers/<id or slug>.pdf` (if `RESEARCH_HARNESS_HOME` is unset, glob for `**/literature-search/scripts/fetch_paper.py`). Skip null URLs — never substitute shadow-library sources. A failed fetch is noted, not fatal. Corpus-only runs skip this step entirely.
7. **Synthesize.** Spawn the `synthesizer` agent via the task tool with the research question, the criteria and counts, the included papers' metadata, and the local paths of the PDFs (corpus `path`s and any fetched files). It writes `review-<slug>.md` in the cwd.
8. **Grow the paper graph.** Locate `paper_graph.py` (try `$RESEARCH_HARNESS_HOME/research/skills/paper-graph/scripts/paper_graph.py`, else glob for `**/paper-graph/scripts/paper_graph.py`). Then, for the INCLUDED papers only:
   - `add` each with a stable slug id and all known metadata (`--title --authors --year --venue --doi --url --abstract`, plus `--path` for local papers).
   - `link` every pair of included papers with `--type same-topic --note "<review slug>"` (they co-appear in this review).
   - Run `auto-edges <id>` for each added paper to pull citation edges from OpenAlex; a failed or empty run is noted, not fatal. Skip auto-edges when the run must stay offline (corpus-only review with no network).
9. **Report.** This step is MANDATORY and always last. Print the review file path, include/exclude/maybe counts, how many PDFs were fetched (or "local corpus, none fetched"), and the output of `paper_graph.py stats` so the user sees the graph grow.
