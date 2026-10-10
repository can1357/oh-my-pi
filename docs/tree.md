# `/tree` Command Reference

`/tree` opens the interactive **Session Tree** navigator. It lets you jump to any entry in the current session file and continue from that point.

This is an in-file leaf move, not a new session export.

## What `/tree` does

- Builds a tree from current session entries (`SessionManager.getTree()`)
- Opens `TreeSelectorComponent` with keyboard navigation, filters, and search
- On selection, calls `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- Rebuilds visible chat from the new leaf path
- Optionally prefills editor text when selecting a user/custom message

Primary implementation:

- `packages/coding-agent/src/slash-commands/builtin-session.ts` (`/tree`, `/branch` command routing)
- `packages/coding-agent/src/modes/controllers/input-controller.ts` (keybinding wiring, double-escape behavior)
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` (tree UI launch + summary prompt flow)
- `packages/tui/src/overlays/tree-selector.ts` (navigation, filters, search, labels, rendering)
- `packages/coding-agent/src/session/agent-session.ts` (`navigateTree` leaf switching + optional summary)
- `packages/coding-agent/src/session/session-manager.ts` (`getTree`, `branch`, `branchWithSummary`, `resetLeaf`, label persistence)

## How to open it

Any of the following opens the same selector:

- `/tree`
- configured keybinding for the `app.session.tree` action

Double-escape on an empty editor follows `doubleEscapeAction`: `rewind` (default) opens the fullscreen transcript rewind selector, `tree` opens this tree selector, and `none` disables the shortcut. Transcript rewind calls `navigateTree(..., { summarize: false })` for every target and stays in the current session file. User-request drafts replace the editor text.

Rewind opens on the latest ~600 entries, keeping whole user turns (which may exceed the limit). Press `a` for all earlier history without changing the selected point or branch.
Press `f` to filter the replayed transcript (loading the whole branch); Left/Right navigate the rewind selector's sibling-branch strip when available. These controls belong to transcript rewind, not the tree selector below.

## Tree UI model

The tree is rendered from session-entry parent pointers (`id` / `parentId`).

- Children are sorted by timestamp ascending
- The branch containing the active leaf is ordered first in the selector; other history remains reachable
- Active branch (root-to-leaf path) is marked with a bullet
- Labels render as `[label]` before node text
- Missing parents, self-parent entries, and explicit null parents become roots; multiple roots share a virtual branching root

```text
Example tree view (active path marked with •):

├─ user: "Start task"
│  └─ assistant: "Plan"
│     ├─ • user: "Try approach A"
│     │  └─ • assistant: "A result"
│     │     └─ • [milestone] user: "Continue A"
│     └─ user: "Try approach B"
│        └─ assistant: "B result"
```

The selector recenters around current selection and shows up to:

- `max(1, min(max(5, floor(terminalHeight / 2)), terminalHeight - 8))` rows, reserving panel chrome on short terminals

## Keybindings inside tree selector

- `Up` / `Down`: move selection (wraps)
- `Alt+Up` / `Alt+Down`: jump to previous/next user or assistant turn
- `Shift+Left` / `Shift+Right`: jump to the previous/next visible branch in rendered order (wraps), across nested forks; on a fork node, enter its last/first visible child branch. A branch whose head is filtered out lands on its first visible descendant.
- `Page Up` / `Page Down`, or `Left` / `Right`: page
- `Home` / `End`: first/last visible item
- `Enter`: select node
- `Shift+Enter`: summarize and switch without opening the summary-choice prompt
- `Esc`: clear search if active; otherwise close selector
- `Ctrl+C`: close selector
- `Type`: append to search query
- `Backspace`: delete search character
- `Shift+L`: edit/clear label when search is empty
- `Ctrl+O`: cycle filter forward
- `Shift+Ctrl+O`: cycle filter backward
- `Alt+D/T/U/L/A`: jump directly to a filter

## Filters and search semantics

Initial mode comes from `treeFilterMode` (default `default`). Modes cycle in this order:

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

Shows conversational nodes plus any entry types not explicitly suppressed. It hides these setting/bookkeeping entry types:

- `label`
- `custom`
- `model_change`
- `thinking_level_change`
- `model_usage`
- `service_tier_change`
- `title_change`
- `credential_pin`
- `session_init`
- `ttsr_injection`
- `mode_change`
- `reset_boundary`

The `all` filter renders these as metadata rows; entries without specialized rendering use their type name rather than a blank row.

### `no-tools`

Same as `default`, plus hides `toolResult` messages.

### `user-only`

User requests: ordinary user messages and user-invoked skill/collaboration custom prompts.

### `labeled-only`

Only entries that currently resolve to a label.

### `all`

Everything in the session tree, including bookkeeping/custom entries.

### Tool-only assistant node behavior

Assistant messages that contain only tool calls (no canonical text) are hidden in every filter mode, including `all`, unless:

- message is error/aborted (`stopReason` is neither `stop` nor `toolUse`), or
- it is the current leaf

### Search behavior

