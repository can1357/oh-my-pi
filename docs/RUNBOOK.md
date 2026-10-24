# Testing Runbook

How to test-drive research-harness end to end on a real scoping review, in one sitting, and know whether each step actually worked.

Everything below was executed on **2026-09-19** against a throwaway copy of a real 50-record PubMed export and a 43-PDF folder. The numbers quoted as "what you should see" are the numbers that run produced. Where a step was exercised through the underlying script rather than through the chat command, the text says so.

**What you need**

- A terminal, and the harness installed (`bash setup.sh` below does that).
- A reference export from a database search — this runbook uses a PubMed CSV export with 50 records.
- Optionally, a folder of PDFs you already collected.

---

## Part 0 — Environment gates (5 minutes)

Do these three in order. If one fails, stop and fix it; the later parts assume a green environment.

### Step 0.1 — Install / repair the harness

Type:

```bash
cd ~/Projects/research-harness
bash setup.sh
```

You should see a short "research-harness is wired" block listing the plugin, 4 agents, 13 prompts, the state directory, your corpus folder, the config file, the brand name, and the launcher:

```text
research-harness is wired:
  plugin   research-harness-tools registered with omp
  agents   librarian scholar screener synthesizer -> ~/.omp/agent/agents/
  prompts  /databases /dedupe /export /find /fulltext /graph /import /litreview /prisma /review /scope /screen /searchstring -> ~/.omp/agent/prompts/
  state    ~/.research-harness (projects/, papers.db)
  corpus   ~/Research/Papers (43 PDFs, read-only)
  config   ~/.research-harness/config.env
  brand    Research Harness (RESEARCHHARNESS_BRAND_NAME in config.env)
  launcher research -> ~/Projects/research-harness/bin/research
```

**If you don't see 13 prompts**, the install is partial — run the command again and read the error. `setup.sh` is safe to re-run: it never overwrites your own agent files, and it keeps the settings it manages. It does **not** keep anything else you put in `config.env`, including a changed brand name — see the Jev subsection in Part 1 for what that costs you.

### Step 0.2 — Health check

Type:

```bash
bash bin/research doctor
```

No line may start with `FAIL`, and the last line must be `status: ready`:

```text
research doctor
  ok    omp omp/18.1.19 at ~/.local/bin/omp
  ok    plugin research-harness-tools installed
  ok    extension research-mode (/help guide + statusline)
  ok    agent scholar
  ok    agent screener
  ok    agent synthesizer
  ok    agent librarian
  ok    prompts (13 commands installed)
  ok    mode system prompt ~/Projects/research-harness/research/mode/system.md
  ok    config ~/.research-harness/config.env
  ok    brand "Research Harness", logo ok, tips ok
  warn  Jev first-pass OFF (optional - set TYPESAFE_API_KEY to enable)
  ok    corpus ~/Research/Papers (43 PDFs)
  ok    paper graph ~/.research-harness/papers.db (0 papers, 0 edges)
  ok    projects 1 under ~/.research-harness/projects (active: ...)
status: ready — run 'research' to start
        type /help in the TUI to see every command
```

**A `FAIL` line means the fix is almost always `bash setup.sh`.** A `warn` about the corpus, the paper graph or the Jev first pass is fine — it means you haven't set a PDF folder, the graph file doesn't exist yet (it is created the first time you file a paper), or you haven't opted into the optional first pass (Part 1, after Step 4).

### Step 0.3 — Run the test suite

Type:

```bash
bash research/tests/run.sh
```

Last three lines should be:

```text
Ran 109 tests in 1.129s

OK (skipped=1)
```

It takes about a second. **Any `FAIL`/`ERROR` here means the scripts themselves are broken** — do not start a review on top of that; report it.

---

## Part 0.5 — See what you can type

Open the harness (`research`) and type `/help`. It prints the capability guide: one line on
what this workspace is, the three ways to start, then every command with what it does and when
you would use it.

```text
Your research workspace
...
Where to start

  Starting fresh, with only a question         type  /scope
  You already exported records from a search   type  /import
  You just want one quick end-to-end pass      type  /litreview

Everything you can type

  command        what it does                                              when you'd use it
  -------------  --------------------------------------------------------  ----------------------------------
  /scope         Turns a fuzzy question into a written scope with the       First step of a new review
                 inclusion and exclusion rules you will screen against
  /databases     Recommends which databases to search and what each one     Before you run any search
                 misses
  ...
```

