/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead. A rule refuses a call only when the tool it
 * names can perform the step it matched (see `bash-step.ts`).
 */
import { dedicatedToolCanPerformStep } from "./bash-step";
import { extractFlatShellCommandSegments } from "./shell-tokenize";
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../exec/settings";

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
	if (!leadingOnly || segments.length === 0) candidates.push({ text: command.trim(), step: command });
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
		candidates.push({ text: segment.text, step });
		const withoutAssignments = withoutLeadingEnvironmentAssignments(segment.text);
		if (withoutAssignments) candidates.push({ text: withoutAssignments, step });
		if (leadingOnly) break;
	}
	return candidates;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
	originalCommand = command,
): InterceptionResult {
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
			if (regex.test(candidate.text) && dedicatedToolCanPerformStep(rule.tool, candidate.step, availableTools)) {
				return {
					block: true,
					message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
					suggestedTool: rule.tool,
				};
			}
		}
	}

	return { block: false };
}
