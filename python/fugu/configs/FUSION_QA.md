# Fusion targeting Q&A

A tiny questionnaire that turns "what's my task?" into a concrete fusion config — **which weaver to use
and which specific models to run** — encoding everything this repo measured. One spec
(`configs/fusion_qa.yaml`) drives a CLI for humans and a JSON contract for agents.

## The one rule it encodes

> Fusion beats the best single lane **iff (a) oracle headroom exists AND (b) an outcome-aware verifier
> *selects* it.** Otherwise **route the best lane**. Selection beats re-derivation; debate/critique-revise hurt.

So the Q&A's job is to detect *which regime you're in* and route you to fuse-by-selection, fuse-by-synthesis,
or just-use-the-best-model.

## 4 questions → a recommendation

| # | question | why it matters |
|---|---|---|
| `regime` | single-answer / open-ended / **agentic** / code | agentic + code are where real headroom lives |
| `signal` | ground-truth / checklist / **subjective** | no objective signal ⇒ "wins" are judge-bias |
| `diversity` | several families / minor variants | correlated lanes ⇒ no headroom ⇒ don't fuse |
| `priority` | cost / balanced / quality | route vs fuse vs full |

Decision table (first match wins):

| answers | decision | models |
|---|---|---|
| `signal=subjective` | **caution** — single strong model | `cx/gpt-5.5` |
| `diversity=low` | **don't fuse** (no headroom) | best single |
| `regime=agentic` | **FUSE — outcome-aware *selection*** | 6-family pool `kimi-k2.6 / minimax-M3 / cline-qwen3.7-plus / cline-deepseek-v4-pro / claude-sonnet-4-6 / gemini-3.1-pro-low` (+failover), verifier `cx/gpt-5.5`, `--strategy diff_primary --gate` |
| `regime=code` | **FUSE — best-of-N, select by tests** | `kimi-for-coding / cline-qwen3.7-plus / cline-deepseek-v4-pro` |
| `regime=open` | **FUSE — synthesize** (only if lanes are *partial*) | `explore` lanes + synthesizer `cx/gpt-5.5` |
| `regime=mc` | **route / select best lane** (fusion only ties) | `cx/gpt-5.5` |

Model notes: `cx/gpt-5.5` is strong but **breaks multi-turn tool loops** → synthesizer/verifier only, never a
lane. The agentic pool spans six families: Qwen + DeepSeek via local 9router Cline aliases (`cline-*`),
Claude (`cc/`) + Gemini-3.1-Pro (`ag/`) via 9router. Use the `cline-*` ids for Cline-backed routes.

## Cost & pool-size knobs

The `priority` answer maps to concrete controls merged into any FUSE recommendation (`cost_profiles` in the
spec), so you can trade cost against oracle headroom:

| priority | `--n-lanes` | `--workers` | `--budget` (USD) |
|---|---|---|---|
| cost | 2 | 4 | 2 |
| balanced | 3 | 3 | 10 |
| quality | 0 (all) | 3 | 0 (no cap) |

`tau_fusion.py` enforces them: `--n-lanes K` uses the first K of the pool, `--budget USD` stops launching new
tasks once measured spend (litellm `total_cost`) hits the cap, and every run reports `total_cost_usd` +
`cost_per_lane`. Fewer lanes = cheaper but narrower headroom — that's the trade the dial exposes. The CLI fills
these into the `Run:` command automatically.

## Humans / CLI

```bash
python -m harness.cli.fusion_qa                                   # interactive
python -m harness.cli.fusion_qa --answers regime=agentic,signal=ground_truth,diversity=high
```

It prints the decision, the resolved model list, the things to avoid, and a ready-to-run launch command
(e.g. `python evals/agentic/tau_fusion.py --domain <env> --env-aware --strategy diff_primary --gate …`).

## Agents / plugins / skills

The spec is the contract — an agent QAs the user without hard-coding anything:

```bash
python -m harness.cli.fusion_qa --json        # -> {questions, models, recommendations}
```

1. Read `questions`; ask the user each one (e.g. via the host's multiple-choice UI), collecting `{id: key}`.
2. Get the config back, either by calling the engine directly
   (`from harness.cli.fusion_qa import load_spec, recommend; recommend(answers, load_spec())`)
   or `python -m harness.cli.fusion_qa --answers <id=key,...> --out-json`.
3. Launch fusion with the returned `lanes` / `verifier` / `strategy` (or surface the `command`).

Because both paths share `configs/fusion_qa.yaml`, updating the questions, model pools, or rules in that one
file changes the CLI and every agent at once. Tests pin the key branches: `tests/unit/test_fusion_qa.py`.
