# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff`: trigger path, oneshot generation, in-session compaction commit, persistence, and UI behavior.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.compact(focus, { mode: "handoff" })` lifecycle
- `SessionHandoff.generateDocument(...)` and `generateHandoffFromContext(...)` request shape and compatibility retry
- How the handoff document is committed as a compaction entry
- UI behavior for success, cancel, and failure

Does not cover:

- Generic tree navigation/branch internals
- Session commands (`/new`, `/fork`, `/resume`)

## Implementation files

- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/session/session-handoff.ts`](../packages/coding-agent/src/session/session-handoff.ts)
- [`src/session/session-maintenance.ts`](../packages/coding-agent/src/session/session-maintenance.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/agent/src/compaction/compaction.ts`](../packages/agent/src/compaction/compaction.ts)
- [`packages/agent/src/compaction/messages.ts`](../packages/agent/src/compaction/messages.ts) — method-specific handoff context wrapper
- [`packages/agent/src/telemetry.ts`](../packages/agent/src/telemetry.ts) — instrumented oneshot and transient retry
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)

## Trigger path

`/handoff [focus]` aliases `/compact handoff [focus]`. Both dispatch through the same compaction command handlers. The SDK selects the mode with `session.compact(focus, { mode: "handoff" })`.

## End-to-end lifecycle

### 1) Prepare the commit

`SessionMaintenance.compact()` snapshots the active branch and live messages instead of aborting the agent when the selected mode runs in the background. It uses the same `prepareCompaction(...)`, `session_before_compact` hook, and manual compaction lifecycle events as foreground modes. The preparation determines `firstKeptEntryId` and `tokensBefore`; a session with nothing to summarize does not start a provider request.

### 2) Generate the document

`SessionHandoff.generateDocument(focus, options)` supplies the document to the compaction pass:

- Requires a selected model and an API key/resolver for that model.
- Builds the handoff request through the **same side-request pipeline a live turn uses**, shared with ephemeral turns:
   1. Renders the handoff prompt (`renderHandoffPrompt(...)` with optional focus, after secret obfuscation) and appends it as an agent-attributed `user` message to the captured messages.
   2. Converts the snapshot with `convertMessagesToLlm(...)` for the handoff model (the snapcompact archive view that model may read, session `transformContext`, LLM conversion, and obfuscation).
   3. Builds provider `Context` with `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)` — normalized tools and provider-context transforms matching the loop. The base system prompt is pinned, so the committed summary does not inherit a per-turn `before_agent_start` override.
   4. Builds simple-stream options with the live provider cache key, a unique side `sessionId` (`<sid>:side:<snowflake>`), service tier/payload hooks, `preferWebsockets: false`, `initiatorOverride: "agent"`, and the abort signal.
- Obfuscates the final provider context and calls `generateHandoffFromContext(...)` through the host side-stream transport.
- Deobfuscates the returned handoff text.
- For auto-triggered generations with `compaction.handoffSaveToDisk`, writes a timestamped `handoff-*.md` artifact under the session's artifacts directory.

`generateHandoffFromContext(...)` lives in `packages/agent/src/compaction/compaction.ts` next to summarization. It issues an OTEL-instrumented `completeSimple`-equivalent oneshot against the caller-built `Context`, overriding the supplied stream options with clamped compaction reasoning, `toolChoice: "none"`, and `maxTokens: MAX_SUMMARY_TOKENS` (the summary output cap, so a server without its own limit cannot stream forever).

Before the oneshot, the prepared context (handoff instruction, system prompt, and tool schemas included) is counted locally against the model's context window (`countContextOverrun` in `packages/agent/src/output-budget.ts`). A request that leaves no room for the transport's minimum fitted output fails without network I/O. The count carries no tokenizer margin, so a near-full request is still sent.

If a provider rejects explicit `toolChoice: "none"` because it supports only automatic tool choice, the function retries once with `toolChoice: "auto"`. Tools remain present for cache-prefix compatibility, but returned tool-call blocks are ignored; only text blocks are joined.

Each tool-choice lane also opts into the shared transient oneshot retry policy (three attempts, 500ms base backoff, honoring provider retry timing). This is separate from the session's `auto_retry_*` lifecycle.

```ts
await generateHandoffFromContext(context, model, {
	streamOptions,
	completeImpl,
	telemetry,
	thinkingLevel,
});
```

