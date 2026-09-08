# context_notes

> Read or replace the current branch's persistent experimental context notebook.

## Source

- Entry: `packages/coding-agent/src/tools/context-notes.ts` (`ContextNotesTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/context-notes.md`
- Notebook projection: `packages/coding-agent/src/session/context-notes.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `compaction.experimentalContextManagement = true`, an undisposed session, and a session journal whose ID matches the tool session's owner ID.
- The setting defaults to `false`. Enable **Notes-backed context windows (experimental)** under `/settings` → Context → Compaction, then restart to update available tools.
- Metadata: `strict = true`, `loadMode = "essential"`. Calls without a `text` property request read approval; calls with that property request write approval.
- Notes-backed rollover requires all four tools to be active: `context_notes`, `new_context`, `read`, and `grep`.

## Inputs

| Field  | Type     | Required | Description                                                                                                                         |
| ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `text` | `string` | No       | Entire replacement notebook. Omit to read; use an empty string to clear. Writes replace rather than append to the visible notebook. |

## Outputs

- Read: returns the latest visible notebook text, or `No context notes are stored for this session branch.` when absent. Details contain `text` and the notebook's `entryId` when present.
- Write: returns `Context notes saved.` Details contain `entryId`, the saved `text`, and its UTF-8 byte count in `bytes`.

## Flow and Side Effects

1. Resolve the live owning journal and check cancellation.
2. Reads project the latest notebook revision on the active branch.
3. Writes validate the byte limit, capture the owner and branch leaf, and await disk preparation.
4. Recheck cancellation, session ownership, feature availability, and the branch leaf before appending an `experimental_context_notes` custom entry with `{ version: 1, text }`.
5. Flush the journal before returning success.

The latest visible notebook is included in experimental context reconstruction and survives rollover and disk resume. A context reset hides earlier notebook revisions. Clearing the notebook appends an empty revision; it does not delete earlier journal entries.

## Limits and Errors

- Maximum notebook size: **16,384 UTF-8 bytes**. Oversized writes fail before appending. Shorten the notebook and recover supporting detail through `history://current/full` using `read` or `grep`.
- Disabled, disposed, or mismatched-owner sessions fail with a `ToolError`.
- A branch change during disk preparation rejects the write rather than saving to a different branch.
- Cancellation and persistence errors propagate to the caller.

See [new_context](new-context.md) for rollover and [Compaction and Branch Summaries](../compaction.md) for the experimental maintenance lifecycle.
