export interface HelpRecommendation {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly whenToUse: string;
	readonly command: string;
	readonly docs: string;
	readonly keywords: readonly string[];
}

export interface RankedHelpRecommendation extends HelpRecommendation {
	readonly score: number;
}

/**
 * Built-in capability guide for questions that are easier to answer with an
 * oh-my-pk affordance than with a generic explanation. Keep this list focused
 * on user-facing capabilities; the linked docs remain the detailed source.
 */
export const BUILTIN_HELP_RECOMMENDATIONS: readonly HelpRecommendation[] = [
	{
		id: "collab",
		title: "Share a live session",
		summary: "Invite someone to watch or drive the current session from another terminal or browser.",
		whenToUse: "Use when you want to pair, hand off a task, or share a read-only progress view.",
		command: "/collab [view]",
		docs: "docs/collab.md",
		keywords: [
			"share",
			"session",
			"teammate",
			"collaborate",
			"collaboration",
			"remote",
			"watch",
			"pair",
			"browser",
			"qr",
			"read-only",
			"collab",
		],
	},
	{
		id: "plan",
		title: "Plan before making changes",
		summary: "Ask the agent to inspect the work and propose a plan before it edits files.",
		whenToUse:
			"Use for unfamiliar repositories, risky refactors, or work where you want to review the approach first.",
		command: "/plan [request]",
		docs: "docs/session-tree-plan.md",
		keywords: [
			"plan",
			"planning",
			"approach",
			"design",
			"refactor",
			"review",
			"before",
			"changes",
			"change",
			"architecture",
		],
	},
	{
		id: "delegate",
		title: "Delegate work to subagents",
		summary: "Split an independent investigation or implementation into isolated background workers.",
		whenToUse:
			"Use when a task has parallel research or coding slices and you want typed results back in the main session.",
		command: "/delegate <task> or /subagent <task>",
		docs: "docs/task-contract-orchestration.md",
		keywords: [
			"delegate",
			"delegation",
			"subagent",
			"agent",
			"parallel",
			"parallelize",
			"worker",
			"background",
			"isolate",
			"fan out",
		],
	},
	{
		id: "agents",
		title: "Manage background agents",
		summary: "Open Agent Hub to inspect, focus, revive, or stop background sessions and subagents.",
		whenToUse: "Use when work is running in the background or you need to switch between multiple agent sessions.",
		command: "/agents or /backgrounds",
		docs: "docs/task-agent-discovery.md",
		keywords: [
			"agent hub",
			"agents",
			"backgrounds",
			"background",
			"worker",
			"subagents",
			"running",
			"switch",
			"revive",
			"stop",
		],
	},
	{
		id: "mcp",
		title: "Connect MCP servers",
		summary: "Add, test, reconnect, and discover tools exposed by Model Context Protocol servers.",
		whenToUse:
			"Use when a service or integration is available as an MCP server and its tools should be visible to the agent.",
		command: "/mcp <add|list|test|...>",
		docs: "docs/mcp-config.md",
		keywords: ["mcp", "server", "integration", "connect", "tools", "protocol", "smithery", "resource", "prompt"],
	},
	{
		id: "marketplace",
		title: "Discover and install plugins",
		summary: "Browse marketplaces and install extensions that add commands, tools, skills, or hooks.",
		whenToUse:
			"Use when the capability you need is packaged as a plugin or you want to browse available integrations.",
		command: "/marketplace discover or /marketplace install <name@marketplace>",
		docs: "docs/marketplace.md",
		keywords: ["marketplace", "plugin", "plugins", "install", "discover", "extension", "integration", "catalog"],
	},
	{
		id: "skills",
		title: "Use or author reusable skills",
		summary: "Load specialized procedures that teach the agent how to handle a recurring kind of work.",
		whenToUse:
			"Use when a task needs a known workflow, domain-specific instructions, or a repeatable team convention.",
		command: "/skill:<name>",
		docs: "docs/skills.md",
		keywords: ["skill", "skills", "workflow", "procedure", "instructions", "reusable", "author", "specialized"],
	},
	{
		id: "lsp",
		title: "Use IDE code intelligence",
		summary:
			"Configure language servers so the agent can use definitions, references, diagnostics, and safe refactors.",
		whenToUse: "Use for symbol navigation, rename refactors, diagnostics, and language-aware edits.",
		command: "Ask for LSP or use the `lsp` tool",
		docs: "docs/lsp-config.md",
		keywords: [
			"lsp",
			"language server",
			"ide",
			"definition",
			"reference",
			"rename",
			"diagnostic",
			"refactor",
			"symbol",
		],
	},
	{
		id: "debug",
		title: "Debug a running program",
		summary:
			"Attach a debugger through the DAP integration to inspect frames, scopes, variables, and execution state.",
		whenToUse: "Use for crashes, hangs, breakpoint-driven investigations, or runtime state that logs cannot explain.",
		command: "Ask to debug or use the `debug` tool",
		docs: "docs/tools/debug.md",
		keywords: ["debug", "debugger", "dap", "breakpoint", "crash", "hang", "stack", "frame", "variables", "runtime"],
	},
	{
		id: "browser",
		title: "Automate a real browser",
		summary: "Navigate pages, inspect tabs, and run browser actions against an existing or launched browser session.",
		whenToUse:
			"Use for UI testing, web workflows, screenshots, and tasks that need a real browser rather than HTTP alone.",
		command: "Ask to use the `browser` tool",
		docs: "docs/tools/browser.md",
		keywords: ["browser", "web", "website", "page", "tab", "ui", "click", "screenshot", "puppeteer", "navigate"],
	},
	{
		id: "web-search",
		title: "Search the web and read sources",
		summary: "Find current information and read web pages or PDFs as structured markdown.",
		whenToUse:
			"Use when the answer depends on current facts, external documentation, research, or a source you have not provided locally.",
		command: "Ask to search the web or use `web_search`",
		docs: "docs/tools/web_search.md",
		keywords: [
			"web",
			"search",
			"internet",
			"current",
			"research",
			"paper",
			"pdf",
			"source",
			"documentation",
			"online",
		],
	},
	{
		id: "file-tools",
		title: "Read, search, and edit files",
		summary:
			"Use the native read, search, edit, write, and glob tools instead of rebuilding filesystem workflows in shell.",
		whenToUse: "Use for repository exploration, targeted changes, file creation, and inspecting project structure.",
		command: "Ask to inspect or edit files; use `read`, `grep`, `glob`, `edit`, or `write`",
		docs: "docs/tools/read.md",
		keywords: [
			"file",
			"files",
			"read",
			"search",
			"grep",
			"glob",
			"edit",
			"write",
			"find",
			"repository",
			"repo",
			"code",
		],
	},
	{
		id: "shell",
		title: "Run shell commands",
		summary: "Run a command in the project environment with persistent sessions for longer-lived processes.",
		whenToUse:
			"Use for builds, tests, package managers, git, and external CLIs that are not covered by a specialized tool.",
		command: "Ask to run a command or use `bash`",
		docs: "docs/tools/bash.md",
		keywords: ["shell", "bash", "command", "terminal", "run", "build", "test", "npm", "bun", "git", "process"],
	},
	{
		id: "eval",
		title: "Compute with persistent kernels",
		summary: "Run JavaScript, Python, and other supported languages while retaining state across evaluation calls.",
		whenToUse:
			"Use for data analysis, experiments, transformations, and multi-step computation that benefits from retained state.",
		command: "Ask to use `eval` or enter `$ <code>`",
		docs: "docs/tools/eval.md",
		keywords: [
			"eval",
			"evaluate",
			"python",
			"javascript",
			"js",
			"data",
			"analysis",
			"compute",
			"kernel",
			"notebook",
			"experiment",
		],
	},
	{
		id: "memory",
		title: "Recall or retain project knowledge",
		summary: "Use memory tools to retrieve relevant past context or save durable facts and conventions.",
		whenToUse:
			"Use when prior decisions, preferences, or project knowledge would make the current answer more accurate or consistent.",
		command: "Ask to recall or retain context",
		docs: "docs/memory.md",
		keywords: ["memory", "recall", "remember", "retain", "past", "history", "preference", "decision", "knowledge"],
	},
	{
		id: "compaction",
		title: "Manage long context",
		summary: "Compact or prune the conversation when tool results and history are consuming the context window.",
		whenToUse: "Use when a session is long, context usage is high, or stale tool output is no longer useful.",
		command: "/compact, /prune, or /shake",
		docs: "docs/compaction.md",
		keywords: ["compact", "compaction", "prune", "shake", "context", "tokens", "long", "window", "stale", "history"],
	},
	{
		id: "approval",
		title: "Control command approval",
		summary: "Choose how shell and other potentially consequential actions are approved before execution.",
		whenToUse: "Use when you need a safer default, a less interruptive workflow, or tighter control over automation.",
		command: "Configure approval mode or run with `--approval-mode`",
		docs: "docs/approval-mode.md",
		keywords: [
			"approval",
			"approve",
			"permission",
			"permissions",
			"safety",
			"safe",
			"automation",
			"confirm",
			"confirmation",
		],
	},
	{
		id: "models",
		title: "Choose or configure models",
		summary: "Select a model for the session and configure providers, roles, thinking, and routing.",
		whenToUse: "Use when you need a different quality, speed, cost, context window, or provider capability.",
		command: "/model, /setup, or `--model`",
		docs: "docs/models.md",
		keywords: [
			"model",
			"models",
			"provider",
			"providers",
			"fast",
			"slow",
			"quality",
			"cost",
			"thinking",
			"routing",
			"login",
		],
	},
	{
		id: "sessions",
		title: "Manage and resume sessions",
		summary: "Start, resume, branch, fork, export, or move conversations without losing the working context.",
		whenToUse:
			"Use when you want to continue earlier work, explore an alternative path, or preserve a session for handoff.",
		command: "/new, /resume, /branch, /fork, or /tree",
		docs: "docs/session.md",
		keywords: [
			"session",
			"sessions",
			"resume",
			"continue",
			"branch",
			"fork",
			"tree",
			"export",
			"move",
			"conversation",
		],
	},
];

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"can",
	"do",
	"for",
	"how",
	"i",
	"in",
	"is",
	"me",
	"my",
	"of",
	"on",
	"or",
	"the",
	"this",
	"to",
	"use",
	"want",
	"what",
	"with",
]);

