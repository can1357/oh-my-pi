/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead. A rule refuses a call only when the tool it
 * names can perform the step it matched (see `bash-step.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	dedicatedToolCanPerformStep,
	type FileFacts,
	globArgsForStep,
	type PathKind,
	type StepFilesystem,
} from "./bash-step";
import { extractFlatShellCommandSegments } from "./shell-tokenize";
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../exec/settings";

/** An internal URL (`local://…`), whose filesystem only the embedded shell reaches. */
const URL_PATH = /^[a-z][a-z0-9+.-]*:\/\//iu;
/** Kernel and device trees: reads and writes there reach an interface, not a file. */
const SPECIAL_ROOT = /^\/(?:dev|proc|sys)(?:\/|$)/u;

/**
 * What `target` names, resolved as the shell resolves it: relative to `cwd`, with `..` taken
 * after following symlinks (the path is joined, never normalized). `follow` follows a final
 * symlink (read and grep read through it); otherwise a symlink is `other`, because `sed -i` and
 * a shell write treat it differently from the edit and write tools. A path whose real location
 * is under /dev, /proc or /sys is `other`. `realpathSync.native` resolves `..` physically;
 * the JavaScript one normalizes it first.
 */
function pathKindIn(cwd: string, target: string, follow: boolean): PathKind {
	if (URL_PATH.test(cwd) || URL_PATH.test(target)) return "unknown";
	const joined = joinPhysically(cwd, target);
	try {
		if (!follow && fs.lstatSync(joined).isSymbolicLink()) {
			// Unfollowed, any symlink (a dangling one too) is `other`: the shell writes through it, the tools replace it.
			return "other";
		}
		const stat = fs.statSync(joined);
		if (SPECIAL_ROOT.test(fs.realpathSync.native(joined))) return "other";
		return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
		try {
			// A missing name is created where its directory really is; with no directory there the
			// shell fails, while the write tool would create one.
			const parent = fs.realpathSync.native(path.dirname(joined));
			if (!fs.statSync(parent).isDirectory()) return "unknown";
			return SPECIAL_ROOT.test(parent) ? "other" : "missing";
		} catch {
			return "unknown";
		}
	}
}

/** `target` joined to `cwd` without normalizing, so the kernel resolves `..` after symlinks. */
function joinPhysically(cwd: string, target: string): string {
	return path.isAbsolute(target) ? target : `${cwd}/${target}`;
}

/** Largest file the edit tool's byte-for-byte check reads. */
const PLAIN_TEXT_LIMIT = 4 * 1024 * 1024;

/** A regular file's size and links, and (read on first use) whether it is plain text the edit tool keeps. */
function fileFactsIn(cwd: string, target: string): FileFacts | undefined {
	if (URL_PATH.test(cwd) || URL_PATH.test(target)) return undefined;
	const joined = joinPhysically(cwd, target);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(joined);
	} catch {
		return undefined;
	}
	let plainText: boolean | undefined;
	let maybeBinary: boolean | undefined;
	return {
		size: stat.size,
		links: stat.nlink,
		mode: stat.mode,
		writable: isWritable(joined),
		plainText: () => {
			plainText ??= isPlainText(joined, stat.size);
			return plainText;
		},
		maybeBinary: () => {
			maybeBinary ??= mayHoldNul(joined, stat.size);
			return maybeBinary;
		},
	};
}

/** Whether the current user may write `file`. */
function isWritable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether grep may treat the file as binary: it holds a NUL byte or invalid UTF-8, it cannot be
 * read, or it is over 4 MB (too large to check on each call).
 */
function mayHoldNul(file: string, size: number): boolean {
	if (size > PLAIN_TEXT_LIMIT) return true;
	try {
		const bytes = fs.readFileSync(file);
		if (bytes.includes(0)) return true;
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return false;
	} catch {
		return true;
	}
}