`generateHandoff(messages, …)` remains exported for downstream callers. It constructs a basic context from `systemPrompt`, `tools`, and `convertToLlm`, then delegates to `generateHandoffFromContext`; coding-agent uses the context-aware function so host transforms, obfuscation, side-stream routing, and cache keys match live turns.

Important generation properties:

- The request shares the live provider cache prefix because the `Context` is built by the identical transform + normalization pipeline the loop uses, and routed with the same `promptCacheKey` the turn used.
- The handoff instruction is a trailing `user` message, not a developer message, so the cached prefix remains aligned with the prior turn (the trailing message is the only divergence point).
- `toolChoice: "none"` prevents intentional tool dispatch on normal providers; the compatibility retry uses `"auto"` only after an explicit-tool-choice rejection.
- Returned assistant content is filtered to text blocks and joined with `\n`; tool-call blocks are ignored.
- `stopReason === "error"` after the compatibility retry throws a generation error.

Capture is direct from the oneshot response; no agent-loop events or latest-assistant-message scan are involved.

### 3) Cancellation and validation

`abortCompaction()` or a caller's abort signal cancels generation or a prepared result waiting for its commit boundary. Cancellation raises `CompactionCancelledError` with the signal reason as `cause`; a provider failure without cancellation is reported as a failure. A positive `compaction.handoffTimeoutSeconds` (default `0`, off) aborts generation at that deadline as a failure (`Handoff timed out after Ns`), never a cancel, and discards any partial text. Missing content or a missing `## Goal` section rejects a manual compaction. Automatic maintenance can try the next configured method instead.

### 4) Commit as a compaction entry

The summary applies after the current turn and its tool results have been persisted, before the next provider call, or when the session is idle. If the snapshot is no longer on the active branch or a newer compaction or reset superseded it, the result is discarded.

The standard compaction commit:

1. Wraps the document as a compaction summary: `upsertFileOperations(document, readFiles, modifiedFiles, …)` appends the cumulative `<files>` tag from the preparation's file operations; `{ readFiles, modifiedFiles }` becomes the entry `details`.
2. Appends a regular `CompactionEntry` through `appendCompaction(summary, undefined, firstKeptEntryId, tokensBefore, options)`, with `details`, `fromExtension: false`, `method: "handoff"`, and a projected `tokensAfter` count.
3. Rebuilds the display context, replaces live agent messages, re-anchors stats (`rebaseAfterCompaction`), resets the plan reference, advisor runtimes (`"handoff"`), and todo phases, and closes provider sessions whose history was rewritten.
4. Emits the `session_compact` extension hook with the saved entry.
5. Returns a `CompactionResult`.

The session ID, session file, and provider prompt-cache key are unchanged. The commit retains everything from `firstKeptEntryId` onward, including messages that arrived while the handoff was running. When applying between tool turns, it also updates the live loop's context before its next request.

On LLM conversion, `method: "handoff"` selects `packages/agent/src/compaction/prompts/handoff-summary-context.md` instead of the generic compaction wrapper. This identifies the document as a prior agent instance's working context rather than fresh user instructions.

### Automatic handoff

Manual `/handoff` works regardless of the context-maintenance method order. To use this pipeline automatically, include `handoff` in `compaction.methodOrder` (the default order is `remote`, `snapcompact`, `handoff`, `shake`, `soft`). Threshold-triggered handoffs (post-turn, pre-prompt, mid-turn) and `incomplete` recovery generate and commit the document inline; a post-turn handoff completes before the run's `agent_end` settles. Input `overflow` skips handoff generation because the request would carry the same oversized input — but an already-armed speculative handoff result can still be applied during overflow recovery.

Async compaction (`compaction.asyncEnabled`) may also generate the handoff document speculatively in the pre-threshold band and commit it instantly when the threshold is crossed; see `docs/compaction.md`.

If auto generation returns no document, fails, or times out, maintenance advances to the next configured method. `compaction.handoffSaveToDisk` defaults to `false`; when enabled, only auto-triggered handoffs write the extra markdown artifact.

## Interactive behavior

The normal working row stays visible while the summary runs in the background. In the main view, `Esc` cancels the pending compaction without interrupting the live response. After a successful commit, the shared compaction UI rebuilds the transcript and preserves live tool and message components.
