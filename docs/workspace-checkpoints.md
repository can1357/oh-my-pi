# workspace checkpoints (`/checkpoint`, `/rollback`)

> Git-backed, content-addressed snapshots of your working tree plus a journaled rollback that always captures the pre-rollback state first. Snapshots live under `refs/omp/checkpoints/<sessionId>/<id>` and **never move HEAD or your branch**. Distinct from the conversation-context `checkpoint`/`rewind` *tools* (see [docs/tools/checkpoint.md](./tools/checkpoint.md)).

This feature is **opt-in and off by default** (`checkpoints.enabled = false`). The `/sessions` manager surfaces per-session checkpoint counts and links into a read-only list — see [sessions-manager.md](./sessions-manager.md).

## Source

- Core service: `packages/coding-agent/src/checkpoints/service.ts` (`WorkspaceCheckpointService`).
- Capture: `packages/coding-agent/src/checkpoints/capture.ts` (`captureWorkspaceTree`, `resolveWorkspaceIdentity`, `writeCheckpointRef`).
- Storage + journal: `packages/coding-agent/src/checkpoints/store.ts` (refs, atomic metadata JSON, rollback journal, validity checks).
- Rollback transaction: `packages/coding-agent/src/checkpoints/rollback.ts` (`runRollbackTransaction`).
- Types: `packages/coding-agent/src/checkpoints/types.ts` (`CheckpointMeta`, `WorkspaceIdentity`, `RollbackJournal`, `CheckpointError`).
- Post-rollback notification + auto triggers: `packages/coding-agent/src/checkpoints/notify.ts`, `auto-trigger.ts`.
- Commands: `packages/coding-agent/src/slash-commands/builtin-workspace.ts` (`/checkpoint`, `/rollback`).
- TUI list/selector: `packages/coding-agent/src/modes/components/checkpoint-list.ts`.
- Git primitives: `packages/coding-agent/src/utils/git.ts` (temp-index tree capture, `commit-tree`, `ref.update`, `diff.treeStatus`, `restorePathsFromTree`, `cat-file` size probe).
- Settings: `packages/coding-agent/src/config/settings-schema.ts` (`checkpoints.*`).

## What a checkpoint includes

A checkpoint is a **full snapshot of the working tree** — tracked files plus untracked, non-ignored files — captured through git plumbing (`git add -A` into a throwaway index, `write-tree`, `commit-tree -p <HEAD>`). Ignored files are never captured (the temp-index add respects `.gitignore`). HEAD, the current branch, and your index are never moved by a capture.

Each checkpoint records a metadata JSON (`CheckpointMeta`) beside the session artifacts containing:

- `id` — 10-char lowercase hex (5 random bytes); unique within the session.
- `sessionId`, `createdAt`, optional `label` (manual captures).
- `reason` — `manual` | `auto` | `pre-rollback` (`manual`/`pre-rollback` are retention-protected).
- `identity` — `repoRoot`, `worktreePath`, `headSha` (at capture), `branch` (at capture). Used for validation.
- `treeSha` — the captured working-tree tree object.
- `headShaAtCapture` — the HEAD the snapshot was parented to.
- `refName` — `refs/omp/checkpoints/<sessionId>/<id>`.
- `bytesCaptured` — logical bytes the snapshot represents (sum of blob sizes in `treeSha`). Because content is shared with existing git objects, this is an upper bound on what the capture *could* have added, not a delta.
- `skippedFiles` — paths excluded because they exceed `checkpoints.maxFileBytes`.

## Capture mechanics

1. `resolveWorkspaceIdentity` confirms `cwd` is inside a git repository (throws `CheckpointError` otherwise) and records `repoRoot`/`worktreePath`/`headSha`/`branch`.
2. `findOversizeFiles` enumerates untracked + modified paths and `lstat`s each; any regular file larger than `checkpoints.maxFileBytes` is excluded. If more than 50 files exceed the limit, the capture **aborts** with a clear error rather than half-snapshotting.
3. `captureWorkspaceTree` builds the tree (excluding the oversize pathspecs) and computes `bytesCaptured` from the tree's blobs.
4. `writeCheckpointRef` creates the snapshot commit (`commit-tree`, parented to `headSha`) and points the ref at it, all under the repo lock. Author/committer identity is synthetic (`omp checkpoints <checkpoints@oh-my-pi.local>`), never your own.
5. Metadata JSON is written **atomically (tmp file + rename) only after the ref exists**, so a crash between the two leaves an unreferenced ref (pruned later) and never metadata pointing at a missing snapshot.

**Dedup:** if the newest checkpoint of the session already has the candidate `treeSha`, the existing checkpoint is returned unchanged — no new ref, no new metadata, no new bytes. Dedup is by content hash, not timestamp.

## Storage, dedup, and retention

