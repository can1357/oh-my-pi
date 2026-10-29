/**
 * Edit tags for files a `bash` command printed with line numbers (`grep -n`,
 * `rg -n`, `cat -n`, `nl -ba`).
 *
 * Agents locate code with `grep -n` and then edit it, but bash output carries
 * no `[path#tag]` header, so the edit that follows invents one or anchors on
 * lines no tagged view displayed. A numbered row counts here only when the
 * command is one numberer reading files it names (see {@link parseView}) and
 * the row's text equals the file's current line at that number: once the
 * caller knows the model receives the output whole, those lines are recorded
 * as displayed in the file's snapshot, exactly as a `search` hit records them,
 * and the result names the tag. Unnumbered output (`sed -n`, `head`) never
 * counts: the model would have to count lines to get a number.
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
/** Matches the edit store's snapshot cap. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Cheap pre-check: some row starts like `N:`, `name:N:`, or `   N<TAB>`. */
const MAYBE_NUMBERED = /^(?:\s*\d+\t|[^\n]*?\d+:)/m;
const TAB_ROW = /^\s*(\d+)\t(.*)$/;
const COLON_ROW = /^(\d+):(.*)$/;

/** Tags for a finished command's numbered rows, not yet recorded. */
export interface NumberedFileTags {
	/** The notice naming each file's `[path#TAG]`. */
	notice: string;
	/** Record the verified rows as displayed; call only once the model receives the output whole. */
	commit(): void;
}

/**
 * The options a numberer may take: every other option, and every option
 * abbreviation, gives no tags, so a flag that renumbers, relabels, prints
 * context, names or counts instead of rows, or recurses (`-b`, `--label`,
 * `-A`, `-h`, `-l`, `-r`) never slips through.
 */
interface OptionSpec {
	/** Short options without a value. */
	flags: string;
	/** Short options that take a value: the rest of the cluster, or the next word. */
	valued: string;
	/** Short options whose value is the pattern. */
	patternFlags: string;
	long: ReadonlySet<string>;
	longValued: ReadonlySet<string>;
	/** Long options whose value may only follow `=`. */
	longOptional: ReadonlySet<string>;
	/** The long option that numbers lines. */
	numberLong: string;
	/** Whether the first operand is the pattern unless an option gave it. */
	pattern: boolean;
	/**
	 * Whether options may follow operands. GNU tools under `POSIXLY_CORRECT`,
	 * and BSD `cat`, read `cat a.ts -n`'s `-n` as a file: the numbering and
	 * pattern options must then come first, the others only filter real rows.
	 */
	permutes: boolean;
	/** How a row with no file name prints: `N:text`, or `cat -n`'s `   N<TAB>text`. */
	rows: "colon" | "tab";
}

const GREP: OptionSpec = {
	flags: "nivwxyEFGPHosaIU",
	valued: "mef",
	patternFlags: "ef",
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
		"with-filename",
		"only-matching",
		"silent",
		"no-messages",
		"text",
	]),
	longValued: new Set(["max-count", "binary-files", "regexp", "file"]),
	longOptional: new Set(["color", "colour"]),
	numberLong: "line-number",
	pattern: true,
	permutes: false,
	rows: "colon",
};

const NUMBERERS: Record<string, OptionSpec> = {
	grep: GREP,
	egrep: GREP,
	fgrep: GREP,
	rg: {
		flags: "niSswxvFPHoU",
		valued: "mefjM",
		patternFlags: "ef",
		long: new Set([
			"line-number",
			"ignore-case",
			"smart-case",
			"case-sensitive",
			"word-regexp",
			"line-regexp",
			"invert-match",
			"fixed-strings",
			"with-filename",
			"only-matching",
			"multiline",
			"pcre2",
			"text",
			"no-config",
		]),
		longValued: new Set(["max-count", "regexp", "file", "color", "max-columns", "threads"]),
		longOptional: new Set(),
		numberLong: "line-number",
		pattern: true,
		permutes: true,
		rows: "colon",
	},
	cat: {
		flags: "nu",
		valued: "",
		patternFlags: "",
		long: new Set(["number"]),
		longValued: new Set(),
		longOptional: new Set(),
		numberLong: "number",
		pattern: false,
		permutes: false,
		rows: "tab",
	},
};

/** Unquoted characters that make a word several words, or another one. */
const EXPANDING = /[$`*?[{]/;
/** An `nl` logical-page delimiter line, which restarts its numbering. */
const NL_DELIMITER = /^(?:\\:){1,3}$/;

interface Word {
	value: string;
	/** The unquoted characters of the word, where globs expand, plus `$` and backticks inside double quotes. */
	active: string;
	/** The word starts with an unquoted `~`, which the shell expands to the home directory. */
	tilde: boolean;
}

/**
 * A word's shell spelling with quoted and escaped text dropped, except `$`
 * (not closing the quotes) and backticks inside double quotes, which still expand.
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
			else if (quote === '"' && (ch === "`" || (ch === "$" && raw[i + 1] !== '"'))) out += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else {
			out += ch;
		}
	}
	return out;
}

