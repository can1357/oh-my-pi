/**
 * Edit tags for files a `bash` command printed with line numbers (`grep -n`,
 * `rg -n`, `cat -n`, `nl`).
 *
 * Agents locate code with `grep -n` and then edit it, but bash output carries
 * no `[path#tag]` header, so the edit that follows invents one or anchors on
 * lines no tagged view displayed. A numbered row counts here only when its
 * text equals the file's current line at that number: those lines are
 * recorded as displayed in the file's current snapshot, exactly as a `search`
 * hit records them, and the result names the tag. Unnumbered output (`sed -n`,
 * `head`) never counts: the model would have to count lines to get a number.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getEditStore } from "../edit/store";
import type { ToolSession } from "../sdk";
import { formatPathRelativeToCwd } from "./path-utils";
import { tokenizeShellSegments } from "./shell-tokenize";

/**
 * Files one output may tag. Views an edit follows name one or two files; a
 * listing across more is a survey, so it gets no tags and costs no reads.
 */
const MAX_TAGGED_FILES = 4;
/** Distinct `path:` prefixes looked up; the rest of a long listing is not a view. */
const MAX_PREFIXES = 64;
/** Matches the edit store's snapshot cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Output rows inspected; numbered views longer than this are cut by the inline cap anyway. */
const MAX_ROWS = 4000;

/** Cheap pre-check: some row starts like `N:`/`N-`, `name:N:`/`name-N-`, or `   N<TAB>`. */
const MAYBE_NUMBERED = /^(?:\s*\d+\t|\d+[:-]|[^\n]*?[:-]\d+[:-])/m;
const CAT_N_ROW = /^\s*(\d+)\t(.*)$/;
const BARE_ROW = /^(\d+)[:-](.*)$/;
const NAMED_ROW = /[:-](\d+)[:-]/g;

interface Row {
	/** File prefix as printed (grep/rg with several files), or undefined for single-file views. */
	file?: string;
	line: number;
	text: string;
}

function parseRows(output: string): Row[] {
	const rows: Row[] = [];
	const lines = output.split("\n", MAX_ROWS);
	for (const raw of lines) {
		const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const catN = CAT_N_ROW.exec(row);
		if (catN) {
			rows.push({ line: Number(catN[1]), text: catN[2] });
			continue;
		}
		const bare = BARE_ROW.exec(row);
		if (bare) rows.push({ line: Number(bare[1]), text: bare[2] });
		// `path:N:text` / `path-N-text`: every `:N:` split is a candidate; the
		// content check below keeps only the reading that matches a real file.
		for (const match of row.matchAll(NAMED_ROW)) {
			if (match.index === 0) continue;
			rows.push({
				file: row.slice(0, match.index),
				line: Number(match[1]),
				text: row.slice(match.index + match[0].length),
			});
		}
	}
	return rows;
}

/** Absolute paths of the command's word arguments that name regular files. */
async function commandFiles(command: string, cwd: string): Promise<string[]> {
	const words: string[] = [];
	let dir = cwd;
	for (const segment of tokenizeShellSegments(command)) {
		if (segment[0] === "cd" && segment.length === 2) {
			dir = path.resolve(dir, segment[1]);
			continue;
		}
		for (const word of segment.slice(1)) {
			if (!word.startsWith("-")) words.push(path.resolve(dir, word));
		}
	}
	return regularFiles(words);
}

async function regularFiles(candidates: Iterable<string>): Promise<string[]> {
	const unique = [...new Set(candidates)];
	const stats = await Promise.all(unique.map(file => fs.stat(file).catch(() => null)));
	return unique.filter((_, index) => {
		const stat = stats[index];
		return stat?.isFile() && stat.size <= MAX_FILE_BYTES;
	});
}

async function readLines(file: string): Promise<{ text: string; lines: string[] } | undefined> {
	const raw = await fs.readFile(file, "utf8").catch(() => undefined);
	if (raw === undefined || raw.includes("\0")) return undefined;
	const text = (raw.startsWith("\uFEFF") ? raw.slice(1) : raw).replace(/\r\n?/g, "\n");
	return { text, lines: text.split("\n") };
}

/**
 * Record the verified numbered rows of a finished `bash` command as displayed
 * lines and return the footer naming each file's tag, or `undefined` when the
 * output shows no current line of any file.
 */
export async function tagNumberedFileViews(
	session: ToolSession,
	command: string,
	cwd: string,
	output: string,
): Promise<string | undefined> {
	if (!path.isAbsolute(cwd) || !MAYBE_NUMBERED.test(output)) return undefined;
	const rows = parseRows(output);
	if (rows.length === 0) return undefined;

	const named = new Map<string, string>();
	for (const row of rows) {
		if (row.file === undefined || named.has(row.file) || /\s/.test(row.file)) continue;
		if (named.size === MAX_PREFIXES) break;
		named.set(row.file, path.resolve(cwd, row.file));
	}
	const [operands, namedFiles] = await Promise.all([commandFiles(command, cwd), regularFiles(named.values())]);
	if (namedFiles.length > MAX_TAGGED_FILES) return undefined;
	const files = [...new Set([...namedFiles, ...operands])].slice(0, MAX_TAGGED_FILES);
	if (files.length === 0) return undefined;
	const namedSet = new Set(namedFiles);
	const operandSet = new Set(operands);

	const store = getEditStore(session);
	const headers: string[] = [];
	for (const file of files) {
		const content = await readLines(file);
		if (!content) continue;
		const seen = new Set<number>();
		for (const row of rows) {
			const applies =
				row.file === undefined ? operandSet.has(file) : namedSet.has(file) && named.get(row.file) === file;
			if (applies && row.line >= 1 && content.lines[row.line - 1] === row.text) seen.add(row.line);
		}
		if (seen.size === 0) continue;
		const lines = [...seen];
		let tag = store.headHash(file);
		if (tag !== null && store.headText(file) === content.text) {
			// No seen set, or an empty one (a `write` tag), already accepts every
			// line; merging rows would narrow it.
			if (store.seenLines(file, tag)?.length) store.recordSeenLines(file, tag, lines);
		} else {
			tag = store.recordSnapshot(file, content.text, lines);
		}
		headers.push(`[${formatPathRelativeToCwd(file, session.cwd)}#${tag}]`);
	}
	if (headers.length === 0) return undefined;
	return `Edit tags for the numbered lines above: ${headers.join(" ")}`;
}
