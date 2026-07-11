import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import type { Skill } from "../extensibility/skills";
import { InternalUrlRouter, type LocalProtocolOptions } from "../internal-urls";
import { ToolError } from "./tool-errors";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// A single line-range chunk: `N`, `N-M`, `N+K`, or open-ended `N-`. `..` is
// accepted everywhere `-` is, as a forgiving alias for Rust/Python-style ranges
// (e.g. `2724..2727` == `2724-2727`, `2724..` == `2724-`); it is normalized to
// `-` in parseLineRangeChunk. Keep this fragment and LINE_RANGE_CHUNK_RE in sync.
const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;
// Permissive selector chunk for internal URLs — accepts well-formed selectors
// plus common malformed shapes (e.g. `:-N`) so the read tool peels the entire
// selector chain off before dispatching to a protocol handler.
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);
// Schemes whose host grammar is identifier-shaped, so any trailing
// `:<selector-chunk>` is unambiguously a read-tool selector. `mcp://` is
// excluded because mcp resource URIs may legitimately contain colons. `ssh://`
// is included despite an optional `:port`; `splitInternalUrlSel` skips the peel
// for an `ssh://host:port` that has no `/path`, so the port colon is never
// mistaken for a selector (a real ssh selector trails the `/path`, e.g.
// `ssh://h/f:1-5`).
const INTERNAL_SCHEMES_WITH_SELECTORS: Record<string, true> = {
	agent: true,
	artifact: true,
	issue: true,
	local: true,
	memory: true,
	omp: true,
	pr: true,
	rule: true,
	skill: true,
	ssh: true,
	vault: true,
};
// Schemes whose resource URIs are server-defined and may legitimately end
// with selector-shaped tails (e.g. `:raw`, `:conflicts`, `:1-50`, `/:raw`).
// `McpProtocolHandler` resolves by exact URI match (`r.uri === uri`), so
// peeling syntactically can make valid resources unreachable. Keep these
// schemes opaque; selector support for them needs a resolver-aware path that
// tries the exact URI before interpreting any suffix as a read selector.
const OPAQUE_RESOURCE_SCHEMES: ReadonlySet<string> = new Set(["mcp"]);
const INTERNAL_URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const NARROW_NO_BREAK_SPACE = "\u202F";
const TOP_LEVEL_INTERNAL_URL_PREFIXES = [
	"agent://",
	"artifact://",
	"skill://",
	"rule://",
	"local://",
	"mcp://",
	"ssh://",
	"vault://",
] as const;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function tryShellEscapedPath(filePath: string): string {
	if (!filePath.includes("\\") || !filePath.includes("/")) return filePath;
	return filePath.replace(/\\([ \t"'(){}[\]])/g, "$1");
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);

	// We only treat a leading "@" as a shorthand for a small set of well-known
	// syntaxes. This avoids mangling literal paths like "@my-file.txt".
	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		// Windows absolute paths (drive letters / UNC / root-relative)
		path.win32.isAbsolute(withoutAt) ||
		// Internal URL shorthands
		withoutAt.startsWith("agent://") ||
		withoutAt.startsWith("artifact://") ||
		withoutAt.startsWith("skill://") ||
		withoutAt.startsWith("rule://") ||
		withoutAt.startsWith("local:") ||
		withoutAt.startsWith("mcp://")
	) {
		return withoutAt;
	}

	return filePath;
}

function stripFileUrl(filePath: string): string {
	if (!filePath.toLowerCase().startsWith("file://")) return filePath;

	try {
		return url.fileURLToPath(filePath);
	} catch {
		return filePath;
	}
}

export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

export function expandPath(filePath: string): string {
	const normalized = stripFileUrl(normalizeUnicodeSpaces(normalizeAtPrefix(filePath)));
	return expandTilde(normalized);
}

function isAsciiDriveLetter(value: string): boolean {
	if (value.length !== 1) return false;
	const code = value.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function windowsDriveAliasPath(filePath: string): string | undefined {
	if (!filePath.startsWith("/")) return undefined;
	const parts = filePath.split("/");
	if (parts[0] !== "") return undefined;

	let drive: string | undefined;
	let tailStart = 2;
	if (parts.length >= 2 && isAsciiDriveLetter(parts[1] ?? "")) {
		drive = parts[1]!.toUpperCase();
	} else if (parts.length >= 3 && (parts[1] ?? "").toLowerCase() === "mnt" && isAsciiDriveLetter(parts[2] ?? "")) {
		drive = parts[2]!.toUpperCase();
		tailStart = 3;
	}
	if (!drive) return undefined;

	const tail = parts.slice(tailStart).filter(Boolean).join("\\");
	return tail ? `${drive}:\\${tail}` : `${drive}:\\`;
}

export function normalizeWindowsDriveAliasPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return filePath;
	return windowsDriveAliasPath(filePath) ?? filePath;
}

/**
 * Inclusive line range describing one selector segment (e.g. `50-100`,
 * `301-`, or `50+10`). `endLine` is `undefined` for open-ended ranges.
 */
export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

/** Parse a single `N`, `N-M`, `N-`, `N+K`, or `..`-aliased (`N..M`, `N..`) chunk. Throws via {@link ToolError} on invalid bounds. */
export function parseLineRangeChunk(sel: string): LineRange | null {
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	// `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973`). Returns
 * the ranges in ascending order with overlapping/adjacent ranges merged so
 * downstream consumers can stream the file in a single forward pass per range.
 */
export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);

	const merged: LineRange[] = [parsed[0]];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i];
		const last = merged[merged.length - 1];
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

