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
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Component } from "@oh-my-pi/pi-tui";
import {
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
	formatAdvisorMemoryPrompt,
} from "./advisor";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import {
	MAIN_AGENT_RULE_NAME,
	type Rule,
	ruleCapability,
	setActiveRules,
	SUB_AGENT_RULE_NAME,
} from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import type { EffectiveExtensionRoots } from "./capability/types";
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
import {
	applySettingsTrackedServiceTiers,
	buildServiceTierByFamily,
	SERVICE_TIER_FAMILIES,
} from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { resolveDialect } from "./config/tool-dialect";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "./cursor";
import { createBridgeEditTool, createBridgeGrepFactory } from "./cursor-bridge-tools";
import "./discovery";
import { createImageUrlServiceFromSettings, type ImageUrlService } from "./blob-broker/service";
import { wrapStreamFnWithBlobUrlFallback } from "./blob-broker/stream-fallback";
import { initializeWithSettings } from "./discovery";
import { setInvocationConfiguredExtensions, withOmpExtensionRootScope } from "./discovery/omp-extension-roots";
import { applyMCPEnvironment } from "./mcp/reload";
import { TtsrManager } from "./export/ttsr";
import { disposeVmContextsByOwner } from "./eval/js/context-manager";
import { getEnabledEvalPreludes, type EvalPreludeDefinition } from "./eval/preludes";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import type { EditMode } from "./edit";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	bindPreparedExtensions,
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
	type PreparedExtension,
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
import { LocalProtocolHandler, type LocalProtocolOptions, stripXdUrlPrefix } from "./internal-urls";
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
	shouldFilterBrowserMCPForPrelude,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { resolveMCPToolAlias } from "./mcp/tool-bridge";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "./memory-backend/tool-names";
import type { MnemopiSessionState } from "./mnemopi/state";
import mcpXdevGuidanceTemplate from "./prompts/system/mcp-xdev-guidance.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentKind, type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	buildSecretObfuscator,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "./secrets";
import type { RefreshScope } from "./extensibility/reload";
import { AgentSession, type InitialRetryFallbackState, type PlanYolo, type Prewalk } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { DateCwdReminderInjector } from "./session/date-cwd-reminder";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import { recoverInlineSloppyEdit } from "./session/inline-edit-recovery";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { clampProviderContextImages, dropUnreadableContextImages } from "./session/provider-image-budget";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./session/retry-fallback-chains";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { reconcileSettingsWorkspaceRoots } from "./session/session-workspace";
import {
	collectMountedMCPToolRoutes,
	isSettingGatedTool,
	markSettingGatedTool,
	projectMountedMCPXdevGuidance,
} from "./session/session-tools";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import { createSpeculativeToolExecutionConfig } from "./speculation/host";
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
import { sessionDelegationBias } from "./task/prompt-policy";
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
import { createBrowserPrelude } from "./tools/browser";
import { isMCPToolName, normalizeToolNames } from "./tools/builtin-names";
import { createComputerPrelude } from "./tools/computer";
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
	/**
	 * Allow an explicit {@link model} to be rebound to its same-selector registry
	 * entry after initial background discovery. The CLI enables this for models
	 * it resolved from the registry; SDK-supplied model objects default to false
	 * so caller-owned routing and limits remain authoritative.
	 */
	rebindModelAfterDiscovery?: boolean;
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
	/**
	 * Per-family service tiers for this session, replacing the `tier.*` settings
	 * and any persisted tier history. Called once the initial model is final —
	 * after deferred `modelPattern` resolution and auth fallback — so the caller
	 * can scope a tier to that model's provider family. The result is always
	 * persisted, even when empty, so resume and cold revival restore it instead
	 * of re-deriving tiers from settings.
	 */
	resolveServiceTierByFamily?: (model: Model | undefined) => ServiceTierByFamily;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/**
	 * Re-resolve {@link scopedModels} after a settings refresh moved
	 * `enabledModels`. Supplied by the host, not derived here: an explicit
	 * `--models` pin outranks the setting for the session's lifetime, and that
	 * invocation input is not recoverable from settings. A host that omits this
	 * keeps its launch-time scope, which is what an SDK caller supplying
	 * `scopedModels` directly wants.
	 */
	reconcileScopedModels?: () => Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }> | undefined>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;
	/**
	 * Pre-refresh hook for embedded hosts. Awaited as the first statement inside
	 * {@link AgentSession.refresh}'s critical section, before any config surface
	 * is re-read, so the host can stage fresh skills/rules/settings/MCP to disk
	 * and have that refresh pick them up.
	 */
	onBeforeRefresh?: (scope: RefreshScope) => void | Promise<void>;

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
	 * Live extension-root policy inherited by a child session. Keeps recursive
	 * sub-discovery aligned with the parent while `preloadedExtensionPaths` only
	 * optimizes extension-module loading.
	 *
	 * @internal
	 */
	extensionRoots?: () => EffectiveExtensionRoots;
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
	 * {@link preloadedPreparedExtensions} instead.
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
	 * Compatibility pass-through for callers that do not have prepared factories.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Session-independent imported extension factories. Child sessions rebind
	 * these to their own ExtensionAPI without re-evaluating the module graph.
	 * @internal
	 */
	preloadedPreparedExtensions?: readonly PreparedExtension[];
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

	/**
	 * Root-scoped bus carrying `task:subagent:*` observability frames for this
	 * session and every subagent it spawns. Default: creates a new bus per
	 * root session; `buildSubagentSessionOptions` inherits the spawner's.
	 */
	subagentEventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/**
	 * Marks {@link rules} as an INHERITED parent roster rather than an explicit
	 * restriction. Set by the subagent spawn path, which always forwards the
	 * parent's `session.rules`; a parent's refresh may replace an inherited
	 * roster but must never widen an explicit one.
	 */
	rulesInherited?: boolean;
	/** Whether {@link skills} is a forwarded parent roster rather than a caller restriction. */
	skillsInherited?: boolean;
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
	/**
	 * Agent definition name used to evaluate rule `agents` scoping. Defaults to
	 * "main" for a top-level session / "sub" for a subagent.
	 */
	agentName?: string;
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
	/** Root-scoped bus carrying this session tree's `task:subagent:*` frames. */
	subagentEventBus?: EventBus;
}

// Re-exported from `config/tool-dialect` so the settings reconciliation in
// `AgentSession` can resolve the same way without importing this entry point.
export { type DialectFormat, resolveDialect } from "./config/tool-dialect";

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
	/** Include browser eval-prelude guidance. Default: false. */
	browserEnabled?: boolean;
	/** Include computer eval-prelude guidance and safety policy. Default: false. */
	computerEnabled?: boolean;
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
		browserEnabled: options.browserEnabled,
		computerEnabled: options.computerEnabled,
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
			const definition = customToolToDefinition(tool, sourcePaths?.get(tool.name));
			// `customToolToDefinition` builds a fresh object, so carry the
			// setting-gated marker across: it is what lets a later
			// `refresh('settings')` disable tell this built-in from an extension
			// that re-registered the same name.
			if (isSettingGatedTool(tool)) markSettingGatedTool(definition);
			api.registerTool(definition);
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
	/**
	 * Resolved per capture, not captured once: `autolearn.enabled` is reloadable,
	 * so a session that starts with it off has no capture tools at construction
	 * and every later capture would hit the empty-list guard below even after a
	 * refresh built and activated them.
	 */
	captureTools: () => AgentTool[];
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
		const captureTools = options.captureTools();
		if (captureTools.length === 0 || signal?.aborted) return;
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
				tools: captureTools,
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
	const extensionRoots = options.extensionRoots?.();
	const explicit = extensionRoots?.explicit ?? options.additionalExtensionPaths ?? [];
	const mode = extensionRoots?.mode ?? (options.disableExtensionDiscovery ? "explicit-only" : "merge");
	return await withOmpExtensionRootScope(explicit, mode, () => createAgentSessionScoped(options));
}

