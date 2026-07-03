---
name: quickscope
description: Run the QuickScope stage of qs-parallelprd: turn a messy objective, findings list, repo issue, or research-backed gap analysis into an evidence-rooted A-to-Z lane plan with root cause, lane ownership, dependencies, parallel windows, serialization rules, effort, and targeted acceptance gates.
---

# QuickScope

QuickScope is the front-end scoping pass for `qs-parallelprd`. It converts a rough objective, backlog, research output, bug list, current-code gap analysis, or adversarial findings set into a compact, evidence-rooted lane plan that can be handed to parallel implementation agents.

Use this instead of a full PRD when the user needs the work decomposed quickly but safely: grounded in observable evidence, bundled by file/contract ownership, explicit about root cause and uncertainty, parallel-safe, and closed by a targeted acceptance gate.

## Inputs

Accept any of:

- A raw objective or feature request.
- A list of bugs, findings, remediation items, or research-backed gaps.
- A partially written PRD or implementation plan.
- A current-code gap analysis request.
- A request mentioning `quickscope`, `quick-scope`, `qs-parallelprd`, `A to Z Gaps`, “what lanes can run in parallel?”, or “root this gap analysis in evidence/research.”

If the input is underspecified, infer the narrowest useful scope from repo evidence. Ask only when missing information would materially change lane boundaries.

## Evidence standard

QuickScope must distinguish observed evidence from inferred root cause.

Use this evidence ladder:

| Level | Name | Meaning | Use |
|---|---|---|---|
| E0 | Assertion | Human intuition with no artifact | Not enough to create a lane. |
| E1 | Static artifact | File path, schema, API, config, docs, code search, issue text | Enough for scoping and preliminary ownership. |
| E2 | Runtime artifact | Failing test, stack trace, repro, log, trace, telemetry | Strong evidence for fault localization and validation. |
| E3 | Change artifact | Git history, PR coupling, migration history, dependency graph | Strong evidence for bundling, sequencing, and impact. |
| E4 | Research artifact | arXiv, peer-reviewed SE research, benchmark evidence | Use for general risk patterns; never replaces repo-specific evidence. |
| E5 | Closeout artifact | Passing targeted test, contract check, acceptance transcript, regression check | Required to close implementation lanes. |

External research may justify risk controls, such as file localization, retrieval quality, merge-conflict avoidance, stack-trace use, patch-overfit review, or task decomposition. It does not prove a specific repo gap exists unless tied to repo evidence.

## Process

### Pass 1 -- Scope Frame

State the work in 3-6 sentences:

- Goal and success condition.
- In-scope packages/files/surfaces.
- Out-of-scope work.
- Existing evidence used.
- External-service or sequencing constraints.

Do not decompose yet.

### Pass 2 -- Evidence Basis

Create a compact evidence basis before gap extraction. Include only evidence that will affect lane boundaries, dependencies, root-cause confidence, or acceptance.

Use IDs such as `E1`, `E2`, `E3`. Each item must include:

- Evidence type: `static`, `runtime`, `change`, `research`, `user-report`, or `unknown/TBD`.
- Source: file path, test name, stack trace, log, PR/issue, benchmark/paper, or search result.
- Claim supported.
- Limit or uncertainty.

If no repo evidence is available, say so and mark repo-specific claims as `TBD`; do not invent files.

### Pass 3 -- Completed Planned Tasks

Summarize what is already known or already completed. Each item should reference evidence IDs where possible. This section prevents duplicated work and anchors the gap list in the current state.

### Pass 4 -- Root-Cause Gap Map

Extract every distinct remaining work item before converting items into implementation lanes.

For each item, identify:

- Observed symptom or capability gap.
- Evidence IDs supporting the gap.
- Inferred root cause.
- Alternative explanations or uncertainty.
- Files/contracts likely owned by the item.
- Whether it must be bundled with another item because they share the same core file, schema, contract, fixture, or validation helper.
- Validation needed to close the gap.
- Confidence: `Low`, `Medium`, or `High`.

Use code/search/read evidence when operating inside a repo. Do not invent files; mark unknowns as `TBD` only when repo evidence cannot settle them quickly.

### Pass 5 -- A-to-Z Lane Plan

Produce `### [A to Z Gaps]` as a markdown table with these exact columns:

| Letter | Name | Archetype tag | Remaining-work note | Effort | Depends on | Primary files |
|---|---|---|---|---|---|---|

Rules:

- Use letters as stable lane IDs. Usually start with A and proceed sequentially; reserve `Z` for the final acceptance gate when one is needed.
- Prefer 3-6 implementation lanes. Do not split past the point where merge conflicts or contract drift become likely.
- Bundle same-file or same-contract work into one lane, even when the lane becomes larger. Avoid multiple lanes editing the same hot file.
- `Archetype tag` should be one of:
  - `[pre-phase]` — contract, schema, scaffold, preflight, or shared invariant that later lanes depend on.
  - `[remediation]` — implementation/fix lane with bounded ownership.
  - `[surface]` — CLI/API/UI/user-facing exposure.
  - `[validation]` — tests, assertions, hardening, parity checks owned by the lane.
  - `[acceptance-gate]` — read-only or targeted final verification after implementation lanes land.
