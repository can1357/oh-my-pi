/**
 * Credit source lines a bash command displayed with their line numbers
 * (`grep -n`, `rg -n`, `nl -ba`, `cat -n`) to the session's edit store, so the
 * hashline seen-line guard accepts edits anchored on them, and mint the file's
 * edit tag for the model.
 *
 * A row counts only when its text equals the numbered line of the file's
 * current content, checked against the text the model receives: a row a pipe
 * transformed or a cap cut never matches, so whatever is credited is a correct
 * view of that line regardless of which command printed it. The caller records
 * the matches only when nothing downstream cuts the result again
 * ({@link bashResultReachesModelWhole}). Unnumbered views (`sed -n`, `cat`,
 * `head`, `tail`) carry no row numbers and are never credited.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { getEditStore } from "../edit/store";
import { ASYNC_INLINE_RESULT_MAX_CHARS } from "../session/async-job-delivery";
import type { ToolSession } from ".";
import { resolveArtifactSpillThreshold } from "./output-meta";
import { formatPathRelativeToCwd, resolveShellDirectory, resolveToCwd } from "./path-utils";
import { decodeUtf8Text, formatReadHashlineHeader } from "./read-format";
import { extractFlatShellCommandSegments, tokenizeShellSegments } from "./shell-tokenize";

/** Distinct files credited per result. */
const MAX_CREDITED_FILES = 16;
/** The edit store retains no snapshot above this size, so such files cannot be credited. */
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
/** Distinct path-prefix spellings probed on disk per result; bounds stats on output that merely looks numbered. */
const MAX_PREFIX_PROBES = 64;
/** Path/number splits considered per output line (`a:1:b:2:c` splits at `:1:` and `:2:`). */
const MAX_SPLITS_PER_ROW = 4;
/** Command words probed as candidate files per result. */
const MAX_COMMAND_WORDS = 64;
/** Literal `cd` targets used as resolution bases besides the command cwd. */
const MAX_CD_BASES = 3;
/** Filesystem stats per result, across every base and spelling. */
const MAX_STAT_PROBES = 128;
/** Line ranges a footer line lists before summarizing the rest. */
const MAX_FOOTER_RANGES = 12;

/** Cheap gate: some line could be a numbered row (forms a, b, c). */
const NUMBERED_ROW_HINT = /^[ \t]*\d+\t|^\d+[:-]|[:-]\d+[:-]/m;
/** `nl -ba` / `cat -n`: right-aligned number, a tab, the line. */
const TAB_ROW = /^[ \t]*(\d+)\t(.*)$/;
/** Single-file `grep -n` / `rg -n` match (`N:`) or context (`N-`) row. */
const BARE_ROW = /^(\d+)[:-](.*)$/;
/** `<sep><N><sep>` at a fixed offset, the same separator on both sides. */
const PREFIX_SPLIT = /([:-])(\d+)\1/y;

interface NumberedRow {
	line: number;
	text: string;
}

interface PrefixedRow extends NumberedRow {
	pathText: string;
}

interface ParsedRows {
	bare: NumberedRow[];
	prefixed: PrefixedRow[];
}

function parseRows(outputText: string): ParsedRows {
	const bare: NumberedRow[] = [];
	const prefixed: PrefixedRow[] = [];
	for (const row of outputText.split("\n")) {
		const tab = TAB_ROW.exec(row);
		if (tab) bare.push({ line: Number(tab[1]), text: tab[2] });
		const plain = BARE_ROW.exec(row);
		if (plain) bare.push({ line: Number(plain[1]), text: plain[2] });
		let splits = 0;
		for (let i = 1; i < row.length && splits < MAX_SPLITS_PER_ROW; i++) {
			const ch = row[i];
			if (ch !== ":" && ch !== "-") continue;
			PREFIX_SPLIT.lastIndex = i;
			const split = PREFIX_SPLIT.exec(row);
			if (!split) continue;
			splits++;
			const pathText = row.slice(0, i);
			if (pathText.trim().length === 0) continue;
			prefixed.push({ pathText, line: Number(split[2]), text: row.slice(i + split[0].length) });
		}
	}
	return { bare, prefixed };
}

interface CommandContext {
	/** Directories relative paths resolve against: the command cwd, then each literal `cd` target. */
	bases: string[];
	/** Words that may name a file, in command order. */
	words: string[];
}

