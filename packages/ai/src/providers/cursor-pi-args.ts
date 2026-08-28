/**
 * Translate a Pi frame's args into the local tool kwargs that run it.
 *
 * Shared deliberately by three consumers: the provider synthesizes a display
 * block from these, the coding-agent bridge executes with them, and the legacy
 * pi shim performs the identical translation for the old wire. Separate
 * hand-rolled copies drift, and the drift is invisible — the transcript shows
 * one operation while a different one runs.
 *
 * Kept apart from `cursor/exec-modern.ts` on purpose: these are pure
 * string/path functions with no protobuf coupling, while that module pulls in
 * the generated cursor protobuf graph. The legacy shim is
 * compiled into the bundled virtual module registry, so importing it from a
 * nested path would drag the whole exec implementation in with it — and
 * `./providers/*` is a single-segment wildcard export that cannot serve a
 * nested specifier under bunfs (issue #3442).
 *
 * Every `optional int32` here is presence-sensitive: `0` is a supplied value,
 * not "unset", so it must never be folded into a default.
 */

import * as path from "node:path";

/**
 * A `pi_read` range composed onto the path as `read`'s inline `:raw:N+K`
 * selector.
 *
 * `read` exposes no range kwargs, so an uncomposed range reads the whole file.
 * `offset` is a 1-indexed start clamped like the reference's
 * `Math.max(0, offset - 1)` over 0-indexed lines; `limit` is a line count.
 * `null` marks a present `limit: 0` — zero lines, which no selector expresses
 * and which must not degrade into a whole-file read.
 *
 * The range is `raw` because a plain `:N+K` deliberately pads with one leading
 * and three trailing context lines: helpful for a human reading a snippet,
 * wrong for a caller that asked for exactly `limit` lines from `offset`. The
 * wire result is an opaque `output` string, so the hashline and line-number
 * gutter that `raw` also drops carry nothing the frame's contract needs.
 * A range-free read keeps the ordinary form — whole-file reads want them.
 */
export function piReadPath(readPath: string, offset?: number, limit?: number): string | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined;
	const count = limit !== undefined ? Math.floor(limit) : undefined;
	if (start === undefined && count === undefined) return readPath;
	const base = readPath.split(":").some(chunk => chunk.toLowerCase() === "raw") ? readPath : `${readPath}:raw`;
	if (start === undefined) return `${base}:1+${count}`;
	return count === undefined ? `${base}:${start}-` : `${base}:${start}+${count}`;
}

const READ_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

function isReadRangeList(value: string): boolean {
	return value.split(",").every(chunk => {
		const match = READ_RANGE_CHUNK_RE.exec(chunk);
		if (!match) return false;
		const start = Number.parseInt(match[1]!, 10);
		if (start < 1) return false;
		const separator = match[2];
		if (!separator) return true;
		const end = match[3] ? Number.parseInt(match[3], 10) : undefined;
		if (separator === "+") return end !== undefined && end >= 1;
		return end === undefined || end >= start;
	});
}

/**
 * Whether a read path ends in an OMP line selector, including compound `raw`
 * forms. Cursor uses this only to describe the operation already executed by
 * the coding-agent read tool; the selector remains embedded in the path.
 */
export function piReadPathHasRange(readPath: string): boolean {
	const chunks = readPath.split(":");
	const last = chunks.at(-1);
	if (last && isReadRangeList(last)) return true;
	if (last?.toLowerCase() !== "raw") return false;
	const preceding = chunks.at(-2);
	return preceding !== undefined && isReadRangeList(preceding);
}

/**
 * Force a Cursor exec read onto `read`'s verbatim `:raw` selector.
 *
 * Native `editToolCall` (StrReplace) materializes via `readArgs` then
 * `writeArgs`. The server treats the read result as file bytes and writes
 * them back. A hashline-formatted native read (`[path#TAG]` + `LINE:`
 * prefixes) poisons that cycle: the write would persist the markup.
 * `:raw` is the existing selector that drops both. A path that already
 * carries `raw` is left alone; a range-only selector gets `raw` inserted
 * so the range still applies without the gutter.
 */
export function cursorRawReadPath(readPath: string): string {
	const chunks = readPath.split(":");
	if (chunks.some(chunk => chunk.toLowerCase() === "raw")) return readPath;
	if (piReadPathHasRange(readPath)) {
		const last = chunks.pop()!;
		return `${chunks.join(":")}:raw:${last}`;
	}
	return `${readPath}:raw`;
}