The bar at the bottom of the screen carries the same invitation plus where you are:

```text
active: multi-agent-llm-clinical-decision-support · 0/50 screened · type /help for commands
```

`0/50` is "records with a title/abstract verdict / records imported" — it moves as you screen,
and is read read-only from the project's `review.db`. With no active project the bar reads
`type /help to see what this harness can do` instead. Both lines above were observed on
2026-09-19: the guide by typing `/help` in the TUI, the no-project hint by hiding
`~/.research-harness/active-project` for one run.

### Welcome-screen branding

The banner at the top of the session is branded for this harness, not for omp: `Research Harness`
sits beside the block mark with the version under it, the mark is a stack of papers, and the tips are about
`/find`, `/import` and `/screen` instead of coding-agent jokes.

Three environment variables drive it, all read by `packages/utils/src/branding.ts` at render
time. `bin/research` exports them for you:

| Variable | Meaning | Unset |
|---|---|---|
| `RESEARCHHARNESS_BRAND_NAME` | Name beside the mark | Stock `omp` wordmark |
| `RESEARCHHARNESS_BRAND_LOGO` | Path to a logo file, one row per line | Stock omp mark |
| `RESEARCHHARNESS_BRAND_TIPS` | Path to a tips file, one tip per line | Stock omp tips |

To change the mark or the tips, edit `research/branding/logo.txt` (leading and trailing spaces
are significant - every row must be the same width) or `research/branding/tips.txt` (one tip
per line, blank lines ignored) and restart. A missing or unreadable file is not an error: that
surface silently falls back to stock omp. `research doctor` prints
`brand "Research Harness", logo ok, tips ok` when both files resolve and a `warn` when either
is missing.

To change the name, edit the `RESEARCHHARNESS_BRAND_NAME="Research Harness"` line that
`setup.sh` adds to `~/.research-harness/config.env` (with no such line, `bin/research` still
uses `Research Harness`). **Re-running `bash setup.sh` puts the default name back**: step 6
rewrites `config.env` from scratch (see the Jev subsection in Part 1), so re-apply a custom
name after every setup run.

The brand lives in the fork's source, so the launcher runs the fork: `bin/research` prefers
`packages/coding-agent/scripts/omp` (the dev wrapper, which runs `packages/coding-agent/src/cli.ts`
through `bun`) whenever `bun` is on your PATH and the repo's dependencies are installed
(`node_modules/` at the repo root); otherwise it runs the `omp` on your PATH. Set
`RESEARCH_HARNESS_OMP=/path/to/omp` to force a specific binary. The wrapper runs this
checkout's omp version, which can differ from the installed `omp` that `research doctor`
reports on its first line. **An installed compiled `omp` shows the stock screen until it is
rebuilt from this fork** - that is expected, not a fault.

---

## Part 1 — The worked pass on a real review

Open the harness:

```bash
research
```

You get the Research Harness welcome panel (model name on the left, `/` for commands on the right) and an empty prompt line. Everything below is typed at that prompt. You can also type plain sentences — it is a conversation, the slash commands are just shortcuts.

Where a step below shows a `python3 .../review.py ...` line, that is the command the assistant runs for you. You never have to type it; it is shown so you can recognise it in the transcript and check it yourself later. The outputs quoted as "what you should see" are those scripts' real outputs — in the chat you see the same lines wrapped in the assistant's summary.

### Step 1 — Import your database export

Type:

```text
/import ~/Research/csv-multi-agen-set.csv from pubmed
```

You should see one JSON summary line per file:

```text
{"source_db": "pubmed", "added": 50, "already_present": 0, "skipped": 0}
```

- `added` should equal the number of records in your export (here: 50 rows + 1 header line = a 51-line file).
- `skipped` should be 0. A skipped row is a row with no title.
- Run it twice and the second run reports `"added": 0, "already_present": 50`. **Imports are idempotent — re-importing never duplicates.**

**What failure looks like:** `added: 0, skipped: 50` means the file format wasn't recognised. Only `.ris`, `.bib`, `.csv` and `.jsonl` are understood. PubMed's *Citation manager* export (`.nbib`) is **not** — see Known issues.

### Step 2 — Deduplicate

Type:

```text
/dedupe
```

Expected output on a single-database export:

