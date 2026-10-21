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
import * as os from "node:os";
import * as path from "node:path";
import { hashlineFileHash } from "@oh-my-pi/pi-natives";
import { normalizeToLF, stripBom } from "../edit/normalize";
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
/** Matches one glob operand may expand to; a wider one is a survey, not a view. */
const MAX_GLOB_MATCHES = 256;
/** Matches the edit store's snapshot cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Cheap pre-check: some row starts like `N:`/`N-`, `name:N:`/`name-N-`, or `   N<TAB>`. */
const MAYBE_NUMBERED = /^(?:\s*\d+\t|\d+[:-]|[^\n]*?[:-]\d+[:-])/m;
const CAT_N_ROW = /^\s*(\d+)\t(.*)$/;
const BARE_ROW = /^(\d+)[:-](.*)$/;
const NAMED_ROW = /[:-](\d+)[:-]/g;

interface Row {
	/** The output line the row was read from; one line may give several readings. */
	index: number;
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
	for (const [index, raw] of output.split("\n").entries()) {
		const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const catN = CAT_N_ROW.exec(row);
		if (catN) {
			rows.push({ index, line: Number(catN[1]), text: catN[2] });
			continue;
		}
		const bare = BARE_ROW.exec(row);
		if (bare) rows.push({ index, line: Number(bare[1]), text: bare[2] });
		// `path:N:text` / `path-N-text`: every `:N:` split is a candidate; the
		// content check below keeps a line only when exactly one reading
		// matches a file the command read.
		for (const match of row.matchAll(NAMED_ROW)) {
			if (match.index === 0) continue;
			rows.push({
				index,
				file: row.slice(0, match.index),
				line: Number(match[1]),
				text: row.slice(match.index + match[0].length),
			});
		}
	}
	return rows;
}

/**
 * The options a numberer may take: every other option, and every option
 * abbreviation, gives no tags, so a flag that renumbers, relabels, prints
 * names or counts instead of rows, or adds synthetic rows (`-b`, `--label`,
 * `-l`, `--group-separator`) never slips through.
 */
interface OptionSpec {
	/** Short options without a value. */
	flags: string;
	/** Short options that take a value: the rest of the cluster, or the next word. */
	valued: string;
	/** Short options whose value is the pattern. */
	patternFlags: string;
	/** `-5` sets the context. */
	digits: boolean;
	long: ReadonlySet<string>;
	longValued: ReadonlySet<string>;
	/** Long options whose value may only follow `=`. */
	longOptional: ReadonlySet<string>;
	/** The long options that number lines. */
	numberLong: string;
	/** The short option that prints rows without their file names. */
	hideNames?: string;
	/** Whether the first operand is the pattern unless an option gave it. */
	pattern: boolean;
	/**
	 * Whether options may follow operands. GNU tools under `POSIXLY_CORRECT`,
	 * and BSD `cat`, read `cat a.ts -n`'s `-n` as a file: the numbering and
	 * pattern options must then come first, the others only filter real rows.
	 */
	permutes: boolean;
}

const GREP: OptionSpec = {
	flags: "nivwxyEFGPrRHhosaIU",
	valued: "ABCmef",
	patternFlags: "ef",
	digits: true,
	long: new Set([
		"line-number",
		"ignore-case",
		"no-ignore-case",
		"word-regexp",
		"line-regexp",
		"invert-match",
		"extended-regexp",
		"fixed-strings",
		"basic-regexp",
		"perl-regexp",
		"recursive",
		"dereference-recursive",
		"with-filename",
		"no-filename",
		"only-matching",
		"silent",
		"no-messages",
		"text",
	]),
	longValued: new Set([
		"max-count",
		"after-context",
		"before-context",
		"context",
		"include",
		"exclude",
		"exclude-dir",
		"binary-files",
		"regexp",
		"file",
	]),
	longOptional: new Set(["color", "colour"]),
	numberLong: "line-number",
	hideNames: "h",
	pattern: true,
	permutes: false,
};

