# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff`: trigger path, oneshot generation, in-session compaction commit, persistence, and UI behavior.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.handoff()` → `SessionMaintenance.handoff()` lifecycle
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
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)

## Trigger path

1. `/handoff` is declared in the builtin slash-command registry with optional inline hint `[focus instructions]`.
2. The registry's TUI handler clears the editor and calls `handleHandoffCommand(customInstructions?)`.
3. `CommandController.handleHandoffCommand` refuses while the current response is streaming, then counts `type === "message"` entries.
4. If the count is `< 2`, it warns `Nothing to hand off (no messages yet)` and returns.

The same minimum-content guard exists inside `SessionMaintenance.handoff()` and throws if violated. RPC separately refuses a handoff while streaming. Direct SDK callers must avoid invoking the session method during an active response.

## End-to-end lifecycle

### 1) Prepare the commit

`AgentSession.handoff()` delegates to `SessionMaintenance.handoff(customInstructions?, options?)`:

- Throws `Compaction already in progress` while manual or automatic maintenance is active, and cancels any background speculative compaction.
- Reads the current branch, validates at least two message entries, and runs `prepareCompaction(...)` with the handoff method settings to compute `firstKeptEntryId` and `tokensBefore`; an empty preparation (e.g. right after a compaction) throws `Nothing to hand off (already compacted)`.

### 2) Generate the document

`SessionHandoff.generateDocument(customInstructions?, options?)` owns generation and the abort controller (`isGeneratingHandoff`):

- Requires a selected model and an API key/resolver for that model.
- Builds the handoff request through the **same side-request pipeline a live turn uses**, shared with ephemeral turns:
  1. Renders the handoff prompt (`renderHandoffPrompt(...)` with optional focus, after secret obfuscation) and appends it as an agent-attributed `user` message to a snapshot of `agent.state.messages`.
  2. Converts the snapshot with `convertMessagesToLlm(...)` (session `transformContext`, LLM conversion, and obfuscation).
  3. Builds provider `Context` with `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)` — normalized tools and provider-context transforms matching the loop. The base system prompt is pinned, so the committed summary does not inherit a per-turn `before_agent_start` override.
  4. Builds simple-stream options with the live provider cache key, a unique side `sessionId` (`<sid>:side:<snowflake>`), service tier/payload hooks, `preferWebsockets: false`, `initiatorOverride: "agent"`, and the abort signal.
- Obfuscates the final provider context and calls `generateHandoffFromContext(...)` through the host side-stream transport.
- Deobfuscates the returned handoff text.
- For auto-triggered generations with `compaction.handoffSaveToDisk`, writes a timestamped `handoff-*.md` artifact under the session's artifacts directory.

`generateHandoffFromContext(...)` lives in `packages/agent/src/compaction/compaction.ts` next to summarization. It issues an OTEL-instrumented `completeSimple`-equivalent oneshot against the caller-built `Context`, overriding the supplied stream options with clamped compaction reasoning and `toolChoice: "none"`.

If a provider rejects explicit `toolChoice: "none"` because it supports only automatic tool choice, the function retries once with `toolChoice: "auto"`. Tools remain present for cache-prefix compatibility, but returned tool-call blocks are ignored; only text blocks are joined.

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

### 3) Cancellation checks

An explicit user cancellation throws `Error("Handoff cancelled")`. Harness-initiated aborts preserve a supplied reason, or surface `Handoff aborted by session` when none is supplied. A manual handoff whose generation is empty/whitespace-only throws `Handoff generation produced no content`; auto-handoff returns `undefined` so maintenance can advance to the next configured method.

- caller signal aborts the handoff controller and forwards its reason
- `completeSimple(...)` receives the abort signal
- direct `abortHandoff()` or an unreasoned caller signal is normalized to `Error("Handoff cancelled")`
- harness abort reasons and provider failures (including provider `AbortError`s) surface verbatim

`SessionHandoff.generateDocument()` always clears the abort controller in `finally`.

### 4) Commit as a compaction entry

If text was generated and not aborted, `SessionMaintenance.handoff()` commits the document on the **current** session:

1. Wraps the document as a compaction summary: `upsertFileOperations(document, readFiles, modifiedFiles, …)` appends the cumulative `<files>` tag from the preparation's file operations; `{ readFiles, modifiedFiles }` becomes the entry `details`.
2. Appends a regular `CompactionEntry` (`appendCompaction(summary, undefined, firstKeptEntryId, tokensBefore, details, false, undefined)`).
3. Rebuilds the display context, replaces live agent messages, re-anchors stats (`rebaseAfterCompaction`), resets the plan reference, advisor runtimes (`"handoff"`), and todo phases, and closes provider sessions whose history was rewritten.
4. Emits the `session_compact` extension hook with the saved entry.
5. Returns `{ document, savedPath? }`.

