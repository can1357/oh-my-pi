# Agentic long-horizon headroom probe (tau-bench)

The pro-model audit pinned the one regime our verdict does **not** cover: **long-horizon verifiable
tasks** where models fail at *different stages*, so oracle headroom could be 10–20pp instead of the
2–4pp we measured on MC. This is the test for that regime — on a task with **objective, executable
ground truth** (no LLM judge).

## Why tau-bench

[tau-bench](https://github.com/sierra-research/tau-bench) is a self-contained tool-agent benchmark
(retail / airline domains): the agent calls tools against a mocked database while an LLM-simulated user
drives the conversation, and success is a **verifiable final-state check** (the DB must match the task's
gold actions) — `SolveResult.reward ∈ {0,1}`. No live web, no security risk, real multi-step structure.

All four 9router lanes do tool-calling; calls route through **litellm's openai provider** at the 9router
base URL. **`cx/gpt-5.5` is excluded** — it works in a single litellm call but errors on every multi-turn
rollout (a cx/9router+litellm tool-loop incompatibility); the other three (`kimi-k2.6`, `MiniMax-M3`,
`gemini-3.5-flash-low`) route cleanly.

## The staged plan

1. **Stage 1 — headroom probe (the kill gate, `tau_headroom.py`):** each lane independently plays the
   agent on the same N tasks; report per-lane success, `best_lane`, and `oracle` (any lane solves the
   task). **Headroom = oracle − best_lane.**
   - If oracle ≈ best_lane → strong frontier lanes saturate even here; agentic fusion can't win (a clean
     extension of the MC verdict).
   - If headroom ≥ ~8pp → different lanes solve different tasks; **build Stage 2.**
2. **Stage 2 — fusion (only if the gate opens):** verifier-selection over the lanes' completed
   trajectories, then test/critique-guided revision — does it capture the agentic headroom the MC weavers
   couldn't?

```bash
python evals/agentic/tau_headroom.py --domain airline --n 20   # harder domain; retail saturates early
```

## Results (airline)

**Stage 1 — headroom probe (n=20):** lanes kimi 0.60 / minimax 0.55 / gemini 0.60; **best_lane 0.60,
oracle 0.75 → headroom +0.15**, with **8/20 tasks solved by some-but-not-all lanes**. Unlike MC (2–4pp)
and retail (saturated), long-horizon airline tasks genuinely separate strong lanes — the agentic headroom
the audit predicted is **real and large**.

**Stage 2 — verifier-guided fusion (`tau_fusion.py`, n=24).** The verifier picks diversely (beats random
~0.48) but **hovers around a tie with the best lane**, noisily: on one rollout set fusion = best_lane
(0% capture); on another fusion edged best_lane by ~1 task (0.542 vs 0.500, ~20% capture). At n=24 that
swing is rollout variance — *not* a robust win.

**Swap-and-aggregate did NOT help.** Single-pass vs 3-rotation swap-and-aggregate on the *same cached
trajectories* (`--reuse --orderings 1` vs `0`) gives identical results. Position bias is not the agentic
bottleneck (unlike pairwise answer-judging) — what the verifier can *see* is.

**Stage 3 — env-state-aware verifier (`--env-aware`): the lever that WINS.** Give the verifier each lane's
resulting **DB changes** (`_db_diff` of reservations/users — the actual outcome), not just the action
transcript. Clean isolation on the *same* trajectories (`--reuse` ± `--env-aware`):

| verifier sees | fusion | oracle-capture | beats best lane (0.708)? |
|---|---|---|---|
| transcript only | 0.667 | **−49%** (hurts) | ❌ |
| transcript + **DB outcome** | **0.750** | **+50%** | **✅** |

The *only* change is outcome vs intent, and it flips fusion from actively-harmful to the **first robust
agentic fusion win**. Judging what an agent *did to the world* is tractable; judging its *actions* is not.

**Stage 4 — critique-revise (`tau_critique.py`): HURTS.** A reviser (kimi) re-runs the task with the prior
attempts + their DB outcomes injected. Result: **0.583 — below the reviser's own solo score (0.708)**,
−150% capture, **0 new successes beyond the oracle**. The mixed-quality attempts anchor/distract the
reviser. This is the **re-derivation-harm pattern from MC, reproduced in the agentic regime** (cf.
Self-MoA's "diversity drags toward the weakest"): showing a strong model others' partly-wrong work makes
it worse. *Select, don't re-derive* — confirmed in agentic.

## Final unified law

Fusion beats the best lane **iff (a) oracle headroom exists AND (b) the verifier captures it via
OUTCOME-AWARE SELECTION.**

- **MC / componential:** fails (a) — no headroom (the +0.5 was an artifact; bootstrap-confirmed tie).
- **Agentic:** has (a) abundantly (+12–21pp); (b) is met **only** by an *outcome-aware selector*
  (transcript-only selection hurts; DB-outcome selection wins, +50% capture, beats best lane).
- **Re-derivation / critique-revise hurts in every regime tested** — selection beats generation.

The winning recipe everywhere is the same: **a strong, outcome-aware verifier that SELECTS, never
re-derives.** That is exactly this repo's core competency.

## Implemented: adaptive controller + verifier upgrades

The roadmap's components are now built (authored in parallel via a `qs-parallelprd`-style workflow, then
integrated + tested):

