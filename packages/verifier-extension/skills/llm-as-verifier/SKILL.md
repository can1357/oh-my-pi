---
name: llm-as-verifier
description: This skill should be used when the user asks to "compare candidate patches", "rank multiple solutions", "choose between implementations", "verify two drafts", "pick the best trajectory", "use llm-as-a-verifier", or wants repeated criteria-decomposed LLM verification instead of a single free-form judgment.
---

# LLM-as-Verifier

## Purpose

Use this skill to choose among multiple candidate solutions with a structured verifier loop inspired by the `llm-as-a-verifier` paper and repo.

Prefer this workflow when:
- a single model judgment would be too brittle,
- several drafts, patches, or plans already exist,
- the task benefits from explicit evaluation criteria,
- deterministic evidence exists and should be weighed more heavily than narration.

Do **not** treat the verifier as a replacement for tests, logs, or direct inspection. It is a selection mechanism layered on top of concrete evidence.

## Core idea

Replace one-shot "which answer is best?" judging with four stronger moves:

1. **Compare candidates pairwise** instead of scoring only one artifact in isolation.
2. **Decompose judgment into criteria** such as correctness, requirements adherence, empirical verification, or clarity.
3. **Repeat the verification** several times to reduce single-sample noise.
4. **Use a tournament/ranking pass** to select the overall winner across candidates.

## Prefer compare mode over audit mode

Use **compare** mode whenever at least two viable candidates exist. Pairwise comparison is the closest match to the paper and usually produces a stronger signal than absolute scoring.

Use **audit** mode only when a single artifact must be scored against explicit criteria and no alternative candidate exists yet.

## Inputs

Provide as many of these as the task supports:

- `task`
- `candidates`
- `criteria`
- optional shared `context`
- optional shared `evidencePaths`
- optional `nVerifications`
- optional `outputPath`
- optional `backend`
- optional `models`
- optional `modelWeights`

For each candidate, prefer:
- stable `id`
- focused `content` or file `path`
- optional short `summary`
- optional candidate-specific evidence

## Output behavior

A successful verifier run should produce:
- a winner or audit score,
- criterion-by-criterion reasoning structure,
- repeated verification results,
- confidence and disagreement signals,
- machine-readable JSON output,
- a final explanation of why the result won.

When confidence is low or evidence is weak, say so explicitly and recommend the next deterministic check.

## Backends and model lanes in this packet

Three verifier backends are available:

- `gemini-python` — uses the deterministic Python runner in `scripts/lav_runner.py`
- `zai-coding-plan` — runs the verifier flow through a single Pi-configured ZAI coding model
- `pi-model-ensemble` — rotates repeated verification attempts across multiple Pi-configured models

Default ensemble lane selection is aligned with the current `/delegate` setup:

- `kimi:kimi-for-coding` — prompt/requirements-sensitive verifier lane
- `minimax.io:minimax-m3` — independent MiniMax M3 verifier lane
- `openai:gpt-5.5` — strong OpenAI/Codex-side verifier and synthesis lane

When verifying outputs produced by `/delegate`, treat the lane artifacts as candidates or evidence:

- Kimi-refined prompt: shared context/evidence, not a candidate unless evaluating prompt quality.
- Minimax lane output: candidate or candidate-specific evidence.
- OpenAI Codex lane output: candidate or candidate-specific evidence.
- GPT-5.5 via Codex synthesis: audit target or candidate only if comparing synthesized reports.

The ensemble backend also supports:
- per-model weighting through `modelWeights`
- confidence and disagreement reporting
- per-model breakdowns across repeated attempts

All three backends perform:
- repeated per-criterion scoring
- pairwise aggregation
- round-robin selection or audit averaging
- machine-readable JSON output

### Interactive selection menu

Create an interactive menu only when the user has not specified a backend/model set and the choice has material tradeoffs:

1. **Fast deterministic smoke** — `gemini-python` with `mock: true`; use only for pipeline validation.
2. **Default compare** — `pi-model-ensemble` with `kimi:kimi-for-coding`, `minimax.io:minimax-m3`, and `openai:gpt-5.5`; recommended for normal multi-candidate selection.
3. **Single strong verifier** — `zai-coding-plan` with `zai:glm-5.1`; use when ensemble auth is unavailable or the user wants one Pi-routed model.
4. **Delegate-output review** — `pi-model-ensemble` with `/delegate` lane outputs supplied as candidates/evidence; use after `/delegate` generates Minimax/Codex lane artifacts.

If the safest default is clear, do not ask: choose **Default compare** for 2+ candidates and **Single strong verifier** only for a single-candidate audit.

## Required process

### 1. Gather deterministic evidence first

