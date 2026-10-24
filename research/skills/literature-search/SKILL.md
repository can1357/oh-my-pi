---
name: literature-search
description: "Use when searching academic literature. Search arXiv/OpenAlex, fetch open-access PDFs."
---

# literature-search

Eight python3-stdlib CLI scripts under `scripts/` (relative to this SKILL.md). Three sources are first-class: arXiv (Atom export API), OpenAlex (api.openalex.org), and a **local PDF corpus** (no network); RIS/BibTeX/CSV exports from manually searched databases come in via `refs_io.py` or land directly in the per-project review store via `review.py import`. Search scripts emit one JSON object per line on stdout; errors go to stderr with exit 1.

Two reference documents under `references/` (relative to this SKILL.md): `SCREENING.md` (PCC criteria + verdict methodology) and `DATABASES.md` (database selection + per-database search syntax: MeSH vs Emtree vs field tags, truncation, proximity, worked multi-database example). Database recommendations and search strings MUST come from `DATABASES.md`; resolve it relative to the skill directory, and record every executed search (database, exact string, date, hits) in the project's `searches/` directory.

**Policy: Open-access sources only; never fetch from shadow libraries.**

## arxiv_search.py

```sh
python3 scripts/arxiv_search.py --query "multi-agent LLM" [--max 15] [--category cs.CL]
```

- `--query` (required): free-text query, searched as `all:<query>`.
- `--max` (default 15): max results.
- `--category` (optional): ANDs `cat:<c>` onto the query, e.g. `cs.CL`.

Output schema per line: `{"source":"arxiv", "id", "title", "authors":[...], "abstract", "published", "pdf_url"}` — title/abstract whitespace-normalized.

Sample line:

```json
{"source": "arxiv", "id": "2410.12532v3", "title": "MedAide: Information Fusion and Anatomy of Medical Intents via LLM-based Multi-Agent Collaboration", "authors": ["Xian Gao", "Jiacheng Ruan"], "abstract": "In healthcare intelligence, the ability to fuse heterogeneous, multi-intent information...", "published": "2024-10-16T13:10:27Z", "pdf_url": "https://arxiv.org/pdf/2410.12532v3"}
```

## openalex_search.py

```sh
python3 scripts/openalex_search.py --query "LLM clinical agents" [--max 15] [--from-year 2022]
```

- `--query` (required): full-text search.
- `--max` (default 15): per-page result count.
- `--from-year` (optional): filter `from_publication_date:<Y>-01-01`.

Output schema per line: `{"source":"openalex", "id", "doi", "title", "authors":[...], "year", "venue", "cited_by", "abstract", "oa_pdf_url"}`. Any field may be `null` when OpenAlex lacks it; `abstract` is `""` when the inverted index is missing (abstracts are reconstructed from `abstract_inverted_index`).

Sample line:

```json
{"source": "openalex", "id": "https://openalex.org/W4386963671", "doi": "https://doi.org/10.48550/arxiv.2308.08155", "title": "AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation", "authors": ["Qingyun Wu", "Gagan Bansal"], "year": 2023, "venue": "arXiv", "cited_by": 412, "abstract": "AutoGen is an open-source framework that allows developers to build LLM applications...", "oa_pdf_url": "https://arxiv.org/pdf/2308.08155"}
```

## fetch_paper.py

```sh
python3 scripts/fetch_paper.py fetch --url https://arxiv.org/pdf/2308.08155 --out papers/autogen.pdf
python3 scripts/fetch_paper.py resolve --doi 10.1234/example [--fetch --out papers/x.pdf]
python3 scripts/fetch_paper.py resolve --id <record-id> --project <slug> --fetch
```

- `fetch` (also the default when invoked with bare `--url`/`--out`): downloads with an honest UA header, follows redirects, requires HTTP 200 and >10KB, creates parent dirs, prints `saved <path> (<n> bytes)`. Nonzero exit + stderr message otherwise. Only pass open-access URLs.
- `resolve`: OA-first cascade. Tries in order: **OpenAlex** (`best_oa_location.pdf_url`, else `open_access.oa_url`), **Unpaywall** (`best_oa_location.url_for_pdf`, else `url` — requires a contact email from `UNPAYWALL_EMAIL` or `OPENALEX_MAILTO`; unset means the step is SKIPPED with a stderr notice, never a fake address), **arXiv** (id detected in the DOI/URL), **local corpus** (`RESEARCH_CORPUS_DIR`, matched by DOI then normalized title), and **web search LAST** — which only returns a `candidate_url` (a scholar search page) for human review, never downloading from an arbitrary host. Output is one JSON object with `resolved`, `oa_source` (which step won), `oa_status` (gold/green/hybrid/bronze/closed as reported by OpenAlex/Unpaywall), `pdf_url`/`pdf_path`, and a `tried` trail. With `--id` the outcome is written back to the record in `review.db` (`fulltext_sought` -> `fulltext_retrieved`/`fulltext_not_retrieved`, plus `pdf_path`/`oa_source`/`oa_status`); already-retrieved records short-circuit, so re-runs are idempotent. `--fetch` downloads the resolved URL (default out: `<project>/papers/<id>.pdf`); a failed download falls through to the next step.

