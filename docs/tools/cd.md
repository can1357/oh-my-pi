# cd

> Move the session's working directory. Shown as `Change directory` in the UI.

## Source
- Entry: `packages/coding-agent/src/tools/cd.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cd.md`
- Key collaborators:
  - `packages/coding-agent/src/session/cwd-relocation.ts` — the relocation itself: settings flush, session/artifact move, rollback, and the re-scope of every cwd-derived cache
  - `packages/coding-agent/src/session/agent-session.ts` — `AgentSession.changeWorkingDirectory()`, the all-or-nothing entry point
  - `packages/coding-agent/src/session/session-manager.ts` — `moveTo()`, `captureState()`, `rollbackMove()`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Directory to make the session's working directory. Resolved against the current cwd; `~` is expanded. Must exist and be a directory. |

## Behavior

The change belongs to the session, not to a shell, so it is not a `cd` inside `bash`: the session file and its artifacts move into the destination project's session bucket, the process cwd follows, and the cwd-derived scope is rebuilt — project settings (`reloadForCwd`), the memory backend's scope, the plugin-root cache, the `TITLE_SYSTEM.md` override, and skills plus slash commands. Afterwards every relative path in `read`, `write`, `edit`, `glob`, `grep`, `find`, `bash`, `eval`, and subagent calls resolves against the new directory, and the per-request date/cwd reminder carries it.

The call is all-or-nothing. Pending settings are flushed first; if any step fails, the session file and the process are rolled back to the directory they started in and the result is an error naming the failed step. A failed rollback is reported as such — the session and the process may then disagree about the workspace — and is `fatal`.

Two `cd` calls in one turn never overlap: the tool is `exclusive`, so a batch containing one waits for the calls before it and holds the rest.

Moving to the directory already in effect is a no-op that succeeds.

## Outputs
- Success: one text block, `Working directory: <absolute path>`. `details.cwd` carries the new path and `details.previousCwd` the old one.
- Failure: one text block with the reason (`No such directory: …`, `Not a directory: …`, `Move failed: …`, `Cannot change working directory to …`) and `isError`.

## Boundaries
- Internal URLs (`skill://`, `local://`, `xd://`, `ssh://`) are rejected: the session cwd is a filesystem directory. `bash`'s own `cwd` argument still accepts a URL for a single command.
- The interactive TUI additionally repaints its status line, terminal title, and editor border through `AgentSession.onCwdChanged`. Headless hosts leave that hook unset.
- The `/btw` move gate is TUI-only state; a `cd` call is not routed through it.
