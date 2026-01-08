export { type AskToolDetails, askTool, createAskTool } from "./ask";
export { type BashToolDetails, createBashTool } from "./bash";
export { createCompleteTool } from "./complete";
export { createEditTool } from "./edit";
// Exa MCP tools (22 tools)
export { exaTools } from "./exa/index";
export type { ExaRenderDetails, ExaSearchResponse, ExaSearchResult } from "./exa/types";
export { createFindTool, type FindToolDetails } from "./find";
export { setPreferredImageProvider } from "./gemini-image";
export { createGitTool, type GitToolDetails, gitTool } from "./git";
export { createGrepTool, type GrepToolDetails } from "./grep";
export { createLsTool, type LsToolDetails } from "./ls";
export {
	createLspTool,
	type FileDiagnosticsResult,
	type FileFormatResult,
	getLspStatus,
	type LspServerStatus,
	type LspToolDetails,
	type LspWarmupOptions,
	type LspWarmupResult,
	warmupLspServers,
} from "./lsp/index";
export { createNotebookTool, type NotebookToolDetails } from "./notebook";
export { createOutputTool, type OutputToolDetails } from "./output";
export { createReadTool, type ReadToolDetails } from "./read";
export { reportFindingTool, type SubmitReviewDetails } from "./review";
export { filterRulebookRules, formatRulesForPrompt, type RulebookToolDetails } from "./rulebook";
export { BUNDLED_AGENTS, createTaskTool, taskTool } from "./task/index";
export type { TruncationResult } from "./truncate";
export { createWebFetchTool, type WebFetchToolDetails } from "./web-fetch";
export {
	companyWebSearchTools,
	createWebSearchTool,
	exaWebSearchTools,
	getWebSearchTools,
	hasExaWebSearch,
	linkedinWebSearchTools,
	setPreferredWebSearchProvider,
	type WebSearchProvider,
	type WebSearchResponse,
	type WebSearchToolsOptions,
	webSearchCodeContextTool,
	webSearchCompanyTool,
	webSearchCrawlTool,
	webSearchCustomTool,
	webSearchDeepTool,
	webSearchLinkedinTool,
	webSearchTool,
} from "./web-search/index";
export { createWriteTool, type WriteToolDetails } from "./write";

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Rule } from "../../capability/rule";
import type { EventBus } from "../event-bus";
import type { BashInterceptorRule } from "../settings-manager";
import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import { createCompleteTool } from "./complete";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGitTool } from "./git";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createLspTool } from "./lsp/index";
import { createNotebookTool } from "./notebook";
import { createOutputTool } from "./output";
import { createReadTool } from "./read";
import { reportFindingTool } from "./review";
import { createRulebookTool } from "./rulebook";
import { createTaskTool } from "./task/index";
import { createWebFetchTool } from "./web-fetch";
import { createWebSearchTool } from "./web-search/index";
import { createWriteTool } from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Rulebook rules */
	rulebookRules: Rule[];
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the complete tool by default */
	requireCompleteTool?: boolean;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Settings manager (optional) */
	settings?: {
		getImageAutoResize(): boolean;
		getLspFormatOnWrite(): boolean;
		getLspDiagnosticsOnWrite(): boolean;
		getLspDiagnosticsOnEdit(): boolean;
		getEditFuzzyMatch(): boolean;
		getGitToolEnabled(): boolean;
		getBashInterceptorEnabled(): boolean;
		getBashInterceptorSimpleLsEnabled(): boolean;
		getBashInterceptorRules(): BashInterceptorRule[];
	};
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	ask: createAskTool,
	bash: createBashTool,
	edit: createEditTool,
	find: createFindTool,
	git: createGitTool,
	grep: createGrepTool,
	ls: createLsTool,
	lsp: createLspTool,
	notebook: createNotebookTool,
	output: createOutputTool,
	read: createReadTool,
	rulebook: createRulebookTool,
	task: createTaskTool,
	web_fetch: createWebFetchTool,
	web_search: createWebSearchTool,
	write: createWriteTool,
};

export const HIDDEN_TOOLS: Record<string, ToolFactory> = {
	complete: createCompleteTool,
	report_finding: () => reportFindingTool,
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeComplete = session.requireCompleteTool === true;
	const requestedTools = toolNames && toolNames.length > 0 ? [...new Set(toolNames)] : undefined;
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	if (includeComplete && requestedTools && !requestedTools.includes("complete")) {
		requestedTools.push("complete");
	}

	const entries = requestedTools
		? requestedTools.filter((name) => name in allTools).map((name) => [name, allTools[name]] as const)
		: [
				...Object.entries(BUILTIN_TOOLS),
				...(includeComplete ? ([["complete", HIDDEN_TOOLS.complete]] as const) : []),
			];
	const results = await Promise.all(entries.map(([, factory]) => factory(session)));
	const tools = results.filter((t): t is Tool => t !== null);

	if (requestedTools) {
		const allowed = new Set(requestedTools);
		return tools.filter((tool) => allowed.has(tool.name));
	}

	return tools;
}