## local_library.py

Local PDF corpus support — fully offline, no network. Records merge with arxiv/openalex candidates via the same dedupe recipe below.

```sh
python3 scripts/local_library.py scan --dir ~/Research/Papers [--max 10]
python3 scripts/local_library.py extract --path ~/Research/Papers/paper.pdf [--max-chars 200000]
```

- `scan --dir DIR [--max N]`: one JSON line per `*.pdf` in DIR (non-recursive, sorted by filename). Schema: `{"source":"local", "id":<filename slug>, "path", "title", "authors", "year", "doi", "abstract", "pages"}`. Title prefers PDF metadata `/Title` when it looks like a real title, else the first plausible title line of page 1, else the de-slugified filename. Abstract is the text between an `Abstract` heading (or a structured `Background:`/`Objective:` start) and the next section heading, capped at 4000 chars. DOI is the first `10.\d{4,9}/...` match in the first 3 pages.
- `extract --path FILE [--max-chars N]`: full extracted text of one PDF (default cap 200000 chars) as `{"source":"local", "path", "chars", "truncated", "text"}` — use for full-text (`stage=fulltext`) screening.

**Extraction chain** — first that works: `pdftotext` (poppler) if on PATH, then PyMuPDF (`import fitz`) if importable, then a built-in stdlib fallback that reads the PDF `/Title` metadata and returns an empty abstract. Optional tools are detected, never required. A scan NEVER crashes on a bad PDF: each file gets a 60s subprocess timeout, and an unparseable file still emits its record with whatever fields resolved plus an `"extract_error"` field.

## refs_io.py

Import reference exports from databases the harness cannot query (PubMed, Embase, Scopus, ...); export records for Covidence/Zotero/EndNote. No network.

```sh
python3 scripts/refs_io.py import --path refs.ris            # also .bib, .csv
python3 scripts/refs_io.py export --format ris --records recs.jsonl --out out.ris
python3 scripts/refs_io.py export --format bib --from-graph --out out.bib   # from the paper graph ($PAPER_GRAPH_DB or --db)
```

- `import` emits the shared record shape: `{"source":"import", "id", "doi", "title", "authors":[...], "year", "venue", "abstract", "url"}` — `id` is the normalized DOI when present, else a title slug. Format from extension, else content sniffing. Handles RIS tags TY/TI/T1/AU/PY/JO/JF/T2/DO/AB/N2/UR, BibTeX entry types with nested-brace values, and CSV with aliased headers. A malformed entry NEVER crashes the run: it is skipped with a stderr note and a final `refs_io: imported N, skipped M` summary.
- `export` reads JSON-line records from `--records`/stdin or `--from-graph`, writes RIS or BibTeX, prints `{"exported", "format", "records"}`.


## review.py

Per-project PRISMA-ScR review store: `<project>/review.db` (SQLite). One row per record with the explicit state machine `identified -> duplicate | screened_excluded | screened_included -> fulltext_sought -> fulltext_retrieved | fulltext_not_retrieved -> included | fulltext_excluded`, plus a `history` table timestamping every transition — PRISMA counts are derived, never hand-typed. `--project` takes a slug under `~/.research-harness/projects/` or a directory; default from `RESEARCH_PROJECT_DIR`, else the active-project file.

```sh
python3 scripts/review.py --project SLUG import --path refs.ris --database PubMed   # also .bib/.csv/.jsonl
python3 scripts/review.py --project SLUG dedupe
python3 scripts/review.py --project SLUG next --stage ta --n 10
python3 scripts/review.py --project SLUG verdict --id X --stage ta --verdict exclude --rationale "Population: ..." --reason "wrong population" --confidence HIGH
python3 scripts/review.py --project SLUG set-state --id X --state fulltext_retrieved --pdf-path p.pdf --oa-source openalex --oa-status gold
python3 scripts/review.py --project SLUG get --id X
python3 scripts/review.py --project SLUG list --state included
python3 scripts/review.py --project SLUG stats
```

