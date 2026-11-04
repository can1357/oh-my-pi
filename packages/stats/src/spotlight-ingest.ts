/**
 * Spotlight experiment facts the parser extracts from a session journal, for the Spotlight dashboard
 * (`spotlight-aggregator.ts`).
 *
 * A session is an experiment session from its first Spotlight marker on (see {@link experimentMarker}); from then the
 * parser records every evaluated result, every tool call (target, order, result size, the artifacts its result names)
 * and every main-loop request, so recoveries of hidden output can be detected later. Evaluated results come from two
 * entries that may land in different tail parses: the `spotlight:shape` journal entry (Spotlight's bill, timing) and
 * the result message's `details.spotlight` (what the model saw, the hidden lines). Both upsert the same row.
 *
 * Each shaped read (applied, held out or score-free) also collects the original lines the agent needed later (see
 * {@link SpotlightCollector}): its open reads ride in the parser state, so a later tail parse keeps collecting, and the
 * lines land in `spotlight_needs`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isRecord } from "@oh-my-pi/pi-utils";

/**
 * Whether a custom entry marks its session as a Spotlight experiment session: pi's `spotlight:session` entry, which
 * every session with the experiment on writes. Journals from before the experiment became a toggle carry
 * `spotlight:assignment` instead, naming the arm the session drew; only the arm that shipped shaped with the shipped
 * algorithm, so sessions of any other arm (`native`, `plain`, …) are not experiment sessions.
 */
export function experimentMarker(customType: unknown, data: Record<string, unknown>): boolean {
	if (customType === "spotlight:session") return true;
	return customType === "spotlight:assignment" && data.arm === "vylv5";
}

/** Longest stored call target. */
export const SPOTLIGHT_TARGET_CHARS = 500;

/** A shaped read still collecting the lines the agent needs later (see {@link SpotlightCollector}). */
export interface SpotlightOpenRead {
	toolCallId: string;
	/** The read file, resolved against the session's working directory. */
	file: string;
	/** First file line of the original and its line count. */
	start: number;
	lines: number;
	/** `original.url`: the session artifact holding the original text. */
	url: string | null;
}

/** Spotlight state a tail parse needs from earlier bytes of the same transcript. */
export interface SpotlightParserState {
	/** A Spotlight marker was seen: results, calls and requests are recorded from here on. */
	experiment: boolean;
	/** Tool calls recorded so far (the next call's order). */
	seq: number;
	/** The session header's working directory, for resolving relative read paths. */
	cwd: string | null;
	/** Latest session title. */
	title: string | null;
	/** Shaped reads still collecting needed lines; absent in cursors persisted before them. */
	open?: SpotlightOpenRead[];
}

export function emptySpotlightState(): SpotlightParserState {
	return { experiment: false, seq: 0, cwd: null, title: null, open: [] };
}

/** `spotlight_sessions` row: the session's first Spotlight marker. */
export interface SpotlightSessionRow {
	sessionFile: string;
	folder: string;
	markedAt: number;
	cwd: string | null;
	title: string | null;
}

/** `spotlight_results` row (upserted): one evaluated result, from its shape entry, its result details, or both. */
export interface SpotlightShapeRow {
	sessionFile: string;
	toolCallId: string;
	timestamp: number;
	tool: string;
	inChars: number;
	outChars: number;
	inTokens: number;
	outTokens: number;
	/** What pi would have shown unshaped (`plain`) for the call; null on traces written before pi recorded it. */
	plainChars: number | null;
	plainTokens: number | null;
	/**
	 * A cut wider than `plain` that pi did not apply (steps end with `plain-cap`): the would-be cut's tokens; the model
	 * got `plain`'s text (`outTokens`). Null otherwise.
	 */
	cappedTokens: number | null;
	/** The score-free coin skipped Spotlight: the no-score fallback rules shaped the result. */
	scoreFree: boolean;
	steps: string[];
	/** The result message carried `details.spotlight`. */
	hasDetails: boolean;
	/**
	 * Held out at random: Spotlight would have shortened it, but the model saw it unshaped; the token counts and
	 * `original` describe the would-be cut.
	 */
	holdout: boolean;
	/**
	 * Kept whole by the edit gate (an edit-likely read): the model saw `plain`'s page; like a held-out result, the
	 * token counts and `original` describe the would-be cut.
	 */
	gated: boolean;
	/** pi's edit-likely mark of a read (see `SpotlightEditGate`); null on traces written before pi marked reads. */
	editLikely: boolean | null;
	/** `details.spotlight.original` (present only when shaping changed the text). */
	original: SpotlightOriginalFacts | null;
	/** Artifact ids the result names (its text's `artifact://N` plus `original.url`); null before the result lands. */
	artifacts: number[] | null;
	/** Spotlight's own usage, from the shape entry; null before it lands. */
	spotlight: { calls: number; failures: number; ms: number; costUsd: number } | null;
	/** Wall time shaping took, from the shape entry. */
	shapeMs: number | null;
}

