/**
 * SDK for programmatic usage of AgentSession.
 *
 * Provides a factory function and discovery helpers that allow full control
 * over agent configuration, or sensible defaults that match CLI behavior.
 *
 * @example
 * ```typescript
 * // Minimal - everything auto-discovered
 * const session = await createAgentSession();
 *
 * // With custom hooks
 * const session = await createAgentSession({
 *   hooks: [
 *     ...await discoverHooks(),
 *     { factory: myHookFactory },
 *   ],
 * });
 *
 * // Full control
 * const session = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => process.env.MY_KEY,
 *   tools: [readTool, bashTool],
 *   hooks: [],
 *   skills: [],
 *   sessionFile: false,
 * });
 * ```
 */

import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
// Import discovery to register all providers on startup
import "../discovery";
import { loadSync as loadCapability } from "../capability/index";
import { type Rule, ruleCapability } from "../capability/rule";
import { getAgentDir, getConfigDirPaths } from "../config";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./custom-commands/index";
import {
	type CustomToolsLoadResult,
	discoverAndLoadCustomTools,
	type LoadedCustomTool,
	wrapCustomTools,
} from "./custom-tools/index";
import type { CustomTool } from "./custom-tools/types";
import { discoverAndLoadHooks, HookRunner, type LoadedHook, wrapToolsWithHooks } from "./hooks/index";
import type { HookFactory } from "./hooks/types";
import { logger } from "./logger";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp/index";
import { convertToLlm } from "./messages";
import { ModelRegistry } from "./model-registry";
import { SessionManager } from "./session-manager";
import { type CommandsSettings, type Settings, SettingsManager, type SkillsSettings } from "./settings-manager";
import { loadSkills as loadSkillsInternal, type Skill } from "./skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./slash-commands";
import {
	buildSystemPrompt as buildSystemPromptInternal,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { time } from "./timings";
import { createToolContextStore } from "./tools/context";
import {
	allTools,
	applyBashInterception,
	bashTool,
	codingTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	editTool,
	findTool,
	grepTool,
	lsTool,
	readOnlyTools,
	readTool,
	type Tool,
	warmupLspServers,
	writeTool,
} from "./tools/index";
import { createTtsrManager } from "./ttsr";

// Types

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'off' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;

	/** System prompt. String replaces default, function receives default and returns final. */
	systemPrompt?: string | ((defaultPrompt: string) => string);

	/** Built-in tools to use. Default: codingTools [read, bash, edit, write] */
	tools?: Tool[];
	/** Custom tools (replaces discovery). */
	customTools?: Array<{ path?: string; tool: CustomTool }>;
	/** Additional custom tool paths to load (merged with discovery). */
	additionalCustomToolPaths?: string[];

	/** Hooks (replaces discovery). */
	hooks?: Array<{ path?: string; factory: HookFactory }>;
	/** Additional hook paths to load (merged with discovery). */
	additionalHookPaths?: string[];

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Slash commands. Default: discovered from cwd/.omp/commands/ + agentDir/commands/ */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;

	/** Tool names explicitly requested (enables disabled-by-default tools) */
	explicitTools?: string[];

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Custom tools result (for UI context setup in interactive mode) */
	customToolsResult: CustomToolsLoadResult;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers that were warmed up at startup */
	lspServers?: Array<{ name: string; status: "ready" | "error"; fileTypes: string[] }>;
}

// Re-exports

export type { CustomCommand, CustomCommandFactory } from "./custom-commands/types";
export type { CustomTool } from "./custom-tools/types";
export type { HookAPI, HookCommandContext, HookContext, HookFactory } from "./hooks/types";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp/index";
export type { Settings, SkillsSettings } from "./settings-manager";
export type { Skill } from "./skills";
export type { FileSlashCommand } from "./slash-commands";
export type { Tool } from "./tools/index";

export {
	// Pre-built tools (use process.cwd())
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
	codingTools,
	readOnlyTools,
	allTools as allBuiltInTools,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): AuthStorage {
	const primaryPath = join(agentDir, "auth.json");
	// Get all auth.json paths (user-level only), excluding the primary
	const allPaths = getConfigDirPaths("auth.json", { project: false });
	const fallbackPaths = allPaths.filter((p) => p !== primaryPath);

	logger.debug("discoverAuthStorage", { agentDir, primaryPath, allPaths, fallbackPaths });

	return new AuthStorage(primaryPath, fallbackPaths);
}

