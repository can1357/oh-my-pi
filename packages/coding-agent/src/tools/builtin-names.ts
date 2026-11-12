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

/**
 * CLI help entry for a built-in: its summary and whether default settings activate it. A
 * `detected` tool needs no setting change but appears only when `detectedWhen` holds.
 */
export type BuiltinToolHelp =
	| { summary: string; defaultState: "on" | "off" }
	| { summary: string; defaultState: "detected"; detectedWhen: string };

/**
 * Keyed by name so a new tool cannot ship without help; `test/tools/builtin-defaults.test.ts` checks
 * `defaultState`. Entry order is CLI help order: most-used tools first, specialized ones last.
 */
export const BUILTIN_TOOL_HELP: Record<BuiltinToolName, BuiltinToolHelp> = {
	read: { summary: "Read files, directories, URLs, archives, and databases", defaultState: "on" },
	edit: { summary: "Edit files in place", defaultState: "on" },
	write: { summary: "Create or overwrite files", defaultState: "on" },
	bash: { summary: "Execute shell commands", defaultState: "on" },
	grep: { summary: "Search file contents by regex", defaultState: "on" },
	glob: { summary: "Find files by glob pattern", defaultState: "on" },
	find: {
		summary: "Find code by describing what it does",
		defaultState: "detected",
		detectedWhen: "a native judge model is available",
	},
	eval: { summary: "Run Python/JS cells; hosts the browser and computer-use helpers", defaultState: "on" },
	task: { summary: "Launch subagents for parallel work", defaultState: "on" },
	wait: { summary: "Wait for background jobs", defaultState: "on" },
	todo: { summary: "Track a todo list", defaultState: "on" },
	ask: { summary: "Ask the user questions (interactive mode only)", defaultState: "on" },
	web_search: { summary: "Search the web", defaultState: "on" },
	lsp: { summary: "Language server queries (code intelligence)", defaultState: "on" },
	ast_edit: { summary: "Rewrite code with AST patterns", defaultState: "on" },
	debug: { summary: "Debug a running process over DAP", defaultState: "on" },
	ida: {
		summary: "Open, edit, and script IDA Pro databases",
		defaultState: "detected",
		detectedWhen: "IDA Pro is installed",
	},
	ast_grep: { summary: "Search code with AST patterns", defaultState: "off" },
	github: { summary: "Query and act on GitHub repositories, issues, and PRs", defaultState: "off" },
	checkpoint: { summary: "Save a git-based checkpoint of session state", defaultState: "off" },
	rewind: { summary: "Rewind to a saved checkpoint", defaultState: "off" },
	context_notes: { summary: "Read or replace the session's persistent context notes", defaultState: "off" },
	new_context: { summary: "Request a fresh context window after the current turn", defaultState: "off" },
	retain: { summary: "Store facts in long-term memory", defaultState: "off" },
	recall: { summary: "Search long-term memory", defaultState: "off" },
	reflect: { summary: "Synthesize an answer from long-term memory", defaultState: "off" },
	memory_edit: { summary: "Edit or forget long-term memories", defaultState: "off" },
	learn: { summary: "Capture reusable lessons in long-term memory", defaultState: "off" },
	manage_skill: { summary: "Create, update, or delete managed skills", defaultState: "off" },
	security_scan: { summary: "Run security scans", defaultState: "off" },
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
