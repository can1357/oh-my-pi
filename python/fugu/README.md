# pi-llm-as-verifier

**pi-llm-as-verifier** is a fusion meta-harness that uses LLMs as structured judges to evaluate and compare AI-generated candidate answers. It runs multiple candidate solutions through a rubric-scored pipeline, then applies a hardened pairwise comparison mode — running every A vs B pair in both orderings (swap-and-aggregate) to cancel position bias, requiring 3 concrete evidence observations before any score, and forcing a `tie` when the vote margin falls below 70% — producing a ranked winner that's resistant to the well-documented failure modes of LLM-as-a-judge systems (position bias, verbosity bias, self-enhancement, and adversarial judge-manipulation). The harness adds additional reliability gates including output-side manipulation scanning, a model-independence requirement between synthesizer and verifier, symbolic command verification, and a gated promotion pipeline that requires holdout evaluation and human sign-off before a candidate or verifier prompt can be promoted to production.

Pi package for `llm-as-verifier` style selection and auditing.

## Fusion Meta-Harness

This repository now also contains a Python `fusion-meta-harness` v1 framework. It accepts structured `TaskContract` JSON, runs bounded candidate agents, stores full traces under `runs/{run_id}`, scores candidates with hard gates and weighted rubric dimensions, synthesizes a final answer, verifies it, and records results in a SQLite index.

Quick start:

```bash
pip install -e .[dev]
fmh validate-task tests/fixtures/mock_task.json
fmh run-task --task tests/fixtures/mock_task.json --backend mock
fmh run-eval --suite evals/search/tasks.jsonl --limit 1
fmh optimize --iterations 1 --suite search --validation-suite validation
```

## Fugu orchestrator

This fork adds `fugu`, a Fugu-style coordinator on top of FMH. It chooses a route/tree/build-debug/specialist scaffold over the configured 9router pool, executes the lanes through the existing FMH trace/rubric/synthesis/verifier contract, and exposes the collective through an OpenAI-compatible endpoint.

```bash
pip install -e 'python/fugu[llm,serve]'
fugu plan "write a binary search in Rust" --json
fugu solve "2+2?" --mock
fugu serve --port 8088
```

Omp provider config is available at `configs/omp_provider.yml`; merge its `providers.fugu` block into `~/.ompk/agent/models.yml`, then use `fugu/fugu` or `fugu/fugu-ultra` while `fugu serve` is running.

Runtime knobs: `FUGU_COORDINATOR_MODEL` (default `9router/cline-deepseek-v4-flash`), `FUGU_9ROUTER_RPM` (default `80`, `0` disables the local limiter), `FUGU_API_KEY` (optional bearer auth for `fugu serve`), `NINEROUTER_API_KEY` / `9ROUTER_API_KEY`, and `9ROUTER_BASE_URL`.

