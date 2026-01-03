export { type AskToolDetails, askTool, createAskTool } from "./ask";
export { type BashToolDetails, bashTool, createBashTool } from "./bash";
export { createEditTool, type EditToolOptions, editTool } from "./edit";
// Exa MCP tools (22 tools)
export { exaTools } from "./exa/index";
export type { ExaRenderDetails, ExaSearchResponse, ExaSearchResult } from "./exa/types";
export { createFindTool, type FindToolDetails, findTool } from "./find";
export { createGrepTool, type GrepToolDetails, grepTool } from "./grep";
export { createLsTool, type LsToolDetails, lsTool } from "./ls";
export {
	createLspTool,
	type FileDiagnosticsResult,
	type FileFormatResult,
	formatFile,
	getDiagnosticsForFile,
	getLspStatus,
	type LspServerStatus,
	type LspToolDetails,
	type LspWarmupResult,
	lspTool,
	warmupLspServers,
} from "./lsp/index";
export { createNotebookTool, type NotebookToolDetails, notebookTool } from "./notebook";
export { createOutputTool, type OutputToolDetails, outputTool } from "./output";
export { createReadTool, type ReadToolDetails, readTool } from "./read";
export { createReportFindingTool, createSubmitReviewTool, reportFindingTool, submitReviewTool } from "./review";
export { BUNDLED_AGENTS, createTaskTool, taskTool } from "./task/index";
export type { TruncationResult } from "./truncate";
export { createWebFetchTool, type WebFetchToolDetails, webFetchCustomTool, webFetchTool } from "./web-fetch";
export {
	companyWebSearchTools,
	createWebSearchTool,
	exaWebSearchTools,
	getWebSearchTools,
	hasExaWebSearch,
	linkedinWebSearchTools,
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
export { createWriteTool, type WriteToolDetails, type WriteToolOptions, writeTool } from "./write";

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { askTool, createAskTool } from "./ask";
import { bashTool, createBashTool } from "./bash";
import { checkBashInterception, checkSimpleLsInterception } from "./bash-interceptor";
import { createEditTool, editTool } from "./edit";
import { createFindTool, findTool } from "./find";
import { createGrepTool, grepTool } from "./grep";
import { createLsTool, lsTool } from "./ls";
import { createLspTool, formatFile, getDiagnosticsForFile, lspTool } from "./lsp/index";
import { createNotebookTool, notebookTool } from "./notebook";
import { createOutputTool, outputTool } from "./output";
import { createReadTool, readTool } from "./read";
import { createReportFindingTool, createSubmitReviewTool, reportFindingTool, submitReviewTool } from "./review";
import { createTaskTool, taskTool } from "./task/index";
import { createWebFetchTool, webFetchTool } from "./web-fetch";
import { createWebSearchTool, webSearchTool } from "./web-search/index";
import { createWriteTool, writeTool } from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

/** Context for tools that need session information */
export interface SessionContext {
	getSessionFile: () => string | null;
}

/** Options for creating coding tools */
export interface CodingToolsOptions {
	/** Whether to fetch LSP diagnostics after write tool writes files (default: true) */
	lspDiagnosticsOnWrite?: boolean;
	/** Whether to fetch LSP diagnostics after edit tool edits files (default: false) */
	lspDiagnosticsOnEdit?: boolean;
	/** Whether to format files using LSP after write tool writes (default: true) */
	lspFormatOnWrite?: boolean;
	/** Whether to accept high-confidence fuzzy matches in edit tool (default: true) */
	editFuzzyMatch?: boolean;
}

// Factory function type
type ToolFactory = (cwd: string, sessionContext?: SessionContext, options?: CodingToolsOptions) => Tool;

// Tool definitions: static tools and their factory functions
const toolDefs: Record<string, { tool: Tool; create: ToolFactory }> = {
	ask: { tool: askTool, create: createAskTool },
	read: { tool: readTool, create: createReadTool },
	bash: { tool: bashTool, create: createBashTool },
	edit: {
		tool: editTool,
		create: (cwd, _ctx, options) => {
			const enableDiagnostics = options?.lspDiagnosticsOnEdit ?? false;
			return createEditTool(cwd, {
				fuzzyMatch: options?.editFuzzyMatch ?? true,
				getDiagnostics: enableDiagnostics ? (absolutePath) => getDiagnosticsForFile(absolutePath, cwd) : undefined,
			});
		},
	},
	write: {
		tool: writeTool,
		create: (cwd, _ctx, options) => {
			const enableFormat = options?.lspFormatOnWrite ?? true;
			const enableDiagnostics = options?.lspDiagnosticsOnWrite ?? true;
			return createWriteTool(cwd, {
				formatOnWrite: enableFormat ? (absolutePath) => formatFile(absolutePath, cwd) : undefined,
				getDiagnostics: enableDiagnostics ? (absolutePath) => getDiagnosticsForFile(absolutePath, cwd) : undefined,
			});
		},
	},
	grep: { tool: grepTool, create: createGrepTool },
	find: { tool: findTool, create: createFindTool },
	ls: { tool: lsTool, create: createLsTool },
	lsp: { tool: lspTool, create: createLspTool },
	notebook: { tool: notebookTool, create: createNotebookTool },
	output: { tool: outputTool, create: (cwd, ctx) => createOutputTool(cwd, ctx) },
	task: { tool: taskTool, create: (cwd, ctx) => createTaskTool(cwd, ctx) },
	web_fetch: { tool: webFetchTool, create: createWebFetchTool },
	web_search: { tool: webSearchTool, create: createWebSearchTool },
	report_finding: { tool: reportFindingTool, create: createReportFindingTool },
	submit_review: { tool: submitReviewTool, create: createSubmitReviewTool },
};

export type ToolName = keyof typeof toolDefs;

// Tools that require UI (excluded when hasUI is false)
const uiToolNames: ToolName[] = ["ask"];

// Tool sets defined by name (base sets, without UI-only tools)
const baseCodingToolNames: ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"lsp",
	"notebook",
	"output",
	"task",
	"web_fetch",
	"web_search",
];
const baseReadOnlyToolNames: ToolName[] = ["read", "grep", "find", "ls"];

