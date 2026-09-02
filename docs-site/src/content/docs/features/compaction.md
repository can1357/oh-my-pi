---
title: Compaction
description: How omp keeps long sessions usable by summarizing old history, plus how it retries around errors and overflow.
coverage: A
---

Compaction is how omp keeps long sessions working as the context window fills up. When the conversation gets too large, omp rewrites the older history into a summary that the model still sees, so you don't lose the work — you lose the exact words. From your point of view, the chat keeps scrolling and the agent keeps going.

## When compaction runs

You can trigger it yourself or let omp trigger it automatically:

| Trigger | How |
| --- | --- |
| Manual | `/compact [instructions]` — runs compaction now with optional focus instructions. |
| Overflow recovery | After an assistant error is detected as context overflow on the current model. |
| Incomplete-output recovery | After a same-model assistant message ends with `stopReason === "length"` (the response was cut off). |
| Threshold maintenance | After a successful turn whose adjusted context tokens exceed the resolved threshold. |
| Mid-turn maintenance | Before the next provider request when a tool-loop turn crosses the threshold (when `compaction.midTurnEnabled !== false`). |
| Idle maintenance | `runIdleCompaction()` runs the same auto-maintenance path with reason `"idle"` when the session is quiet and not streaming. |

The auto paths are intentionally distinct from manual `/compact`:

- **Overflow recovery** tries context promotion first (switching to a configured larger model if available) and otherwise runs context-full compaction with `reason: "overflow"` and `willRetry: true`, then schedules `agent.continue()` to retry the turn.
- **Incomplete-output recovery** also tries promotion first, but unlike overflow it allows `compaction.strategy: "handoff"` (overflow can't use handoff because the request itself already failed).
- **Threshold maintenance** uses `reason: "threshold"` and `willRetry: false`. With the handoff strategy it normally schedules a post-prompt auto-handoff instead of writing a compaction entry; pre-prompt and mid-turn checks still run inline. If `compaction.autoContinue !== false`, post-turn threshold maintenance also schedules an agent-authored developer auto-continue prompt.
- **Idle maintenance** uses `reason: "idle"` and never auto-continues.

When auto-compaction fails it surfaces as `Context overflow recovery failed: ...`, `Incomplete response recovery failed: ...`, or `Auto-compaction failed: ...`, depending on the path that triggered it.

## What survives compaction

The on-disk session is never destroyed. Compaction appends a `compaction` entry to the same session file, and context reconstruction rebuilds the LLM input as:

1. The compaction summary (one user-context message).
2. The kept messages from `firstKeptEntryId` to the compaction boundary.
3. Anything added after the boundary.

The TUI's display transcript is preserved separately — every path entry is still rendered in chronological order, with a slim divider (`── 📷 compacted · ctrl+o ──`) where each compaction fired. Expanding it reveals the summary. Only the LLM context resets at the boundary; what you can scroll back to stays intact, even across session resume.

Before summarization, omp prunes noisy tool output (replacing oversized results with `[Output truncated - N tokens]`) and elides "useless" results flagged by tools (replacing them with `[Uneventful result elided]`) when `compaction.dropUseless` is on. Skill results, active plan reads, and sub-floor results are protected by the default prune policy.

The summary itself contains a `<files>` tag listing the files touched during the summarized span, with `(Read)`/`(Write)`/`(RW)` markers and a 20-file cap (older summaries' `<read-files>`/`<modified-files>` tags self-heal on the next compaction).

## Strategies

`compaction.strategy` selects what the compactor actually does:

- `snapcompact` (default) — replaces the LLM summarization call with a local, deterministic archival pass that prints the discarded history onto bitmap images (model-aware frame dimensions). Safe for overflow recovery because it makes no model call. Falls back to context-full with a warning if the current model is not vision-capable. Manual `/compact` honors this strategy unless you pass custom instructions.
- `context-full` — the original LLM-summarize-the-history pipeline.
- `handoff` — generates a handoff document instead of writing a compaction entry; the document lands as a `custom_message` in a brand-new session (see [Sessions](/oh-my-pi/features/sessions/)). Used by post-turn threshold maintenance to start a fresh session without losing context.
- `shake` — additional supported strategy.
- `off` — disables automatic compaction (manual `/compact` still runs).

## Settings

Defaults from `settings-schema.ts`:

| Setting | Default | Description |
| --- | --- | --- |
| `compaction.enabled` | `true` | Master switch for automatic compaction. |
| `compaction.strategy` | `snapcompact` | `context-full`, `handoff`, `shake`, or `off` are also supported. |
| `compaction.reserveTokens` | unset | Tokens reserved for output and overhead when computing the threshold. When unset, the effective reserve is the larger of `16384` and 15% of the context window. |
| `compaction.keepRecentTokens` | `20000` | Tokens kept fresh on the most recent side of the cut. |
| `compaction.thresholdPercent` | `-1` | Override as a percentage of context window. |
| `compaction.thresholdTokens` | `-1` | Override as an absolute token count. With no positive override the threshold is `contextWindow - max(15% of contextWindow, reserveTokens)`. |
| `compaction.autoContinue` | `true` | Schedule an auto-continue prompt after threshold maintenance. |
| `compaction.midTurnEnabled` | `true` | Check the threshold mid-turn before the next provider request. |
| `compaction.remoteEnabled` | `true` | Allow remote summarization endpoints. |
| `compaction.remoteEndpoint` | `undefined` | Custom summarizer endpoint or OpenAI-compatible `/chat/completions` URL. |
| `compaction.idleEnabled` | `false` | Allow `runIdleCompaction()` to compact during quiet sessions. |
| `compaction.idleThresholdTokens` | `200000` | Minimum context size before idle maintenance kicks in. |
| `compaction.idleTimeoutSeconds` | `300` | Idle seconds before idle maintenance runs. |
| `compaction.dropUseless` | `true` | Blank useless tool results to `[Uneventful result elided]`. |
| `branchSummary.enabled` | `false` | When on, `/tree` navigation auto-summarizes the abandoned path into a `branch_summary` entry. |
| `branchSummary.reserveTokens` | `16384` | Tokens reserved for output when budgeting branch summaries. |

## Retry behavior for non-overflow errors

Overflow has its own path (above); everything else uses the standard API-error retry policy in `AgentSession`. The two paths are checked from the same `agent_end` event and intentionally don't overlap: context overflow is hard-excluded from retry classification so it falls through to compaction instead.

The retry engine re-issues the failing turn with capped exponential backoff:

| Setting | Default | Description |
| --- | --- | --- |
| `retry.enabled` | `true` | Master switch for automatic retry. |
| `retry.maxRetries` | `10` | Max retry attempts before giving up. |
| `retry.baseDelayMs` | `500` | Base delay before jitter; doubles each attempt. |
| `retry.maxDelayMs` | `300000` | Five-minute cap; if the provider's requested delay exceeds this and no credential/model switch is available, retry ends immediately. Set `<= 0` to disable the cap. |
| `retry.modelFallback` | `true` | Allow model fallback on retry. |
| `retry.fallbackChains` | — | Model-fallback chain definitions. |
| `retry.fallbackRevertPolicy` | `cooldown-expiry` | How the primary model returns after fallback. `"never"` disables automatic restoration. |

The default delay sequence before jitter is 500 ms → 1000 ms → 2000 ms → 4000 ms → 8000 ms (then capped at 8000 ms). Actual sleep is 75–100% of the nominal value. Stale OpenAI Responses replay errors skip backoff entirely after the cached provider session is reset; credential or model fallback switches force delay to `0`.

What gets retried: classifier refusals (`stopDetails.type` is `"refusal"` or `"sensitive"`), stale OpenAI Responses replay failures, transient transport/envelope errors, overloaded/rate-limit/usage-limit messages, 429/500/502/503/504-class failures, and network/connection/timeout wording. A `stopReason === "aborted"` with the generic abort sentinel and no in-progress user/dispose/streaming-edit abort is also retried, without model fallback.

What's excluded: anything that produced observable output before the stop (text, thinking, tool calls, redacted thinking, or a `STREAM_INTERRUPTED_AFTER_CONTENT` detail) — partially produced turns are not silently replayed. Context overflow is excluded and routed to compaction.

User controls:

- Press `Esc` while a retry loader (`Retrying (attempt/maxAttempts) in Ns…`) is visible to cancel.
- `session.abortRetry()` and the RPC `abort_retry` command cancel an in-flight retry chain.
- `session.setAutoRetryEnabled(false)` and the RPC `set_auto_retry` command toggle retry behavior at runtime.

Final failure surfacing: when retries exhaust, the session emits `auto_retry_end { success: false, finalError }`, the TUI shows `Retry failed after N attempts: <finalError>`, and RPC consumers receive the same event object on the stdout stream.