- **Ref:** `refs/omp/checkpoints/<sessionId>/<id>` in the repository that owns the session's worktree. Linked worktrees share the object database and refs, so a snapshot is visible from any worktree of the same repo (subject to identity scoping below).
- **Metadata:** atomic JSON beside the session artifacts (`<checkpointsRoot>/<sessionId>/<id>.json`).
- **Content-addressed dedup:** identical tree state costs ~0 additional disk because git objects are shared; the only per-checkpoint cost is the ref and the small metadata file.
- **Retention:** `pruneSession` keeps the newest checkpoints up to `checkpoints.retention.maxPerSession` (default 20). Oldest **automatic** (`reason: "auto"`) checkpoints are pruned beyond the cap; `manual` and `pre-rollback` checkpoints are **never** pruned. Pruning also deletes any orphan refs whose metadata is gone (e.g. left by a crash).
- **Session-scoped:** refs and metadata are namespaced by `sessionId`; a checkpoint from another session is never listed or applied here.

A checkpoint is **valid** iff its ref resolves **and** its metadata parses **and** its workspace identity matches the current checkout. `list` filters out entries that fail any of these, and `pendingRollback` surfaces an unfinished journal for startup recovery.

## Commands

### `/checkpoint`

- `/checkpoint [<label>]` — **bare** creates a manual checkpoint. If the working tree already matches the latest checkpoint, it reports "already current (unchanged)" instead of minting a duplicate, and prints a confirmation line (`Checkpoint <id> created` + `label:`/`reason:`).
- `/checkpoint list` — prints checkpoints newest-first (`id`, label-or-reason, age, bytes captured).
- `/checkpoint show <id-prefix>` — prints full metadata (reason, label, created, bytes captured, skipped count, repo, worktree, head, tree).

`/checkpoint` requires `checkpoints.enabled`; otherwise it prints the enable hint. In TUI mode the bare/list/show logic runs headless and prints to the status line.

### `/rollback`

- `/rollback` (no args, TUI) — opens the fullscreen `CheckpointListComponent` selector: list, inline inspect, and an inline confirm (`y`/`enter`) that performs the rollback.
- `/rollback <id-prefix>` (TUI with an id) — resolves the checkpoint by exact or prefix match and shows a confirmation dialog (`Roll back to checkpoint <id>? A safety checkpoint of the current state is created first.`) before rolling back.
- `/rollback <id-prefix>` (text/ACP) — resolves and rolls back on the typed command; there is no separate prompt, and it returns a clean failure message if the id matches no checkpoint or the rollback cannot complete.

Outside a git repository, `/checkpoint` and `/rollback` return a clean error / no-match message rather than touching the filesystem (capture throws `CheckpointError`; a non-repo `/rollback` simply matches no checkpoint).

## Rollback transaction

`runRollbackTransaction` is a journaled, crash-recoverable sequence **PREPARE → SAFETY → APPLY → VERIFY → COMMIT**:

1. **PREPARE** — recapture the current working tree into a base tree so the change set is computed against content-addressed truth, not status heuristics. If the base already equals the target tree, the transaction short-circuits (no safety capture, no writes) and returns success with zero restored/removed files.
2. **SAFETY** — **always** taken when the workspace differs from the target: a `pre-rollback` checkpoint of the current state is captured first (reusing the ordinary create path, so it is deduped, retained, and metadata-complete). This means "undo the rollback" is itself just another rollback.
3. **APPLY** — compute the minimal base→target diff (`git diff-tree --name-status`) and materialize it: restores land in both worktree and index; removals are `fs.rm`'d from the worktree and dropped from the index. HEAD/branch are never moved.
4. **VERIFY** — recapture the workspace and require it to match the target tree. Size-guard exclusions are legitimately allowed to differ (they were never part of the snapshot). On mismatch the journal is left in `failed` state and the workspace is left at the safety state; the transaction reports the residual paths.
5. **COMMIT** — the journal file is removed (its absence is the "no transaction in flight" signal).

The index/worktree staging distinction is intentionally collapsed: restored paths are written to both, so a rolled-back workspace has no phantom staged diff against the content on disk.

### File-behavior case matrix

Diff direction is base (current) → target (checkpoint):

| Situation | Result |
| --- | --- |
| File existed and was **modified** since the checkpoint | **Restored** to checkpoint content (worktree + index). |
| File was **created after** the checkpoint (present now, absent in target) | **Removed** — but only the paths that provably appear in the base→target diff, and only after the pre-rollback safety checkpoint has captured them (so they remain recoverable). |
| File was **deleted** since the checkpoint (absent now, present in target) | **Restored** from the checkpoint. |
| File **unchanged** between base and target | Untouched (not in the diff). |
| **Ignored** file (`.gitignore`) | **Never captured**, therefore never restored or removed. |
| **Binary** file | Captured as a blob and restored verbatim like any other file (content-addressed). |
| **Submodule** (gitlink) | Captured as a **gitlink only** — the recorded submodule commit pointer, not the submodule's contents. Restoring sets the gitlink SHA; submodule working trees are not walked. |

