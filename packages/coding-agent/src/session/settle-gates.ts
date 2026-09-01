import * as fs from "node:fs";
import * as path from "node:path";
import { extractLeadingCdTarget, hasTopLevelShellBackground, hasTopLevelStatusMaskingOperator } from "../tools/shell-tokenize";

/** Isolated apply succeeded; parent must re-run acceptance on this tree. */
export const MERGED_UNVERIFIED_MARKER = "MERGED — child yield is not evidence; re-run acceptance on this tree.";

export function annotateUnverifiedMergeSummary(mergeSummary: string, latch: boolean): string {
	if (!latch) return mergeSummary;
	if (mergeSummary.includes(MERGED_UNVERIFIED_MARKER)) return mergeSummary;
	const markerBlock = `\n${MERGED_UNVERIFIED_MARKER}`;
	return mergeSummary.length > 0 ? `${mergeSummary}${markerBlock}` : markerBlock;
}

export function isolatedApplyShouldLatch(args: {
	isolated: boolean;
	applyChanges: boolean;
	hadAnyChanges: boolean;
	exitCode: number;
}): boolean {
	// Key on `hadAnyChanges`, not `changesApplied`: a no-op merge ("No changes
	// to apply.") leaves the repo clean but applied nothing, so there is no
	// unverified child work for the parent to re-accept.
	return args.isolated && args.applyChanges && args.hadAnyChanges === true && args.exitCode === 0;
}

const TAUTOLOGICAL_BASH_COMMANDS = new Set([
	"pwd",
	"ls",
	"echo",
	"true",
	"date",
	"whoami",
	"hostname",
	"uname",
	"id",
	"printenv",
	"env",
	":",
	// Read-only inspection probes — not parent acceptance of merged work.
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"rg",
	"grep",
	"ag",
	"ack",
	"find",
	"fd",
	"wc",
	"file",
	"stat",
	"which",
	"type",
	"realpath",
	"readlink",
	"tree",
	"du",
]);

/** `git status` / `git log` / … inspect state; they do not re-run acceptance. */
const READONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"show",
	"diff",
	"blame",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"branch",
	"remote",
	"tag",
	"describe",
	"shortlog",
	"cat-file",
	"grep",
	"whatchanged",
	"name-rev",
	"symbolic-ref",
	"check-ignore",
]);

/** Leading `NAME=value` tokens (including empty values) before the invoked command. */
const ENV_ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop leading env-assignment tokens so `FOO=1 pwd` classifies as `pwd`. */
export function skipLeadingEnvAssignmentTokens(tokens: readonly string[]): string[] {
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT_TOKEN_RE.test(tokens[index] ?? "")) {
		index++;
	}
	return tokens.slice(index);
}

/** True when a shell segment is only `cd` (optionally with a path / env prefix). */
function isCdOnlyCommandSegment(segment: string): boolean {
	const tokens = skipLeadingEnvAssignmentTokens(segment.replace(/^sudo\s+/, "").split(/\s+/));
	return (tokens[0] ?? "") === "cd";
}

/** `ls` / `pwd` / `echo ok` are not parent acceptance of merged work. */
export function isTautologicalParentVerifyCommand(command: string): boolean {
	let trimmed = command.trim();
	if (trimmed.length === 0) return true;
	// Backgrounded work (`bun test & true`) reports sync success before the check
	// finishes — never treat that as parent acceptance.
	if (hasTopLevelShellBackground(trimmed)) return true;
	// Multiline scripts (`bun test\ntrue`) report the last statement's status, so a
	// trailing `true`/`pwd` masks a failed check. Reject any newline-separated chain.
	if (/\r?\n/.test(trimmed)) return true;
	// Bash `! cmd` inverts the exit status — success means the check failed.
	// Also strip a leading `time` / `time -p` reserved word so `time ! bun test`
	// is classified the same way (Bash returns 0 when the negated check fails).
	const withoutTime = trimmed.replace(/^(?:time(?:[ \t]+-p)?)[ \t]+/, "");
	if (/^!/.test(withoutTime)) return true;
	// Bash normalizes leading `cd <path> &&|; …` into cwd; strip those wrappers so
	// `cd packages/foo && pwd` classifies as `pwd`, not as a real check.
	for (;;) {
		const cd = extractLeadingCdTarget(trimmed);
		if (!cd) break;
		trimmed = cd.rest.trim();
	}
	if (trimmed.length === 0) return true;
	const segments = trimmed
		.split(/(?:&&|\|\||;)+/)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0 && !segment.startsWith("#"));
	// Drop any remaining leading `cd …` segments (e.g. after `||` / redirects).
	// Leading `cd … &&|; …` is already stripped via extractLeadingCdTarget above.
	while (segments.length > 0 && isCdOnlyCommandSegment(segments[0]!)) {
		segments.shift();
	}
	if (segments.length === 0) return true;
	// `bun test || true`, `bun test; true`, and `bun test | cat` report exit 0
	// even when the check failed — never treat as parent acceptance.
	if (hasTopLevelStatusMaskingOperator(trimmed)) return true;
	return segments.every(segment => {
		const tokens = skipLeadingEnvAssignmentTokens(segment.replace(/^sudo\s+/, "").split(/\s+/));
		// Bare assignment-only segment (`FOO=1`) is not acceptance evidence.
		if (tokens.length === 0) return true;
		const invoked = tokens[0] ?? "";
		const base = invoked.split("/").pop() ?? invoked;
		if (TAUTOLOGICAL_BASH_COMMANDS.has(base)) return true;
		if (base === "git") {
			const sub = tokens.slice(1).find(token => token.length > 0 && !token.startsWith("-")) ?? "";
			return READONLY_GIT_SUBCOMMANDS.has(sub);
		}
		return false;
	});
}