```text
review: 0 duplicate(s) marked
```

**Zero is the correct answer here** — one PubMed export cannot contain two copies of the same record. Duplicates appear once you import a second database. Each merge prints one line naming the loser, the survivor, and whether it matched on `doi` or `title`; the survivor keeps the richer metadata.

### Step 3 — Fill in the missing abstracts (important for a PubMed CSV)

Check what actually landed. Type:

```text
Show me record 1 from the store
```

In the 2026-09-19 run, all 50 records had a title, 48 had a DOI, 50 had a year — and **0 had an abstract and 0 had a journal name.** PubMed's CSV export simply has no `Abstract` column, and its `Journal/Book` column is not one the importer recognises (see Known issues).

This matters because the screening rule is **"no abstract ⇒ exclude"**. Screening a CSV import as-is would exclude all 50 records for the wrong reason.

Fix it by searching the machine-queryable sources for the same papers, which brings abstracts with them:

```text
/find
```

`/find` searches OpenAlex, arXiv and your local PDF folder for your scoped question and imports each source separately. Then re-run:

> **Measured 2026-09-19: bare `/find` did not finish.** On a fresh 50-record project it ran **25 minutes and wrote nothing** — no records, no `records/found-*.jsonl`, no output at all — before it was killed. The step spawns the `scholar` agent with no candidate cap (`research/prompts/find.md` step 2), and the underlying scripts are not the bottleneck: `openalex_search.py` and `arxiv_search.py` each answered the same query in about a second when run directly. If you only need the abstracts your CSV is missing, ask for that instead and bound it — *"can you look up the first five on OpenAlex and pull their abstracts in?"* returned in **39 s** with **4 of 5** backfilled (the fifth, a Nature Medicine RCT, has no `abstract_inverted_index` in OpenAlex at all). `find.md` says a cap in the argument is honoured, so `/find max 20` should bound the candidate search — that was not exercised here.

```text
/dedupe
```

`/dedupe` matches the new records against your PubMed rows by DOI (then by title) and **carries the abstract, DOI, URL and PDF path from the loser onto the survivor.** In pre-flight, looking up the first 10 PubMed titles in OpenAlex returned 9 with abstracts; after import + dedupe the store showed:

```text
{"total": 59, "by_state": {"identified": 50, "duplicate": 9, ...}, "by_source": {"openalex": 9, "pubmed": 50}}
```

— 9 duplicates marked (7 matched on DOI, 2 on title), and the 9 surviving records now carried the abstract, the journal name (`npj Digital Medicine`) and full author names instead of PubMed initials. One of the two title matches was a medRxiv preprint merging with its published journal version: exactly what you want dedupe to do.

**What failure looks like:** if the survivors still have no abstract, the merge didn't happen — check that the two rows really share a DOI (`/dedupe` is case-insensitive on DOI but exact on the normalised title).

### Step 4 — Screen a bounded batch

Type:

```text
/screen the first 10
```

The assistant pulls the unscreened queue 10 at a time, reads your criteria from the project's `scope.md`, and shows you a verdict table before writing anything. **This is a smoke pass, not the whole review** — `/screen` only ever returns records that have no verdict yet, so you can stop after one batch and resume days later with the same command.

Each verdict is persisted with a command of this shape:

```text
python3 .../review.py --project <slug> verdict --id <id> --stage ta \
  --verdict include|exclude|maybe --rationale "<evidence sentence>" \
  --confidence HIGH|MEDIUM|LOW [--reason "<first failed dimension>"]
```

Note `--confidence` takes a **label** (`HIGH`/`MEDIUM`/`LOW`), not a number.

Three real verdicts from the pre-flight run, using the multi-agent criteria:

```text
INCLUDE — "Enhancing diagnostic capability with multi-agents conversational large language models"
  Four doctor agents plus a supervisor agent hold a Multi-Agent Conversation modelled on
  multidisciplinary team discussion over 302 rare-disease cases; agents react to each other's output.
  Confidence: HIGH

EXCLUDE — "Human-AI collaboration in large language model-assisted brain MRI differential diagnosis"
  Concept: collaboration is between six radiology residents and one LLM-based search engine/chatbot;
  no second LLM agent whose reasoning is conditioned on another agent's output.
  Confidence: HIGH

EXCLUDE — "LLM-based multi-agent system for neuro-ophthalmic diagnosis and personalized treatment planning"
  Concept: an Information Collection Agent normalises inputs and a Diagnosis Agent ensembles multiple
  LLMs with uncertainty-aware fusion — a fixed-order role pipeline plus score aggregation; no agent
  revises in light of another agent's output.
  Confidence: HIGH
```

