/**
 * Verification accounting for the scope benchmark.
 *
 * The behavior it scores: work statically, then verify the finished change once before
 * yielding. Each shell command (bash `command`, or string literals inside an `eval` cell) is
 * split into segments and classified by its leading program, then placed against the run's
 * edits ({@link CheckPhase}): `before` the first one (reproducing a reported failure),
 * `during` the work (the check-edit-check loop the goal removes), or `final`, the verification
 * after the last edit. Also counts reads of files the agent had already edited
 * ({@link CallAnalysis.postEditReads}).
 *
 * Edits are the edit tools plus shell commands that write files the run left changed
 * (`sed -i`, `sd`, `mv`, `rm`, redirects, inline scripts that write files). Scratch paths and
 * throwaway scripts the run removed again are not edits, so deleting a check script after the
 * check does not unverify the change. Documentation ({@link DOC_FILE}) is not checkable: a
 * docs edit neither needs verification nor resets one.
 */

/** Work a command segment performs. `scan` = a search rooted at `/`, `~`, or a top-level system directory. */
export type CheckKind = "test" | "typecheck" | "lint" | "build" | "install" | "run" | "scan";

/**
 * When a check ran, relative to the run's edits.
 * - `before`: ahead of the first edit, or in a run that changed nothing.
 * - `final`: a test, typecheck, lint, build, or program run started after the last edit.
 * - `during`: anything else after the first edit, including installs and scans, which verify nothing.
 */
export type CheckPhase = "before" | "during" | "final";

/** One tool call that ran a check. */
export interface CheckCall {
	tool: string;
	kinds: CheckKind[];
	/** Command text, cut to 240 chars. */
	command: string;
	ms: number;
	phase: CheckPhase;
}

/** One finished tool call, in start order. */
export interface ToolCallRecord {
	name: string;
	args: unknown;
	ms: number;
}

/** What a run's tool calls spent on verification. */
export interface CallAnalysis {
	checks: CheckCall[];
	/** A `final` check ran; `null` when the run changed no code file, so there was nothing to verify. */
	verified: boolean | null;
	/** `read`/`grep`/`cat`-style calls naming a file an earlier `edit`/`write` changed. */
	postEditReads: number;
}

const CHECK_PATTERNS: ReadonlyArray<readonly [CheckKind, RegExp]> = [
	[
		"test",
		/^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|(?:bunx\s+|npx\s+)?(?:vitest|jest|mocha)\b|(?:python3?\s+-m\s+)?pytest\b|cargo\s+(?:test|nextest)\b|go\s+test\b|node\s+--test\b)/,
	],
	[
		"typecheck",
		/^(?:(?:bunx\s+|npx\s+)?tsc\b|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:check|typecheck)\b|cargo\s+check\b|mypy\b|pyright\b)/,
	],
	[
		"lint",
		/^(?:(?:bunx\s+|npx\s+)?(?:oxlint|eslint|biome|prettier|oxfmt)\b|ruff\b|cargo\s+clippy\b|(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|fmt|format)\b)/,
	],
	["build", /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b|cargo\s+build\b|make\b)/],
	["install", /^(?:(?:bun|npm|pnpm|yarn)\s+(?:install|add|i)\b|bunx\b|npx\b)/],
	[
		"run",
		/^(?:(?:bun|npm|pnpm|yarn)\s+run\s+(?!(?:test|check|typecheck|lint|fmt|format|build)\b)[\w:.-]+|(?:npm|pnpm|yarn)\s+(?:start|dev)\b|bun\s+(?:-e\b|--eval\b|-(?=\s|$)|\S+\.[cm]?[jt]sx?\b)|node\s+(?:-e\b|-(?=\s|$)|\S+\.[cm]?js\b)|python3?\s+(?:-c\b|-(?=\s|$)|\S+\.py\b)|deno\s+run\b)/,
	],
	[
		"scan",
		/^(?:(?:find|fd|rg|ag|grep)\b.*\s(?:\/|~\/?|\$HOME\/?|\/(?:Users|home|private|var|tmp|opt|usr)\/?)(?=\s|$)|(?:locate|mdfind)\b)/,
	],
];