/**
 * Extract the line-range component from a read-tool selector that may also
 * carry a verbatim/index display mode (`raw`, `conflicts`) — alone or compounded
 * with a range (`raw:50-100`, `50-100:raw`). Returns the parsed ranges when the
 * selector names any, otherwise `undefined` (pure `raw`/`conflicts`/none).
 *
 * Used by content search, which honors line ranges as a match filter but has no
 * use for verbatim/conflict display modes — so those selectors are accepted and
 * treated as an unfiltered, whole-resource search rather than rejected.
 */
export function selectorLineRanges(sel: string | undefined): [LineRange, ...LineRange[]] | undefined {
	if (!sel) return undefined;
	for (const chunk of sel.split(":")) {
		const lower = chunk.toLowerCase();
		if (lower === "raw" || lower === "conflicts") continue;
		const ranges = parseLineRanges(chunk);
		if (ranges) return ranges;
	}
	return undefined;
}

/** Return `true` when `lineNumber` (1-indexed) falls in any of the supplied ranges. */
export function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	for (const range of ranges) {
		if (lineNumber < range.startLine) continue;
		if (range.endLine === undefined || lineNumber <= range.endLine) return true;
	}
	return false;
}

export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	// Allow a compound trailing selector: `path:1-50:raw` or `path:raw:1-50`.
	// The two chunks must be one line-range plus one `raw`, in either order.
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

/**
 * Variant of {@link splitPathAndSel} for internal URLs (`scheme://...`).
 *
 * The filesystem-path splitter is intentionally conservative: it refuses to
 * peel a trailing `:<chunk>` unless that chunk matches the strict selector
 * grammar. That rule is right for filesystem paths (a file named `a:1-50` is
 * legal) but wrong for internal URLs, where any trailing `:<chunk>` after the
 * scheme is unambiguously a read-tool selector — even if malformed (e.g.
 * `artifact://3:raw:-100`).
 *
 * This function iteratively peels selector-shaped chunks (well-formed plus
 * common malformed shapes like `:-N`) so the rest of the read tool can pass a
 * clean URL to the protocol handler and surface selector errors via parseSel
 * instead of as misleading "host invalid" errors from the handler. Schemes
 * whose resource URIs may legitimately contain colons (`mcp://`) are skipped.
 *
 * Falls back to the input unchanged when nothing matches.
 */

export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(INTERNAL_URL_SCHEME_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1].toLowerCase();
	// Opaque schemes (mcp://, etc.) carry server-defined resource URIs that may
	// legitimately end in selector-shaped tails. Forward verbatim — see
	// OPAQUE_RESOURCE_SCHEMES.
	if (OPAQUE_RESOURCE_SCHEMES.has(scheme)) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;
	// ssh:// authority carries an optional `:port`; with no `/path` after the
	// authority, a trailing `:NNNN` is the port, not a read selector
	// (e.g. ssh://host:2222). Other schemes' authority-trailing selectors
	// (artifact://5:1-50) still peel, so this guard is ssh-specific.
	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		// Stop before crossing into the scheme separator `://`.
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

/**
 * Peel a read-tool selector off an internal-URL write target so `write` resolves
 * the same file `read` does (e.g. `ssh://h/f:raw` -> `ssh://h/f`). Only the
 * whole-file display modes `raw`/`conflicts` are accepted (they do not change
 * which bytes are written); any other selector-shaped tail `splitInternalUrlSel`
 * peels — a line range, a compound like `raw:1-20`, or a malformed `:-N` — throws,
 * because `write` addresses a whole file, not a partial range, and silently
 * stripping it would write to a path the caller never named. Non-URL paths and
 * URLs without a selector pass through unchanged.
 */