function tokenize(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
}

function searchableText(recommendation: HelpRecommendation): string {
	return [
		recommendation.title,
		recommendation.summary,
		recommendation.whenToUse,
		recommendation.command,
		recommendation.keywords.join(" "),
	]
		.join(" ")
		.toLowerCase();
}

function rankRecommendation(question: string, recommendation: HelpRecommendation): number {
	const query = question.toLowerCase();
	const tokens = tokenize(question).filter(token => !STOP_WORDS.has(token));
	if (tokens.length === 0) return 0;

	const keywordSet = new Set(recommendation.keywords.map(keyword => keyword.toLowerCase()));
	const titleTokens = new Set(tokenize(recommendation.title));
	const searchable = searchableText(recommendation);
	const searchableTokens = new Set(tokenize(searchable));
	let score = 0;

	for (const token of tokens) {
		if (keywordSet.has(token)) score += 4;
		else if (titleTokens.has(token)) score += 3;
		else if (searchableTokens.has(token)) score += 1;
	}

	if (searchable.includes(query.trim())) score += 5;
	return score;
}

/** Return the strongest built-in feature matches for a natural-language question. */
export function findHelpRecommendations(question: string, limit = 3): RankedHelpRecommendation[] {
	const trimmed = question.trim();
	if (!trimmed || limit <= 0) return [];

	return BUILTIN_HELP_RECOMMENDATIONS.map((recommendation, index) => ({
		...recommendation,
		score: rankRecommendation(trimmed, recommendation),
		index,
	}))
		.filter(recommendation => recommendation.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, limit)
		.map(({ index: _index, ...recommendation }) => recommendation);
}