/** Kinds that can confirm a change works; installs and scans confirm nothing. */
const VERIFYING: Record<CheckKind, boolean> = {
	test: true,
	typecheck: true,
	lint: true,
	build: true,
	run: true,
	install: false,
	scan: false,
};

/** Whether a check of these kinds can confirm that code works. */
export function verifies(kinds: readonly CheckKind[]): boolean {
	return kinds.some(kind => VERIFYING[kind]);
}

/** Leading noise before a segment's program: subshell parens, a `name() {` definition, `VAR=x`, and wrappers like `timeout 60`. */
const SEGMENT_PREFIX =
	/^[\s(]*(?:\w+\s*\(\)\s*\{\s*)?(?:(?:[A-Za-z_]\w*=\S*|timeout\s+\S+|time|env|nice|command|exec)\s+)*/;
/** Files no test, typecheck, or lint covers. */
const DOC_FILE = /\.(?:md|mdx|txt|rst)$/i;
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const READ_COMMAND = /^(?:cat|head|tail|sed|less|bat|nl|grep|rg|awk)\b/;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/** A module load in a JS `eval` cell, with the rest of its line: `import("./src/x.ts")`, `require(dir + "/src/x")`, `from "./src/x"`. */
const CELL_IMPORT = /\b(?:import|require)\s*\(([^\n]{0,200})|\bfrom\s+(["'`][^"'`\n]+["'`])/g;
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const MUTATION_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
/** A file header of an `edit` patch. */
const EDIT_HEADER = /^\*\*\* (?:Edit|Add|Update|Delete) File: (.+)$/gm;
const READ_TOOLS: Record<string, true> = { read: true, grep: true };

/** A heredoc: its command line (group 1), then the body up to the terminator line. */
const HEREDOC = /([^\n]*<<-?\s*(["']?)(\w+)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;
/** A script handed to an interpreter inline: `bun -e '…'`, `python3 -c "…"`. */
const INLINE_SCRIPT = /\b(?:python3?\s+-c|bun\s+(?:-e|--eval)|node\s+-e)\s+(["'])([\s\S]*?)\1/g;
const INTERPRETER = /^\s*(?:python3?|bun|node|ruby|perl)\b/;
const SCRIPT_WRITES_FILE = /\.write_text\(|writeFileSync\(|Bun\.write\(|open\([^)]*,\s*["'][wa]/;
/** Stands in for an inline script that writes files, so the script body never reads as shell. */
const WRITE_MARKER = "__script_writes_file__";

const IN_PLACE_EDIT = /^(?:sed\b.*\s-(?:[a-zA-Z]*i(?=\s|$|\.|')|-in-place)|sd\b|perl\s+-\S*i|patch\b)/;
const WORKTREE_GIT = /^git\s+(?:apply|mv|rm|checkout|restore|stash|reset)\b/;
/** Commands whose path arguments are written or removed; `cp` writes only its last one. */
const PATH_WRITER = /^(rm|mv|cp|tee|touch)\b/;
/** `> file` / `>> file`; not fd duplication (`2>&1`, `>&2`) nor arrows inside code (`=>`, `->`). */
const REDIRECT = /(?<![0-9&=-])>>?\s*(?!&)(\S+)/g;
const SCRATCH_PATH = /^(?:\/tmp\b|\/private\/tmp\b|\/dev\/|\$\{?TMPDIR)/;
const SURROUNDING_QUOTES = /^["']|["']$/g;

/** Command segments in program position, with wrappers and env assignments stripped. */
export function commandSegments(command: string): string[] {
	return command
		.split(SEGMENT_SPLIT)
		.map(segment => segment.replace(SEGMENT_PREFIX, "").trim())
		.filter(Boolean);
}

/** Every check kind one segment performs; `bunx tsc` is both `install` and `typecheck`. */
export function classifySegment(segment: string): CheckKind[] {
	return CHECK_PATTERNS.filter(([, pattern]) => pattern.test(segment)).map(([kind]) => kind);
}

/**
 * Shell text with script bodies removed: a heredoc collapses to its command line and an inline
 * `-e`/`-c` script to nothing. A body that an interpreter runs and that writes files leaves
 * {@link WRITE_MARKER} behind as its own segment, after the command: the script's run cannot
 * verify what it wrote.
 */
function stripScripts(command: string): string {
	return command
		.replace(HEREDOC, (_, line: string, _quote: string, _tag: string, body: string) =>
			INTERPRETER.test(line) && SCRIPT_WRITES_FILE.test(body) ? `${line}\n${WRITE_MARKER}` : line,
		)
		.replace(INLINE_SCRIPT, (script: string, _quote: string, body: string) => {
			const head = script.slice(0, script.indexOf(body) - 1);
			return SCRIPT_WRITES_FILE.test(body) ? `${head}\n${WRITE_MARKER}` : head;
		});
}

/** Shell text a tool call executes: bash's `command`, or the string literals of an `eval` cell. */
function executedText(call: ToolCallRecord): string[] {
	const args = call.args;
	if (typeof args !== "object" || args === null) return [];
	if (call.name === "bash" && "command" in args && typeof args.command === "string") return [args.command];
	if (call.name === "eval" && "code" in args && typeof args.code === "string") {
		return Array.from(args.code.matchAll(STRING_LITERAL), match => match[2]);
	}
	return [];
}

/**
 * Whether an edit-tool call changes code. The files it writes are its `path` argument or its
 * patch's file headers: docs and scratch files are not code. A call showing neither is judged
 * by the workspace files its arguments name (`named`), and counted when it names none, to stay strict.
 */
function editsCode(call: ToolCallRecord, named: readonly string[]): boolean {
	const args = call.args;
	const targets: string[] = [];
	if (typeof args === "object" && args !== null) {
		if ("path" in args && typeof args.path === "string") targets.push(args.path);
		if ("input" in args && typeof args.input === "string") {
			for (const header of args.input.matchAll(EDIT_HEADER)) targets.push(header[1].trim());
		}
	}
	if (targets.length === 0) return named.length === 0 || named.some(file => !DOC_FILE.test(file));
	return targets.some(target => !DOC_FILE.test(target) && !SCRATCH_PATH.test(target));
}

/**
 * Whether an `eval` cell loads a workspace module: it then runs project code in-process, the
 * same check as `bun -e`. `paths` are the workspace files as the agent would name them.
 */
function cellRunsProject(call: ToolCallRecord, paths: readonly string[]): boolean {
	const args = call.args;
	if (call.name !== "eval" || typeof args !== "object" || args === null) return false;
	if (!("code" in args) || typeof args.code !== "string") return false;
	const stems = paths.filter(file => MODULE_EXTENSION.test(file)).map(file => file.replace(MODULE_EXTENSION, ""));
	return Array.from(args.code.matchAll(CELL_IMPORT), match => match[1] ?? match[2]).some(target =>
		stems.some(stem => target.includes(stem)),
	);
}

/**
 * Whether one segment edits the workspace. In-place editors and script writes always do; a
 * command naming its targets (`rm`, `mv`, `cp`, `tee`, `touch`, redirects) does only when a
 * target is one of the `changed` files. `inScratch` = an earlier `cd` left for a scratch directory.
 */
function mutatesWorkspace(
	segment: string,
	inScratch: boolean,
	changed: readonly string[],
	docs: readonly string[],
): boolean {
	if (segment === WRITE_MARKER || WORKTREE_GIT.test(segment)) return true;
	// An in-place edit naming only changed docs is a docs edit; one naming no changed file is counted, to stay strict.
	if (IN_PLACE_EDIT.test(segment)) {
		return changed.some(file => segment.includes(file)) || !docs.some(file => segment.includes(file));
	}
	const hitsChanged = (word: string): boolean => {
		const target = word.replace(SURROUNDING_QUOTES, "").replace(/^\.\//, "");
		if (target.length < 3 || SCRATCH_PATH.test(target) || (inScratch && !target.startsWith("/"))) return false;
		return changed.some(file => target.endsWith(file) || file.endsWith(target));
	};
	for (const redirect of segment.matchAll(REDIRECT)) if (hitsChanged(redirect[1])) return true;
	const writer = PATH_WRITER.exec(segment);
	if (!writer) return false;
	const paths = segment
		.replace(REDIRECT, "")
		.split(/\s+/)
		.slice(1)
		.filter(word => !word.startsWith("-"));
	return (writer[1] === "cp" ? paths.slice(-1) : paths).some(hitsChanged);
}

/** A step of the run, in order: an edit, a check, or both. */
interface Step {
	call: number;
	mutates: boolean;
	checks: boolean;
	/** The check can confirm a change works. */
	verifies: boolean;
}

/**
 * Places each call's checks against the run's code edits and counts post-edit reads.
 * `changed` are the files that differ from the fixture afterwards: a run that changed no code
 * has nothing to verify. `paths` are all files the run could touch. Both are workspace-relative
 * as the agent would name them; a call names a file when its serialized arguments contain the path.
 */
export function analyzeCalls(
	calls: readonly ToolCallRecord[],
	opts: { changed: readonly string[]; paths: readonly string[] },
): CallAnalysis {
	const code = opts.changed.filter(file => !DOC_FILE.test(file));
	const docs = opts.changed.filter(file => DOC_FILE.test(file));
	const steps: Step[] = [];
	const found: Array<{ call: number; kinds: CheckKind[]; command: string }> = [];
	const edited = new Set<string>();
	let postEditReads = 0;
	for (const [index, call] of calls.entries()) {
		const texts = executedText(call);
		const segments = texts.flatMap(text => commandSegments(stripScripts(text)));
		const kinds = new Set<CheckKind>();
		const serialized = JSON.stringify(call.args) ?? "";
		const named = opts.paths.filter(file => serialized.includes(file));
		// An edit naming only docs is not a code edit; one naming no known file is counted, to stay strict.
		if (MUTATION_TOOLS[call.name] === true && editsCode(call, named)) {
			steps.push({ call: index, mutates: true, checks: false, verifies: false });
		}
		let inScratch = false;
		for (const segment of segments) {
			const segmentKinds = classifySegment(segment);
			for (const kind of segmentKinds) kinds.add(kind);
			const mutates = mutatesWorkspace(segment, inScratch, code, docs);
			const checks = segmentKinds.length > 0;
			if (mutates || checks) {
				steps.push({ call: index, mutates, checks, verifies: verifies(segmentKinds) });
			}
			if (segment.startsWith("cd ")) {
				inScratch = SCRATCH_PATH.test(segment.slice(3).trim().replace(SURROUNDING_QUOTES, ""));
			}
		}
		if (cellRunsProject(call, opts.paths)) {
			kinds.add("run");
			steps.push({ call: index, mutates: false, checks: true, verifies: true });
		}
		if (kinds.size > 0) found.push({ call: index, kinds: [...kinds], command: texts.join("\n").slice(0, 240) });

		if (MUTATION_TOOLS[call.name] === true) {
			for (const file of named) edited.add(file);
		} else if (
			(READ_TOOLS[call.name] === true || segments.some(segment => READ_COMMAND.test(segment))) &&
			named.some(file => edited.has(file))
		) {
			postEditReads++;
		}
	}

	// A changed workspace with no edit in sight means the edit went unrecognized: every check may have followed it.
	const changed = code.length > 0;
	const firstEdit = changed ? steps.findIndex(step => step.mutates) : -1;
	const lastEdit = steps.findLastIndex(step => step.mutates);
	const final = new Set<number>();
	const before = new Set<number>();
	for (const [index, step] of steps.entries()) {
		if (!step.checks) continue;
		if (changed && step.verifies && index > lastEdit) final.add(step.call);
		if (!changed || (firstEdit !== -1 && index < firstEdit)) before.add(step.call);
	}
	return {
		checks: found.map(check => ({
			tool: calls[check.call].name,
			kinds: check.kinds,
			command: check.command,
			ms: calls[check.call].ms,
			phase: final.has(check.call) ? "final" : before.has(check.call) ? "before" : "during",
		})),
		verified: changed ? final.size > 0 : null,
		postEditReads,
	};
}
