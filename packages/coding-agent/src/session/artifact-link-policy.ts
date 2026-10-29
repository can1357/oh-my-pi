/**
 * Which entries of a session's artifacts directory a copy of that directory
 * may hard-link instead of duplicating.
 *
 * A hard link is safe exactly when nobody writes the file through that inode
 * again. Get it wrong and the cost is not disk: one session's later write
 * appears inside another session's history, silently, because both names point
 * at the same bytes. So the rule is an allow-list, and anything it does not
 * recognize is copied — a new artifact kind, a new directory, a file name that
 * does not parse, all copy.
 *
 * What is safe, and why:
 *
 * - `<id>.<tool>.log` at the top level, for the tool types below. These are
 *   published by `writeArtifact` (staged to a temp sibling, then `rename`d
 *   into place), so even a rewrite replaces the name rather than the bytes,
 *   and a link keeps the version it was taken from. Artifact ids are allocated
 *   upwards from the highest in the directory, so neither session reuses an id
 *   the other already wrote.
 *
 * What is not, and must stay a copy:
 *
 * - `local/` — the session's scratch space, written in place by the large-paste
 *   flow, the eval helpers and `write local://…`. Two sessions editing one
 *   file is exactly the failure this policy exists to prevent.
 * - `*.jsonl` — subagent transcripts. A session journal is appended through its
 *   own inode by whichever process owns it, so a link would pull the owner's
 *   later turns into the copy's history.
 * - Any nested directory, including a subagent's own artifacts directory: its
 *   contents are the two kinds above.
 * - Streamed tool output (`bash`, `eval`): `OutputSink` writes the artifact
 *   while the command runs, through the inode, so a link taken mid-command
 *   keeps receiving the source session's bytes.
 * - Single-shot in-place writes (`bash-original`, `browser-original`,
 *   `computer-original`, `read`, the `gh` and `ida` tool types): their tools
 *   write `Bun.write(path, …)` onto the artifact path itself. One write, but
 *   through the inode, and a copy that races it would link a half-written
 *   file that then grows.
 *
 * One writer this cannot speak for: `write`, `edit` and `bash` take any
 * absolute path, so an agent that writes into another session's artifacts
 * directory by hand reaches a linked file as it reaches any other. The link
 * makes that one mistake land in two histories instead of one.
 *
 * To add a tool type here, check that **every** writer of that type goes
 * through `writeArtifact`. The generic spill in `tools/output-meta.ts` names
 * the artifact after the tool and publishes it through `saveArtifact`, so it
 * is atomic whatever the name; what decides the answer is whether the tool
 * also writes its own artifact path directly, as the ones above do.
 */

/** `<id>.<tool>.log` at the top level of an artifacts directory. */
const ARTIFACT_LOG_NAME = /^\d+\.([A-Za-z0-9_-]+)\.log$/;

/**
 * Tool types whose artifacts are only ever published atomically by
 * `writeArtifact`, and which no tool shares a name with:
 * - `shake` — `SessionMaintenance` saves the recovery artifact of a shake.
 * - `async` — `AgentSession` saves the full output of an async job.
 */
const WRITE_ONCE_TOOL_TYPES: Record<string, true> = { shake: true, async: true };

/**
 * How a copy of an artifacts directory must reproduce `relativePath` (POSIX or
 * Windows separators, relative to the directory's root). `"link"` only for an
 * entry proven write-once; everything else, known or unknown, `"copy"`.
 */
export function artifactCopyMode(relativePath: string): "link" | "copy" {
	const segments = relativePath.split(/[\\/]/).filter(segment => segment.length > 0);
	if (segments.length !== 1) return "copy";
	const toolType = ARTIFACT_LOG_NAME.exec(segments[0])?.[1];
	return toolType !== undefined && WRITE_ONCE_TOOL_TYPES[toolType] === true ? "link" : "copy";
}
