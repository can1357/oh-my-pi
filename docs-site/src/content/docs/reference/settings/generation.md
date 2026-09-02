---
title: Settings — Generation
description: Sampling, thinking budgets, provider tiers, and retry/fallback chains.
coverage: A
sidebar:
  label: Settings — Generation
  order: 1
---

Settings that control how a turn is generated — what the model thinks, how it samples, which service tier it uses, and what happens when a request fails. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

::::note
Several sections in this page use a `Default` of `-1` to mean "use the provider or model default; `omp` does not send that parameter". This applies to every numeric sampling key and to a few integer triggers that opt into the reserve-based default.
::::

## Thinking

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultThinkingLevel` | enum | `high` | One of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. Override per run with `--thinking`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output. `--hide-thinking` sets it for the run (display only). |
| `thinkingBudgets.minimal` | number | `1024` | Token budget for the `minimal` level. |
| `thinkingBudgets.low` | number | `2048` | Token budget for `low`. |
| `thinkingBudgets.medium` | number | `8192` | Token budget for `medium`. |
| `thinkingBudgets.high` | number | `16384` | Token budget for `high`. |
| `thinkingBudgets.xhigh` | number | `32768` | Token budget for `xhigh`. |
| `thinkingBudgets.max` | number | `32768` | Token budget for `max`. |
| `providers.autoThinkingMaxEffort` | enum | `xhigh` | Highest effort `defaultThinkingLevel: auto` may resolve. `xhigh` keeps the classifier one tier below the top, so only `ultrathink` reaches `max`; `max` lets the classifier bill the top tier on models that expose it. The local on-device classifier stays capped at `xhigh` either way. This governs what `auto` *resolves*: a model whose ladder offers nothing under the ceiling gets no auto level at all, and one that also sets `thinking.requiresEffort` still receives its lowest supported effort from the transport — on a `["max"]` ladder that is `max`, because the model accepts nothing else. |

## Sampling

| Key | Type | Default | Description |
|---|---|---|---|
| `temperature` | number | `-1` | Sampling temperature. |
| `topP` | number | `-1` | Nucleus sampling. |
| `topK` | number | `-1` | Top-K sampling. |
| `minP` | number | `-1` | Minimum-probability cutoff. |
| `presencePenalty` | number | `-1` | Presence penalty. |
| `repetitionPenalty` | number | `-1` | Repetition penalty. |
| `tier.openai` | enum | `none` | One of `none`, `auto`, `default`, `flex`, `scale`, `priority`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. |
| `tier.anthropic` | enum | `none` | One of `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter). |
| `tier.google` | enum | `none` | One of `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex). |
| `tier.subagent` | enum | `inherit` | One of `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the spawned model's family; `inherit` tracks the main agent. |
| `tier.advisor` | enum | `none` | One of `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the advisor model's family. |
| `personality` | enum | `default` | One of `default`, `friendly`, `pragmatic`, `none`. |

## Retry and fallback

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    google-antigravity/*:
      - google/*
      - google-vertex/*
```

| Key | Type | Default | Description |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | Retry transient provider errors. |
| `retry.maxRetries` | number | `10` | Max retries per request. |
| `retry.baseDelayMs` | number | `500` | Initial backoff. |
| `retry.maxDelayMs` | number | `300000` | Backoff ceiling (5 min). |
| `retry.modelFallback` | boolean | `true` | Fall back to another model when one is unavailable. |
| `retry.usageAwareFallback` | boolean | `false` | Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded. |
| `retry.usageReservePct` | number | `10` | Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model. |
| `retry.usageReservePolicy` | enum | `confirm` | What to do when every same-provider coding-plan account is inside the reserve margin: `confirm` keeps interactive sessions on the primary until confirmed (background agents auto-fallback), `auto` always selects the next eligible configured fallback, `fail-closed` does not spend reserve quota or select a fallback. |
| `retry.fallbackChains` | record | `{}` | Maps roles, model selectors, or `provider/*` wildcards to ordered fallback selectors. Keys containing `/` are model-oriented and win over roles: `provider/model-id` matches that exact model, `provider/*` matches every model of the provider. A `provider/*` *entry* keeps the failing model's id and swaps the provider. The `default` chain covers every assigned role without its own chain. Unknown models/providers or malformed chains are reported as config warnings at startup. |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | One of `cooldown-expiry`, `never`. `cooldown-expiry` returns to the primary model once its suppression window ends; `never` stays on the fallback until switched manually. |

When the active model keeps failing (429s, quota walls, provider outages) and `retry.modelFallback` is on, the session picks the chain that owns the failing model, by specificity: an exact `provider/model-id` key, then a `provider/*` wildcard, then the current role's chain, then `default`. It skips models whose selectors are still cooling down and switches for the rest of the turn. Subagents get their own per-spawn chains when their agent definition lists multiple model patterns — the first resolvable pattern is primary and the rest become its fallbacks; there is no `agent:<name>` key in `fallbackChains`.