function commandContext(command: string, cwd: string): CommandContext {
	const bases = [cwd];
	const words: string[] = [];
	for (const segment of extractFlatShellCommandSegments(command)) {
		for (const segmentWords of tokenizeShellSegments(segment.text)) {
			const [head, ...args] = segmentWords;
			if (head === "cd") {
				if (args.length === 1) {
					const base = resolvePath(args[0], cwd, resolveShellDirectory);
					if (base !== undefined && !bases.includes(base) && bases.length <= MAX_CD_BASES) bases.push(base);
				}
				continue;
			}
			for (const arg of args) {
				if (!arg.startsWith("-") && words.length < MAX_COMMAND_WORDS) words.push(arg);
			}
		}
	}
	return { bases, words };
}

/** Resolve a shell word to an absolute path; undefined for internal URLs and other unresolvable words. */
function resolvePath(
	word: string,
	base: string,
	resolve: (filePath: string, cwd: string) => string,
): string | undefined {
	try {
		return resolve(word, base);
	} catch {
		return undefined;
	}
}

/**
 * Resolves paths to regular-file sizes, statting each absolute path at most
 * once and at most {@link MAX_STAT_PROBES} paths in total; paths past the
 * budget count as missing.
 */
class FileProbe {
	#sizes = new Map<string, Promise<number | undefined>>();