// Default tools for full access mode (using process.cwd(), no UI)
export const codingTools: Tool[] = baseCodingToolNames.map((name) => toolDefs[name].tool);

// Read-only tools for exploration without modification (using process.cwd(), no UI)
export const readOnlyTools: Tool[] = baseReadOnlyToolNames.map((name) => toolDefs[name].tool);

// All available tools (using process.cwd(), no UI)
export const allTools = Object.fromEntries(Object.entries(toolDefs).map(([name, def]) => [name, def.tool])) as Record<
	ToolName,
	Tool
>;

/**
 * Create coding tools configured for a specific working directory.
 * @param cwd - Working directory for tools
 * @param hasUI - Whether UI is available (includes ask tool if true)
 * @param sessionContext - Optional session context for tools that need it
 * @param options - Options for tool configuration
 */
export function createCodingTools(
	cwd: string,
	hasUI = false,
	sessionContext?: SessionContext,
	options?: CodingToolsOptions,
): Tool[] {
	const names = hasUI ? [...baseCodingToolNames, ...uiToolNames] : baseCodingToolNames;
	return names.map((name) => toolDefs[name].create(cwd, sessionContext, options));
}

/**
 * Create read-only tools configured for a specific working directory.
 * @param cwd - Working directory for tools
 * @param hasUI - Whether UI is available (includes ask tool if true)
 * @param sessionContext - Optional session context for tools that need it
 * @param options - Options for tool configuration
 */
export function createReadOnlyTools(
	cwd: string,
	hasUI = false,
	sessionContext?: SessionContext,
	options?: CodingToolsOptions,
): Tool[] {
	const names = hasUI ? [...baseReadOnlyToolNames, ...uiToolNames] : baseReadOnlyToolNames;
	return names.map((name) => toolDefs[name].create(cwd, sessionContext, options));
}

/**
 * Create all tools configured for a specific working directory.
 * @param cwd - Working directory for tools
 * @param sessionContext - Optional session context for tools that need it
 * @param options - Options for tool configuration
 */
export function createAllTools(
	cwd: string,
	sessionContext?: SessionContext,
	options?: CodingToolsOptions,
): Record<ToolName, Tool> {
	return Object.fromEntries(
		Object.entries(toolDefs).map(([name, def]) => [name, def.create(cwd, sessionContext, options)]),
	) as Record<ToolName, Tool>;
}

/**
 * Wrap a bash tool with interception that redirects common patterns to specialized tools.
 * This helps prevent LLMs from falling back to shell commands when better tools exist.
 *
 * @param bashTool - The bash tool to wrap
 * @param availableTools - Set of tool names that are available (for context-aware blocking)
 * @returns Wrapped bash tool with interception
 */
export function wrapBashWithInterception(bashTool: Tool, availableTools: Set<string>): Tool {
	const originalExecute = bashTool.execute;

	return {
		...bashTool,
		execute: async (toolCallId, params, signal, onUpdate, context) => {
			const command = (params as { command: string }).command;

			// Check for forbidden patterns
			const interception = checkBashInterception(command, availableTools);
			if (interception.block) {
				throw new Error(interception.message);
			}

			// Check for simple ls that should use ls tool
			const lsInterception = checkSimpleLsInterception(command, availableTools);
			if (lsInterception.block) {
				throw new Error(lsInterception.message);
			}

			// Pass through to original bash tool
			return originalExecute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

/**
 * Apply bash interception to a set of tools.
 * Finds the bash tool and wraps it with interception based on other available tools.
 *
 * @param tools - Array of tools to process
 * @returns Tools with bash interception applied
 */
export function applyBashInterception(tools: Tool[]): Tool[] {
	const toolNames = new Set(tools.map((t) => t.name));

	// If bash isn't in the tools, nothing to do
	if (!toolNames.has("bash")) {
		return tools;
	}

	return tools.map((tool) => {
		if (tool.name === "bash") {
			return wrapBashWithInterception(tool, toolNames);
		}
		return tool;
	});
}