Collect the strongest available evidence before calling the verifier:

- build/test output
- terminal logs
- diff or patch text
- spec excerpts
- generated files
- failing vs passing examples

Prefer observed outputs over self-reported claims from the candidate.

### 2. Define 3-5 criteria

Write criteria that isolate different failure modes. Keep each criterion narrow and operational.

Good examples:
- **Correctness** — Does the artifact actually solve the requested problem?
- **Requirements adherence** — Does it match exact constraints, file paths, formats, and scope?
- **Empirical verification** — Does the evidence show the fix was tested and validated?
- **Maintainability** — Does the change fit surrounding code and avoid obvious regressions?

Avoid overlapping criteria like "quality", "goodness", and "correctness" all at once. That creates duplicate scoring.

Use `references/criteria-recipes.md` for templates.

### 3. Prepare candidate payloads

Keep candidate payloads focused. Include the patch, proposal, response, or document section that actually needs comparison. Trim unrelated noise.

### 4. Run the verifier

Use the project-local `llm_as_verifier` extension tool when available. It is auto-registered from:
- `.pi/extensions/llm-as-verifier/index.ts`

### 5. Sanity-check the winner

Do not stop at the selected winner. Verify that the result agrees with deterministic evidence and user constraints.

If the winner contradicts tests or explicit requirements:
- inspect the pairwise breakdown,
- tighten the criteria,
- add missing evidence,
- rerun compare mode.

### 6. Explain the decision

Summarize:
- why the winner won,
- which criteria decided the outcome,
- what evidence mattered most,
- any residual uncertainty.

## Setup

For `gemini-python` real runs, install the Gemini client:

```bash
pip install google-genai
```

Provide one of these environment variables or a local `.env` file:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `VERTEX_API_KEY`

For `zai-coding-plan` real runs, configure ZAI auth in Pi so the extension can access a ZAI model such as `glm-5.1` through Pi's model registry.

For `pi-model-ensemble` real runs, configure auth in Pi for each provider/model you want to rotate across. The default verifier panel is:

- `kimi:kimi-for-coding`
- `minimax.io:minimax-m3`
- `openai:gpt-5.5` (GPT-5.5 via the OpenAI/Codex side)

Other supported examples:

- `minimax:MiniMax-M2.7-highspeed`
- `openai:gpt-5-codex`
- `openai:gpt-5.4`
- `google:gemini-2.5-flash`

Use `mock` mode only for smoke tests and pipeline validation.

## Tooling in this packet

### Settings and slash command

Use `/settings` → **Tasks** → **Subagents** → **LLM Verifier Model** to choose the model used by the verifier lane. Prefer a model/provider independent from the implementation model.

Run `/verify` after implementation to audit the current staged and unstaged tracked diff. With no arguments, the command opens an objective/acceptance editor. Inline form:

```text
/verify Objective: preserve installer defaults

Acceptance:
- npm/Bun remains the default
- unsupported binary architectures fail before download
- focused installer tests pass
```

`/verify` runs a repeated single-candidate audit and reports criterion-level evidence. It does not run tests for the implementer. The command audits tracked diffs only; use `llm_as_verifier` directly for saved or untracked candidates and multi-candidate comparison.

The command fails before contacting the model when the tracked diff exceeds 40,000 characters or status evidence exceeds 20,000 characters, so verification never silently scores a truncated workspace. Narrow the change set or call `llm_as_verifier` with a saved candidate.

### Extension tool

Use the `llm_as_verifier` tool for normal operation.

The tool supports:
- `compare` mode for 2-6 candidates
- `audit` mode for 1 candidate
- `backend` selection: `gemini-python`, `zai-coding-plan`, or `pi-model-ensemble`
- `models` for ensemble rotation across repeated attempts; known aliases include `kimi-for-coding`, `kimi-k2` (mapped to `kimi-for-coding`), `minimax-m3`, `minimax-m2.7-highspeed`, `gpt-5.5`, and `gpt-5-codex`
- `modelWeights` for weighted ensemble aggregation
- confidence/disagreement reporting in result details
- `mock` mode for smoke tests only

### Deterministic runner

Use `scripts/lav_runner.py` directly when the extension is unavailable or when a machine-readable batch run is preferred.

Example:

```bash
python .agents/skills/llm-as-verifier/scripts/lav_runner.py \
  --input /path/to/input.json \
  --output /path/to/result.json
```

### Smoke commands

Use the bundled smoke commands before higher-stakes runs:

```bash
/lav-smoke
/lav-ensemble-smoke
```

- `/lav-smoke` runs the bundled Python-runner example in deterministic mock mode.
- `/lav-ensemble-smoke` runs the bundled weighted ensemble example in deterministic mock mode and exercises model rotation plus weighted aggregation.