export function peelWriteUrlSelector(rawPath: string): string {
	const { path, sel } = splitInternalUrlSel(rawPath);
	if (sel === undefined) return rawPath;
	// Case-insensitive to match read's selector grammar (parseSel + the /i regexes above).
	if (/^(?:raw|conflicts)$/i.test(sel)) return path;
	throw new ToolError(
		`write does not accept the trailing selector ":${sel}" — it writes a whole file. ` +
			`Remove ":${sel}", or if the filename truly ends with it, percent-encode the ":" as %3A.`,
	);
}

function assertNotInternalUrl(expanded: string, original: string): void {
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expanded.startsWith(prefix)) {
			throw new Error(
				`Path "${original}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}
}

export function normalizeLocalScheme(filePath: string): string {
	return filePath.replace(/^(local:)\/(?!\/)/, "$1//");
}

export function isInternalUrlPath(filePath: string): boolean {
	const normalized = normalizeLocalScheme(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expandPath(normalized));
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expandedAndNormalized.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * True when a tool path argument references the `ssh://` scheme anywhere.
 *
 * Substring (not anchored) on purpose: it feeds the read/search/write approval
 * tier, which runs synchronously on the raw args. `search` only flattens a
 * delimited `paths: "a,ssh://h/x"` into separate entries *after* approval, so an
 * anchored check would let an embedded `ssh://` slip through at the read tier.
 * Matching the literal `ssh://` substring also tracks exactly what routes to the
 * SSH handler; over-matching only over-prompts (fail-closed).
 */
export function pathTargetsSsh(path: string): boolean {
	return /ssh:\/\//i.test(path);
}

/**
 * True when a path is specifically an `ssh://` URL (anchored scheme match).
 * Unlike {@link pathTargetsSsh} (substring, for the pre-expansion approval
 * scan), this is the exact per-entry check used to reject `ssh://` *before* a
 * side-effecting `InternalUrlRouter.resolve` in tools that need a local file.
 */
export function isSshUrl(path: string): boolean {
	return /^ssh:\/\//i.test(path.trim());
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 *
 * A bare root slash is treated as a workspace-root alias for tool inputs. Users
 * often pass `/` to mean “search from here”, and letting tools escape to the
 * filesystem root is almost never what they intended.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const normalized = normalizeLocalScheme(filePath);
	const expanded = normalizeWindowsDriveAliasPath(expandPath(normalized));
	const expandedAndNormalized = normalizeLocalScheme(expanded);

	assertNotInternalUrl(expandedAndNormalized, normalized);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

export function formatPathRelativeToCwd(
	filePath: string,
	cwd: string,
	options: { trailingSlash?: boolean } = {},
): string {
	const resolvedCwd = path.resolve(cwd);
	const normalized = normalizeLocalScheme(filePath);
	if (isInternalUrlPath(normalized)) {
		return normalized;
	}
	const expanded = expandPath(normalized);
	const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const relative = path.relative(resolvedCwd, resolvedPath);
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	let displayPath = normalizePosixPath(isWithinCwd ? relative || "." : resolvedPath);
	if (options.trailingSlash && displayPath !== "." && !displayPath.endsWith("/")) {
		displayPath += "/";
	}
	return displayPath;
}

/**
 * Strip matching surrounding double quotes from a path string.
 * Common when users paste quoted paths from Windows Explorer or shell copy-paste.
 * Only double quotes — single quotes are valid POSIX filename characters.
 * Tradeoff: a POSIX path literally starting AND ending with " would also be unquoted.
 * Accepted because such names are virtually nonexistent in practice.
 */
export function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1 ? input.slice(1, -1) : input;
}
function normalizePathSeparators(input: string): string {
	if (isInternalUrlPath(input)) return input;
	if (!input.includes("\\")) return input;
	return input.replace(/\\/g, "/");
}

export function normalizePathLikeInput(input: string): string {
	return stripOuterDoubleQuotes(input.trim());
}

const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const;

export function hasGlobPathChars(filePath: string): boolean {
	return GLOB_PATH_CHARS.some(char => filePath.includes(char));
}

type PathEntrySplitter = (item: string) => { basePath: string };

const TOP_LEVEL_WHITESPACE_RE = /\s/;

type DelimitedPathSplitMode = "comma" | "semicolon" | "whitespace" | "mixed";

function isDelimitedPathSeparator(ch: string, mode: DelimitedPathSplitMode): boolean {
	if (mode === "comma") return ch === ",";
	if (mode === "semicolon") return ch === ";";
	if (mode === "whitespace") return TOP_LEVEL_WHITESPACE_RE.test(ch);
	return ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
}

function hasTopLevelPathDelimiter(entry: string): boolean {
	let braceDepth = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch))) {
			return true;
		}
	}
	return false;
}