	size(absolutePath: string): Promise<number | undefined> {
		let size = this.#sizes.get(absolutePath);
		if (!size) {
			if (this.#sizes.size >= MAX_STAT_PROBES) return Promise.resolve(undefined);
			size = fs.stat(absolutePath).then(
				st => (st.isFile() ? st.size : undefined),
				() => undefined,
			);
			this.#sizes.set(absolutePath, size);
		}
		return size;
	}

	/** Every existing regular file `word` names under `bases`, in base order. */
	async files(word: string, bases: readonly string[]): Promise<string[]> {
		const resolved = new Set<string>();
		for (const base of bases) {
			const absolutePath = resolvePath(word, base, resolveToCwd);
			if (absolutePath !== undefined) resolved.add(absolutePath);
		}
		const paths = [...resolved];
		const sizes = await Promise.all(paths.map(absolutePath => this.size(absolutePath)));
		return paths.filter((_, index) => sizes[index] !== undefined);
	}
}

/** Rows claimed for one file: line number → every row text shown for it. */
type ClaimedRows = Map<number, Set<string>>;

function claim(claims: Map<string, ClaimedRows>, absolutePath: string, row: NumberedRow): void {
	let rows = claims.get(absolutePath);
	if (!rows) {
		if (claims.size >= MAX_CREDITED_FILES) return;
		rows = new Map();
		claims.set(absolutePath, rows);
	}
	let texts = rows.get(row.line);
	if (!texts) {
		texts = new Set();
		rows.set(row.line, texts);
	}
	texts.add(row.text);
}

/** Read a file the way the edit store snapshots it: BOM-stripped, LF-normalized UTF-8; undefined when unusable. */
async function readSnapshotText(absolutePath: string, probe: FileProbe): Promise<string | undefined> {
	const size = await probe.size(absolutePath);
	if (size === undefined || size > MAX_SNAPSHOT_FILE_BYTES) return undefined;
	try {
		const decoded = decodeUtf8Text(await Bun.file(absolutePath).bytes());
		return decoded === null ? undefined : normalizeToLF(stripBom(decoded).text);
	} catch (err) {
		logger.debug("bash seen-lines: unreadable file", { path: absolutePath, err: String(err) });
		return undefined;
	}
}

/** Lines of `text` whose content equals a claimed row, ascending. */
function verifiedLines(text: string, rows: ClaimedRows): number[] {
	const lines = text.split("\n");
	const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
	const verified: number[] = [];
	for (const [line, texts] of rows) {
		if (line < 1 || line > lineCount) continue;
		const content = lines[line - 1];
		const bare = content.endsWith("\r") ? content.slice(0, -1) : content;
		if (texts.has(bare)) verified.push(line);
	}
	return verified.sort((a, b) => a - b);
}

/** `10-12, 35` for `[10, 11, 12, 35]` (ascending, distinct); past {@link MAX_FOOTER_RANGES} ranges the rest is counted. */
function formatLineRanges(lines: readonly number[]): string {
	const parts: string[] = [];
	let start = lines[0];
	let end = start;
	for (const line of lines.slice(1)) {
		if (line === end + 1) {
			end = line;
			continue;
		}
		parts.push(start === end ? `${start}` : `${start}-${end}`);
		start = line;
		end = line;
	}
	parts.push(start === end ? `${start}` : `${start}-${end}`);
	if (parts.length <= MAX_FOOTER_RANGES) return parts.join(", ");
	return `${parts.slice(0, MAX_FOOTER_RANGES).join(", ")} (+${parts.length - MAX_FOOTER_RANGES} more ranges)`;
}

/** A file whose numbered rows in a bash result match its current content. */
export interface BashSeenFile {
	absolutePath: string;
	/** BOM-stripped, LF-normalized content the rows matched; recorded as the snapshot. */
	text: string;
	/** Verified 1-based lines, ascending; never empty. */
	lines: number[];
	/** Edit tag `text` hashes to, the one the store records it under. */
	tag: string;
}

/**
 * Files whose lines `outputText` shows with their numbers, each with the lines
 * whose row text equals the file's current line. Records nothing.
 *
 * Path-prefixed rows (`path:N:text`, `path-N-text`) resolve against `cwd` and
 * the first literal `cd` targets in `command`; bare rows (`N:text`, `N-text`,
 * `  N\ttext`) count only when the command's words name exactly one file.
 */
export async function findBashSeenLines(command: string, cwd: string, outputText: string): Promise<BashSeenFile[]> {
	// A virtual cwd (an internal URL) names no host directory to resolve against.
	if (!path.isAbsolute(cwd) || !NUMBERED_ROW_HINT.test(outputText)) return [];
	const rows = parseRows(outputText);
	if (rows.bare.length === 0 && rows.prefixed.length === 0) return [];

	const { bases, words } = commandContext(command, cwd);
	const probe = new FileProbe();
	const claims = new Map<string, ClaimedRows>();

	if (rows.prefixed.length > 0) {
		const pathTexts = [...new Set(rows.prefixed.map(row => row.pathText))].slice(0, MAX_PREFIX_PROBES);
		const resolved = new Map(
			await Promise.all(pathTexts.map(async pathText => [pathText, await probe.files(pathText, bases)] as const)),
		);
		for (const row of rows.prefixed) {
			for (const absolutePath of resolved.get(row.pathText) ?? []) claim(claims, absolutePath, row);
		}
	}

	if (rows.bare.length > 0) {
		const named = new Set((await Promise.all(words.map(word => probe.files(word, bases)))).flat());
		if (named.size === 1) {
			const [absolutePath] = named;
			for (const row of rows.bare) claim(claims, absolutePath, row);
		}
	}

	if (claims.size === 0) return [];
	const entries = [...claims];
	const texts = await Promise.all(entries.map(([absolutePath]) => readSnapshotText(absolutePath, probe)));
	const files: BashSeenFile[] = [];
	entries.forEach(([absolutePath, claimed], index) => {
		const text = texts[index];
		if (text === undefined) return;
		const lines = verifiedLines(text, claimed);
		if (lines.length > 0) files.push({ absolutePath, text, lines, tag: hashlineFileHash(text) });
	});
	return files;
}

/** One line per file: the `read`-style edit tag header and the credited lines. */
export function formatBashSeenLinesFooter(files: readonly BashSeenFile[], sessionCwd: string): string[] {
	return files.map(file => {
		const header = formatReadHashlineHeader(formatPathRelativeToCwd(file.absolutePath, sessionCwd), file.tag);
		return `${header} ${file.lines.length === 1 ? "line" : "lines"} ${formatLineRanges(file.lines)}`;
	});
}

/**
 * Whether a bash result reaches the model uncut. `text` is its text content;
 * `outputNotice` is the notice a backgrounded job's delivered text appends to
 * it (`formatOutputNotice` of the result's meta). Two later cuts apply:
 * - the tool wrapper middle-elides `text` over the spill threshold (bytes,
 *   measured before notices are appended);
 * - an async follow-up longer than {@link ASYNC_INLINE_RESULT_MAX_CHARS}
 *   (text plus notice) is replaced by a preview.
 * Both are checked for every bash result: a foreground call can be
 * backgrounded while its result is still being built.
 */
export function bashResultReachesModelWhole(
	text: string,
	outputNotice: string,
	settings: Settings | undefined,
): boolean {
	return (
		text.length + outputNotice.length <= ASYNC_INLINE_RESULT_MAX_CHARS &&
		Buffer.byteLength(text, "utf-8") <= resolveArtifactSpillThreshold(settings)
	);
}

/** Record each file's verified lines as displayed under its tag; returns the files recorded. */
export function recordBashSeenLines(session: ToolSession, files: readonly BashSeenFile[]): BashSeenFile[] {
	const store = getEditStore(session);
	return files.filter(file => {
		try {
			// `lines` is never empty: an empty seen set marks authored content and lifts the guard for the version.
			store.recordSnapshot(file.absolutePath, file.text, file.lines);
			return true;
		} catch (err) {
			logger.debug("bash seen-lines: snapshot not recorded", { path: file.absolutePath, err: String(err) });
			return false;
		}
	});
}
