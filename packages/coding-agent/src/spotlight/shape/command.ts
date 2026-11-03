/**
 * What a bash command does, read from its text: which segments print files,
 * which name source, which run tests, which run the agent's own programs.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Source extensions: code windows outline, and reads of these are "source reads". */
export const SOURCE_PATH =
	/\.(?:pyi?|js|jsx|ts|tsx|mts|cts|mjs|cjs|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|scala|swift|lua|vue|svelte)$/;

/** Docs printed whole fold to their needed sections. */
export const DOC_FILE = /(?:^|\/)[\w.-]+\.(?:md|mdx|rst|txt)$/i;

/** Extensions of files agents print as data: records, logs, reports, tool outputs. */
export const DATA_EXT = /\.(?:json|jsonl|ndjson|csv|tsv|txt|log|out|xml|edb|gct|cls|rnk|gmt|tab|dat)$/i;

/** A segment that prints file contents; `cat >` / `cat <<` writes excluded. */
const READ_SEGMENT = /^(?:cat|sed\s+-n|head|tail|nl|less|more|bat)\b(?!\s*(?:>|<<))/;

/** The agent's own program: a heredoc or an interpreter run, whose output it shaped itself. */
const PROGRAM = /<<-?\s*['"]?\w+|(?:^|[;&|\n]\s*)(?:python3?|node|perl|Rscript|ruby|julia)\b/;

/** A segment that runs a coding agent non-interactively (`omp -p`, `claude -p`, `codex exec`, `bun src/cli.ts -p`). */
const AGENT_SEGMENT =
	/^(?:\w+=\S*\s+)*(?:(?:omp|claude)\b[^|]*\s(?:-p|--print)\b|codex\s+exec\b|bun\s+(?:run\s+)?\S*cli\.ts\b[^|]*\s(?:-p|--print)\b)/;

/** A segment that runs tests or lint: the runner is the command word (after env vars / npx / uv run / python -m …). */
const TEST_SEGMENT =
	/^(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm(?:\s+exec)?|yarn|uv\s+run(?:\s+--?[\w-]+(?:[=\s][\w.@/-]+)?)*|poetry\s+run|python3?\s+-m|(?:\S*\/)?\.bin\/|\S*\/bin\/)\s*)*(?:pytest|py\.test|vitest|jest|mocha|tox|nox|eslint|ruff|mypy|tsc|biome|playwright\s+test|python3?\s+\S*runtests\.py|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|typescript|test[:-][\w:-]+)|cargo\s+(?:test|clippy)|go\s+test|make\s+(?:test|lint|check))\b/;

/** A segment that prints source, docs or diffs (its output must not be shaped as test output). */
const PRINT_SEGMENT = /^(?:cat|nl|sed\s+-n|head|tail|grep|rg|git\s+(?:diff|show)|python3?\s+-\s*<<|python3?\s+-c)\b/;

/** A whole-file read: `cat|nl|bat|more|less [-flags] F…` with no pipe or redirect. */
const WHOLE_READ = /^(?:cat|nl|bat|more|less)(?:\s+-[A-Za-z]+)*\s+[^|<>]+$/;

/**
 * Segments of a shell command: split on `;`, `&&`, `||` and newlines outside quotes (`sed -n '1,9p;20,30p'` is one
 * segment); pipes stay inside a segment.
 */
export function segments(command: string): string[] {
	const out: string[] = [];
	let quote = "";
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = "";
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") i++;
		else if (ch === ";" || ch === "\n" || ((ch === "&" || ch === "|") && command[i + 1] === ch)) {
			out.push(command.slice(start, i).trim());
			if (ch === "&" || ch === "|") i++;
			start = i + 1;
		}
	}
	out.push(command.slice(start).trim());
	return out;
}

/** Some segment prints file contents (`cd x; ls; cat a.py`). */
export function printsFiles(command: string): boolean {
	return segments(command).some(s => READ_SEGMENT.test(s));
}

