/**
 * Edit tags for files a `bash` command printed with line numbers (`grep -n`,
 * `rg -n`, `cat -n`, `nl`).
 *
 * Agents locate code with `grep -n` and then edit it, but bash output carries
 * no `[path#tag]` header, so the edit that follows invents one or anchors on
 * lines no tagged view displayed. A numbered row counts here only when its
 * text equals the file's current line at that number: once the caller knows
 * the model receives the output whole, those lines are recorded as displayed
 * in the file's snapshot, exactly as a `search` hit records them, and the
 * result names the tag. Unnumbered output (`sed -n`, `head`) never counts: the
 * model would have to count lines to get a number.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
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

/** Tags for a finished command's numbered rows, not yet recorded. */
export interface NumberedFileTags {
	/** The notice naming each file's `[path#TAG]`. */
	notice: string;
	/** Record the verified rows as displayed; call only once the model receives the output whole. */
	commit(): void;
}

function parseRows(output: string): Row[] {
	const rows: Row[] = [];
	for (const raw of output.split("\n")) {
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

/**
 * The directories the command runs in (the start, then each `cd`) and the
 * absolute paths of its word arguments, resolved in the directory in effect.
 */
function commandWords(command: string, cwd: string): { dirs: string[]; words: string[] } {
	const dirs = [cwd];
	const words: string[] = [];
	let dir = cwd;
	for (const segment of tokenizeShellSegments(command)) {
		if (segment[0] === "cd" && segment.length === 2) {
			dir = path.resolve(dir, segment[1]);
			dirs.push(dir);
			continue;
		}
		for (const word of segment.slice(1)) {
			if (!word.startsWith("-")) words.push(path.resolve(dir, word));
		}
	}
	return { dirs: [...new Set(dirs)], words };
}

async function regularFiles(candidates: Iterable<string>): Promise<Set<string>> {
	const unique = [...new Set(candidates)];
	const stats = await Promise.all(unique.map(file => fs.stat(file).catch(() => null)));
	return new Set(
		unique.filter((_, index) => {
			const stat = stats[index];
			return stat?.isFile() && stat.size <= MAX_FILE_BYTES;
		}),
	);
}

async function readLines(file: string): Promise<{ text: string; lines: string[] } | undefined> {
	const raw = await fs.readFile(file, "utf8").catch(() => undefined);
	if (raw === undefined || raw.includes("\0")) return undefined;
	const text = (raw.startsWith("\uFEFF") ? raw.slice(1) : raw).replace(/\r\n?/g, "\n");
	return { text, lines: text.split("\n") };
}

/**
 * Verify a finished `bash` command's numbered rows against the files they
 * name, or `undefined` when the output shows no current line of any file.
 * Nothing is recorded until the returned `commit` runs.
 */
export async function planNumberedFileTags(
	session: ToolSession,
	command: string,
	cwd: string,
	output: string,
): Promise<NumberedFileTags | undefined> {
	if (!path.isAbsolute(cwd) || !MAYBE_NUMBERED.test(output)) return undefined;
	const rows = parseRows(output);
	if (rows.length === 0) return undefined;

	const { dirs, words } = commandWords(command, cwd);
	const prefixes = new Set<string>();
	for (const row of rows) {
		if (row.file === undefined || /\s/.test(row.file)) continue;
		if (prefixes.size === MAX_PREFIXES && !prefixes.has(row.file)) break;
		prefixes.add(row.file);
	}
	const [operands, existing] = await Promise.all([
		regularFiles(words),
		regularFiles([...prefixes].flatMap(prefix => dirs.map(dir => path.resolve(dir, prefix)))),
	]);
	// A prefix names the file only when exactly one of the command's
	// directories holds it; `cd sub; grep -n x a.ts` with an `a.ts` on both
	// sides cannot say which one printed.
	const named = new Map<string, string>();
	for (const prefix of prefixes) {
		const matches = new Set(dirs.map(dir => path.resolve(dir, prefix)).filter(file => existing.has(file)));
		if (matches.size === 1) named.set(prefix, [...matches][0]);
	}
	const namedFiles = new Set(named.values());
	if (namedFiles.size > MAX_TAGGED_FILES) return undefined;
	const files = [...new Set([...namedFiles, ...operands])].slice(0, MAX_TAGGED_FILES);

	const verified: Array<{ file: string; text: string; tag: string; lines: number[] }> = [];
	for (const file of files) {
		const content = await readLines(file);
		if (!content) continue;
		const seen = new Set<number>();
		for (const row of rows) {
			const applies = row.file === undefined ? operands.has(file) : named.get(row.file) === file;
			if (applies && row.line >= 1 && content.lines[row.line - 1] === row.text) seen.add(row.line);
		}
		if (seen.size > 0) {
			verified.push({ file, text: content.text, tag: hashlineFileHash(content.text), lines: [...seen] });
		}
	}
	if (verified.length === 0) return undefined;

	const headers = verified.map(({ file, tag }) => `[${formatPathRelativeToCwd(file, session.cwd)}#${tag}]`);
	return {
		notice: `Edit tags for the numbered lines above: ${headers.join(" ")}`,
		commit() {
			const store = getEditStore(session);
			for (const { file, text, tag, lines } of verified) {
				// A retained version with no seen set, or an empty one (a `write`
				// tag), already accepts every line: re-recording it without rows
				// makes it current without narrowing it.
				const retained = store.byHashText(file, tag) === text;
				const unrestricted = retained && !store.seenLines(file, tag)?.length;
				store.recordSnapshot(file, text, unrestricted ? undefined : lines);
			}
		},
	};
}