export interface SpotlightOriginalFacts {
	url: string | null;
	path: string | null;
	/** First original line of the window (1-based file line for reads, else 1). */
	start: number;
	lines: number;
	/** Hidden absolute line ranges, inclusive: the window minus the kept ranges. */
	hidden: [number, number][];
	hiddenLines: number;
	/** Spotlight's per-line heat (`0`–`9`, `-` unscored) over the first lines; null when the trace has none. */
	heat: string | null;
	/** Kept runs, 1-based positions in the original (of a held-out result: what the cut would have kept). */
	kept: [number, number][];
}

/**
 * `spotlight_needs` row (merged on upsert): original lines (1-based positions in the original) a shaped read's later
 * calls needed. Ranges of later parses are added to the stored ones; `open` is the latest.
 */
export interface SpotlightNeedRow {
	sessionFile: string;
	toolCallId: string;
	file: string;
	/** Still collecting: no edit, whole-file read or later shaped read of the file yet. */
	open: boolean;
	/** Lines later `read` selections covered. */
	reread: [number, number][];
	/** Lines later `edit` Find blocks located in the original. */
	edit: [number, number][];
}

/** `spotlight_calls` row: one tool call of an experiment session. */
export interface SpotlightCallRow {
	sessionFile: string;
	toolCallId: string;
	entryId: string;
	timestamp: number;
	seq: number;
	toolName: string;
	callsInTurn: number;
	target: string;
	/** Files an `edit`/`write`/`ast_edit` call changes, as written (relative paths unresolved); null for other calls. */
	edits: string[] | null;
	/** {@link argumentTokens} of the call, for the generic rerun rule; null for `read` and `bash` (own rules). */
	argTokens: string[] | null;
}

/** Result facts of a recorded call, applied as an update (the result can land in a later tail parse). */
export interface SpotlightCallResultLink {
	sessionFile: string;
	toolCallId: string;
	resultChars: number;
	artifacts: number[];
}

/** `spotlight_requests` row: a main-loop assistant message of an experiment session (side requests excluded). */
export interface SpotlightRequestRow {
	sessionFile: string;
	entryId: string;
	timestamp: number;
}

/** Everything one parse extracted for the Spotlight tables. */
export interface SpotlightParseRows {
	sessions: SpotlightSessionRow[];
	/** Title changes of experiment sessions seen after their marker. */
	titles: { sessionFile: string; title: string }[];
	shapes: SpotlightShapeRow[];
	calls: SpotlightCallRow[];
	callResults: SpotlightCallResultLink[];
	requests: SpotlightRequestRow[];
	needs: SpotlightNeedRow[];
}

export function emptySpotlightRows(): SpotlightParseRows {
	return { sessions: [], titles: [], shapes: [], calls: [], callResults: [], requests: [], needs: [] };
}

