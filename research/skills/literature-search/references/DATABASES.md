# Database Selection and Search Syntax

Reference for translating a review question into per-database search strings. Covidence-style: pick databases by question type, write native syntax for each, record every executed search.

**Rule zero: no single database is sufficient for a systematic review.** Every database has indexing gaps, and single-source searches are a standard critical-appraisal failure (AMSTAR-2 item 4). A defensible review searches at least 2-3 databases matched to the question, plus a preprint/grey source where the field moves faster than journals.

**Automation boundary:** the harness machine-queries **arXiv and OpenAlex only** (see `scripts/`). Every other database below is searched manually — the harness writes the ready-to-paste string, the user runs it in the database's own interface and reports back hits/exports. The harness NEVER automates paywalled databases.

## Which databases a question makes mandatory

| Question type | Mandatory | Add when relevant |
|---|---|---|
| Any health/clinical topic | PubMed/MEDLINE | Scopus or WoS for cross-disciplinary reach |
| Drug, device, or pharmacovigilance | PubMed + Embase | CENTRAL if trials exist |
| Intervention effectiveness (RCTs) | PubMed + Embase + CENTRAL | CINAHL/PsycINFO by delivery setting |
| Nursing / allied health / midwifery | CINAHL + PubMed | Embase |
| Mental / behavioral health | PsycINFO + PubMed | CINAHL for nursing-delivered care |
| Computing / software / AI systems | IEEE Xplore + ACM DL + arXiv | Scopus for non-IEEE/ACM venues |
| Health + AI (e.g. LLMs in clinic) | PubMed + Embase + IEEE or Scopus + arXiv | CENTRAL if trials exist |
| Bibliometrics / citation chasing | Scopus or WoS | OpenAlex (free, automated) |

## PubMed / MEDLINE

- **Coverage:** biomedicine and life sciences; MEDLINE back to 1946 (older via OLDMEDLINE), plus PubMed Central and ahead-of-print records; ~37M citations; overwhelmingly journal articles, English-skewed but international.
- **Required when:** the question touches health, medicine, or clinical populations in any way. It is the default first database for every health-related review.
- **Known gaps:** conference papers (almost none), European and non-English pharma journals (Embase's strength), nursing/allied-health journals (CINAHL's strength), preprints (only some via PMC), engineering/CS venues.
- **Syntax:**
  - Controlled vocabulary: **MeSH**. `"Decision Support Systems, Clinical"[mh]` (or `[MeSH Terms]`) — **explodes automatically** (includes narrower terms); `[mh:noexp]` disables explosion; `[majr]` restricts to major topic. New concepts (e.g. LLMs pre-2024) may have no MeSH term yet — always pair MeSH with free text.
  - Field tags: `[tiab]` (title/abstract), `[ti]`, `[ab]`, `[au]`, `[pt]` (publication type), `[dp]` (date), `[la]`.
  - Truncation: `*` (needs >=4 characters before it; disables automatic term mapping; works at the end of a quoted phrase: `"decision support system*"[tiab]`). No single-character wildcard.
  - Proximity: **mostly none.** Since late 2022 there is one narrow form: `"clinical decision"[tiab:~3]` (quoted terms within N words, unordered) — only in `[tiab]`, `[ti]`, `[ad]`, and it cannot contain truncation. There is no general `NEAR`/`adj`.
  - Phrases: double quotes; quoting disables automatic term mapping (deliberate in systematic strings).
  - Boolean: `AND` / `OR` / `NOT` (uppercase), nested with parentheses.
- **Access:** free (NLM). Still pasted manually — the harness does not automate PubMed's interface or E-utilities.

## Embase