/** Any token of the command is a source path or glob (`cat src/*.py`, `sed -n 1,80p app.ts`). */
export function namesSource(command: string): boolean {
	return command.split(/[\s;|&<>()'"`=]+/).some(token => SOURCE_PATH.test(token));
}

/** Every file-printing segment names only data files (by extension), e.g. `head -80 /results/EXP_A.log`. */
export function readsOnlyData(command: string): boolean {
	const reads = segments(command).filter(s => READ_SEGMENT.test(s));
	if (reads.length === 0) return false;
	return reads.every(s => {
		const paths = s
			.split(/[|<>]/)[0]
			.split(/\s+/)
			.slice(1)
			.map(unquote)
			.filter(t => t && !t.startsWith("-") && !/^\d+(,\d+)?p?$/.test(t));
		return paths.length > 0 && paths.every(p => DATA_EXT.test(p));
	});
}

/** A segment runs tests or lint, and none prints source, docs or diffs (logs and bare `head -N`/`tail -N` are fine). */
export function isTestRun(command: string): boolean {
	const segs = segments(command)
		.map(s => s.replace(/^cd\s+\S+\s*$/, ""))
		.filter(Boolean);
	if (!segs.some(s => TEST_SEGMENT.test(s))) return false;
	return !segs.some(
		s => PRINT_SEGMENT.test(s) && !/\.(?:log|txt|out)\b/.test(s) && !/^(?:head|tail)\s+-n?\s*\d+\s*$/.test(s),
	);
}

/** The command runs a program of the agent's own (heredoc, interpreter). */
export function runsProgram(command: string): boolean {
	return PROGRAM.test(command);
}

/** The command runs a coding agent whose printed report is its whole answer. */
export function runsAgent(command: string): boolean {
	return segments(command).some(s => AGENT_SEGMENT.test(s));
}

/** A pipeline stage that keeps only the lines it was told to (`grep`, `rg`, `sed -n 10,40p`, `awk '/x/'`). */
const FILTER_STAGE = /^(?:\w+=\S*\s+)*(?:grep|egrep|rg|ag|sed\s+-n|awk)\b/;

/**
 * The command's output is lines the agent already picked: its last segment searches or selects (`grep -n f x.c`,
 * `git show m:x.c | grep -A12 y`, `sed -n '99,130p' doc.md`).
 */
export function narrowsOutput(command: string): boolean {
	const last = segments(command).filter(Boolean).at(-1) ?? "";
	return last.split("|").some(stage => FILTER_STAGE.test(stage.trim()));
}

/** The command or read path reads text a shaped result saved (`artifact://N`): the agent paging hidden lines back in. */
export function isPageBack(command: string): boolean {
	return command.includes("artifact://");
}

/** One file-printing segment of a command. */
export interface ReadTarget {
	/** The path or glob as written. */
	arg: string;
	/** Printed with `cat -n` / `nl -ba` line-number prefixes (`%6d\t`). */
	numbered: boolean;
	/** `cd` arguments of earlier segments, in order. */
	cds: string[];
	/** 1-based inclusive ranges in sed order; undefined = whole file. */
	ranges?: [number, number][];
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "");

/** sed `-n` script of `a,bp` / `Np` commands joined by `;` → ranges; undefined for anything else. */
function sedRanges(spec: string): [number, number][] | undefined {
	const out: [number, number][] = [];
	for (const part of unquote(spec).split(";").filter(Boolean)) {
		const m = /^(\d+)(?:,(\d+))?p$/.exec(part.trim());
		if (!m) return undefined;
		out.push([Number(m[1]), Number(m[2] ?? m[1])]);
	}
	return out.length ? out : undefined;
}

/**
 * File-printing segments of `command`: `sed -n 'A,Bp' F` (also `A,Bp;C,Dp`), `head [-n] N F`, `cat -n F | sed -n …`,
 * `nl -ba F | sed -n …`, `cat F | head N`, `cat F | sed -n …`, and whole reads `cat|nl|bat|more|less [-flags] F…`.
 */
export function readTargets(command: string): ReadTarget[] {
	const cds: string[] = [];
	const targets: ReadTarget[] = [];
	for (const seg of segments(command)) {
		const cd = /^cd\s+(\S+)\s*$/.exec(seg);
		if (cd) {
			cds.push(unquote(cd[1]));
			continue;
		}
		const at = [...cds];
		let m = /^sed\s+-n\s+(\S+)\s+(\S+)$/.exec(seg);
		if (m) {
			const ranges = sedRanges(m[1]);
			if (ranges) targets.push({ arg: unquote(m[2]), numbered: false, cds: at, ranges });
			continue;
		}
		m = /^head\s+(?:-n\s*)?-?(\d+)\s+(\S+)$/.exec(seg);
		if (m) {
			targets.push({ arg: unquote(m[2]), numbered: false, cds: at, ranges: [[1, Number(m[1])]] });
			continue;
		}
		m = /^(?:nl\s+-ba|cat\s+-n)\s+(\S+)\s*\|\s*sed\s+-n\s+(\S+)$/.exec(seg);
		if (m) {
			const ranges = sedRanges(m[2]);
			if (ranges) targets.push({ arg: unquote(m[1]), numbered: true, cds: at, ranges });
			continue;
		}
		m = /^cat\s+(\S+)\s*\|\s*head\s+(?:-n\s*)?-?(\d+)$/.exec(seg);
		if (m) {
			targets.push({ arg: unquote(m[1]), numbered: false, cds: at, ranges: [[1, Number(m[2])]] });
			continue;
		}
		m = /^cat\s+(\S+)\s*\|\s*sed\s+-n\s+(\S+)$/.exec(seg);
		if (m) {
			const ranges = sedRanges(m[2]);
			if (ranges) targets.push({ arg: unquote(m[1]), numbered: false, cds: at, ranges });
			continue;
		}
		if (!WHOLE_READ.test(seg)) continue;
		const parts = seg.split(/\s+/);
		if (parts[0] === "nl" && !/-ba\b|-b\s+a\b/.test(seg)) continue;
		const numbered = parts[0] === "nl" || /^-[A-Za-z]*n/.test(parts.find(w => w.startsWith("-")) ?? "");
		for (const w of parts.slice(1)) if (!w.startsWith("-")) targets.push({ arg: unquote(w), numbered, cds: at });
	}
	return targets;
}

/** A file a read target names: the path as written (glob expanded) and its real absolute path. */
export interface ResolvedFile {
	path: string;
	abs: string;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * The files `target` prints, resolved against `cwd` after its `cd` segments, globs expanded in shell order.
 * Missing files and directories are left out.
 */
export async function resolveTarget(target: ReadTarget, cwd: string): Promise<ResolvedFile[]> {
	let dir = cwd;
	for (const cd of target.cds) dir = path.resolve(dir, expandHome(cd));
	const arg = expandHome(target.arg);
	let names: string[];
	if (/[*?[]/.test(arg)) {
		const parts = arg.split("/");
		const first = parts.findIndex(p => /[*?[]/.test(p));
		const base = parts.slice(0, first).join("/") || (arg.startsWith("/") ? "/" : ".");
		const pattern = parts.slice(first).join("/");
		names = [];
		try {
			for await (const hit of new Bun.Glob(pattern).scan({ cwd: path.resolve(dir, base), onlyFiles: true })) {
				names.push(base === "." ? hit : path.join(base, hit));
			}
		} catch {
			return [];
		}
		names.sort();
	} else names = [arg];
	const out: ResolvedFile[] = [];
	for (const name of names) {
		try {
			const abs = await fs.realpath(path.resolve(dir, name));
			if ((await fs.stat(abs)).isFile()) out.push({ path: name, abs });
		} catch {
			// A path the command named but that does not exist (or is unreadable) prints nothing to match.
		}
	}
	return out;
}

/** The file's lines (a trailing newline does not add one); null when it can't be read. */
export async function fileLines(abs: string): Promise<string[] | null> {
	try {
		return (await Bun.file(abs).text()).replace(/\n$/, "").split("\n");
	} catch {
		return null;
	}
}
