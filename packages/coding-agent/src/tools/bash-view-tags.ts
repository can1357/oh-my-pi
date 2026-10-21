/**
 * Edit tags for files a `bash` command printed with line numbers (`grep -n`,
 * `rg -n`, `cat -n`, `nl -ba`).
 *
 * Agents locate code with `grep -n` and then edit it, but bash output carries
 * no `[path#tag]` header, so the edit that follows invents one or anchors on
 * lines no tagged view displayed. A numbered row counts here only when the
 * command has a shape whose rows can be traced to a file (see
 * {@link parseView}) and the row's text equals the file's current line at
 * that number: once the caller knows the model receives the output whole,
 * those lines are recorded as displayed in the file's snapshot, exactly as a
 * `search` hit records them, and the result names the tag. Unnumbered output
 * (`sed -n`, `head`) never counts: the model would have to count lines to get
 * a number.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import { getEditStore } from "../edit/store";
import type { ToolSession } from "../sdk";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { formatPathRelativeToCwd } from "./path-utils";
import { formatReadHashlineHeader } from "./read-format";
import { lexShellCommand } from "./shell-tokenize";

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

/** Short-option letters that make a numberer's numbers stop being file line numbers. */
const RENUMBERING: Record<string, RegExp> = {
	grep: /[bz]/, // byte offsets, NUL-separated records
	egrep: /[bz]/,
	fgrep: /[bz]/,
	rg: /[bz]/, // byte offsets, decompressed archives
	git: /O/, // `git grep` into a pager
	cat: /[bs]/, // non-blank numbering, squeezed blank lines
};
/** Long options with the same effect, or that relabel or re-root the printed paths. */
const RENUMBERING_LONG =
	/^--(?:byte-offset|null-data|search-zip|pre\b|label|full-name|open-files-in-pager|number-nonblank|squeeze-blank)/;
/** A `sed` script that only selects lines (`3,4p`, `$p`, `40q`). */
const SED_SELECT = /^(?:\d+|\$)(?:,(?:\d+|\$))?[pq]$/;
/** `NAME=value` before a command, judged on its shell spelling. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Unquoted characters that expand a word into other words or paths. */
const EXPANDING = /[$`*?[{~]/;

interface Word {
	value: string;
	/** The characters of the word the shell interprets (see {@link unquoted}). */
	bare: string;
}

/**
 * A word's shell spelling with quoted and escaped text dropped, except `$`
 * and backticks inside double quotes, which still expand.
 */
function unquoted(raw: string): string {
	let out = "";
	let quote: string | undefined;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\" && quote !== "'") {
			i++;
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else if (quote === '"' && (ch === "$" || ch === "`")) out += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else {
			out += ch;
		}
	}
	return out;
}

/**
 * A `..` after a symlink is resolved by the filesystem, not lexically as
 * `path.resolve` does, so paths that climb are left unresolved.
 */
const climbs = (spelling: string): boolean => spelling.split(/[/\\]/).includes("..");

/**
 * The words naming the files a numberer reads (its pattern dropped), or
 * `undefined` when the command does not print those files' line numbers.
 * Option values stay in: an extra word only costs the single-file
 * attribution, while a dropped file name could misplace it.
 */
function numbererFiles(name: string, args: Word[]): Word[] | undefined {
	if (name === "git") {
		if (args[0]?.value !== "grep") return undefined;
		args = args.slice(1);
	}
	const flags = args.filter(arg => arg.value.startsWith("-")).map(arg => arg.value);
	const positional = args.filter(arg => !arg.value.startsWith("-"));
	if (name === "nl") {
		// Only `-ba` numbers every line; the default skips blank ones.
		const options = flags.join(" ");
		if (options === "-b") return positional[0]?.value === "a" ? positional.slice(1) : undefined;
		return options === "-ba" || options === "--body-numbering=a" ? positional : undefined;
	}
	const renumbering = RENUMBERING[name];
	if (!renumbering) return undefined;
	const short = flags.filter(flag => !flag.startsWith("--")).map(flag => /^-([a-zA-Z]*)/.exec(flag)?.[1] ?? "");
	const numbered =
		short.some(letters => letters.includes("n")) || flags.includes("--line-number") || flags.includes("--number");
	if (
		!numbered ||
		short.some(letters => renumbering.test(letters)) ||
		flags.some(flag => RENUMBERING_LONG.test(flag))
	) {
		return undefined;
	}
	if (name === "cat") return positional;
	// The first positional word is the pattern unless `-e`/`-f` supplied it.
	const patternGiven =
		short.some(letters => /[ef]/.test(letters)) || flags.some(flag => /^--(?:regexp|file)\b/.test(flag));
	return patternGiven ? positional : positional.slice(1);
}

/** True when a pipeline stage reads only its input stream and keeps or drops whole rows. */
function keepsRows(name: string, args: Word[]): boolean {
	const values = args.map(arg => arg.value);
	switch (name) {
		case "head":
		case "tail":
			return /^(?:-n ?\+?\d+|-\d+)?$/.test(values.join(" "));
		case "grep":
		case "egrep":
		case "fgrep":
		case "rg":
			// One pattern, no files, and no flag that numbers, counts or cuts rows.
			return (
				values.filter(value => !value.startsWith("-")).length === 1 &&
				values.every(value => !value.startsWith("-") || /^-[viEFwxP]+$/.test(value))
			);
		case "sed": {
			const script = values.at(-1);
			return script !== undefined && SED_SELECT.test(script) && values.slice(0, -1).every(value => value === "-n");
		}
		default:
			return false;
	}
}

/** Where a command's numbered rows come from. */
interface ParsedView {
	/** The directory every view runs in. */
	dir: string;
	/** The one file every view reads, owner of the rows printed without a path. */
	sole?: string;
}