`fmh optimize` grades each candidate against its **own edited code**: the persisted
candidate dir holds only the editable surface, but evaluation builds an ephemeral
full-repo overlay (the candidate's edited files overlaid on a repo copy) and runs the
suite as a subprocess against it, so search/validation scores reflect the proposed
change. The `holdout` suite is refused as a search/validation suite (it is reserved for
the promotion gate). Set `FMH_OPTIMIZER_INPROC_EVAL=1` to force the faster in-process
eval (grades against the installed harness, not the candidate's edits) for CI/smoke runs.

The mock backend is the default for tests and local pipeline validation. Real backends are wired and **fail closed** until their credentials/commands are configured:

| Backend | What it runs | Configure with |
| --- | --- | --- |
| `mock` | Deterministic stub (default) | — |
| `anthropic_api` | Claude (Opus 4.8 default) | `ANTHROPIC_API_KEY`; `FMH_ANTHROPIC_MODEL` |
| `openai_api` | OpenAI / Codex (GPT-5.5 default) | `OPENAI_API_KEY`; `FMH_OPENAI_MODEL` |
| `kimi` | **Budget** — Kimi for Coding (Moonshot, Anthropic-compatible) | `KIMI_API_KEY`; `FMH_KIMI_MODEL`, `KIMI_BASE_URL` |
| `minimax` | **Budget** — MiniMax M3 (verified live) | `MINIMAX_API_KEY`; `FMH_MINIMAX_MODEL` |
| `qwen` | **Budget** — Qwen Coder Plus (Alibaba DashScope, OpenAI-compatible) | `DASHSCOPE_API_KEY`; `FMH_QWEN_MODEL`, `QWEN_BASE_URL` |
| `9router` | **Meta-router** — local 9router gateway (60+ providers via OpenAI-compatible proxy; install with `npm i -g 9router`, run `9router`) | `9ROUTER_API_KEY` or `NINEROUTER_API_KEY`; `9ROUTER_BASE_URL`, `FMH_9ROUTER_MODEL` |
| `codex_cli` | Local Codex CLI | `FMH_CODEX_CLI_CMD="codex exec"` |
| `claude_code` | Local Claude Code CLI | `FMH_CLAUDE_CODE_CMD="claude -p"` |
| `subprocess_cli` | Operator-configured subprocess command (for private model gateways / local inference servers) | Per-backend env vars set in `harness/agents/cli_backend.py` |
| `local` | Honest stub alias for `mock` (lets a TaskContract request `local` without wiring a real adapter) | — |

Select a backend per run, e.g. `fmh run-task --task tests/fixtures/mock_task.json --backend kimi` or `fmh run-eval --suite evals/search/tasks.jsonl --backend minimax`.

### Budget candidates + a strong synthesizer

Pair cheap candidate generation (Kimi K2.7, MiniMax M3) with a high-end **synthesizer** that fuses the candidate answers. Enable the model synthesizer (Codex / ChatGPT 5.5 or better) with:

```bash
export FMH_SYNTHESIZER=openai          # turn on the model synthesizer
export FMH_SYNTHESIZER_MODEL=gpt-5.5   # or any stronger model
export OPENAI_API_KEY=...

fmh run-task --task tests/fixtures/mock_task.json --backend kimi
```

The synthesizer runs independently of the candidate backends, so budget models propose and the strong model fuses. If it is unconfigured or unreachable, synthesis falls back to the deterministic best-candidate selection and the run still completes (the fallback is recorded in `run_state.errors`).

### Independent cross-model verifier

For a second, independent check, enable a verifier on a **different** model from the candidates/synthesizer. It judges the final answer against the acceptance criteria (grounded in the cited evidence) and can only make the gate stricter — a deterministic pass that it rejects becomes a failure:

```bash
export FMH_VERIFIER=openai
export FMH_VERIFIER_MODEL=...   # set to a DIFFERENT model than the synthesizer
```

Like the synthesizer it redacts content before egress, is skipped for secret-handling tasks, and falls back gracefully (recorded in `run_state.warnings`) if unreachable.

The `budget` **profile** rotates the budget backends (Kimi, MiniMax) across candidates in one run — no per-candidate config needed:

```bash
fmh run-task --task tests/fixtures/mock_task.json --profile budget
```

It ignores `--backend` and cycles `kimi` → `minimax` → … across the candidate slots, each resolving its own default model.

Install the optional SDKs with `pip install -e .[llm]` (or `.[anthropic]` / `.[openai]`).

### Verifier hardening gates

The fusion-meta-harness enforces a stack of reliability gates so verifier results
stay aligned with deterministic evidence and survive well-known LLM-judge failure
modes. Each gate is implemented as a focused, independently testable module.

- **Swap-and-aggregate compare mode** — `harness/fusion/verifier_scoring.py` and
  the Python runner enforce that every pairwise comparison runs both `A/B` and
  `B/A` orderings; the canonical score for the swapped run is fed back into the
  aggregate. The pair winner is `tie` (or low-confidence) when the two orders
  disagree, so position bias cannot pick a winner on its own.
- **Evidence-first scoring** — `prompts/critic.md`, `prompts/ensemble-verifier.md`,
  and the Python runner's `create_compare_prompt` / `create_audit_prompt`
  prepend a "list 3 evidence observations before scoring" instruction
  (`EVIDENCE_FIRST_INSTRUCTION`). Score tags remain optional to parse; an LLM
  that skips evidence but still emits a score tag is treated as before.
- **Output-side judge-manipulation scanning** — `harness/security/prompt_injection.py`
  exposes `scan_for_judge_manipulation` with five pattern families
  (`note-to-evaluator`, `rate-highly`, `override-judge`, `declare-winner`,
  `verdict-injection`). The lifecycle supervisor scans every candidate's answer
  after recording it, appends `judge-manipulation: <name>` weaknesses to the
  candidate's `self_assessment`, surfaces a top-level run warning in the
  exact format `candidate <id> contains judge-manipulation patterns: <flags>`,
  and the rubric applies a soft penalty to `evidence_quality` and
  `safety_permission_fit` for flagged candidates.
- **Rubric descriptors** — `configs/rubric.yaml` and `harness/rubric/base.py`
  carry Prometheus-style level descriptors (1/3/5) for each rubric dimension.
  `Rubric.format_for_prompt()` exposes them to verifier prompts in descending
  weight order using the line format
  `<dimension> (weight <weight>): 1=<level1>; 3=<level3>; 5=<level5>`.
- **Verifier reliability eval command** — `fmh evaluate-verifier
  --suite evals/verifier/search/tasks.jsonl --backend mock` runs the Python
  runner over a fixture suite and reports `accuracy`,
  `position_bias_rate_available`, `position_bias_rate`, `flag_recall`, and
  per-row outcomes, so regressions in compare or judge-manipulation handling
  are caught before any model change ships.
- **Promotion command** — `fmh promote --candidate <id> --human-review` reads the
  frontier SQLite index and refuses to promote a candidate without all four
  decision inputs (`search_passed`, `validation_passed`,
  `holdout_regressions`, `human_review`). Missing data fails closed with
  `allowed: false` and a `promotion data incomplete for candidate <id>` reason.
- **Symbolic verification commands** — every entry in
  `task.success_commands` is run as a `symbolic_verification_command` check
  in `harness/fusion/verifier.py`. A non-zero exit (or a denied command)
  sets `VerifierResult.pass_` to `False` and the model-verifier can only
  make the gate *stricter*, never rescue a failed symbolic command.
- **Step-level verification foundation** — `harness/fusion/step_verifier.py`
  carries the PRM-style `StepScore` / `StepVerificationResult` model and the
  `aggregate_step_scores` function (min-step aggregation with a
  symbolic-failure-dominates policy). Lifecycle integration of diff-hunk
  extraction is intentionally not wired yet — the model and policy are
  stable first, wiring comes after.

It bundles:
- a Pi skill: `llm-as-verifier`
- a Pi extension tool: `llm_as_verifier`
- reusable prompt templates for common verifier workflows

## Red Queen Gödel Machine (RQGM)

This fork integrates the standalone `red-queen-godel-machine` package — a
co-evolutionary archive search (arXiv:2606.26294) in which evaluators co-evolve
with agents under controlled utility evolution (epoch-local frozen evaluators,
anchor-based best-belief replacement, selective erasure of evaluator-dependent
records). The algorithm lives in the package; FMH contributes a backend-driven
provider plus CLI/MCP/slash-command surfaces.

Install the optional dependency (not yet on PyPI), from `python/fugu`:

```bash
pip install -e ../../../red-queen-godel-machine
pip install -e '.[rqgm]'
```

Run a search:

```bash
fmh rqgm search --provider fmh --backend 9router --model omp --budget 64  # real local 9router run
fmh rqgm benchmark --backend 9router --model omp --budget 4               # seed-vs-RQGM self-improvement check
fmh rqgm search --provider mock --budget 64 --seed 0                          # deterministic offline test mode
fmh rqgm inspect <run_id>                                                     # print a persisted run summary
```

- Default search is real: `--provider fmh --backend 9router --model omp`.
- `--provider mock` uses the package's deterministic providers; keep it for tests/offline CI, not for self-improvement claims.
- `--provider fmh` evolves coder/judge prompts through
  `harness.core.lifecycle.BACKENDS`; `--backend` selects the model backend
  (`mock`, `9router`, `claude_code`, `anthropic_api`, …). Coder tasks come from
  `evals/<task-suite>`; evaluator anchors from `evals/<anchor-suite>` (default
  `verifier/labeled`, mapped to Accept/Reject from each row's `expected_winner`).
- `--provider llm --dataset <tasks.jsonl> --anchor <anchor.jsonl> --model <id>`
  uses the package's generic OpenAI-compatible provider.

The same search is exposed over MCP as the `rqgm_search` tool and as the `/rqgm`
slash command in the coding agent.

### Real-world self-improvement: `fmh rqgm evolve`

`fmh rqgm evolve` runs an RQGM loop that self-improves the harness *scaffolding*
(`_COPY_SURFACE`) against an **executable** reward — `success_commands` (`python -m
pytest -q`) on the `rqgm_code` coding suite — instead of an LLM judge. It drives the
`rqgm` primitives directly with three real-world gates: proportional stepping-stone
sampling (no greedy collapse), a compile → cheap-canary → strong evaluation cascade
with a DE-anchored mutation operator + sha256 novelty gate, and a co-evolving but
anchored verifier (dual-split + discriminative anchor best-belief + EST invariance +
master-key rejection + subterfuge firewall + selective erasure on the frozen
`holdout/rqgm_code` anchor).

```bash
# Default: pick a real local agentic backend. If `codex` is on PATH, FMH auto-sets
# FMH_CODEX_CLI_CMD="codex exec --sandbox workspace-write --skip-git-repo-check --ephemeral".
# If not, it tries `claude` with FMH_CLAUDE_CODE_CMD="claude -p --permission-mode dontAsk".
fmh rqgm evolve --suite rqgm_code --holdout holdout/rqgm_code --budget 24 --json

# Explicit backend command when you want to pin the coding agent used for task solves:
FMH_CODEX_CLI_CMD="codex exec --sandbox workspace-write --skip-git-repo-check --ephemeral" \
  fmh rqgm evolve --backend codex_cli --suite rqgm_code --holdout holdout/rqgm_code --budget 24 --json

# Claude Code backend; `claude` also serves as the proposer CLI that edits scaffolding:
FMH_CLAUDE_CODE_CMD="claude -p --permission-mode dontAsk" \
  fmh rqgm evolve --backend claude_code --suite rqgm_code --holdout holdout/rqgm_code --budget 24 --json

# Promote the best scaffold into the repo iff it beats the seed on the held-out suite:
fmh rqgm evolve --backend auto --apply
```

- **Backend matters.** `rqgm evolve` now rejects `mock`, `9router`, and other
  single-shot backends. They cannot edit the task workspace, so they cannot test the
  paper's real self-improvement claim. Use `codex_cli`, `claude_code`,
  `subprocess_cli`, or the default `auto` resolver.
- **Two CLIs, two roles.** The `--backend` solves coding tasks and must be agentic
  (workspace-editing). The *proposer* (`claude` on PATH) edits the scaffolding. If
  `claude` is missing, `rqgm evolve` aborts instead of falling back to no-op evolution.
- **Cascade affordability** is task-count + reduced per-task budget (turns/wall-clock),
  not model tier — agentic CLIs bake the model into their launch command and ignore
  `--model`, so the cheap canary subset (not a cheaper model) is the real lever.
- **Fail-fast preflight:** non-agentic backends, missing launch commands, or missing
  proposer tooling abort before the loop, so a run cannot report a vacuous zero-delta
  "success."
- **Safety:** candidates physically cannot edit `FORBIDDEN_PATHS` (incl. the held-out
  anchor) via `check_paths`; the subterfuge firewall invalidates any episode that
  mutates a forbidden/holdout file; `--apply` is human-initiated and gated on a strict
  holdout gain. See `evals/rqgm_code/README.md` for the reward semantics.

## MCP Server

An MCP server is included for clients that prefer tool calls over the CLI (Claude Desktop, Cursor, Zed, etc.).

### Install

```bash
pip install -e .[mcp]
```

### Claude Desktop config

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pi-llm-as-verifier": {
      "command": "python",
      "args": ["C:/dev/Desktop-Projects/pi-llm-as-verifier/mcp_server.py"],
      "cwd": "C:/dev/Desktop-Projects/pi-llm-as-verifier"
    }
  }
}
```

Or using the installed entry point after `pip install -e .[mcp]`:

```json
{
  "mcpServers": {
    "pi-llm-as-verifier": {
      "command": "fmh-mcp"
    }
  }
}
```

### SSE transport (remote / web clients)

```bash
python mcp_server.py --transport sse --host 127.0.0.1 --port 8765
```

### Tools

| Tool | Description |
|---|---|
| `verifier_fusion_compare` | Swap-and-aggregate pairwise compare across candidates |
| `fmh compare candidate --a <id> --b <id>` | Same compare pipeline, run from the CLI on two stored candidates |
| `verifier_fusion_audit` | Single-candidate rubric scoring |
| `evaluate_verifier` | Accuracy + flag-recall report against a fixture suite |
| `run_task` | Full fusion pipeline from a TaskContract JSON file |
| `inspect_run` | Read any stored artifact from a completed run |
| `frontier` | List top candidates from the SQLite frontier index |
| `rqgm_search` | Red Queen Gödel Machine co-evolutionary search (provider `mock` or `fmh`) |

## Install

```bash
pi install npm:pi-llm-as-verifier
```

Or test without installing globally:

```bash
pi -e npm:pi-llm-as-verifier
```

## What it does

This package helps Pi choose among multiple candidate artifacts using:
- pairwise comparison
- criteria decomposition
- repeated verification
- round-robin winner selection

It supports three backends:
- `gemini-python` - Python runner inspired by the upstream paper/repo
- `zai-coding-plan` - single ZAI model through Pi's model registry
- `pi-model-ensemble` - multiple Pi models rotated across repeated attempts

## Tool usage

Use the `llm_as_verifier` tool with:
- `task`
- `candidates`
- `criteria`
- optional `context`
- optional `evidencePaths`
- optional `outputPath`

### Multi-model repeated attempts

For mixed-model verification, use:
- `backend: "pi-model-ensemble"`
- `models: ["openai:gpt-5.4", "google:gemini-2.5-flash", "minimax:MiniMax-M2.7-highspeed"]`

If `nVerifications` is omitted in ensemble mode, it defaults to `max(5, models.length)` so each configured verifier model gets coverage and the run still uses at least five samples.

### Weighted voting by model

For ensemble runs, you can bias some verifier models more strongly:

```json
{
  "backend": "pi-model-ensemble",
  "models": [
    "openai:gpt-5.4",
    "google:gemini-2.5-flash",
    "minimax:MiniMax-M2.7-highspeed"
  ],
  "modelWeights": [
    { "model": "openai:gpt-5.4", "weight": 1.5 },
    { "model": "google:gemini-2.5-flash", "weight": 1.0 },
    { "model": "minimax:MiniMax-M2.7-highspeed", "weight": 0.8 }
  ]
}
```

### Confidence reporting

Ensemble and ZAI-backed runs now return richer breakdowns in `details`, including:
- criterion confidence
- pairwise confidence
- disagreement scores
- per-model breakdowns
- weighted model metadata

### Example

```json
{
  "backend": "pi-model-ensemble",
  "task": "Choose the strongest patch for the bug fix.",
  "models": [
    "openai:gpt-5.4",
    "google:gemini-2.5-flash",
    "minimax:MiniMax-M2.7-highspeed"
  ],
  "modelWeights": [
    { "model": "openai:gpt-5.4", "weight": 1.3 },
    { "model": "google:gemini-2.5-flash", "weight": 1.0 },
    { "model": "minimax:MiniMax-M2.7-highspeed", "weight": 0.9 }
  ],
  "candidates": [
    {
      "id": "patch-a",
      "content": "..."
    },
    {
      "id": "patch-b",
      "content": "..."
    }
  ],
  "criteria": [
    {
      "name": "Correctness",
      "description": "Check whether the patch directly fixes the requested behavior."
    },
    {
      "name": "Requirements adherence",
      "description": "Check whether exact task constraints are satisfied."
    },
    {
      "name": "Empirical verification",
      "description": "Check whether the candidate is supported by concrete test or runtime evidence."
    }
  ]
}
```

## Prompt templates

This package also ships prompt templates:
- `/compare-patches`
- `/audit-candidate`
- `/ensemble-verifier`

These expand into ready-made instructions for common verifier workflows.

## Auth and setup

### Gemini Python backend

Install:

```bash
pip install google-genai
```

Provide one of:
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `VERTEX_API_KEY`

### Pi registry backends

For `zai-coding-plan` and `pi-model-ensemble`, configure model auth in Pi for whichever providers you want to use.

## Smoke tests

Python-runner smoke test:

```bash
/lav-smoke
```

Weighted ensemble smoke test:

```bash
/lav-ensemble-smoke
```

## Package contents

- `.pi/extensions/llm-as-verifier/index.ts`
- `.agents/skills/llm-as-verifier/SKILL.md`
- `.agents/skills/llm-as-verifier/scripts/lav_runner.py`
- `.agents/skills/llm-as-verifier/examples/code-patch-selection.json`
- `.agents/skills/llm-as-verifier/examples/weighted-ensemble-selection.json`
- `prompts/*.md`
- bundled references and examples