export function spotlightRowCount(rows: SpotlightParseRows): number {
	return (
		rows.sessions.length +
		rows.titles.length +
		rows.shapes.length +
		rows.calls.length +
		rows.callResults.length +
		rows.requests.length +
		rows.needs.length
	);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const ARTIFACT_RE = /artifact:\/\/(\d+)/g;

/** Distinct `artifact://N` ids a text names, ascending. */
export function artifactIds(text: string): number[] {
	if (!text.includes("artifact://")) return [];
	const ids = new Set<number>();
	for (const match of text.matchAll(ARTIFACT_RE)) ids.add(Number(match[1]));
	return [...ids].sort((a, b) => a - b);
}

/**
 * What a call asked for, as recovery detection compares it: a read's path with its selector, a bash command, a
 * search pattern with its path, eval code. Clipped to {@link SPOTLIGHT_TARGET_CHARS}.
 */
export function callTarget(toolName: string, args: unknown): string {
	const a: Record<string, unknown> = isRecord(args) ? args : {};
	const str = (key: string): string => {
		const value = a[key];
		return typeof value === "string" ? value : "";
	};
	let target: string;
	if (toolName === "read") target = str("path");
	else if (toolName === "bash") target = str("command");
	else if (toolName === "eval") target = str("code");
	else if (typeof a.pattern === "string") target = [str("pattern"), str("path")].filter(Boolean).join(" ");
	else if (typeof a.query === "string") target = [str("query"), str("path")].filter(Boolean).join(" ");
	else if (typeof a.path === "string") target = str("path");
	else {
		try {
			target = JSON.stringify(args ?? {});
		} catch {
			target = "";
		}
	}
	return target.slice(0, SPOTLIGHT_TARGET_CHARS);
}

/** Top-level arguments that say why, not what: the intent note every omp tool takes. */
const NOTE_ARGUMENTS = new Set(["i"]);
/** Argument keys whose string values are paths (or URLs), kept as one token even with spaces. */
const PATH_ARGUMENT = /(?:^|_)(?:path|file|dir|cwd|url)s?$/i;
/** Most tokens kept per call (the first distinct ones), and the longest token. */
const ARGUMENT_TOKEN_LIMIT = 256;
const ARGUMENT_TOKEN_CHARS = 200;

/**
 * A call's arguments as a token set for the generic rerun rule (two calls of the same tool rerun when their sets'
 * Jaccard similarity is high): every JSON leaf as `key=value`, the key being the nearest object key; strings split
 * on whitespace except under path keys (`path`, `paths`, `file`, `cwd`, `url`, …), which stay whole; nulls dropped;
 * the top-level intent note `i` left out. Distinct tokens in first-seen order, at most
 * {@link ARGUMENT_TOKEN_LIMIT}, each clipped to {@link ARGUMENT_TOKEN_CHARS} chars.
 */
export function argumentTokens(args: unknown): string[] {
	const tokens = new Set<string>();
	const add = (key: string, value: string) => {
		if (tokens.size < ARGUMENT_TOKEN_LIMIT) tokens.add(`${key}=${value}`.slice(0, ARGUMENT_TOKEN_CHARS));
	};
	const visit = (value: unknown, key: string, top: boolean): void => {
		if (tokens.size >= ARGUMENT_TOKEN_LIMIT || value === null || value === undefined) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, key, false);
		} else if (isRecord(value)) {
			for (const child in value) {
				if (!(top && NOTE_ARGUMENTS.has(child))) visit(value[child], child, false);
			}
		} else if (typeof value === "string") {
			if (PATH_ARGUMENT.test(key)) {
				const whole = value.trim();
				if (whole) add(key, whole);
			} else {
				for (const part of value.split(/\s+/)) if (part) add(key, part);
			}
		} else if (typeof value === "number" || typeof value === "boolean") {
			add(key, String(value));
		}
	};
	visit(args, "", true);
	return [...tokens];
}

const URL_SCHEME = /^[a-z][\w+.-]*:\/\//i;
/** Patch headers naming a changed file: `*** Edit File: PATH` (optionally ` all`), apply-patch headers too. */
const EDIT_HEADER = /^\*\*\* (?:Edit|Update|Add|Delete) File: (.+?)(?: all)?\s*$|^\*\*\* Move to: (.+?)\s*$/gm;

function unquotePath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith('"')) return trimmed;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "string" ? parsed : trimmed;
	} catch {
		return trimmed;
	}
}

function filePaths(values: readonly unknown[]): string[] {
	const paths = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const file = unquotePath(value);
		if (file && !URL_SCHEME.test(file)) paths.add(file);
	}
	return [...paths];
}

/**
 * Files a call changes: an `edit`'s patch headers (or its `path`), a `write`'s `path`, an `ast_edit`'s `paths`
 * (globs kept as written), also when `ast_edit` runs through `write xd://ast_edit`. Null when the call is no file
 * edit (other tools, or a write to an internal URL such as `proc://…/kill`).
 */
export function editedPaths(toolName: string, args: unknown): string[] | null {
	if (!isRecord(args)) return null;
	let paths: string[];
	if (toolName === "edit") {
		const headers: unknown[] = [];
		if (typeof args.input === "string") {
			for (const match of args.input.matchAll(EDIT_HEADER)) headers.push(match[1] ?? match[2]);
		}
		paths = filePaths(headers.length > 0 ? headers : [args.path]);
	} else if (toolName === "ast_edit") {
		paths = filePaths(Array.isArray(args.paths) ? args.paths : [args.path]);
	} else if (toolName === "write") {
		if (args.path === "xd://ast_edit" && typeof args.content === "string") {
			try {
				return editedPaths("ast_edit", JSON.parse(args.content));
			} catch {
				return null;
			}
		}
		paths = filePaths([args.path]);
	} else {
		return null;
	}
	return paths.length > 0 ? paths : null;
}

/** A read target split into its path and selected lines. */
export interface ReadSelection {
	path: string;
	/** Selected inclusive line ranges; empty with `tail` null means the whole file. */
	ranges: [number, number][];
	/** `:-N`: the last N lines. */
	tail: number | null;
}

