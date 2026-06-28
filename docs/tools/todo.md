# todo

> Applies one mutation to the session todo list and returns a text summary plus the full phase/task state.

## Source
- Entry: `packages/coding-agent/src/tools/todo.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/todo.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers tool, exposes session hooks, gates availability.
  - `packages/coding-agent/src/modes/controllers/event-controller.ts` — updates the visible todo UI on tool completion.
  - `packages/coding-agent/src/session/agent-session.ts` — stores cached phases, strips done/dropped tasks on session resume, emits failure reminders.
  - `packages/coding-agent/src/modes/controllers/todo-command-controller.ts` — `/todo` command path, custom-entry persistence, transcript reminder injection.
  - `packages/coding-agent/src/tools/render-utils.ts` — collapsed-preview cap for renderer trees.

## Inputs

The params object **is** a single op — the discriminator and its fields live at the top level (no `ops` array wrapper).

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `init` | `list` **or** flat `items` | `phase` (names the phase for the flat `items` form; defaults to `Tasks`) | Replaces the entire list — with `list`, uses the given phases; with a flat `items` array, synthesizes one phase. Every new task starts `pending` before normalization. |
| `start` | `task` | None | Marks one task `in_progress`; any other `in_progress` task is demoted to `pending`. |
| `done` | `task` or `phase` or neither | None | Marks the target task, phase, or all tasks `completed`. |
| `drop` | `task` or `phase` or neither | None | Marks the target task, phase, or all tasks `abandoned`. |
| `rm` | `task` or `phase` or neither | None | Removes the target task, clears the phase's task list, or clears all task lists. |
| `append` | `phase`, `items` | None | Appends new `pending` tasks to a phase; creates the phase if missing. |
| `view` | None | None | Echoes the current list. A `view` call is read-only: no normalization, no state write. |

### Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"init" | "start" | "done" | "rm" | "drop" | "append" | "view"` | Yes | Operation discriminator. |
| `list` | `{ phase: string; items: string[] }[]` | For `init` (unless a flat `items` list is given) | Full replacement payload. Each `items` array has `minItems: 1`. |
| `task` | `string` | For `start`; for task-targeted `done`/`drop`/`rm` | Exact task content match. |
| `phase` | `string` | For `append`; for phase-targeted `done`/`drop`/`rm`; optional for a flat `init` | Exact phase name match, except `append` lazily creates a missing phase and a flat `init` synthesizes one (default `Tasks`). |
| `items` | `string[]` | For `append`; or as a flat `init` payload | Tasks to append, or the full task list for a flat `init`. `minItems: 1`. |

## Outputs
The tool returns a single-shot `AgentToolResult`:

- `content`: one text part containing the summary from `formatSummary(...)`.
  - Empty final state with no errors: `Todo list cleared.` (`Todo list is empty.` for a pure-`view` call).
  - Non-empty final state: remaining-item list, current phase progress, then a per-phase tree.
  - If the op produced validation/runtime errors, the summary starts with `Errors: ...` and the result is marked `isError: true`; the mutation is discarded — the returned and persisted state stay at the pre-call list.
- `details`:
  - `phases: TodoPhase[]`
  - `storage: "session" | "memory"`
  - `completedTasks?: TodoCompletionTransition[]` when a task changed from non-completed to `completed` during the call

`TodoPhase` / `TodoItem` state model:

- `TodoPhase`: `{ name: string, tasks: TodoItem[] }`
- `TodoItem`: `{ content: string, status: "pending" | "in_progress" | "completed" | "abandoned" }`

The TUI renderer (`todoToolRenderer`) merges call and result into one transcript block and renders phases as a tree. Collapsed transcript previews cap tree items at `PREVIEW_LIMITS.COLLAPSED_ITEMS` (`8`).