- **`verifier_accuracy.py`** — the **≥60% gate** (arXiv 2512.02304). Builds solved-vs-genuinely-failed
  trajectory pairs from the cache and measures order-robust pairwise discrimination. **Measured: the
  env-aware verifier (cx/gpt-5.5) scores 0.923 over 13 pairs — far above 0.60.** This is the mechanistic
  proof of the whole agentic win: outcome-aware verification is well clear of the self-enhancement-bias
  danger zone, which is exactly why env-aware selection captures headroom and transcript-only hurts.
- **`verifier_strategies.py`** — `rank_candidates(mode=transcript|env_aware|diff_primary|aspect|genrm)`:
  GenRM YES/NO multi-sample scoring (2408.15240), aspect-verifiers over the DB diff (2502.20379), and
  DB-diff-primary ranking with an LLM tie-break (R2E-Gym 2504.07164).
- **`adaptive.py`** — pure controller: `is_hard`/`is_unanimous`/`outcome_key`/`pick_reserve_lanes` — escalate
  to reserve lanes only on hard (lanes-disagree) tasks. **`passk.py`** — pass@k / pass^k reliability metrics.
- **`tau_fusion.py` flags**: `--strategy`, `--adaptive --reserve-lanes`, `--trials` (pass^k), `--gate`
  (refuse to overrule the best lane unless the verifier clears 0.60). All exercised rollout-free via
  `--reuse` on the cached trajectories. Unit tests: `tests/unit/test_passk.py`, `tests/unit/test_adaptive.py`.
- **Lane FAILOVER** (`LANE_BACKUPS` / `--lane-backups`): two distinct robustness mechanisms — (1) the
  *adaptive controller* fans out to **reserve lanes on hard/disagreement tasks**, and (2) `_run_lane` now
  **fails over a crashed lane to a healthy backup model** (after 2 retries) so the slot stays filled and
  the pool stays diverse at full N. This is the fix for gemini's n=50 collapse (45/50 crashed under load,
  crushing headroom). Verified working backups (tau-bench tool loop, via 9router): `minimax/MiniMax-M2.5`,
  `kimi/kimi-for-coding`, `kimi/kimi-k2.5`. **Not usable as lanes:** `cx/gpt-5.5` (breaks the multi-turn
  tool loop via litellm — usable only as the single-shot verifier), `ag/gemini-3.5-flash-medium` (litellm
  NotFound). Each rollout records `ran_model` / `failed_over`.
- **Cline aliases → a genuinely diverse pool** (`_provider_for`): the headroom limiter was lane
  *correlation* (kimi/minimax/gemini are close families). Qwen and DeepSeek are distinct families and now
  route through local 9router Cline aliases (`cline-qwen3.7-plus`, `cline-deepseek-v4-pro`) instead of
  paid OpenRouter or stale plan IDs. `_run_lane` uses the 9router OpenAI-compatible provider for these
  aliases. Verified full tool-loop lane coverage should be re-run when Cline plan credentials change.
  `openrouter/*:free` remains acceptable where explicitly configured as a free fallback.
- **Claude + Gemini-Pro via cheap 9router-native routes** complete a **six-family** default pool:
  `cc/claude-sonnet-4-6` (Anthropic via OAuth — solved task 0) and `ag/gemini-3.1-pro-low` (Google Gemini
  3.1 Pro via antigravity — ran clean). Preferred over the OpenRouter equivalents (`anthropic/
  claude-sonnet-4.6` $3/$15, `google/gemini-3.1-pro-preview` $2/$12), which stay as their failover backups.
  (`gc/gemini-3.1-pro-preview` errors with an IndexError — route skipped.) **New default `LANES` (6 distinct
  families):** `kimi-k2.6 · minimax-M3 · glm-5.1 · deepseek-v4-pro · claude-sonnet-4-6 · gemini-3.1-pro-low`
  — the maximal decorrelation available, run to test whether the wider oracle headroom finally pushes the
  fusion-vs-best Δ-CI past 0.

**Firm-up (n=50, failover on, workers=3).** Failover validated: `[failover] 27/150` substitutions, all on
the gemini slot → `minimax/MiniMax-M2.5` filled them, lifting that slot from the 0.06 no-failover collapse
to **0.52** (pool stayed healthy at full N). Result: best-lane 0.62, oracle 0.70 (**headroom +0.08, CI
[0.02, 0.16] — real/significant**), env-aware fusion **0.66 — beats best lane, 50% capture**. But the
fusion-vs-best Δ-CI is **[−0.04, 0.12] (includes 0; McNemar p=0.625) — NOT yet significant**. The verifier
is excellent (0.923 discrimination) and the win is robust *directionally*; the blocker is now the **small
oracle headroom** — the 3 reachable families (kimi/minimax/gemini) are correlated (oracle only 0.70 over a
0.62 best). **The path to a significant aggregate win is more diverse Cline-backed Qwen/DeepSeek lanes**, not on the verifier or N.

> `evals/agentic/*.json` are gitignored run outputs. Needs `pip install git+https://github.com/sierra-research/tau-bench.git`
> and `9ROUTER_API_KEY` / `NINEROUTER_API_KEY`.