/**
 * Create a ModelRegistry with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export function discoverModels(authStorage: AuthStorage, agentDir: string = getDefaultAgentDir()): ModelRegistry {
	const primaryPath = join(agentDir, "models.json");
	// Get all models.json paths (user-level only), excluding the primary
	const allPaths = getConfigDirPaths("models.json", { project: false });
	const fallbackPaths = allPaths.filter((p) => p !== primaryPath);

	logger.debug("discoverModels", { primaryPath, fallbackPaths });

	return new ModelRegistry(authStorage, primaryPath, fallbackPaths);
}

/**
 * Discover hooks from cwd and agentDir.
 */
export async function discoverHooks(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; factory: HookFactory }>> {
	const resolvedCwd = cwd ?? process.cwd();

	const { hooks, errors } = await discoverAndLoadHooks([], resolvedCwd);

	// Log errors but don't fail
	for (const { path, error } of errors) {
		console.error(`Failed to load hook "${path}": ${error}`);
	}

	return hooks.map((h) => ({
		path: h.path,
		factory: createFactoryFromLoadedHook(h),
	}));
}

/**
 * Discover custom tools from cwd and agentDir.
 */
export async function discoverCustomTools(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; tool: CustomTool }>> {
	const resolvedCwd = cwd ?? process.cwd();

	const { tools, errors } = await discoverAndLoadCustomTools([], resolvedCwd, Object.keys(allTools));

	// Log errors but don't fail
	for (const { path, error } of errors) {
		console.error(`Failed to load custom tool "${path}": ${error}`);
	}

	return tools.map((t) => ({
		path: t.path,
		tool: t.tool,
	}));
}

/**
 * Discover skills from cwd and agentDir.
 */
export function discoverSkills(cwd?: string, _agentDir?: string, settings?: SkillsSettings): Skill[] {
	const { skills } = loadSkillsInternal({
		...settings,
		cwd: cwd ?? process.cwd(),
	});
	return skills;
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Array<{ path: string; content: string; depth?: number }> {
	return loadContextFilesInternal({
		cwd: cwd ?? process.cwd(),
	});
}

/**
 * Discover slash commands from cwd and agentDir.
 */
export function discoverSlashCommands(
	cwd?: string,
	_agentDir?: string,
	_settings?: CommandsSettings,
): FileSlashCommand[] {
	return loadSlashCommandsInternal({
		cwd: cwd ?? process.cwd(),
	});
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? process.cwd();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? process.cwd();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	appendPrompt?: string;
}

/**
 * Build the default system prompt.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	return buildSystemPromptInternal({
		cwd: options.cwd,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
	});
}

// Settings

/**
 * Load settings from agentDir/settings.json merged with cwd/.omp/settings.json.
 */
export function loadSettings(cwd?: string, agentDir?: string): Settings {
	const manager = SettingsManager.create(cwd ?? process.cwd(), agentDir ?? getDefaultAgentDir());
	return {
		modelRoles: manager.getModelRoles(),
		defaultThinkingLevel: manager.getDefaultThinkingLevel(),
		queueMode: manager.getQueueMode(),
		theme: manager.getTheme(),
		compaction: manager.getCompactionSettings(),
		retry: manager.getRetrySettings(),
		hideThinkingBlock: manager.getHideThinkingBlock(),
		shellPath: manager.getShellPath(),
		collapseChangelog: manager.getCollapseChangelog(),
		hooks: manager.getHookPaths(),
		customTools: manager.getCustomToolPaths(),
		skills: manager.getSkillsSettings(),
		terminal: { showImages: manager.getShowImages() },
	};
}

// Internal Helpers

/**
 * Create a HookFactory from a LoadedHook.
 * This allows mixing discovered hooks with inline hooks.
 */
function createFactoryFromLoadedHook(loaded: LoadedHook): HookFactory {
	return (api) => {
		for (const [eventType, handlers] of loaded.handlers) {
			for (const handler of handlers) {
				api.on(eventType as any, handler as any);
			}
		}
	};
}

/**
 * Convert hook definitions to LoadedHooks for the HookRunner.
 */
function createLoadedHooksFromDefinitions(definitions: Array<{ path?: string; factory: HookFactory }>): LoadedHook[] {
	return definitions.map((def) => {
		const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
		const messageRenderers = new Map<string, any>();
		const commands = new Map<string, any>();
		let sendMessageHandler: (message: any, triggerTurn?: boolean) => void = () => {};
		let appendEntryHandler: (customType: string, data?: any) => void = () => {};
		let newSessionHandler: (options?: any) => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false });
		let branchHandler: (entryId: string) => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false });
		let navigateTreeHandler: (targetId: string, options?: any) => Promise<{ cancelled: boolean }> = async () => ({
			cancelled: false,
		});

		const api = {
			on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage: (message: any, triggerTurn?: boolean) => {
				sendMessageHandler(message, triggerTurn);
			},
			appendEntry: (customType: string, data?: any) => {
				appendEntryHandler(customType, data);
			},
			registerMessageRenderer: (customType: string, renderer: any) => {
				messageRenderers.set(customType, renderer);
			},
			registerCommand: (name: string, options: any) => {
				commands.set(name, { name, ...options });
			},
			newSession: (options?: any) => newSessionHandler(options),
			branch: (entryId: string) => branchHandler(entryId),
			navigateTree: (targetId: string, options?: any) => navigateTreeHandler(targetId, options),
		};

		def.factory(api as any);

		return {
			path: def.path ?? "<inline>",
			resolvedPath: def.path ?? "<inline>",
			handlers,
			messageRenderers,
			commands,
			setSendMessageHandler: (handler: (message: any, triggerTurn?: boolean) => void) => {
				sendMessageHandler = handler;
			},
			setAppendEntryHandler: (handler: (customType: string, data?: any) => void) => {
				appendEntryHandler = handler;
			},
			setNewSessionHandler: (handler: (options?: any) => Promise<{ cancelled: boolean }>) => {
				newSessionHandler = handler;
			},
			setBranchHandler: (handler: (entryId: string) => Promise<{ cancelled: boolean }>) => {
				branchHandler = handler;
			},
			setNavigateTreeHandler: (handler: (targetId: string, options?: any) => Promise<{ cancelled: boolean }>) => {
				navigateTreeHandler = handler;
			},
		};
	});
}

