/**
 * `grep` and `glob` that answer through the ovnfs daemon when the search root
 * lies in an ovnfs mount, and through `@oh-my-pi/pi-natives` otherwise.
 *
 * The caller names its ovnfs command (`ovnfsCommand`), whose daemon reports
 * the mount it serves ({@link runningDaemon}); a root below that mount is
 * searched by the daemon in the checkout's overlay, in-process, instead of
 * paying a kernel round trip per file. Any daemon failure (not reachable, op
 * unknown, arguments rejected) falls back to the native search with the same
 * arguments; an abort or timeout does not, and cancels the daemon's search.
 *
 * @example
 * const result = await grep({ pattern: "TODO", path: "/Users/me/checkouts/app" }, null, "ovnfs");
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { logger, relativePathWithinNormalizedRoot } from "@oh-my-pi/pi-utils";
import { callSocket, OvnfsError } from "./client";
import { forgetDaemon, runningDaemon } from "./daemon";

/** Per-match callback of `natives.grep`, run after the search. */
type GrepCallback = (error: Error | null, match: natives.GrepMatch) => void;
/** Per-match callback of `natives.glob`, run after the search. */
type GlobCallback = (error: Error | null, match: natives.GlobMatch) => void;

interface DaemonGrepMatch {
	path: string;
	line: number;
	text: string;
	before?: { line: number; text: string }[];
	after?: { line: number; text: string }[];
	truncated?: boolean;
	count?: number;
	column?: number;
}

interface DaemonGrepReply {
	matches: DaemonGrepMatch[] | null;
	total_matches: number;
	files_with_matches: number;
	files_searched: number;
	limit_reached?: boolean;
	skipped_oversized?: number;
}

interface DaemonGlobReply {
	matches: { path: string; type: "file" | "dir" | "symlink"; size: number; mtime: number }[] | null;
	total: number;
	truncated: boolean;
}

/**
 * True when native search would read `p` from the host filesystem: a host path
 * rather than a `scheme://` URL, through no filesystem or one that leaves host
 * paths native (`nativeLocalPaths`, as the tools' internal-URL filesystem does).
 */
function onHost(p: string, filesystem: natives.ShellFilesystem | undefined): boolean {
	return (
		path.isAbsolute(p) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && (!filesystem || filesystem.nativeLocalPaths === true)
	);
}

/**
 * Run `op` on `ovnfs`'s daemon when `root` lies in one of its checkouts.
 * Returns undefined when it does not, or the daemon is absent or failed
 * (caller falls back); rejects only on abort or timeout.
 */
async function callDaemon<T>(
	ovnfs: string,
	op: string,
	root: string,
	args: Record<string, unknown>,
	signal: unknown,
	timeoutMs: number | undefined,
): Promise<T | undefined> {
	const daemon = await runningDaemon(ovnfs);
	if (!daemon) return undefined;
	let dir: string;
	try {
		dir = await fs.realpath(root);
	} catch {
		return undefined;
	}
	// Strictly below: the daemon searches checkouts, not the folder listing them.
	if (!relativePathWithinNormalizedRoot(daemon.mount, dir)) return undefined;
	const controller = new AbortController();
	const external = signal instanceof AbortSignal ? signal : undefined;
	const onAbort = () => {
		const err = new Error("Aborted: Signal");
		err.name = "AbortError";
		controller.abort(err);
	};
	if (external?.aborted) onAbort();
	else external?.addEventListener("abort", onAbort, { once: true });
	const timer =
		timeoutMs && timeoutMs > 0
			? setTimeout(() => controller.abort(new Error("Aborted: Timeout")), timeoutMs)
			: undefined;
	try {
		controller.signal.throwIfAborted();
		for (const key in args) {
			const value = args[key];
			if (value === undefined || value === false || value === 0) delete args[key];
		}
		return await callSocket<T>(daemon.socket, op, { dir, ...args }, controller.signal);
	} catch (err) {
		if (controller.signal.aborted) throw controller.signal.reason;
		if (!(err instanceof OvnfsError)) forgetDaemon(ovnfs);
		logger.debug("ovnfs search failed; using native search", { op, root, error: String(err) });
		return undefined;
	} finally {
		clearTimeout(timer);
		external?.removeEventListener("abort", onAbort);
	}
}