- **Coverage:** Elsevier; biomedicine with deep **drug, pharmacology, and medical-device** indexing; 1974+ (1947+ with Embase Classic); strong European and Asian journal coverage; **conference abstracts from 2009+**; includes MEDLINE records re-indexed with Emtree.
- **Required when:** drug or device interventions (pharmacovigilance searches in Embase are an EMA regulatory expectation), European-heavy evidence bases, and all Cochrane intervention reviews (MECIR requires MEDLINE + Embase + CENTRAL).
- **Known gaps:** paywalled; overlaps heavily with MEDLINE (unique value is the drug/device depth, conference abstracts, and European titles); nothing on computing venues.
- **Syntax (embase.com):**
  - Controlled vocabulary: **Emtree**. `'clinical decision support system'/exp` explodes; `/de` = the term alone, no explosion; `/mj` = major focus. Emtree is drug-richer and finer-grained than MeSH; terms differ (map each MeSH term, do not transliterate).
  - Field tags: suffix style — `'clinical decision support':ti,ab,kw` (title, abstract, author keywords). Also `:ti`, `:ab`, `:dn` (device name), `:tn` (trade name).
  - Truncation/wildcards: `*` = any number of characters, `?` = exactly one character, `$` = zero or one character. (On the **Ovid** platform, syntax differs: `$` is the truncation symbol, fields are `.ti,ab.`, explosion is `exp heading/`, proximity is `adj3` — do not mix the two dialects in one string.)
  - Proximity: `NEAR/n` (unordered, within n words), `NEXT/n` (ordered). Field-restrictable: `(agent* NEAR/3 collaborat*):ti,ab`.
  - Phrases: **single quotes** — `'large language model'`.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest.
- **Access:** paywalled (institutional). Manual paste only.

## Cochrane CENTRAL

- **Coverage:** the Cochrane Central Register of Controlled Trials — citations of **RCTs and quasi-RCTs** harvested from MEDLINE, Embase, ClinicalTrials.gov, WHO ICTRP, plus hand-searching; includes trial reports that exist only as conference abstracts or registry entries. Citations only, no full text.
- **Required when:** the review asks an **intervention-effectiveness question answered by trials**. For RCT reviews CENTRAL is the single highest-yield source and is mandatory for Cochrane reviews.
- **Known gaps:** trials only — useless for prognosis, diagnostic accuracy, qualitative, or methods questions; many records are sparse (registry stubs with no abstract); duplicates the trials subset of MEDLINE/Embase.
- **Syntax (Cochrane Library search manager):**
  - Controlled vocabulary: MeSH, borrowed from MEDLINE. `[mh "Decision Support Systems, Clinical"]` explodes; `[mh^ "..."]` = no explosion.
  - Field tags: suffix `:ti,ab,kw`.
  - Truncation/wildcards: `*` (any characters), `?` (single character). **Truncation does not work inside quoted phrases** — use `NEXT` chains instead: `(decision NEXT support NEXT system*)`.
  - Proximity: `NEAR/n` (unordered within n words; bare `NEAR` = NEAR/6), `NEXT` (adjacent, ordered).
  - Phrases: double quotes (no wildcards inside).
  - Boolean: `AND` / `OR` / `NOT`; numbered lines (`#1 AND #2`) are the convention.
- **Access:** the Cochrane Library search interface is free to search in most countries (national licenses vary). Manual paste.

## Scopus

- **Coverage:** Elsevier; multidisciplinary — science, engineering, medicine, social science; ~90M records, strongest from 1970+; journals, conference proceedings, book series; citation links for snowballing.
- **Required when:** the topic crosses disciplines (e.g. health + computing, health + policy), or you need forward/backward citation chasing at scale.
- **Known gaps:** **no native controlled vocabulary** (INDEXTERMS carries imported MeSH/Emtree but is not reliably navigable); thin pre-1970; arts/humanities weaker; paywalled.
- **Syntax:**
  - Controlled vocabulary: none native — free-text strings only.
  - Field tags: function style — `TITLE-ABS-KEY(...)`, `TITLE(...)`, `ABS(...)`, `AUTHKEY(...)`, `ALL(...)`.
  - Truncation/wildcards: `*` (zero or more characters), `?` (exactly one). Wildcards work inside double-quoted phrases.
  - Proximity: `W/n` (unordered, within n words), `PRE/n` (ordered, first term precedes within n).
  - Phrases: double quotes = "loose phrase" (stemming and wildcards apply); braces `{exact phrase}` = literal match, punctuation included, no wildcards.
  - Boolean: `AND` / `OR` / **`AND NOT`** (Scopus has no bare `NOT`; place `AND NOT` last to avoid surprises); parentheses nest.
