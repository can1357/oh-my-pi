# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff`: trigger path, oneshot generation, session switch, context reinjection, persistence, and UI behavior.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.handoff()` lifecycle and state transitions
- `generateHandoff(...)` request shape
- How old/new sessions persist handoff data differently
- UI behavior for success, cancel, and failure

Does not cover:

- Generic tree navigation/branch internals
- Non-handoff session commands (`/new`, `/fork`, `/resume`)

## Implementation files

- [`../src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/agent/src/compaction/compaction.ts`](../packages/agent/src/compaction/compaction.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)

## Trigger path

1. `/handoff` is declared in builtin slash command metadata (`slash-commands/builtin-registry.ts`) with optional inline hint: `[focus instructions]`.
2. In interactive input handling (`InputController`), submit text matching `/handoff` or `/handoff ...` is intercepted before normal prompt submission.
3. The editor is cleared and `handleHandoffCommand(customInstructions?)` is called.
4. `CommandController.handleHandoffCommand` performs a preflight guard using current entries:
   - Counts `type === "message"` entries.
   - If `< 2`, it warns: `Nothing to hand off (no messages yet)` and returns.

The same minimum-content guard exists again inside `AgentSession.handoff()` and throws if violated. This duplicates safety at both UI and session layers.

## End-to-end lifecycle

### 1) Start handoff generation

`AgentSession.handoff(customInstructions?)`:

- Reads current branch entries (`sessionManager.getBranch()`).
- Validates minimum message count (`>= 2`).
- Refuses if a response is still streaming (the TUI `/handoff` and RPC `handoff` command guard on `isStreaming` before calling this; the auto-handoff path runs only after the turn settles). Resetting the agent mid-stream would let the live turn keep emitting into the torn-down session.
- Creates `#handoffAbortController` and links any caller-provided abort signal to it.
- Resolves the current model API key through `ModelRegistry`.
- Builds the handoff request through the **same pipeline a live turn uses** — the cache-preserving side-request path shared with `runEphemeralTurn` (`/btw`, `/omfg`):
  1. Renders the handoff prompt (`renderHandoffPrompt(...)` with optional `additionalFocus`, after obfuscating any focus instructions) and appends it as a trailing agent-attributed `user` message to a snapshot of `agent.state.messages`.
  2. Converts the snapshot with `convertMessagesToLlm(...)` (applies the session `transformContext` — extension context + steering wrap — then `convertToLlm` + obfuscation), exactly as the loop does.
  3. Builds the provider `Context` with `agent.buildSideRequestContext(llmMessages, #baseSystemPrompt)` — normalized tools and `transformProviderContext` (obfuscation + inline snapcompact) matching the loop. The **base** system prompt is pinned here, not a per-turn `before_agent_start` hook override, so the new session does not inherit prompt-specific hook state.
  4. Builds stream options with `prepareSimpleStreamOptions(...)`: a stable `promptCacheKey` (= the live session id) so the oneshot reads the cache the turn populated, a unique side `sessionId` (`<sid>:side:<snowflake>`) so OpenAI/Codex append-only state never mixes with the live turn, `serviceTier`/payload hooks mirrored from the session, and `preferWebsockets: false`.
- Calls `generateHandoffFromContext(context, model, { streamOptions, telemetry, thinkingLevel })`.

### 2) Generate and capture output

`generateHandoffFromContext(...)` lives in `packages/agent/src/compaction/compaction.ts` next to summarization. It is the handoff request contract: it issues one `instrumentedCompleteSimple(...)` (the OTEL-instrumented `completeSimple` oneshot wrapper) against the caller-built `Context`, forcing `toolChoice: "none"` and `reasoning: resolveCompactionEffort(model, thinkingLevel)` over whatever the caller's `streamOptions` carried:

```ts
await instrumentedCompleteSimple(
  model,
  context, // system prompt + normalized tools + transformed history + trailing handoff prompt
  {
    ...streamOptions, // apiKey, signal, sessionId, promptCacheKey, serviceTier, hooks
    reasoning: resolveCompactionEffort(model, options.thinkingLevel),
    toolChoice: "none",
  },
  { telemetry, oneshotKind: "handoff" },
);
```

(`generateHandoff(messages, …)` remains exported for downstream callers and now builds a basic `Context` from `systemPrompt`/`tools`/`convertToLlm` and delegates to `generateHandoffFromContext`. `AgentSession` no longer uses it because it cannot apply the host's transform pipeline or cache routing.)

Important generation properties:

- The request shares the live provider cache prefix because the `Context` is built by the identical transform + normalization pipeline the loop uses, and routed with the same `promptCacheKey` the turn used.
- The handoff instruction is a trailing `user` message, not a developer message, so the cached prefix remains aligned with the prior turn (the trailing message is the only divergence point).
- `toolChoice: "none"` prevents intentional tool dispatch.
- The returned assistant content is filtered to text blocks and joined with `\n`; stray tool-call blocks are ignored if a provider does not honor `toolChoice: "none"`.
- `stopReason === "error"` throws a generation error.

No agent-loop events are used for capture. The handoff path no longer waits for `agent_end` and no longer scans the latest assistant message.

### 3) Cancellation checks

Cancellation throws `Error("Handoff cancelled")`; a completed generation with no text returns `undefined`.

- caller signal aborts `#handoffAbortController`
- `completeSimple(...)` receives the abort signal
- aborted handoff signal or provider `AbortError` is normalized to `Error("Handoff cancelled")`
- empty generated text returns `undefined`

`AgentSession.handoff()` always clears `#handoffAbortController` in `finally`.

### 4) New session creation

If text was generated and not aborted:

1. Flush current session writer (`sessionManager.flush()`).
2. Cancel session-owned async jobs.
3. Start a brand-new session with `parentSession` pointing at the previous session file when one exists.
4. Reset in-memory agent state (`agent.reset()`).
5. Rebind `agent.sessionId` to the new session id.
6. Rekey/reset Hindsight and Mnemopi memory session tracking for the new session.
7. Clear the queued next-turn context array (`#pendingNextTurnMessages`) and the scheduled hidden next-turn generation (`#scheduledHiddenNextTurnGeneration`). The agent's steering and follow-up queues are already cleared by `agent.reset()` in step 4.
8. Reset todo reminder counter.

### 5) Handoff-context injection

The generated handoff document is wrapped by coding-agent session glue and appended to the new session as a `custom_message` entry:

```text
<handoff-context>
...handoff text...
</handoff-context>

The above is a handoff document from a previous session. Use this context to continue the work seamlessly.
```

Insertion call:

```ts
this.sessionManager.appendCustomMessageEntry(
  "handoff",
  handoffContent,
  true,
  undefined,
  "agent",
);
```

Semantics:

- `customType`: `"handoff"`
- `display`: `true` (visible in TUI rebuild)
- attribution: `"agent"`
- Entry type: `custom_message` (participates in LLM context)

### 6) Rebuild active agent context

After injection:

1. `buildDisplaySessionContext()` resolves message list for current leaf.
2. `agent.replaceMessages(sessionContext.messages)` makes the injected handoff message active context.
3. Todo phases are synchronized from the new branch.
4. Method returns `{ document: handoffText, savedPath? }`.

At this point, the active LLM context in the new session contains the injected handoff message, not the old transcript.

## Persistence model: old session vs new session

### Old session

Handoff generation is a oneshot request, not a visible agent turn. The generated handoff text is not appended to the old session as an assistant message.

Result: the original session keeps its prior transcript unchanged except for data already persisted before handoff began.

### New session

After session reset, handoff is persisted as `custom_message` with `customType: "handoff"`.

`buildSessionContext()` converts this entry into a runtime custom/user-context message via `createCustomMessage(...)`, so it is included in future prompts from the new session.

Auto-triggered handoffs can additionally write a timestamped `handoff-*.md` artifact under the session artifacts directory when `compaction.handoffSaveToDisk` is enabled. Manual `/handoff` does not write that artifact.

## Controller/UI behavior

`CommandController.handleHandoffCommand` behavior:

- Refuses with a warning when `session.isStreaming` (matches `/fork` and `/move`) — the user must finish or abort the response before handing off.
- Shows a status loader: `Generating handoff… (esc to cancel)`.
- Calls `await session.handoff(customInstructions)`.
- If result is `undefined`: `showError("Handoff cancelled")`.
- On success:
  - `rebuildChatFromMessages()` (loads new session context, including injected handoff)
  - invalidates status line and editor top border
  - reloads todos
  - appends success chat line: `New session started with handoff context`
- On exception:
  - if message is `"Handoff cancelled"` or error name is `AbortError`: `showError("Handoff cancelled")`
  - otherwise: `showError("Handoff failed: <message>")`
- Stops the loader, clears the status container, and requests render at end.

Manual `/handoff` no longer streams the generated document into chat. A cancellable loader remains visible while the oneshot request runs, and the chat is rebuilt after generation completes.

## Cancellation semantics

### Session-level cancellation primitive

`AgentSession` exposes:

- `abortHandoff()` → aborts `#handoffAbortController`
- `isGeneratingHandoff` → true while controller exists

When this abort path is used, the abort signal is passed to `completeSimple(...)`; `handoff()` normalizes the cancellation to `Error("Handoff cancelled")`, and command controller maps it to cancellation UI.

### Interactive `/handoff` path

`InputController`'s global `editor.onEscape` handler dispatches on live session state instead of swapping handlers: while `isGeneratingHandoff` is true, pressing Escape calls `session.abortHandoff()`, which aborts the `completeSimple(...)` request through `#handoffAbortController`.

## Aborted vs failed handoff

Current UI classification:

- **Aborted/cancelled**
  - `abortHandoff()` path triggers `"Handoff cancelled"`, or
  - thrown `AbortError`
  - UI shows `Handoff cancelled`
- **Failed**
  - any other thrown error from `handoff()` / `generateHandoff()` / provider request path
  - UI shows `Handoff failed: ...`

Additional nuance: if generation completes but no text is returned, `handoff()` returns `undefined` and controller currently reports **cancelled**, not **failed**.

## Short-session and minimum-content guardrails

Two guards prevent low-signal handoffs:

- UI layer (`handleHandoffCommand`): warns and returns early for `< 2` message entries
- Session layer (`handoff()`): throws the same condition as an error

This avoids creating a new session with empty/near-empty handoff context.

## State transition summary

High-level state flow:

1. Interactive slash command intercepted.
2. Preflight message-count guard.
3. `#handoffAbortController` created (`isGeneratingHandoff = true`).
4. `generateHandoff(...)` issues one `instrumentedCompleteSimple(...)` request with live system prompt, tools, message history, current thinking level, and trailing handoff prompt.
5. Assistant response text blocks are joined; tool-call blocks are discarded.
6. If missing text → return `undefined`; if aborted → cancellation error path.
7. If present:
   - flush old session
   - cancel async jobs
   - create new empty session with previous session as parent
   - reset runtime queues/counters
   - append `custom_message(handoff)`
   - optionally save an auto-triggered handoff document under the session artifacts directory when `compaction.handoffSaveToDisk` is enabled
8. Controller rebuilds chat UI and announces success.
9. `#handoffAbortController` cleared (`isGeneratingHandoff = false`).

## Known assumptions and limitations

- No structural validation checks that generated markdown follows the requested section format.
- Missing generated text is reported as cancellation in controller UX.
- Manual handoff has no streaming visibility; a cancellable loader is shown until the UI updates after generation completes.
- Auto-triggered handoffs can write a timestamped `handoff-*.md` artifact when `compaction.handoffSaveToDisk` is enabled; write failure is logged and does not fail the handoff.
