/**
 * Workspace inspection through the agent's own shell.
 *
 * Everything here runs via `bash` over RPC rather than spawning git from Rust.
 * Two reasons: the sidecar already has the session's working directory, so there
 * is no cwd to resolve or keep in sync; and `bash` is dispatched concurrently by
 * the RPC server, so a `git diff` never blocks a streaming turn.
 *
 * Commands are pinned with `-c core.pager=cat` and `--no-color` so a user's
 * global git config cannot inject pager escapes or ANSI into what we parse.
 *
 * ## Records are newline-separated, not NUL-separated
 *
 * git's `-z` machine format exists so paths containing spaces, quotes or
 * newlines survive without escaping. It cannot be read through this transport:
 * measured against a live `--mode rpc-ui` sidecar, `printf 'AAA\0BBB\0CCC'`
 * comes back as `"AAABBBCCC"` — the NUL bytes are dropped silently. Of the
 * plausible separators only TAB and LF survive; VT, RS and US are dropped too.
 *
 * So every `-z` command is piped through `tr '\000' '\n'` in the shell, before
 * the bytes reach the transport. That keeps what `-z` is actually for — no
 * quoting, no escaping, so paths with spaces and quotes parse correctly — and
 * gives up only on paths containing a literal newline, which git itself treats
 * as pathological.
 *
 * Without this the records ran together: a status listing rendered as one row
 * whose path read `…/icons/128x128.png?? packages/desktop/…`, with a status code
 * embedded in the middle of a filename.
 */

import type { RpcBridge } from "../rpc/bridge";

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	truncated: boolean;
	workingDir?: string;
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";

export interface ChangedFile {
	path: string;
	/** Previous path for renames. */
	from?: string;
	status: ChangeStatus;
	staged: boolean;
	additions: number;
	deletions: number;
}

export interface DiffLine {
	kind: "add" | "del" | "ctx" | "meta";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	from?: string;
	binary: boolean;
	hunks: DiffHunk[];
}

async function run(bridge: RpcBridge, command: string): Promise<BashResult> {
	return (await bridge.bash(command)) as BashResult;
}

const GIT = "git -c core.pager=cat --no-optional-locks";

/** Turns git's NUL record separator into one the transport does not eat. */
const UNZ = "tr '\\000' '\\n'";

/** Every command runs at the repository root, so a path means one thing. */
function at(root: string): string {
	return `${GIT} -C ${shellQuote(root)}`;
}

/** A repo-relative path made absolute, for everything that is not git. */
export function absolute(root: string, path: string): string {
	return path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
}

/**
 * Three answers, not two.
 *
 * The old check mapped anything that was not the literal `true` to "not a git
 * repository", so a missing `git`, a shell failure or a directory that no longer
 * exists all rendered as a confident, wrong statement about the user's project.
 *
 * `exitCode` is the discriminator rather than the message, because git's error
 * is localised — measured on this machine it comes back as *"fatal: no es un
 * repositorio git"* — so any English match would report the wrong answer for
 * anyone not running git in English.
 */
export type RepositoryState = { kind: "repo"; root: string } | { kind: "none" } | { kind: "unknown"; detail: string };

/**
 * `--show-toplevel` rather than `--is-inside-work-tree`: it answers the same
 * question through its exit code *and* hands back the root, which every other
 * command here needs.
 *
 * The root is not a detail. `git status --porcelain` reports paths relative to
 * the **repository root**, while a pathspec and a `cat` resolve against the
 * process's working directory. For a session opened anywhere but the root those
 * are different places, so the file list was right and every follow-up missed —
 * measured from `packages/desktop/src-tauri`, `git diff HEAD -- <path>` returned
 * nothing where the same path anchored with `:/` returned 132 lines.
 */
export async function repositoryState(bridge: RpcBridge): Promise<RepositoryState> {
	// stderr stays redirected: outside a repository git writes a localised fatal
	// there, and merging it in would only give us a blob we cannot match on.
	const result = await run(bridge, `${GIT} rev-parse --show-toplevel 2>/dev/null`);
	const output = result.output.trim();

	if (result.exitCode === 0 && output.startsWith("/")) return { kind: "repo", root: output };
	// 128 is git's own "this is not a repository". Any other non-zero code is
	// something else failing — git missing from PATH exits 127, for one.
	if (result.exitCode === 128) return { kind: "none" };

	return {
		kind: "unknown",
		detail: output || `\`git rev-parse\` exited with ${result.exitCode ?? "no status"}`,
	};
}

/**
 * Changed files with per-file line counts.
 *
 * `--porcelain=v1 -z` is the stable machine format: NUL-separated, so paths with
 * spaces, quotes or newlines survive intact. Renames emit two NUL-terminated
 * entries (new path, then old).
 */