function splitTopLevelDelimitedPath(entry: string, mode: DelimitedPathSplitMode): string[] {
	const parts: string[] = [];
	let braceDepth = 0;
	let start = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || !isDelimitedPathSeparator(ch, mode)) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}

async function delimitedPathPartResolves(entry: string, cwd: string, splitter: PathEntrySplitter): Promise<boolean> {
	if (isInternalUrlPath(entry)) return true;
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	const absoluteBasePath = resolveToCwd(basePath, cwd);
	try {
		await fs.promises.stat(absoluteBasePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function tryDelimitedPathSplit(
	entry: string,
	cwd: string,
	splitter: PathEntrySplitter,
	mode: DelimitedPathSplitMode,
	requireAllParts: boolean,
): Promise<string[] | null> {
	const rawParts = splitTopLevelDelimitedPath(entry, mode);
	if (rawParts.length < 2) return null;

	const parts = rawParts.map(normalizePathLikeInput).filter(part => part.length > 0);
	if (parts.length === 0) return null;
	if (parts.length < 2 && rawParts.length === parts.length) return null;

	const resolved = await Promise.all(parts.map(part => delimitedPathPartResolves(part, cwd, splitter)));
	const valid = requireAllParts ? resolved.every(Boolean) : resolved.some(Boolean);
	return valid ? parts : null;
}

/**
 * Split one path-like entry whose multiple targets were flattened into one
 * string. Existing paths are kept intact, so real filenames containing spaces,
 * commas, or semicolons win over delimiter recovery.
 */
export async function splitDelimitedPathEntry(
	entry: string,
	cwd: string,
	options: { splitter?: PathEntrySplitter } = {},
): Promise<string[] | null> {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	if (isInternalUrlPath(normalizedEntry)) return null;

	const splitter = options.splitter ?? parseSearchPath;
	const peeledEntry = splitPathAndSel(normalizedEntry).path;
	if (!hasGlobPathChars(peeledEntry) && (await delimitedPathPartResolves(normalizedEntry, cwd, splitter))) {
		return null;
	}

	return (
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "semicolon", false)) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "comma", false)) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "whitespace", true)) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "mixed", true))
	);
}

/** Expand delimited entries in-place while preserving unsplit entries. */
export async function expandDelimitedPathEntries(
	entries: readonly string[],
	cwd: string,
	options: { splitter?: PathEntrySplitter } = {},
): Promise<string[]> {
	const expanded: string[] = [];
	for (const entry of entries) {
		const normalizedEntry = normalizePathLikeInput(entry);
		const split = await splitDelimitedPathEntry(normalizedEntry, cwd, options);
		if (split) expanded.push(...split);
		else expanded.push(normalizedEntry);
	}
	return expanded;
}

export interface ParsedSearchPath {
	basePath: string;
	glob?: string;
}

export interface ParsedFindPattern {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

export interface ResolvedSearchTarget {
	basePath: string;
	glob?: string;
}

export interface ResolvedMultiSearchPath {
	basePath: string;
	glob?: string;
	scopePath: string;
	exactFilePaths?: string[];
	targets?: ResolvedSearchTarget[];
}

export interface ResolvedFindTarget {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

export interface ResolvedMultiFindPattern {
	targets: ResolvedFindTarget[];
	scopePath: string;
}
export function parseSearchPath(filePath: string): ParsedSearchPath {
	const normalizedPath = normalizePathSeparators(filePath);
	const segments = normalizedPath.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPath };
	}

	if (firstGlobIndex <= 0) {
		return { basePath: ".", glob: normalizedPath };
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		glob: segments.slice(firstGlobIndex).join("/"),
	};
}

/**
 * Async sibling of {@link parseSearchPath} that prefers literal interpretation
 * when a path containing glob metacharacters resolves to an existing entry on
 * disk. Disambiguates Next.js/SvelteKit routes like `apps/[id]/page.tsx` —
 * without this, `[id]` is parsed as a glob character class and silently
 * matches nothing.
 */
export async function parseSearchPathPreferringLiteral(filePath: string, cwd: string): Promise<ParsedSearchPath> {
	if (!hasGlobPathChars(filePath) || isInternalUrlPath(filePath)) return parseSearchPath(filePath);
	try {
		await fs.promises.stat(resolveToCwd(filePath, cwd));
		return { basePath: normalizePathSeparators(filePath) };
	} catch {
		return parseSearchPath(filePath);
	}
}

