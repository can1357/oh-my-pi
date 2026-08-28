import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	CredentialDisabledEvent,
	Effort,
	Message,
	Model,
	ModelUsageHealth,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	$flag,
	getAgentDir,
	getModelDbPath,
	getProjectDir,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { isAuthenticated, kNoAuth, ModelRegistry } from "./config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { applyProviderGlobalsFromSettings } from "./config/provider-globals";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "./cursor";
import { createBridgeEditTool, createBridgeGrepFactory } from "./cursor-bridge-tools";
import "./discovery";
import { createImageUrlServiceFromSettings } from "./blob-broker/service";
import { wrapStreamFnWithBlobUrlFallback } from "./blob-broker/stream-fallback";
import { initializeWithSettings } from "./discovery";
import { withOmpExtensionRootScope } from "./discovery/omp-extension-roots";
import { disposeAllJuliaKernelSessions, disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeVmContextsByOwner } from "./eval/js/context-manager";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeAllRubyKernelSessions, disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	EXTENSION_HANDLER_TIMEOUT_MS,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type RegisteredTool,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { setSharedLspEnabled } from "./lsp/client";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	deduplicateMCPToolsByName,
	discoverAndLoadMCPTools,
	getMCPToolOriginKey,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "./memory-backend/tool-names";
import type { MnemopiSessionState } from "./mnemopi/state";
import mcpXdevGuidanceTemplate from "./prompts/system/mcp-xdev-guidance.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	buildSecretObfuscator,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "./secrets";
import { AgentSession, type InitialRetryFallbackState, type PlanYolo, type Prewalk } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { withDateCwdReminder } from "./session/date-cwd-reminder";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { clampProviderContextImages } from "./session/provider-image-budget";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./session/retry-fallback-chains";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { collectMountedMCPToolRoutes, projectMountedMCPXdevGuidance } from "./session/session-tools";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	loadProjectContextFiles as loadContextFilesInternal,
	projectSystemPromptToolMetadata,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import { isScoutSpawnable } from "./task/spawn-policy";
import type { StructuredSubagentSchemaMode } from "./task/types";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	createVibeTools,
	type DeferredDiagnosticsEntry,
	defaultLoadModeForToolName,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isMountableUnderXdev,
	type LspStartupServerInfo,
	listXdevTools,
	ReadTool,
	releaseComputerSessionsForOwner,
	resolveMountedXdevExecutable,
	supportsExternalThinking,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
	xdevDocsAll,
	xdevEntries,
} from "./tools";
import { isMCPToolName, normalizeToolNames } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { isIrcEnabled } from "./tools/hub";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { isFilesystemSourcePath } from "./tools/path-utils";
import { isAutoQaEnabled } from "./tools/report-tool-issue";
import { queueResolveHandler } from "./tools/resolve";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "./tools/todo";
import { ttsTool } from "./tools/tts";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { normalizeProviderContextImagesForModel } from "./utils/image-loading";
import { formatLocalCalendarDate } from "./utils/local-date";
import { normalizePromptPath } from "./utils/prompt-path";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { VibeSessionRegistry } from "./vibe/runtime";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(lateDiagnosticTemplate, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write",
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

function collectPendingMCPToolNames(explicitToolNames: readonly string[] | undefined): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute or cwd-relative. */
	additionalDirectories?: string[];
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/**
	 * Request credential resolver. Defaults to the model registry's normal
	 * session-affine resolver. Security scans use this narrow seam to keep one
	 * durable OAuth row pinned for the operation without changing ordinary
	 * provider routing.
	 */
	getApiKey?: AgentOptions["getApiKey"];

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Validated default retry chain to install when a deferred singleton pattern resolves. */
	modelPatternDefaultFallbackChain?: string[];
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); retry-fallback recovery re-clamps to it. */
	thinkingLevelCeiling?: Effort;
	/** OpenAI service-tier override for this session. `null` omits `service_tier`. */
	openAIServiceTier?: ServiceTier | null;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/**
	 * Enable MCP capabilities. `false` skips MCP discovery and ignores
	 * `mcpManager`, preventing process-global or inherited MCP access. Default:
	 * true.
	 */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse when MCP is enabled (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Restrict LSP to navigation and diagnostics even when enabled. Defaults to true for restricted sessions. */
	lspReadOnly?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];
	/** Limit the session to explicitly supplied tool names, without discovered extras. */
	restrictToolNames?: boolean;
	/**
	 * Permit only caller-supplied SDK custom tools inside a restricted session.
	 * They must still be named in {@link toolNames}; discovered extensions, MCP,
	 * and ambient custom tools remain disabled. Default: false.
	 */
	allowRestrictedCustomTools?: boolean;

	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent Hindsight state to alias for subagent memory tools. */
	parentHindsightSessionState?: HindsightSessionState;
	/** Parent Mnemopi state to alias for subagent memory tools. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/**
	 * Registry generation authorized for this creation. `null` requires the id
	 * to be absent; an AgentRef allows a parked revival to reuse only that ref.
	 * Undefined preserves legacy unconditional registration for external SDK callers.
	 * @internal
	 */
	expectedAgentRef?: AgentRef | null;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;
	/** Inherited eval executor session id for subagents sharing parent eval state. */
	parentEvalSessionId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/**
	 * A human can answer synchronous prompts even without a terminal UI (e.g. an
	 * ACP client rendering elicitation forms). Enables `ask` without enabling
	 * TUI-only session behavior such as eager LSP warmup. Default: `hasUI`.
	 */
	interactivePrompts?: boolean;
	/**
	 * Defer `confirm` reserve-policy fallback until AgentSession prompt-time UI is configured.
	 * ACP uses this while capabilities are negotiated without enabling UI-only tools.
	 */
	deferUsageReserveConfirmation?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;
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
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Start cache-aware online runtime model discovery after the first UI paint. */
	startBackgroundModelDiscovery?: () => Promise<void>;
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

export type DialectFormat = "auto" | "native" | Dialect;