const NUMBERERS: Record<string, OptionSpec> = {
	grep: GREP,
	egrep: GREP,
	fgrep: GREP,
	rg: {
		flags: "niSswxvFPHIouU.",
		valued: "ABCmefgtTjM",
		patternFlags: "ef",
		digits: false,
		long: new Set([
			"line-number",
			"ignore-case",
			"smart-case",
			"case-sensitive",
			"word-regexp",
			"line-regexp",
			"invert-match",
			"fixed-strings",
			"hidden",
			"no-ignore",
			"no-ignore-vcs",
			"follow",
			"no-heading",
			"with-filename",
			"no-filename",
			"only-matching",
			"multiline",
			"pcre2",
			"text",
			"unrestricted",
		]),
		longValued: new Set([
			"max-count",
			"after-context",
			"before-context",
			"context",
			"glob",
			"iglob",
			"type",
			"type-not",
			"regexp",
			"file",
			"color",
			"max-depth",
			"max-filesize",
			"max-columns",
			"threads",
		]),
		longOptional: new Set(),
		numberLong: "line-number",
		hideNames: "I",
		pattern: true,
		permutes: true,
	},
	// `git grep`, after its `grep` word.
	git: {
		flags: "niwvEFGPhHoIaWr",
		valued: "ABCmef",
		patternFlags: "ef",
		digits: true,
		long: new Set([
			"line-number",
			"ignore-case",
			"word-regexp",
			"invert-match",
			"extended-regexp",
			"fixed-strings",
			"basic-regexp",
			"perl-regexp",
			"untracked",
			"cached",
			"no-index",
			"only-matching",
			"text",
			"function-context",
			"recursive",
		]),
		longValued: new Set(["max-count", "after-context", "before-context", "context", "max-depth", "threads"]),
		longOptional: new Set(["color"]),
		numberLong: "line-number",
		hideNames: "h",
		pattern: true,
		permutes: false,
	},
	cat: {
		flags: "nu",
		valued: "",
		patternFlags: "",
		digits: false,
		long: new Set(["number"]),
		longValued: new Set(),
		longOptional: new Set(),
		numberLong: "number",
		pattern: false,
		permutes: false,
	},
};

/** A `sed` script that only selects lines (`3,4p`, `$p`, `40q`). */
const SED_SELECT = /^(?:\d+|\$)(?:,(?:\d+|\$))?[pq]$/;
/**
 * `NAME=value` before a command, judged on its raw spelling (`F''OO=x` is a
 * command name): only locale variables, which cannot reconfigure a numberer
 * (`RIPGREP_CONFIG_PATH`, `POSIXLY_CORRECT`).
 */