- `import` reuses the `refs_io` parsers (or reads shared-shape JSONL); rows land in state `identified` with the source database recorded (PRISMA needs per-source counts). Idempotent: the unique key is (source_db, DOI-or-normalized-title), so re-importing a file adds nothing. The same paper from a DIFFERENT database imports as a new row on purpose — that is what `dedupe` counts.
- `dedupe` matches by normalized DOI, then normalized title; losers become `duplicate` with `duplicate_of` pointing at the survivor, and the survivor inherits missing doi/url/abstract/pdf. Screened records are never demoted. Prints one JSON merge line each; idempotent.
- `verdict` records a screening decision and moves the state. Stage `ta`: include/exclude/maybe (`maybe` leaves the state unchanged so a human can resolve it). Stage `ft`: **binary** — `maybe` exits 1 per SCREENING.md; a verdict straight from `screened_included` records the implied `fulltext_sought`/`fulltext_retrieved` hops in history. `--reason` is the primary exclusion reason used in PRISMA reason breakdowns. `--confidence` takes the SCREENING.md labels HIGH | MEDIUM | LOW (case-insensitive; stored uppercase); a legacy 0.0-1.0 float is accepted and mapped to a label (>=0.8 HIGH, >=0.5 MEDIUM, else LOW).
- `next` prints the next unscreened records as JSON lines (`ta`: identified without a verdict; `ft`: screened-in/retrieved without one) so an agent can walk the queue resumably.
- `set-state` is the retrieval bookkeeping entry point (validates the state machine; also sets `--pdf-path/--oa-status/--oa-source/--reason`). `stats` prints all state/source/reason counts as one JSON object.

## prisma_scr.py

PRISMA-ScR flow diagram derived from `review.db` — every count computed from record states, so the arithmetic reconciles by construction.

```sh
python3 scripts/prisma_scr.py --project SLUG --format text      # box-drawn, for the terminal (default)
python3 scripts/prisma_scr.py --project SLUG --format mermaid   # fenced flowchart for manuscripts/GitHub
python3 scripts/prisma_scr.py --project SLUG --format svg --out prisma.svg   # standalone PRISMA-ScR 2018 layout
python3 scripts/prisma_scr.py --project SLUG --format html --out prisma.html
```

Four stages (Identification / Screening / Eligibility / Included) with per-source identified counts and exclusion-reason breakdowns in the side boxes; pending records (unscreened, retrieval in flight) surface as explicit `NOTE:` lines and an arithmetic footer shows the full derivation. Exits 1 with a pointer to `prisma.py` when the project has no `review.db`.

## prisma.py (legacy manual ledger)

Manual PRISMA count ledger per project: maintains `<project>/prisma.json` (`--project DIR`, else `RESEARCH_PROJECT_DIR`, else cwd). Use it only when there is no `review.db` (counts from databases the harness never saw as records); otherwise prefer the derived `prisma_scr.py`.

```sh
python3 scripts/prisma.py --project DIR identify --database pubmed --count 120
python3 scripts/prisma.py --project DIR dedupe --records all.jsonl > deduped.jsonl   # or: dedupe --removed N
python3 scripts/prisma.py --project DIR exclude --reason "wrong population" --count 100
python3 scripts/prisma.py --project DIR include --count 12
python3 scripts/prisma.py --project DIR show
```

- `dedupe --records` drops duplicates by normalized DOI, then normalized title (lowercase, non-alphanumerics stripped), prints the kept records, and sets `duplicates_removed`.
- `show` prints the PRISMA flow block (identified per database, duplicates removed, screened, excluded per reason, included) with derived arithmetic, a `WARNING` line when `included + excluded != screened`, and one machine-readable JSON summary line.
- Every mutating subcommand rewrites `prisma.json` and echoes it as one JSON line.

## Rate limiting & retries

All network calls share `scripts/_http.py`: up to 4 attempts on HTTP 429/500/502/503/504 and on timeouts, exponential backoff 3s/9s/27s (capped 60s), honoring a numeric `Retry-After` header. Retry notices go to stderr; stdout stays pure JSON lines. `arxiv_search.py` additionally enforces >=3s between arXiv requests in one process (arXiv's guidance is ~1 request per 3s).

Set `OPENALEX_MAILTO=you@example.org` to join OpenAlex's polite pool (appends `mailto:` to the User-Agent). Unset means no mailto is sent. Unpaywall requires a contact email (`UNPAYWALL_EMAIL`, else `OPENALEX_MAILTO`); when neither is set, `fetch_paper.py resolve` skips that step with a stderr notice instead of sending a fake address.

## Failure modes

- HTTP failure (network down, rate limit, API 5xx): retried automatically as above; after exhausting retries the script exits 1 with a stderr message naming the status code. Note the outage and continue with the other source.
- Empty result set: valid — the query matched nothing; broaden the query.
- fetch_paper "response too small": the URL served an HTML landing page, not a PDF; skip it.

## Dedupe recipe

Records from different sources overlap (including local PDFs of papers also on arXiv/OpenAlex). Normalize each title — lowercase, strip all non-alphanumeric characters — and treat records with equal normalized titles as duplicates. Keep one record per title, preferring the one with a DOI (usually the OpenAlex record); merge in the arXiv `pdf_url` if the kept record lacks an OA URL, and carry over a local record's `path` so full text stays reachable offline.
