# Cost / Performance Tuning

Per-session levers for trading cost, latency, and intelligence — ranked by leverage, with exact settings, defaults, and tradeoffs so you can opt in deliberately.

**There is no free lunch across all four.** Prompt caching is free in both cost and intelligence; everything else trades something. Pick the levers that match your workload.

## TL;DR — leverage vs. tradeoff

| # | Lever | Cost | Speed | Intelligence risk | Default | Setting |
|---|---|---|---|---|---|---|
| 1 | Prompt caching (append-only context) | large ↓ | large ↓ | none | **on (`auto`)** | `provider.appendOnlyContext` |
| 2 | Fusion model-routing | large ↓ (~35%) | small ↓ | **real** on judgment work | **off** | `fusion.enabled` |
| 3 | Thinking / reasoning budgets | medium ↓ | medium ↓ | low if tuned | `auto`, untuned | `thinkingBudgets.*` |
| 4 | Compaction + cache-aware pruning | medium ↓ | medium ↓ | low | **on** | `compaction.*` |
| 5 | Static context trim / defer-loading | small ↓ | small ↓ | none | partial | (code-level) |
| 6 | Inference acceleration | — | large ↓ (potential) | unverified | **off (experimental)** | `acceleration.*` |

**Per-turn cost** ≈ `Σ tokens × price(model) × (1 − cache_hit_rate)` plus reasoning-token latency. Levers 1–2 dominate; 5 is the smallest.

---

## 1. Prompt caching — the free win (already on)

Append-only context caches the system prompt + tool specs and keeps an append-only message log, so provider prefix caches (Anthropic, DeepSeek, Xiaomi/SGLang) hit at maximum rate. Cache hits cut **both** cost and prefill latency, with zero intelligence loss.

- **Setting:** `provider.appendOnlyContext` — `"auto"` (default, enables for known prefix-cache providers) | `"on"` | `"off"`.
- **Recommendation:** leave `"auto"`. Set `"on"` only if your provider supports prefix caching but isn't auto-detected.
- **Watch misses:** `display.cacheMissMarker` renders a divider above any turn that lost the cache — use it to spot churn (a churny system prompt or tool set busts the cache and silently inflates cost).
- **Cache-aware pruning** (on by default): `compaction.supersedeReads` (drops older reads of re-read files every turn) and `compaction.dropUseless` (drops no-match / timed-out tool results once consumed) keep the prefix stable without manual pruning.

This is the highest-leverage lever and it's maximized by default. Don't touch it unless you're debugging a cache-miss storm.

---

## 2. Fusion model-routing — the biggest unrealized cut (~35%)

Devin-Fusion: a frontier main agent + a cheap persistent **sidekick**, each with its own cached context; the main agent delegates settled mechanical work and keeps the plan / ambiguity calls / final review. Dynamic routing switches models **at compaction boundaries** (where the cache is already invalidated, so the switch is free). Spec: <https://cognition.com/blog/devin-fusion>.

This is the blog's headline ~35% cost cut — but it is **opt-in** (`fusion.enabled: false`) because delegation has a real intelligence cliff: on judgment-heavy work, offloading the coding loses the subtle intent (the blog's own data: a React/Redux team-selector task scored 27 delegated vs 54 solo).

**Settings (all default off / empty):**

| Setting | Default | Effect |
|---|---|---|
| `fusion.enabled` | `false` | Master toggle. |
| `fusion.mode` | `"escalate"` | `delegate` (prompt-driven offload) or `escalate` (cheap-first, escalate hard work to frontier). |
| `fusion.sidekickModel` | `"pi/smol"` | Cheap model the sidekick runs. |
| `fusion.compactModel` | `""` | Cheaper main-model tier switched in at each compaction. Empty = disabled. |
| `fusion.dynamicRouting` | `false` | Run a lightweight classifier at each compaction to pick the main-model tier for the next stretch. |
| `fusion.sidekickStrongModel` | `""` | Independent sidekick re-tier on hard stretches (recommended `pi/task`). Empty = disabled. |
| `fusion.escalateFailureStreak` | `3` | Force-escalate a downgraded main back to frontier after N consecutive tool failures (0 = disabled). |
| `fusion.sidekickRequestBudget` | `0` | Hard cap on sidekick model-requests per delegated turn (0 = unlimited). |
| `fusion.modelPool` | `[]` | `"<tier>=<selector>"` entries (tier 1=strongest … 5=weakest) for tiered routing. |