const ASSIGNMENT = /^(?:LC_[A-Z]+|LANG|LANGUAGE)=/;
/** Characters that expand a word into other words or paths. */
const EXPANDING = /[$`*?[{~]/;
/** Unquoted characters that make a word several words, or another one. */
const GLOB = /[*?[{]/;
/** An `nl` logical-page delimiter line, which restarts its numbering. */
const NL_DELIMITER = /^(?:\\:){1,3}$/;

interface Word {
	value: string;
	raw: string;
	/** The characters of the word the shell interprets (see {@link unquoted}). */
	bare: string;
	/** The unquoted characters of the word, where globs and a leading `~` expand. */
	active: string;
}

/** True when the shell may turn the word into other words: a glob, braces, or a leading `~`. */
const expands = (word: Word): boolean => GLOB.test(word.active) || word.active.startsWith("~");

/**
 * A word's shell spelling with quoted and escaped text dropped, except, when
 * `keepQuotedExpansions`, `$` and backticks inside double quotes, which still
 * expand (into one word).
 */
function unquoted(raw: string, keepQuotedExpansions: boolean): string {
	let out = "";
	let quote: string | undefined;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\" && quote !== "'") {
			i++;
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else if (keepQuotedExpansions && quote === '"' && (ch === "$" || ch === "`")) out += ch;
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

/** The files a numberer reads, and whether it was told to print rows without their file names. */
interface Numbered {
	files: Word[];
	hidesNames: boolean;
}

/**
 * The words naming the files a numberer reads (its pattern and option values
 * dropped), or `undefined` when the command does not print those files' line
 * numbers or takes an option outside its {@link OptionSpec}.
 */
function numbererFiles(name: string, args: Word[]): Numbered | undefined {
	if (name === "git") {
		if (args[0]?.value !== "grep") return undefined;
		args = args.slice(1);
	}
	if (name === "nl") {
		// Only `-ba` numbers every line; the default skips blank ones.
		const firstOperand = args.findIndex(arg => !arg.value.startsWith("-") && arg.value !== "a");
		if (firstOperand >= 0 && args.slice(firstOperand).some(arg => arg.value.startsWith("-"))) return undefined;
		const flags = args.filter(arg => arg.value.startsWith("-")).map(arg => arg.value);
		const positional = args.filter(arg => !arg.value.startsWith("-"));
		const options = flags.join(" ");
		if (options === "-b") {
			return positional[0]?.value === "a" ? { files: positional.slice(1), hidesNames: false } : undefined;
		}
		return options === "-ba" || options === "--body-numbering=a"
			? { files: positional, hidesNames: false }
			: undefined;
	}
	const spec = NUMBERERS[name];
	if (!spec) return undefined;
	let numbered = false;
	let hidesNames = false;
	let patternGiven = false;
	let optionsEnded = false;
	const operands: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i].value;
		if (optionsEnded || !word.startsWith("-")) {
			operands.push(args[i]);
			continue;
		}
		// `git grep PATTERN -- PATH` separates pathspecs; elsewhere a `--` after a file is a file.
		if (word === "--" && (operands.length === 0 || name === "git")) {
			optionsEnded = true;
			continue;
		}
		// Under `POSIXLY_CORRECT` an option after a file is a file.
		const early = operands.length === 0 || spec.permutes;
		// `--include=*.ts` expands only to words that start `--include=`, if any.
		if (expands(args[i]) && !/^--[a-z-]+=/.test(args[i].active)) return undefined;
		if (word === "-") return undefined; // standard input
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const option = eq < 0 ? word.slice(2) : word.slice(2, eq);
			if (spec.longValued.has(option)) {
				if (eq < 0 && args[++i] && expands(args[i])) return undefined;
				if (option === "regexp" || option === "file") {
					if (!early) return undefined;
					patternGiven = true;
				}
			} else if (!spec.longOptional.has(option) && (eq >= 0 || !spec.long.has(option))) {
				return undefined;
			}
			hidesNames ||= option === "no-filename";
			if (option === spec.numberLong) {
				if (!early) return undefined;
				numbered = true;
			}
			continue;
		}
		for (let j = 1; j < word.length; j++) {
			const letter = word[j];
			if (spec.digits && /\d/.test(letter)) continue;
			if (spec.valued.includes(letter)) {
				if (j === word.length - 1 && args[++i] && expands(args[i])) return undefined;
				if (spec.patternFlags.includes(letter)) {
					if (!early) return undefined;
					patternGiven = true;
				}
				break;
			}
			if (!spec.flags.includes(letter)) return undefined;
			hidesNames ||= letter === spec.hideNames;
			if (letter === "n") {
				if (!early) return undefined;
				numbered = true;
			}
		}
	}
	if (!numbered) return undefined;
	const files = spec.pattern && !patternGiven ? operands.slice(1) : operands;
	// A glob or braces in the pattern can make it a pattern and files (`s*`).
	// A file glob is expanded as the shell does (see `planNumberedFileTags`):
	// only one whose every glob character is unquoted, without bash's
	// non-recursive `**`. Only a leading `~` (one path) is resolved.
	if (files.length < operands.length && expands(operands[0])) return undefined;
	for (const file of files) {
		if (/^~[^/]/.test(file.active) || file.value.includes("**")) return undefined;
		if (file.value.match(/[*?[{]/g)?.length !== file.active.match(/[*?[{]/g)?.length) return undefined;
	}
	return { files, hidesNames };
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
	/** The one file every view reads, owner of the rows printed without a path. */
	sole?: string;
	/** Files and directories the views read: a `path:N:` row names a file at or under one. */
	roots: string[];
	/** File globs the views read, expanded into {@link roots} before rows are matched. */
	globs: string[];
	/** Some view is `nl`, whose numbering restarts at a logical-page delimiter. */
	nl: boolean;
	/** Some view is `git grep`, which prints paths from the top of the repository under `grep.fullName`. */
	git: boolean;
	/**
	 * Some view prints rows without file names (`grep -h`): its row text then
	 * reads as `path:N:` rows of files the view may never have read.
	 */
	hidesNames: boolean;
}

/**
 * Parse a command of the one shape whose rows can be traced to files:
 *
 *     VIEW [(; | newline) VIEW]...
 *     VIEW = [LC_*=… | LANG=…]... NUMBERER [OPTION]... [FILE]... [| FILTER]...
 *
 * A NUMBERER prints each file's own line numbers (`grep -n`, `rg -n`,
 * `git grep -n`, `cat -n`, `nl -ba`) and takes only the options its
 * {@link OptionSpec} lists; a FILTER reads the stream and only keeps or drops
 * rows (`head`, `tail`, `grep PATTERN`, `sed -n 3,4p`). Every view runs, in
 * `cwd`: `bash` already turns a leading `cd DIR &&` into the call's checked
 * working directory, and no `cd` inside the command is modeled (a function,
 * `CDPATH` or a failure can send it elsewhere). `&&`, `||`, any other
 * command, keyword, subshell, comment, input redirection, unquoted `$` or
 * backtick (which can split into words), glob outside a file operand (see
 * {@link numbererFiles}), or a numberer after a pipe (which numbers a stream,
 * as `tail -n 1 a.ts | cat -n` does) gives `undefined`.
 */
function parseView(command: string, cwd: string): ParsedView | undefined {
	const tokens = lexShellCommand(command);
	const pipelines: Word[][][] = [[[]]];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const stages = pipelines[pipelines.length - 1];
		if (token.kind === "word") {
			const bare = unquoted(token.raw, true);
			if (bare.startsWith("#") || bare.includes("<")) return undefined;
			if (bare.includes(">")) {
				// An output redirection: `2>/dev/null`, `2>"err"`, or `2>` then `&1` or a target.
				if (!/^\d*>>?/.test(bare)) return undefined;
				if (/^\d*>>?$/.test(token.raw)) {
					const next = tokens[i + 1];
					if (next?.kind !== "separator" || (next.raw !== "&" && next.raw.trim() !== "")) return undefined;
					if (tokens[i + 2]?.kind !== "word") return undefined;
					i += 2;
				}
				continue;
			}
			const active = unquoted(token.raw, false);
			if (/[$`]/.test(active)) return undefined;
			if (token.value.length > 0)
				stages[stages.length - 1].push({ value: token.value, raw: token.raw, bare, active });
			continue;
		}
		const operator = token.raw.replace(/[ \t]/g, "");
		if (operator.length === 0) continue;
		if (/^\|\n*$/.test(operator)) stages.push([]);
		// `;` and newlines run every view; `&&` may skip the later ones.
		else if (/^[;\n]+$/.test(operator)) pipelines.push([[]]);
		else return undefined;
	}

	const soles = new Set<string | undefined>();
	const roots: string[] = [];
	const globs: string[] = [];
	let nl = false;
	let git = false;
	let hidesNames = false;
	for (const stages of pipelines) {
		if (stages.length === 1 && stages[0].length === 0) continue;
		const start = stages[0].findIndex(word => !ASSIGNMENT.test(word.raw));
		if (start < 0) return undefined;
		const [name, ...args] = stages[0].slice(start);
		const numbered = numbererFiles(name.value, args);
		if (!numbered) return undefined;
		const { files } = numbered;
		hidesNames ||= numbered.hidesNames;
		for (const [stage, ...stageArgs] of stages.slice(1)) {
			if (stage === undefined || stageArgs.some(expands) || !keepsRows(stage.value, stageArgs)) return undefined;
		}
		nl ||= name.value === "nl";
		// `git grep` prints paths under the directory whatever its revisions and pathspecs.
		if (name.value === "git" || files.length === 0) roots.push(cwd);
		else {
			for (const file of files) {
				const spelled = file.active.startsWith("~") ? os.homedir() + file.value.slice(1) : file.value;
				if (GLOB.test(file.active)) globs.push(spelled);
				else roots.push(path.resolve(cwd, spelled));
			}
		}
		git ||= name.value === "git";
		const [only] = files;
		soles.add(
			files.length === 1 && !EXPANDING.test(only.bare) && !climbs(only.value)
				? path.resolve(cwd, only.value)
				: undefined,
		);
	}
	if (soles.size === 0) return undefined;
	const [sole] = soles;
	return { sole: soles.size === 1 ? sole : undefined, roots, globs, nl, git, hidesNames };
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
	const text = normalizeToLF(stripBom(raw).text);
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
	// The files a glob matched are the shell's operands: a match spelled like
	// an option (`-v`) was read as one, and a row may only name a match.
	for (const glob of view.globs) {
		const absolute = path.isAbsolute(glob);
		const matches = [
			...new Bun.Glob(absolute ? path.relative("/", glob) : glob).scanSync({
				cwd: absolute ? "/" : cwd,
				onlyFiles: false,
				absolute: true,
			}),
		];
		if (
			matches.length > MAX_GLOB_MATCHES ||
			(!absolute && matches.some(match => path.relative(cwd, match).startsWith("-")))
		) {
			return undefined;
		}
		view.roots.push(...matches);
	}
	if (view.git) {
		// Under `grep.fullName`, `git grep` prints paths from the repository's
		// top: only there do they read the same as from `cwd`.
		for (let dir = cwd; ; dir = path.dirname(dir)) {
			if (await fs.stat(path.join(dir, ".git")).catch(() => null)) {
				if (dir !== cwd) return undefined;
				break;
			}
			if (path.dirname(dir) === dir) break;
		}
	}
	// A `path:N:` row names a file the command read, or one under a directory it searched.
	const underRoot = (file: string): boolean =>
		view.roots.some(root => {
			const relative = path.relative(root, file);
			return (
				relative === "" ||
				(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
			);
		});
	const prefixes = new Set<string>();
	for (const row of rows) {
		if (view.hidesNames || row.file === undefined || /\s/.test(row.file) || climbs(row.file)) continue;
		if (!underRoot(path.resolve(cwd, row.file))) continue;
		if (prefixes.size === MAX_PREFIXES && !prefixes.has(row.file)) break;
		prefixes.add(row.file);
	}
	const [operands, existing] = await Promise.all([
		regularFiles(view.sole ? [view.sole] : []),
		regularFiles([...prefixes].map(prefix => path.resolve(cwd, prefix))),
	]);
	const named = new Map<string, string>();
	for (const prefix of prefixes) {
		const file = path.resolve(cwd, prefix);
		if (existing.has(file)) named.set(prefix, file);
	}
	// Rows printed without a path belong to the one file the view reads;
	// `cat -n a.ts b.ts` numbers the joined stream.
	const [sole] = operands;
	const files = [...new Set([...named.values(), ...(sole ? [sole] : [])])].filter(
		// Notebooks edit as cell text, not the JSON these rows number.
		file => !file.toLowerCase().endsWith(".ipynb"),
	);
	if (files.length > MAX_TAGGED_FILES) return undefined;

	const contents = new Map<string, { text: string; lines: string[] }>();
	/** Readings that match a file line, per output line. */
	const matches = new Map<number, Array<{ file: string; line: number }>>();
	for (const file of files) {
		const content = await readLines(file);
		if (!content) continue;
		// `nl` restarts its numbers after a logical-page delimiter line.
		if (view.nl && file === sole && content.lines.some(line => NL_DELIMITER.test(line))) continue;
		contents.set(file, content);
		for (const row of rows) {
			const applies = row.file === undefined ? file === sole : named.get(row.file) === file;
			if (!applies || row.line < 1 || content.lines[row.line - 1] !== row.text) continue;
			const readings = matches.get(row.index);
			if (readings) readings.push({ file, line: row.line });
			else matches.set(row.index, [{ file, line: row.line }]);
		}
	}
	// An output line read two ways (`a.ts:1:b.ts:1:x`) vouches for neither.
	const seenByFile = new Map<string, Set<number>>();
	for (const readings of matches.values()) {
		if (readings.length !== 1) continue;
		const [{ file, line }] = readings;
		const seen = seenByFile.get(file);
		if (seen) seen.add(line);
		else seenByFile.set(file, new Set([line]));
	}
	const verified: Array<{ file: string; text: string; tag: string; lines: number[] }> = [];
	for (const [file, content] of contents) {
		const seen = seenByFile.get(file);
		if (seen) verified.push({ file, text: content.text, tag: hashlineFileHash(content.text), lines: [...seen] });
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