const SELECTOR_CHUNK = /:(raw|conflicts|img|-?\d+(?:[-+]\d*)?(?:,-?\d+(?:[-+]\d*)?)*)$/i;

/** Split a read path into the path and its selector (`file.ts:10-40`, `:50+20`, `:-30`, `:5-9,20`, `:raw`). */
export function parseReadSelection(target: string): ReadSelection {
	let rest = target.trim();
	const ranges: [number, number][] = [];
	let tail: number | null = null;
	for (let match = SELECTOR_CHUNK.exec(rest); match && match.index > 0; match = SELECTOR_CHUNK.exec(rest)) {
		const chunk = match[1];
		rest = rest.slice(0, match.index);
		if (/^(?:raw|conflicts|img)$/i.test(chunk)) continue;
		for (const part of chunk.split(",")) {
			const tailMatch = /^-(\d+)$/.exec(part);
			if (tailMatch) {
				tail = Number(tailMatch[1]);
				continue;
			}
			const range = /^(\d+)(?:([-+])(\d*))?$/.exec(part);
			if (!range) continue;
			const start = Number(range[1]);
			const bound = range[3] ? Number(range[3]) : null;
			if (range[2] === "+" && bound !== null) ranges.push([start, start + Math.max(bound, 1) - 1]);
			else if (range[2] === "-" && bound !== null) ranges.push([start, bound]);
			else ranges.push([start, Number.POSITIVE_INFINITY]);
		}
	}
	return { path: rest, ranges, tail };
}

/** A read selection's lines; null for the whole file. */
export function selectedLines(selection: ReadSelection): [number, number][] | null {
	return selection.ranges.length === 0 && selection.tail === null ? null : selection.ranges;
}

/** A path as written, resolved against the session's working directory (URLs and absolute paths kept). */
export function resolveReadPath(target: string, cwd: string | null): string {
	if (URL_SCHEME.test(target) || !cwd || path.isAbsolute(target)) return target;
	return path.resolve(cwd, target);
}

/** One `*** Find` block of an `edit` input and the file its section edits (null: the call's `path`). */
export interface EditFindBlock {
	file: string | null;
	/** `*** Edit File: PATH all`: every occurrence is replaced. */
	all: boolean;
	lines: string[];
}

const EDIT_FILE_HEADER = /^\*\*\* (?:Edit|Update) File: (.+?)( all)?\s*$/;
const PATCH_HEADER = /^\*\*\* [A-Z]/;

/** The `*** Find` blocks of an `edit` call's input, with the file each one's section edits. */
export function editFindBlocks(input: string): EditFindBlock[] {
	const blocks: EditFindBlock[] = [];
	let file: string | null = null;
	let all = false;
	let block: EditFindBlock | null = null;
	for (const line of input.split("\n")) {
		if (PATCH_HEADER.test(line)) {
			block = null;
			const header = EDIT_FILE_HEADER.exec(line);
			if (header) {
				file = unquotePath(header[1]);
				all = header[2] !== undefined;
			} else if (line.trimEnd() === "*** Find") {
				block = { file, all, lines: [] };
				blocks.push(block);
			}
			continue;
		}
		block?.lines.push(line);
	}
	return blocks;
}

const GAP = "…";

/** Whether original line `line` matches Find line `find`: equal up to trailing space, or its `…`-split pieces in order. */
function findLineMatches(line: string, find: string): boolean {
	if (!find.includes(GAP)) return line.trimEnd() === find.trimEnd();
	let at = 0;
	for (const piece of find.split(GAP)) {
		const literal = piece.trim();
		if (!literal) continue;
		const found = line.indexOf(literal, at);
		if (found === -1) return false;
		at = found + literal.length;
	}
	return true;
}

/**
 * Where a Find block's text lies in `original` (lines): every match as 1-based inclusive `[first, last]` positions.
 * A Find line ending in `…` (or a lone `…` line) may skip original lines before the next Find line matches; blank
 * lines around the block are ignored.
 */
export function locateFind(original: readonly string[], find: readonly string[]): [number, number][] {
	let lo = 0;
	let hi = find.length;
	while (lo < hi && find[lo].trim() === "") lo++;
	while (hi > lo && find[hi - 1].trim() === "") hi--;
	const block = find.slice(lo, hi);
	while (block.length > 0 && block[0].trim() === GAP) block.shift();
	if (block.length === 0) return [];
	const spans: [number, number][] = [];
	for (let first = 0; first < original.length; first++) {
		if (!findLineMatches(original[first], block[0])) continue;
		let at = first;
		let gap = block[0].trimEnd().endsWith(GAP);
		let matched = true;
		for (let k = 1; k < block.length && matched; k++) {
			const find = block[k];
			if (find.trim() === GAP) {
				gap = true;
				continue;
			}
			if (gap) {
				let next = at + 1;
				while (next < original.length && !findLineMatches(original[next], find)) next++;
				matched = next < original.length;
				at = next;
			} else {
				matched = at + 1 < original.length && findLineMatches(original[at + 1], find);
				at++;
			}
			gap = find.trimEnd().endsWith(GAP);
		}
		if (!matched) continue;
		spans.push([first + 1, at + 1]);
		first = at;
	}
	return spans;
}

