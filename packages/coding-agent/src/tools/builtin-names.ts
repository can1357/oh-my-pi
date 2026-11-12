import type { AgentTool } from "@oh-my-pi/pi-agent-core";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"ast_grep",
	"ast_edit",
	"ask",
	"debug",
	"ida",
	"eval",
	"github",
	"glob",
	"grep",
	"find",
	"lsp",
	"checkpoint",
	"rewind",
	"context_notes",
	"new_context",
	"security_scan",
	"task",
	"wait",
	"todo",
	"web_search",
	"write",
	"memory_edit",
	"retain",
	"recall",
	"reflect",
	"learn",
	"manage_skill",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** One-line CLI help summary per built-in tool; keyed by name so a new tool cannot ship without one. */
export const BUILTIN_TOOL_SUMMARIES: Record<BuiltinToolName, string> = {
	read: "Read files, directories, URLs, archives, and databases",
	bash: "Execute shell commands",
	edit: "Edit files in place",
	ast_grep: "Search code with AST patterns",
	ast_edit: "Rewrite code with AST patterns",
	ask: "Ask the user questions (interactive mode only)",
	debug: "Debug a running process over DAP",
	ida: "Open, edit, and script IDA Pro databases",
	eval: "Run Python/JS cells; hosts the browser and computer-use helpers",
	github: "Query and act on GitHub repositories, issues, and PRs",
	glob: "Find files by glob pattern",
	grep: "Search file contents by regex",
	find: "Find code by describing what it does",
	lsp: "Language server queries (code intelligence)",
	checkpoint: "Save a git-based checkpoint of session state",
	rewind: "Rewind to a saved checkpoint",
	context_notes: "Read or replace the session's persistent context notes",
	new_context: "Request a fresh context window after the current turn",
	security_scan: "Run security scans",
	task: "Launch subagents for parallel work",
	wait: "Wait for background jobs",
	todo: "Track a todo list",
	web_search: "Search the web",
	write: "Create or overwrite files",
	memory_edit: "Edit or forget long-term memories",
	retain: "Store facts in long-term memory",
	recall: "Search long-term memory",
	reflect: "Synthesize an answer from long-term memory",
	learn: "Capture reusable lessons in long-term memory",
	manage_skill: "Create, update, or delete managed skills",
};

export const HIDDEN_TOOL_NAMES = ["yield", "goal", "think"] as const;

export type HiddenToolName = (typeof HIDDEN_TOOL_NAMES)[number];

const LEGACY_BUILTIN_TOOL_NAME_ALIASES: ReadonlyMap<string, BuiltinToolName> = new Map([["search", "grep"]]);

const CANONICAL_TOOL_NAMES: Record<string, true> = Object.fromEntries(
	[...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map(name => [name, true]),
);

/** Canonicalize built-in IDs and legacy aliases. Leave plugin names unchanged. */
export function normalizeToolName(name: string): string {
	const lower = name.toLowerCase();
	return LEGACY_BUILTIN_TOOL_NAME_ALIASES.get(lower) ?? (Object.hasOwn(CANONICAL_TOOL_NAMES, lower) ? lower : name);
}

/** Normalize and deduplicate tool names while preserving first-seen order. */
export function normalizeToolNames(names: Iterable<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = normalizeToolName(name);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/** The name the model calls tool `name` by (its custom wire name when it declares one), for prompts that reference it. */
export function toolWireName(registry: ReadonlyMap<string, AgentTool>, name: string): string {
	const tool = registry.get(name);
	return typeof tool?.customWireName === "string" ? tool.customWireName : name;
}

/** MCP tool names carry the `mcp__<server>_<tool>` prefix minted by `createMCPToolName`. */
export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}