// Parse a find pattern into a base directory path and a glob pattern.
// Examples:
//   src/app/**/\*.tsx -> { basePath: "src/app", globPattern: "**/*.tsx", hasGlob: true }
//   src/app/\*.tsx -> { basePath: "src/app", globPattern: "*.tsx", hasGlob: true }
//   \*.ts -> { basePath: ".", globPattern: "**/*.ts", hasGlob: true }
//   **/\*.json -> { basePath: ".", globPattern: "**/*.json", hasGlob: true }
//   /abs/path/**/\*.ts -> { basePath: "/abs/path", globPattern: "**/*.ts", hasGlob: true }
//   src/app -> { basePath: "src/app", globPattern: "**/*", hasGlob: false }
export function parseFindPattern(pattern: string): ParsedFindPattern {
	const normalizedPattern = normalizePathSeparators(pattern);
	const segments = normalizedPattern.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPattern, globPattern: "**/*", hasGlob: false };
	}

	if (firstGlobIndex === 0) {
		const needsRecursive = !normalizedPattern.startsWith("**/");
		return {
			basePath: ".",
			globPattern: needsRecursive ? `**/${normalizedPattern}` : normalizedPattern,
			hasGlob: true,
		};
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		globPattern: segments.slice(firstGlobIndex).join("/"),
		hasGlob: true,
	};
}

export function combineSearchGlobs(prefixGlob?: string, suffixGlob?: string): string | undefined {
	if (!prefixGlob) return suffixGlob;
	if (!suffixGlob) return prefixGlob;

	const normalizedPrefix = prefixGlob.replace(/\/+$/, "");
	const normalizedSuffix = suffixGlob.replace(/^\/+/, "");

	return `${normalizedPrefix}/${normalizedSuffix}`;
}

function normalizePosixPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function joinRelativeGlob(basePath: string | undefined, globPattern: string): string {
	if (!basePath || basePath === ".") return normalizePosixPath(globPattern).replace(/^\/+/, "");
	const normalizedBase = normalizePosixPath(basePath).replace(/\/+$/, "");
	const normalizedGlob = normalizePosixPath(globPattern).replace(/^\/+/, "");
	return `${normalizedBase}/${normalizedGlob}`;
}

function buildBraceUnion(patterns: string[]): string | undefined {
	const uniquePatterns = [...new Set(patterns.map(pattern => normalizePosixPath(pattern).trim()).filter(Boolean))];
	if (uniquePatterns.length === 0) return undefined;
	if (uniquePatterns.length === 1) return uniquePatterns[0];
	return `{${uniquePatterns.join(",")}}`;
}

function findCommonBasePath(paths: string[]): string {
	if (paths.length === 0) return ".";
	let commonParts = path.resolve(paths[0]).split(path.sep);
	for (const candidatePath of paths.slice(1)) {
		const candidateParts = path.resolve(candidatePath).split(path.sep);
		let sharedCount = 0;
		const maxShared = Math.min(commonParts.length, candidateParts.length);
		while (sharedCount < maxShared && commonParts[sharedCount] === candidateParts[sharedCount]) {
			sharedCount += 1;
		}
		commonParts = commonParts.slice(0, sharedCount);
	}
	if (commonParts.length === 0) {
		return path.parse(path.resolve(paths[0])).root;
	}
	const joined = commonParts.join(path.sep);
	return joined || path.parse(path.resolve(paths[0])).root;
}

function toScopeDisplay(items: string[], cwd: string): string {
	return items
		.map(item =>
			formatPathRelativeToCwd(item, cwd, {
				trailingSlash: item.endsWith("/") || item.endsWith("\\"),
			}),
		)
		.join(", ");
}

