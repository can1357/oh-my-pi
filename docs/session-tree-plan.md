# Session tree architecture (current)

Reference: [session.md](./session.md)

This document describes how session tree navigation works today: in-memory tree model, leaf movement rules, branching behavior, and extension/event integration.

## What this subsystem is

The session is stored as an append-only entry log, but runtime behavior is tree-based:

- Every non-header entry has `id` and `parentId`.
- The active position is `leafId` in `SessionManager`.
- Appending an entry always creates a child of the current leaf.
- Branching does **not** rewrite history; it only changes where the leaf points before the next append.

Key files:

- `packages/coding-agent/src/session/session-manager.ts` — tree data model, traversal, leaf movement, branch/session extraction
- `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext` context reconstruction (resolved root→leaf LLM context, compaction/branch-summary replay)
- `packages/coding-agent/src/session/agent-session.ts` — `/tree` navigation flow, summarization, hook/event emission
- `packages/tui/src/overlays/tree-selector.ts` — interactive tree UI behavior and filtering
- `packages/coding-agent/src/modes/controllers/selector-controller.ts` — selector orchestration for `/tree` and `/branch`
- `packages/coding-agent/src/slash-commands/builtin-session.ts` — command routing (`/tree`, `/branch`)
- `packages/coding-agent/src/modes/controllers/input-controller.ts` — double-escape behavior and `app.session.tree`/`app.session.fork` keybinding wiring
- `packages/coding-agent/src/session/messages.ts` — conversion of `branch_summary`, `compaction`, and `custom_message` entries into LLM context messages

## Tree data model in `SessionManager`

Runtime indices live in a `SessionEntryIndex` helper, held as `#index` on `SessionManager` and kept in lockstep with the journal array `#entries`:

- `#entriesById: Map<string, SessionEntry>` — fast lookup for any entry
- `#children: Map<string | null, SessionEntry[]>` — parent→children adjacency
- `#labels: Map<string, string>` — resolved labels by target entry id
- `#leaf: string | null` — current position in the tree
- `#usage` — running usage totals

Tree APIs:

- `getBranch(fromId?)` walks parent links to root and returns root→node path
- `getTree()` returns `SessionTreeNode[]` (`entry`, `children`, `label`)
  - parent links become children arrays
  - entries with missing, null, or self parents are treated as roots
  - children are sorted oldest→newest by timestamp
- `getChildren(parentId)` returns direct children
- `getLabel(id)` resolves current label from the index's `#labels` map

`getTree()` is a runtime projection; persistence remains append-only JSONL entries.

## Leaf movement semantics

There are three leaf movement primitives:

1. `branch(entryId)`
   - Validates entry exists
   - Sets `leafId = entryId`
   - No new entry is written

2. `resetLeaf()`
   - Sets `leafId = null`
   - Next append creates a new root entry (`parentId = null`)