- **Access:** paywalled. Manual paste.

## Web of Science (Core Collection)

- **Coverage:** Clarivate; SCIE (1900+), SSCI, AHCI, ESCI, plus Conference Proceedings Citation Index; journal-selective ("flagship" venues); the classic citation-index for bibliometrics.
- **Required when:** citation analysis/snowballing, multidisciplinary questions, physics/engineering journal coverage alongside Scopus.
- **Known gaps:** selective indexing skips niche and regional journals; **which sub-indexes you can search depends on your institution's subscription slice** — record the editions searched; no controlled vocabulary (Keywords Plus is algorithmic, not curated); paywalled.
- **Syntax:**
  - Controlled vocabulary: none.
  - Field tags: prefix style — `TS=` (topic: title + abstract + author keywords + Keywords Plus), `TI=`, `AB=`, `AK=`, `SO=` (source).
  - Truncation/wildcards: `*` (zero or more), `$` (zero or one — catches colour/color), `?` (exactly one). All three work inside quoted phrases.
  - Proximity: `NEAR/n` (unordered; bare `NEAR` = NEAR/15). No ordered proximity operator.
  - Phrases: double quotes. Hyphenated input (`multi-agent`) also matches the spaced and fused forms.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest inside the `TS=(...)` wrapper.
- **Access:** paywalled. Manual paste.

## IEEE Xplore

- **Coverage:** IEEE + IET; electrical engineering, computing, electronics; journals, magazines, **conference proceedings (the bulk of CS evidence)**, and standards; ~6M documents, legacy content to the 1870s.
- **Required when:** the question involves computing, software, networks, or engineered systems — for software-engineering and AI systematic reviews IEEE Xplore + ACM DL are the canonical pair.
- **Known gaps:** nothing biomedical or social-science; publisher-limited (misses Springer/Elsevier CS venues — pair with Scopus); command search caps complexity (**max 5 wildcards per query**).
- **Syntax (command search):**
  - Controlled vocabulary: IEEE Thesaurus / INSPEC controlled terms exist as `"Index Terms":` and `"INSPEC Controlled Terms":` fields, but most SR strings are free-text.
  - Field tags: quoted field name + colon, binding to the **single next term or quoted phrase** — `"Document Title":diagnosis`, `"Abstract":"decision support"`, `"Author Keywords":LLM`, `"All Metadata":...`. The tag must be repeated for every term (no field-wide grouping).
  - Truncation/wildcards: `*` only (multi-character, needs >=3 preceding characters, max 5 per query). No `?`.
  - Proximity: `NEAR/n` (unordered) and `ONEAR/n` (ordered) — command search only, and **cannot be combined with wildcards**.
  - Phrases: double quotes.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest.
- **Access:** paywalled (metadata browsable free; full search/export needs subscription). Manual paste.

## ACM Digital Library

