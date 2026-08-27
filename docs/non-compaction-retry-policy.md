# Non-compaction auto-retry policy

This document describes the standard API-error retry path coordinated by `AgentSession` and implemented by `TurnRecovery`.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`compaction.md`](./compaction.md).

## Implementation files

- [`../packages/coding-agent/src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../packages/coding-agent/src/session/turn-recovery.ts`](../packages/coding-agent/src/session/turn-recovery.ts) — retry classification, backoff, credential rotation, and model fallback
- [`../packages/coding-agent/src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)
- [`../packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-client.ts`](../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../packages/coding-agent/src/modes/rpc/rpc-types.ts`](../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` path, but they are intentionally separated:

1. `agent_end` inspects the last assistant message.
2. `TurnRecovery.isRetryableError(...)` runs before ordinary compaction recovery.
3. If retry is initiated, compaction checks are skipped for that turn.
4. Context-overflow errors are excluded from retry classification by `AIError.isContextOverflow(...)`.
5. Overflow therefore reaches `SessionMaintenance.checkCompaction(...)` instead of the standard retry.

So: overload/rate/server/network-style failures use this retry policy; context-window overflow uses compaction recovery.

## Retry classification

`TurnRecovery.isRetryableError(...)` requires all of the following:

- assistant `stopReason === "error"`
- message is **not** context overflow
- one of:
  - the stop is a classifier refusal (`stopDetails.type` is `"refusal"` or `"sensitive"`)
  - the error is a stale OpenAI Responses replay failure
  - the normalized `AIError` classification is retryable (including transient transport/provider failures and usage limits)

Retry classification runs through `AIError.classifyMessage(...)`, using the persisted `errorId`/status when present and augmenting it from provider-aware message classification. It is not solely a regex policy, although legacy/string-only provider failures still use text classification.

The stale-replay and retryable-error branches additionally require that the stream did **not** already emit replay-unsafe output. Non-empty visible text, images, tool calls, and Anthropic server-tool blocks prevent replay. Thinking-only and whitespace-only partials are safe to discard and retry. Classifier refusals are subject to the same replay-safety check.

Current retryable categories include:

- transient transport/envelope failures, including Anthropic stream-envelope failures before `message_start`
- overloaded/provider-returned-error wording
- rate limit / usage limit / too many requests
- HTTP-like server classes: 429, 500, 502, 503, 504
- service unavailable / server/internal error
- provider-suggested retry wording, including OpenAI `retry your request` failures
- network/connection/socket failures, refused/closed connections, upstream connect/reset-before-headers, socket hang up, timeout/timed out, fetch failed, terminated, retry delay wording, and unexpected socket close messages

The normalized classifier recognizes the transient categories above from structured flags/status and provider-aware text patterns. Classifier refusals remain a separate typed `stopDetails` decision.

Beyond `isRetryableError(...)`, empty generic aborts may enter the same retry engine when no user, dispose, or streaming-edit-guard abort is in progress. An interrupted turn whose tool calls already have matching results can also be continued safely: the failed assistant/tool-result sequence is preserved so completed side effects are not replayed. Resolved stream stalls and HTTP/2 stream resets (`NGHTTP2_INTERNAL_ERROR`, `NGHTTP2_REFUSED_STREAM`, `HTTP2StreamReset`) use the same preserve-and-continue path. Cursor idle-stall recovery continues after every emitted tool call has a result; the Connect stream is already closed by the idle abort. An HTTP/2 RST is the same: the stream is already dead.

Retry state is owned by `TurnRecovery`:

- retry attempt counter (`0` means idle)
- retry lifecycle promise and resolver
- retry backoff abort controller

Flow (`#handleRetryableError`):

1. Read the `retry` settings group and stop when retry is disabled (except the intrinsic one-shot Fireworks Fast-to-base fallback).
2. Increment the retry attempt and create the shared retry lifecycle promise on the first attempt.
3. Calculate whether the current model's retry budget is exhausted.
4. Classify the error, parse retry timing, and compute capped jittered backoff: `min(retry.baseDelayMs * 2^(attempt-1), 8000ms) * (75–100% jitter)`. Stale OpenAI Responses replay errors reset the provider session and use delay `0`.
5. For usage limits, apply a successful credential switch or banked Codex reset immediately; otherwise wait for the earlier of the provider hint and the next temporarily blocked sibling credential.
6. When allowed, consult configured model fallback chains. A switch uses delay `0`; classifier refusals only continue when a fallback is applied.
7. If the current model's retry budget is exhausted, stop unless a fallback model was found. A fallback receives a fresh retry budget.
8. If the final delay exceeds `retry.maxDelayMs` and no credential/model switch happened, emit final failure without sleeping.
9. Emit `auto_retry_start`, record the recoverable error, and remove the failed assistant from active context unless this is a resolved interrupted tool turn.
10. Sleep with abort support, then schedule `agent.continue()` through the post-prompt task scheduler for the same prompt generation.

### What resets retry counters

`#retryAttempt` resets to `0` in these cases:

- first successful non-error, non-aborted assistant message after retries started (emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path
- max delay exceeded path
- classifier refusal or hard error with no fallback model applied
- a later error settles without retry or compaction continuation

The retry promise resolves and clears whenever the chain ends.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `10`)
- `retry.baseDelayMs` (default `500`)
- `retry.maxDelayMs` (default `300000`, 5 minutes; `<= 0` disables the fail-fast cap)

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#retryAttempt - 1` (last attempted retry count)

Backoff sequence with default settings, before jitter:

- attempt 1: 500 ms
- attempt 2: 1000 ms
- attempt 3: 2000 ms
- attempt 4: 4000 ms
- attempt 5+: 8000 ms

The actual local sleep is 75–100% of the nominal value, matching Anthropic-style retry jitter so concurrent sessions do not retry in lockstep.

Delay override inputs can come from parsed retry headers (`retry-after-ms`, `retry-after`, `x-ratelimit-reset-ms`, `x-ratelimit-reset`) or usage-limit backoff. Credential/model fallback switches set delay to `0`; otherwise parsed hints can extend the capped local delay. If the computed delay is greater than `retry.maxDelayMs` and no switch succeeded, retry ends immediately with a final error instead of sleeping.

## Abort mechanics

### Explicit retry abort

`abortRetry()`:

- aborts `#retryAbortController` (if present)
- resolves retry promise (`#resolveRetry()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController (`#handleAutoRetryStart`):

- stops the working loader and clears the status container
- renders a `retryLoader` with text: `Retrying (attempt/maxAttempts) in Ns… (esc to cancel)`

`Esc` cancellation dispatches on live session state rather than a swapped handler: the input controller checks `viewSession.isRetrying` and calls `viewSession.abortRetry()` (alongside its compaction/handoff abort checks).

On `auto_retry_end` (`#handleAutoRetryEnd`), it stops and clears the `retryLoader` and status container.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForPostPromptRecovery()` after `agent.prompt(...)` returns; that loop awaits the retry lifecycle promise alongside TTSR resume and deferred post-prompt tasks.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and RPC

### Configuration knobs

Defined in settings schema under retry group:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.modelFallback` (default `true`; gates retry model-fallback switching)
- `retry.fallbackChains`
- `retry.fallbackRevertPolicy` (`"cooldown-expiry"` by default; `"never"` disables automatic restoration)
- `retry.usageAwareFallback` (default `false`; runs a preflight for supported coding-plan usage reports)
- `retry.usageReservePct` (default `10`; remaining-quota reserve threshold)
- `retry.usageReservePolicy` (default `"confirm"`; `"auto"` and `"fail-closed"` are also supported)

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether retry lifecycle promise is active

### RPC controls

RPC command surface:

- `set_auto_retry` → `session.setAutoRetryEnabled(command.enabled)`
- `abort_retry` → `session.abortRetry()`

Client helpers:

- `RpcClient.setAutoRetry(enabled)`
- `RpcClient.abortRetry()`

## Event emission and failure surfacing

Session-level retry events:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, errorId? }`
- `auto_retry_end { success, attempt, finalError?, recoveredErrors? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- in RPC mode, forwarded directly as JSON event objects (`session.subscribe(event => output(event))`)
- in TUI, consumed by `EventController` for loader/error UI

Final failure surfacing:

- On max-exceeded, max-delay failure, or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>`
- Extensions/hooks receive `auto_retry_end` with same fields
- RPC consumers receive same event object on stdout stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries are exceeded and no fallback model is available
- provider-requested delay exceeds `retry.maxDelayMs` and no credential/model switch is available
- user cancels retry (`abort_retry` or `Esc` during retry loader)
- global abort (`abort`) cancels retry first

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Classification uses normalized `AIError` flags/status plus provider-aware text fallback; it is not limited to structured errors or to regex matching alone.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry.
- `RpcSessionState` currently exposes `autoCompactionEnabled` but not an `autoRetryEnabled` field; RPC callers must track their own toggle state or query settings through other APIs.
- Model fallback changes append temporary `model_change` entries and may later restore the primary model when its cooldown expires, depending on `retry.fallbackRevertPolicy`.
- Usage-aware fallback runs before a provider request when both `retry.modelFallback` and `retry.usageAwareFallback` are enabled. Unknown/unmapped usage fails open. At the reserve threshold, `"confirm"` asks interactive sessions and keeps the current model when declined; sessions without a confirmation UI automatically apply an eligible configured fallback. `"auto"` applies an eligible fallback without asking. `"fail-closed"` rejects reserve or depleted usage instead of spending it or selecting a fallback. Depleted usage under the other policies applies an eligible fallback without a reserve confirmation.