function renderRecommendation(recommendation: HelpRecommendation, index?: number): string {
	const prefix = index === undefined ? "" : `${index}. `;
	return [
		`${prefix}${recommendation.title}`,
		`   ${recommendation.summary}`,
		`   When to use: ${recommendation.whenToUse}`,
		`   Try: ${recommendation.command}`,
		`   Docs: ${recommendation.docs}`,
	].join("\n");
}

/** Render the user-facing `/help` overview or question-specific recommendations. */
export function renderHelp(question: string): string {
	const trimmed = question.trim();
	if (!trimmed) {
		return [
			"Built-in feature help",
			"",
			"Ask `/help <question>` to find the oh-my-pk feature that fits your task.",
			"Each recommendation includes when to use it, a command or tool to try, and local documentation.",
			"",
			"Common feature recommendations:",
			...BUILTIN_HELP_RECOMMENDATIONS.slice(0, 8).map((recommendation, index) =>
				renderRecommendation(recommendation, index + 1),
			),
		].join("\n\n");
	}

	const matches = findHelpRecommendations(trimmed);
	if (matches.length === 0) {
		return [
			`No close built-in feature match for: ${trimmed}`,
			"",
			"The question will still be sent to the agent if you submit it normally.",
			"Try `/help <question>` with a capability such as sharing, planning, MCP, plugins, browser, files, debugging, or models.",
		].join("\n");
	}

	return [
		`Built-in recommendations for: ${trimmed}`,
		"",
		...matches.map((recommendation, index) => renderRecommendation(recommendation, index + 1)),
	].join("\n\n");
}