## Rules

- Prefer **compare** mode over **audit** mode whenever there are multiple viable candidates.
- Gather deterministic evidence before asking the verifier to rank anything.
- Keep criteria narrow, operational, and non-overlapping.
- Keep candidate payloads focused; trim unrelated noise.
- Treat strong evidence as more trustworthy than polished narration.
- When uncertainty is high, say so and recommend a next deterministic check.
- Do not present verifier output as certainty when the inputs are weak.
- Use mock mode only for smoke tests, demos, and pipeline validation.
- For `/delegate` results, preserve separate lane outputs. Do not collapse Minimax, Codex, and GPT-5.5 synthesis into one candidate unless the question is about the combined final response.

## Criteria-writing rules

Use this pattern:
- **Name**: short label
- **Description**: exact thing to inspect, what counts as strong evidence, what counts as failure

Prefer wording like:
- "Check whether the final patch edits the actual failing code path rather than a downstream symptom."
- "Compare the observed output to the required output and score only the match between them."
- "Reward candidates whose final artifact is supported by concrete test evidence."

Avoid vague wording like:
- "Judge overall quality."
- "See whether it seems better."
- "Pick the one you like most."

## Failure modes to watch

- Missing evidence causes the verifier to over-trust polished narration.
- Overlapping criteria double-count the same weakness.
- Huge candidate payloads bury the important signal.
- Audit mode on a single candidate is weaker than compare mode.
- Strong style can beat weak correctness unless criteria explicitly protect correctness.

## Additional resources

Read these references when shaping a verifier run:

- `references/research-notes.md` — paper-to-implementation mapping and design rationale
- `references/criteria-recipes.md` — reusable criteria sets for code, plans, docs, and answers
- `examples/code-patch-selection.json` — example compare input for the Python runner and `/lav-smoke`
- `examples/weighted-ensemble-selection.json` — weighted ensemble example for `/lav-ensemble-smoke`

Prompt templates are also bundled for quick starts:

- `/compare-patches`
- `/audit-candidate`
- `/ensemble-verifier`

## Success criteria

This skill is successful when it:
- chooses the strongest candidate rather than the most polished one,
- makes the decision legible through explicit criteria,
- incorporates deterministic evidence into the ranking,
- surfaces uncertainty honestly,
- produces a machine-readable artifact when needed,
- helps the user rerun the comparison with sharper inputs when the result is weak.

## Operating guidance

Start with compare mode.

Use **5 verifier samples** as the default for normal work. The Python runner
(`scripts/lav_runner.py`) defaults `n_verifications` to 5; the Pi extension
defaults `nVerifications` to `max(5, models.length)` for `pi-model-ensemble`
and 5 for `gemini-python` / `zai-coding-plan`. Explicit lower values
(`n_verifications` in `1..8`) are still accepted for smoke tests, but treat
anything below 5 as a high-variance decision aid, not a verdict.

**Compare mode always runs A/B and B/A orderings.** Every pair / criterion /
repetition evaluates both `candidate_a → candidate_b` (original) and
`candidate_b → candidate_a` (swapped). The canonical score for the swapped
run is fed back into the aggregate, so a position-only bias cannot pick a
winner on its own.

**Low vote margin returns `tie` / uncertain.** Pairwise compare mode counts
canonical per-repetition winners (ties count `0.5` for each candidate) and
computes `vote_margin = max(votes) / total_votes`. When `vote_margin < 0.7`
the pair winner is forced to `tie` even if the mean scores differ — the
numeric scores stay visible, but the categorical decision is `uncertain`.
Audit mode applies the same rule to its positive/negative vote tally.

**Candidate outputs are untrusted and scanned.** Every candidate answer is
routed through `scan_for_judge_manipulation`
(`harness/security/prompt_injection.py`) before rubric scoring. Flagged
candidates receive `judge-manipulation: <pattern>` weaknesses (penalizing
`evidence_quality` and `safety_permission_fit`) and the run surfaces a
top-level warning in the format
`candidate <id> contains judge-manipulation patterns: <flags>`. Legitimate
security discussion may be flagged and stays advisory plus penalty, not
hard failure.

In `pi-model-ensemble`, if `nVerifications` is omitted, it defaults to
`max(5, models.length)` so each model still gets at least one pass. The
default panel is Kimi, MiniMax M3 from `minimax.io`, and GPT-5.5 via
OpenAI/Codex. Increase verifications only when the decision is high value
and the candidate set is small.

Supply shared evidence whenever the task has external ground truth.

Use audit mode only as a fallback.

Treat the verifier as a structured selector layered on top of deterministic evidence, not as a magical replacement for tests.
