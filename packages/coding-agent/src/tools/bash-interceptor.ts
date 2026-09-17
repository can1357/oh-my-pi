/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";

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
	fusionIoDelegation = false,
): InterceptionResult {
	// Normalize command for pattern matching
	const normalizedCommand = command.trim();
	// Convenience routing, not a shell sandbox: autonomous arbitrary execution is separately denied.
	if (
		fusionIoDelegation &&
		/(?:^|[;&|\n])\s*(?:&\s*)?(?:["'](?:[^"'\r\n]*[\\/])?(?:cat|head|tail|less|more|type|get-content)(?:\.exe)?["']|(?:[^\s"';&|]*[\\/])?(?:cat|head|tail|less|more|type|get-content)(?:\.exe)?)(?=\s|$|[;&|])/i.test(
			normalizedCommand,
		)
	) {
		return {
			block: true,
			suggestedTool: "read",
			message:
				"[Fusion I/O] Use native read for file contents or grep for matching lines; bulk reads require an evidenceDigest task or a bounded range.",
		};
	}
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		if (regex.test(normalizedCommand)) {
			return {
				block: true,
				message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
				suggestedTool: rule.tool,
			};
		}
	}

	return { block: false };
}