/** Union of inclusive ranges, sorted and merged (touching ranges join). */
export function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
	const sorted = ranges.map(([a, b]): [number, number] => [a, b]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: [number, number][] = [];
	for (const [a, b] of sorted) {
		const last = out.at(-1);
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** Hidden absolute ranges of a window `[start, start + lines - 1]` whose kept ranges are 1-based within it. */
export function hiddenRanges(start: number, lines: number, kept: readonly [number, number][]): [number, number][] {
	const sorted = [...kept].sort((x, y) => x[0] - y[0]);
	const hidden: [number, number][] = [];
	let next = 1;
	for (const [a, b] of sorted) {
		if (a > next) hidden.push([start + next - 1, start + Math.min(a - 1, lines) - 1]);
		next = Math.max(next, b + 1);
		if (next > lines) break;
	}
	if (next <= lines) hidden.push([start + next - 1, start + lines - 1]);
	return hidden.filter(([a, b]) => b >= a);
}

function parseKept(value: unknown): [number, number][] {
	if (!Array.isArray(value)) return [];
	const out: [number, number][] = [];
	for (const pair of value) {
		if (Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number")
			out.push([pair[0], pair[1]]);
	}
	return out;
}

function parseOriginal(value: unknown): SpotlightOriginalFacts | null {
	if (!isRecord(value)) return null;
	const lines = finite(value.lines);
	const start = finite(value.start) || 1;
	const kept = parseKept(value.kept);
	const hidden = hiddenRanges(start, lines, kept);
	return {
		url: typeof value.url === "string" ? value.url : null,
		path: typeof value.path === "string" ? value.path : null,
		start,
		lines,
		hidden,
		hiddenLines: hidden.reduce((sum, [a, b]) => sum + b - a + 1, 0),
		heat: typeof value.heat === "string" ? value.heat : null,
		kept,
	};
}

/** A count the trace may lack (written before pi recorded it): null then. */
function optionalCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A flag the trace may lack (written before pi recorded it): null then. */
function optionalFlag(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function parseSteps(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((step): step is string => typeof step === "string") : [];
}

/** The row a `spotlight:shape` entry's data describes, or null when it names no call. */
export function shapeFromEntry(
	sessionFile: string,
	data: Record<string, unknown>,
	timestamp: number,
): SpotlightShapeRow | null {
	if (typeof data.toolCallId !== "string" || typeof data.tool !== "string") return null;
	const usage: Record<string, unknown> = isRecord(data.spotlight) ? data.spotlight : {};
	return {
		sessionFile,
		toolCallId: data.toolCallId,
		timestamp,
		tool: data.tool,
		inChars: finite(data.inChars),
		outChars: finite(data.outChars),
		inTokens: finite(data.inTokens),
		outTokens: finite(data.outTokens),
		plainChars: optionalCount(data.plainChars),
		plainTokens: optionalCount(data.plainTokens),
		cappedTokens: optionalCount(data.cappedTokens),
		scoreFree: data.scoreFree === true,
		steps: parseSteps(data.steps),
		hasDetails: false,
		holdout: data.holdout === true,
		gated: data.gated === true,
		editLikely: optionalFlag(data.editLikely),
		original: null,
		artifacts: null,
		spotlight: {
			calls: finite(usage.calls),
			failures: finite(usage.failures),
			ms: finite(usage.ms),
			costUsd: finite(usage.costUsd),
		},
		shapeMs: finite(data.ms),
	};
}

/** The row a result message's `details.spotlight` describes, or null when it carries none. */
export function shapeFromDetails(
	sessionFile: string,
	toolCallId: string,
	details: unknown,
	text: string,
	timestamp: number,
): SpotlightShapeRow | null {
	if (!isRecord(details) || !isRecord(details.spotlight)) return null;
	const s = details.spotlight;
	if (typeof s.tool !== "string") return null;
	const original = parseOriginal(s.original);
	const holdout = s.holdout === true;
	const gated = s.gated === true;
	const artifacts = new Set(artifactIds(text));
	// A held-out or gated result's original artifact was never shown to the model: it cannot fetch from it.
	if (!holdout && !gated) for (const id of artifactIds(original?.url ?? "")) artifacts.add(id);
	return {
		sessionFile,
		toolCallId,
		timestamp,
		tool: s.tool,
		inChars: finite(s.inChars),
		outChars: finite(s.outChars),
		inTokens: finite(s.inTokens),
		outTokens: finite(s.outTokens),
		plainChars: optionalCount(s.plainChars),
		plainTokens: optionalCount(s.plainTokens),
		cappedTokens: optionalCount(s.cappedTokens),
		scoreFree: s.scoreFree === true,
		steps: parseSteps(s.steps),
		hasDetails: true,
		holdout,
		gated,
		editLikely: optionalFlag(s.editLikely),
		original,
		artifacts: [...artifacts].sort((a, b) => a - b),
		spotlight: null,
		shapeMs: null,
	};
}

/**
 * Directories a session's artifacts can live in: its own (`<session>/`), else, for a subagent transcript
 * (`<parent>/<name>.jsonl`), its parent's and further ancestors' up to the project folder.
 */
function artifactDirs(sessionFile: string): string[] {
	const dirs = [sessionFile.replace(/\.jsonl$/, "")];
	const sessionsDir = getSessionsDir();
	for (let dir = path.dirname(sessionFile); ; dir = path.dirname(dir)) {
		const rel = path.relative(sessionsDir, dir);
		// The project folder (`<sessions>/<folder>`) holds transcripts, not artifacts.
		if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).length < 2) break;
		dirs.push(dir);
	}
	return dirs;
}

/** The lines of artifact `url` (`artifact://N`, file `N.*`) of a session; null when it cannot be found or read. */
async function readArtifactLines(
	sessionFile: string,
	url: string,
	listings: Map<string, Promise<string[]>>,
): Promise<string[] | null> {
	const id = /^artifact:\/\/(\d+)$/.exec(url)?.[1];
	if (id === undefined) return null;
	for (const dir of artifactDirs(sessionFile)) {
		let listing = listings.get(dir);
		if (!listing) {
			listing = fs.readdir(dir).catch(() => []);
			listings.set(dir, listing);
		}
		const name = (await listing).find(entry => entry.startsWith(`${id}.`));
		if (!name) continue;
		try {
			return (await Bun.file(path.join(dir, name)).text()).split("\n");
		} catch {
			return null;
		}
	}
	return null;
}

/** Message time in ms: the message's own timestamp, else the entry's ISO time, else 0 (as the parser stores it). */
function entryTime(messageTimestamp: unknown, isoTimestamp: unknown): number {
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp) && messageTimestamp > 0) {
		return messageTimestamp;
	}
	const parsed = typeof isoTimestamp === "string" ? Date.parse(isoTimestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function joinedText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

/**
 * Reduces one transcript's entries to {@link SpotlightParseRows}, carrying {@link SpotlightParserState} across tail
 * parses. With `record` false it only advances the state (a prefix scan that rebuilds the state of a cursor without
 * one).
 *
 * Needed lines: once a shaped read's result lands (applied, held out or score-free: any read with
 * `details.spotlight.original`), later calls of the session, all from later requests, add to its needs: a `read` of the
 * same file with a line selection adds the selected lines; an `edit` of it adds the lines its `*** Find` blocks
 * locate in the original (read from the session's artifact directory in {@link finish}). Collecting stops at the
 * file's first edit (after recording its lines; any edit tool), a later whole-file read, or a later shaped read of
 * the file (after recording its selection), which starts collecting for itself.
 */
export class SpotlightCollector {
	readonly rows: SpotlightParseRows = emptySpotlightRows();
	readonly state: SpotlightParserState;
	readonly #sessionFile: string;
	readonly #folder: string;
	readonly #record: boolean;
	/** Rows of this parse by call id, so a shape entry and its result details merge before the upsert. */
	readonly #shapes = new Map<string, SpotlightShapeRow>();
	/** Need rows of this parse by call id (the changes this parse makes; the upsert merges them). */
	readonly #needs = new Map<string, SpotlightNeedRow>();
	/** Find blocks to locate in an original once its text is read ({@link finish}). */
	readonly #locates: { read: SpotlightOpenRead; blocks: EditFindBlock[] }[] = [];

	constructor(sessionFile: string, folder: string, state: SpotlightParserState, record = true) {
		this.#sessionFile = sessionFile;
		this.#folder = folder;
		this.state = { ...state, open: (state.open ?? []).map(read => ({ ...read })) };
		this.#record = record;
	}

	/**
	 * Locate the parse's edit Find blocks in their reads' originals (artifact files) and add the lines to the needs;
	 * an original that cannot be read adds none.
	 */
	async finish(): Promise<void> {
		const texts = new Map<string, Promise<string[] | null>>();
		const listings = new Map<string, Promise<string[]>>();
		for (const { read, blocks } of this.#locates) {
			const url = read.url ?? "";
			let text = texts.get(url);
			if (!text) {
				text = readArtifactLines(this.#sessionFile, url, listings);
				texts.set(url, text);
			}
			const original = await text;
			if (!original) continue;
			const row = this.#need(read);
			for (const block of blocks) {
				const spans = locateFind(original, block.lines);
				// Without `all` the edit needs exactly one match; more is a Find this text cannot place.
				const located = block.all ? spans : spans.length === 1 ? spans : [];
				for (const [a, b] of located) {
					if (a <= read.lines) row.edit.push([a, Math.min(b, read.lines)]);
				}
			}
			row.edit = mergeRanges(row.edit);
		}
		this.#locates.length = 0;
	}

	#need(read: SpotlightOpenRead): SpotlightNeedRow {
		let row = this.#needs.get(read.toolCallId);
		if (!row) {
			row = {
				sessionFile: this.#sessionFile,
				toolCallId: read.toolCallId,
				file: read.file,
				open: true,
				reread: [],
				edit: [],
			};
			this.#needs.set(read.toolCallId, row);
			this.rows.needs.push(row);
		}
		return row;
	}

	#close(read: SpotlightOpenRead): void {
		const open = this.state.open ?? [];
		this.state.open = open.filter(other => other !== read);
		if (this.#record) this.#need(read).open = false;
	}

	/** Start collecting for a shaped read whose result just landed; it stops an earlier one of the same file. */
	#openRead(row: SpotlightShapeRow): void {
		const original = row.original;
		if (row.tool !== "read" || !original?.path || original.lines <= 0) return;
		if ((this.state.open ?? []).some(read => read.toolCallId === row.toolCallId)) return;
		const file = resolveReadPath(original.path, this.state.cwd);
		for (const read of this.state.open ?? []) if (read.file === file) this.#close(read);
		const read: SpotlightOpenRead = {
			toolCallId: row.toolCallId,
			file,
			start: original.start,
			lines: original.lines,
			url: original.url,
		};
		this.state.open = [...(this.state.open ?? []), read];
		if (this.#record) this.#need(read);
	}

	/** What a later call needs of the open reads, and which ones it stops. */
	#noteCall(toolName: string, args: unknown): void {
		const open = this.state.open ?? [];
		if (open.length === 0 || !isRecord(args)) return;
		if (toolName === "read" && typeof args.path === "string") {
			const selection = parseReadSelection(args.path);
			const file = resolveReadPath(selection.path, this.state.cwd);
			for (const read of open) {
				if (read.file !== file) continue;
				const ranges = selectedLines(selection);
				if (ranges === null) {
					this.#close(read);
					continue;
				}
				if (!this.#record) continue;
				const end = read.start + read.lines - 1;
				const positions: [number, number][] = [];
				for (const [a, b] of ranges) {
					const from = Math.max(a, read.start);
					const to = Math.min(b, end);
					if (from <= to) positions.push([from - read.start + 1, to - read.start + 1]);
				}
				// The last N lines are known only when the original reaches the file's end: a whole-file read's does.
				if (selection.tail !== null && read.start === 1)
					positions.push([Math.max(1, read.lines - selection.tail + 1), read.lines]);
				const row = this.#need(read);
				row.reread = mergeRanges([...row.reread, ...positions]);
			}
			return;
		}
		const edited = editedPaths(toolName, args);
		if (!edited) return;
		const exact = new Set<string>();
		const globs: Bun.Glob[] = [];
		for (const file of edited) {
			const resolved = resolveReadPath(file, this.state.cwd);
			if (/[*?[{]/.test(file)) globs.push(new Bun.Glob(resolved));
			else exact.add(resolved);
		}
		const blocks = toolName === "edit" && typeof args.input === "string" ? editFindBlocks(args.input) : [];
		const fallback = typeof args.path === "string" ? args.path : null;
		for (const read of open) {
			if (!exact.has(read.file) && !globs.some(glob => glob.match(read.file))) continue;
			if (this.#record) {
				const own = blocks.filter(block => {
					const file = block.file ?? fallback;
					return file !== null && resolveReadPath(file, this.state.cwd) === read.file;
				});
				if (own.length > 0) this.#locates.push({ read, blocks: own });
			}
			this.#close(read);
		}
	}

	visit(entry: unknown): void {
		if (!isRecord(entry)) return;
		const state = this.state;
		switch (entry.type) {
			case "session":
				if (typeof entry.cwd === "string") state.cwd = entry.cwd;
				if (typeof entry.title === "string") state.title = entry.title;
				return;
			case "title":
			case "title_change":
				if (typeof entry.title !== "string") return;
				state.title = entry.title;
				if (state.experiment && this.#record)
					this.rows.titles.push({ sessionFile: this.#sessionFile, title: entry.title });
				return;
			case "custom":
				this.#custom(entry);
				return;
			case "message":
				if (isRecord(entry.message)) this.#message(entry, entry.message);
				return;
		}
	}

	#custom(entry: Record<string, unknown>): void {
		if (!isRecord(entry.data)) return;
		const timestamp = entryTime(undefined, entry.timestamp);
		if (experimentMarker(entry.customType, entry.data)) {
			// A later marker (the session moved files, or its settings changed) keeps the first one's start.
			if (this.state.experiment) return;
			this.state.experiment = true;
			if (!this.#record) return;
			this.rows.sessions.push({
				sessionFile: this.#sessionFile,
				folder: this.#folder,
				markedAt: timestamp,
				cwd: this.state.cwd,
				title: this.state.title,
			});
		} else if (entry.customType === "spotlight:shape" && this.state.experiment && this.#record) {
			const row = shapeFromEntry(this.#sessionFile, entry.data, timestamp);
			if (row) this.#addShape(row);
		}
	}

	#message(entry: Record<string, unknown>, message: Record<string, unknown>): void {
		const state = this.state;
		if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string") return;
			const details = message.details;
			// Traces count only from the session's Spotlight marker on.
			const traced = state.experiment && isRecord(details) && isRecord(details.spotlight);
			if (!this.#record) {
				// A prefix scan only rebuilds the open reads.
				if (traced) {
					const row = shapeFromDetails(this.#sessionFile, message.toolCallId, details, "", 0);
					if (row) this.#openRead(row);
				}
				return;
			}
			if (!state.experiment) return;
			const text = joinedText(message.content);
			const timestamp = entryTime(message.timestamp, entry.timestamp);
			if (traced) {
				const row = shapeFromDetails(this.#sessionFile, message.toolCallId, details, text, timestamp);
				if (row) {
					this.#addShape(row);
					this.#openRead(row);
				}
			}
			this.rows.callResults.push({
				sessionFile: this.#sessionFile,
				toolCallId: message.toolCallId,
				resultChars: text.length,
				artifacts: artifactIds(text),
			});
			return;
		}
		if (message.role !== "assistant" || !state.experiment || typeof entry.id !== "string") return;
		const timestamp = entryTime(message.timestamp, entry.timestamp);
		if (this.#record) this.rows.requests.push({ sessionFile: this.#sessionFile, entryId: entry.id, timestamp });
		if (!Array.isArray(message.content)) return;
		const blocks = message.content.filter(
			(block): block is Record<string, unknown> =>
				isRecord(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string" &&
				typeof block.name === "string",
		);
		for (const block of blocks) {
			const seq = state.seq++;
			const toolName = String(block.name).trim();
			this.#noteCall(toolName, block.arguments);
			if (!this.#record) continue;
			this.rows.calls.push({
				sessionFile: this.#sessionFile,
				toolCallId: String(block.id),
				entryId: entry.id,
				timestamp,
				seq,
				toolName,
				callsInTurn: blocks.length,
				target: callTarget(toolName, block.arguments),
				edits: editedPaths(toolName, block.arguments),
				argTokens: toolName === "read" || toolName === "bash" ? null : argumentTokens(block.arguments),
			});
		}
	}

	#addShape(row: SpotlightShapeRow): void {
		const seen = this.#shapes.get(row.toolCallId);
		if (!seen) {
			this.#shapes.set(row.toolCallId, row);
			this.rows.shapes.push(row);
			return;
		}
		if (row.hasDetails) {
			seen.hasDetails = true;
			seen.original = row.original;
			seen.artifacts = row.artifacts;
			seen.inChars = row.inChars;
			seen.outChars = row.outChars;
			seen.inTokens = row.inTokens;
			seen.outTokens = row.outTokens;
			seen.steps = row.steps;
		}
		seen.plainChars ??= row.plainChars;
		seen.plainTokens ??= row.plainTokens;
		seen.cappedTokens ??= row.cappedTokens;
		seen.scoreFree ||= row.scoreFree;
		seen.holdout ||= row.holdout;
		seen.gated ||= row.gated;
		seen.editLikely ??= row.editLikely;
		seen.spotlight ??= row.spotlight;
		seen.shapeMs ??= row.shapeMs;
	}
}