export async function changedFiles(bridge: RpcBridge, root: string): Promise<ChangedListing> {
	const git = at(root);
	const [statusResult, numstatResult] = await Promise.all([
		run(bridge, `${git} status --porcelain=v1 -z --untracked-files=all | ${UNZ}`),
		run(bridge, `${git} diff HEAD --numstat --no-color -z | ${UNZ}`),
	]);

	const counts = parseNumstat(numstatResult.output);
	const files: ChangedFile[] = [];

	for (const entry of splitStatus(statusResult.output)) {
		const count = counts.get(entry.path) ?? { additions: 0, deletions: 0 };
		files.push({ ...entry, ...count });
	}

	return {
		files: files.sort((a, b) => a.path.localeCompare(b.path)),
		truncated: statusResult.truncated || numstatResult.truncated,
	};
}

/** Unified diff for one file, or the whole tree when `path` is omitted. */
/**
 * One file's diff as git printed it, unparsed.
 *
 * `fileDiff` returns hunks for rendering; this is for the clipboard, where a
 * reconstruction from parsed hunks would quietly lose the header lines that
 * make a diff applicable. Same anchoring as everything else here — commands run
 * at the repository root, because the panels' paths are relative to it.
 */
export async function rawFileDiff(bridge: RpcBridge, root: string, path: string): Promise<string> {
	const result = await run(
		bridge,
		`${at(root)} diff HEAD --no-color --no-ext-diff --unified=3 -- ${shellQuote(path)}`,
	);
	/*
	 * Refuse rather than hand over a patch with a hole in it. The shell caps how
	 * much it returns and elides the middle, and the result still *looks* like a
	 * diff — header, hunks, the lot — so `git apply` accepts it and writes the
	 * wrong file. The flag has been on the response type all along and nothing
	 * read it.
	 */
	if (result.truncated) {
		throw new Error(
			"This diff is too large to copy — the shell truncated it, and a partial patch would not apply cleanly.",
		);
	}

	const diff = result.output.trim();
	if (diff) return diff;

	/*
	 * An untracked file has no diff against HEAD, so this quietly put an empty
	 * string on the clipboard for a row the panel was showing as all-additions —
	 * `fileDiff` has an untracked fallback and this did not.
	 *
	 * `--no-index` against /dev/null rather than a hand-assembled patch: git
	 * writes the real headers, so what lands on the clipboard is something `git
	 * apply` accepts. It exits 1 when the two differ, which is every time here,
	 * so the code says nothing and only its output does.
	 */
	const asNew = await run(
		bridge,
		`${at(root)} diff --no-color --no-ext-diff --no-index -- /dev/null ${shellQuote(path)}`,
	);
	if (asNew.truncated) {
		throw new Error(
			"This diff is too large to copy — the shell truncated it, and a partial patch would not apply cleanly.",
		);
	}
	return asNew.output.trim();
}

export async function fileDiff(bridge: RpcBridge, root: string, path?: string): Promise<DiffListing> {
	const git = at(root);
	const target = path ? ` -- ${shellQuote(path)}` : "";
	// `--no-ext-diff` keeps a configured external difftool from replacing the
	// unified format we parse.
	const result = await run(bridge, `${git} diff HEAD --no-color --no-ext-diff --unified=3${target}`);
	const diffs = parseUnifiedDiff(result.output);

	// Untracked files never appear in `git diff`; show their contents as additions.
	if (path && diffs.length === 0) {
		const untracked = await run(bridge, `${git} ls-files --others --exclude-standard -- ${shellQuote(path)}`);
		/*
		 * The exit code, not emptiness. Given a pathspec it cannot resolve,
		 * `ls-files` prints a *warning* — localised, so unmatchable — and a check
		 * for non-empty output took that warning for a file, went on to `cat` it,
		 * and printed "No such file or directory" into the diff as if it were the
		 * file's contents.
		 */
		if (untracked.exitCode === 0 && untracked.output.trim()) {
			const body = await run(bridge, `cat ${shellQuote(absolute(root, path))}`);
			return {
				diffs: [
					{
						path,
						binary: false,
						hunks: [
							{
								header: "@@ new file @@",
								lines: body.output.split("\n").map((text, index) => ({
									kind: "add" as const,
									text,
									newNo: index + 1,
								})),
							},
						],
					},
				],
				truncated: body.truncated,
			};
		}
	}

	return { diffs, truncated: result.truncated };
}

export interface FileListing {
	paths: string[];
	/** The full listing did not fit; what came back is a prefix. */
	truncated: boolean;
}

/**
 * A listing plus whether the shell cut it short.
 *
 * The flag is carried out to the panel rather than dropped here because the two
 * failures look identical from the inside: a repository with three changed files
 * and a repository whose status output was elided after three both hand back
 * three entries. Only the caller can say "and there are more".
 */
export interface ChangedListing {
	files: ChangedFile[];
	truncated: boolean;
}

export interface DiffListing {
	diffs: FileDiff[];
	truncated: boolean;
}