/** The files a numberer reads, and how it prints their rows. */
interface Numbered {
	files: Word[];
	/** `-H`: rows carry their file name even for one file. */
	withNames: boolean;
	rows: "colon" | "tab";
}

/**
 * The words naming the files a numberer reads (its pattern and option values
 * dropped), or `undefined` when the command does not print those files' line
 * numbers or takes an option outside its {@link OptionSpec}. A system `rg`
 * (`systemTools`) also reads options from `RIPGREP_CONFIG_PATH`, which can
 * change its rows (`--no-filename`), unless the command passes `--no-config`.
 */
function numbererFiles(name: string, args: Word[], systemTools: boolean): Numbered | undefined {
	if (name === "nl") {
		// Only `-ba` numbers every line; the default skips blank ones.
		const [option, ...files] = args;
		return option?.value === "-ba" && files.every(file => !file.value.startsWith("-"))
			? { files, withNames: false, rows: "tab" }
			: undefined;
	}
	const spec = NUMBERERS[name];
	if (!spec) return undefined;
	let numbered = false;
	let withNames = false;
	let patternGiven = false;
	let optionsEnded = false;
	let configIgnored = !systemTools || name !== "rg";
	const operands: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i].value;
		if (optionsEnded || !word.startsWith("-")) {
			operands.push(args[i]);
			continue;
		}
		// A `--` after a file is itself a file.
		if (word === "--" && operands.length === 0) {
			optionsEnded = true;
			continue;
		}
		// Under `POSIXLY_CORRECT` an option after a file is a file.
		const early = operands.length === 0 || spec.permutes;
		if (EXPANDING.test(args[i].active) || word === "-") return undefined;
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const option = eq < 0 ? word.slice(2) : word.slice(2, eq);
			if (spec.longValued.has(option)) {
				if (eq < 0 && args[++i] && EXPANDING.test(args[i].active)) return undefined;
				if (option === "regexp" || option === "file") {
					if (!early) return undefined;
					patternGiven = true;
				}
			} else if (!spec.longOptional.has(option) && (eq >= 0 || !spec.long.has(option))) {
				return undefined;
			}
			withNames ||= option === "with-filename";
			configIgnored ||= option === "no-config";
			if (option === spec.numberLong) {
				if (!early) return undefined;
				numbered = true;
			}
			continue;
		}
		for (let j = 1; j < word.length; j++) {
			const letter = word[j];
			if (spec.valued.includes(letter)) {
				if (j === word.length - 1 && args[++i] && EXPANDING.test(args[i].active)) return undefined;
				if (spec.patternFlags.includes(letter)) {
					if (!early) return undefined;
					patternGiven = true;
				}
				break;
			}
			if (!spec.flags.includes(letter)) return undefined;
			withNames ||= letter === "H";
			if (letter === "n") {
				if (!early) return undefined;
				numbered = true;
			}
		}
	}
	// An expanded pattern can turn into a pattern and files (`s*`).
	if (!numbered || !configIgnored || operands.some(operand => EXPANDING.test(operand.active))) return undefined;
	return { files: spec.pattern && !patternGiven ? operands.slice(1) : operands, withNames, rows: spec.rows };
}

/** True when a pipeline stage reads only its input stream and keeps whole rows (`head -5`, `tail -n +3`). */
function keepsRows(name: string, args: Word[]): boolean {
	return (name === "head" || name === "tail") && /^(?:-n ?\+?\d+|-\d+)?$/.test(args.map(arg => arg.value).join(" "));
}

/** Where a command's numbered rows come from. */
interface ParsedView {
	/** The files the numberer reads, resolved, keyed by their spelling: grep prints a name as it was given. */
	files: Map<string, string>;
	/** Rows carry no file name: a single file, without `-H`. */
	bare: boolean;
	rows: "colon" | "tab";
	/** The numberer is `nl`, whose numbering restarts at a logical-page delimiter. */
	nl: boolean;
}

/**
 * Parse a command of the one shape whose rows can be traced to files:
 *
 *     NUMBERER [OPTION]... FILE... [| head … | tail …]...
 *
 * A NUMBERER prints each file's own line numbers (`grep -n`, `rg -n`,
 * `cat -n`, `nl -ba`) and takes only the options its {@link OptionSpec}
 * lists, none of which adds context rows, hides file names or recurses. The
 * FILEs are spelled out: no glob, variable or standard input. It runs in
 * `cwd`, where `bash` already turns a leading `cd DIR &&` into the call's
 * working directory. A second command, any other command or filter, keyword,
 * subshell, comment or input redirection gives `undefined`.
 */