/**
 * Path the edit-owned materialization read should execute.
 *
 * Range is composed first (`piReadPath` already uses `:raw` for a range),
 * then a whole-file path is forced onto `:raw`. The caller must drop
 * `offset`/`limit` after this so the bridge's `piReadPath` cannot append a
 * second `:raw` onto the already-composed selector.
 */
export function cursorEditOwnedReadPath(readPath: string, offset?: number, limit?: number): string | null {
	const ranged = piReadPath(readPath, offset, limit);
	if (ranged === null) return null;
	return cursorRawReadPath(ranged);
}

/**
 * The same range as {@link piReadPath}, rendered for a transcript block rather
 * than for execution.
 *
 * Differs only at `limit: 0`, where `piReadPath` returns `null` because no
 * selector reads zero lines and the frame is answered with empty output
 * directly. The block still has to say so: falling back to the bare path there
 * would record a whole-file read whose result is empty, which is the widest
 * possible gap between what a rebuilt transcript shows and what happened.
 * `+0` is never executed — it exists to be read.
 */
export function piReadDisplayPath(readPath: string, offset?: number, limit?: number): string {
	const composed = piReadPath(readPath, offset, limit);
	if (composed !== null) return composed;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : 1;
	return `${readPath}:raw:${start}+0`;
}

/**
 * A legacy `grep` frame's pagination `offset` as the local tool's file `skip`.
 *
 * `grep` paginates by file and reports "use skip=N for the next page" in that
 * same unit, so the offset maps across directly. A present `0` means "start at
 * the beginning", which is the unskipped search rather than a skip of zero.
 *
 * Shared because both the executing bridge and the provider's transcript
 * synthesis need it: a block showing an unskipped search beside a result from
 * a later file window misreports what was searched.
 */
export function piGrepSkip(offset?: number): number | undefined {
	return offset !== undefined && offset > 0 ? Math.floor(offset) : undefined;
}

/**
 * Join a Pi frame's optional `path` with the `glob`/`pattern` it scopes.
 *
 * The local `grep`/`glob` tools take one combined path spec. An absolute
 * pattern ignores the path, and an absent or `.` path leaves the pattern
 * standing alone rather than building a `./`- or `//`-prefixed spec.
 *
 * Uses `node:path` rather than string surgery so Windows absolutes (`C:\…`,
 * UNC) are recognised and separators stay normalized.
 */
export function piJoinPath(basePath: string | undefined, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!basePath || basePath === ".") return pattern;
	return path.join(basePath, pattern);
}

/**
 * The path a `pi_ls` frame lists.
 *
 * The frame's `limit` is deliberately NOT mapped. It caps directory *entries*
 * (the reference does a flat `readdir` and slices the entry array), while the
 * local `read` tool renders a depth-2 tree with per-directory caps and elision
 * summaries and applies a selector as a *rendered line* slice. Nested rows,
 * headers and "N more" lines all count toward that slice, so `:1+K` would cap
 * a different unit while looking honored — worse than leaving it unset, which
 * at least reports the local listing's own truncation faithfully.
 */
export function piLsPath(basePath: string | undefined): string {
	return basePath || ".";
}

/** Escape a literal string so the regex-only local `grep` tool matches it verbatim. */
export function piEscapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clamp a present `optional int32` result cap the way the reference does; `undefined` stays unset. */
export function piLimit(limit: number | undefined): number | undefined {
	return limit === undefined ? undefined : Math.max(1, Math.floor(limit));
}

/**
 * A `pi_bash` frame's timeout as the local `bash` tool's kwarg.
 *
 * Presence-sensitive like every other `optional int32` here, and unusually
 * load-bearing: `bash` documents `timeout: 0` as "disables the command
 * deadline", so folding a supplied `0` into `undefined` applies the 300s
 * default and kills exactly the long-running command that asked not to be.
 * Negative values have no local meaning and fall back to the default.
 */
export function piTimeout(timeout: number | undefined): number | undefined {
	return timeout !== undefined && timeout >= 0 ? timeout : undefined;
}

/**
 * Drop keys whose value is `undefined` so optional local-tool kwargs stay
 * absent rather than present-as-undefined.
 *
 * The Cursor exec bridge historically wrote forms like
 * `cwd: workingDirectory || undefined` and
 * `case: caseInsensitive === true ? false : undefined`. ArkType rejects a
 * present `undefined` on an optional field (`was undefined`) even though
 * omitting the key is valid — which flooded Cursor sessions with bash/grep
 * validation errors for otherwise fine frames.
 */
export function omitUndefinedArgs<T extends Record<string, unknown>>(
	args: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(args)) {
		const value = args[key];
		if (value !== undefined) out[key] = value;
	}
	return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
