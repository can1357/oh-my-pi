# Files and conversation history

## Rewind in the terminal

Checkpoints are saved automatically before new prompts. In the chat input, type
`/rewind`, select a prompt with the arrow keys, press Enter, and confirm. Both
workspace files and the conversation return to before that prompt. `/redo`
restores both to before the last rewind; repeated redo walks successive rewinds.
A new prompt clears redo. Esc cancels the selector.

Wait for the agent to finish before restoring. If a restore is interrupted, run
`/rewind-recover` before continuing. Recovery is journaled before file writes;
conversation changes follow successful file restoration. New combined history
starts with prompts captured by this build, not legacy file-only checkpoints.

Capture is bounded. Ignored, remote, or uncaptured files are not protected.
Known local write/edit paths are declared before mutation, including absent files;
binary files are restored as bytes. Shell/MCP writes need pre-existing capture
coverage. These commands do not call a model.

## Legacy file-only interface


Capture is enabled automatically for persistent sessions. `/file-history on` re-enables capture after it was disabled.
Before each prompt, OMP captures the bounded workspace scope. Before tools run,
OMP declares their known local file paths after extension argument rewriting.
`/file-history list` lists checkpoint IDs; `/file-history restore <turn>` restores
that checkpoint. `/file-history redo` reverses the latest restore. All operations
keep the conversation intact. `/file-history off` stops automatic capture without
removing existing history. `/file-history clear` permanently deletes this session's
file checkpoints, disables automatic capture, and runs garbage collection. It
does not modify workspace files or the conversation. Shared content remains
protected and recently written blobs observe the GC grace period. Settings and snapshots survive session resumption.

This uses the official `filesnap@0.5.0` npm dependency and its native platform
binary. Standalone OMP builds embed the target platform executable and extract it
automatically into a private, content-addressed runtime directory on first use,
alongside its Apache-2.0 license and attribution notice.
Neither installation method requires a separate filesnap install or a Rust compiler;
standalone builds also need no Node/npm or runtime download. `FILESNAP_BIN` remains
an optional override for development. Cross-builds require installing optional
platform packages with `bun install --frozen-lockfile --os='*' --cpu='*'` first. The data
store lives beside OMP's agent database, outside the workspace. The integration
refuses a data directory inside the workspace.

Coverage combines Git-indexed files, explicitly declared edit paths and a bounded
recent-file scan. `.filesnapignore`, file-size and scan budgets still apply.
Shell/MCP changes can be restored only if their paths were already captured;
virtual and remote resource paths are not local file backups. This does not
restore an entire environment or distinguish simultaneous edits by other agents.

Restore first saves a safety checkpoint. Partial failures are reported; do not
continue editing before attempting `/file-history redo`. Redo can overwrite edits
made after a restore; preparation saves their state in a named recovery snapshot
before any write. Repeating redo reverses the preceding restoration. Use a single active OMP process per session while
managing file history. New/forked sessions have independent histories.

The existing model `checkpoint`/`rewind` tools continue to manage exploration
context. File history does not change their meaning.