function parseView(command: string, cwd: string, systemTools: boolean): ParsedView | undefined {
	const tokens = lexShellCommand(command);
	const stages: Word[][] = [[]];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === "word") {
			const active = unquoted(token.raw);
			if (active.startsWith("#") || active.includes("<")) return undefined;
			if (active.includes(">")) {
				// An output redirection, spelled from the word's start: `2>/dev/null`,
				// `2>"err"`, or `2>` then `&1` or a target. In `'2p'>out` the `2p` is an argument.
				if (!/^\d*>>?/.test(token.raw)) return undefined;
				if (/^\d*>>?$/.test(token.raw)) {
					const next = tokens[i + 1];
					if (next?.kind !== "separator" || (next.raw !== "&" && next.raw.trim() !== "")) return undefined;
					if (tokens[i + 2]?.kind !== "word") return undefined;
					i += 2;
				}
				continue;
			}
			if (token.value.length > 0) {
				stages[stages.length - 1].push({ value: token.value, active, tilde: token.raw.startsWith("~") });
			}
			continue;
		}
		const operator = token.raw.replace(/[ \t]/g, "");
		if (operator.length === 0) continue;
		if (operator === "|") stages.push([]);
		else return undefined;
	}

	const [[name, ...args], ...filters] = stages;
	if (name === undefined) return undefined;
	const numbered = numbererFiles(name.value, args, systemTools);
	if (!numbered || numbered.files.length === 0 || numbered.files.length > MAX_TAGGED_FILES) return undefined;
	for (const [stage, ...stageArgs] of filters) {
		if (stage === undefined || !keepsRows(stage.value, stageArgs)) return undefined;
	}
	const files = new Map<string, string>();
	for (const file of numbered.files) {
		// A leading unquoted `~/` is one path; any other expansion can name other files.
		if (EXPANDING.test(file.active) || (file.tilde && /^~[^/]/.test(file.value)) || file.value === "-") {
			return undefined;
		}
		// `link/../a.ts` climbs out of the symlink's target; resolved by hand it would not.
		if (file.value.split(/[/\\]/).includes("..")) return undefined;
		const spelled = file.tilde ? os.homedir() + file.value.slice(1) : file.value;
		files.set(file.value, path.resolve(cwd, spelled));
	}
	// `cat -n a.ts b.ts` numbers the joined stream.
	if (numbered.rows === "tab" && numbered.files.length !== 1) return undefined;
	return {
		files,
		bare: numbered.files.length === 1 && !numbered.withNames,
		rows: numbered.rows,
		nl: name.value === "nl",
	};
}

async function readLines(file: string): Promise<{ text: string; lines: string[] } | undefined> {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
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
 * Nothing is recorded until the returned `commit` runs. `systemTools`: the
 * shell runs system binaries in place of its builtins (`PI_DISABLE_UUTILS_BUILTINS`).
 */
export async function planNumberedFileTags(
	session: ToolSession,
	command: string,
	cwd: string,
	output: string,
	systemTools = false,
): Promise<NumberedFileTags | undefined> {
	if (!path.isAbsolute(cwd) || !resolveFileDisplayMode(session).hashLines || !MAYBE_NUMBERED.test(output)) {
		return undefined;
	}
	const view = parseView(command, cwd, systemTools);
	if (!view) return undefined;

	const contents = new Map<string, { text: string; lines: string[] }>();
	for (const file of new Set(view.files.values())) {
		// Notebooks edit as cell text, not the JSON these rows number.
		if (file.toLowerCase().endsWith(".ipynb")) continue;
		const content = await readLines(file);
		// `nl` restarts its numbers after a logical-page delimiter line.
		if (!content || (view.nl && content.lines.some(line => NL_DELIMITER.test(line)))) continue;
		contents.set(file, content);
	}

	const seenByFile = new Map<string, Set<number>>();
	for (const raw of output.split("\n")) {
		const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		// Each output line reads as a row of the file it names, or of the one
		// file when rows carry no name; a line that reads as rows of two named
		// files (`a:1:b:2:x` for files `a` and `a:1:b`) vouches for neither.
		const readings: Array<{ file: string; line: number }> = [];
		if (view.bare) {
			const match = (view.rows === "tab" ? TAB_ROW : COLON_ROW).exec(row);
			const [file] = view.files.values();
			if (match && contents.get(file)?.lines[Number(match[1]) - 1] === match[2]) {
				readings.push({ file, line: Number(match[1]) });
			}
		} else {
			for (const [spelling, file] of view.files) {
				if (!row.startsWith(`${spelling}:`)) continue;
				const match = COLON_ROW.exec(row.slice(spelling.length + 1));
				if (match && contents.get(file)?.lines[Number(match[1]) - 1] === match[2]) {
					readings.push({ file, line: Number(match[1]) });
				}
			}
		}
		if (readings.length !== 1) continue;
		const [{ file, line }] = readings;
		if (line < 1) continue;
		const seen = seenByFile.get(file);
		if (seen) seen.add(line);
		else seenByFile.set(file, new Set([line]));
	}

	const verified: Array<{ file: string; text: string; tag: string; lines: number[] }> = [];
	for (const [file, seen] of seenByFile) {
		const { text } = contents.get(file)!;
		verified.push({ file, text, tag: hashlineFileHash(text), lines: [...seen] });
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