export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
// Agent registry: pass a private instance per `createAgentSession` when
// embedding several concurrent top-level sessions in one process (the default
// global registry admits only one "Main" per process generation).
export { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	GlobTool,
	GrepTool,
	HIDDEN_TOOLS,
	ReadTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

// Helper Functions

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `OMP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Delegates to {@link ./session/auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir);
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const configuredPaths = options.disableExtensionDiscovery
		? (options.additionalExtensionPaths ?? [])
		: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = options.disableExtensionDiscovery
		? undefined
		: (settings.get("disabledExtensions") ?? []);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !options.disableExtensionDiscovery,
	});
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`omp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.omp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `omp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
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
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
	disabledExtensions?: string[],
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		disabledExtensions,
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

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
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
	/** Include the read-only security:// resource inventory entry. Default: false. */
	securityEnabled?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolNames = options.tools?.map(tool => tool.name);
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	const promptTools = toolMap
		? projectSystemPromptToolMetadata(
				toolMap,
				options.inlineToolDescriptors ? { mode: "full" } : { mode: "compact", toolNames: toolNames ?? [] },
			)
		: undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		securityEnabled: options.securityEnabled,
		toolNames,
		tools: promptTools,
	});
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
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__ompLegacyBuiltinTool" in tool && tool.__ompLegacyBuiltinTool === true;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");
/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

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
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
}

export function customToolToDefinition(tool: CustomTool, sourcePath?: string): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		defaultInactive: tool.hidden === true,
		loadMode: defaultLoadModeForToolName(tool.name, tool.loadMode),
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		// Preserved through RegisteredToolAdapter so MCP-backed tools' explicit
		// `strict: false` (#4336/#4340) survives the custom-tool → definition bridge.
		strict: tool.strict,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		sourcePath,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
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

function createCustomToolsExtension(tools: CustomTool[], sourcePaths?: ReadonlyMap<string, string>): ExtensionFactory {
	const uniqueTools = deduplicateMCPToolsByName(tools);
	return api => {
		for (const tool of uniqueTools) {
			api.registerTool(customToolToDefinition(tool, sourcePaths?.get(tool.name)));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of uniqueTools) {
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
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					retryErrors: event.retryErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

/** Dependencies used to construct an isolated auto-learn capture agent. */
export interface AutoLearnCaptureRunnerOptions {
	sourceAgent: Agent;
	captureTools: AgentTool[];
	createAgent: (options: AgentOptions) => Agent;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	createSessionId?: () => string;
}

/** Build a private capture runner over a detached message snapshot and provider session. */
export function createAutoLearnCaptureRunner(
	options: AutoLearnCaptureRunnerOptions,
): (content: string, signal?: AbortSignal) => Promise<void> {
	return async (content, signal) => {
		if (options.captureTools.length === 0 || signal?.aborted) return;
		const captureModel = options.sourceAgent.state.model;
		if (!captureModel) return;

		const captureSessionId = options.createSessionId?.() ?? Bun.randomUUIDv7();
		const captureProviderSessionState = new Map<string, ProviderSessionState>();
		const captureMessages = options.sourceAgent.state.messages.map((message): AgentMessage => {
			if (message.role === "assistant") {
				return { ...message, responseId: undefined, providerPayload: undefined };
			}
			if (message.role === "user" || message.role === "developer") {
				return { ...message, providerPayload: undefined };
			}
			return message;
		});
		const captureAgent = options.createAgent({
			initialState: {
				systemPrompt: [...options.sourceAgent.state.systemPrompt],
				model: captureModel,
				thinkingLevel: options.sourceAgent.state.thinkingLevel,
				disableReasoning: options.sourceAgent.state.disableReasoning,
				tools: options.captureTools,
				messages: captureMessages,
			},
			sessionId: captureSessionId,
			promptCacheKey: captureSessionId,
			providerSessionState: captureProviderSessionState,
			getApiKey: requestModel => options.sourceAgent.getApiKey?.(requestModel),
			onPayload: options.onPayload,
			onResponse: options.onResponse,
		});
		captureAgent.setMetadataResolver(provider => options.sourceAgent.metadataForProvider(provider));
		const captureMessage: CustomMessage = {
			role: "custom",
			customType: "autolearn-nudge",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		const abortCapture = () => captureAgent.abort(signal?.reason);
		signal?.addEventListener("abort", abortCapture, { once: true });
		try {
			if (signal?.aborted) {
				abortCapture();
				return;
			}
			await captureAgent.prompt(captureMessage);
		} catch (error) {
			if (!signal?.aborted) throw error;
		} finally {
			signal?.removeEventListener("abort", abortCapture);
			for (const [providerKey, state] of captureProviderSessionState) {
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close auto-learn capture provider state", {
						providerKey,
						error: String(error),
					});
				}
			}
			captureProviderSessionState.clear();
		}
	};
}
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
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const rootMode = options.disableExtensionDiscovery ? "explicit-only" : "merge";
	return await withOmpExtensionRootScope(options.additionalExtensionPaths ?? [], rootMode, () =>
		createAgentSessionScoped(options),
	);
}

async function createAgentSessionScoped(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(
			options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)),
			path.join(agentDir, "models.yml"),
			{
				settings,
				cacheDbPath: getModelDbPath(agentDir),
			},
		);
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	// Subscribe before any getApiKey() call so startup model probes can't fire a
	// credential_disabled event past us. An embedder's constructor handler makes the
	// listener set non-empty from construction, which defeats AuthStorage's no-listener
	// buffer — so we can't rely on it to catch startup events for the extension runner.
	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void credentialDisabledTarget.emitCredentialDisabled(event);
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});
	await modelRegistry.hydrateCredentialScopedModelCaches();
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	// Kick off workspace tree discovery early. The native workspace scan returns
	// both the rendered-tree input and the AGENTS.md directory-context index, so
	// startup does not perform a second recursive filesystem search. Subagents
	// inherit the parent's resolved values via options.
	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
	const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: includeWorkspaceTree
			? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
			: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] });
	workspaceTreePromise.catch(() => {});

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
	contextFilesPromise.catch(() => {});
	const resolveRepoContext = async (repoCwd: string) => {
		try {
			return await resolveActiveRepoContext(repoCwd);
		} catch (err) {
			logger.debug("Failed to resolve active repo context", { err: String(err) });
			return null;
		}
	};
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", resolveRepoContext, cwd);
	activeRepoContextPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const advisorConfigsPromise = logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir));
	advisorConfigsPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const customCommandsPromise =
		options.disableExtensionDiscovery || options.restrictToolNames === true
			? Promise.resolve<CustomCommandsLoadResult>({ commands: [], errors: [] })
			: logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
	customCommandsPromise.catch(() => {});
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	// Initialize provider preferences from settings
	applyProviderGlobalsFromSettings(settings);

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const configuredDirs = options.additionalDirectories
		? options.additionalDirectories
		: settings.get("workspace.additionalDirectories");
	if (configuredDirs.length > 0) {
		// Merge with any roots restored from the session header (resume/fork), not replace.
		const existing = sessionManager.getAdditionalDirectories();
		const merged = [...new Set([...existing, ...configuredDirs])];
		await sessionManager.setAdditionalDirectories(merged);
	}
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined;
	const inheritedPromptCacheKey = forkCacheShapeChanged
		? undefined
		: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;
	// Startup model *selection* only needs to know whether auth is configured for
	// a candidate's provider — never the resolved key bytes. Use the synchronous,
	// side-effect-free probe (`hasConfiguredAuth`): it refreshes no OAuth tokens,
	// executes no `!command` keys, and issues no auth-broker requests. Resolving the
	// real key here (`getApiKey`) blocks resume on those network paths — a slow or
	// unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh
	// timeout per candidate (observed as a hang in `restoreSessionModel`). The real
	// key is resolved lazily per request via ModelRegistry.resolver.
	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	// Load and create secret obfuscator early so resumed session state and prompt warnings
	// reflect actual loaded secrets, not just the setting toggle.
	const obfuscator: SecretObfuscator | undefined = settings.get("secrets.enabled")
		? await buildSecretObfuscator(cwd, agentDir, options.agentDir)
		: undefined;
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	// An abnormal process exit after a non-terminal message tail is durable
	// evidence that the old process can no longer finish that turn. Preserve the
	// partial transcript and append one terminal aborted assistant record before
	// rebuilding runtime context. The helper is idempotent once that record exists.
	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	let existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const defaultRoleValue = settings.getModelRole("default");
	let explicitDefaultProviders: Set<string> | undefined;
	if ((settings.get("enabledModels")?.length ?? 0) === 0) {
		const patterns = resolveConfiguredModelPatterns(defaultRoleValue, settings);
		if (patterns && patterns.length > 0) {
			const providers = new Set<string>();
			for (const pattern of patterns) {
				const slash = pattern.indexOf("/");
				const provider = slash > 0 ? pattern.slice(0, slash).trim() : "";
				if (!provider || /[*?[\]{}]/.test(provider)) {
					providers.clear();
					break;
				}
				providers.add(provider);
			}
			if (providers.size > 0) explicitDefaultProviders = providers;
		}
	}
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		explicitDefaultProviders
			? modelRegistry.getAvailableForProviders(explicitDefaultProviders)
			: resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(defaultRoleValue, allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	let initialRetryFallback: InitialRetryFallbackState | undefined;
	// Identify session model strings to restore in fallback order. We do an
	// initial pass here so model-dependent setup (thinking-level resolution,
	// host preconnect) can use the restored model; extension-registered
	// providers aren't visible yet, so we retry the preferred candidates once
	// extensions register below.
	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					allowAutoAlias: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) {
					failedSessionModel ??= sessionModelStr;
					continue;
				}

				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	// Resolves the session/agent thinking level using the same precedence we
	// apply at startup: explicit option → persisted session entry → restored
	// model selector suffix → default role's explicit selector → selected
	// model's defaultLevel → global settings default. Run again after extension
	// role reclaim so the final model's own defaults aren't masked by an earlier
	// fallback model's.
	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
		let level = options.thinkingLevel;
		if (level === undefined && hasExistingSession && hasThinkingEntry) {
			level =
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel);
		}
		if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			level = restoredSessionThinkingLevel;
		}
		if (level === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
			level = defaultRoleSpec.thinkingLevel;
		}
		if (level === undefined && selectedModel?.thinking?.defaultLevel !== undefined) {
			level = selectedModel.thinking.defaultLevel;
		}
		if (level === undefined) {
			level = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
		}
		return level;
	};
	let thinkingLevel = pickInitialThinkingLevel(model);
	let autoThinking = thinkingLevel === AUTO_THINKING;
	// Concrete level the agent/session start with. With `auto` this is the
	// provisional level shown until the first per-turn classification resolves;
	// `auto` itself stays a session-only concept handled by AgentSession.
	let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			autoThinking
				? resolveProvisionalAutoLevel(resolvedModel)
				: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
		);
		// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
		// with the rest of session setup (extension/skill load, tool registry,
		// system prompt build). Without this, the first `fetch(...)` pays the
		// full handshake serially — 100–300 ms transcontinental for
		// api.anthropic.com from a residential IP. Every mode benefits
		// (interactive, print, rpc, acp).
		preconnectModelHost(model.baseUrl);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
		"discoverTtsrRules",
		async () => {
			const { TtsrManager } = await import("./export/ttsr");
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: ttsrSettings.disabledRules,
			});
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
		},
	);

	// Resolve contextFiles up-front (it's needed before tool creation). The
	// workspace tree scan is slow on large repos and we MUST NOT block startup on
	// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
	// will re-race the same promise through its own withDeadline path. Background
	// work continues so caches still warm.
	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const result = await Promise.race([
			work,
			Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
				timedOut = true;
				return undefined;
			}),
		]);
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};
	const [initialContextFiles, resolvedWorkspaceTree, watchdogFiles, initialActiveRepoContext, discoveredAdvisors] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
			watchdogFilesPromise,
			activeRepoContextPromise,
			advisorConfigsPromise,
		]);
	let contextFiles = initialContextFiles;

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	const restrictToolNames = options.restrictToolNames === true;
	const enableLsp = options.enableLsp ?? !restrictToolNames;
	const lspReadOnly = options.lspReadOnly ?? restrictToolNames;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	// Only the first top-level session in a process owns an AsyncJobManager.
	// Subagents inherit the parent's manager via `AsyncJobManager.instance()`
	// (set below), and any additional top-level session spun up in-process
	// (e.g. the agent-creation architect in `agents-hub.ts`) must share
	// the live singleton — otherwise its dispose path would clobber the
	// owning session's manager and break the `task`/`bash` async paths
	// (issue #1923). The `instance()` guard means later sessions also skip
	// constructing an orphaned manager that nothing would ever route to.
	// Delivery is owner-routed: every AgentSession registers its own sink
	// (see session/async-job-delivery.ts), so the manager takes no default
	// onJobComplete here.
	const asyncJobManager =
		!options.parentTaskPrefix && !AsyncJobManager.instance()
			? new AsyncJobManager({ maxRunningJobs: asyncMaxJobs })
			: undefined;

	const scopedAsyncJobManager = asyncJobManager ?? (options.parentTaskPrefix ? AsyncJobManager.instance() : undefined);

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
	let registeredAgentRef: AgentRef | undefined;
	/**
	 * Forget the agent ref on teardown — unless it is a retained terminal ref.
	 * Parking disposes the session but keeps the ref addressable (history://,
	 * revive); a hard kill leaves it as a terminal `aborted` tombstone. Both are
	 * detached (session === null) by the time dispose runs, per the AgentRef
	 * invariant, so preserving them never keeps a disposed session reachable — an
	 * aborted ref that still holds a live session is a bug and is unregistered
	 * rather than handed to ensureLive. Only process teardown / a plain release
	 * unregisters.
	 */
	const unregisterUnlessParked = (): void => {
		const ref = registeredAgentRef;
		if (!ref || agentRegistry.get(resolvedAgentId) !== ref) return;
		if (ref.status === "parked" || (ref.status === "aborted" && !ref.session)) return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId, ref)) return;
		agentRegistry.unregister(resolvedAgentId, ref);
	};
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		// Per-path mutation counter shared across edit/write tools. Late-diagnostics
		// entries capture it at fetch time and are dropped at injection if a newer
		// mutation (any tool) bumped it in the meantime.
		const fileMutationVersions = new Map<string, number>();
		const disposeCallbacks = new Set<() => void>();
		const activeToolNames = new Set<string>();
		const toolRegistry = new Map<string, Tool & Pick<ToolDefinition, "defaultInactive">>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			isToolActive: name => activeToolNames.has(name),
			setActiveToolNames,
			toolRegistry,
			hasUI: options.hasUI ?? false,
			canPromptUser: options.interactivePrompts ?? options.hasUI ?? false,
			getApiKey: options.getApiKey,
			get additionalDirectories() {
				return sessionManager.getAdditionalDirectories();
			},
			enableLsp,
			lspReadOnly,
			enableIrc: restrictToolNames ? false : options.enableIrc,
			restrictToolNames,
			get hasEditTool() {
				const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
				return restrictToolNames
					? requestedToolNames?.includes("edit") === true
					: !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.refreshSkills(),
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			requireYieldTool: options.requireYieldTool,
			prewalkArmed: options.prewalk !== undefined,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			sessionManager,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			isDisposed: () => session?.isDisposed ?? false,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			getToolForEvalBridge: name => session?.getToolForEvalBridge(name),
			getEvalBridgeToolNames: () => session?.getEvalBridgeToolNames() ?? [],
			getCodeModeDirectToolNames: () => session?.getCodeModeDirectToolNames(),
			agentRegistry,
			// The global lifecycle releases through AgentRegistry.global(); wiring it
			// onto a caller-supplied registry would report a cancel while releasing an
			// unrelated global ref. With no lifecycle, hub cancel falls back to
			// dispose + unregister on the session's own registry.
			agentLifecycle: options.agentRegistry ? undefined : () => AgentLifecycleManager.global(),
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModel: () => agent?.state.model ?? model,
			getInspectImageModeOverride: () => session?.getInspectImageModeOverride(),
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getPlanModeState: () => session?.getPlanModeState(),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? "local://PLAN.md",
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			queueDeferredDiagnostics: entry => session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			registerDisposeCallback: callback => {
				disposeCallbacks.add(callback);
				return () => disposeCallbacks.delete(callback);
			},
			registerSessionChangeCallback: callback => session?.registerSessionChangeCallback(callback),
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekPlanProposalHandler: () => session.peekPlanProposalHandler(),
			setPlanProposalHandler: handler => session.setPlanProposalHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Subagents inherit the singleton (the parent's manager) so their bash/task
			// completions still flow into the spawning conversation's yieldQueue.
			// Secondary in-process top-level sessions (no parentTaskPrefix, no
			// constructed manager because the singleton was already installed) leave
			// this undefined so tools and session job snapshots refuse async work
			// instead of silently routing into the owning session (issue #1923).
			asyncJobManager: scopedAsyncJobManager,
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions && !options.parentTaskPrefix) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Restricted sessions cannot inherit or discover MCP capabilities.
		const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
		let mcpManager: MCPManager | undefined = enableMCP ? options.mcpManager : undefined;
		toolSession.mcpManager = mcpManager;
		toolSession.enableMCP = enableMCP;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		const initialMcpManagerTools: CustomTool[] = [];
		let startDeferredMCPDiscovery: ((liveSession: AgentSession) => void) | undefined;
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP servers when builtin browser tool is active
			filterBrowser: settings.get("browser.enabled") ?? false,
		};
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}

				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = liveSession => {
					void (async () => {
						try {
							const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
								deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
							);
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
							// Connected MCP tools are enabled and mounted under xd:// devices.
							await liveSession.refreshMCPTools(mcpResult.tools);
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
				};
			} else {
				const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
					...mcpDiscoverOptions,
					cacheStorage: settings.getStorage(),
					authStorage,
				});
				mcpManager = mcpResult.manager;
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				// Log MCP errors
				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				// MCP tools are LoadedCustomTool, extract the tool property while
				// retaining their origins for initial registry ownership.
				const loadedMcpTools = mcpResult.tools.map(loaded => loaded.tool);
				customTools.push(...loadedMcpTools);
				initialMcpManagerTools.push(...loadedMcpTools);
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		const builtInToolNames = [...toolRegistry.keys()];
		let customToolPaths: ToolPathWithSource[] = [];
		const inlineExtensions: ExtensionFactory[] = [];
		if (!restrictToolNames) {
			// Add image tools when generation is enabled and either no explicit tool
			// whitelist was given or it names `generate_image`. Unlike built-in tools
			// (filtered in `createTools`), custom tools are force-activated via
			// `alwaysInclude` below, so an explicit `--no-tools`/whitelist must be
			// honored here or image-gen would leak past every filter (issue #5305).
			const imageGenRequested = !options.toolNames || options.toolNames.includes("generate_image");
			if (settings.get("generate_image.enabled") && imageGenRequested) {
				const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
				if (imageGenTools.length > 0) {
					customTools.push(...(imageGenTools as unknown as CustomTool[]));
				}
			}

			if (settings.get("speechgen.enabled")) {
				customTools.push(ttsTool as unknown as CustomTool);
			}

			// Add web search tools
			if (options.toolNames?.includes("web_search")) {
				customTools.push(...getSearchTools());
			}

			// Discover custom tools from `.omp/tools/`, `.claude/tools/`, plugins, etc.
			// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
			// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
			// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
			// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
			// execution back through the parent — wrong for isolated tasks and for
			// pending-action queueing.
			customToolPaths =
				options.preloadedCustomToolPaths ??
				(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd)));
			const customToolsLoadResult = await logger.time("loadCustomTools", () =>
				loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
			);
			for (const { path, error } of customToolsLoadResult.errors) {
				logger.error("Custom tool load failed", { path, error });
			}
			const customToolSourcePaths = new Map<string, string>();
			if (customToolsLoadResult.tools.length > 0) {
				for (const loaded of customToolsLoadResult.tools) {
					customTools.push(loaded.tool);
					if (isFilesystemSourcePath(loaded.resolvedPath)) {
						customToolSourcePaths.set(loaded.tool.name, loaded.resolvedPath);
					}
				}
			}

			inlineExtensions.push(...(options.extensions ?? []));
			inlineExtensions.push(createAutoresearchExtension);
			if (customTools.length > 0) {
				inlineExtensions.push(createCustomToolsExtension(customTools, customToolSourcePaths));
			}
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		// Load extensions. Three paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedExtensionPaths` (subagent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   3. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (restrictToolNames) {
			// Allocate a session runtime without evaluating caller-provided extension
			// instances, paths, or factories.
			extensionPaths = [];
			extensionsResult = await loadExtensions([], cwd, eventBus);
		} else if (options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
			};
			// Capture paths for downstream forwarding; filter inline-factory
			// entries (`<inline-N>`) — those are per-session, not source paths.
			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
		} else if (options.preloadedExtensionPaths) {
			extensionPaths = options.preloadedExtensionPaths;
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, settings),
			);
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;

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

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		if (!restrictToolNames) {
			const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
			modelRegistry.syncExtensionSources(activeExtensionSources);
			for (const sourceId of new Set(activeExtensionSources)) {
				modelRegistry.clearSourceRegistrations(sourceId);
			}
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}
		// Hydrate cached runtime (extension) provider catalogs before model
		// resolution. Dynamic-only providers have no synchronous registration side
		// effect, so a cold --model/provider resume must see the same fresh SQLite
		// cache that `omp models find` uses before the online refresh continues in
		// the background.
		await modelRegistry.refreshRuntimeProviders("offline");
		// Online runtime discovery must not steal the event loop from the first UI
		// frame. Explicit deferred model selectors still start it immediately
		// because they await it below; normal UI startup receives a one-shot
		// starter in CreateAgentSessionResult and calls it after mode.init paints.
		let runtimeDiscoveryPromise: Promise<void> | undefined;
		const startRuntimeDiscovery = (): Promise<void> => {
			runtimeDiscoveryPromise ??= modelRegistry.refreshRuntimeProviders().catch(error => {
				logger.warn("runtime provider discovery failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return runtimeDiscoveryPromise;
		};
		if (!options.hasUI || deferredModelPatterns.length > 0) {
			void startRuntimeDiscovery();
		}

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			const restoreSessionModel = (): boolean => {
				for (let i = 0; i < sessionRetryLimit; i++) {
					const sessionModelStr = sessionModelStrings[i];
					const parsedModel = parseModelString(sessionModelStr, {
						allowMaxSuffix: true,
						allowAutoAlias: true,
						isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
					});
					if (!parsedModel) continue;
					const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
					if (restoredModel && hasModelAuth(restoredModel)) {
						model = restoredModel;
						modelFallbackMessage = undefined;
						restoredSessionModelIndex = i;
						restoredSessionThinkingLevel = parsedModel.thinkingLevel;
						// Recompute thinking-level from scratch against the reclaimed
						// model: any value derived from the earlier fallback model's
						// `thinking.defaultLevel` must not become sticky.
						thinkingLevel = pickInitialThinkingLevel(restoredModel);
						autoThinking = thinkingLevel === AUTO_THINKING;
						effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
						effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
							autoThinking
								? resolveProvisionalAutoLevel(restoredModel)
								: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
						);
						preconnectModelHost(restoredModel.baseUrl);
						return true;
					}
				}
				return false;
			};
			if (!restoreSessionModel()) {
				// The saved candidates weren't in the static+cached catalog. If any
				// belongs to a discovery-backed provider that hasn't been fetched
				// yet (models.yml `discovery:` — openai-models-list/litellm/proxy/…),
				// trigger a cache-aware, provider-scoped discovery pass and retry
				// before resume silently downgrades to the default role. The
				// registry coalesces this with any matching request already running
				// in the SDK's startup background refresh.
				const discoverableProviders = new Set(modelRegistry.getDiscoverableProviders());
				const candidateProviders = new Set<string>();
				if (discoverableProviders.size > 0) {
					for (const sessionModelStr of sessionModelStrings.slice(0, sessionRetryLimit)) {
						const parsedModel = parseModelString(sessionModelStr, {
							allowMaxSuffix: true,
							allowAutoAlias: true,
							isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
						});
						if (parsedModel && discoverableProviders.has(parsedModel.provider)) {
							candidateProviders.add(parsedModel.provider);
						}
					}
				}
				if (candidateProviders.size > 0) {
					// This skips the static reload and all-other-runtime restore
					// performed by `refreshProvider`, so unrelated runtime providers
					// continue independently.
					await logger.time("restoreSessionModelDiscoveryFallback", () =>
						modelRegistry.refreshDiscoverableProviders(candidateProviders, "online-if-uncached"),
					);
					restoreSessionModel();
				}
			}
		}
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Use the same CLI resolver as the immediate path so bare role
		// names, exact model names, and provider selectors keep one precedence rule.
		if (!model && deferredModelPatterns.length > 0) {
			// Deferred `--model` patterns almost always failed at the immediate
			// path (main.ts:881) precisely because discovery-backed providers
			// hadn't populated yet. Await the in-flight runtime discovery
			// already kicked off above (stash + reuse avoids a second concurrent
			// `#refreshRuntimeDiscoveries` pass for the same runtime model
			// managers; it resolves instantly when no runtime managers are
			// registered). `refreshRuntimeProviders()` only covers runtime model
			// managers, not config-discovery providers (e.g. user-configured
			// ollama); fall back to a full cache-aware refresh only when the
			// runtime pass didn't surface a match AND config-discovery providers
			// exist to fetch from. By then runtime managers short-circuit on the
			// fresh cache written by the awaited pass, closing the double-fetch
			// window.
			await logger.time("resolveModelDiscoveryDeferredRetry", startRuntimeDiscovery);
			const matchPreferences = getModelMatchPreferences(settings);
			const runtimeResolved = deferredModelPatterns.some(pattern =>
				pattern.split(",").some(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return false;
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					// Only a concretely resolved model counts as a runtime match. A role
					// alias that expanded to `configuredPatterns` but resolved no model
					// (its discoverable provider hasn't been fetched yet) must NOT
					// short-circuit the fallback refresh below — otherwise `@role`
					// selectors pointing at discovery-backed models never trigger the
					// fetch and fail with `Model "@role" not found`.
					return Boolean(resolved.model);
				}),
			);
			if (!runtimeResolved && modelRegistry.getDiscoverableProviders().length > 0) {
				await logger.time("resolveModelDiscoveryFallbackNonRuntime", () =>
					modelRegistry.refresh("online-if-uncached"),
				);
			}
			const allModels = modelRegistry.getAll();
			const availableModels = modelRegistry.getAvailable();
			const expandedModelPatterns = deferredModelPatterns.flatMap(pattern =>
				pattern.split(",").flatMap(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return [];
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					if (resolved.configuredPatterns && resolved.configuredPatterns.length > 0) {
						const primaryPatterns: Array<{
							pattern: string;
							retryFallback: InitialRetryFallbackState | undefined;
						}> = resolved.configuredPatterns.map(pattern => ({
							pattern,
							retryFallback: undefined,
						}));
						if (!resolved.configuredRole || !settings.get("retry.modelFallback")) {
							return primaryPatterns;
						}
						const fallbackContext: RetryFallbackResolutionContext = {
							chains: expandDefaultRetryFallbackChains(settings.get("retry.fallbackChains"), [
								...Object.keys(settings.getModelRoles()),
								resolved.configuredRole,
							]),
							getModelRole: role => settings.getModelRole(role),
							modelLookup: modelRegistry,
						};
						const originalSelector = resolved.configuredPatterns[0];
						const availableOriginal = parseModelPattern(originalSelector, availableModels, matchPreferences);
						const originalModel =
							availableOriginal.model ?? parseModelPattern(originalSelector, allModels, matchPreferences).model;
						const chainKey = resolveRetryFallbackChainKey(
							fallbackContext,
							originalSelector,
							originalModel,
							resolved.configuredRole,
						);
						if (!chainKey) return primaryPatterns;
						const parsedOriginal = parseModelString(originalSelector, {
							allowMaxSuffix: true,
							allowAutoAlias: true,
							isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
						});
						const retryFallback: InitialRetryFallbackState = {
							role: chainKey,
							originalSelector,
							originalThinkingLevel: parsedOriginal?.thinkingLevel,
						};
						return [
							...primaryPatterns,
							...findRetryFallbackCandidates(fallbackContext, chainKey, originalSelector, originalModel, {
								allowMissingPrimary: true,
							}).map(candidate => ({ pattern: candidate.raw, retryFallback })),
						];
					}
					if (resolved.model) {
						return [
							{
								pattern: formatModelSelectorValue(
									resolved.selector ?? formatModelStringWithRouting(resolved.model),
									resolved.thinkingLevel,
								),
								retryFallback: undefined,
							},
						];
					}
					return resolveConfiguredModelPatterns([trimmedSelector], settings).map(pattern => ({
						pattern,
						retryFallback: undefined,
					}));
				}),
			);
			const resolutionModels = expandedModelPatterns.some(
				({ pattern }) => parseModelPattern(pattern, availableModels, matchPreferences).model,
			)
				? availableModels
				: allModels;
			let usageFallbackTriggered = false;
			for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
				const { pattern, retryFallback } = expandedModelPatterns[patternIndex];
				const primary = parseModelPattern(pattern, resolutionModels, matchPreferences);
				if (!primary.model || (retryFallback && !hasModelAuth(primary.model))) continue;
				let hasUsageFallbackCandidate = false;
				for (
					let candidateIndex = patternIndex + 1;
					candidateIndex < expandedModelPatterns.length;
					candidateIndex += 1
				) {
					const candidate = parseModelPattern(
						expandedModelPatterns[candidateIndex].pattern,
						resolutionModels,
						matchPreferences,
					);
					if (candidate.model && hasModelAuth(candidate.model)) {
						hasUsageFallbackCandidate = true;
						break;
					}
				}
				const usageReservePolicy = settings.get("retry.usageReservePolicy");
				const modelFallbackEnabled = settings.get("retry.modelFallback");
				if (
					((modelFallbackEnabled && (hasUsageFallbackCandidate || usageFallbackTriggered)) ||
						usageReservePolicy === "fail-closed") &&
					settings.get("retry.usageAwareFallback")
				) {
					let usageHealth: ModelUsageHealth | undefined;
					try {
						usageHealth = await modelRegistry.authStorage.getModelUsageHealth(primary.model.provider, {
							modelId: primary.model.id,
							baseUrl: primary.model.baseUrl,
							reserveFraction: settings.get("retry.usageReservePct") / 100,
						});
					} catch (error) {
						logger.debug("Usage-aware model preflight failed open", {
							provider: primary.model.provider,
							model: primary.model.id,
							error: String(error),
						});
					}
					if (usageHealth?.state === "depleted") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage depleted for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (modelFallbackEnabled) {
							usageFallbackTriggered = true;
							continue;
						}
					}
					if (usageHealth?.state === "reserve") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage reserve reached for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (
							modelFallbackEnabled &&
							(usageReservePolicy === "auto" || (!options.hasUI && !options.deferUsageReserveConfirmation))
						) {
							usageFallbackTriggered = true;
							continue;
						}
					}
				}
				let selectedModel = primary.model;
				let selectedThinkingLevel = primary.thinkingLevel;
				let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;
				// A chain entry without its own `:level` suffix inherits the
				// unavailable primary's configured thinking level, matching
				// runtime fallback-chain semantics.
				if (retryFallback && !selectedExplicitThinkingLevel && retryFallback.originalThinkingLevel !== undefined) {
					selectedThinkingLevel = retryFallback.originalThinkingLevel;
					selectedExplicitThinkingLevel = true;
				}
				let authFallbackUsed = false;
				if (options.modelPatternAuthFallback) {
					const primaryKey = await modelRegistry.getApiKey(primary.model);
					if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
						const fallback = parseModelPattern(
							options.modelPatternAuthFallback,
							resolutionModels,
							matchPreferences,
						);
						if (fallback.model) {
							const fallbackKey = await modelRegistry.getApiKey(fallback.model);
							if (isAuthenticated(fallbackKey)) {
								selectedModel = fallback.model;
								selectedThinkingLevel = fallback.thinkingLevel;
								selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
								authFallbackUsed = true;
							}
						}
					}
				}
				if (!authFallbackUsed && options.modelPatternFallbackRole) {
					const primarySelector = formatModelSelectorValue(
						formatModelStringWithRouting(primary.model),
						primary.thinkingLevel,
					);
					const seenSelectors = new Set<string>([primarySelector]);
					const fallbackSelectors: string[] = [];
					for (const fallbackEntry of expandedModelPatterns.slice(patternIndex + 1)) {
						const fallback = parseModelPattern(fallbackEntry.pattern, resolutionModels, matchPreferences);
						if (!fallback.model) continue;
						const fallbackSelector = formatModelSelectorValue(
							formatModelStringWithRouting(fallback.model),
							fallback.thinkingLevel,
						);
						if (seenSelectors.has(fallbackSelector)) continue;
						seenSelectors.add(fallbackSelector);
						fallbackSelectors.push(fallbackSelector);
					}
					if (fallbackSelectors.length === 0) {
						for (const selector of options.modelPatternDefaultFallbackChain ?? []) {
							if (typeof selector !== "string" || seenSelectors.has(selector)) continue;
							seenSelectors.add(selector);
							fallbackSelectors.push(selector);
						}
					}
					if (fallbackSelectors.length > 0) {
						const modelRoles: Record<string, string> = {};
						const existingRoles = settings.getModelRoles();
						for (const role in existingRoles) {
							const selector = existingRoles[role];
							if (selector) {
								modelRoles[role] = selector;
							}
						}
						modelRoles[options.modelPatternFallbackRole] = primarySelector;
						settings.override("modelRoles", modelRoles);
						const fallbackChains: Record<string, string[]> = {
							[options.modelPatternFallbackRole]: fallbackSelectors,
						};
						const existingFallbackChains = settings.get("retry.fallbackChains");
						for (const role in existingFallbackChains) {
							if (role !== options.modelPatternFallbackRole) {
								fallbackChains[role] = existingFallbackChains[role];
							}
						}
						settings.override("retry.fallbackChains", fallbackChains);
					}
				}
				model = selectedModel;
				initialRetryFallback =
					retryFallback && usageFallbackTriggered ? { ...retryFallback, pinned: true } : retryFallback;
				modelFallbackMessage = undefined;
				if (selectedExplicitThinkingLevel) {
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(selectedModel)
						: resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
				);
				preconnectModelHost(selectedModel.baseUrl);
				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				modelFallbackMessage = `Model ${requested} not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && deferredModelPatterns.length === 0) {
			// Retry the configured default role against the current catalog,
			// setting `model` (+ thinking level) when it resolves. Extension
			// factories register providers AFTER the early `defaultRoleSpec`
			// resolution, and configured discovery providers may still be
			// mid-discovery, so a role pointing at such a model (an openai-compat
			// plugin's `posthog/claude-opus-4-8`, a models.yml `openai-models-list`
			// endpoint) returned `undefined` there. Without this retry the
			// `pickDefaultAvailableModel` fallback below happily replaces the
			// user's configured default with a bundled provider's default whenever
			// a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issues #3569, #6162)
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;
				// Re-resolve the allowed set: extension factories and discovery
				// refreshes above may have registered models not visible earlier.
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
				});
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;
				// Recompute the thinking level against the now-real model.
				// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
				// so the role's explicit selector (e.g. `:max`) now applies.
				thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(resolvedDefaultModel)
						: resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
				);
				preconnectModelHost(resolvedDefaultModel.baseUrl);
				return true;
			};

			await tryResolveDefaultRole();

			if (!model) {
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));

				// Cold-cache discovery race (issues #6114, #6162): a discovery
				// provider (models.yml `openai-models-list`, LM Studio/Ollama/
				// llama.cpp, or an openai-compat proxy) ships no static models, so
				// the static+cached catalog resolved nothing above. Background
				// discovery in main.ts fires only AFTER createAgentSession returns,
				// so on a cache-cold boot the configured default stays unresolved
				// and `pick` silently degrades to an unrelated authed provider's
				// default (#6162) or "No models available" (#6114) — even though
				// `omp models` (which awaits discovery) lists the model. Await one
				// cache-aware discovery pass and retry when a default role is
				// configured (must win over `pick`) or nothing resolved at all.
				// The common path — role already resolved, or a `pick` with no
				// configured default — never pays for it.
				const defaultRoleConfigured = Boolean(settings.getModelRole("default"));
				if (
					!hasExplicitModel &&
					(defaultRoleConfigured || !pick) &&
					modelRegistry.getDiscoverableProviders().length > 0
				) {
					await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
					if (!(await tryResolveDefaultRole()) && !model) {
						const refreshedCandidates = await resolveAllowedModels(
							modelRegistry,
							settings,
							modelMatchPreferences,
						);
						pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth));
					}
				}

				if (!model && pick) {
					model = pick;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		if (model) {
			const selectedModel = model;
			const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
				modelRegistry.refreshSelectedModelMetadata(selectedModel),
			);
			if (refreshedModel !== selectedModel) {
				model = refreshedModel;
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(refreshedModel)
						: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () =>
					deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
				);
			}
		}

		// Discovery started with the other cwd/agentDir-only scans, before model
		// resolution and tool construction, so command module I/O stays off the
		// session-creation critical path.
		const customCommandsResult = await customCommandsPromise;
		if (!options.disableExtensionDiscovery && !restrictToolNames) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// The runner is created unconditionally — even with zero extensions loaded — because the
		// `ExtensionToolWrapper` installed below is the only place the per-tool approval gate runs.
		// A conditional runner means the approval system silently disappears for users with no
		// extensions, contradicting non-yolo `tools.approvalMode` settings without feedback.
		// (The builtin autoresearch extension is unconditionally loaded above, so this scenario
		// is unreachable; unconditional runner construction keeps that invariant explicit and
		// prevents future optional extensions from silently re-opening the hole.)
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			() => (hasSession ? createSessionMemoryRuntimeContext(session, agentDir, cwd) : undefined),
			settings,
			localProtocolOptions,
			() => (hasSession ? session.getAsyncJobSnapshot() : null),
		);

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void extensionRunner.emitCredentialDisabled(event);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);
		toolSession.getToolContext = () => toolContextStore.getContext();
		const setSessionActiveToolNames = (names: Iterable<string>): void => {
			const snapshot = Array.from(names);
			setActiveToolNames(snapshot);
			toolContextStore.setToolNames(snapshot);
		};
		// Native built-in implementations backing same-tool `ctx.invokeTool`, so a tool that
		// re-registers a built-in (e.g. wrapping `write`) can delegate to the original — reaching the
		// unwrapped native execute, which inherits the caller's already-granted approval rather than
		// re-running the gate. Seeded from the xdev registry when present (it retains discoverable
		// built-ins like `browser` that xdev partitioning removes from the active tool array), else
		// from the built-in registry; captured before the ExtensionToolWrapper pass so the natives
		// stay unwrapped. The extension runner exposes it to re-registered tools via createContext.
		const nativeToolsByName = new Map<string, Tool>(toolSession.xdev?.tools ?? undefined);

		const registeredTools = restrictToolNames ? [] : extensionRunner.getAllRegisteredTools();
		const initialRegisteredTools = new WeakSet(registeredTools);
		const sdkCustomTools =
			restrictToolNames && options.allowRestrictedCustomTools !== true
				? []
				: (options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? []);
		const sdkCustomToolNames = new Set(sdkCustomTools.map(tool => tool.name));
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
				return { definition, extensionPath: "<sdk>" };
			}),
		];
		// `wrapToolWithMetaNotice` runs the centralized large-output → artifact spill.
		// Built-in tools get it in `createTools`; extension, SDK-custom, image-gen,
		// TTS, and startup (non-deferred) MCP tools all funnel through here, so apply
		// it once at this adapter boundary (idempotent — a no-op if already wrapped).
		const wrappedExtensionTools: Tool[] = deduplicateMCPToolsByName(
			wrapRegisteredTools(allCustomTools, extensionRunner).map(wrapToolWithMetaNotice),
		);
		const initialMcpManagerToolNames = new Set<string>();
		for (const tool of wrappedExtensionTools) {
			const originKey = getMCPToolOriginKey(tool);
			const matchesManagerOrigin =
				originKey !== undefined &&
				initialMcpManagerTools.some(
					managerTool => managerTool.name === tool.name && getMCPToolOriginKey(managerTool) === originKey,
				);
			if (matchesManagerOrigin) initialMcpManagerToolNames.add(tool.name);
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const builtInRegistryToolNames = toolSession.xdev?.builtInNames ?? new Set(toolRegistry.keys());
		// Capture the native built-in implementations before extension re-registration replaces registry
		// entries and before the ExtensionToolWrapper pass below, so `ctx.invokeTool` reaches the
		// unwrapped native execute (inheriting the caller's already-granted approval, not re-gating).
		for (const [name, tool] of toolRegistry) {
			nativeToolsByName.set(name, tool);
		}
		if (!restrictToolNames && !toolRegistry.has("goal") && settings.get("goal.enabled")) {
			const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
			if (goalTool) {
				const wrapped = wrapToolWithMetaNotice(goalTool);
				toolRegistry.set(goalTool.name, wrapped);
				builtInRegistryToolNames.add(goalTool.name);
				nativeToolsByName.set(goalTool.name, wrapped);
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
			builtInRegistryToolNames.delete(tool.name);
		}
		// Expose the native built-ins to same-tool `ctx.invokeTool` on re-registered tools. Set after
		// the override loop so the map holds the natives, not the extension replacements. The context
		// factory is the loop's own tool context, so a delegated native call sees ordinary session state.
		extensionRunner.setNativeToolResolver(name => {
			const tool = nativeToolsByName.get(name);
			return tool ? { tool, makeContext: () => toolContextStore.getContext() } : undefined;
		});
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
					initialMcpManagerToolNames.add(name);
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
		// Hashline `edit` stays in the registry so Cursor can call it as MCP.
		// Native StrReplace arrives as `editToolCall` and materializes through
		// exec `readArgs`/`writeArgs`; `pi_edit` still needs a `replace`-mode
		// instance because `PiEditExecArgs` carries `old_string`/`new_string`,
		// which is exactly `replace`'s schema and nothing else's. The registry
		// instance follows the session's configured mode, so the bridge builds
		// its own and serves it through `getEditReplaceTool` — not `getTool`,
		// which doubles as the agent loop's fallback for unadvertised calls.
		//
		// The grant is captured here, independently of the session's provider:
		// a session that starts on another provider can switch to Cursor later,
		// and the roster is built once, at session creation.
		const editWasGranted = toolRegistry.has("edit");
		// Built on first use rather than eagerly: a session that never reaches
		// Cursor never constructs it.
		let cursorBridgeEditTool: AgentTool | undefined;
		const getCursorBridgeEditTool = (): AgentTool | undefined => {
			// Only when the session actually granted `edit`. `createTools` omits
			// it entirely for a restricted tool set, and the bridge answers native
			// frames that arrive regardless of the advertised catalog — so
			// building one unconditionally would hand a read-only agent a
			// mutating tool it was denied (the issue #5680 escalation).
			if (!editWasGranted) return undefined;
			cursorBridgeEditTool ??= createBridgeEditTool(toolSession, extensionRunner);
			return cursorBridgeEditTool;
		};
		// Whether this session granted a file-writing tool. Same capture-early
		// reasoning, plus `write` may be auto-registered further down as an xdev
		// transport. The exec bridge answers native `delete` and
		// resource-download frames that mutate files without running a registry
		// tool, so it needs the grant as the session actually made it.
		const cursorCanMutateFiles = editWasGranted || toolRegistry.has("write");

		let writeRegistration: Promise<boolean> | undefined;
		const ensureWriteRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("write")) return Promise.resolve(builtInRegistryToolNames.has("write"));
			writeRegistration ??= (async () => {
				const writeTool = await logger.time("createTools:write:session", BUILTIN_TOOLS.write, toolSession);
				if (!writeTool || toolRegistry.has("write")) return builtInRegistryToolNames.has("write");
				const nativeWrite = wrapToolWithMetaNotice(writeTool);
				toolRegistry.set(writeTool.name, new ExtensionToolWrapper(nativeWrite, extensionRunner) as Tool);
				builtInRegistryToolNames.add(writeTool.name);
				nativeToolsByName.set(writeTool.name, nativeWrite);
				return true;
			})().finally(() => {
				writeRegistration = undefined;
			});
			return writeRegistration;
		};

		// Goal mode can be enabled after the session was created (settings UI,
		// `/set goal.enabled true`). The eager registration above only runs at
		// creation, so a runtime enable would leave the registry without `goal`
		// and `#enterGoalMode`'s `setActiveToolsByName([...tools, "goal"])` would
		// silently drop the unknown name — goal mode starts, the model is told to
		// use the `goal` tool, and the call fails (issue #9444). Register it
		// lazily on demand, mirroring `ensureWriteRegistered`.
		let goalRegistration: Promise<boolean> | undefined;
		const ensureGoalRegistered = (): Promise<boolean> => {
			if (toolRegistry.has("goal")) return Promise.resolve(true);
			if (restrictToolNames || !settings.get("goal.enabled")) return Promise.resolve(false);
			goalRegistration ??= (async () => {
				const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
				if (!goalTool || toolRegistry.has("goal")) return toolRegistry.has("goal");
				const nativeGoal = wrapToolWithMetaNotice(goalTool);
				toolRegistry.set(goalTool.name, new ExtensionToolWrapper(nativeGoal, extensionRunner) as Tool);
				builtInRegistryToolNames.add(goalTool.name);
				nativeToolsByName.set(goalTool.name, nativeGoal);
				return true;
			})().finally(() => {
				goalRegistration = undefined;
			});
			return goalRegistration;
		};

		// Existing staged/device paths need write registered before active-set assembly.
		// Deferred MCP also registers it now, but refresh activates it only after a server connects.
		// xd:// mounts never register write: xdev state only exists when the session
		// already granted a write tool (see createTools), so mounting rides that grant.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const planModeAvailable = settings.get("plan.enabled");
		if (!restrictToolNames && (hasDeferrableTools || planModeAvailable || deferMCPDiscoveryForUI)) {
			await ensureWriteRegistered();
		}

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		// Cursor and the agent loop may call a mounted device by its top-level
		// name. Resolve that name from the canonical map and apply the same
		// execution-only ACP decorator used by `write xd://<tool>`; docs and
		// renderer lookup continue to use the undecorated canonical instance.
		const resolveDeviceTool = (name: string): AgentTool | undefined => {
			const state = toolSession.xdev;
			if (!state) return undefined;
			return resolveMountedXdevExecutable(state, name);
		};
		// Cursor's resource frames ask what THIS client's servers advertise; only
		// live connections have any. Built once: the advisor bridges answer from
		// the same connections the primary does.
		const cursorMcpResources: CursorMcpResourceAdapter | undefined = mcpManager && {
			serverNames: () => mcpManager.getConnectedServers(),
			getServerResources: async name => {
				// The manager registers a server's tools before its background
				// resource load finishes, so a frame arriving in that window
				// would read an empty cache and report "advertises nothing".
				await mcpManager.ensureServerResources(name);
				return mcpManager.getServerResources(name);
			},
			readServerResource: (name, uri) => mcpManager.readServerResource(name, uri),
		};
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			// The session's cwd moves (`/cd`, resume, branch restore) while this
			// bridge is built once at startup. Path-confining frames — the native
			// `delete` and a `download_path` resource read — resolve against
			// whichever of the two they are given, so without the live resolver the
			// primary would write into the workspace the session has left while
			// reporting success for the path the server asked about. The advisor
			// bridge already passes one.
			getCwd: () => sessionManager.getCwd(),
			tools: toolRegistry,
			getExecutableTool: resolveDeviceTool,
			// `pi_edit` needs the `replace`-mode instance specifically, and the
			// registry may still hold the session's own `edit` (any mode) when
			// this session did not start on Cursor.
			getEditReplaceTool: getCursorBridgeEditTool,
			getToolContext: () => toolContextStore.getContext(),
			mcpResources: cursorMcpResources,
			emitEvent: event => cursorEventEmitter?.(event),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			persistTodoPhases: phases => sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
			// `pi_grep` carries its own context width and match cap, which the
			// shared grep instance fixed at construction cannot express. Gated on
			// the grant: the factory builds a fresh tool and `executeTool` prefers
			// it over the registry, so installing it unconditionally would let a
			// session without `grep` search anyway.
			createGrepTool: toolRegistry.has("grep") ? createBridgeGrepFactory(toolSession, extensionRunner) : undefined,
			// The native `delete` and resource-download frames mutate files
			// without running a registry tool, so this grant is the only thing
			// standing between a restricted session and a workspace write.
			allowDirectFileMutation: cursorCanMutateFiles,
		});

		// Resolve the inline-descriptors setting against the session-start model.
		// `auto` enforces the per-model policy (inline for Gemini, off otherwise);
		// like the rest of the prune machinery this is fixed for the session, so a
		// mid-session model switch keeps the start-time decision.
		const inlineToolDescriptors = shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), model?.id);
		const eagerTasks = settings.get("task.eager") !== "default";
		const eagerTasksAlways = settings.get("task.eager") === "always";
		const intentField = $flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			rebuildOptions?: { directToolNames?: readonly string[] },
		): Promise<BuildSystemPromptResult> => {
			const promptCwd = sessionManager.getCwd();
			const activeRepoContext = hasSession
				? await logger.time("resolveActiveRepoContext", resolveRepoContext, promptCwd)
				: initialActiveRepoContext;
			if (hasSession && options.contextFiles === undefined) {
				contextFiles = await logger.time("discoverContextFiles", discoverContextFiles, promptCwd, agentDir, [
					...(settings.get("disabledExtensions") ?? []),
				]);
				toolSession.contextFiles = contextFiles;
				session.setAdvisorContextPrompt(formatAdvisorContextPrompt(contextFiles));
			}
			const memoryBackend = restrictToolNames ? undefined : await resolveMemoryBackend(settings);
			const memoryInstructions = memoryBackend
				? await memoryBackend.buildDeveloperInstructions(agentDir, settings, session)
				: undefined;

			// Build combined append prompt: memory instructions + auto-learn guidance
			// + mounted MCP route guidance + optional MCP server instructions. For UI
			// sessions MCP discovery is deferred, so the initial registry and
			// `getServerInstructions()` are empty until the background connect
			// completes; the rebuild that `refreshMCPTools` triggers post-discovery
			// then picks up the mounted routes and any connected-server instructions.
			const serverInstructions = mcpManager?.getServerInstructions();
			// Drive guidance off the auto-learn BUILTINS that createTools actually built
			// (provenance, not just an active name): `builtInToolNames` excludes a
			// custom/extension tool that merely shares the name, and reflects the
			// session-start build — so a subagent that filtered them out, a mid-session
			// enable that never built them, or a same-named custom tool while auto-learn
			// is off all get no guidance.
			const autoLearnInstructions = restrictToolNames
				? undefined
				: buildAutoLearnInstructions({
						manageSkill: builtInToolNames.includes("manage_skill"),
						learn: builtInToolNames.includes("learn"),
					});
			const appendParts: string[] = [];
			if (memoryInstructions) appendParts.push(memoryInstructions);
			if (autoLearnInstructions) appendParts.push(autoLearnInstructions);
			const projection = projectMountedMCPXdevGuidance(
				collectMountedMCPToolRoutes(toolSession.xdev ? listXdevTools(toolSession.xdev) : []),
			);
			if (projection.mappings.length > 0 || projection.hasOmittedMappings) {
				appendParts.push(
					prompt
						.render(mcpXdevGuidanceTemplate, {
							tools: projection.mappings.map(mapping => ({
								mcpToolName: mapping.label,
								path: mapping.path,
							})),
							hasOmittedTools: projection.hasOmittedMappings,
						})
						.trim(),
				);
			}
			if (serverInstructions && serverInstructions.size > 0) {
				appendParts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					appendParts.push(`### ${srvName}\n${truncated}`);
				}
			}
			let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			// Owned/in-band tool dialects (non-native) require the full functions-
			// namespace catalog; native tool calling lets the compact name list suffice.
			const nativeTools = resolveDialect(settings.get("tools.format"), agent?.state.model ?? model) === undefined;
			const promptTools = projectSystemPromptToolMetadata(
				tools,
				nativeTools && !inlineToolDescriptors ? { mode: "compact", toolNames } : { mode: "full" },
			);
			if (options.appendSystemPrompt) {
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd: promptCwd,
				additionalWorkspaceRoots: sessionManager.getAdditionalDirectories(),
				xdevTools: toolSession.xdev ? xdevEntries(toolSession.xdev) : [],
				xdevDocs: toolSession.xdev
					? xdevDocsAll(toolSession.xdev, settings.get("tools.xdevDocs"), settings.get("tools.xdevInlineDevices"))
					: "",
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: session?.skills ?? skills,
				contextFiles,
				tools: promptTools,
				toolNames,
				directToolNames: rebuildOptions?.directToolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				inlineToolDescriptors,
				nativeTools,
				intentField,
				eagerTasks,
				eagerTasksAlways,
				taskBatch: settings.get("task.batch"),
				taskMaxConcurrency: settings.get("task.maxConcurrency"),
				scoutAvailable: isScoutSpawnable(
					settings.get("task.disabledAgents") as string[] | undefined,
					options.spawns ?? "*",
				),
				taskIrcEnabled: !restrictToolNames && isIrcEnabled(settings, options.taskDepth ?? 0),
				autoQaEnabled: !restrictToolNames && isAutoQaEnabled(settings),
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				includeWorkspaceTree,
				memoryRootEnabled: memoryBackend?.id === "local",
				securityEnabled: settings.get("security.enabled"),
				model: getActiveModelString(),
				includeModelInPrompt: settings.get("includeModelInPrompt"),
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
				renderMermaid: settings.get("tui.renderMermaid"),
				activeRepoContext,
			});

			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			const customPrompt =
				typeof options.systemPrompt === "function"
					? options.systemPrompt(defaultPrompt.systemPrompt)
					: options.systemPrompt;
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the subagent's prompts and idle-reminders demand a
		// `yield` call to terminate. The tool registry already includes `yield` (see
		// `createTools`), but an explicit `toolNames` list would otherwise drop it from the
		// active set — leaving the model unable to satisfy the contract. Mirror the same
		// invariant `parseAgentFields` enforces on frontmatter `tools`.
		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes("yield")
		) {
			explicitlyRequestedToolNames.push("yield");
		}
		// Auto-learn builtins are force-included into the registry by `createTools`
		// for enabled top-level sessions (tools/index.ts), but — like `yield` above —
		// an explicit `toolNames` list would otherwise drop them from the ACTIVE set,
		// leaving the nudge/guidance pointing at tools the model cannot call. Activate
		// exactly the builtins createTools built (`builtInToolNames` — provenance, so a
		// same-named custom/extension tool is never force-activated when auto-learn is
		// off) to keep guidance, controller, and the active set consistent.
		if (!restrictToolNames && explicitlyRequestedToolNames) {
			for (const name of ["manage_skill", "learn"]) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		// Checkpoint and rewind are a pair: `createTools` auto-includes the sister
		// tool in the registry, but an explicit `toolNames` list would otherwise
		// drop it from the ACTIVE set — leaving the agent able to checkpoint but
		// unable to rewind (or vice versa). Mirror the pairing here. Unlike the
		// manage_skill/learn mirror above, this is a safety pairing — it applies
		// to restricted sessions too.
		if (explicitlyRequestedToolNames) {
			if (builtInToolNames.includes("checkpoint") && !explicitlyRequestedToolNames.includes("rewind")) {
				explicitlyRequestedToolNames.push("rewind");
			} else if (builtInToolNames.includes("rewind") && !explicitlyRequestedToolNames.includes("checkpoint")) {
				explicitlyRequestedToolNames.push("checkpoint");
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const defaultInactiveToolNames = new Set(
			toolNamesFromRegistry.filter(name => {
				const tool = toolRegistry.get(name);
				return tool?.defaultInactive === true || tool?.hidden === true;
			}),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const explicitlyRequestedToolNameSet = explicitlyRequestedToolNames
			? new Set(explicitlyRequestedToolNames)
			: undefined;
		const xdevReadAvailable =
			builtInRegistryToolNames.has("read") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("read"));
		const xdevWriteAvailable =
			builtInRegistryToolNames.has("write") &&
			(explicitlyRequestedToolNameSet === undefined || explicitlyRequestedToolNameSet.has("write"));
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		let initialToolNames = [...initialRequestedActiveToolNames];

		// Custom tools and extension-registered tools are always included
		// unless the effective registry winner is hidden / defaultInactive. Restricted callers own the list.
		const alwaysInclude: string[] = restrictToolNames
			? []
			: [...sdkCustomTools.map(t => t.name), ...registeredTools.map(t => t.definition.name)].filter(
					name => !defaultInactiveToolNames.has(name),
				);
		for (const name of alwaysInclude) {
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		const registrationInput = {
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running" as const,
		};
		registeredAgentRef =
			options.expectedAgentRef === undefined
				? agentRegistry.register(registrationInput)
				: agentRegistry.registerIfAvailable(registrationInput, options.expectedAgentRef);
		if (!registeredAgentRef && options.expectedAgentRef === null) {
			// A fresh spawn collided with an existing id. If that id is held by a
			// provably-dead parked corpse — no live session, no reviver — reclaim it
			// so this new generation can take the id instead of failing forever at
			// construction. Without this, one such corpse (isolated-run park,
			// interrupted construction) poisons the id for the whole process (#8490).
			// The reclaim is gated by the lifecycle owner and only touches the
			// registry it manages; the corpse's transcript stays at history://.
			const stale = agentRegistry.get(resolvedAgentId);
			const lifecycle = AgentLifecycleManager.global();
			if (stale && lifecycle.manages(agentRegistry) && (await lifecycle.reclaimDeadCorpse(resolvedAgentId, stale))) {
				registeredAgentRef = agentRegistry.registerIfAvailable(registrationInput, null);
			}
		}
		if (!registeredAgentRef) {
			throw new Error(`Agent "${resolvedAgentId}" is already owned by another session generation.`);
		}
		// A reused parked ref remains parked until the new AgentSession is fully
		// constructed and attached. Startup failure therefore leaves it revivable.
		hasRegistered = options.expectedAgentRef === undefined || options.expectedAgentRef === null;

		// Partition the initial enabled set for the xd:// transport. Tool instances
		// remain in the canonical map; only presentation names move between layers.
		// Mounting requires both transport halves in the granted set (`read xd://`
		// discovers, `write xd://<tool>` executes); a session without either keeps
		// every tool top-level instead of auto-granting the missing transport.
		if (toolSession.xdev) {
			const topLevelToolNames: string[] = [];
			const mountedNames: string[] = [];
			for (const name of initialToolNames) {
				const tool = toolRegistry.get(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				if (tool && xdevReadAvailable && xdevWriteAvailable && !explicitlyRequested && isMountableUnderXdev(tool))
					mountedNames.push(name);
				else topLevelToolNames.push(name);
			}
			toolSession.xdev.mountedNames.clear();
			for (const name of mountedNames) toolSession.xdev.mountedNames.add(name);
			initialToolNames = topLevelToolNames;
			if (mountedNames.length > 0 && !initialToolNames.includes("write")) initialToolNames.push("write");
		}

		setSessionActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Keep image blocks off the wire when they'd be rejected: either the user
		// disabled images (`images.blockImages`) or the active model has no vision
		// support. The latter covers switching from a vision model to a text-only
		// one mid-session — historical image blocks would otherwise be replayed to
		// a provider that 400s on them (#5400). Read both dynamically so a `/model`
		// switch or setting change takes effect on the next turn.
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (settings.get("images.blockImages")) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !activeModel.input.includes("image")) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};

		// Final convertToLlm: live provider replay drops API-level refusal errors,
		// then applies secret obfuscation to the remaining outbound context.
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = filterProviderReplayMessages(convertToLlmWithBlockImages(messages));
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};
		// Per-request provider-context transforms. Obfuscate FIRST so secrets are
		// redacted from text before snapcompact rasterizes it into PNG frames. Clamp
		// to the provider budget before normalizing decoder-incompatible images so
		// dropped historical images never pay a transcode cost.
		// URL-mirrored images: providers that fetch image URLs get a broker URL
		// instead of inline base64. Decoration runs LAST among image transforms so
		// the served bytes are exactly the bytes that would have shipped inline.
		const blobBroker = createImageUrlServiceFromSettings(settings, sessionManager.getCwd(), model =>
			modelRegistry.getApiKey(model, providerSessionId),
		);
		blobBroker?.prewarm();
		const snapcompactSystemPromptMode = settings.get("snapcompact.systemPrompt");
		const snapcompactInline =
			snapcompactSystemPromptMode !== "none" || settings.get("snapcompact.toolResults")
				? new SnapcompactInlineTransformer(
						{
							renderSystemPrompt: snapcompactSystemPromptMode,
							renderToolResults: settings.get("snapcompact.toolResults"),
							shape: settings.get("snapcompact.shape"),
						},
						// Journal the tokens each imaged tool result keeps off the wire
						// (frames never reach session.jsonl, so this is their only trace).
						createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
						// With a serving blob broker, frames become lazy URLs: rasterized
						// only when a provider fetches them, never held as pixels here.
						blobBroker?.frameSink,
					)
				: undefined;
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			if (snapcompactInline) transformed = await snapcompactInline.transform(transformed, transformModel);
			transformed = clampProviderContextImages(transformed, transformModel);
			transformed = await normalizeProviderContextImagesForModel(transformed, transformModel);
			if (blobBroker) transformed = await blobBroker.decorateContext(transformed, transformModel);
			// Keep per-request volatility out of the system prompt: the date/cwd
			// reminder rides on the first user turn so open-weight providers keep
			// their tool-schema prefix cache (#7404).
			return withDateCwdReminder(
				transformed,
				formatLocalCalendarDate(),
				normalizePromptPath(sessionManager.getCwd()),
			);
		};
		const onPayload = async (payload: unknown, model?: Model) => {
			return await extensionRunner.emitBeforeProviderRequest(payload, model);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);
		const autoLearnCaptureTools = initialTools.filter(tool => tool.name === "manage_skill" || tool.name === "learn");

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const configuredServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);
		const initialServiceTierByFamily = { ...configuredServiceTierByFamily };
		if (options.openAIServiceTier === null) {
			delete initialServiceTierByFamily.openai;
		} else if (options.openAIServiceTier !== undefined) {
			initialServiceTierByFamily.openai = options.openAIServiceTier;
		}

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps OpenRouter sticky-routing variants, antigravity endpoint routing,
		// in-flight caps, and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		const settingsAwareStreamFn = wrapStreamFnWithBlobUrlFallback(
			wrapStreamFnWithProviderConcurrency(settings, createSettingsAwareStreamFn(settings)),
			blobBroker,
		);
		const codeModeState: { namespacesInfo?: unknown } = {};
		const transformToolCallArguments = (args: Record<string, unknown>): Record<string, unknown> => {
			let result = args;
			const maxTimeout = settings.get("tools.maxTimeout");
			if (maxTimeout > 0 && typeof result.timeout === "number") {
				result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
			}
			if (obfuscator?.hasSecrets()) {
				result = deobfuscateToolArguments(obfuscator, result);
			}
			return result;
		};
		const kimiApiFormatSetting = settings.get("providers.kimiApiFormat");
		const kimiApiFormat = kimiApiFormatSetting === "auto" ? undefined : kimiApiFormatSetting;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat,
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: options.getApiKey ?? (requestModel => modelRegistry.resolver(requestModel, agent.sessionId)),
			streamFn: (streamModel, context, streamOptions) => {
				if (notifyFirstChatDispatch) {
					const cb = notifyFirstChatDispatch;
					notifyFirstChatDispatch = undefined;
					try {
						cb();
					} catch (err) {
						logger.warn("onFirstChatDispatch hook threw", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				const externalThinking =
					settings.get("externalThinking") &&
					agent.state.tools.some(tool => tool.name === "think") &&
					supportsExternalThinking(streamModel);
				return settingsAwareStreamFn(streamModel, context, {
					...streamOptions,
					anthropicCacheRefresh: true,
					forceReasoningOff: externalThinking || streamOptions?.forceReasoningOff,
					...(codeModeState.namespacesInfo === undefined
						? {}
						: { toolNamespacesInfo: codeModeState.namespacesInfo }),
				});
			},
			cursorExecHandlers,
			getCursorTools: () => (toolSession.xdev ? listXdevTools(toolSession.xdev) : []),
			transformToolCallArguments,
			resolveFallbackTool: resolveDeviceTool,
			intentTracing: !!intentField,
			pruneToolDescriptions: inlineToolDescriptors,
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			onToolChoiceUnavailable: () => session?.toolChoiceQueue.reject("unavailable"),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
			if (options.openAIServiceTier !== undefined) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			}
			if (options.openAIServiceTier !== undefined || Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		}

		// Full toolset for the advisor, built unconditionally so it can be toggled at
		// runtime. Bound to a DISTINCT ToolSession (its own `-advisor` session id +
		// agent id) so the advisor's tool state — snapshot, seen-lines, conflict, and
		// summary caches, all keyed on session identity — stays isolated from the
		// primary, while edit/bash/write stay fully functional: the advisor is a full
		// agent and its config's `tools` selects which of these it actually gets
		// (defaulting to read/grep/glob).
		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			hasEditTool: true,
			requireYieldTool: false,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			getAgentId: () => "advisor",
			// The primary's availability signals are wrong for advisors: their tool
			// slate is filtered separately at runtime (default read/grep/glob, no
			// write transport), so xd:// devices are unreachable and read must never
			// advertise inspect_image — images are inlined, and the provider
			// boundary handles text-only advisor models.
			xdev: undefined,
			isToolActive: name => name !== "inspect_image" && toolSession.isToolActive?.(name) === true,
		};
		const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
		for (const name in BUILTIN_TOOLS) {
			advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
		}
		const built = await Promise.all(advisorToolBuilds);
		// Wrapped like every registry tool: `ExtensionToolWrapper` is where the
		// approval mode, per-tool `tools.approval.<tool>` policies and
		// `autoApprove` are enforced. The advisor's loop and its Cursor exec
		// bridge both run these instances directly, so a raw one would execute a
		// `bash`/`write` the user configured as `ask` or `deny`. Meta-notice
		// first, matching the registry's wrap order.
		const advisorTools: Tool[] = built
			.filter((tool): tool is Tool => tool != null)
			.map(tool => new ExtensionToolWrapper(wrapToolWithMetaNotice(tool), extensionRunner) as Tool);

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (initialActiveRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(initialActiveRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the user's standing project rules instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		// Advisor spend recorded before this resume is restored off the critical
		// path below (issue #9553): a large advisor transcript would otherwise
		// block createAgentSession for tens of seconds while the whole file is
		// streamed and parsed on the main thread.
		session = new AgentSession({
			codeModeState,
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			agent,
			pruneToolDescriptions: inlineToolDescriptors,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			thinkingLevelCeiling: options.thinkingLevelCeiling,
			initialRetryFallback,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			settings,
			autoApprove: options.autoApprove,
			scoutAllowedBySpawnPolicy: isScoutSpawnable(undefined, options.spawns ?? "*"),
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			toolRegistry,
			memoryAgentDir: agentDir,
			memoryTaskDepth: taskDepth,
			createMemoryTools: restrictToolNames
				? undefined
				: async () => {
						const tools = await Promise.all(
							MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)),
						);
						return tools.filter((tool): tool is AgentTool => tool !== null);
					},
			createComputerTool: restrictToolNames
				? undefined
				: async () => (await BUILTIN_TOOLS.computer(toolSession)) ?? null,
			createThinkTool: async () => (await HIDDEN_TOOLS.think(toolSession)) ?? null,
			createInspectImageTool: restrictToolNames
				? undefined
				: async () => (await BUILTIN_TOOLS.inspect_image(toolSession)) ?? null,
			createVibeTools:
				(options.taskDepth ?? 0) === 0 && !options.parentTaskPrefix
					? () => createVibeTools(toolSession)
					: undefined,
			builtInToolNames: builtInRegistryToolNames,
			mcpManagerToolNames: initialMcpManagerToolNames,
			transformContext,
			transformProviderContext,
			onPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			advisorStreamFn: settingsAwareStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			getXdevToolEntries: () => (toolSession.xdev ? xdevEntries(toolSession.xdev) : []),
			xdev: toolSession.xdev,
			presentationPinnedToolNames: explicitlyRequestedToolNameSet,
			setActiveToolNames: setSessionActiveToolNames,
			ensureWriteRegistered,
			ensureGoalRegistered,
			getMcpServerInstructions: mcpManager
				? () => {
						const raw = mcpManager.getServerInstructions();
						if (!raw || raw.size === 0) return raw;
						const out = new Map<string, string>();
						for (const [name, text] of raw) {
							out.set(
								name,
								text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
							);
						}
						return out;
					}
				: undefined,
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorTools,
			// Same per-call `grep` seam the primary bridge gets, built against the
			// advisor's own tool session so a `pi_grep` frame's context width and
			// match cap are honored there too.
			advisorCreateGrepTool: createBridgeGrepFactory(advisorToolSession, extensionRunner),
			// Same `replace`-mode requirement as the primary bridge; the advisor
			// path gates it on the advisor's own `edit` grant.
			advisorCreateEditTool: () => createBridgeEditTool(advisorToolSession, extensionRunner),
			// The advisor's bridge tools are wrapped for approval, but the wrapper
			// reads the mode and per-tool policies only from the execute-time
			// context — the primary bridge passes the same store.
			advisorGetToolContext: () => toolContextStore.getContext(),
			// Same live connections the primary bridge reads; an advisor's
			// resource frame would otherwise report every server as empty.
			advisorMcpResources: cursorMcpResources,
			titleSystemPrompt: options.titleSystemPrompt,
		});
		hasSession = true;
		// Backfill the resumed advisor spend without blocking startup: the scan
		// runs after the session is live, so `--resume` no longer scales with the
		// advisor transcript size (issue #9553).
		session.beginInitialAdvisorCostRestore();
		// Extension factories normally register tools before session construction,
		// but Pi-compatible extensions may discover them asynchronously from a
		// session_start handler. Install those late registrations into the live
		// registry and serialize activation so no update can overwrite a sibling.
		const scheduledToolRegistrations = new WeakMap<RegisteredTool, Promise<void>>();
		const scheduleToolRegistration = (registered: RegisteredTool, signal?: AbortSignal): Promise<void> => {
			const scheduled = scheduledToolRegistrations.get(registered);
			if (scheduled) return scheduled;
			const activationSignal = signal ?? AbortSignal.timeout(EXTENSION_HANDLER_TIMEOUT_MS);

			const [wrapped] = wrapRegisteredTools([registered], extensionRunner);
			if (!wrapped) return Promise.resolve();
			const name = registered.definition.name;
			const liveTool = new ExtensionToolWrapper(wrapToolWithMetaNotice(wrapped), extensionRunner);
			// Capture ordinary extension precedence while the listener observes this exact registration.
			// A later same-name registration may replace the extension map before serialized activation runs.
			const isEffectiveRegistrant = extensionRunner.getRegisteredTool(name) === registered;
			const activation = session.runToolRegistryMutation(async () => {
				activationSignal.throwIfAborted();
				const existingTool = toolRegistry.get(name);
				const previousExtensionMcpTool = session.getExtensionMCPTool(name);
				const wasMcpManagerTool = session.hasMCPManagerTool(name);
				if (existingTool) {
					// RPC host tools and SDK custom tools retain their startup precedence when an
					// extension registers the same name later.
					if (session.hasRpcHostTool(name) || sdkCustomToolNames.has(name)) return;
					// Put the replacement first so same-origin MCP re-registration keeps it. Distinct MCP origins still
					// use the stable winner; ordinary tool collisions retain the extension runner's last-wins precedence.
					const competingTools = deduplicateMCPToolsByName([liveTool, existingTool]);
					if (competingTools.length === 1) {
						if (competingTools[0] !== liveTool) return;
					} else if (!isEffectiveRegistrant) {
						return;
					}
				} else if (!isEffectiveRegistrant) {
					return;
				}

				const enabled = session.getEnabledToolNames();
				const alreadyEnabled = enabled.includes(name);
				const explicitlyRequested = explicitlyRequestedToolNameSet?.has(name) === true;
				const mounted = session.getMountedXdevToolNames();
				const wasBuiltIn = builtInRegistryToolNames.has(name);
				toolRegistry.set(name, liveTool);
				builtInRegistryToolNames.delete(name);
				session.setToolBuiltIn(name, false);
				session.setExtensionMCPTool(name, liveTool);
				try {
					if ((registered.definition.defaultInactive || registered.definition.hidden) && !explicitlyRequested) {
						if (!alreadyEnabled) return;
						await session.setActiveToolPresentation(
							enabled.filter(enabledName => enabledName !== name),
							mounted.filter(mountedName => mountedName !== name),
							existingTool !== undefined,
							activationSignal,
						);
						return;
					}
					// Re-registration refreshes the implementation, but it must not reverse an
					// explicit setActiveTools() decision that disabled the previous definition.
					if (existingTool && !alreadyEnabled) return;
					const shouldMount =
						!explicitlyRequested &&
						toolSession.xdev !== undefined &&
						builtInRegistryToolNames.has("read") &&
						builtInRegistryToolNames.has("write") &&
						enabled.includes("read") &&
						enabled.includes("write") &&
						isMountableUnderXdev(liveTool);
					const nextMounted = shouldMount
						? mounted.includes(name)
							? mounted
							: [...mounted, name]
						: mounted.filter(mountedName => mountedName !== name);
					await session.setActiveToolPresentation(
						alreadyEnabled ? enabled : [...enabled, name],
						nextMounted,
						existingTool !== undefined,
						activationSignal,
					);
				} catch (error) {
					if (existingTool) {
						toolRegistry.set(name, existingTool);
					} else {
						toolRegistry.delete(name);
					}
					if (wasBuiltIn) builtInRegistryToolNames.add(name);
					session.setToolBuiltIn(name, wasBuiltIn);
					session.setExtensionMCPTool(name, previousExtensionMcpTool);
					session.setMCPManagerTool(name, wasMcpManagerTool);
					throw error;
				}
			}, activationSignal);
			scheduledToolRegistrations.set(registered, activation);
			return activation;
		};
		if (!restrictToolNames) {
			const unsubscribeToolRegistrations = extensionRunner.onToolRegistered(scheduleToolRegistration);
			disposeCallbacks.add(unsubscribeToolRegistrations);

			// Close the construction race: a background registration can land after
			// the initial snapshot but before the live listener above is attached.
			for (const registered of extensionRunner.getAllRegisteredTools()) {
				if (!initialRegisteredTools.has(registered)) {
					await scheduleToolRegistration(registered);
				}
			}
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
			build: buildLateDiagnosticsBatchMessage,
			isStale: entry => entry.isStale(),
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		if (
			!registeredAgentRef ||
			!agentRegistry.attachSession(
				resolvedAgentId,
				session,
				sessionManager.getSessionFile() ?? null,
				registeredAgentRef,
			) ||
			!agentRegistry.setStatus(resolvedAgentId, "running", registeredAgentRef)
		) {
			throw new Error(`Agent "${resolvedAgentId}" was replaced during session initialization.`);
		}
		hasRegistered = true;
		// MCP notification bridge cleanup — assigned when the bridge is wired below,
		// invoked from the dispose wrapper AND registered as a postmortem so both
		// explicit-dispose (SDK embedders that reuse the process across sessions) and
		// process-exit paths tear the listener down. Nulled after use so the closure
		// graph (`extensionRunner`, `session`) can be GC'd instead of retained by the
		// process-global postmortem list.
		let unsubscribeMcpNotifications: (() => void) | undefined;
		let unregisterMcpPostmortem: (() => void) | undefined;

		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					// Reject new session work (eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						const vibeRegistry = VibeSessionRegistry.global();
						const vibeParentSession = {
							getAgentId: () => resolvedAgentId,
							getSessionId: () => sessionManager.getSessionId(),
							getSessionFile: () => sessionManager.getSessionFile() ?? null,
							sessionManager,
							asyncJobManager: scopedAsyncJobManager,
							settings,
							getActiveModelString,
						};
						await vibeRegistry.suspendScope(vibeRegistry.ownerScope(vibeParentSession), scopedAsyncJobManager);
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose();
				} finally {
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
					unsubscribeMcpNotifications?.();
					unregisterMcpPostmortem?.();
					for (const callback of disposeCallbacks) callback();
					disposeCallbacks.clear();
					// Drop refs so the process-global postmortem list doesn't retain
					// the bridge closure past explicit dispose.
					unsubscribeMcpNotifications = undefined;
					unregisterMcpPostmortem = undefined;
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
			const codexModel = model as Model<"openai-codex-responses">;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = options.getApiKey
							? // `getApiKey` returns a value-or-promise union; unwrap the promise,
								// then resolve the result if it is itself an ApiKeyResolver.
								await resolveApiKeyOnce(await options.getApiKey(codexModel))
							: await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Broker-shared language servers: one server per project, multiplexed
		// across omp instances by the LSP mux daemon. Session-level because the
		// flag lives in module state consulted on every client cold-start.
		setSharedLspEnabled(enableLsp && settings.get("lsp.shared"));

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the lsp tool or an edit/write
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && options.hasUI && settings.get("lsp.lazy")) {
			lspServers = discoverStartupLspServers(cwd, "available");
		} else if (enableLsp && options.hasUI) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		const startMemoryBackend = async () => {
			const memoryBackend = await resolveMemoryBackend(settings);
			await memoryBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
			});
		};

		const runAutoLearnCapture = createAutoLearnCaptureRunner({
			sourceAgent: agent,
			captureTools: autoLearnCaptureTools,
			onPayload,
			onResponse,
			createAgent: captureOptions => {
				const captureModel = captureOptions.initialState?.model;
				const captureSessionId = captureOptions.sessionId;
				if (!captureModel || !captureSessionId) throw new Error("Auto-learn capture identity is incomplete");
				return new Agent({
					...captureOptions,
					cwd: sessionManager.getCwd(),
					cwdResolver: () => sessionManager.getCwd(),
					convertToLlm: convertToLlmFinal,
					transformContext: async messages => wrapSteeringForModel(messages),
					transformProviderContext: async (context, transformModel) => {
						let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
						transformed = clampProviderContextImages(transformed, transformModel);
						transformed = await normalizeProviderContextImagesForModel(transformed, transformModel);
						if (blobBroker) transformed = await blobBroker.decorateContext(transformed, transformModel);
						return withDateCwdReminder(
							transformed,
							formatLocalCalendarDate(),
							normalizePromptPath(sessionManager.getCwd()),
						);
					},
					thinkingBudgets: agent.thinkingBudgets,
					temperature: agent.temperature,
					topP: agent.topP,
					topK: agent.topK,
					minP: agent.minP,
					presencePenalty: agent.presencePenalty,
					repetitionPenalty: agent.repetitionPenalty,
					serviceTierResolver: agent.serviceTierResolver,
					hideThinkingSummary: agent.hideThinkingSummary,
					maxRetryDelayMs: agent.maxRetryDelayMs,
					kimiApiFormat,
					preferWebsockets: preferOpenAICodexWebsockets,
					getToolContext: toolCall => toolContextStore.getContext(toolCall),
					streamFn: settingsAwareStreamFn,
					transformToolCallArguments,
					resolveFallbackTool: resolveDeviceTool,
					intentTracing: !!intentField,
					pruneToolDescriptions: inlineToolDescriptors,
					dialect: resolveDialect(settings.get("tools.format"), captureModel),
					abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
					appendOnlyContext: shouldEnableAppendOnlyContext(
						settings.get("provider.appendOnlyContext"),
						captureModel,
					)
						? new AppendOnlyContextManager()
						: undefined,
				});
			},
		});

		// Auto-learn can immediately trigger a private capture after the first real
		// stop. When a memory backend is selected, install that backend's
		// per-session state first so the capture turn's `learn` tool observes the
		// same initialized state as normal memory tools. Other sessions keep memory
		// startup in the background to preserve the existing startup profile.
		//
		// Gated on `autolearn.enabled` to match the tools: `createTools` builds the
		// `learn`/`manage_skill` registry ONCE at session start and no settings
		// change rebuilds it, so installing the controller while disabled would let a
		// mid-session enable fire a nudge pointing at tools the session never built.
		// Activation is therefore a session-start decision for BOTH the controller
		// and the tools; the fire-time re-check in `#onAgentEnd` still handles a
		// mid-session DISABLE. The subscription lives for the session's lifetime; the
		// reference is intentionally discarded (the listener retains it).
		if (!restrictToolNames) {
			if (settings.get("autolearn.enabled") && taskDepth === 0) {
				await logger.time("startMemoryStartupTask", startMemoryBackend);
				new AutoLearnController({
					session,
					settings,
					capture: content => session.runAutolearnCapture(signal => runAutoLearnCapture(content, signal)),
				});
			} else {
				void logger.time("startMemoryStartupTask", startMemoryBackend);
			}
		}

		// MCP manager wiring has two ownership models:
		//   * Single-slot callbacks (tools/prompts/resources changed) — exactly one
		//     owner per manager. When reusing a parent's manager (subagent path,
		//     see task/executor.ts), the parent already owns these slots so we
		//     MUST NOT overwrite them. Guarded by `!options.mcpManager`.
		//   * Notification listener — multi-listener by design. Every session with
		//     an MCP manager (fresh OR reused) needs its own bridge to its own
		//     `extensionRunner` so extensions loaded in that session receive frames.
		//     Guarded only by `mcpManager` (see the second `if` below).
		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(async tools => {
				try {
					await session.refreshMCPTools(tools);
				} catch (error) {
					logger.warn("MCP tool refresh failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		if (mcpManager) {
			// Bridge server-initiated notifications to this session's extension
			// handlers. Multi-listener registration: fresh-manager and reused-manager
			// sessions both install their own listener here, so a subagent's
			// extensions get frames even though the parent owns the single-slot
			// tool/prompt/resource callbacks above. MCPManager fires known
			// list/update refreshes internally, then invokes all registered
			// listeners with (server, method, params) for every frame (including
			// server-custom methods). Two-layer buffering protects the startup
			// race: MCPManager buffers frames received before the first
			// `addNotificationListener` subscriber (drains here); ExtensionRunner
			// buffers frames received before `initialize()` and drains them on
			// init. Both drop-oldest under pressure at cap 100.
			unsubscribeMcpNotifications = mcpManager.addNotificationListener((server, method, params) => {
				void extensionRunner.emitMcpNotification({ server, method, params });
			});
			// postmortem.register returns a cancel function; capture it so explicit
			// session.dispose can remove this from the global list (see finally above).
			unregisterMcpPostmortem = postmortem.register("mcp-notification-listener-cleanup", () =>
				unsubscribeMcpNotifications?.(),
			);
		}

		startDeferredMCPDiscovery?.(session);

		// Route the initial tool surface through the Code Mode-aware path when the
		// session starts directly on a Codex Code Mode model (`codeMode` `on`, or
		// `auto` matching the model's `code_mode_only` flag): the Agent above was
		// handed the unrestricted `initialTools`, so without this the first and all
		// subsequent turns would expose the full direct tool surface and omit
		// `tool_namespaces_info` until an unrelated model/setting/tool-selection
		// change reconciled.
		try {
			await session.initializeCodeMode();
		} catch (error) {
			logger.warn("Code Mode initialization at session startup failed", { error: String(error) });
		}

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			startBackgroundModelDiscovery: startRuntimeDiscovery,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership. Idempotent with dispose() — Set.delete is a no-op
		// for already-removed listeners.
		unsubscribeCredentialDisabled?.();
		try {
			if (hasSession) {
				await session.dispose();
				if (hasRegistered) unregisterUnlessParked();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await releaseComputerSessionsForOwner(evalKernelOwnerId);
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
				await disposeRubyKernelSessionsByOwner(evalKernelOwnerId);
				await disposeJuliaKernelSessionsByOwner(evalKernelOwnerId);
				await disposeVmContextsByOwner(evalKernelOwnerId);
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}