/**
 * Parse a command of the one shape whose rows can be traced to files:
 *
 *     [cd DIR (; | && | newline)]... VIEW [(; | && | newline) VIEW]...
 *     VIEW = NUMBERER [OPTION | FILE]... [| FILTER]...
 *
 * A NUMBERER prints each file's own line numbers (`grep -n`, `rg -n`,
 * `git grep -n`, `cat -n`, `nl -ba`); a FILTER reads the stream and only keeps
 * or drops rows (`head`, `tail`, `grep PATTERN`, `sed -n 3,4p`). A `cd`
 * counts only before any view, where it runs unconditionally: if it fails,
 * the files it would lead to do not exist. Any other command, keyword,
 * subshell, comment, input redirection, or a numberer after a pipe (which
 * numbers a stream, as `tail -n 1 a.ts | cat -n` does) gives `undefined`.
 */
function parseView(command: string, cwd: string): ParsedView | undefined {
	const tokens = lexShellCommand(command);
	const pipelines: Word[][][] = [[[]]];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const stages = pipelines[pipelines.length - 1];
		if (token.kind === "word") {
			const bare = unquoted(token.raw);
			if (bare.startsWith("#") || bare.includes("<")) return undefined;
			if (bare.includes(">")) {
				// An output redirection: `2>/dev/null`, or `2>` then `&1` or a target.
				if (!/^\d*>>?/.test(bare)) return undefined;
				if (/^\d*>>?$/.test(bare)) {
					const next = tokens[i + 1];
					if (next?.kind !== "separator" || (next.raw !== "&" && next.raw.trim() !== "")) return undefined;
					if (tokens[i + 2]?.kind !== "word") return undefined;
					i += 2;
				}
				continue;
			}
			if (token.value.length > 0) stages[stages.length - 1].push({ value: token.value, bare });
			continue;
		}
		const operator = token.raw.replace(/[ \t]/g, "");
		if (operator.length === 0) continue;
		if (/^\|\n*$/.test(operator)) stages.push([]);
		else if (/^(?:;|&&|\n)+$/.test(operator)) pipelines.push([[]]);
		else return undefined;
	}

	let dir = cwd;
	let views = 0;
	const soles = new Set<string | undefined>();
	for (const stages of pipelines) {
		const [first, ...filters] = stages.map(words => {
			const start = words.findIndex(word => !ASSIGNMENT.test(word.bare));
			return start < 0 ? [] : words.slice(start);
		});
		const [name, ...args] = first;
		if (name === undefined) {
			if (filters.length > 0 || stages[0].length > 0) return undefined;
			continue;
		}
		if (name.value === "cd") {
			const target = args[0];
			if (views > 0 || filters.length > 0 || args.length !== 1 || EXPANDING.test(target.bare)) return undefined;
			if (target.value.startsWith("-")) return undefined;
			dir = path.resolve(dir, target.value);
			continue;
		}
		const files = numbererFiles(name.value, args);
		if (!files) return undefined;
		for (const [stage, ...stageArgs] of filters) {
			if (stage === undefined || !keepsRows(stage.value, stageArgs)) return undefined;
		}
		views++;
		const [only] = files;
		soles.add(
			files.length === 1 && !EXPANDING.test(only.bare) && !climbs(only.value)
				? path.resolve(dir, only.value)
				: undefined,
		);
	}
	if (views === 0) return undefined;
	const [sole] = soles;
	return { dir, sole: soles.size === 1 ? sole : undefined };
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
	const raw = await Bun.file(file)
		.text()
		.catch(() => undefined);
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
	if (!path.isAbsolute(cwd) || !resolveFileDisplayMode(session).hashLines || !MAYBE_NUMBERED.test(output)) {
		return undefined;
	}
	const rows = parseRows(output);
	if (rows.length === 0) return undefined;

	const view = parseView(command, cwd);
	if (!view) return undefined;
	const prefixes = new Set<string>();
	for (const row of rows) {
		if (row.file === undefined || /\s/.test(row.file) || climbs(row.file)) continue;
		if (prefixes.size === MAX_PREFIXES && !prefixes.has(row.file)) break;
		prefixes.add(row.file);
	}
	const [operands, existing] = await Promise.all([
		regularFiles(view.sole ? [view.sole] : []),
		regularFiles([...prefixes].map(prefix => path.resolve(view.dir, prefix))),
	]);
	const named = new Map<string, string>();
	for (const prefix of prefixes) {
		const file = path.resolve(view.dir, prefix);
		if (existing.has(file)) named.set(prefix, file);
	}
	// Rows printed without a path belong to the one file every view reads;
	// `cat -n a.ts b.ts` numbers the joined stream.
	const [sole] = operands;
	const files = [...new Set([...named.values(), ...(sole ? [sole] : [])])].filter(
		// Notebooks edit as cell text, not the JSON these rows number.
		file => !file.toLowerCase().endsWith(".ipynb"),
	);
	if (files.length > MAX_TAGGED_FILES) return undefined;

	const verified: Array<{ file: string; text: string; tag: string; lines: number[] }> = [];
	for (const file of files) {
		const content = await readLines(file);
		if (!content) continue;
		const seen = new Set<number>();
		for (const row of rows) {
			const applies = row.file === undefined ? file === sole : named.get(row.file) === file;
			if (applies && row.line >= 1 && content.lines[row.line - 1] === row.text) seen.add(row.line);
		}
		if (seen.size > 0) {
			verified.push({ file, text: content.text, tag: hashlineFileHash(content.text), lines: [...seen] });
		}
	}
	if (verified.length === 0) return undefined;

	const headers = verified.map(({ file, tag }) =>
		formatReadHashlineHeader(formatPathRelativeToCwd(file, session.cwd), tag),
	);
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
