/**
 * Verification accounting for the scope benchmark.
 *
 * Splits each shell command (bash `command`, or string literals inside an `eval` cell) into
 * segments, classifies each segment by its leading program, and charges segments that run
 * tests, typecheckers, linters, builds, installs, or programs the task did not ask for. Also
 * counts reads of files the agent had already edited ({@link CallAnalysis.postEditReads}).
 */

/** Verification a command segment performs. `vcs` (status/diff/log/show) is inspection and never charged. */
export type CheckKind = "test" | "typecheck" | "lint" | "build" | "install" | "run" | "vcs";

/** One tool call that performed verification. */
export interface CheckCall {
	tool: string;
	kinds: CheckKind[];
	/** Command text, cut to 240 chars. */
	command: string;
	ms: number;
	/** A charged segment matched none of the task's `allowedChecks`. */
	unrequested: boolean;
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
		/^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:start|dev)\b|bun\s+(?:run\s+)?(?:-e\b|--eval\b|\S+\.[cm]?[jt]sx?\b)|node\s+(?:-e\b|\S+\.[cm]?js\b)|python3?\s+(?:-c\b|\S+\.py\b)|deno\s+run\b)/,
	],
	["vcs", /^git\s+(?:-C\s+\S+\s+)?(?:status|diff|log|show)\b/],
];

/** Leading noise before a segment's program: subshell parens, `VAR=x`, and wrappers like `timeout 60`. */
const SEGMENT_PREFIX = /^[\s(]*(?:(?:[A-Za-z_]\w*=\S*|timeout\s+\S+|time|env|nice|command|exec)\s+)*/;
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const READ_COMMAND = /^(?:cat|head|tail|sed|less|bat|nl|grep|rg|awk)\b/;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const MUTATION_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const READ_TOOLS: Record<string, true> = { read: true, grep: true };

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
 * Charges each call's verification against the task's allowlist and counts post-edit reads.
 * `paths` are the workspace-relative files the run could touch; a call names a file when its
 * serialized arguments contain the path.
 */
export function analyzeCalls(
	calls: readonly ToolCallRecord[],
	opts: { allowedChecks: readonly RegExp[]; paths: readonly string[] },
): CallAnalysis {
	const checks: CheckCall[] = [];
	const edited = new Set<string>();
	let postEditReads = 0;
	for (const call of calls) {
		const texts = executedText(call);
		const segments = texts.flatMap(commandSegments);
		const kinds = new Set<CheckKind>();
		let unrequested = false;
		for (const segment of segments) {
			const segmentKinds = classifySegment(segment);
			for (const kind of segmentKinds) kinds.add(kind);
			const charged = segmentKinds.some(kind => kind !== "vcs");
			if (charged && !opts.allowedChecks.some(allowed => allowed.test(segment))) unrequested = true;
		}
		if (kinds.size > 0) {
			checks.push({ tool: call.name, kinds: [...kinds], command: texts.join("\n").slice(0, 240), ms: call.ms, unrequested });
		}

		const serialized = JSON.stringify(call.args) ?? "";
		const named = opts.paths.filter(file => serialized.includes(file));
		if (MUTATION_TOOLS[call.name] === true) {
			for (const file of named) edited.add(file);
		} else if (
			(READ_TOOLS[call.name] === true || segments.some(segment => READ_COMMAND.test(segment))) &&
			named.some(file => edited.has(file))
		) {
			postEditReads++;
		}
	}
	return { checks, postEditReads };
}