// Factory

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => process.env.MY_KEY,
 *   systemPrompt: 'You are helpful.',
 *   tools: [readTool, bashTool],
 *   hooks: [],
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();

	// Use provided or create AuthStorage and ModelRegistry
	const authStorage = options.authStorage ?? discoverAuthStorage(agentDir);
	const modelRegistry = options.modelRegistry ?? discoverModels(authStorage, agentDir);
	time("discoverModels");

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	time("settingsManager");

	// Initialize discovery system with settings for provider persistence
	const { initializeWithSettings } = await import("../discovery");
	initializeWithSettings(settingsManager);
	time("initializeWithSettings");

	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);
	time("sessionManager");

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	time("loadSession");
	const hasExistingSession = existingSession.messages.length > 0;

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	const defaultModelStr = existingSession.models.default;
	if (!model && hasExistingSession && defaultModelStr) {
		const slashIdx = defaultModelStr.indexOf("/");
		if (slashIdx > 0) {
			const provider = defaultModelStr.slice(0, slashIdx);
			const modelId = defaultModelStr.slice(slashIdx + 1);
			const restoredModel = modelRegistry.find(provider, modelId);
			if (restoredModel && (await modelRegistry.getApiKey(restoredModel))) {
				model = restoredModel;
			}
			if (!model) {
				modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
			}
		}
	}

	// If still no model, try settings default
	if (!model) {
		const settingsDefaultModel = settingsManager.getModelRole("default");
		if (settingsDefaultModel) {
			const slashIdx = settingsDefaultModel.indexOf("/");
			if (slashIdx > 0) {
				const provider = settingsDefaultModel.slice(0, slashIdx);
				const modelId = settingsDefaultModel.slice(slashIdx + 1);
				const settingsModel = modelRegistry.find(provider, modelId);
				if (settingsModel && (await modelRegistry.getApiKey(settingsModel))) {
					model = settingsModel;
				}
			}
		}
	}

	// Fall back to first available model with a valid API key
	if (!model) {
		for (const m of modelRegistry.getAll()) {
			if (await modelRegistry.getApiKey(m)) {
				model = m;
				break;
			}
		}
		time("findAvailableModel");
		if (model) {
			if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		} else {
			// No models available - set message so user knows to /login or configure keys
			modelFallbackMessage = "No models available. Use /login or set an API key environment variable.";
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = existingSession.thinkingLevel as ThinkingLevel;
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? "off";
	}

	// Clamp to model capabilities
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	const skills = options.skills ?? discoverSkills(cwd, agentDir, settingsManager.getSkillsSettings());
	time("discoverSkills");

	// Discover TTSR rules
	const ttsrManager = createTtsrManager(settingsManager.getTtsrSettings());
	const rulesResult = loadCapability<Rule>(ruleCapability.id, { cwd });
	for (const rule of rulesResult.items) {
		if (rule.ttsrTrigger) {
			ttsrManager.addRule(rule);
		}
	}
	time("discoverTtsrRules");

	const contextFiles = options.contextFiles ?? discoverContextFiles(cwd, agentDir);
	time("discoverContextFiles");

	// Hook runner - always created (needed for custom command context even without hooks)
	let loadedHooks: LoadedHook[] = [];
	if (options.hooks !== undefined) {
		if (options.hooks.length > 0) {
			loadedHooks = createLoadedHooksFromDefinitions(options.hooks);
		}
	} else {
		// Discover hooks, merging with additional paths
		const configuredPaths = [...settingsManager.getHookPaths(), ...(options.additionalHookPaths ?? [])];
		const { hooks, errors } = await discoverAndLoadHooks(configuredPaths, cwd);
		time("discoverAndLoadHooks");
		for (const { path, error } of errors) {
			console.error(`Failed to load hook "${path}": ${error}`);
		}
		loadedHooks = hooks;
	}
	const hookRunner = new HookRunner(loadedHooks, cwd, sessionManager, modelRegistry);

	const sessionContext = {
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
	};
	const builtInTools =
		options.tools ??
		createCodingTools(cwd, options.hasUI ?? false, sessionContext, {
			lspFormatOnWrite: settingsManager.getLspFormatOnWrite(),
			lspDiagnosticsOnWrite: settingsManager.getLspDiagnosticsOnWrite(),
			lspDiagnosticsOnEdit: settingsManager.getLspDiagnosticsOnEdit(),
			editFuzzyMatch: settingsManager.getEditFuzzyMatch(),
		});
	time("createCodingTools");

	let customToolsResult: CustomToolsLoadResult;
	if (options.customTools !== undefined) {
		// Use provided custom tools
		const loadedTools: LoadedCustomTool[] = options.customTools.map((ct) => ({
			path: ct.path ?? "<inline>",
			resolvedPath: ct.path ?? "<inline>",
			tool: ct.tool,
		}));
		customToolsResult = {
			tools: loadedTools,
			errors: [],
			setUIContext: () => {},
		};
	} else {
		// Discover custom tools, merging with additional paths
		const configuredPaths = [...settingsManager.getCustomToolPaths(), ...(options.additionalCustomToolPaths ?? [])];
		customToolsResult = await discoverAndLoadCustomTools(configuredPaths, cwd, Object.keys(allTools));
		time("discoverAndLoadCustomTools");
		for (const { path, error } of customToolsResult.errors) {
			console.error(`Failed to load custom tool "${path}": ${error}`);
		}
	}

	// Discover MCP tools from .mcp.json files
	let mcpManager: MCPManager | undefined;
	const enableMCP = options.enableMCP ?? true;
	if (enableMCP) {
		const mcpResult = await discoverAndLoadMCPTools(cwd, {
			onConnecting: (serverNames) => {
				if (options.hasUI && serverNames.length > 0) {
					process.stderr.write(`\x1b[90mConnecting to MCP servers: ${serverNames.join(", ")}...\x1b[0m\n`);
				}
			},
			enableProjectConfig: settingsManager.getMCPProjectConfigEnabled(),
			// Always filter Exa - we have native integration
			filterExa: true,
		});
		time("discoverAndLoadMCPTools");
		mcpManager = mcpResult.manager;

		// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
		if (mcpResult.exaApiKeys.length > 0 && !process.env.EXA_API_KEY) {
			process.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
		}

		// Log MCP errors
		for (const { path, error } of mcpResult.errors) {
			console.error(`MCP "${path}": ${error}`);
		}

		// Merge MCP tools into custom tools result
		if (mcpResult.tools.length > 0) {
			customToolsResult = {
				...customToolsResult,
				tools: [...customToolsResult.tools, ...mcpResult.tools],
			};
		}
	}

	// Add specialized Exa web search tools if EXA_API_KEY is available
	const exaSettings = settingsManager.getExaSettings();
	if (exaSettings.enabled && exaSettings.enableSearch) {
		const { getWebSearchTools } = await import("./tools/web-search/index.js");
		const exaWebSearchTools = await getWebSearchTools({
			enableLinkedin: exaSettings.enableLinkedin,
			enableCompany: exaSettings.enableCompany,
		});
		// Filter out the base web_search (already in built-in tools), add specialized Exa tools
		const specializedTools = exaWebSearchTools.filter((t) => t.name !== "web_search");
		if (specializedTools.length > 0) {
			const loadedExaTools: LoadedCustomTool[] = specializedTools.map((tool) => ({
				path: "<exa>",
				resolvedPath: "<exa>",
				tool,
				source: { provider: "builtin", providerName: "builtin", level: "user" },
			}));
			customToolsResult = {
				...customToolsResult,
				tools: [...customToolsResult.tools, ...loadedExaTools],
			};
		}
		time("getWebSearchTools");
	}

	let agent: Agent;
	let session: AgentSession;
	const getSessionContext = () => ({
		sessionManager,
		modelRegistry,
		model: agent.state.model,
		isIdle: () => !session.isStreaming,
		hasQueuedMessages: () => session.queuedMessageCount > 0,
		abort: () => {
			session.abort();
		},
	});
	const toolContextStore = createToolContextStore(getSessionContext);
	const wrappedCustomTools = wrapCustomTools(customToolsResult.tools, getSessionContext);
	const baseSetUIContext = customToolsResult.setUIContext;
	customToolsResult = {
		...customToolsResult,
		setUIContext: (uiContext, hasUI) => {
			toolContextStore.setUIContext(uiContext, hasUI);
			baseSetUIContext(uiContext, hasUI);
		},
	};

	let allToolsArray: Tool[] = [...builtInTools, ...wrappedCustomTools];

	// Filter out hidden tools unless explicitly requested
	if (options.explicitTools) {
		const explicitSet = new Set(options.explicitTools);
		allToolsArray = allToolsArray.filter((tool) => !tool.hidden || explicitSet.has(tool.name));
	} else {
		allToolsArray = allToolsArray.filter((tool) => !tool.hidden);
	}
	time("combineTools");

	// Apply bash interception to redirect common shell patterns to proper tools (if enabled)
	if (settingsManager.getBashInterceptorEnabled()) {
		allToolsArray = applyBashInterception(allToolsArray);
	}
	time("applyBashInterception");

	if (hookRunner) {
		allToolsArray = wrapToolsWithHooks(allToolsArray, hookRunner) as Tool[];
	}

	let systemPrompt: string;
	const defaultPrompt = buildSystemPromptInternal({
		cwd,
		skills,
		contextFiles,
	});
	time("buildSystemPrompt");

	if (options.systemPrompt === undefined) {
		systemPrompt = defaultPrompt;
	} else if (typeof options.systemPrompt === "string") {
		systemPrompt = buildSystemPromptInternal({
			cwd,
			skills,
			contextFiles,
			customPrompt: options.systemPrompt,
		});
	} else {
		systemPrompt = options.systemPrompt(defaultPrompt);
	}

	const commandsSettings = settingsManager.getCommandsSettings();
	const slashCommands = options.slashCommands ?? discoverSlashCommands(cwd, agentDir, commandsSettings);
	time("discoverSlashCommands");

	// Discover custom commands (TypeScript slash commands)
	const customCommandsResult = await loadCustomCommandsInternal({ cwd, agentDir });
	time("discoverCustomCommands");
	for (const { path, error } of customCommandsResult.errors) {
		console.error(`Failed to load custom command "${path}": ${error}`);
	}

	agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel,
			tools: allToolsArray,
		},
		convertToLlm,
		transformContext: hookRunner
			? async (messages) => {
					return hookRunner.emitContext(messages);
				}
			: undefined,
		queueMode: settingsManager.getQueueMode(),
		interruptMode: settingsManager.getInterruptMode(),
		getToolContext: toolContextStore.getContext,
		getApiKey: async () => {
			const currentModel = agent.state.model;
			if (!currentModel) {
				throw new Error("No model selected");
			}
			const key = await modelRegistry.getApiKey(currentModel);
			if (!key) {
				throw new Error(`No API key found for provider "${currentModel.provider}"`);
			}
			return key;
		},
	});
	time("createAgent");

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.replaceMessages(existingSession.messages);
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(`${model.provider}/${model.id}`);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		scopedModels: options.scopedModels,
		fileCommands: slashCommands,
		hookRunner,
		customTools: customToolsResult.tools,
		customCommands: customCommandsResult.commands,
		skillsSettings: settingsManager.getSkillsSettings(),
		modelRegistry,
		ttsrManager,
	});
	time("createAgentSession");

	// Warm up LSP servers (connects to detected servers)
	let lspServers: CreateAgentSessionResult["lspServers"];
	if (settingsManager.getLspDiagnosticsOnWrite()) {
		try {
			const result = await warmupLspServers(cwd);
			lspServers = result.servers;
			time("warmupLspServers");
		} catch {
			// Ignore warmup errors
		}
	}

	return {
		session,
		customToolsResult,
		mcpManager,
		modelFallbackMessage,
		lspServers,
	};
}