The third one is the test that matters. **A title containing "multi-agent" is not evidence.** A fixed-order pipeline, an ensemble vote, or one controller calling tools does not qualify — some agent must react to another agent's output. If the assistant includes a paper like that, the screening rules are not being applied and you should say so in the chat.

Where the abstract genuinely cannot settle it, the right verdict is `maybe` at title/abstract (rare) or `include` with `Confidence: MEDIUM` and a note that the full text must resolve it. Pre-flight used the latter for a paper whose abstract said only "emulating a collaborative diagnostic process".

Counts move as you go. After the first three verdicts above, the store read:

```text
"identified": 47, "screened_excluded": 2, "screened_included": 1
```

### Optional: a cheap first pass with Jev

Before the screener agent reads anything, you can have a decision-only model (TypeSafe's Jev)
look at the same queue and settle the obvious records. It does not write prose: it returns a
probability per criterion, and `jev_screen.py` decides only the two clear bands — include when
every criterion scores ≥ 0.90, exclude when the weakest scores ≤ 0.10. **Everything in between
is left untouched**, so it never shrinks what you or the screener agent see; it only removes
records nobody would have argued about. Each auto-verdict carries its probabilities in the
rationale (`[jev-1.13.0 p=0.04] exclude on criterion 'Context' (…)`) and goes through the same
`review.py verdict` command a human uses, so you can overturn any of them.

**It is off unless you turn it on, and off means nothing changes.** The key is read from the
`TYPESAFE_API_KEY` environment variable first, then from a `TYPESAFE_API_KEY="..."` line in
`~/.research-harness/config.env`; with neither, `research doctor` prints
`warn  Jev first-pass OFF (optional - set TYPESAFE_API_KEY to enable)` and stays `status: ready`,
the assistant does not mention the feature, and running the script yourself prints
`jev_screen: Jev first-pass OFF (no TYPESAFE_API_KEY)` and exits 0 without touching the store.
That was verified on 2026-09-19 on a scratch project: 3 records in, 3 records still `identified`,
no verdicts written.

To enable it, add one line to `~/.research-harness/config.env`:

```bash
TYPESAFE_API_KEY="your-key-here"
```

**Re-running `bash setup.sh` deletes that line.** Step 6 of the script rewrites `config.env` from
scratch with only the three settings it manages (plus the default brand line), so the key silently disappears and the first pass
goes quiet again. This is not specific to Jev — the same run drops `UNPAYWALL_EMAIL` and
`OPENALEX_MAILTO` too (both reproduced on 2026-09-19 against a scratch `HOME`), even though the
file's own header invites you to edit it freely. Re-add your lines after any setup run, or export
`TYPESAFE_API_KEY` from your shell profile instead, which the resolver checks first.

With a working key `doctor` lists the models it can see (`ok    Jev first-pass enabled (models: ...)`);
that branch was not exercised here — no real key was used. What was exercised is the other one:
`Jev key set but API unreachable (HTTPError) - first pass will skip`. **A bad key is worse than no
key today**: probed on 2026-09-19 with a deliberately invalid key, `jev_screen.py` did not skip —
it stopped on the first record with a `JevAuthError` traceback and exit 1 (nothing was written).
Fix or remove the key before screening; the screener agent still works either way.

Guidance on when this kind of model fits at all is in `research/skills/jev-decide/SKILL.md`. The
short version: calibrated over many calls is not the same as right on any one call, which is why
the bands are wide and the uncertain middle still reaches you.

### Step 5 — Get the full texts

Type:

```text
/fulltext
```

For each screened-in record the harness walks an open-access-only cascade — OpenAlex, then Unpaywall, then arXiv, then your local PDF folder, then (last) a web-search *candidate* it will not download without your approval. Outcomes are written back to the record.

Two real outcomes from pre-flight:

```text
{"resolved": true,  "oa_source": "openalex", "oa_status": "gold", "pdf_path": ".../papers/<id>.pdf"}
{"resolved": false, "oa_status": "closed", "candidate_url": "https://scholar.google.com/scholar?q=...",
 "needs_human_review": true,
 "tried": [{"step":"openalex","outcome":"no OA URL"},
           {"step":"unpaywall","outcome":"skipped: no contact email configured"},
           {"step":"arxiv","outcome":"miss"},{"step":"local","outcome":"miss"},
           {"step":"web_search","outcome":"candidate for human review"}]}
```

- `fulltext_not_retrieved` means **no legal open-access copy was found** — not that the paper is irrelevant. Those records stay in the review with a reason, and PRISMA counts them.
- The `skipped: no contact email configured` line is Unpaywall being skipped on purpose: their API requires a real contact address and the harness will never invent one. To enable it, put `UNPAYWALL_EMAIL="you@example.org"` in `~/.research-harness/config.env`.

**Always spot-check one downloaded file** — see Known issue 1. Ask:

```text
Check that the downloaded full texts are really PDFs
```

A good file reports `PDF document, version 1.4, 9 pages`. A bad one reports `HTML document text` and must be recorded as not obtained.

### Step 6 — PRISMA flow

Type:

```text
/prisma
```

You get the diagram derived from the store — every number computed from record states, never typed by hand:

```text
PRISMA-ScR flow — <project> (derived from review.db)

IDENTIFICATION
┌────────────────────────────────────────┐
│ Records identified (n=59)              │
│   openalex: 9                          │
│   pubmed: 50                           │
└────────────────────┬───────────────────┘
                     ├─▶ Duplicate records removed (n=9)
                     ▼
SCREENING
┌────────────────────────────────────────┐
│ Records screened (n=50)                │
└────────────────────┬───────────────────┘
                     ├─▶ Records excluded (n=3)
                     │     Concept: parallel independent LLMs, no inter-agent interaction: 1
                     │     Concept: human-LLM collaboration, not 2+ interacting LLM agents: 1
                     │     Concept: fixed-order role pipeline, no inter-agent feedback: 1
                     ▼
┌────────────────────────────────────────┐
│ Reports sought for retrieval (n=2)     │
└────────────────────┬───────────────────┘
                     ├─▶ Reports not retrieved (n=0)
                     ▼
ELIGIBILITY
┌────────────────────────────────────────┐
│ Reports assessed for eligibility (n=2) │
└────────────────────┬───────────────────┘
                     ├─▶ Reports excluded (n=1)
                     ▼
INCLUDED
┌────────────────────────────────────────┐
│ Studies included in review (n=1)       │
└────────────────────────────────────────┘

NOTE: awaiting title/abstract screening: 45

arithmetic: 59 - 9 duplicates = 50 screened; 50 - 3 excluded - 45 pending = 2 sought; 2 - 0 not retrieved = 2 assessed; 2 - 1 excluded = 1 included
```

**Read the `arithmetic:` line — it must balance.** It balances by construction, so if a number looks wrong the record is wrong, not the diagram: fix it with a verdict or a state change and re-run `/prisma`. Never edit the diagram. `NOTE:` lines are pending work, not errors. Ask for `mermaid`, `svg` or `html` when you need a manuscript figure.

### Step 7 — Synthesise

Type:

```text
/review
```

The synthesizer agent reads the included records (and their PDFs where retrieved) and writes `review-<slug>.md` into the project folder, then reports the path and how many citations it used. *Pre-flight exercised the inputs to this step (the included-record list and the PDF extraction), not the agent itself — with one included study the output is a paragraph, so run it after a real screening pass.*

### Step 8 — File the papers into the graph

Type:

```text
/graph add
```

Each included paper is added with its metadata, co-included papers are linked, and citation edges are pulled from OpenAlex. Pre-flight result for one paper:

```text
{"paper": "care-ad-2025", "openalex_id": "...", "references": 47, "local_matches": 0, "edges_added": 0}
paper graph: 1 papers, 0 edges (no edges)
isolated: care-ad-2025
```

**`references: 47, edges_added: 0` is correct, not a failure**: an edge is only drawn when *both* ends are in your graph. Edges appear as the graph fills up. Then:

```text
/graph
```

prints the whole graph in the terminal, and `/graph image` shows it inline if your terminal supports Kitty graphics.

### Step 9 — Export

Type:

```text
/export included as ris
```

You get a file path and a count. Pre-flight round-tripped the export back through the importer and got the record back intact — 6 authors, DOI, year and journal preserved:

```text
{"exported": ".../export-included-<date>.ris", "format": "ris", "records": 1}
TY  - JOUR
TI  - CARE-AD: a multi-agent large language model framework for Alzheimer's disease prediction ...
AU  - Rumeng Li
...
ER  -
```

This file imports directly into Zotero or EndNote. Exporting is optional — the harness screens and produces the PRISMA diagram itself.

---

## Part 2 — Assertion checklist

Measured 2026-09-19 on a 50-record PubMed CSV and a 43-PDF folder.

| Checkpoint | Expected | What a different result means |
|---|---|---|
| `bash bin/research doctor` | no `FAIL` line, `status: ready` (the Jev line is a `warn` until you opt in) | a `FAIL` line → re-run `bash setup.sh` |
| `bash research/tests/run.sh` | `Ran 109 tests ... OK (skipped=1)`, ~1 s | the scripts are broken; stop and report |
| `/import` of the 50-record CSV | `added: 50, already_present: 0, skipped: 0` | `skipped > 0` → rows without a title; `added: 0` → format not recognised |
| Re-run the same `/import` | `added: 0, already_present: 50` | duplicates created → the store is not idempotent; report it |
| Field completeness after CSV import | 50 titles, 48 DOIs, 50 years, **0 abstracts, 0 journals** | more abstracts is better (a richer export); fewer titles means a parsing problem |
| Author parsing | 3+ author rows split correctly (14, 11, 11 authors on the first three records) | 2-author rows are stored as one string — see Known issue 3 |
| `/dedupe` on one database | `0 duplicate(s) marked` | non-zero on a single export → investigate before trusting the counts |
| `/dedupe` after adding OpenAlex records | duplicates marked, survivors gain abstracts | survivors still empty → the merge didn't run |
| Corpus scan of the PDF folder | 43 records from 43 files in ~2.7 s; 43 titles, 42 abstracts, 35 DOIs, 1 unreadable | a crash, or 0 records, is a bug; 1 unreadable is the known-bad file below |
| `/prisma` | the `arithmetic:` line balances | it cannot fail to balance; if a count is wrong, the record is wrong |
| `/export` → re-import | same title, authors, DOI, year, journal | lost fields → an export bug, report it |
| Paper graph after `/graph add` | `papers` count grows; `edges` stay 0 until both ends are filed | nothing added → check the graph path |

---

## Part 3 — Starting a brand-new review

If you're not importing an existing search, start at the top:

1. **`/scope`** — give it the question in plain words:

   ```text
   /scope Do LLM multi-agent systems improve clinical decision-making compared with single-model LLMs?
   ```

   It creates a project folder, restates the question as **PCC** (Population, Concept, Context) — or PICO when you're comparing an intervention against a comparator — and writes an explicit include/exclude table to `scope.md`. Read that table carefully: everything downstream is judged against it. Ask it to tighten any row that's vague; a criterion you can't apply to an abstract is a criterion that will produce inconsistent verdicts.

2. **`/databases`** — ask where to search:

   ```text
   /databases
   ```

   You get a table of databases with why-this-question, coverage gaps, access and syntax family. **No single database is sufficient**: a defensible set is 2–3 core databases plus one preprint or grey-literature source. The plan is saved under the project's `searches/`.

3. **`/searchstring`** — get paste-ready strings:

   ```text
   /searchstring
   ```

   One block per database, in that database's own syntax (MeSH for PubMed, exploded Emtree for Embase, `TITLE-ABS-KEY()` for Scopus, and so on). Each string is recorded with its date and a `hits: pending` line.

4. **Run the searches yourself.** The harness never logs into or scrapes a paywalled database — PubMed, Embase, Scopus, Web of Science, CINAHL, PsycINFO, Cochrane, IEEE Xplore, ACM DL. You paste the string into the database, report the hit count back to the chat, and export the results as RIS or CSV. Only arXiv, OpenAlex and your local PDF folder can be queried directly, with `/find`.

5. **`/import`** each export, then continue at Part 1 Step 2.

---

## Known issues found during this test run (2026-09-19)

These are real, reproduced defects. They are recorded here, not fixed here.

**1. A publisher landing page can be saved as a PDF and counted as retrieved.** When OpenAlex has no direct PDF link for a record, the cascade falls back to the DOI landing page and downloads that HTML as `<id>.pdf`. The only guard is a 10 KB size floor, and a 400 KB HTML page passes it. The record is then marked `fulltext_retrieved` with `oa_status: gold`, so the PRISMA diagram counts a full text you don't have.

```bash
. ~/.research-harness/config.env
python3 "$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/fetch_paper.py" \
  resolve --doi 10.1038/s41746-025-01550-0 --fetch --out /tmp/landing-page-probe.pdf
file /tmp/landing-page-probe.pdf
```

Observed: `"resolved": true, "oa_source": "openalex", "oa_status": "gold"` and `fetched 403559 bytes`, but `file` reports `HTML document text`. Trying to read it fails with `May not be a PDF file`.
*Workaround:* after `/fulltext`, check the downloaded files and, for any HTML one, record the record as excluded at full-text stage with the reason "full text not obtained". Note that the store has no edge from `fulltext_retrieved` back to `fulltext_not_retrieved`, so a wrongly-recorded retrieval can only move on to `included` or `fulltext_excluded`.

**2. The PubMed CSV `Journal/Book` column is not mapped, so every imported record has an empty journal.** The importer recognises `journal`, `venue`, `source title` and `publication`, but not `Journal/Book`. All 50 records imported with `venue: null`; the journal name only appeared after the OpenAlex merge.

```bash
. ~/.research-harness/config.env
python3 "$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/refs_io.py" \
  import --path ~/Research/csv-multi-agen-set.csv 2>/dev/null | head -1 | \
  python3 -c "import sys,json; r=json.loads(sys.stdin.readline()); print('venue:', r['venue'], '| abstract chars:', len(r['abstract']), '| authors:', len(r['authors']))"
```

Observed: `venue: None | abstract chars: 0 | authors: 14`.

**3. Two-author PubMed rows are stored as a single author.** The importer splits a comma-separated author list only when it contains more than one comma, to protect `"Surname, Given"` from being torn in half. A two-author PubMed list has exactly one comma, so it is kept whole. Three records in this export are affected.

```bash
. ~/.research-harness/config.env
python3 "$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/refs_io.py" \
  import --path ~/Research/csv-multi-agen-set.csv 2>/dev/null | \
  python3 -c "
import sys, json
for line in sys.stdin:
    r = json.loads(line)
    if r['doi'] == '10.12788/fp.0589': print(len(r['authors']), 'author(s):', r['authors'])"
```

Observed: `1 author(s): ['Borkowski AA, Ben-Ari A.']` — two people in one string. Records with 3+ authors split correctly.

**4. PubMed's "Citation manager" export (`.nbib`) is not supported.** It is not RIS, so the importer falls through to its CSV reader and drops every line — a 16-line sample file gave `imported 0, skipped 16` — and still exits successfully, so a script can't tell it failed. Export as **CSV** instead, or convert to RIS in Zotero first.

**5. The corpus scanner only reads the top level of a folder.** The PDF folder used here holds 103 PDFs, 60 of them in sub-folders; both `doctor` and the scanner see only the 43 at the top level. Point the scan at each sub-folder separately if you keep PDFs in a tree.

**6. There is no abstract in a PubMed CSV export** (issue 2's sibling, and the one most likely to bite you). Combined with the "no abstract ⇒ exclude" rule, a CSV-only import would exclude everything. Do Part 1 Step 3 before screening.

---

## Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| `doctor` reports a missing prompt or agent | the install drifted | `bash setup.sh`, then `doctor` again |
| `_http: HTTP Error 429 ...; retry 1/3 in 3s` | arXiv/OpenAlex is rate-limiting you | nothing — the backoff is 3s, 9s, 27s and it honours `Retry-After`. **Don't re-run the command while it's waiting**; that's what got you throttled |
| `skipping Unpaywall — set UNPAYWALL_EMAIL` | Unpaywall needs a real contact address | add `UNPAYWALL_EMAIL="you@example.org"` to `~/.research-harness/config.env`, or accept that one cascade step is skipped |
| `"needs_human_review": true` with a `candidate_url` | no open-access copy was found | open the link yourself; if you find a legitimate OA copy, approve it and it will be fetched and recorded |
| One PDF reports `extract_error` in a scan | the file isn't a real PDF (here: a saved 404 page with a `.pdf` name) | ignore it or delete it from your own folder; the scan does not crash and the other files are unaffected |
| A record was excluded for "no abstract" | the record genuinely has no abstract in the store | that's the rule — but first make sure it isn't Known issue 6; fill the abstracts, then re-screen |
| PRISMA numbers look wrong | a record is in the wrong state | fix the record (a verdict or a state change), never the diagram; re-run `/prisma` |
| You want to start the test over | state lives in `~/.research-harness/` | delete the project folder `~/.research-harness/projects/<slug>/` — the review store, the fetched PDFs and the searches all live inside it. The paper graph is separate (`~/.research-harness/papers.db`) |
| You want the review isolated from your main graph | per-project graph | tell the chat "keep this review's graph separate" — it prefixes the graph commands with a project-local database |

---

## Appendix — scripted checks

For a smoke test without the chat interface. Everything here writes only to `/tmp` and reads your review artifacts read-only.

```bash
. ~/.research-harness/config.env
SCRIPTS="$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts"
SCRATCH=/tmp/harness-smoke
mkdir -p "$SCRATCH"
python3 "$SCRIPTS/review.py" --project "$SCRATCH" import --path ~/Research/csv-multi-agen-set.csv --database pubmed
python3 "$SCRIPTS/review.py" --project "$SCRATCH" dedupe
python3 "$SCRIPTS/review.py" --project "$SCRATCH" stats
python3 "$SCRIPTS/prisma_scr.py" --project "$SCRATCH" --format text
```

First run prints `{"source_db": "pubmed", "added": 50, ...}`; every later run prints `"added": 0, "already_present": 50` and the same PRISMA diagram. Delete `/tmp/harness-smoke` to start clean.

Corpus scan, with a one-line summary instead of 43 JSON lines:

```bash
. ~/.research-harness/config.env
python3 "$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/local_library.py" \
  scan --dir ~/Research/Papers > /tmp/corpus-scan.jsonl
python3 -c "
import json
rows = [json.loads(l) for l in open('/tmp/corpus-scan.jsonl')]
print(len(rows), 'records;', sum(1 for r in rows if r.get('title')), 'titles;',
      sum(1 for r in rows if r.get('abstract')), 'abstracts;',
      sum(1 for r in rows if r.get('doi')), 'DOIs;',
      sum(1 for r in rows if r.get('extract_error')), 'unreadable')"
```

Expected on 2026-09-19: `43 records; 43 titles; 42 abstracts; 35 DOIs; 1 unreadable`.

Retrieval cascade on a paywalled DOI — shows every step and why it was skipped or missed:

```bash
. ~/.research-harness/config.env
python3 "$RESEARCH_HARNESS_HOME/research/skills/literature-search/scripts/fetch_paper.py" \
  resolve --doi 10.1148/radiol.232255
```

Paper-graph counters (scratch graph, then your real one):

```bash
. ~/.research-harness/config.env
GRAPH="$RESEARCH_HARNESS_HOME/research/skills/paper-graph/scripts/paper_graph.py"
PAPER_GRAPH_DB=/tmp/harness-smoke/papers.db python3 "$GRAPH" stats
python3 "$GRAPH" stats
```

The chat interface also works non-interactively, which is useful to check that the research mode prompt and the slash commands are wired up without opening the TUI:

```bash
research -p --no-tools --no-session "/prisma Do not act. Reply with the single word READY if you received PRISMA flow instructions."
```

Expected output: `READY`. `--no-tools` guarantees it cannot touch your project. **Without `--no-tools`, a headless run acts on your active project** — so keep that flag for smoke tests.

The `/help` guide and the statusline hint are not visible in `-p` output (print mode has no
status bar and no notification surface), so check those two through the RPC surface instead —
it reports the same frames the TUI renders:

```bash
(sleep 3; printf '{"id":"1","type":"prompt","message":"/help"}\n'; sleep 5) \
  | research --mode rpc --no-session 2>/dev/null > /tmp/help-smoke.log
grep -c "Everything you can type" /tmp/help-smoke.log
grep -o '"statusKey":"research","statusText":"[^"]*"' /tmp/help-smoke.log
```

Expected on 2026-09-19: `1`, then one status line, e.g.
`"statusKey":"research","statusText":"active: <your-project> · 0/50 screened · type /help for commands"`.
A zero from the first grep means the extension did not load — run `bash bin/research doctor`.
