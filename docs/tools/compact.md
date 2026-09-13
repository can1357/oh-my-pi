# compact

> Compact your own conversation context at a clean turn boundary, instead of waiting for automatic threshold or idle compaction.

## Source
- Entry: `packages/coding-agent/src/tools/compact.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/compact.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — records the request from the turn's tool result and runs the actual compaction after the turn settles.
  - `packages/coding-agent/src/session/session-maintenance.ts` — owns `compact()`, the shared compaction machinery the automatic threshold/idle backstops also drive.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool via `CompactTool.createIf`.
  - `packages/coding-agent/src/tools/essential-tools.ts` — lists `compact` among the essential built-ins pinned to the top-level schema.

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "essential"`. Execution is single-shot; the tool does not stream progress updates.
- Registration is opt-in: the tool ships default-off behind the `compact.enabled` setting (tab "tools", group "Available Tools"). `isToolAllowed("compact")` gates on it, and `CompactTool.createIf()` refuses when it is unset or false.
- With the setting enabled, `CompactTool.createIf()` returns the tool only for a genuine top-level session: `taskDepth` undefined or `0`, no `parentTaskPrefix`, and `getAgentId()` not `"advisor"`. Subagents receive `null` (a subagent hands its result back to its parent and is discarded, so there is no long-lived context worth compacting). An advisor tool session is also refused: it is spread from the primary top-level session so it inherits `taskDepth 0` and no `parentTaskPrefix`, but it runs its own Agent and never runs the primary's turn-settle marker consumer, so a compact tool there would be inert.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `instructions` | `string` | No | Optional focus for the summary — what context to preserve. Trimmed by `execute()`; a blank or whitespace-only value is normalized to none. |

## Outputs
The tool returns a single text result plus structured details:

- text body:
  - `Compaction scheduled — it runs when this turn settles. This does not interrupt the current turn.`
- `details`:
  - `requested: true`
  - `instructions?: string` — the trimmed focus text, when supplied

The returned result only *signals* intent. The session runs the actual compaction after the turn settles, not inline.

## Flow
1. `CompactTool.execute()` rejects a subagent call with `ToolError("Compaction is not available in subagents.")` (defense in depth beyond `createIf`).
2. It trims `instructions` and returns a `toolResult()` carrying `details.requested = true`. The tool method itself does not compact.
3. On the successful `compact` tool result, `AgentSession` records the request (with its instructions) as a one-shot marker scoped to that turn.
4. At the genuine settle (`willContinue === false`), `AgentSession` schedules the compaction to run after the agent run unwinds, then consumes and clears the marker so a stale result cannot re-fire on a later settle.
5. The deferred pass runs `AgentSession.compact()` — the same entrypoint the `/compact` command and the automatic threshold/idle backstops use — forwarding any focus instructions.

## Modes / Variants
- Deferred turn-end apply: the tool result only requests compaction; the rewrite happens after the surrounding turn finishes, so the call never interrupts the turn that made it.
- Benign no-op: when the session is already small enough, was just compacted, or a compaction is already running, the requested pass is a swallowed no-op.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Rewrites the active conversation history into a compact summary plus the retained recent tail, exactly as automatic compaction does.
  - Consumes the one-shot request marker after applying, so the same tool result cannot trigger a second compaction.
- User-visible prompts / interactive UI
  - The tool result confirms the compaction is scheduled and that the current turn is not interrupted.
- Background work / cancellation
  - The compaction is deferred to run after the run unwinds. `compact()` aborts the (already-ending) active operation first, which is why it cannot run inline from `execute()`.

## Limits & Caps
- Opt-in via `compact.enabled` (default off). Top-level sessions only; subagents and advisor sessions never receive the tool.
- Compaction is driven by the shared `compaction` settings (method order, reserve). A directed compaction (focus instructions) requires an LLM summary method rather than the local snapcompact path.

## Errors
- `ToolError("Compaction is not available in subagents.")` — thrown when `execute()` runs in a subagent session.
- A deferred compaction failure is best-effort: a too-small / already-compacted / already-running outcome is logged at debug and swallowed; any other failure is logged as a warning without escaping the settle path.

## Notes
- This is the proactive counterpart to automatic threshold/idle compaction: those fire on their own, but the model knows best when a breakpoint is clean (a finished task, a wait on a gate, between independent tasks).
- The signal-then-apply split mirrors `checkpoint`/`rewind`: the tool records intent and the session applies the effect at turn settle.
