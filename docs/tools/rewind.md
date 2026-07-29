# rewind

> End an active checkpoint by pruning exploratory context and retaining a concise report.

## Source
- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/rewind.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — validates pending rewind state, applies the actual rewind, and injects the retained report.
  - `packages/coding-agent/src/session/session-manager.ts` — branches the persisted session tree and appends persisted summary/report entries.
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()` converts persisted `branch_summary` entries into LLM-visible `branchSummary` messages on rebuilt context.
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and shares the `checkpoint.enabled` gate.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `report` | `string` | Yes | Investigation findings. `execute()` trims it and rejects the empty result. |

## Outputs
The tool returns a single text result plus structured details:

- text body:
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`:
  - `report: string` — trimmed report text
  - `rewound: true`

The returned tool result is not the final rewind. `AgentSession` waits until `turn_end`, then applies the rewind side effects asynchronously.

## Flow
1. `RewindTool.createIf()` in `packages/coding-agent/src/tools/checkpoint.ts` hides the tool from subagents.
2. `RewindTool.execute()` rejects subagent calls with `ToolError("Checkpoint not available in subagents.")`.
3. It rejects calls with no active checkpoint using `ToolError("No active checkpoint.")`.
4. It trims `params.report`; if empty, it throws `ToolError("Report cannot be empty.")`.
5. It returns a `toolResult()` with `details.report` and `details.rewound = true`.
6. On the rewind tool result's `message_end`, `AgentSession` extracts the report from `details.report` or the first text content block and stores it in `#pendingRewindReport`.
7. On `turn_end`, if `#pendingRewindReport` is set, `AgentSession.#applyRewind()` runs.
8. `#applyRewind()` computes `safeCount = clamp(checkpointMessageCount, 0, agent.state.messages.length)`, calls `agent.replaceMessages(agent.state.messages.slice(0, safeCount))`, then resets the advisor runtime via `#advisorRuntime?.reset()`.
9. It then calls `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`. That moves the persisted session leaf back to the checkpoint entry and appends a new `branch_summary` entry whose `summary` is the rewind report.
10. If `checkpointEntryId` no longer resolves, it logs a warning and falls back to `branchWithSummary(null, report, { startedAt })`, branching from root instead.
11. `#applyRewind()` appends a hidden in-memory custom message `{ customType: "rewind-report", content: report, display: false }` and persists the same payload through `sessionManager.appendCustomMessageEntry("rewind-report", ...)` with `details = { startedAt, rewoundAt }`.
12. Finally it clears `#checkpointState` and `#pendingRewindReport`.

## Modes / Variants
- Normal rewind: checkpoint entry exists; session history branches from that exact entry.
- Fallback rewind: checkpoint entry ID is missing from the current session tree; rewind branches from root and logs a warning.
- Immediate turn-end apply: rewind side effects happen only after the surrounding assistant turn finishes, not inside `RewindTool.execute()`.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Replaces in-memory conversation history with the prefix ending at the checkpoint tool result.
  - Adds a hidden custom message `rewind-report` carrying the retained report.
  - Clears the active checkpoint state and pending rewind report.
  - Repositions the persisted session leaf to the checkpoint branch point and appends new session entries.
- Filesystem
  - Persists the new `branch_summary` and `custom_message` entries into the session `.jsonl` file through normal `SessionManager` append persistence.
  - Session files are named `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl` in the session directory; default directory selection is documented in `SessionManager.create()` as `~/.ompk/agent/sessions/<encoded-cwd>/` when no override is passed.
- User-visible prompts / interactive UI
  - The tool result itself is visible.
  - The persisted `branch_summary` becomes an LLM-visible `branchSummary` message when context is rebuilt from `SessionManager.buildSessionContext()` (via `createBranchSummaryMessage()` in `session-context.ts`); `packages/agent/src/compaction/messages.ts` renders it as a user-role text message using `packages/agent/src/compaction/prompts/branch-summary-context.md`.
  - The persisted `rewind-report` custom message also participates in rebuilt LLM context because `custom_message` entries are converted through `createCustomMessage()`.
- Background work / cancellation
  - Rewind application is deferred to `turn_end`. There is no separate job object or cancel handle.

## Limits & Caps
- Availability is gated by `checkpoint.enabled`, default `false`, in `packages/coding-agent/src/config/settings-schema.ts`.
- Top-level sessions only.
- Requires exactly one active checkpoint; there is no path to name or choose among multiple checkpoints.
- Report text must be non-empty after `trim()`.
- Rewind restores only the message prefix recorded by `checkpointMessageCount`; there is no file restore, artifact restore, blob restore, or process restore path.
- Persisted report/summary content is still subject to the global session persistence cap `MAX_PERSIST_CHARS = 500_000` in `packages/coding-agent/src/session/session-persistence.ts`.

## Errors
- `ToolError("Checkpoint not available in subagents.")` — thrown for subagent sessions.
- `ToolError("No active checkpoint.")` — thrown when no checkpoint state is present.
- `ToolError("Report cannot be empty.")` — thrown when the trimmed report is empty.
- Missing checkpoint entry IDs during apply do not fail the tool call; `#applyRewind()` catches the error, logs `Rewind branch checkpoint missing, falling back to root`, and branches from root.

## Notes
- Checkpoint selection is implicit. `rewind` always targets the single `#checkpointState` captured by the last successful `checkpoint`; there is no checkpoint list, label, or ID parameter.
- Restored state is transcript/session-tree state only:
  - in-memory `agent.state.messages` prefix up to `checkpointMessageCount`
  - persisted session leaf reset to `checkpointEntryId` or root fallback
  - retained rewind report as `branch_summary` and hidden `rewind-report` custom message
- Not restored:
  - filesystem contents
  - git state
  - artifacts under `packages/coding-agent/src/session/artifacts.ts`
  - blob-store payloads under `packages/coding-agent/src/session/blob-store.ts`
  - prompt history rows in `packages/coding-agent/src/session/history-storage.ts`
  - auth or other agent storage in `packages/coding-agent/src/session/agent-storage.ts`
- There is no concurrent-edit reconciliation. If code or session-adjacent state changes during the checkpoint window, rewind does not merge or revert them; it only drops conversation context and rewires the session branch.
- Rewind is not destructive to persisted session history. `branchWithSummary()` appends a new `branch_summary` entry and moves the leaf; it does not delete the abandoned path from the `.jsonl` session log. The active context is cut over to the new branch, but the old entries remain in session storage.