- `Remaining-work note` must cite evidence IDs, explain the inferred root cause, state why the lane is bundled, and name concrete validation to close it.
- `Effort` must be `SMALL`, `MEDIUM`, or `LARGE`.
- `Depends on` must be explicit: `none`, `A`, `A result-row contract`, `A and B`, etc.
- `Primary files` must list concrete paths where known; use semicolon-separated paths in one cell.

### Pass 6 -- Parallelization Contract

After the table, add a dedicated `### Parallelization Contract` section with bullets for:

- **Safe parallel window:** which lanes can run together and why file ownership will not collide.
- **Required serialization:** which lanes must land first because they define contracts, schemas, fixtures, migrations, or shared validation.
- **Independent lanes:** lanes that can proceed without external services or upstream outputs.
- **Bundle rationale:** why related findings were grouped together instead of split.

### Pass 7 -- Acceptance Gate

Add a dedicated `### Acceptance Gate` section. It must name what `Z` verifies using targeted tests/commands only. Do not prescribe project-wide gates unless necessary.

The gate must reject any lane that lacks:

- Evidence ID.
- Root-cause claim.
- Confidence.
- Explicit dependency rationale.
- Primary files or `TBD` justification.
- Targeted validation.
- Parallelization safety rationale when the lane is proposed to run concurrently.

## Required output

Use this shape exactly:

```markdown
## QuickScope

### Scope Frame

...

### Evidence Basis

| Evidence ID | Type | Source | Claim supported | Limits / uncertainty |
|---|---|---|---|---|
| E1 | static | `path/to/file` | ... | ... |
| E2 | research | paper / benchmark | ... | ... |

### [Completed Planned Tasks]

- E1: ...

### Root-Cause Gap Map

| Gap ID | Observed signal / gap | Evidence | Inferred root cause | Alternative explanations | Validation to close | Confidence |
|---|---|---|---|---|---|---|
| G1 | ... | E1, E2 | ... | ... | ... | Medium |

### [A to Z Gaps]

| Letter | Name | Archetype tag | Remaining-work note | Effort | Depends on | Primary files |
|---|---|---|---|---|---|---|
| A | ... | `[pre-phase]` | Evidence: E1. Root cause: ... Validation: ... Confidence: Medium. | LARGE | none | `path`; `path` |
| Z | Acceptance gate | `[acceptance-gate]` | Evidence: E1-E3. Read-only verification that every lane has evidence, root cause, confidence, dependency rationale, primary files/TBD justification, and targeted validation. | SMALL | A, B, C | read-only over A-C files |

### Parallelization Contract

- **Safe parallel window:** ...
- **Required serialization:** ...
- **Independent lanes:** ...
- **Bundle rationale:** ...

### Acceptance Gate

- **Targeted checks:** ...
- **Reject if:** ...
```

## Guardrails

- QuickScope produces a lane plan, not implementation.
- Keep tables compact enough to paste into a parallel-agent prompt.
- Prefer boring, conflict-avoiding ownership over maximum parallelism.
- Never assign two lanes to independently define the same contract.
- If a lane depends on a shared contract, name the exact contract in `Depends on`.
- If acceptance requires tests, name targeted tests only; do not prescribe project-wide gates unless necessary.
- Do not let research evidence replace repo evidence. Research evidence supports risk controls; repo evidence supports repo-specific claims.
- Do not admit E0-only lanes.

## Research basis for this structure

- SWE-bench shows real repository issues require understanding and coordinating changes across functions, classes, and files, supporting file localization before lane assignment. Reference: arXiv:2310.06770.
- SWE-agent shows software-engineering agents benefit from interfaces that help navigate repositories, edit files, and execute tests, supporting explicit evidence and targeted validation. Reference: arXiv:2405.15793.
- Repository-level retrieval-augmented code generation research emphasizes context construction, retrieval, generation, and environment interaction, supporting an explicit Evidence Basis before gap extraction. Reference: arXiv:2510.04905.
- Stack-trace-based fault localization research shows crash reports and stack traces can be high-value runtime evidence when failing tests are unavailable. Reference: arXiv:2405.00565.
- Code-aware root-cause analysis research shows issue reports alone are often incomplete or ambiguous and benefit from retrieved code context. Reference: arXiv:2503.23051.
- Automated program repair research shows patches may pass available tests while still being incorrect or overfit, supporting targeted acceptance beyond broad green-test claims. Reference: arXiv:1706.09120.
- Prompting and agent-planning research supports explicit planning/decomposition and refinement before final answers, supporting the order: evidence, root-cause map, lane plan, parallel contract, acceptance. References: arXiv:2305.04091 and arXiv:2303.17651.
- Empirical merge-conflict research supports bundling same-file/same-contract work and avoiding maximum parallelism when ownership evidence is weak. Reference: Brindescu et al., Empirical Software Engineering, 2020.