/**
 * Tracked + untracked paths, for the file tree.
 *
 * Bounded on purpose. The shell tool composes its reply through a 50 KB window
 * and, past it, returns the head, an elision marker and the tail — so asking for
 * a whole repository got roughly a fifth of it, in two disjoint pieces, with the
 * marker itself parsed as a filename. Measured on this repo: 6847 paths, 345 KB,
 * 1253 of them surviving.
 *
 * So ask for a number that fits and say when it did not, rather than silently
 * showing a fifth of a tree as if it were the tree.
 */
export async function listFiles(bridge: RpcBridge, root: string, limit = 800): Promise<FileListing> {
	const result = await run(
		bridge,
		`${at(root)} ls-files --cached --others --exclude-standard -z | ${UNZ} | head -n ${limit + 1}`,
	);

	const lines = result.output.split("\n").filter(Boolean);
	// The marker only appears when the window cut the stream; it is not a path.
	const elided = lines.some(line => ELISION.test(line));
	const paths = lines.filter(line => !ELISION.test(line));

	return {
		paths: paths.slice(0, limit).sort(),
		truncated: elided || paths.length > limit,
	};
}

/** The shell tool's "output was cut here" marker, e.g. `[…5594ln elided…]`. */
const ELISION = /\[[^\]]*elided[^\]]*\]/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * `XY <path>` records, one per line, with renames adding a second line holding
 * the old path. git emits these NUL-separated; see the module header for why
 * they arrive as newlines instead.
 */
export function splitStatus(raw: string): Array<Omit<ChangedFile, "additions" | "deletions">> {
	const parts = raw.split("\n");
	const out: Array<Omit<ChangedFile, "additions" | "deletions">> = [];

	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		if (record.length < 4) continue;

		const index = record[0];
		const worktree = record[1];
		const path = record.slice(3);
		// Either column can carry the rename. `git add -N <newpath>` after a rename
		// pairs it on the worktree side, so git writes ` R new\0old\0` — blank index
		// column, old path still following as its own record. Keying off the index
		// alone left that record to be parsed as a file of its own, so the panel grew
		// a phantom row whose path was the old path minus its first three characters.
		const isRename = index === "R" || index === "C" || worktree === "R" || worktree === "C";

		out.push({
			path,
			from: isRename ? parts[++i] : undefined,
			status: statusOf(index, worktree),
			staged: index !== " " && index !== "?",
		});
	}
	return out;
}

function statusOf(index: string, worktree: string): ChangeStatus {
	if (index === "?" || worktree === "?") return "untracked";
	const code = index !== " " ? index : worktree;
	switch (code) {
		case "M":
			return "modified";
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		default:
			return "unknown";
	}
}

/**
 * `adds\tdels\t<path>` per line, where `-` means binary. Tabs survive the
 * transport, so only the record separator needed changing.
 *
 * Renames are the one gap: `-z` numstat writes them as an empty path followed by
 * the old and new paths as their own records, so they fall through to 0/0. The
 * file still lists — it just shows no line counts.
 */
export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
	const counts = new Map<string, { additions: number; deletions: number }>();
	for (const record of raw.split("\n")) {
		if (!record.trim()) continue;
		const [adds, dels, ...rest] = record.split("\t");
		const path = rest.join("\t");
		if (!path) continue;
		counts.set(path, {
			additions: adds === "-" ? 0 : Number(adds) || 0,
			deletions: dels === "-" ? 0 : Number(dels) || 0,
		});
	}
	return counts;
}

export function parseUnifiedDiff(raw: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let hunk: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;

	// git diff output ends with a newline, so the split leaves a trailing empty
	// segment. Left in, it renders as a phantom context line at the end of the
	// last hunk and shifts the line numbers after it.
	const lines = raw.split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			current = { path: pathFromDiffHeader(line), binary: false, hunks: [] };
			files.push(current);
			hunk = null;
			continue;
		}
		if (!current) continue;

		if (line.startsWith("Binary files ")) {
			current.binary = true;
			continue;
		}
		if (line.startsWith("rename from ")) {
			current.from = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("+++ b/")) {
			current.path = line.slice("+++ b/".length);
			continue;
		}
		if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			oldNo = match ? Number(match[1]) : 0;
			newNo = match ? Number(match[2]) : 0;
			hunk = { header: line, lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;

		if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
		} else if (line.startsWith("-")) {
			hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
		} else if (line.startsWith("\\")) {
			hunk.lines.push({ kind: "meta", text: line.slice(1).trim() });
		} else {
			hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		}
	}

	return files;
}

function pathFromDiffHeader(line: string): string {
	// `diff --git a/x b/x`; the b/ side is authoritative and survives renames.
	const match = / b\/(.*)$/.exec(line);
	return match ? match[1] : line.slice("diff --git ".length);
}

/** Single-quote for POSIX sh, the only safe way to pass an arbitrary path. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