- Query is tokenized by spaces
- Matching is fuzzy (subsequence) and case-insensitive (`fuzzyMatch`)
- All tokens must match (AND semantics)
- Searchable text includes label, role, and type-specific content (message text, branch summary text, custom type, tool command snippets, etc.)
- Message/custom-message text is bounded to a 200-character search preview; search does not index every byte of a long message.

## Selection outcomes (important)

`navigateTree` computes new leaf behavior from selected entry type:

### Selecting `user` message

- New leaf becomes the selected entry’s `parentId`
- Root user message resets leaf to root
- Text and image attachments are reconstructed as an editable draft
- The selector only writes that draft when the editor is currently empty

### Selecting `custom_message`

- Ordinary custom messages use the same parent-leaf rule and text prefill as user messages
- User-invoked skill/collaboration custom prompts restore the original user draft and image attachments, using the parent-leaf rule
- Agent/autoload `skill-prompt` injections are not editable; selecting one lands on that node like other non-user entries

### Selecting a past `ask` tool result

- Interactive `/tree` reopens the original question UI instead of reusing the stale answer
- Cancel leaves the tree unchanged
- A new answer is appended as a sibling tool result, preserving the old answer branch, then the agent resumes from it
- If legacy/corrupt data cannot recover the original questions, selection falls back to a plain leaf move

### Selecting other nodes

- New leaf becomes selected node id
- Editor is not prefilled

### Selecting current leaf

- Normally closes with `Already at this point`
- The `/tree` UI treats a current-leaf user prompt as a no-op; transcript `/branch` rewind and direct `navigateTree()` calls can still rewind past that prompt
- A current-leaf `ask` result still permits the re-answer flow

```text
Selection decision (simplified):

selected node
   │
   ├─ current leaf (not ask result)? ──> close selector (no-op)
   │
   ├─ ask tool result? ──> re-answer as a sibling branch when questions are recoverable
   │
   ├─ user or ordinary custom message? ──> leaf := parentId (or root)
   │                                         + prefill only into an empty editor
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## Summary-on-switch flow

Summary prompting is controlled by `branchSummary.enabled` (default `false`). `Shift+Enter` requests summarization directly regardless of the prompt setting. A model must be available; provider credentials are checked only when the built-in summarizer runs (not for hook-supplied summaries or an empty abandoned path).

When prompting is enabled, ordinary Enter offers:

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

Flow details:

- Escape in summary prompt reopens tree selector
- Custom prompt cancellation returns to summary choice
- During summarization, UI shows a loader and binds Esc to `abortBranchSummary()`
- If summarization aborts, tree selector reopens and no move is applied

`navigateTree` internals:

- flushes pending bash output and validates the target
- collects abandoned-branch entries from old leaf to common ancestor
- emits cancellable `session_before_tree`; an extension may supply the requested summary
- runs the default summarizer only when requested, entries need summarizing, and no hook summary was supplied
- applies `branchWithSummary(...)`, `branch(newLeafId)`, or `resetLeaf()` as appropriate
- rebuilds model context, checkpoint/rewind state, advisor state, todos, and provider sessions affected by the history rewrite
- emits `session_tree` and rebuilds again if handlers may have appended entries

If summary is requested but there is nothing to summarize, navigation proceeds without a summary entry.

## Labels

Label edits in tree UI call `appendLabelChange(targetId, label)`.

- non-empty label sets/updates resolved label
- empty label clears it
- labels are stored as append-only `label` entries
- tree nodes display resolved label state, not raw label-entry history

## `/tree` vs adjacent operations

| Operation | Scope                                            | Result                                                                                                                                                   |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree`   | Current session file                             | Moves leaf to selected point (same file)                                                                                                                 |
| `/branch` (alias `/rewind`) | Current session file | Opens transcript rewind; moves the leaf in place and restores user-request drafts |
| `/fork`   | Whole current session                            | Duplicates session into a new persisted session file                                                                                                     |
| `/resume` | Session list                                     | Switches to another session file                                                                                                                         |

Key distinction: `/tree` and `/branch` navigate inside one session file. `/fork` duplicates the file; `/resume` switches files. The programmatic `AgentSession.branch()` API still creates a separate branched session.

## Operator workflows

### Re-run from an earlier user prompt without losing current branch

1. `/tree`
2. search/select earlier user message
3. choose `No summary` (or summarize if needed)
4. edit prefilled text in editor
5. submit

Effect: new branch grows from selected point within same session file.

### Leave current branch with context breadcrumb

1. enable `branchSummary.enabled`
2. `/tree` and select target node
3. choose `Summarize` (or custom prompt)

Effect: a `branch_summary` entry is appended at the target position before continuing.

### Investigate hidden bookkeeping entries

1. `/tree`
2. press `Alt+A` (all)
3. search for `model`, `thinking`, `custom`, or labels

Effect: inspect full internal timeline, not just conversational nodes.

### Bookmark pivot points for later jumps

1. `/tree`
2. move to entry
3. `Shift+L` and set label
4. later use `Alt+L` (`labeled-only`) to jump quickly

Effect: fast navigation among durable branch landmarks.