## Crash recovery

The rollback journal (`<checkpointsRoot>/<sessionId>/rollback-journal.json`) is rewritten atomically at each phase (`prepare` → `safety` → `apply` → `failed`). `RollbackPhase` is `"prepare" | "safety" | "apply" | "failed"`; an **absent** journal means no transaction is in flight. Because the journal is written before each mutating step and cleared only on COMMIT, a crash mid-transaction leaves either a recoverable journal or a completed safety checkpoint — never a half-applied workspace. On startup, `pendingRollback` exposes any unfinished journal so the process can surface a recoverable-state message to the user.

## Post-rollback invalidation

A successful rollback changes files behind the agent's back, so `emitWorkspaceRolledBack` (in `notify.ts`) appends a `workspace_rolled_back` custom session entry (carrying `checkpointId`, `sessionId`, `label`, `reason`, `treeSha`, `rolledBackAt`) and fans out to registered listeners. Each listener is failure-isolated: a throwing consumer is logged and skipped, so one stale-cache consumer cannot fail the others or the rollback. Registered invalidation (`auto-trigger.ts`) drops:

- filesystem scan caches for the rolled-back worktree,
- LSP diagnostics / restart for touched dirs (`notifyWorkspaceWatchedFiles`),
- stale patch expectations.

The transcript is preserved; the `workspace_rolled_back` entry tells a resumed session that the workspace changed.

## Auto checkpoints (opt-in, defaults OFF)

Triggers are conservative and never use prompt-wording heuristics:

- **`checkpoints.auto.gitOperations`** — an internal `tool_call` pre-hook (subscribed via `subscribeInternalBeforeToolCall`) matches destructive git command shapes and captures a checkpoint before the tool runs:
  - `git reset --hard`
  - `git clean -f` / `-fd` / `-fdx` (force, recursive) — **never** `-n` (dry-run)
  - `git restore .` / `git checkout .` (whole-tree `.` operand only)
  - `git push --force` (whole `--force` token; `--force-with-lease` excluded)
  - `git branch -D`
  - `git rebase` (resolution continuations `--abort`/`--continue`/`--skip`/`--quit`/`--edit-todo` excluded)

  Matchers require a literal `git` subcommand on the same simple command (no shell separators `;|&` bleed into it), so safe variants never fire.
- **`checkpoints.auto.riskyEdits`** — a deterministic threshold seam in the patch/edit pipeline: `countEditFiles` counts distinct `*** (Add|Update|Delete) File:` markers in `edit` `apply_patch` input; crossing `RISKY_EDIT_FILE_THRESHOLD` (5 files) arms the trigger. `patch`/`hashline`/`sloppy` edit modes touch at most one file and never arm it.

A debounce (`AUTO_CHECKPOINT_DEBOUNCE_MS = 60_000`) limits auto-checkpoints of the same session/workspace. Both triggers default to `false`.

## Isolated-worktree behavior

Linked worktrees of one repository share the object database and the `refs/omp/checkpoints/*` namespace, but metadata and **workspace identity** are scoped per session **and** per worktree. `identityMatches` compares `repoRoot` + `worktreePath` (HEAD and branch are deliberately excluded, so a checkpoint stays valid after you commit or switch branches — it just no longer matches HEAD). A checkpoint captured in worktree A is therefore **rejected** in worktree B: `rollback` returns `ok: false` with a clear "captured in <path>, not <path>" error, and `list` filters it out.

## Archive / kill / delete and checkpoints

- **Archive** (`/sessions` `A`) writes only the sidecar sentinel and **preserves all checkpoints** (refs + metadata untouched).
- **Kill** (current-session subagent tombstone release) **preserves checkpoints**.
- **Delete** (persisted session removal, confirmed twice) is the only path that cleans up a session's checkpoints: it calls `WorkspaceCheckpointService.deleteForSession`, which deletes every ref under the session's ref namespace and removes the metadata directory. This runs **only** through the confirmed delete flow — checkpoints are never silently dropped.

## Settings

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `checkpoints.enabled` | boolean | `false` | Master switch for `/checkpoint` and `/rollback`. |
| `checkpoints.auto.gitOperations` | boolean | `false` | Capture a checkpoint before destructive git commands. |
| `checkpoints.auto.riskyEdits` | boolean | `false` | Capture a checkpoint before a multi-file/large edit application (≥5 files). |
| `checkpoints.retention.maxPerSession` | number | `20` | Retention cap; oldest `auto` checkpoints pruned beyond it; `manual`/`pre-rollback` never pruned. |
| `checkpoints.maxFileBytes` | number | `10485760` (10 MiB) | Per-file ceiling; larger files are excluded (recorded in `skippedFiles`); >50 oversize files aborts the capture. |

All keys live under the `Workspace Checkpoints` UI group. The conversation-context `checkpoint.enabled` flag is a **separate** namespace and does not gate this feature.
