/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

/**
 * Patterns that should NEVER use bash when specialized tools exist.
 * Each pattern maps to a helpful error message.
 */
const forbiddenPatterns: Array<{
	pattern: RegExp;
	tool: string;
	message: string;
}> = [
	// File reading
	{
		pattern: /^\s*(cat|head|tail|less|more)\s+/,
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	// Content search (grep variants)
	{
		pattern: /^\s*(grep|rg|ripgrep|ag|ack)\s+/,
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	// File finding
	{
		pattern: /^\s*(find|fd|locate)\s+.*(-name|-iname|-type|--type|-glob)/,
		tool: "find",
		message: "Use the `find` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	// In-place file editing
	{
		pattern: /^\s*sed\s+(-i|--in-place)/,
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: /^\s*perl\s+.*-[pn]?i/,
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: /^\s*awk\s+.*-i\s+inplace/,
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	// File creation via redirection (but allow legitimate uses like piping)
	{
		pattern: /^\s*(echo|printf|cat\s*<<)\s+.*[^|]>\s*\S/,
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(command: string, availableTools: Set<string>): InterceptionResult {
	// Normalize command for pattern matching
	const normalizedCommand = command.trim();

	for (const { pattern, tool, message } of forbiddenPatterns) {
		// Only block if the suggested tool is actually available
		if (!availableTools.has(tool)) {
			continue;
		}

		if (pattern.test(normalizedCommand)) {
			return {
				block: true,
				message: `❌ Blocked: ${message}\n\nOriginal command: ${command}`,
				suggestedTool: tool,
			};
		}
	}

	return { block: false };
}

/**
 * Check if a command is a simple directory listing that should use `ls` tool.
 * Only applies to bare `ls` without complex flags.
 */
export function checkSimpleLsInterception(command: string, availableTools: Set<string>): InterceptionResult {
	if (!availableTools.has("ls")) {
		return { block: false };
	}

	// Match simple ls commands (ls, ls -la, ls /path, etc.)
	// Don't intercept complex pipes or commands
	const simpleLsPattern = /^\s*ls(\s+(-[a-zA-Z]+\s*)*)?(\s+[^|;&]+)?\s*$/;

	if (simpleLsPattern.test(command.trim())) {
		return {
			block: true,
			message: `Use the \`ls\` tool instead of bash ls. It provides structured output.\n\nOriginal command: ${command}`,
			suggestedTool: "ls",
		};
	}

	return { block: false };
}
