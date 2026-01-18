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
 * // With custom extensions
 * const session = await createAgentSession({
 *   extensions: [myExtensionFactory],
 * });
 *
 * // Full control
 * const session = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => process.env.MY_KEY,
 *   toolNames: ["read", "bash", "edit", "write"], // Filter tools
 *   extensions: [],
 *   skills: [],
 *   sessionFile: false,
 * });
 * ```
 */

import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Message, type Model, supportsXhigh } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import chalk from "chalk";
// Import discovery to register all providers on startup
import "../discovery";
import { loadCapability } from "../capability/index";
import { type Rule, ruleCapability } from "../capability/rule";
import { getAgentDir, getConfigDirPaths } from "../config";
import { initializeWithSettings } from "../discovery";
import { registerAsyncCleanup } from "../modes/cleanup";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { createCursorExecHandlers } from "./cursor/exec-bridge";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./custom-commands/index";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./custom-tools/types";
import { createEventBus, type EventBus } from "./event-bus";
import {
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
	wrapToolWithExtensions,
} from "./extensions/index";
import { logger } from "./logger";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp/index";
import { convertToLlm } from "./messages";
import { ModelRegistry } from "./model-registry";
import { formatModelString, parseModelString } from "./model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./prompt-templates";
import { disposeAllKernelSessions } from "./python-executor";
import { SessionManager } from "./session-manager";
import { type Settings, SettingsManager, type SkillsSettings } from "./settings-manager";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./slash-commands";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import { migrateJsonStorage } from "./storage-migration";
import {
	buildSystemPrompt as buildSystemPromptInternal,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { time } from "./timings";
import { createToolContextStore } from "./tools/context";
import { getGeminiImageTools } from "./tools/gemini-image";
import {
	BUILTIN_TOOLS,
	createBashTool,
	createEditTool,
	createFindTool,
	createGitTool,
	createGrepTool,
	createLsTool,
	createPythonTool,
	createReadTool,
	createSshTool,
	createTools,
	createWriteTool,
	getWebSearchTools,
	setPreferredImageProvider,
	setPreferredWebSearchProvider,
	type Tool,
	type ToolSession,
	warmupLspServers,
} from "./tools/index";
import { createTtsrManager } from "./ttsr";

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

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

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;

	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the complete tool by default */
	requireCompleteTool?: boolean;

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
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers that were warmed up at startup */
	lspServers?: Array<{ name: string; status: "ready" | "error"; fileTypes: string[] }>;
}

// Re-exports

export type { CustomCommand, CustomCommandFactory } from "./custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./custom-tools/types";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "./extensions/index";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp/index";
export type { PromptTemplate } from "./prompt-templates";
export type { Settings, SkillsSettings } from "./settings-manager";
export type { Skill } from "./skills";
export type { FileSlashCommand } from "./slash-commands";
export type { Tool } from "./tools/index";

export {
	// Tool factories
	BUILTIN_TOOLS,
	createTools,
	type ToolSession,
	// Individual tool factories (for custom usage)
	createReadTool,
	createBashTool,
	createPythonTool,
	createSshTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createGitTool,
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
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const primaryPath = join(agentDir, "auth.json");
	// Get all auth.json paths (user-level only), excluding the primary
	const allPaths = getConfigDirPaths("auth.json", { project: false });
	const fallbackPaths = allPaths.filter((p) => p !== primaryPath);

	logger.debug("discoverAuthStorage", { agentDir, primaryPath, allPaths, fallbackPaths });

	// Migrate legacy JSON files (settings.json, auth.json) to SQLite before loading
	await migrateJsonStorage({
		agentDir,
		settingsPath: join(agentDir, "settings.json"),
		authPaths: [primaryPath, ...fallbackPaths],
	});

	const storage = new AuthStorage(primaryPath, fallbackPaths);
	await storage.reload();
	return storage;
}

/**
 * Create a ModelRegistry with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export async function discoverModels(
	authStorage: AuthStorage,
	agentDir: string = getDefaultAgentDir(),
): Promise<ModelRegistry> {
	const primaryPath = join(agentDir, "models.json");
	// Get all models.json paths (user-level only), excluding the primary
	const allPaths = getConfigDirPaths("models.json", { project: false });
	const fallbackPaths = allPaths.filter((p) => p !== primaryPath);

	logger.debug("discoverModels", { primaryPath, fallbackPaths });

	const registry = new ModelRegistry(authStorage, primaryPath, fallbackPaths);
	await registry.refresh();
	return registry;
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? process.cwd();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? process.cwd(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? process.cwd(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? process.cwd(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? process.cwd() });
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
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
	return await buildSystemPromptInternal({
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
export async function loadSettings(cwd?: string, agentDir?: string): Promise<Settings> {
	const manager = await SettingsManager.create(cwd ?? process.cwd(), agentDir ?? getDefaultAgentDir());
	return {
		modelRoles: manager.getModelRoles(),
		defaultThinkingLevel: manager.getDefaultThinkingLevel(),
		steeringMode: manager.getSteeringMode(),
		followUpMode: manager.getFollowUpMode(),
		interruptMode: manager.getInterruptMode(),
		theme: manager.getTheme(),
		compaction: manager.getCompactionSettings(),
		retry: manager.getRetrySettings(),
		hideThinkingBlock: manager.getHideThinkingBlock(),
		shellPath: manager.getShellPath(),
		collapseChangelog: manager.getCollapseChangelog(),
		extensions: manager.getExtensionPaths(),
		skills: manager.getSkillsSettings(),
		terminal: { showImages: manager.getShowImages() },
		images: { autoResize: manager.getImageAutoResize(), blockImages: manager.getBlockImages() },
	};
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	registerAsyncCleanup(() => cleanupSshResources());
}

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	registerAsyncCleanup(async () => {
		await disposeAllKernelSessions();
	});
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (toolCallId, params, onUpdate, ctx, signal) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return (api) => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
	};
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
 *   tools: codingTools({ cwd: process.cwd() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? createEventBus();

	registerSshCleanup();
	registerPythonCleanup();

	// Use provided or create AuthStorage and ModelRegistry
	const authStorage = options.authStorage ?? (await discoverAuthStorage(agentDir));
	const modelRegistry = options.modelRegistry ?? (await discoverModels(authStorage, agentDir));
	time("discoverModels");

	const settingsManager = options.settingsManager ?? (await SettingsManager.create(cwd, agentDir));
	time("settingsManager");
	initializeWithSettings(settingsManager);
	time("initializeWithSettings");

	// Initialize provider preferences from settings
	setPreferredWebSearchProvider(settingsManager.getWebSearchProvider());
	setPreferredImageProvider(settingsManager.getImageProvider());

	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);
	time("sessionManager");
	const sessionId = sessionManager.getSessionId();

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	time("loadSession");
	const hasExistingSession = existingSession.messages.length > 0;

	const hasExplicitModel = options.model !== undefined;
	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	const defaultModelStr = existingSession.models.default;
	if (!model && hasExistingSession && defaultModelStr) {
		const parsedModel = parseModelString(defaultModelStr);
		if (parsedModel) {
			const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
			if (restoredModel && (await modelRegistry.getApiKey(restoredModel, sessionId))) {
				model = restoredModel;
			}
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
		}
	}

	// If still no model, try settings default
	if (!model) {
		const settingsDefaultModel = settingsManager.getModelRole("default");
		if (settingsDefaultModel) {
			const parsedModel = parseModelString(settingsDefaultModel);
			if (parsedModel) {
				const settingsModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (settingsModel && (await modelRegistry.getApiKey(settingsModel, sessionId))) {
					model = settingsModel;
				}
			}
		}
	}

	// Fall back to first available model with a valid API key
	if (!model) {
		const allModels = modelRegistry.getAll();
		const keyResults = await Promise.all(
			allModels.map(async (m) => ({ model: m, hasKey: !!(await modelRegistry.getApiKey(m, sessionId)) })),
		);
		model = keyResults.find((r) => r.hasKey)?.model;
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
	} else if (thinkingLevel === "xhigh" && !supportsXhigh(model)) {
		thinkingLevel = "high";
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await discoverSkills(cwd, agentDir, settingsManager.getSkillsSettings());
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}
	time("discoverSkills");

	// Discover rules
	const ttsrManager = createTtsrManager(settingsManager.getTtsrSettings());
	const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd });
	for (const rule of rulesResult.items) {
		if (rule.ttsrTrigger) {
			ttsrManager.addRule(rule);
		}
	}
	time("discoverTtsrRules");

	// Filter rules for the rulebook (non-TTSR, non-alwaysApply, with descriptions)
	const rulebookRules = rulesResult.items.filter((rule: Rule) => {
		if (rule.ttsrTrigger) return false;
		if (rule.alwaysApply) return false;
		if (!rule.description) return false;
		return true;
	});
	time("filterRulebookRules");

	const contextFiles = options.contextFiles ?? (await discoverContextFiles(cwd, agentDir));
	time("discoverContextFiles");

	let agent: Agent;
	let session: AgentSession;

	const enableLsp = options.enableLsp ?? true;

	const toolSession: ToolSession = {
		cwd,
		hasUI: options.hasUI ?? false,
		enableLsp,
		eventBus,
		outputSchema: options.outputSchema,
		requireCompleteTool: options.requireCompleteTool,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => options.spawns ?? "*",
		getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
		getActiveModelString: () => {
			const activeModel = agent?.state.model;
			return activeModel ? formatModelString(activeModel) : undefined;
		},
		settings: settingsManager,
		settingsManager,
		authStorage,
		modelRegistry,
	};

	const builtinTools = await createTools(toolSession, options.toolNames);
	time("createAllTools");

	// Discover MCP tools from .mcp.json files
	let mcpManager: MCPManager | undefined;
	const enableMCP = options.enableMCP ?? true;
	const customTools: CustomTool[] = [];
	if (enableMCP) {
		const mcpResult = await discoverAndLoadMCPTools(cwd, {
			onConnecting: (serverNames) => {
				if (options.hasUI && serverNames.length > 0) {
					process.stderr.write(
						chalk.gray(`Connecting to MCP servers: ${serverNames.join(", ")}...