/** `natives.grep`, answered by the daemon of the ovnfs command `ovnfs` when `options.path` lies in its mount. */
export async function grep(
	options: natives.GrepOptions,
	onMatch?: GrepCallback | null,
	ovnfs?: string,
): Promise<natives.GrepResult> {
	if (!ovnfs || !onHost(options.path, options.filesystem) || options.onMatches || options.type) {
		return natives.grep(options, onMatch);
	}
	const reply = await callDaemon<DaemonGrepReply>(
		ovnfs,
		"grep",
		options.path,
		{
			pattern: options.pattern,
			glob: options.glob,
			anchored: options.recursive === false,
			ignore_case: options.ignoreCase,
			multiline: options.multiline,
			hidden: options.hidden ?? true,
			no_ignore: options.gitignore === false,
			max_count: options.maxCount,
			offset: options.offset,
			before: options.contextBefore ?? options.context,
			after: options.contextAfter ?? options.context,
			max_columns: options.maxColumns,
			mode: options.mode,
			max_count_per_file: options.maxCountPerFile,
			exclude: options.exclude?.length ? options.exclude : undefined,
		},
		options.signal,
		options.timeoutMs,
	);
	if (!reply) return natives.grep(options, onMatch);
	const countMode = options.mode === natives.GrepOutputMode.Count;
	const matches = (reply.matches ?? []).map(m => {
		const match: natives.GrepMatch = {
			path: path.isAbsolute(m.path) ? options.path : m.path,
			lineNumber: m.line,
			line: m.text,
		};
		if (m.before) match.contextBefore = m.before.map(c => ({ lineNumber: c.line, line: c.text }));
		if (m.after) match.contextAfter = m.after.map(c => ({ lineNumber: c.line, line: c.text }));
		if (m.truncated) match.truncated = true;
		if (m.column && m.column > 0) match.column = m.column;
		if (countMode) match.matchCount = m.count;
		return match;
	});
	if (onMatch) for (const match of matches) onMatch(null, match);
	const result: natives.GrepResult = {
		matches,
		totalMatches: reply.total_matches,
		filesWithMatches: reply.files_with_matches,
		filesSearched: reply.files_searched,
	};
	// Native leaves these out unless set.
	if (reply.limit_reached) result.limitReached = true;
	if (reply.skipped_oversized) result.skippedOversized = reply.skipped_oversized;
	return result;
}

const DAEMON_FILE_TYPE = {
	[natives.FileType.File]: "file",
	[natives.FileType.Dir]: "dir",
	[natives.FileType.Symlink]: "symlink",
} as const;

const NATIVE_FILE_TYPE = {
	file: natives.FileType.File,
	dir: natives.FileType.Dir,
	symlink: natives.FileType.Symlink,
} as const;

/** `natives.glob`, answered by the daemon of the ovnfs command `ovnfs` when `options.path` lies in its mount. */
export async function glob(
	options: natives.GlobOptions,
	onMatch?: GlobCallback | null,
	ovnfs?: string,
): Promise<natives.GlobResult> {
	if (!ovnfs || !onHost(options.path, options.filesystem) || options.followLinks) {
		return natives.glob(options, onMatch);
	}
	const reply = await callDaemon<DaemonGlobReply>(
		ovnfs,
		"glob",
		options.path,
		{
			pattern: options.pattern,
			anchored: !(options.recursive ?? true),
			type: options.fileType ? DAEMON_FILE_TYPE[options.fileType] : undefined,
			hidden: options.hidden,
			limit: options.maxResults,
			sort_by_mtime: options.sortByMtime,
			no_ignore: options.gitignore === false,
			node_modules: options.includeNodeModules,
		},
		options.signal,
		options.timeoutMs,
	);
	if (!reply) return natives.glob(options, onMatch);
	const matches = (reply.matches ?? []).map(m => {
		const match: natives.GlobMatch = { path: m.path, fileType: NATIVE_FILE_TYPE[m.type] };
		if (m.mtime > 0) match.mtime = Math.floor(m.mtime / 1e6);
		if (m.size >= 0) match.size = m.size;
		return match;
	});
	if (onMatch) for (const match of matches) onMatch(null, match);
	return { matches, totalMatches: matches.length };
}