/**
 * Literal / arithmetic-only eval cells (`1+1`, `"ok"`, `true`) are not parent
 * acceptance of merged work. Missing/blank code is also non-evidence.
 */
export function isTrivialParentVerifyEvalCode(code: string | undefined): boolean {
	if (code === undefined) return true;
	let trimmed = code.trim().replace(/;+\s*$/, "");
	if (trimmed.length === 0) return true;
	// Strip one layer of block comments / void / outer parens so `void (1+1)` and
	// `(1+1)` stay non-evidence the same way as bare `1+1`.
	trimmed = trimmed.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
	trimmed = trimmed.replace(/^void\s+/, "").trim();
	if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		trimmed = trimmed.slice(1, -1).trim();
	}
	if (trimmed.length === 0) return true;
	const literal =
		"(?:true|false|null|undefined|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)";
	const trivialRe = new RegExp(`^${literal}(?:\\s*[+\\-*/%]\\s*${literal})*$`);
	return trivialRe.test(trimmed);
}

/**
 * Parent bash verify must run inside the tree that received the merge
 * (session cwd, or optionally the repo root). `/tmp` and other outside paths
 * must not clear the unverified-merge latch. Symlink cwd values are compared
 * after realpath so `/repo/external -> /tmp/project` cannot pass as in-tree.
 */
export function isParentVerifyCwdInMergedTree(
	bashCwd: string | undefined,
	sessionCwd: string,
	repoRoot?: string,
): boolean {
	if (bashCwd === undefined || bashCwd.trim() === "") return true;
	const resolvedBash = realpathOrResolve(bashCwd);
	const roots = [realpathOrResolve(sessionCwd)];
	if (repoRoot !== undefined && repoRoot.trim() !== "") {
		roots.push(realpathOrResolve(repoRoot));
	}
	return roots.some(root => resolvedBash === root || resolvedBash.startsWith(`${root}${path.sep}`));
}

function realpathOrResolve(target: string): string {
	const absolute = path.resolve(target);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		// Path may not exist yet (verify cwd pointing at a to-be-created subdir).
		// Realpath the deepest existing ancestor so /tmp vs /private/tmp matches.
		let dir = path.dirname(absolute);
		const parts: string[] = [path.basename(absolute)];
		for (;;) {
			try {
				return path.join(fs.realpathSync.native(dir), ...parts.reverse());
			} catch {
				const parent = path.dirname(dir);
				if (parent === dir) return absolute;
				parts.push(path.basename(dir));
				dir = parent;
			}
		}
	}
}

/**
 * Pending unverified isolated merges. Each `mark()` adds one; a matching
 * parent verify decrements one. One bash cannot clear two overlapping merges.
 *
 * Generation increments on each `mark()` so a verification tool that started
 * before a merge can finish afterward without clearing a latch it never saw.
 */
export class UnverifiedMergeLatch {
	#pending = 0;
	#generation = 0;

	mark(): void {
		this.#generation++;
		this.#pending++;
	}

	clear(): void {
		this.#pending = 0;
	}

	/** Decrements one pending merge when the verifier started at the current generation. */
	clearIfGeneration(generationAtStart: number): void {
		if (this.#pending === 0) return;
		if (generationAtStart > 0 && generationAtStart === this.#generation) {
			this.#pending--;
		}
	}

	get latched(): boolean {
		return this.#pending > 0;
	}

	get generation(): number {
		return this.#generation;
	}
}