/** Whether the file is at most 4 MB of valid UTF-8 with no byte-order mark and no carriage return. */
function isPlainText(file: string, size: number): boolean {
	if (size > PLAIN_TEXT_LIMIT) return false;
	try {
		const bytes = fs.readFileSync(file);
		if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
		if (bytes.includes(0x0d)) return false;
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/** `filesystem` answering each question once per decision: candidates and rules repeat operands. */
function memoized(filesystem: StepFilesystem): StepFilesystem {
	const kinds = new Map<string, PathKind>();
	const facts = new Map<string, FileFacts | undefined>();
	return {
		kind(target, follow) {
			const key = `${follow ? 1 : 0}\0${target}`;
			let kind = kinds.get(key);
			if (kind === undefined) {
				kind = filesystem.kind(target, follow);
				kinds.set(key, kind);
			}
			return kind;
		},
		facts(target) {
			if (!facts.has(target)) facts.set(target, filesystem.facts(target));
			return facts.get(target);
		},
	};
}

/** A filesystem that cannot be inspected: a later step may run after a `cd` or after files change. */
const UNINSPECTABLE: StepFilesystem = { kind: () => "unknown", facts: () => undefined };

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/** Removes leading `NAME=value` assignments without interpreting shell syntax. */
function withoutLeadingEnvironmentAssignments(command: string): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const assignmentStart = index;
		if (!/[A-Za-z_]/.test(command[index] ?? "")) break;
		let nameEnd = index + 1;
		while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? "")) nameEnd++;
		if (command[nameEnd] !== "=") {
			return foundAssignment ? command.slice(assignmentStart).trimStart() : null;
		}
		const wordEnd = skipShellWord(command, nameEnd + 1);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
		if (index === command.length) return null;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}

/** One text a rule is tested against, and the step (with the rest of its pipeline) that text starts. */
interface Candidate {
	text: string;
	step: string;
	/** The step starts the command, so the command's directory and files are as the caller saw them. */
	leading: boolean;
}

/**
 * Rules naming these tools match only the command's leading step. A read-only step later in a
 * command usually depends on the steps before it (`cd`, a build, an assignment), so its tool
 * cannot replace it without splitting the call; a randomized comparison of the two scopes measured
 * 37% fewer refusals with leading-step matching.
 */
const LEADING_STEP_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

/**
 * The texts rules are tested against: the complete input (kept for rules written against the whole
 * command) and each flat segment, with and without its leading `NAME=value` words. `leadingOnly`
 * keeps only the first segment, or the complete input when the command cannot be split.
 */
function interceptionCandidates(command: string, leadingOnly: boolean): Candidate[] {
	const segments = extractFlatShellCommandSegments(command);
	const candidates: Candidate[] = [];
	if (!leadingOnly || segments.length === 0) candidates.push({ text: command.trim(), step: command, leading: true });
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		// A segment that consumes the previous stage's stdout via `|` reads piped
		// stdin, which no path-based dedicated tool (read/grep/glob) — nor any
		// other dedicated tool — can replace, so it is not an interception
		// candidate. Standalone and first-stage commands still match.
		if (segment.pipedStdin) continue;
		const stages = [segment.text];
		for (let next = i + 1; segments[next]?.pipedStdin; next++) stages.push(segments[next].text);
		const step = stages.join(" | ");
		candidates.push({ text: segment.text, step, leading: i === 0 });
		const withoutAssignments = withoutLeadingEnvironmentAssignments(segment.text);
		if (withoutAssignments) candidates.push({ text: withoutAssignments, step, leading: i === 0 });
		if (leadingOnly) break;
	}
	return candidates;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @param cwd The directory the command runs in (a host path or an internal URL); when given, an
 *   operand or target that is a FIFO, a device, a symlink an edit or write would replace, or that
 *   cannot be inspected is never sent to a tool. A later step's paths cannot be inspected: an
 *   earlier step may change the directory or the files.
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
	originalCommand = command,
	cwd?: string,
): InterceptionResult {
	const filesystem: StepFilesystem | undefined =
		cwd === undefined
			? undefined
			: memoized({
					kind: (target, follow) => pathKindIn(cwd, target, follow),
					facts: target => fileFactsIn(cwd, target),
				});
	const compiled = compileRules(rules);
	const everyStep = interceptionCandidates(command, false);
	const leadingStep = interceptionCandidates(command, true);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		for (const candidate of Object.hasOwn(LEADING_STEP_TOOLS, rule.tool) ? leadingStep : everyStep) {
			// A configured global or sticky regex carries state across calls.
			regex.lastIndex = 0;
			const view = filesystem && (candidate.leading ? filesystem : UNINSPECTABLE);
			if (
				regex.test(candidate.text) &&
				dedicatedToolCanPerformStep(rule.tool, candidate.step, availableTools, view)
			) {
				// A find or fd refusal names the glob call that lists exactly the same entries.
				const globArgs = rule.tool === "glob" ? globArgsForStep(candidate.step, view) : undefined;
				const sameStep = globArgs ? `\n\nThe same listing: glob ${JSON.stringify(globArgs)}` : "";
				return {
					block: true,
					message: `Blocked: ${rule.message}${sameStep}\n\nOriginal command: ${originalCommand}`,
					suggestedTool: rule.tool,
				};
			}
		}
	}

	return { block: false };
}