3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`
   - Accepts `branchFromId: string | null`
   - Sets `leafId = branchFromId`
   - Appends a `branch_summary` entry as child of that leaf
   - When `branchFromId` is `null`, `fromId` is persisted as `"root"`

## `/tree` navigation behavior (same session file)

`AgentSession.navigateTree()` is navigation, not file forking.

Flow:

1. Validate the target and compute the abandoned path (`collectEntriesForBranchSummary`).
2. For an interactive selection of an `ask` tool result whose original questions can be recovered, return a `reopenAsk` request without mutating the tree. The selector re-opens the question UI, then calls `navigateTree` again with the replacement result; that second call appends a new sibling `toolResult` at the original answer's parent.
3. Emit `session_before_tree` with `TreePreparation`.
4. Optionally summarize abandoned entries (hook-provided summary or built-in summarizer).
5. Compute the new leaf target:
   - selecting a **user** message or user-invoked skill/collaboration custom prompt: leaf moves to its parent; the original draft and image attachments are returned for editor restoration
   - selecting another **custom_message** other than a skill-prompt injection: same parent/prefill rule (text only)
   - selecting an agent/autoload skill-prompt injection or any other entry: leaf = selected entry id
6. Apply leaf move:
   - with summary: `branchWithSummary(newLeafId, ...)`
   - without summary and `newLeafId === null`: `resetLeaf()`
   - otherwise: `branch(newLeafId)`
7. Rebuild agent context from the new leaf, reset branch-scoped todo/advisor/checkpoint state, close Codex provider sessions whose history was rewritten, and emit `session_tree`.

Important: summary entries are attached at the **new navigation position**, not on the abandoned branch tail.

## `/branch` and programmatic file branching

Both user-facing commands stay in the current session file:

- `/tree` opens the entry-tree selector with filters, labels, and optional summaries.
- `/branch` (alias `/rewind`) opens the fullscreen transcript rewind selector.
- Transcript rewind calls `navigateTree(entryId, { summarize: false })`. User-request targets rewind past the prompt and replace the editor draft; other targets land on the selected entry.
- `doubleEscapeAction` controls only the empty-editor double-Escape shortcut: `rewind` (default), `tree`, or `none`. It does not change `/branch` routing.

The separate `AgentSession.branch(entryId)` API, used by extension/hook command contexts, still creates a new file (or an in-memory replacement):

- Source must be a **user message**.
- Returns selected user text and image attachments for draft restoration.
- A root prompt starts `newSession({ parentSession: previousSessionFile })`, carrying the prior title and title source.
- Otherwise it calls `createBranchedSession(selectedEntry.parentId)` to copy history up to the prompt boundary.

`SessionManager.createBranchedSession(leafId)` specifics:

- Builds root→leaf path via `getBranch(leafId)`; throws if missing.
- Excludes existing `label` entries from copied path.
- Rebuilds fresh label entries from the resolved label map (`labelsInEffect()`) for entries that remain in path.
- Persistent mode: writes new JSONL file and switches manager to it; returns new file path.
- In-memory mode: replaces in-memory entries; returns `undefined`.

## Context reconstruction and summary/custom integration

`buildSessionContext()` (in `session-context.ts`, exposed via `SessionManager.buildSessionContext()`) resolves the active root→leaf path and builds effective LLM context state:

- Tracks latest configured/effective thinking, role-model, per-family service-tier, mode/data, and injected-TTSR state on the path.
- Handles latest compaction on the path:
  - emits compaction summary first
  - replays kept messages from `firstKeptEntryId` to compaction point
  - then replays post-compaction messages
- Includes `branch_summary` and `custom_message` entries as `AgentMessage` objects.

`session/messages.ts` then maps these message types for model input:

- `branchSummary` and `compactionSummary` become user-role templated context messages
- Ordinary `custom`/`hookMessage` content uses developer-role conversion; user-invoked skill prompts become attributed user messages, and steering user messages use their dedicated wrapper. Image-bearing custom content has a separate conversion path.

So tree movement changes context by changing the active leaf path, not by mutating old entries.

## Labels and tree UI behavior

Label persistence:

- `appendLabelChange(targetId, label?)` writes `label` entries on the current leaf chain.
- `#labels` (in `SessionEntryIndex`) is updated immediately (set or delete).
- `getTree()` resolves current label onto each returned node.

Tree selector behavior (`tree-selector.ts`):

- Flattens tree for navigation, keeps active-path highlighting, and prioritizes displaying the active branch first.
- Supports filter modes: `default`, `no-tools`, `user-only`, `labeled-only`, `all`.
  - `default` suppresses settings/bookkeeping entries: `label`, `custom`, model/thinking/service-tier/title changes, `model_usage`, credential pins, session initialization, TTSR injections, mode changes, and reset boundaries.
  - `user-only` includes ordinary user messages and user-invoked skill/collaboration custom prompts.
- Supports free-text search over rendered semantic content.
- `Shift+L` opens inline label editing and writes via `appendLabelChange`.