## Flow
1. `TodoTool.execute(...)` clones the current cached phases from `session.getTodoPhases?.() ?? []` (`packages/coding-agent/src/tools/todo.ts`).
2. `applyParams(...)` applies the single op (`params`) with `applyEntry(...)`.
3. Each op mutates the working phase array:
   - `initPhases(...)` rebuilds the list from scratch.
   - `start` resolves a task by exact `content`, demotes every other `in_progress` task to `pending`, then marks the target `in_progress`.
   - `done` / `drop` use `getTaskTargets(...)` to target one task, one phase, or every task.
   - `rm` removes one task, clears one phase's `tasks`, or clears all phases' task arrays.
   - `appendItems(...)` resolves or creates the target phase and pushes new `pending` tasks unless the same task content already exists anywhere.
4. Missing task/phase references are recorded in an `errors` array by `resolveTaskOrError(...)` / `resolvePhaseOrError(...)`; any error discards the op's mutations at the end.
5. After the op, `normalizeInProgressTask(...)` enforces the single-active-task invariant:
   - if multiple tasks are `in_progress`, only the first stays active and the rest become `pending`;
   - if none are `in_progress`, the first `pending` task in phase/task order is auto-promoted to `in_progress`.
6. `execute(...)` stores the updated phases with `session.setTodoPhases?.(...)` only when the op produced no errors and was not a `view`; a failed op is discarded (persisting a half-applied mutation would make the natural retry hit "already exists"). `storage` is `"session"` when `session.getSessionFile()` exists, else `"memory"`.
7. `getCompletionTransitions(...)` compares the previous and updated phases (skipped for failed or `view` calls); newly completed tasks are returned in `details.completedTasks`.
8. The agent runtime also watches `todo` tool results in `packages/coding-agent/src/session/agent-session.ts`; successful results refresh cached todos, failed results inject a hidden next-turn reminder telling the model that todo progress is not visible until it retries.
9. The event controller updates the visible todo UI from `result.details.phases` on success, or shows a warning on error (`packages/coding-agent/src/modes/controllers/event-controller.ts`).

## Modes / Variants
### State transitions

| Current status | `start` | `done` | `drop` | `rm` | `append` |
| --- | --- | --- | --- | --- | --- |
| `pending` | `in_progress` on target | `completed` | `abandoned` | Removed | New tasks enter as `pending` |
| `in_progress` | Target stays `in_progress`; non-target active tasks become `pending` | `completed` | `abandoned` | Removed | No status change |
| `completed` | Can be set back to `in_progress` if targeted | Stays `completed` | Becomes `abandoned` if targeted | Removed | No status change |
| `abandoned` | Can be set back to `in_progress` if targeted | Becomes `completed` if targeted | Stays `abandoned` | Removed | No status change |

Normalization then re-applies the single-active-task rule after the op runs.

### Op targeting rules
- `done`, `drop`, `rm`:
  - `task` set: affect one exact-content task.
  - else `phase` set: affect every task in that exact-name phase.
  - else: affect every task in every phase.
- `append` is the only op that creates a missing phase.
- `init` discards previous phases entirely.

### Markdown round-trip helpers
The same file also exposes non-tool helpers used by `/todo`:
- `phasesToMarkdown(...)` serializes phases as headings plus checklist items (`[ ]`, `[/]`, `[x]`, `[-]`).
- `markdownToPhases(...)` parses that format, defaults orphan tasks into a `Todos` phase, accepts `>` as an `in_progress` marker and `~` as `abandoned`, and runs the same normalization step.

## Side Effects
- Filesystem
  - None in the tool itself.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Mutates the session todo cache through `setTodoPhases`.
  - `storage` reports whether the session has a backing session file, but the tool does not append a custom session entry itself.
  - Successful tool-result messages carry `details.phases`; `getLatestTodoPhasesFromEntries(...)` can reconstruct state later from those transcript entries.
  - Failed `todo` results cause `agent-session` to enqueue a hidden next-turn reminder (`customType: "todo-error-reminder"`).
- User-visible prompts / interactive UI
  - Transcript block is rendered by `todoToolRenderer` and merged with the call line.
  - `event-controller` updates the visible todo panel from successful results.
  - On error, `event-controller` shows `Todo update failed...`; the visible panel may stay stale until a later successful call.