- **Coverage:** ACM Full-Text Collection plus the **Guide to Computing Literature** (bibliographic records well beyond ACM's own venues); computing since the 1950s; conferences, journals, magazines, theses.
- **Required when:** software engineering, HCI, and computing questions — searched alongside IEEE Xplore; the Guide widens coverage to non-ACM computing venues.
- **Known gaps:** full text only for ACM-published items; the Guide is metadata-only with uneven abstracts; the search engine handles very long Boolean strings poorly (split long ORs into separate saved searches if the parser mangles one).
- **Syntax (advanced search / "edit query"):**
  - Controlled vocabulary: the ACM CCS classification exists for browsing but is not usable as a search-string vocabulary.
  - Field tags: function style with grouping — `Title:("large language model")`, `Abstract:(...)`, `Keyword:(...)`, `AllField:(...)`. Unlike IEEE, a whole parenthesised group binds to the field.
  - Truncation/wildcards: `*` (multi-character), `?` (single character) — unreliable inside quoted phrases; prefer spelled-out OR variants.
  - Proximity: **none documented** — compensate with quoted phrases plus OR'd variants.
  - Phrases: double quotes.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest.
- **Access:** paywalled (search/browse free; full text needs subscription). Manual paste.

## PsycINFO (APA)

- **Coverage:** psychology and behavioral science from 1887+; journals, books, chapters, dissertations; APA-curated.
- **Required when:** mental/behavioral health questions, psychological interventions or outcomes, human-factors and behavior-change components of a broader review.
- **Known gaps:** paywalled; thin on general biomedicine (pair with MEDLINE) and on computing venues; platform-dependent syntax is a common transcription-error source.
- **Syntax — platform-dependent; state the platform in the search record:**
  - Controlled vocabulary: APA **Thesaurus of Psychological Index Terms**. Ovid: `exp Decision Support Systems/` (explodes), trailing `/` = heading, `*Heading/` = major. EBSCOhost: `DE "Decision Support Systems"`.
  - Field tags: Ovid `.ti,ab.` / `.ti.` / `.ab.`; EBSCO `TI`, `AB`, `SU`.
  - Truncation/wildcards: Ovid `*` or `$` (multi-character), `#` (one character), `?` (zero or one). EBSCO `*` (multi), `?` (one), `#` (zero or one). Note Ovid and EBSCO **swap the meanings of `?` and `#`** — the classic cross-platform trap.
  - Proximity: Ovid `adjN` (unordered within N words: `agent* adj3 collaborat*`). EBSCO `Nn` (unordered) and `Wn` (ordered).
  - Phrases: double quotes on both platforms.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest.
- **Access:** paywalled. Manual paste.

## CINAHL (EBSCOhost)

- **Coverage:** nursing and allied health from 1937 (indexing depth from 1981); journals, dissertations, care sheets, standards of practice; strong on midwifery, physiotherapy, occupational therapy, nutrition.
- **Required when:** nursing, allied-health, midwifery, or rehabilitation questions — and any review where the intervention is delivered by nurses/allied professionals; MEDLINE alone demonstrably under-retrieves this literature.
- **Known gaps:** paywalled; narrow outside nursing/allied health; smaller than MEDLINE overall.
- **Syntax (EBSCOhost):**
  - Controlled vocabulary: **CINAHL Subject Headings** (MeSH-like but not identical). `MH "Decision Support Systems, Clinical"` = heading alone; `MH "Heading+"` (trailing `+`) = **explode**; `MM "..."` = major concept.
  - Field tags: `TI` (title), `AB` (abstract), `TX` (all text), `SU` (subject).
  - Truncation/wildcards: `*` (multi-character), `?` (exactly one character), `#` (zero or one character).
  - Proximity: `Nn` = within n words, any order (`agent* N3 collaborat*`); `Wn` = within n words, order as written.
  - Phrases: double quotes.
  - Boolean: `AND` / `OR` / `NOT`, parentheses nest.
- **Access:** paywalled. Manual paste.

## arXiv

- **Coverage:** preprints in physics, mathematics, CS, quantitative biology, statistics, economics; 1991+; the primary venue where ML/LLM work appears months-to-years before journals.
- **Required when:** any CS/ML/physics topic — for LLM questions specifically, omitting arXiv misses most of the current evidence. (Medicine's preprint analogue is medRxiv, not arXiv.)
- **Known gaps:** **not peer reviewed** — flag preprint status at appraisal; no controlled vocabulary; no clinical-trial or biomedical coverage; versions mutate (record the version id).
- **Syntax (export API, as used by `scripts/arxiv_search.py`):**
  - Controlled vocabulary: none. Category codes (`cs.CL`, `cs.MA`, `cs.AI`) are the only classification, via `cat:`.
  - Field prefixes: `ti:`, `abs:`, `au:`, `cat:`, `all:`.
  - Truncation/wildcards: **none.** Spell out every variant and OR them.
  - Proximity: **none.**
  - Phrases: double quotes.
  - Boolean: `AND` / `OR` / `ANDNOT` (one word), parentheses nest.
- **Access:** free and **machine-queryable — the harness runs this one itself** (with OpenAlex as the second automated source; OpenAlex is free-text relevance search, no field syntax to master).

## Syntax cheat sheet

| Database | Controlled vocab | Title/abstract tag | Truncation | Single char | Zero-or-one | Proximity (unordered / ordered) | Phrase |
|---|---|---|---|---|---|---|---|
| PubMed | MeSH `[mh]`, auto-explode, `[mh:noexp]` | `[tiab]` | `*` (>=4 chars) | — | — | `"a b"[tiab:~n]` only / — | `"..."` |
| Embase (embase.com) | Emtree `/exp`, `/de`, `/mj` | `:ti,ab,kw` | `*` | `?` | `$` | `NEAR/n` / `NEXT/n` | `'...'` |
| Cochrane CENTRAL | MeSH `[mh "..."]`, `[mh^ ...]` | `:ti,ab,kw` | `*` (not in quotes) | `?` | — | `NEAR/n` / `NEXT` | `"..."` |
| Scopus | none | `TITLE-ABS-KEY()` | `*` | `?` | — | `W/n` / `PRE/n` | `"loose"`, `{exact}` |
| Web of Science | none | `TS=` (topic) | `*` | `?` | `$` | `NEAR/n` / — | `"..."` |
| IEEE Xplore | IEEE Thesaurus/INSPEC fields | `"Document Title":`, `"Abstract":` | `*` (>=3 chars, max 5) | — | — | `NEAR/n` / `ONEAR/n` (no wildcards) | `"..."` |
| ACM DL | CCS (browse only) | `Title:()`, `Abstract:()` | `*` | `?` | — | none / none | `"..."` |
| PsycINFO (Ovid) | APA Thesaurus `exp .../` | `.ti,ab.` | `*` or `$` | `#` | `?` | `adjN` / — | `"..."` |
| CINAHL (EBSCO) | CINAHL Headings `MH "...+"` | `TI`, `AB` | `*` | `?` | `#` | `Nn` / `Wn` | `"..."` |
| arXiv | none (categories `cat:`) | `ti:`, `abs:` | — | — | — | none / none | `"..."` |

Boolean note: all ten support `AND`/`OR` with parentheses; Scopus alone spells negation `AND NOT`; arXiv spells it `ANDNOT`.

## Worked example: multi-agent LLM systems for clinical decision support

Three concept blocks, ANDed:

1. **LLM** — large language model(s), LLM(s), generative AI, GPT/ChatGPT, foundation model(s)
2. **Multi-agent** — multi-agent/multiagent, agentic, agent collaboration/orchestration
3. **Clinical decision support** — clinical decision support (system), CDSS, decision support system in clinical context

### PubMed

```
("large language model*"[tiab] OR LLM[tiab] OR LLMs[tiab] OR "generative artificial intelligence"[tiab] OR "generative AI"[tiab] OR GPT[tiab] OR ChatGPT[tiab] OR "foundation model*"[tiab])
AND
("multi-agent"[tiab] OR "multi agent"[tiab] OR multiagent[tiab] OR agentic[tiab] OR "agent collaboration"[tiab] OR "collaborative agents"[tiab] OR "agent orchestration"[tiab])
AND
("Decision Support Systems, Clinical"[mh] OR "clinical decision support"[tiab] OR CDSS[tiab] OR "decision support system*"[tiab])
```

- Block 3 pairs the exploding MeSH heading with free text; blocks 1-2 are free-text only because no MeSH terms exist yet for LLM/multi-agent concepts.
- No general proximity, so every agent-collaboration variant is a spelled-out quoted phrase.
- `*` at the end of a quoted phrase works in `[tiab]`; quoting deliberately disables automatic term mapping.

### Embase (embase.com)

```
('large language model*':ti,ab,kw OR llm:ti,ab,kw OR llms:ti,ab,kw OR 'generative artificial intelligence':ti,ab,kw OR 'generative ai':ti,ab,kw OR gpt:ti,ab,kw OR chatgpt:ti,ab,kw OR 'foundation model*':ti,ab,kw)
AND
('multi agent':ti,ab,kw OR multiagent:ti,ab,kw OR agentic:ti,ab,kw OR ((agent* NEAR/3 (collaborat* OR orchestrat*)):ti,ab,kw))
AND
('clinical decision support system'/exp OR 'clinical decision support':ti,ab,kw OR cdss:ti,ab,kw OR 'decision support system*':ti,ab,kw)
```

- Emtree (not MeSH): `'clinical decision support system'/exp` explodes the Emtree hierarchy; phrases take single quotes.
- `NEAR/3` replaces PubMed's phrase enumeration for the collaboration variants — one proximity clause covers "agents collaborating", "collaborative agents", "agent orchestration".
- Field restriction is a suffix (`:ti,ab,kw`) and can wrap a whole proximity clause.

### Cochrane CENTRAL

```
#1  [mh "Decision Support Systems, Clinical"]
#2  ("clinical decision support" OR CDSS OR (decision NEXT support NEXT system*)):ti,ab,kw
#3  ("large language model" OR (large NEXT language NEXT model*) OR LLM OR LLMs OR "generative AI" OR GPT OR ChatGPT):ti,ab,kw
#4  ("multi agent" OR multiagent OR agentic OR (agent* NEAR/3 (collaborat* OR orchestrat*))):ti,ab,kw
#5  #1 OR #2
#6  #3 AND #4 AND #5
```

- Same MeSH tree as PubMed but bracket syntax: `[mh "..."]`; numbered-line composition is the house style.
- Truncation cannot sit inside quotes here, hence `(large NEXT language NEXT model*)` and `(decision NEXT support NEXT system*)` instead of `"...model*"`.
- Both `NEAR/n` (unordered) and `NEXT` (ordered-adjacent) are available — richer than PubMed, same family as Embase.

### Scopus

```
TITLE-ABS-KEY(
  ("large language model*" OR llm OR llms OR "generative artificial intelligence" OR "generative ai" OR gpt OR chatgpt OR "foundation model*")
  AND ("multi agent" OR multiagent OR agentic OR (agent* W/3 (collaborat* OR orchestrat*)))
  AND ("clinical decision support" OR cdss OR "decision support system*" OR (clinic* W/3 "decision support"))
)
```

- No controlled vocabulary — everything is free text inside one `TITLE-ABS-KEY()` wrapper.
- Proximity is `W/n` (unordered; `PRE/n` when order matters), not `NEAR`.
- Double quotes are loose phrases and accept wildcards; braces `{...}` would force literal matching (not wanted here). Negation, if ever needed, is `AND NOT`.

### Web of Science (Core Collection)

```
TS=(
  ("large language model*" OR LLM OR LLMs OR "generative artificial intelligence" OR "generative AI" OR GPT OR ChatGPT OR "foundation model*")
  AND ("multi agent" OR multi-agent OR multiagent OR agentic OR (agent* NEAR/3 (collaborat* OR orchestrat*)))
  AND ("clinical decision support" OR CDSS OR "decision support system*" OR (clinic* NEAR/3 "decision support"))
)
```

- `TS=` is a prefix tag spanning title, abstract, author keywords, and Keywords Plus — one wrapper, unlike IEEE's per-term tags.
- Proximity is `NEAR/n`; there is no ordered operator, and `$` (zero-or-one) exists for variants like `behavio$r` (unused here).
- Record which Core Collection editions (SCIE/SSCI/ESCI/CPCI) your subscription actually searched.

### IEEE Xplore (command search)

```
(("All Metadata":"large language model" OR "All Metadata":"large language models" OR "All Metadata":LLM OR "All Metadata":LLMs OR "All Metadata":"generative AI" OR "All Metadata":GPT OR "All Metadata":ChatGPT OR "All Metadata":"foundation model")
AND ("All Metadata":"multi-agent" OR "All Metadata":multiagent OR "All Metadata":agentic OR ("All Metadata":agents NEAR/3 "All Metadata":collaboration))
AND ("All Metadata":"clinical decision support" OR "All Metadata":CDSS OR "All Metadata":"decision support system"))
```

- Field tags bind to a single term or phrase, so `"All Metadata":` repeats on every disjunct — the opposite of Scopus/WoS group-wrapping.
- The 5-wildcard cap plus the wildcard/proximity incompatibility make it safer to enumerate singular and plural forms than to truncate.
- `NEAR/n` and `ONEAR/n` exist but only between wildcard-free terms; here plurals are spelled out instead.

### ACM Digital Library (edit query)

```
(Title:("large language model" OR "large language models" OR LLM OR LLMs OR "generative AI" OR GPT OR ChatGPT OR "foundation model")
 OR Abstract:("large language model" OR "large language models" OR LLM OR LLMs OR "generative AI" OR GPT OR ChatGPT OR "foundation model"))
AND
(Title:("multi-agent" OR multiagent OR agentic OR "agent collaboration" OR "collaborative agents")
 OR Abstract:("multi-agent" OR multiagent OR agentic OR "agent collaboration" OR "collaborative agents"))
AND
(Title:("clinical decision support" OR CDSS OR "decision support system" OR "decision support systems")
 OR Abstract:("clinical decision support" OR CDSS OR "decision support system" OR "decision support systems"))
```

- Field functions wrap whole OR groups (unlike IEEE's one-term binding), but title and abstract need separate wrapped copies.
- No proximity operator exists, so every collaboration variant is an enumerated quoted phrase.
- Wildcards misbehave inside quotes on this platform — plurals are spelled out, mirroring the IEEE string.

### arXiv (export API, via `arxiv_search.py` or the web UI)

```
(abs:"large language model" OR abs:"large language models" OR abs:LLM OR abs:"generative AI" OR abs:GPT OR abs:ChatGPT)
AND (abs:"multi-agent" OR abs:multiagent OR abs:agentic OR cat:cs.MA)
AND (abs:"clinical decision support" OR abs:CDSS OR abs:"decision support")
```

- No truncation and no proximity anywhere — every variant is enumerated; category code `cs.MA` (multi-agent systems) substitutes for missing controlled vocabulary.
- Field prefixes (`abs:`, `ti:`, `cat:`) bind per term, IEEE-style.
- This is the one string the harness executes automatically; the others above are for manual pasting.

## Recording searches

Every executed search MUST be recorded for PRISMA reproducibility (PRISMA-S). One file per search under the project's `searches/` directory, capturing at minimum:

- **database** (and platform + editions where it matters: "PsycINFO via Ovid", "WoS Core Collection: SCIE+ESCI"),
- **exact string** as pasted, verbatim, including line numbers for numbered interfaces,
- **date** the search was run,
- **hits** returned (per line for numbered strategies, plus the final count).

Suggested filename: `searches/<date>-<database>.md`, e.g. `searches/2026-09-06-embase.md`. Re-running a search (e.g. an update before submission) gets a new file, never an edit — the audit trail is append-only. Records exported from each database feed the review store (`scripts/review.py import`, one `--database` per source so PRISMA keeps per-source identified counts); from there the workflow is import -> dedupe (DOI, then normalized title) -> screen (`SCREENING.md`) -> fulltext (OA-first cascade) -> prisma (`scripts/prisma_scr.py`, derived from record states) -> review/export.
