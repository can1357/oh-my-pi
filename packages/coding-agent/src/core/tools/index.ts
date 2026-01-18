export { type AskToolDetails, askTool, createAskTool } from "./ask";
export { type BashOperations, type BashToolDetails, type BashToolOptions, createBashTool } from "./bash";
export { type CalculatorToolDetails, createCalculatorTool } from "./calculator";
export { createCompleteTool } from "./complete";
export { createEditTool, type EditToolDetails } from "./edit";
// Exa MCP tools (22 tools)
export { exaTools } from "./exa/index";
export type { ExaRenderDetails, ExaSearchResponse, ExaSearchResult } from "./exa/types";
export { createFindTool, type FindOperations, type FindToolDetails, type FindToolOptions } from "./find";
export { setPreferredImageProvider } from "./gemini-image";
export { createGitTool, type GitToolDetails, gitTool } from "./git";
export { createGrepTool, type GrepOperations, type GrepToolDetails, type GrepToolOptions } from "./grep";
export { createLsTool, type LsOperations, type LsToolDetails, type LsToolOptions } from "./ls";
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
export { createPythonTool, type PythonToolDetails } from "./python";
export { createReadTool, type ReadToolDetails } from "./read";
export { reportFindingTool, type SubmitReviewDetails } from "./review";
export { createSshTool, type SSHToolDetails } from "./ssh";
export { BUNDLED_AGENTS, createTaskTool, taskTool } from "./task/index";
export { createTodoWriteTool, type TodoItem, type TodoWriteToolDetails } from "./todo-write";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate";
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
import type { EventBus } from "../event-bus";
import { logger } from "../logger";
import { getPreludeDocs, warmPythonEnvironment } from "../python-executor";
import { checkPythonKernelAvailability } from "../python-kernel";
import type { BashInterceptorRule } from "../settings-manager";
import { createAskTool } from "./ask";
import { createBashTool } from "./bash";
import { createCalculatorTool } from "./calculator";
import { createCompleteTool } from "./complete";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGitTool } from "./git";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createLspTool } from "./lsp/index";
import { createNotebookTool } from "./notebook";
import { createOutputTool } from "./output";
import { createPythonTool } from "./python";
import { createReadTool } from "./read";
import { reportFindingTool } from "./review";
import { createSshTool } from "./ssh";
import { createTaskTool } from "./task/index";
import { createTodoWriteTool } from "./todo-write";
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
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
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
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../model-registry").ModelRegistry;
	/** MCP manager for proxying MCP calls through parent */
	mcpManager?: import("../mcp/manager").MCPManager;
	/** Settings manager for passing to subagents (avoids SQLite access in workers) */
	settingsManager?: { serialize: () => import("../settings-manager").Settings };
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
		getPythonToolMode?(): "ipy-only" | "bash-only" | "both";
		getPythonKernelMode?(): "session" | "per-call";
	};
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	ask: createAskTool,
	bash: createBashTool,
	python: createPythonTool,
	calc: createCalculatorTool,
	ssh: createSshTool,
	edit: createEditTool,
	find: createFindTool,
	git: createGitTool,
	grep: createGrepTool,
	ls: createLsTool,
	lsp: createLspTool,
	notebook: createNotebookTool,
	output: createOutputTool,
	read: createReadTool,
	task: createTaskTool,
	todo_write: createTodoWriteTool,
	web_fetch: createWebFetchTool,
	web_search: createWebSearchTool,
	write: createWriteTool,
};

export const HIDDEN_TOOLS: Record<string, ToolFactory> = {
	complete: createCompleteTool,
	report_finding: () => reportFindingTool,
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

export type PythonToolMode = "ipy-only" | "bash-only" | "both";

/**
 * Parse OMP_PY environment variable to determine Python tool mode.
 * Returns null if not set or invalid.
 *
 * Values:
 * - "0" or "bash" → bash-only
 * - "1" or "py" → ipy-only
 * - "mix" or "both" → both
 */
function getPythonModeFromEnv(): PythonToolMode | null {
	const value = process.env.OMP_PY?.toLowerCase();
	if (!value) return null;

	switch (value) {
		case "0":
		case "bash":
			return "bash-only";
		case "1":
		case "py":
			return "ipy-only";
		case "mix":
		case "both":
			return "both";
		default:
			return null;
	}
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeComplete = session.requireCompleteTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = toolNames && toolNames.length > 0 ? [...new Set(toolNames)] : undefined;
	const pythonMode = getPythonModeFromEnv() ?? session.settings?.getPythonToolMode?.() ?? "ipy-only";
	let pythonAvailable = true;
	const shouldCheckPython =
		pythonMode !== "bash-only" &&
		(requestedTools === undefined || requestedTools.includes("python") || pythonMode === "ipy-only");
	const isTestEnv = process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test";
	if (shouldCheckPython) {
		const availability = await checkPythonKernelAvailability(session.cwd);
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable, falling back to bash", {
				reason: availability.reason,
			});
		} else if (!isTestEnv && getPreludeDocs().length === 0) {
			void warmPythonEnvironment(session.cwd, session.getSessionFile?.() ?? `cwd:${session.cwd}`).catch((err) => {
				logger.warn("Failed to warm Python environment", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	}
	const effectiveMode = pythonAvailable ? pythonMode : "bash-only";
	const allowBash = effectiveMode !== "ipy-only";
	const allowPython = effectiveMode !== "bash-only";
	if (
		requestedTools &&
		allowBash &&
		!allowPython &&
		requestedTools.includes("python") &&
		!requestedTools.includes("bash")
	) {
		requestedTools.push("bash");
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "lsp") return enableLsp;
		if (name === "bash") return allowBash;
		if (name === "python") return allowPython;
		return true;
	};
	if (includeComplete && requestedTools && !requestedTools.includes("complete")) {
		requestedTools.push("complete");
	}

	const filteredRequestedTools = requestedTools?.filter((name) => name in allTools && isToolAllowed(name));

	const entries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map((name) => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name)),
					...(includeComplete ? ([["complete", HIDDEN_TOOLS.complete]] as const) : []),
				];
	const results = await Promise.all(entries.map(([, factory]) => factory(session)));
	const tools = results.filter((t): t is Tool => t !== null);

	if (filteredRequestedTools !== undefined) {
		const allowed = new Set(filteredRequestedTools);
		return tools.filter((tool) => allowed.has(tool.name));
	}

	return tools;
}