`),
					);
				}
			},
			enableProjectConfig: settingsManager.getMCPProjectConfigEnabled(),
			// Always filter Exa - we have native integration
			filterExa: true,
		});
		time("discoverAndLoadMCPTools");
		mcpManager = mcpResult.manager;
		toolSession.mcpManager = mcpManager;

		// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
		if (mcpResult.exaApiKeys.length > 0 && !process.env.EXA_API_KEY) {
			process.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
		}

		// Log MCP errors
		for (const { path, error } of mcpResult.errors) {
			logger.error("MCP tool load failed", { path, error });
		}

		if (mcpResult.tools.length > 0) {
			// MCP tools are LoadedCustomTool, extract the tool property
			customTools.push(...mcpResult.tools.map((loaded) => loaded.tool));
		}
	}

	// Add Gemini image tools if GEMINI_API_KEY (or GOOGLE_API_KEY) is available
	const geminiImageTools = await getGeminiImageTools();
	if (geminiImageTools.length > 0) {
		customTools.push(...(geminiImageTools as unknown as CustomTool[]));
	}
	time("getGeminiImageTools");

	// Add specialized Exa web search tools if EXA_API_KEY is available
	const exaSettings = settingsManager.getExaSettings();
	if (exaSettings.enabled && exaSettings.enableSearch) {
		const exaWebSearchTools = await getWebSearchTools({
			enableLinkedin: exaSettings.enableLinkedin,
			enableCompany: exaSettings.enableCompany,
		});
		// Filter out the base web_search (already in built-in tools), add specialized Exa tools
		const specializedTools = exaWebSearchTools.filter((t) => t.name !== "web_search");
		if (specializedTools.length > 0) {
			customTools.push(...specializedTools);
		}
		time("getWebSearchTools");
	}

	const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
	if (customTools.length > 0) {
		inlineExtensions.push(createCustomToolsExtension(customTools));
	}

	// Load extensions (discovers from standard locations + configured paths)
	let extensionsResult: LoadExtensionsResult;
	if (options.disableExtensionDiscovery) {
		const configuredPaths = options.additionalExtensionPaths ?? [];
		extensionsResult = await loadExtensions(configuredPaths, cwd, eventBus);
		time("loadExtensions");
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	} else if (options.preloadedExtensions) {
		extensionsResult = options.preloadedExtensions;
	} else {
		// Merge CLI extension paths with settings extension paths
		const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...settingsManager.getExtensionPaths()];
		extensionsResult = await discoverAndLoadExtensions(
			configuredPaths,
			cwd,
			eventBus,
			settingsManager.getDisabledExtensions(),
		);
		time("discoverAndLoadExtensions");
		for (const { path, error } of extensionsResult.errors) {
			logger.error("Failed to load extension", { path, error });
		}
	}

	// Load inline extensions from factories
	if (inlineExtensions.length > 0) {
		for (let i = 0; i < inlineExtensions.length; i++) {
			const factory = inlineExtensions[i];
			const loaded = await loadExtensionFromFactory(
				factory,
				cwd,
				eventBus,
				extensionsResult.runtime,
				`<inline-${i}>`,
			);
			extensionsResult.extensions.push(loaded);
		}
	}

	// Discover custom commands (TypeScript slash commands)
	const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
		? { commands: [], errors: [] }
		: await loadCustomCommandsInternal({ cwd, agentDir });
	if (!options.disableExtensionDiscovery) {
		time("discoverCustomCommands");
		for (const { path, error } of customCommandsResult.errors) {
			logger.error("Failed to load custom command", { path, error });
		}
	}

	let extensionRunner: ExtensionRunner | undefined;
	if (extensionsResult.extensions.length > 0) {
		extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
		);
	}

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

	const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
	const allCustomTools = [
		...registeredTools,
		...(options.customTools?.map((tool) => {
			const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
			return { definition, extensionPath: "<sdk>" };
		}) ?? []),
	];
	const wrappedExtensionTools = extensionRunner ? wrapRegisteredTools(allCustomTools, extensionRunner) : [];

	// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
	const toolRegistry = new Map<string, AgentTool>();
	for (const tool of builtinTools) {
		toolRegistry.set(tool.name, tool as AgentTool);
	}
	for (const tool of wrappedExtensionTools) {
		toolRegistry.set(tool.name, tool);
	}
	if (extensionRunner) {
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, wrapToolWithExtensions(tool, extensionRunner));
		}
	}
	if (model?.provider === "cursor") {
		toolRegistry.delete("edit");
	}
	time("combineTools");

	let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
	const cursorExecHandlers = createCursorExecHandlers({
		cwd,
		tools: toolRegistry,
		getToolContext: toolContextStore.getContext,
		emitEvent: (event) => cursorEventEmitter?.(event),
	});

	const rebuildSystemPrompt = async (toolNames: string[], tools: Map<string, AgentTool>): Promise<string> => {
		toolContextStore.setToolNames(toolNames);
		const defaultPrompt = await buildSystemPromptInternal({
			cwd,
			skills,
			contextFiles,
			tools,
			toolNames,
			rules: rulebookRules,
			skillsSettings: settingsManager.getSkillsSettings(),
		});

		if (options.systemPrompt === undefined) {
			return defaultPrompt;
		}
		if (typeof options.systemPrompt === "string") {
			return await buildSystemPromptInternal({
				cwd,
				skills,
				contextFiles,
				tools,
				toolNames,
				rules: rulebookRules,
				skillsSettings: settingsManager.getSkillsSettings(),
				customPrompt: options.systemPrompt,
			});
		}
		return options.systemPrompt(defaultPrompt);
	};

	const systemPrompt = await rebuildSystemPrompt(Array.from(toolRegistry.keys()), toolRegistry);
	time("buildSystemPrompt");

	const promptTemplates = options.promptTemplates ?? (await discoverPromptTemplates(cwd, agentDir));
	time("discoverPromptTemplates");

	const slashCommands = options.slashCommands ?? (await discoverSlashCommands(cwd));
	time("discoverSlashCommands");

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
		toolContextStore.setUIContext(uiContext, hasUI);
	};

	agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel,
			tools: Array.from(toolRegistry.values()),
		},
		convertToLlm: convertToLlmWithBlockImages,
		sessionId: sessionManager.getSessionId(),
		transformContext: extensionRunner
			? async (messages) => {
					return extensionRunner.emitContext(messages);
				}
			: undefined,
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		interruptMode: settingsManager.getInterruptMode(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		getToolContext: toolContextStore.getContext,
		getApiKey: async () => {
			const currentModel = agent.state.model;
			if (!currentModel) {
				throw new Error("No model selected");
			}
			const key = await modelRegistry.getApiKey(currentModel, sessionId);
			if (!key) {
				throw new Error(`No API key found for provider "${currentModel.provider}"`);
			}
			return key;
		},
		cursorExecHandlers,
	});
	cursorEventEmitter = (event) => agent.emitExternalEvent(event);
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
		promptTemplates,
		slashCommands,
		extensionRunner,
		customCommands: customCommandsResult.commands,
		skills,
		skillWarnings,
		skillsSettings: settingsManager.getSkillsSettings(),
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt,
		ttsrManager,
	});
	time("createAgentSession");

	// Warm up LSP servers (connects to detected servers)
	let lspServers: CreateAgentSessionResult["lspServers"];
	if (enableLsp && settingsManager.getLspDiagnosticsOnWrite()) {
		try {
			const result = await warmupLspServers(cwd, {
				onConnecting: (serverNames) => {
					if (options.hasUI && serverNames.length > 0) {
						process.stderr.write(chalk.gray(`Starting LSP servers: ${serverNames.join(", ")}...\n`));
					}
				},
			});
			lspServers = result.servers;
			time("warmupLspServers");
		} catch (error) {
			logger.warn("LSP server warmup failed", { cwd, error: String(error) });
		}
	}

	return {
		session,
		extensionsResult,
		setToolUIContext,
		mcpManager,
		modelFallbackMessage,
		lspServers,
	};
}