Command routing:

- `/tree` always opens the tree selector.
- `/branch` (alias `/rewind`) always opens the transcript rewind selector and performs same-file navigation.

## Extension and hook touchpoints for tree operations

Command-time extension API (`ExtensionCommandContext`):

- `branch(entryId)` — create a branched session file; returns `{ cancelled }`
- `navigateTree(targetId, { summarize? })` — move within the current tree/file; returns `{ cancelled }`

`HookCommandContext` exposes the same `branch` and `navigateTree` actions, but intentionally omits extension-only session switching/reload/compaction actions.
Events around tree navigation:

- `session_before_tree`
  - receives `TreePreparation`:
    - `targetId`
    - `oldLeafId`
    - `commonAncestorId`
    - `entriesToSummarize`
    - `userWantsSummary`
  - may cancel navigation
  - may provide summary payload used instead of built-in summarizer
  - receives abort `signal` (Escape cancellation path)
- `session_tree`
  - emits `newLeafId`, `oldLeafId`
  - includes `summaryEntry` when a summary was created
  - `fromExtension` indicates summary origin

Adjacent but related lifecycle hooks:

- `session_before_branch` / `session_branch` for `/branch` flow
- `session_before_compact`, `session.compacting`, `session_compact` for compaction entries that later affect tree-context reconstruction

## Real constraints and edge conditions

- `branch()` cannot target `null`; use `resetLeaf()` for root-before-first-entry state.
- `branchWithSummary()` supports `null` target and records `fromId: "root"`.
- Selecting the current leaf in `/tree` is normally a UI no-op, except interactive `ask` re-answer. Direct `navigateTree()` and transcript rewind can still rewind past a current-leaf user message.
- Requested summarization requires an active model. Built-in summary generation also requires a provider credential; hook-supplied summaries and navigation with no abandoned entries do not invoke that credential check.
- If summarization is aborted, navigation is cancelled and leaf is unchanged.
- In-memory sessions never return a branch file path from `createBranchedSession`, though their in-memory entries are replaced.
- Tree context reconstruction includes role models, configured/effective thinking, per-family service tiers, mode data, and injected TTSR state; state entries do not themselves become LLM messages.

## Plan approval session naming

When a user approves a plan from plan mode (`InteractiveMode.#approvePlan`), the dispatch path seeds the session name from the plan's title so the resulting fresh, preserved, or compacted session does not stay unnamed.

Trigger:

- Plan approval reaches `#approvePlan(...)` with `options.title` populated from the plan-approval details.
- This applies to each approval choice that reaches execution dispatch. If approval-time compaction is explicitly cancelled, execution is not dispatched and the naming block is not reached; the next operator turn continues from the preserved plan reference.

Naming source:

- The normalized plan title is humanized via `humanizePlanTitle(title)` (`packages/coding-agent/src/plan-mode/approved-plan.ts`):
  - replaces runs of `-`/`_` with a single space
  - trims whitespace
  - capitalizes the first character
  - returns `""` for whitespace-only / separator-only input
- The humanized name is applied only when the current session has no name (`!sessionManager.getSessionName()`). It then calls `sessionManager.setSessionName(name, "auto")`, which also refuses to overwrite user-named sessions.
- The naming write is awaited before the execution prompt is queued.

Examples (from `humanizePlanTitle`):

- `migrate-mcp-loader` → `Migrate mcp loader`
- `fix_session_naming` → `Fix session naming`
- `foo--bar__baz` → `Foo bar baz`
- `RefactorRouter` → `RefactorRouter` (no separators to expand)
- `""` / `"---"` → `""` (no name applied)

## Legacy compatibility still present

Session migrations still run on load:

- v1→v2 adds `id`/`parentId` and converts compaction index anchor to id anchor
- v2→v3 migrates legacy `hookMessage` role to `custom`

Current runtime behavior is version-3 tree semantics after migration.