async function createAgentSessionScoped(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();
	const subagentEventBus = options.subagentEventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	// Snapshot this session's effective configured lane onto its invocation scope
	// so startup sub-discovery sees the same complete policy that post-startup
	// reloads and recursively spawned children consume.
	const extensionRoots = options.extensionRoots?.();
	setInvocationConfiguredExtensions(
		extensionRoots?.configured ?? settings.get("extensions") ?? [],
		extensionRoots?.configuredLevel ?? settings.extensionsSourceLevel(),
	);

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
	// The roots the current settings value granted, normalized the same way
	// SessionManager normalizes them so the live list can be compared by value.
	// A live re-read reconciles against this set rather than the whole list, so
	// removing a directory from settings actually revokes it while header and
	// `/add-dir` roots stay. Empty when `--add-dir` pinned the list: the
	// listener returns early in that case, so nothing is settings-owned.
	// Seeded from the roots the HEADER records as settings-derived, not from the
	// roots current settings configure. On a resume those differ precisely in
	// the case that matters: a root persisted into the header and then removed
	// from config while the session was stopped is absent from the live value,
	// so a settings-derived seed starts empty, the reconcile sees no change, and
	// the revoked directory stays granted forever. Sessions written before the
	// header carried provenance report nothing, which keeps their roots manual —
	// the prior behaviour, and the safe direction.
	let settingsOwnedRoots = new Set(options.additionalDirectories ? [] : sessionManager.getSettingsOwnedDirectories());
	if (options.additionalDirectories) {
		// `--add-dir` pins the list for the session, so nothing is settings-owned
		// and the reconcile below is skipped entirely. Merge with header roots
		// (resume/fork) rather than replacing them.
		if (configuredDirs.length > 0) {
			const merged = [...new Set([...sessionManager.getAdditionalDirectories(), ...configuredDirs])];
			await sessionManager.setAdditionalDirectories(merged);
		}
	} else {
		// Through the SAME reconcile the live listener uses, so a config edit made
		// while the session was stopped lands exactly as one made while it ran.
		// A merge alone could only ever ADD: with the root removed the live value
		// is empty, `configuredDirs.length > 0` is false, and the header kept
		// granting a directory the config no longer names.
		const { roots, owned } = reconcileSettingsWorkspaceRoots({
			cwd: sessionManager.getCwd(),
			live: sessionManager.getAdditionalDirectories(),
			previouslyOwned: settingsOwnedRoots,
			configured: configuredDirs,
		});
		settingsOwnedRoots = owned;
		await sessionManager.setAdditionalDirectories(roots);
		await sessionManager.setSettingsOwnedDirectories([...owned]);
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
	//
	// `let`, not `const`: `/refresh settings` rebuilds this when `secrets.enabled`
	// moves, and every closure below reads the LOCAL (not a captured copy), so the
	// rebuild reaches `convertToLlmFinal`, `transformProviderContext`, and
	// tool-argument deobfuscation. Frozen, a session that enabled secrets on disk
	// kept sending the configured values to providers while refresh reported the
	// privacy setting updated.
	let obfuscator: SecretObfuscator | undefined = settings.get("secrets.enabled")
		? await buildSecretObfuscator(cwd, agentDir, options.agentDir)
		: undefined;
	// `let`, not `const`: the prompt's `<redacted-content>` block explains that
	// `$$HASH$$` placeholders are intentional opaque values, so it must hold
	// whenever the obfuscator can MINT one. `/refresh settings` rebuilds that
	// obfuscator, and `rebuildSystemPrompt` reads this local — frozen, a session
	// that enabled secrets on disk started emitting placeholders while the prompt
	// still omitted the instruction, so the model read them as errors and tried
	// to "fix" them.
	//
	// Keyed on `hasSecrets()` rather than the `secrets.enabled` flag: that verdict
	// is what every minting path already gates on, so the instruction holds
	// exactly when a placeholder can appear.
	let secretsEnabled = obfuscator?.hasSecrets() === true;

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
	// Whether a thinking level was actually REQUESTED at startup, tracked apart
	// from whether a model was. `options.thinkingLevel` (CLI `--thinking`, and
	// the `:level` suffix `main.ts` lifts off an explicit `--model` selector)
	// starts it; the deferred `modelPattern` path sets it below when the pattern
	// it resolved carried its own suffix. A model supplied WITHOUT any suffix
	// says nothing about thinking — the level then came from
	// `thinking.defaultLevel` or `defaultThinkingLevel`, which must stay
	// settings-tracking so editing that setting and running `refresh('settings')`
	// still reaches the session.
	let explicitThinkingSelector = options.thinkingLevel !== undefined;
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

	// Agent identity must resolve before rule discovery: `agents` frontmatter decides
	// which rules are bucketed into this session at all.
	const isSubagentSession = (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
	const agentKind: AgentKind = isSubagentSession ? SUB_AGENT_RULE_NAME : MAIN_AGENT_RULE_NAME;
	const resolvedAgentName = (options.agentName ?? agentKind).trim().toLowerCase();

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	// `rulebookRules`/`alwaysApplyRules` are reassignable so an in-session
	// `refresh` can swap the roster the `rebuildSystemPrompt` closure renders
	// from (wired via `applyReloadedRoster` below). Without that, a rules refresh
	// would rebuild the prompt from this stale launch-time snapshot.
	let rulebookRules: Rule[];
	let alwaysApplyRules: Rule[];
	const {
		ttsrManager,
		allRules,
		rulebookRules: initialRulebookRules,
		alwaysApplyRules: initialAlwaysApplyRules,
	} = await logger.time("discoverTtsrRules", async () => {
		const ttsrSettings = settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings);
		const rulesResult =
			options.rules !== undefined
				? { items: options.rules, warnings: undefined }
				: await loadCapability<Rule>(ruleCapability.id, { cwd });
		const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
			builtinRules: ttsrSettings.builtinRules,
			disabledRules: ttsrSettings.disabledRules,
			agentName: resolvedAgentName,
		});
		if (existingSession.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
		}
		return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
	});
	rulebookRules = initialRulebookRules;
	alwaysApplyRules = initialAlwaysApplyRules;

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
	// Whether THIS session constructed the manager above, rather than adopting a
	// parent's or the pre-existing process singleton. Only the owner may
	// reconcile process-wide admission limits from its own settings scope.
	const ownsAsyncJobManager = asyncJobManager !== undefined;

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName = options.agentDisplayName ?? agentKind;
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
		let settingGatedBuiltinPermissions: ReadonlySet<string> = new Set();
		// Idempotent: the controller subscribes for the session's lifetime and the
		// reference is intentionally discarded (the listener retains it), so a
		// second construction would double every nudge.
		let autoLearnControllerStarted = false;
		const startAutoLearnController = (): void => {
			// Both callsites run after construction, but the local is nullable until
			// then; a guard rather than a cast, so a future earlier call cannot
			// construct a controller bound to `undefined`.
			const target = session;
			if (autoLearnControllerStarted || !target) return;
			autoLearnControllerStarted = true;
			new AutoLearnController({
				session: target,
				settings,
				capture: content => target.runAutolearnCapture(signal => runAutoLearnCapture(content, signal)),
			});
		};
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
			// Records what THIS invocation permitted, so a later false->true refresh
			// can build a gated built-in without widening a restricted tool list.
			// Captured locally: `createTools` runs long before the session exists,
			// so this cannot forward straight to it.
			setSettingGatedBuiltinPermissions: (names: ReadonlySet<string>) => {
				settingGatedBuiltinPermissions = names;
			},
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
			refresh: scope => session.refresh(scope),
			rules: allRules,
			activeRules: [...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()],
			eventBus,
			subagentEventBus,
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
			getWorkPoolYieldItems: () => session?.getWorkPoolYieldItems() ?? [],
			setWorkPoolYieldItems: items => session.setWorkPoolYieldItems(items),
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
		let browserPrelude: EvalPreludeDefinition | undefined;
		let computerPrelude: EvalPreludeDefinition | undefined;
		const getEvalPreludes = (): readonly EvalPreludeDefinition[] => {
			if (restrictToolNames || !toolRegistry.has("eval") || !activeToolNames.has("eval")) return [];
			const builtins: EvalPreludeDefinition[] = [];
			if (settings.get("browser.enabled")) {
				browserPrelude ??= createBrowserPrelude(toolSession);
				builtins.push(browserPrelude);
			}
			if (settings.get("computer.enabled")) {
				computerPrelude ??= createComputerPrelude(toolSession);
				builtins.push(computerPrelude);
			}
			return getEnabledEvalPreludes(builtins);
		};
		toolSession.getEvalPreludes = getEvalPreludes;

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
		const initialBrowserPreludeAvailable = shouldFilterBrowserMCPForPrelude({
			restrictToolNames,
			browserEnabled: settings.get("browser.enabled"),
			evalRegistered: toolRegistry.has("eval"),
			evalActive: activeToolNames.has("eval"),
		});

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
		// Provider, never a stored value: inherited child policy remains linked to
		// the owning session, while top-level sessions materialize their own live
		// settings on every discovery call.
		const buildSessionExtensionRoots =
			options.extensionRoots ??
			((): EffectiveExtensionRoots => ({
				explicit: options.additionalExtensionPaths ?? [],
				mode: options.disableExtensionDiscovery ? "explicit-only" : "merge",
				configured: settings.get("extensions") ?? [],
				configuredLevel: settings.extensionsSourceLevel(),
			}));
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP only when Eval can expose the built-in browser prelude.
			filterBrowser: initialBrowserPreludeAvailable,
			extensionRoots: buildSessionExtensionRoots(),
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
							// Owned by THIS session's manager, so the key this session
							// installs cannot later be replaced or deleted by a peer
							// top-level session's own startup or refresh.
							applyMCPEnvironment(mcpResult, deferredMCPManager);
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
				applyMCPEnvironment(mcpResult, mcpManager);

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
					// Mark them as the setting's own built-ins so a later
					// `refresh('settings')` disable can tell them from an extension
					// that re-registers the same name (see SETTING_GATED_TOOL_MARKER).
					for (const tool of imageGenTools) markSettingGatedTool(tool);
					customTools.push(...(imageGenTools as unknown as CustomTool[]));
				}
			}

			if (settings.get("speechgen.enabled")) {
				markSettingGatedTool(ttsTool);
				customTools.push(ttsTool as unknown as CustomTool);
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
		//   2. `preloadedPreparedExtensions` (subagent): caller imported modules;
		//      re-bind their factories to THIS session's ExtensionAPI without
		//      evaluating the same module graph again.
		//   3. `preloadedExtensionPaths`: compatibility fallback for callers that
		//      only have paths; imports and binds them for this session.
		//   4. No preload: run the full session discovery.
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
		} else if (options.preloadedPreparedExtensions) {
			extensionPaths = options.preloadedPreparedExtensions.map(prepared => prepared.path);
			extensionsResult = await logger.time(
				"bindPreparedExtensions",
				bindPreparedExtensions,
				options.preloadedPreparedExtensions,
				cwd,
				eventBus,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to bind extension", { path, error });
			}
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
		toolSession.effectiveExtensionRoots = buildSessionExtensionRoots;

		// Inline source ids must remain stable when caller factories are rebound in
		// child sessions. Start after any prepared inline sources so SDK-provided
		// factories (autoresearch/custom tools) keep the same ids as the parent.
		let nextInlineExtensionIndex = 0;
		for (const extension of extensionsResult.extensions) {
			const match = /^<inline-(\d+)>$/.exec(extension.path);
			if (match) {
				nextInlineExtensionIndex = Math.max(nextInlineExtensionIndex, Number(match[1]) + 1);
			}
		}

		// Load inline extensions from factories. Caller-provided factories are safe
		// to rebind, so preserve them with file-backed prepared extensions for
		// `/tan` and other child sessions.
		const rebindableInlineExtensionCount = options.extensions?.length ?? 0;
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const sourceId = `<inline-${nextInlineExtensionIndex++}>`;
				const loaded = await loadExtensionFromFactory(factory, cwd, eventBus, extensionsResult.runtime, sourceId);
				extensionsResult.extensions.push(loaded);
				if (i < rebindableInlineExtensionCount) {
					extensionsResult.preparedExtensions ??= [];
					extensionsResult.preparedExtensions.push({
						path: sourceId,
						resolvedPath: sourceId,
						factory,
						error: null,
					});
				}
			}
		}
		toolSession.preparedExtensions = extensionsResult.preparedExtensions;

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
					// The resolved pattern carried its own `:level` suffix (or
					// inherited the unavailable primary's), so this startup really
					// did request a thinking level.
					explicitThinkingSelector = true;
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
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth), provider =>
					modelRegistry.hasConcreteAuth(provider),
				);

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
						pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth), provider =>
							modelRegistry.hasConcreteAuth(provider),
						);
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
		// xd:// mounts ride the session's write grant: createTools either saw a
		// granted write tool or registered a device-only transport one for an
		// explicit-list session that omitted it, so xdev state always implies one.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const planModeAvailable = settings.get("plan.enabled");
		if (!restrictToolNames && (hasDeferrableTools || planModeAvailable || deferMCPDiscoveryForUI)) {
			await ensureWriteRegistered();
		}

		// oxlint-disable-next-line prefer-const -- captured by device closures before assignment
		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		// Cursor and the agent loop may call a mounted device by its top-level
		// name. Resolve that name from the canonical map and apply the same
		// execution-only ACP decorator used by `write xd://<tool>`; docs and
		// renderer lookup continue to use the undecorated canonical instance.
		//
		// `advertised` is the agent loop's per-request tool snapshot, the very set
		// exact-name dispatch just searched. It is NOT read from `agent.state`:
		// an MCP `tools/list_changed` reassigns the agent's tools mid-stream, so
		// live state can hold a roster the model never saw for this request, and
		// recovering a name against it would dispatch a tool that was never
		// advertised while exact dispatch still answered from the snapshot.
		// Callers with no request snapshot (the Cursor exec bridge) pass none and
		// get device resolution only.
		const resolveDeviceTool = (name: string, advertised: readonly AgentTool[] = []): AgentTool | undefined => {
			const bareName = stripXdUrlPrefix(name);
			const state = toolSession.xdev;
			// An exact mounted name is the name itself, not a guess.
			const exactDevice = state ? resolveMountedXdevExecutable(state, bareName) : undefined;
			if (exactDevice) return exactDevice;
			// One lookup spanning BOTH presentation sets this request can reach, so
			// the uniqueness rule applies across their union: an alias answered by
			// a mounted device AND by a different advertised tool is ambiguous, not
			// a race the mounted set happens to win.
			//
			// `xd://` state exists only when `tools.xdev` is on and the session is
			// unrestricted (`createTools`), so the advertised arm is what recovers
			// an MCP alias when there is no state at all. That arm reads a set
			// already execution-wrapped by `#applyActiveToolsByName`, so a
			// deselected, `defaultInactive`, hidden, or Code Mode-demoted tool
			// stays unreachable and no permission wrapper is bypassed. Only `mcp__`
			// names yield candidates, so no first-party tool is reachable this way.
			return resolveMCPToolAlias(
				bareName,
				candidate =>
					(state ? resolveMountedXdevExecutable(state, candidate) : undefined) ??
					advertised.find(tool => tool.name === candidate),
			);
		};
		// Mounted devices are absent from the advertised tool set, so a miss on a
		// device name has nothing to suggest unless the loop is told they exist.
		const suggestDeviceToolNames = (): Iterable<string> => toolSession.xdev?.mountedNames ?? [];
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
			// Native delete and resource-download frames mutate files without a
			// registry tool. Resolve both the transactional active predicate and
			// live access mode: Agent.state.tools commits only after prompt rebuilding,
			// while this predicate revokes before the await and rolls back on failure.
			allowDirectFileMutation: () =>
				(editWasGranted && toolSession.isToolActive?.("edit") === true) ||
				(toolSession.isToolActive?.("write") === true &&
					toolRegistry.has("write") &&
					toolSession.deviceOnlyWrite !== true),
		});

		// Resolve the inline-descriptors setting against the session-start model.
		// `auto` enforces the per-model policy (inline for Gemini, off otherwise);
		// like the rest of the prune machinery this is fixed for the session, so a
		// mid-session model switch keeps the start-time decision.
		// Read live, per render, for the same reason as `liveIntentField` above:
		// `/refresh settings` can move either on disk, and a value captured here
		// left `rebuildSystemPrompt` rendering the retired tool catalog and
		// eager-task policy until restart. The model id comes from the live agent
		// state so a model swap in the same refresh is reflected too.
		const liveInlineToolDescriptors = (): boolean =>
			shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), agent?.state.model?.id ?? model?.id);
		const liveEagerTasks = (): boolean => settings.get("task.eager") !== "default";
		const liveEagerTasksAlways = (): boolean => settings.get("task.eager") === "always";
		const inlineToolDescriptors = liveInlineToolDescriptors();
		// Read live, per render, for the same reason the workspace tree below is:
		// `tools.intentTracing` decides whether the required intent field is
		// injected into every tool schema, so a value captured here left both the
		// prompt guidance and request assembly on the launch-time policy while a
		// reloaded settings view reported the new one. `PI_INTENT_TRACING` still
		// overrides the setting, checked on each read so the precedence holds.
		const liveIntentField = (): string | undefined =>
			$flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const intentField = liveIntentField();
		// Read live, per render: `/refresh settings` can flip this on disk, and a
		// value captured here would leave the prompt reporting a refresh while the
		// model kept seeing (or kept missing) the tree. The tree itself follows:
		// `liveWorkspaceTree()` reuses a scan while the flag stays on and rescans
		// only when it has nothing valid, so a refresh pays the recursive walk
		// only when the setting actually asks for one.
		//
		// Keyed by the directory it was taken under, not a "have scanned" flag: a
		// session can move to another project between flips, and a boolean latch
		// would then serve the previous project's files forever. Comparing the cwd
		// both invalidates the scan on a move and keeps the flip lazy.
		let workspaceTreeScan: Promise<WorkspaceTree> = workspaceTreePromise;
		let workspaceTreeScanCwd: string | undefined =
			(settings.get("includeWorkspaceTree") ?? false) || options.workspaceTree !== undefined ? cwd : undefined;
		const liveWorkspaceTree = (enabled: boolean, promptCwd: string): Promise<WorkspaceTree> => {
			if (!enabled) return workspaceTreeScan;
			if (workspaceTreeScanCwd !== promptCwd) {
				workspaceTreeScanCwd = promptCwd;
				workspaceTreeScan = logger.time("buildWorkspaceTree", () =>
					buildWorkspaceTree(promptCwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }),
				);
				workspaceTreeScan.catch(() => {});
			}
			return workspaceTreeScan;
		};
		// Latest memory backend instructions rendered for advisor system prompts.
		// Populated by the initial rebuildSystemPrompt below (before the session is
		// constructed) and refreshed on every later rebuild via
		// `setAdvisorMemoryPrompt`.
		let advisorMemoryPrompt: string | undefined;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
			rebuildOptions?: { directToolNames?: readonly string[] },
		): Promise<BuildSystemPromptResult> => {
			const promptCwd = sessionManager.getCwd();
			const renderWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
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
			// Advisors get the same memory block (sharpshooter decisions, mnemopi/
			// hindsight instructions) wrapped as shared background knowledge; the
			// tool-availability caveat lives in the wrapper template.
			advisorMemoryPrompt = formatAdvisorMemoryPrompt(memoryInstructions);
			if (hasSession) session.setAdvisorMemoryPrompt(advisorMemoryPrompt);

			// Build combined append prompt: memory instructions + auto-learn guidance
			// + mounted MCP route guidance + optional MCP server instructions. For UI
			// sessions MCP discovery is deferred, so the initial registry and
			// `getServerInstructions()` are empty until the background connect
			// completes; the rebuild that `refreshMCPTools` triggers post-discovery
			// then picks up the mounted routes and any connected-server instructions.
			const serverInstructions = mcpManager?.getServerInstructions();
			// Drive guidance off the auto-learn BUILTINS this session currently has
			// (provenance, not just an active name): a custom/extension tool that
			// merely shares the name must not earn guidance.
			//
			// Read through the session's LIVE provenance rather than the
			// construction-time `builtInToolNames`, which cannot see the settings
			// reconcile: an off→on edit builds `manage_skill` and would otherwise
			// activate it with no standing guidance, and an on→off edit would keep
			// rendering guidance for tools that are gone. Before the session exists
			// the array is all there is, and it is accurate then.
			// Provenance AND activation: `hasBuiltInTool` keeps reporting a name the
			// disable path removed from the registry (it records what the session
			// BUILT, which is what keeps a re-enable from being mistaken for a
			// custom tool), so guidance for a gated-off tool would survive on that
			// alone.
			const enabledToolNames = hasSession ? session.getEnabledToolNames() : undefined;
			const hasAutoLearnBuiltin = (name: string): boolean =>
				enabledToolNames
					? session.hasBuiltInTool(name) && enabledToolNames.includes(name)
					: builtInToolNames.includes(name);
			const autoLearnInstructions = restrictToolNames
				? undefined
				: buildAutoLearnInstructions({
						manageSkill: hasAutoLearnBuiltin("manage_skill"),
						learn: hasAutoLearnBuiltin("learn"),
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
				nativeTools && !liveInlineToolDescriptors() ? { mode: "compact", toolNames } : { mode: "full" },
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
				skills: settings.get("skillful") ? (session?.skills ?? skills) : [],
				contextFiles,
				tools: promptTools,
				toolNames,
				directToolNames: rebuildOptions?.directToolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				inlineToolDescriptors: liveInlineToolDescriptors(),
				nativeTools,
				intentField: liveIntentField(),
				eagerTasks: liveEagerTasks(),
				eagerTasksAlways: liveEagerTasksAlways(),
				taskBatch: settings.get("task.batch"),
				taskMaxConcurrency: settings.get("task.maxConcurrency"),
				scoutAvailable: isScoutSpawnable(
					settings.get("task.disabledAgents") as string[] | undefined,
					options.spawns ?? "*",
				),
				delegationBias: sessionDelegationBias(toolSession),
				taskIrcEnabled: !restrictToolNames && isIrcEnabled(settings, options.taskDepth ?? 0),
				autoQaEnabled: !restrictToolNames && isAutoQaEnabled(settings),
				writeTransportOnly:
					toolSession.deviceOnlyWrite === true && toolSession.pendingFullWriteDescription !== true,
				secretsEnabled,
				workspaceTree: liveWorkspaceTree(renderWorkspaceTree, promptCwd),
				includeWorkspaceTree: renderWorkspaceTree,
				memoryRootEnabled: memoryBackend?.id === "local",
				securityEnabled: settings.get("security.enabled"),
				browserEnabled: getEvalPreludes().some(definition => definition.name === "browser"),
				computerEnabled: getEvalPreludes().some(definition => definition.name === "computer"),
				model: getActiveModelString(),
				includeModelInPrompt: settings.get("includeModelInPrompt"),
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
				renderMermaid: settings.get("tui.renderMermaid"),
				reactions: agentKind === "main" && options.hasUI === true && settings.get("tui.reactions"),
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
		// Session-managed builtins may be force-included by createTools. Keep the
		// active set consistent with that registry decision, using built-in
		// provenance so same-named extension tools are never force-activated.
		if (!restrictToolNames && explicitlyRequestedToolNames) {
			for (const name of ["manage_skill", "learn", "context_notes", "new_context"]) {
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
			(explicitlyRequestedToolNameSet === undefined ||
				explicitlyRequestedToolNameSet.has("write") ||
				toolSession.deviceOnlyWrite === true);
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
		// discovers, `write xd://<tool>` executes); explicit-list sessions granted
		// `read` without `write` can use the device-only transport registered by
		// createTools without surfacing it when no device needs it.
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
			const deviceTransportNeeded =
				mountedNames.length > 0 ||
				initialToolNames.some(name => toolRegistry.get(name)?.deferrable === true) ||
				toolSession.getPlanModeState?.()?.enabled === true;
			if (deviceTransportNeeded && xdevWriteAvailable && !initialToolNames.includes("write")) {
				initialToolNames.push("write");
			}
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
		// Rebuildable for the same reason as the snapcompact transformer below: the
		// whole `images.urls.*` group is reloadable, and the request path closes
		// over this BINDING, so a reload can construct one where there was none
		// (enabling), drop it (disabling), or replace one whose backends or
		// credentials moved — instead of leaving the retired instance publishing
		// through the old configuration.
		const buildBlobBroker = (): ImageUrlService | undefined =>
			createImageUrlServiceFromSettings(settings, sessionManager.getCwd(), model =>
				modelRegistry.getApiKey(model, providerSessionId),
			);
		let blobBroker = buildBlobBroker();
		blobBroker?.prewarm();
		const dateCwdReminder = new DateCwdReminderInjector();
		// Built from settings that `/refresh settings` can change, and the request
		// path closes over this binding rather than an instance, so a reload can
		// construct one where there was none (enabling) or drop it (disabling) —
		// not just update the merged value while the old instance keeps running.
		const buildSnapcompactInline = (): SnapcompactInlineTransformer | undefined => {
			const renderSystemPrompt = settings.get("snapcompact.systemPrompt");
			const renderToolResults = settings.get("snapcompact.toolResults");
			if (renderSystemPrompt === "none" && !renderToolResults) return undefined;
			return new SnapcompactInlineTransformer(
				{ renderSystemPrompt, renderToolResults, shape: settings.get("snapcompact.shape") },
				// Journal the tokens each imaged tool result keeps off the wire
				// (frames never reach session.jsonl, so this is their only trace).
				createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
				// With a serving blob broker, frames become lazy URLs: rasterized
				// only when a provider fetches them, never held as pixels here.
				blobBroker?.frameSink,
			);
		};
		let snapcompactInline = buildSnapcompactInline();
		// Reconfigure in place when one already exists, so the render caches (and
		// the savings journal's identity) survive a change that does not retire
		// the frames they hold.
		const reloadSnapcompactInline = () => {
			const renderSystemPrompt = settings.get("snapcompact.systemPrompt");
			const renderToolResults = settings.get("snapcompact.toolResults");
			if (renderSystemPrompt === "none" && !renderToolResults) {
				snapcompactInline = undefined;
				return;
			}
			const next = { renderSystemPrompt, renderToolResults, shape: settings.get("snapcompact.shape") };
			if (snapcompactInline) snapcompactInline.reconfigure(next);
			else snapcompactInline = buildSnapcompactInline();
		};
		// The frame sink is read off the broker when a transformer is BUILT, so a
		// broker swap has to rebuild the transformer too — reconfiguring in place
		// would leave it publishing frames through the retired instance.
		const reloadBlobBroker = async (): Promise<void> => {
			const retired = blobBroker;
			blobBroker = buildBlobBroker();
			blobBroker?.prewarm();
			snapcompactInline = buildSnapcompactInline();
			// Last: the replacement is already serving, so a slow tunnel teardown
			// never leaves the session without a broker.
			await retired?.dispose();
		};
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			if (snapcompactInline) transformed = await snapcompactInline.transform(transformed, transformModel);
			transformed = clampProviderContextImages(transformed, transformModel);
			transformed = await normalizeProviderContextImagesForModel(transformed, transformModel);
			// After the model-specific normalizers: they carry better wording for the
			// cases they own (STB WebP), so this stays the backstop for everything
			// else, and it runs before the blob broker uploads any of these bytes.
			transformed = await dropUnreadableContextImages(transformed, transformModel);
			const activeBlobBroker = blobBroker;
			if (activeBlobBroker) transformed = await activeBlobBroker.decorateContext(transformed, transformModel);
			// Keep per-request volatility out of the system prompt: the date/cwd
			// reminder rides on the first user turn so open-weight providers keep
			// their tool-schema prefix cache (#7404).
			return dateCwdReminder.transform(
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
		const AUTO_LEARN_CAPTURE_TOOL_NAMES = ["manage_skill", "learn"];
		const autoLearnCaptureTools = initialTools.filter(tool => AUTO_LEARN_CAPTURE_TOOL_NAMES.includes(tool.name));
		// Resolved per capture from the LIVE registry: `autolearn.enabled` moves
		// mid-session, so a session that started with it off has an empty list
		// here and would keep hitting the capture runner's empty-list guard after
		// a refresh built the tools. Falls back to the construction-time list
		// before the session exists.
		const liveAutoLearnCaptureTools = (): AgentTool[] => {
			if (!hasSession) return autoLearnCaptureTools;
			return AUTO_LEARN_CAPTURE_TOOL_NAMES.map(name => session.getToolByName(name)).filter(
				(tool): tool is AgentTool => tool !== undefined,
			);
		};

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		// `model` is final here: deferred patterns, auth fallback, and extension
		// role reclaim have all run, so a resolver can scope tiers to its family.
		const resolvedServiceTierByFamily = options.resolveServiceTierByFamily?.(model);
		const configuredServiceTierByFamily =
			resolvedServiceTierByFamily ??
			(hasServiceTierEntry
				? // A receipt exists, so it wins — EXCEPT for the families it recorded as
					// still following `tier.*`. Those are re-derived from the live config, so
					// a `tier.*` edit made while the session was stopped is not overridden by
					// the value that receipt happened to capture (a stale tier no later
					// refresh could detect, since `Settings` has already loaded the new one).
					applySettingsTrackedServiceTiers(
						existingSession.serviceTier ?? {},
						existingSession.serviceTierSettingsTrackingFamilies,
						buildServiceTierByFamily(
							settings.get("tier.openai"),
							settings.get("tier.anthropic"),
							settings.get("tier.google"),
						),
					)
				: buildServiceTierByFamily(
						settings.get("tier.openai"),
						settings.get("tier.anthropic"),
						settings.get("tier.google"),
					));
		const persistInitialServiceTier =
			options.openAIServiceTier !== undefined || resolvedServiceTierByFamily !== undefined;
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
			// Read live, so a broker built or swapped by a settings reload is the one
			// this request recovers through.
			() => blobBroker,
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
		// Live-bound speculation config: the Agent captures this object once at
		// construction but reads `enabled` per turn (and `maxInFlight` per drain)
		// through getters, so mid-session settings UI toggles take effect without
		// a session recreate. The single shared host keeps its evidence across
		// toggles; per-turn coordinator close never touches it.
		const speculativeToolExecution = createSpeculativeToolExecutionConfig(settings, toolSession, extensionRunner);

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
			// A stray sloppy payload in plain text becomes a real edit tool call so
			// the normal pipeline (validation, approval, rendering) executes it.
			transformAssistantMessage: message => {
				if (!settings.get("edit.recoverInlineEdits")) return;
				// The live tool is an ExtensionToolWrapper whose proxy forwards the
				// EditTool `mode` getter; a bridge/custom edit tool without a sloppy
				// mode (e.g. Cursor's replace-pinned pi_edit) never recovers.
				const editTool = agent.state.tools.find(tool => tool.name === "edit") as { mode?: EditMode } | undefined;
				if (editTool?.mode !== "sloppy") return;
				const recovered = recoverInlineSloppyEdit(message);
				if (recovered > 0) {
					logger.info("recovered inline sloppy edit payload into edit tool call", { regions: recovered });
				}
			},
			resolveFallbackTool: resolveDeviceTool,
			suggestFallbackToolNames: suggestDeviceToolNames,
			intentTracing: !!intentField,
			pruneToolDescriptions: inlineToolDescriptors,
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			speculativeToolExecution,
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

		// An EXPLICIT startup model (`options.model` / `options.modelPattern`, incl.
		// CLI `--model`) is a user pin, exactly like an in-session `/model` pick, and
		// must be recorded with role `default` on BOTH startup paths. On a resumed
		// branch whose latest non-ephemeral `model_change` is role-less,
		// `AgentSession.#hasSessionModelOverride()` would otherwise classify the
		// explicitly requested model as settings-tracking, and the next
		// `refresh('settings')` would replace it with the configured default.
		const explicitStartupModel = hasExplicitModel ? model : undefined;
		// An EXPLICIT thinking selection — `options.thinkingLevel` (incl. CLI
		// `--thinking`, which is also where `main.ts` puts an explicit model
		// selector's `:level` suffix), or a resolved `modelPattern`'s own suffix
		// — is a session pin a settings reload must not clobber, exactly as an
		// explicit model is. Hoisted above the branch: BOTH startup paths must
		// record it, and a settings-DERIVED level stays settings-tracking so a
		// later `refresh('settings')` may re-derive it.
		//
		// A model given WITHOUT a thinking suffix is deliberately NOT enough. It
		// pins the model only; the level then came from the model's
		// `thinking.defaultLevel` or the global `defaultThinkingLevel`, and
		// classifying that as a pin wrote an unflagged receipt that made
		// `thinkingFollowsSettings()` read `false` forever — so editing
		// `defaultThinkingLevel` and running `refresh('settings')` left the old
		// level active with nothing the user could do about it short of an
		// explicit re-selection.
		const explicitStartupThinking = explicitThinkingSelector;
		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
			if (explicitStartupModel) {
				sessionManager.appendModelChange(`${explicitStartupModel.provider}/${explicitStartupModel.id}`, "default");
			}
			// An explicit thinking selection needs its pin receipt on the RESUMED
			// path too. Startup applies `options.thinkingLevel` to the new `Agent`
			// either way, but with no receipt on the branch
			// `AgentSession.#thinkingFollowsSettings()` sees only the prior
			// session's entry (or none) and falls through to its follows-settings
			// default, so the next unrelated `refresh('settings')` overwrote the
			// explicitly requested level. Only an EXPLICIT choice writes here: a
			// settings-derived resume must keep tracking the configured default,
			// and the level it resolved to is already restored from the branch.
			if (explicitStartupThinking) {
				if (autoThinking) {
					// `configured: auto` so the pin records the SELECTOR, not the
					// provisional effort — same reason as the new-session branch.
					sessionManager.appendThinkingLevelChange(effectiveThinkingLevel, AUTO_THINKING);
				} else {
					sessionManager.appendThinkingLevelChange(effectiveThinkingLevel, undefined, {
						settingsTracking: false,
					});
				}
			}
			if (persistInitialServiceTier) {
				// Provenance travels with this receipt too. Being the LATEST receipt,
				// it decides what a later resume restores — so omitting the list here
				// cleared the provenance a prior receipt carried and froze the other
				// families alongside the intentional OpenAI pin, where no subsequent
				// refresh could detect an offline `tier.*` edit.
				//
				// CARRIED from the restored receipt rather than re-derived: only the
				// flag's own family changes provenance here, and re-deriving would
				// hand tracking back to a family an earlier `/fast` or selector had
				// deliberately pinned.
				//
				// A host RESOLVER overrides the carry for the same reason it does on
				// the fresh-session path: it is evaluated against the final model and
				// its answer is the intended tier set, so no family may keep
				// following `tier.*` over it.
				const carriedTrackingFamilies =
					resolvedServiceTierByFamily !== undefined
						? []
						: (existingSession.serviceTierSettingsTrackingFamilies ?? []).filter(family => family !== "openai");
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
					carriedTrackingFamilies,
				);
			}
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				// A settings-derived startup stays role-less (still tracks the
				// configured default and remains swappable).
				sessionManager.appendModelChange(
					`${model.provider}/${model.id}`,
					explicitStartupModel ? "default" : undefined,
				);
			}
			if (!autoThinking) {
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel, undefined, {
					settingsTracking: !explicitStartupThinking,
				});
			} else if (explicitStartupThinking) {
				// An EXPLICITLY selected `auto` is a session pin too, and it needs a
				// receipt to say so. A settings-derived `auto` writes nothing (the
				// per-turn classifier persists its concrete effort once a real user
				// turn runs, and an absent entry already reads as follows-settings),
				// but an explicit one has nowhere else to record the pin: every
				// classifier receipt is `autoResolved`, which
				// `AgentSession.#thinkingFollowsSettings()` deliberately walks PAST,
				// so the branch would hold no selection at all and fall through to
				// that scan's follows-settings default — letting an unrelated
				// `refresh('settings')` replace the user's `auto` with the
				// configured/model fallback. `configured: auto` (not the provisional
				// effort) so resume restores the selector, not the effort it
				// happened to show.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel, AUTO_THINKING);
			}
			if (persistInitialServiceTier || Object.keys(initialServiceTierByFamily).length > 0) {
				// Which families still FOLLOW `tier.*`, so a tier edited while this
				// session is stopped is re-derived on resume instead of being
				// overridden by the value this receipt captured. Every family here
				// came from the config above; only `--openai-service-tier` is a real
				// pin, and it pins openai alone — the others keep their provenance.
				// EVERY family, not just the ones currently set. A family configured
				// as `none` has no key in the map, so keying off the map omitted it —
				// and then adding `tier.google` while the session was stopped could
				// never be picked up, since restoration replays a map with no Google
				// provenance and `Settings` already holds the new value. Only the
				// flag is a real pin, and it pins openai alone.
				// A host RESOLVER is a pin too, and it speaks for every family: it is
				// evaluated against the final model and its answer — including an
				// EMPTY map — is the intended tier set, not a config reading. Marking
				// those families settings-tracking made a revival re-derive
				// `tier.*` over them, so a spawn that deliberately resolved to no
				// tier came back carrying the config's.
				const settingsTrackingFamilies =
					resolvedServiceTierByFamily !== undefined
						? []
						: SERVICE_TIER_FAMILIES.filter(
								family => !(family === "openai" && options.openAIServiceTier !== undefined),
							);
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
					settingsTrackingFamilies,
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
			// The primary may carry a dormant xd:// write transport. Advisors use
			// their own configured tool slate, so a selected write is always full.
			deviceOnlyWrite: undefined,
			pendingFullWriteDescription: undefined,
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
			// write transport), so xd:// devices are unreachable. Images are inlined,
			// and the provider boundary handles text-only advisor models.
			xdev: undefined,
			isToolActive: name => toolSession.isToolActive?.(name) === true,
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
			advisorMemoryPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorSharedMaxNotesPerUpdate: discoveredAdvisors.sharedMaxNotesPerUpdate,
			advisorConfigs: discoveredAdvisors.advisors,
			advisorConfigWarnings: discoveredAdvisors.warnings,
			agent,
			pruneToolDescriptions: inlineToolDescriptors,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			thinkingLevelCeiling: options.thinkingLevelCeiling,
			initialRetryFallback,
			prewalk: options.prewalk,
			onBeforeRefresh: options.onBeforeRefresh,
			planYolo: options.planYolo,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			settings,
			additionalExtensionPaths: options.additionalExtensionPaths,
			extensionRoots: buildSessionExtensionRoots,
			preparedExtensions: extensionsResult.preparedExtensions,
			extensionPaths,
			disableExtensionDiscovery: options.disableExtensionDiscovery,
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
			reconcileScopedModels: options.reconcileScopedModels
				? async () => {
						const next = await options.reconcileScopedModels?.();
						// `undefined` means the host declines (an explicit `--models`
						// pin); an empty array is a real result — the edit CLEARED the
						// scope, and every model becomes available again.
						if (next) session.setScopedModels(next);
					}
				: undefined,
			promptTemplates,
			slashCommands,
			extensionRunner,
			getEvalPreludes,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsReloadable: options.skills === undefined,
			skillsSettings: settings.getGroup("skills"),
			// Only the caller-supplied rule policy (SDK `rules` / `--no-rules`), not
			// the disk-discovered set: present, an in-session refresh re-buckets it
			// instead of re-scanning disk, so it cannot re-enable ambient rules the
			// session excluded. `undefined` keeps the roster-editing disk re-scan.
			rules: options.rules,
			// Whether that policy is the parent's INHERITED roster (the subagent
			// spawn path always forwards `session.rules`) rather than a caller
			// restriction. A parent refresh may replace the former in a running
			// child; the latter it must never widen.
			rulesInherited: options.rulesInherited,
			skillsInherited: options.skillsInherited,
			// The session's initial discovered roster (rulebook + always-apply), so
			// a settings-only `refresh` re-buckets the COMPLETE set against the
			// reloaded TTSR gating and drops only newly-gated rules — instead of
			// re-bucketing from TTSR entries alone (empty non-TTSR set) and wiping
			// every non-TTSR rule from the published active rules and next prompt.
			initialRosterRules: [...rulebookRules, ...alwaysApplyRules],
			// The complete UNGATED discovery output. A settings-only `refresh`
			// re-buckets THIS set, so toggling `ttsr.disabledRules`/`builtinRules`
			// applies in both directions: re-bucketing only the gated roster above
			// could never restore a rule whose disable entry the user reverted.
			initialSourceRules: allRules,
			// The same name init bucketed with, so a refresh re-buckets under this
			// session's agent scope rather than admitting every agent-scoped rule.
			agentRuleName: resolvedAgentName,
			modelRegistry,
			rebindModelAfterDiscovery: options.model === undefined || options.rebindModelAfterDiscovery === true,
			toolRegistry,
			// Reapplies `enableLsp && lsp.shared` onto the module-level flag in
			// `lsp/client.ts`. Owned here because `enableLsp` is a construction
			// input (`--no-tools`, a restricted subagent set) the session cannot
			// re-derive from settings.
			reconcileSharedLsp: () => setSharedLspEnabled(enableLsp && settings.get("lsp.shared")),
			// Off→on for `autolearn.enabled`. The construction-time half
			// (`restrictToolNames`, task depth) is captured in the closure, so a
			// settings edit cannot widen it.
			reconcileAutoLearn: () => {
				if (restrictToolNames || taskDepth !== 0) return;
				if (!settings.get("autolearn.enabled")) return;
				startAutoLearnController();
			},
			reconcileBrowserMcpFilter: mcpManager
				? async enabled => {
						await mcpManager.reconcileBrowserFilter(enabled);
						return mcpManager.getTools();
					}
				: undefined,
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
			createThinkTool: async () => (await HIDDEN_TOOLS.think(toolSession)) ?? null,
			// Builds one boolean-gated core built-in on demand. Uses the same
			// factory table and tool session as startup, so the tool binds to this
			// session's cwd/exec rather than a re-derived context.
			createBooleanGatedTool: async (name: string) => {
				const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
				if (!factory) return null;
				const built = await factory(toolSession);
				return built ? wrapToolWithMetaNotice(built) : null;
			},
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
			// An in-session `refresh` re-scans the roster and threads the fresh
			// buckets back here. Reassigning the closure locals `rebuildSystemPrompt`
			// reads is what makes a rules refresh reach the model prompt — without
			// it, `refreshBaseSystemPrompt()` would rebuild from the stale
			// launch-time snapshot. Skills bind a per-session snapshot updated
			// separately (`applyReloadedSkills`); the prompt reads `session.skills`.
			applyReloadedRoster: roster => {
				rulebookRules = roster.rulebookRules;
				alwaysApplyRules = roster.alwaysApplyRules;
				// Re-publish the session's OWN rule snapshot too. `rule://`
				// resolution prefers `context.rules` (this array) over the process
				// global, so leaving it at the launch-time value serves stale rule
				// content — and hides a newly added rule — from every tool that
				// threads `session.activeRules`.
				//
				// The TTSR part is the set the refresh already PUBLISHED, never
				// `ttsrManager.getRules()`: that registry deliberately retains
				// registrations while TTSR is globally disabled, so re-deriving
				// from it here re-added rules the published global set omits — a
				// condition-only rule stayed addressable through `rule://` with no
				// bucket to justify it, and a described one was listed twice,
				// while the reported count came from the narrowed set. Both
				// snapshots must be the rule set a FRESH session under the current
				// gating would hold, so both read the same answer.
				toolSession.activeRules = [
					...roster.rulebookRules,
					...roster.alwaysApplyRules,
					...roster.publishedTtsrRules,
				];
				// And the SPAWN-facing field, which is a different set: children
				// receive `rules: session.rules` as `options.rules`, and a defined
				// `options.rules` is the child's authoritative rule policy (it skips
				// the disk scan and buckets exactly this list). Left at the
				// launch-time `allRules`, a rule added or edited before the spawn was
				// silently absent from the new child's prompt and `rule://` snapshot.
				//
				// The UNGATED source roster is the right value: the gated buckets
				// above are THIS session's applicable set, so forwarding them would
				// bake this session's `ttsr.disabledRules`/`agents` scoping into the
				// child as an unrecoverable policy — the child could never restore a
				// rule whose disable entry the user later reverted, and a rule scoped
				// to the child's own agent would be missing outright.
				toolSession.rules = [...roster.sourceRules];
			},
			getXdevToolEntries: () => (toolSession.xdev ? xdevEntries(toolSession.xdev) : []),
			xdev: toolSession.xdev,
			presentationPinnedToolNames: explicitlyRequestedToolNameSet,
			setActiveToolNames: setSessionActiveToolNames,
			ensureWriteRegistered,
			isDeviceOnlyWrite: () => toolSession.deviceOnlyWrite === true,
			setDeviceOnlyWrite: enabled => {
				toolSession.deviceOnlyWrite = enabled ? true : undefined;
			},
			setPendingFullWriteDescription: enabled => {
				toolSession.pendingFullWriteDescription = enabled ? true : undefined;
			},
			ensureGoalRegistered,
			// Rebuilds a setting-gated tool set (`generate_image`, `tts`) when its
			// setting is turned on after construction. Reproduces the SAME startup
			// gates the initial install applies, so a group this session was never
			// allowed to have stays absent: `restrictToolNames` installs no custom
			// tools at all, and an explicit `--no-tools`/tool whitelist that omits
			// `generate_image` must keep omitting it (issue #5305) — image-gen is
			// force-activated, so honoring the whitelist here is the only filter.
			// Returns the raw `CustomTool`s; the session adapts and wraps them
			// against its own live tool context, exactly as an MCP tool refresh does.
			createSettingGatedTools: async setting => {
				if (restrictToolNames) return [];
				if (setting === "speechgen.enabled") return [ttsTool as unknown as CustomTool];
				if (options.toolNames && !options.toolNames.includes("generate_image")) return [];
				const imageGenTools = await getImageGenTools(modelRegistry, agent.state.model ?? model);
				return imageGenTools as unknown as CustomTool[];
			},
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
			// The manager THIS session was built with (owned or the parent's), so an
			// in-session refresh reconnects it rather than the process-global
			// `MCPManager.instance()` — which, with multiple top-level sessions, may
			// be a different session's manager.
			mcpManager,
			ttsrManager,
			obfuscator,
			// Reassigns the closure local, so the rebuild reaches
			// `convertToLlmFinal`/`transformProviderContext`/tool-argument
			// deobfuscation — the consumers that read `obfuscator` directly and
			// which a session-only swap would never touch. The session installs the
			// returned instance as its own live value.
			//
			// It also refreshes the `secretsEnabled` local that `rebuildSystemPrompt`
			// renders the `<redacted-content>` block from, and reports whether that
			// verdict MOVED so the caller can rebuild the prompt. Reporting the
			// move (rather than rebuilding here) keeps the decision with
			// `#doRefresh`, which already batches every prompt-affecting change into
			// one rebuild at the end — and keeps a steady-state refresh
			// byte-identical so provider prompt caching keeps hitting.
			rebuildObfuscator: async () => {
				obfuscator = settings.get("secrets.enabled")
					? // The session's CURRENT directory, like the rest of refresh
						// (`settings.reload()`, the roster reload, the prompt's repo
						// context). `/move` and a cross-project resume repoint it, and
						// the project half of the secret set is `<cwd>/.omp/secrets.yml`
						// — so rebuilding from the construction-time value read the
						// ORIGINAL project's file, leaving the destination project's
						// secrets unobfuscated in provider requests while the source
						// project's substitutions kept being applied.
						//
						// `agentDir`/`options.agentDir` deliberately stay
						// construction-time: they locate the GLOBAL secrets.yml and the
						// placeholder-key file, neither of which is project-scoped, and
						// the key must stay stable for the session's lifetime so
						// placeholders already minted into the transcript keep
						// deobfuscating after a move.
						await buildSecretObfuscator(sessionManager.getCwd(), agentDir, options.agentDir)
					: undefined;
				const nextSecretsEnabled = obfuscator?.hasSecrets() === true;
				const promptStateChanged = nextSecretsEnabled !== secretsEnabled;
				secretsEnabled = nextSecretsEnabled;
				return { obfuscator, promptStateChanged };
			},
			agentId: resolvedAgentId,
			agentKind,
			// Retain the registry this session was created against so refresh's skill
			// fan-out targets THIS tree's descendants, not a foreign global tree.
			agentRegistry,
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
		// Hand over what `createTools` recorded: it ran before this session
		// existed, so the set was parked in a local until now.
		session.setSettingGatedBuiltinPermissions(settingGatedBuiltinPermissions);
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
						(enabled.includes("write") || toolSession.deviceOnlyWrite === true) &&
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

		// Both settings are read once at startup into an object that owns the
		// behaviour from then on, so `/refresh settings` updating the merged value
		// alone leaves the live session on the launch-time value while reporting
		// success. Push the new value into the owner instead.
		const unsubscribeLiveWorkspaceSettings = settings.onEffectiveChange((path, value) => {
			if (path === "async.maxJobs") {
				// Owner only. `scopedAsyncJobManager` is the process-wide singleton
				// when this session inherited it (a structured subagent, which takes
				// `AsyncJobManager.instance()`), so a child reloading its own
				// project-scoped `async.maxJobs` would rewrite the PARENT's admission
				// limit and start rejecting or admitting the parent's jobs.
				if (ownsAsyncJobManager) {
					// Same clamp as construction, so a config edit cannot widen the cap
					// past what a launch-time value could have asked for.
					scopedAsyncJobManager?.setMaxRunningJobs(Math.min(100, Math.max(1, (value as number) ?? 100)));
				}
				return;
			}
			if (
				path === "snapcompact.systemPrompt" ||
				path === "snapcompact.toolResults" ||
				path === "snapcompact.shape"
			) {
				reloadSnapcompactInline();
				return;
			}
			if (path.startsWith("images.urls.")) {
				// Matched by PREFIX: every key under the group feeds the service's
				// construction — enablement, backends, credentials, TTL, the exposure
				// options — so naming them individually would leave the next one
				// added silently unreconciled.
				session.registerHostReconciliation(
					reloadBlobBroker().catch(error =>
						logger.warn("Failed to apply refreshed image URL settings", { error: String(error) }),
					),
				);
				return;
			}
			if (path !== "workspace.additionalDirectories") return;
			// An explicit `--add-dir` list owns the roots for the session; a config
			// edit must not override what the invocation pinned.
			if (options.additionalDirectories) return;
			// Reconcile against the roots the PREVIOUS settings value granted, not
			// against the live list: the live list already contains them, so a union
			// could never revoke a removed root. See
			// `reconcileSettingsWorkspaceRoots` for why the origin has to be tracked.
			//
			// Resolved against the session's CURRENT directory, not the
			// construction-time `cwd`: after `/move` or a cross-project resume both
			// `SessionManager` and `Settings` already point at the destination, so a
			// relative root like `../shared` would otherwise normalize under the old
			// project and grant a directory the operator never named.
			const { roots, owned } = reconcileSettingsWorkspaceRoots({
				cwd: sessionManager.getCwd(),
				live: sessionManager.getAdditionalDirectories(),
				previouslyOwned: settingsOwnedRoots,
				configured: Array.isArray(value) ? (value as string[]) : [],
			});
			settingsOwnedRoots = owned;
			// Started eagerly, and the handle is registered so `/refresh settings`
			// joins it: a listener return value is discarded, so without this the
			// refresh reports completion while the prompt still advertises the
			// pre-refresh roots.
			session.registerHostReconciliation(
				sessionManager
					.setAdditionalDirectories(roots)
					// Persisted with the roots themselves, so the next resume
					// reconciles against what this edit granted rather than the
					// provenance the session started with.
					.then(() => sessionManager.setSettingsOwnedDirectories([...owned]))
					.then(
						() => session.refreshBaseSystemPrompt(),
						error => logger.warn("Failed to apply refreshed workspace directories", { error: String(error) }),
					),
			);
		});
		disposeCallbacks.add(unsubscribeLiveWorkspaceSettings);
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
			captureTools: liveAutoLearnCaptureTools,
			onPayload,
			onResponse,
			createAgent: captureOptions => {
				const captureModel = captureOptions.initialState?.model;
				const captureSessionId = captureOptions.sessionId;
				if (!captureModel || !captureSessionId) throw new Error("Auto-learn capture identity is incomplete");
				const captureDateCwdReminder = new DateCwdReminderInjector();
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
						transformed = await dropUnreadableContextImages(transformed, transformModel);
						const activeBlobBroker = blobBroker;
						if (activeBlobBroker)
							transformed = await activeBlobBroker.decorateContext(transformed, transformModel);
						return captureDateCwdReminder.transform(
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
					// Read from the live agent, like the tuning fields above: a
					// `providers.kimiApiFormat` change applied by `/refresh settings`
					// updates `agent.kimiApiFormat`, while the construction-time
					// constant would pin every later capture to the old wire format.
					kimiApiFormat: agent.kimiApiFormat,
					// Live too, for the same reason as `kimiApiFormat` above: a
					// `providers.openaiWebsockets` change reconciles onto
					// `agent.preferWebsockets`, and the construction-time constant
					// would keep every later capture on the old transport.
					preferWebsockets: agent.preferWebsockets,
					getToolContext: toolCall => toolContextStore.getContext(toolCall),
					streamFn: settingsAwareStreamFn,
					transformToolCallArguments,
					// No fallback resolver. The capture agent advertises only
					// `learn`/`manage_skill`, both of which stay top-level and never
					// mount as devices, so it has nothing legitimate to recover — while
					// the primary session's resolver is bound to the primary agent's
					// tools and would have let a capture response reach a main-session
					// MCP tool, side effects included. A hallucinated call from here
					// correctly stays `not found`, and suggesting session devices it
					// cannot call would only mislead it.
					//
					// Live too, for the same reason as `kimiApiFormat` and
					// `preferWebsockets` above: an `inlineToolDescriptors` or
					// `tools.intentTracing` change reconciles onto the primary agent,
					// and the construction-time constant would pin every later capture
					// to the launch-time tool-schema policy.
					intentTracing: agent.intentTracing,
					pruneToolDescriptions: agent.pruneToolDescriptions,
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
		// The settings reconcile now BUILDS `manage_skill`/`learn` on an off→on
		// edit (scoped to what this invocation permitted), so the controller starts
		// then too, through `reconcileAutoLearn`. The fire-time re-check in
		// `#onAgentEnd` handles the DISABLE direction.
		if (!restrictToolNames) {
			if (settings.get("autolearn.enabled") && taskDepth === 0) {
				await logger.time("startMemoryStartupTask", startMemoryBackend);
				startAutoLearnController();
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
			subagentEventBus,
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
