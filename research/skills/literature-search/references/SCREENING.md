# Screening Methodology

Review-agnostic rules for screening candidate papers against inclusion criteria. Applies to any systematic or mini review run through this skill.

## Criteria framework: PCC

State screening criteria as **PCC**:

- **Population** — who/what is studied (e.g. clinical decision-support systems, software engineering teams, text-to-SQL benchmarks).
- **Concept** — the core phenomenon that must be present (e.g. 2+ interacting LLM agents, retrieval-augmented generation).
- **Context** — the setting, domain, or study-type bounds (e.g. healthcare deployments, peer-reviewed empirical studies, 2022+).

If the caller supplies free-form criteria, restructure them into PCC **before** screening any candidate. Criteria that fit none of the three dimensions go under **Other** (e.g. language, publication type).

## Two-stage model

| Stage | Verdicts | Notes |
|---|---|---|
| Title/abstract | `include` \| `exclude` \| `maybe` | `maybe` is RARE — only genuine ambiguity where the abstract neither confirms nor rules out a criterion. Reviewer unfamiliarity is not ambiguity. |
| Full text | `include` \| `exclude` — **binary, no `maybe`** | If ambiguity survives the full text, EXCLUDE with note: "Insufficient information to confirm \<criterion\> — not resolved at FT stage." |

## Hard rules

1. **No abstract ⇒ exclude.** At the title/abstract stage, a missing or empty abstract is an `exclude` with rationale "no abstract".
2. **First failed dimension.** Every `exclude` names exactly ONE primary reason: the FIRST failed criterion dimension, checked in priority order **Population → Concept → Context → Other**.
3. **Evidence, not echo.** Rationales must quote or paraphrase evidence from the abstract/full text. Criteria-echo ("does not meet criteria", "seems relevant") is banned.

## Verdict block format

```
#N — Title (FirstAuthor Year, Venue)
Verdict: INCLUDE|EXCLUDE|MAYBE — <one-sentence evidence-based rationale naming the failed/met criterion>
Confidence: HIGH|MEDIUM|LOW
```

Confidence levels:

- **HIGH** — unambiguous: the abstract/full text directly states what the criterion asks.
- **MEDIUM** — one criterion inferred rather than stated.
- **LOW** — partial extraction or abstract-only inference on a full-text-level question.

## Worked example: a subtle Concept judgment

Criterion (Concept): **"2+ interacting LLM agents"** — at least one agent's reasoning must be CONDITIONED on another agent's output (critique, debate, consensus, reconciliation).

Qualifies:
- Multi-round or bidirectional exchange between agents (debate, critic-refiner loops, negotiated consensus).
- Hierarchical/divide-and-conquer designs ONLY if the orchestrator actively monitors and reconciles the agents' work.

Does NOT qualify:
- A sequential role-specialized pipeline: fixed-order role prompts handing output downstream, no agent revising in light of another's response.
- An agent looping against a TOOL (e.g. retrying SQL on execution errors) — the feedback source is an executor, not an agent.
- A single controller orchestrating multiple tools.

Example verdict applying it:

```
#7 — SQLFixer: Iterative Self-Correction for Text-to-SQL (Chen 2024, EMNLP)
Verdict: EXCLUDE — Concept: the "multi-agent" loop is one LLM retrying SQL against a database executor's error messages; no agent conditions on another agent's output.
Confidence: HIGH
```
