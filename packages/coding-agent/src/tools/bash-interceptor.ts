/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import {
	extractFlatShellCommandSegments,
	tokenizeShellSegments,
	withoutLeadingEnvironmentAssignments,
} from "./shell-tokenize";
import type { Settings } from "../config/settings";
import {
	type BashInterceptorRule,
	cfgBashInterceptorEnabled,
	cfgBashInterceptorPatterns,
	DEFAULT_BASH_INTERCEPTOR_RULES,
} from "../exec/settings";

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
		if (!rule || typeof rule.pattern !== "string" || rule.pattern.length === 0 || typeof rule.message !== "string") {
			continue;
		}
		const flags = typeof rule.flags === "string" ? rule.flags : "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

function interceptionCandidates(command: string): string[] {
	const candidates = [command.trim()];
	for (const segment of extractFlatShellCommandSegments(command)) {
		// A segment that consumes the previous stage's stdout via `|` reads piped
		// stdin, which no path-based dedicated tool (read/grep/glob) — nor any
		// other dedicated tool — can replace, so it is not an interception
		// candidate. Standalone and first-stage commands still match.
		if (segment.pipedStdin) continue;
		candidates.push(segment.text);
		const withoutAssignments = withoutLeadingEnvironmentAssignments(segment.text);
		if (withoutAssignments) candidates.push(withoutAssignments);
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
	const candidates = interceptionCandidates(command);

	for (const { rule, regex } of compiled) {
		// Tool-scoped rules only block when their suggested tool is available.
		// Rules without a `tool` apply unconditionally as custom policy blocks.
		const requiredTool = typeof rule.tool === "string" ? rule.tool.trim() : "";
		if (requiredTool.length > 0 && !availableTools.includes(requiredTool)) {
			continue;
		}

		for (const candidate of candidates) {
			// A configured global or sticky regex carries state across calls.
			regex.lastIndex = 0;
			if (regex.test(candidate)) {
				return {
					block: true,
					message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
					...(requiredTool.length > 0 ? { suggestedTool: requiredTool } : {}),
				};
			}
		}
	}

	return { block: false };
}

/** Whether the first simple command of `command` is a session tool command. */
function startsWithToolCommand(command: string, names: ReadonlySet<string>): boolean {
	const first = tokenizeShellSegments(command)[0]?.[0];
	return first !== undefined && names.has(first);
}

/**
 * The configured interceptor's message for a shell command (bash tool and eval `sh()`), or
 * undefined when it may run. Checks the raw command and the one after a leading `cd … &&`
 * (`command`) so the wrapper hides neither shell-navigation rules nor the dedicated-tool command.
 * A command led by a session tool command is that tool's own call and is never intercepted.
 * `name` set (a bash service) drops rules redirecting to `bash` itself.
 */
export function bashInterception(
	settings: Settings,
	rawCommand: string,
	command: string,
	name: string | undefined,
	toolNames: string[],
	toolCommands: ReadonlySet<string>,
): string | undefined {
	if (!cfgBashInterceptorEnabled.get(settings)) return undefined;
	const rules = cfgBashInterceptorPatterns.get(settings).filter(rule => !name || rule.tool?.trim() !== "bash");
	for (const commandToCheck of rawCommand === command ? [command] : [rawCommand, command]) {
		if (startsWithToolCommand(commandToCheck, toolCommands)) continue;
		const interception = checkBashInterception(commandToCheck, toolNames, rules, rawCommand);
		if (interception.block) return interception.message ?? "Command blocked";
	}
	return undefined;
}
