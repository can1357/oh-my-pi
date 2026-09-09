# new_context

> Request a fresh experimental context window while preserving the current notebook and recoverable branch history.

## Source

- Entry: `packages/coding-agent/src/tools/context-notes.ts` (`NewContextTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/new-context.md`
- Request consumption: `packages/coding-agent/src/session/agent-session.ts`
- Rollover lifecycle: `packages/coding-agent/src/session/session-maintenance.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `compaction.experimentalContextManagement = true`, an undisposed session, and a session journal whose ID matches the tool session's owner ID.
- The setting defaults to `false`. Enable **Notes-backed context windows (experimental)** under `/settings` → Context → Compaction, then restart to update available tools.
- Metadata: `approval = "write"`, `strict = true`, `loadMode = "essential"`.
- Notes-backed rollover requires all four tools to be active: `context_notes`, `new_context`, `read`, and `grep`. Unsupported tool configurations retain the existing compaction behavior.

## Inputs

An empty object: `{}`. The tool takes no instructions, notebook text, or target session ID. Save the working notebook with [context_notes](context-notes.md) before requesting rollover.

## Outputs

- Text: `New context window requested.`
- Details: `{ requested: true }`.

This result acknowledges a request. The tool itself does not commit a compaction boundary or synchronously reset the conversation.

## Flow and Side Effects

1. Validate the owning session and check cancellation.
2. Return the turn-local rollover request.
3. The owning agent consumes successful tool results, including write-device results, and processes the request through its maintenance lifecycle before the next provider request.
4. The experimental lifecycle commits a normal compaction boundary without generating another recursive summary. It rebuilds active context with the latest notebook and retained recent messages, leaving original journal entries available through `history://current/full`.

An explicit `new_context` request bypasses the automatic mid-turn threshold toggle. Rollover still depends on the experimental capability and maintenance guards; session, branch, model, cancellation, and active-tool changes are revalidated before commit.

## Limits and Errors

- Disabled, disposed, or mismatched-owner tool sessions fail with a `ToolError`.
- Cancellation is checked before the request is returned.
- The maintenance lifecycle handles cancellation, extension hooks, concurrent compaction, and stale session or branch state. A successful tool request is not proof that a later rollover committed.
- This tool does not create a new session, change working files, or delete raw journal history.

See [Compaction and Branch Summaries](../compaction.md) for automatic rollover, notebook reminders, and manual compaction behavior.