The session id, session file, transcript scrollback, and provider prompt-cache key are all unchanged. Recent history from `firstKeptEntryId` onward is kept verbatim, exactly like every other compaction method; only the summarized prefix is replaced by the document.

### Automatic handoff

Manual `/handoff` works regardless of the context-maintenance method order. To use this pipeline automatically, include `handoff` in `compaction.methodOrder` (the default order is `remote`, `snapcompact`, `handoff`, `shake`, `soft`). Normal threshold-triggered handoffs defer document generation to a post-prompt task; pre-prompt, mid-turn, and `incomplete` recovery run inline. Input `overflow` skips handoff generation because the request would carry the same oversized input — but an already-armed speculative handoff result can still be applied during overflow recovery.

Async compaction (`compaction.asyncEnabled`) may also generate the handoff document speculatively in the pre-threshold band and commit it instantly when the threshold is crossed; see `docs/compaction.md`.

If auto generation returns no document, maintenance advances to the next configured method. `compaction.handoffSaveToDisk` defaults to `false`; when enabled, only auto-triggered handoffs write the extra markdown artifact.

## Controller/UI behavior

`CommandController.handleHandoffCommand` behavior:

- Refuses with a warning when `session.isStreaming` (matches `/fork` and `/move`) — the user must finish or abort the response before handing off.
- Shows a status loader: `Generating handoff… (esc to cancel)`.
- Calls `await session.handoff(customInstructions)`.
- If result is `undefined`: `showError("Handoff cancelled")`.
- On success:
  - clears transient session UI and re-renders the session, which now shows the handoff compaction divider
  - invalidates status line and editor border
  - reloads todos
  - appends `Context handed off and compacted in place`
  - shows `savedPath` when the result includes one (manual `/handoff` normally has none)
- On exception:
  - if message is `"Handoff cancelled"`: `showError("Handoff cancelled")`
  - otherwise: logs the error and calls `showError("Handoff failed: <message>")`
- Stops the loader, clears the status container, and requests render at end.

Manual `/handoff` does not stream the generated document into chat. A cancellable loader remains visible while the oneshot request runs, and the chat is rebuilt after the commit completes.

## Cancellation semantics

### Session-level cancellation primitive

`AgentSession` exposes:

- `abortHandoff()` → aborts the generation controller
- `isGeneratingHandoff` → true while generation is in flight

Direct `abortHandoff()` passes an unreasoned abort signal to `completeSimple(...)`; generation normalizes it to `Error("Handoff cancelled")`, and command controller maps it to cancellation UI. `AgentSession.abort(...)` instead aborts the handoff first with its harness reason (or `Handoff aborted by session`), so subsequent compaction cancellation cannot mask that failure as a user cancellation.

### Interactive `/handoff` path

`InputController`'s global `editor.onEscape` handler dispatches on live session state instead of swapping handlers: while `isGeneratingHandoff` is true, pressing Escape calls `session.abortHandoff()`, which aborts the `completeSimple(...)` request.

## Aborted vs failed handoff

Current UI classification:

- **Aborted/cancelled**
  - direct `abortHandoff()` (interactive Esc) triggers `"Handoff cancelled"`
  - an unreasoned caller signal also triggers `"Handoff cancelled"`
  - UI shows `Handoff cancelled`
- **Failed**
  - a harness abort reason, an empty manual generation, or any thrown provider error
  - UI logs the error and shows `Handoff failed: ...`

Empty generation on the manual path throws; auto-handoff returns `undefined` only for its next-method fallback.

## Short-session and minimum-content guardrails

Two guards prevent low-signal handoffs:

- UI layer (`handleHandoffCommand`): warns and returns early for `< 2` message entries
- Session layer (`SessionMaintenance.handoff()`): throws the same condition as an error

## State transition summary

High-level state flow:

1. Interactive slash command dispatched by the builtin registry.
2. Streaming and message-count preflight guards.
3. `prepareCompaction(...)` computes the cut (`firstKeptEntryId`, `tokensBefore`).
4. Generation controller created (`isGeneratingHandoff = true`); `generateHandoffFromContext(...)` sends one cache-aligned side request, with a one-time `"auto"` tool-choice compatibility retry when required.
5. Assistant text blocks are joined; tool-call blocks are discarded; secret placeholders are restored locally.
6. If missing text → manual throws / auto returns `undefined`; if aborted → cancellation error.
7. If present: append the `CompactionEntry`, rebuild the agent context, reset plan/advisor/todo runtime state, close rewritten provider sessions, emit `session_compact`.
8. Controller rebuilds chat UI and announces success.
9. The generation controller clears in `finally`.

## Known assumptions and limitations

- No structural validation checks that generated markdown follows the requested section format.
- Manual handoff has no streaming visibility; a cancellable loader is shown until the UI updates.
- Auto-triggered artifact write failure is logged and does not fail the handoff.
- Sessions created by older versions may still contain `custom_message` entries with `customType: "handoff"` from the previous new-session pipeline; they render and participate in context unchanged.