async function resolveSearchPathItems(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
	fanOutFileItems = false,
): Promise<ResolvedMultiSearchPath | undefined> {
	if (pathItems.length < 1) {
		return undefined;
	}

	const parsedItems = await Promise.all(
		pathItems.map(async item => {
			const parsedPath = await parseSearchPathPreferringLiteral(item, cwd);
			const absoluteBasePath = resolveToCwd(parsedPath.basePath, cwd);
			const stat = await fs.promises.stat(absoluteBasePath);
			return { raw: item, parsedPath, absoluteBasePath, stat };
		}),
	);

	const allExactFiles = !suffixGlob && parsedItems.every(item => !item.parsedPath.glob && item.stat.isFile());
	const commonBasePath = findCommonBasePath(parsedItems.map(item => item.absoluteBasePath));
	const combinedPatterns = parsedItems.map(item => {
		const relativeBasePath = normalizePosixPath(path.relative(commonBasePath, item.absoluteBasePath)) || ".";
		if (item.parsedPath.glob) {
			const pathGlob = joinRelativeGlob(relativeBasePath, item.parsedPath.glob);
			return combineSearchGlobs(pathGlob, suffixGlob) ?? pathGlob;
		}
		if (suffixGlob) {
			const pathPrefix = relativeBasePath === "." ? undefined : relativeBasePath;
			return combineSearchGlobs(pathPrefix, suffixGlob) ?? suffixGlob;
		}
		if (item.stat.isDirectory()) {
			return joinRelativeGlob(relativeBasePath, "**/*");
		}
		return relativeBasePath === "." ? path.basename(item.absoluteBasePath) : relativeBasePath;
	});
	// A single walk rooted at the common ancestor is only safe when that
	// ancestor is itself one of the requested scopes (e.g. `.` + `src/foo.ts`):
	// the walk then covers exactly what the caller asked for. When the common
	// ancestor is an unrequested parent (`.` + `~/.gitconfig` → `$HOME`, or
	// disjoint trees → `/`), a collapsed walk traverses every unrelated sibling
	// under it — fan out into per-item targets so each scan stays bounded to a
	// requested path.
	const commonIsRequestedScope = parsedItems.some(item => item.absoluteBasePath === commonBasePath);
	// Walkers prune `.git` unconditionally and honor gitignore, so a plain-file
	// item folded into a directory walk's glob union (`.` + `.git/config`) can
	// silently never match. Callers that dedupe overlapping results opt in via
	// `fanOutFileItems` to get explicit file targets, which bypass the walker.
	const demotesFileItem =
		fanOutFileItems && !allExactFiles && parsedItems.some(item => !item.parsedPath.glob && item.stat.isFile());
	const targets =
		parsedItems.length > 1 && (!commonIsRequestedScope || demotesFileItem)
			? parsedItems.map(item => ({
					basePath: item.absoluteBasePath,
					glob: item.parsedPath.glob ? combineSearchGlobs(item.parsedPath.glob, suffixGlob) : suffixGlob,
				}))
			: undefined;

	return {
		basePath: commonBasePath,
		glob: buildBraceUnion(combinedPatterns),
		scopePath: toScopeDisplay(pathItems, cwd),
		exactFilePaths: allExactFiles ? parsedItems.map(item => item.absoluteBasePath) : undefined,
		targets,
	};
}

export async function resolveExplicitSearchPaths(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
	fanOutFileItems = false,
): Promise<ResolvedMultiSearchPath | undefined> {
	return resolveSearchPathItems([...new Set(pathItems)], cwd, suffixGlob, fanOutFileItems);
}

async function resolveFindPatternItems(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	if (patternItems.length <= 1) {
		return undefined;
	}

	// Each path becomes its own walk root. Collapsing to a shared common ancestor
	// (and filtering with a brace-union glob) would force the walker to traverse
	// and stat every unrelated sibling under that ancestor — two paths under
	// $HOME would scan all of $HOME. The find tool fans these targets out in
	// parallel instead, so every scan stays bounded to exactly one requested path.
	const targets = patternItems.map(item => {
		const parsedPattern = parseFindPattern(item);
		return {
			basePath: resolveToCwd(parsedPattern.basePath, cwd),
			globPattern: parsedPattern.globPattern,
			hasGlob: parsedPattern.hasGlob,
		};
	});

	return {
		targets,
		scopePath: toScopeDisplay(patternItems, cwd),
	};
}

export async function resolveExplicitFindPatterns(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	return resolveFindPatternItems([...new Set(patternItems)], cwd);
}

/**
 * Result of partitioning a list of user-supplied paths/globs into entries whose
 * base directory currently exists on disk versus those that do not.
 *
 * Used by multi-path tools (search, find, ast_grep, ast_edit) to tolerate one
 * or more missing entries in a multi-path call: the surviving entries should
 * still be searched, with the missing entries surfaced as a non-fatal warning.
 */
export interface PartitionedPaths {
	/** Raw input strings whose resolved base path exists. */
	valid: string[];
	/** Raw input strings whose resolved base path is missing (ENOENT). */
	missing: string[];
}