- Background work / cancellation
  - Session-level auto-clear of `completed`/`abandoned` tasks was removed (the timer mutated canonical phases between tool calls); the TUI todo widget still clears closed entries after `tasks.todoClearDelay` (display-only, `packages/coding-agent/src/modes/interactive-mode.ts`).

## Limits & Caps
- `init.list`: applies to a single op (`todoSchema`). The params object carries exactly one op.
- `init.list[*].items`: `minItems: 1`.
- `append.items`: `minItems: 1`.
- Renderer collapsed preview: `PREVIEW_LIMITS.COLLAPSED_ITEMS = 8` (`packages/coding-agent/src/tools/render-utils.ts`).
- Auto-clear delay: `tasks.todoClearDelay` default `60` seconds; `< 0` disables auto-clear, `0` clears immediately. Display-only — applied by the TUI widget (`packages/coding-agent/src/modes/interactive-mode.ts`); the setting is inert at the session level.
- Tool execution mode: `concurrency = "exclusive"`, `strict = true`, `loadMode = "discoverable"`.

## Errors
- Ordinary bad op payloads are accumulated as human-readable strings in `errors`; the result is marked `isError: true` and the mutation is discarded — the returned and persisted state stay at the pre-call list.
- Error strings come from the helpers in `packages/coding-agent/src/tools/todo.ts`, including:
  - `Missing list for init operation`
  - `Missing task content`
  - `Duplicate phase "..." in init list` / `Duplicate task "..." in init list`
  - `Task "..." not found` with an extra empty-list hint when applicable, or a hint that tasks are referenced by content (not `task-N` IDs) when the missing content looks like an ID
  - `Missing phase name`
  - `Phase "..." not found`
  - `Missing phase name for append operation`
  - `Missing items for append operation`
  - `Task "..." already exists`
- A `todo` call carries a single op; any error in it discards every mutation the op made.
- Runtime-level tool failure is handled outside the tool body: `agent-session` injects a hidden reminder and the event controller warns the user that visible progress may be stale.
- Idempotency is op-specific:
  - `init` is a full replacement; replaying the same payload yields the same state.
  - `start`, `done`, and `drop` are effectively idempotent on an existing target state, but `start` also demotes any other active task.
  - `rm` is not idempotent for targeted removals: the second call errors because the task or phase is gone.
  - `append` is not idempotent: duplicate task content is rejected with `Task "..." already exists`; the `append` op validates up front, so an op with any duplicate appends nothing.

## Notes
- Task lookup is exact string equality inside the tool. The model-facing prompt says task content and phase names are identifiers and should stay unique; `append` enforces task uniqueness globally, and `init` rejects duplicate phase names and duplicate task contents in its payload.
- `findTaskByContent(...)` returns the first matching task across phases. Duplicate task contents make later targeted ops ambiguous.
- `normalizeInProgressTask(...)` runs once after the op, not mid-op. A single op (e.g. `init`) can build an intermediate invalid state and rely on final normalization.
- `storage: "session"` means the session has a session-file backing; it does not mean this tool wrote a durable custom entry.
- Reload persistence differs by path:
  - plain `todo` calls survive in transcript tool-result details;
  - `/todo` command edits additionally append `customType: "user_todo_edit"` entries and inject a visible-to-model `<system-reminder>` developer message describing the manual edit.
- On session resume, `AgentSession.#syncTodoPhasesFromBranch()` strips `completed` and `abandoned` tasks before restoring the cached list. The `/todo` command works around that by reading the latest transcript/custom-entry state so historical done/dropped tasks still appear to the user.
- Tool availability is gated by `todo.enabled`, and the registry excludes it when `includeYield` is enabled (`packages/coding-agent/src/tools/index.ts`).
- Subagents do not inherit `todo`; `packages/coding-agent/src/task/executor.ts` filters it out as a parent-owned tool.