**Recommendation:** enable only for cost-sensitive, mechanical-heavy workloads, and always set `fusion.escalateFailureStreak` (≥3) + `fusion.sidekickRequestBudget` as guardrails. Toggle interactively with `/fusion`. Keep it off for hard/judgment tasks where the intelligence cliff bites. Implementation: `src/session/fusion-{router,sidekick}.ts`, `src/prompts/fusion/`. See `docs/fugu-router-beats-frontier.md` for the separate 9router-based benchmark routing (distinct from per-session Fusion).

---

## 3. Thinking / reasoning budgets

Reasoning tokens are billable and add latency. For mechanical turns they're wasted; for hard reasoning they're essential.

- **Settings:** `thinkingBudgets.{minimal,low,medium,high,xhigh}` — defaults `1024 / 2048 / 8192 / 16384 / 32768`.
- **Per-session level:** thinking level is `auto` by default (a difficulty classifier picks the budget).
- **Recommendation:** leave `auto`. For purely mechanical sessions, lower the effective budget (`thinking` level `low`/`minimal`) to cut both cost and latency. When Fusion is on, mechanical work is already routed to the cheap sidekick (lower thinking), so this is partially covered.

---

## 4. Compaction

Compaction summarizes old context to keep the turn under the context window. Triggering it invalidates the cache — which is exactly why Fusion does its model switch there (free). See `docs/compaction.md` for full detail.

- **Settings:** `compaction.enabled` (default `true`), `compaction.strategy` (default `"context-full"`), `compaction.thresholdTokens` (default `-1` = auto from context window), `compaction.keepRecentTokens` (20000), `compaction.reserveTokens` (16384), `compaction.autoContinue` (true).
- **Recommendation:** leave defaults. The cache-aware pruning (`supersedeReads`, `dropUseless`) is where the day-to-day cost saving lives; full compaction is the safety net.

---

## 5. Static context trim / defer-loading (code-level)

Tool-prompt prose and skill/memory blocks contribute a fixed per-turn token cost. Current state (already applied): tool prompts trimmed ~−5.4k bytes (~−1.3k tokens); `mnemopi.injectionTokenLimit` default lowered 5000→2000 with a per-item recall cap; agent-roster descriptions truncated to ≤300 chars; skills **never** injected into the system prompt (purely on-demand via `read skill://?q=`).

**Next step (architectural, cache-safe): defer-loading.** Load a tool's full schema only when the model invokes it, keeping the system-prompt prefix byte-identical across turns so the cache stays warm. Extends the existing `skill://?q=` on-demand shape to heavy tool-schema blocks (`task`, `eval`, `browser`). No intelligence loss; modest further saving.

---

## 6. Inference acceleration (experimental, off)

Speculative decoding / lookahead reasoning in front of the streaming path. Latency lever, not a cost lever. **Not verified** against any provider in this repo (no next-token logprobs in the public API), so it falls back to baseline. See `docs/acceleration.md`.

- **Setting:** `acceleration.enabled` (default `false`). **Do not enable without testing** — every mode currently emits a baseline-equivalent response.

---

## Decision guide

- **Want max intelligence, cost no object:** defaults minus Fusion. Caching is already on; everything else is conservative.
- **Cost-sensitive, mostly mechanical work:** enable Fusion (`mode: escalate`, `dynamicRouting: on`, set `compactModel`, guardrails on), lower thinking on mechanical sessions.
- **Want lower latency, can't risk intelligence:** ensure `provider.appendOnlyContext: auto` (cache = free latency), lower thinking budgets for mechanical turns, consider `acceleration` only after testing.
- **Maximizing everything at once is impossible.** Cache is free; Fusion costs average intelligence; acceleration is unverified. Optimize per workload.