/**
 * Stat each input's base path concurrently; return entries split by existence.
 *
 * `splitter` is expected to be {@link parseFindPattern} or
 * {@link parseSearchPath}: both return a `basePath` field that this helper
 * resolves against `cwd` and stats. ENOENT is the only swallowed error — every
 * other stat failure (permission, IO, etc.) propagates so callers do not silently
 * skip paths that exist but are unreadable.
 *
 * Order of `valid` and `missing` follows the input order, so callers can rely
 * on `valid[0]` matching the first surviving user-supplied entry.
 */
export async function partitionExistingPaths(
	items: string[],
	cwd: string,
	splitter: (item: string) => { basePath: string },
): Promise<PartitionedPaths> {
	const settled = await Promise.all(
		items.map(async item => {
			const { basePath } = splitter(item);
			const absoluteBasePath = resolveToCwd(basePath, cwd);
			try {
				await fs.promises.stat(absoluteBasePath);
				return { item, exists: true } as const;
			} catch (err) {
				if (isEnoent(err)) return { item, exists: false } as const;
				throw err;
			}
		}),
	);
	const valid: string[] = [];
	const missing: string[] = [];
	for (const entry of settled) {
		if (entry.exists) valid.push(entry.item);
		else missing.push(entry.item);
	}
	return { valid, missing };
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	const shellEscapedVariant = tryShellEscapedPath(resolved);
	const baseCandidates = shellEscapedVariant !== resolved ? [resolved, shellEscapedVariant] : [resolved];

	for (const baseCandidate of baseCandidates) {
		if (fileExists(baseCandidate)) {
			return baseCandidate;
		}
	}

	for (const baseCandidate of baseCandidates) {
		// Try macOS AM/PM variant (narrow no-break space before AM/PM)
		const amPmVariant = tryMacOSScreenshotPath(baseCandidate);
		if (amPmVariant !== baseCandidate && fileExists(amPmVariant)) {
			return amPmVariant;
		}

		// Try NFD variant (macOS stores filenames in NFD form)
		const nfdVariant = tryNFDVariant(baseCandidate);
		if (nfdVariant !== baseCandidate && fileExists(nfdVariant)) {
			return nfdVariant;
		}

		// Try curly quote variant (macOS uses U+2019 in screenshot names)
		const curlyVariant = tryCurlyQuoteVariant(baseCandidate);
		if (curlyVariant !== baseCandidate && fileExists(curlyVariant)) {
			return curlyVariant;
		}

		// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
		const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
		if (nfdCurlyVariant !== baseCandidate && fileExists(nfdCurlyVariant)) {
			return nfdCurlyVariant;
		}
	}

	return resolved;
}

// =============================================================================
// Tool-scope resolution (search/ast tools)
// =============================================================================

export interface ToolScopeOptions {
	rawPaths: string[];
	cwd: string;
	/** Verb used in the "Cannot {action} internal URL without a backing file: …" message. */
	internalUrlAction: string;
	/** Collect absolute paths flagged immutable by their internal-URL handler. */
	trackImmutableSources?: boolean;
	/** Honor `exactFilePaths` from {@link resolveExplicitSearchPaths} (search-only). */
	surfaceExactFilePaths?: boolean;
	/** Fan plain-file entries out into per-target scans instead of folding them
	 * into a directory walk's glob union (search-only: the caller must dedupe
	 * matches from overlapping targets). */
	fanOutFileTargets?: boolean;
	/** Extra hint appended to "Path not found" when stat fails and the user supplied multiple paths. */
	multipathStatHint?: string;
	/** Calling session's settings — forwarded to the internal-URL router so caller-aware handlers (issue://, pr://) honor it. */
	settings?: unknown;
	/** Caller's abort signal — forwarded to the internal-URL router. */
	signal?: AbortSignal;
	/** Calling session's `local://` root mapping — pins resolutions to the calling session. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Calling session's loaded skills — lets skill:// resolve without process-global state. */
	skills?: readonly Skill[];
}

export interface ToolScopeResolution {
	searchPath: string;
	scopePath: string;
	globFilter: string | undefined;
	isDirectory: boolean;
	multiTargets?: ResolvedSearchTarget[];
	exactFilePaths?: string[];
	missingPaths: string[];
	immutableSourcePaths: Set<string>;
}

/**
 * Shared path-input pipeline for `search`, `ast_grep`, and `ast_edit`:
 *  1. normalize + reject empty paths,
 *  2. resolve internal URLs through {@link InternalUrlRouter} to backing files,
 *  3. partition existing vs missing when multiple paths are supplied,
 *  4. derive a single search base path / glob, or a multi-target list,
 *  5. stat the resolved base path so callers can branch on directory vs file scope.
 */
export async function resolveToolSearchScope(opts: ToolScopeOptions): Promise<ToolScopeResolution> {
	const { rawPaths: inputs, cwd, internalUrlAction } = opts;
	const normalizedRawPaths = inputs.map(normalizePathLikeInput);
	if (normalizedRawPaths.some(rawPath => rawPath.length === 0)) {
		throw new ToolError("`paths` must contain non-empty paths or globs");
	}
	const rawPaths = await expandDelimitedPathEntries(normalizedRawPaths, cwd);
	if (rawPaths.some(rawPath => rawPath.length === 0)) {
		throw new ToolError("`paths` must contain non-empty paths or globs");
	}
	// External (http/https/ftp/file) URLs are not searchable; route the caller
	// to `read` instead of letting the path-resolver surface a confusing
	// "Path not found" for a slash-stripped URL.
	const externalUrl = rawPaths.find(rawPath => /^(?:https?|ftp|file|ws|wss):\/\//i.test(rawPath));
	if (externalUrl) {
		throw new ToolError(
			`Cannot ${internalUrlAction} external URL: ${externalUrl}. Use \`read\` to fetch web content, then search the returned text.`,
		);
	}
	const internalRouter = InternalUrlRouter.instance();
	const resolvedPathInputs: string[] = [];
	const immutableSourcePaths = new Set<string>();
	for (const rawPath of rawPaths) {
		if (!internalRouter.canHandle(rawPath)) {
			resolvedPathInputs.push(rawPath);
			continue;
		}
		if (isSshUrl(rawPath)) {
			throw new ToolError(
				`Cannot ${internalUrlAction} a remote ssh:// path (no local file): ${rawPath}. Use \`read ${rawPath}\` to view it, or the \`search\` tool to grep remote files.`,
			);
		}
		if (hasGlobPathChars(rawPath)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		const resource = await internalRouter.resolve(rawPath, {
			cwd,
			settings: opts.settings,
			signal: opts.signal,
			localProtocolOptions: opts.localProtocolOptions,
			skills: opts.skills,
		});
		if (!resource.sourcePath) {
			throw new ToolError(`Cannot ${internalUrlAction} internal URL without a backing file: ${rawPath}`);
		}
		if (opts.trackImmutableSources && resource.immutable) {
			immutableSourcePaths.add(path.resolve(resource.sourcePath));
		}
		resolvedPathInputs.push(resource.sourcePath);
	}

	let missingPaths: string[] = [];
	let effectivePaths = resolvedPathInputs;
	if (resolvedPathInputs.length > 1) {
		const partition = await partitionExistingPaths(resolvedPathInputs, cwd, parseSearchPath);
		if (partition.valid.length === 0) {
			throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
		}
		effectivePaths = partition.valid;
		missingPaths = partition.missing;
	}

	let searchPath: string;
	let scopePath: string;
	let globFilter: string | undefined;
	let multiTargets: ResolvedSearchTarget[] | undefined;
	let exactFilePaths: string[] | undefined;
	if (effectivePaths.length === 1) {
		const parsedPath = await parseSearchPathPreferringLiteral(effectivePaths[0] ?? ".", cwd);
		searchPath = resolveToCwd(parsedPath.basePath, cwd);
		globFilter = parsedPath.glob;
		scopePath = formatPathRelativeToCwd(searchPath, cwd);
	} else {
		const multiSearchPath = await resolveExplicitSearchPaths(
			effectivePaths,
			cwd,
			undefined,
			opts.fanOutFileTargets === true,
		);
		if (!multiSearchPath) {
			throw new ToolError("`paths` must contain at least one path or glob");
		}
		searchPath = multiSearchPath.basePath;
		multiTargets = multiSearchPath.targets;
		if (opts.surfaceExactFilePaths) {
			exactFilePaths = multiSearchPath.exactFilePaths;
			globFilter = exactFilePaths || multiTargets ? undefined : multiSearchPath.glob;
		} else {
			globFilter = multiTargets ? undefined : multiSearchPath.glob;
		}
		scopePath = multiSearchPath.scopePath;
	}

	let isDirectory: boolean;
	try {
		const stat = await Bun.file(searchPath).stat();
		isDirectory = stat.isDirectory();
	} catch {
		const hint = opts.multipathStatHint && rawPaths.length > 1 ? opts.multipathStatHint : "";
		throw new ToolError(`Path not found: ${scopePath}${hint}`);
	}

	return {
		searchPath,
		scopePath,
		globFilter,
		isDirectory,
		multiTargets,
		exactFilePaths,
		missingPaths,
		immutableSourcePaths,
	};
}
