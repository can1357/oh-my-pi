import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	type ThinkingLevel,
} from "@pk-nerdsaver-ai/pi-agent-core";
import {
	type Context,
	type CredentialDisabledEvent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@pk-nerdsaver-ai/pi-ai";
import type { Dialect } from "@pk-nerdsaver-ai/pi-ai/dialect";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@pk-nerdsaver-ai/pi-ai/providers/openai-codex-responses";
import { FALLBACK_DIALECT, preferredDialect } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { type Component, replaceTabs, truncateToWidth } from "@pk-nerdsaver-ai/pi-tui";
import {
	$env,
	$flag,
	getAgentDir,
	getProjectDir,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@pk-nerdsaver-ai/pi-utils";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import { ADVISOR_READONLY_TOOL_NAMES, discoverWatchdogFiles, formatActiveRepoWatchdogPrompt } from "./advisor";
import { type AsyncJob, AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { loadCapability } from "./capability";
import { findRepoRoot } from "./capability/fs";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import type { SourceMeta } from "./capability/types";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { resolveMoaConfig } from "./config/moa-resolver";
import { ModelRegistry } from "./config/model-registry";
import {
	formatModelString,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { Settings, type SkillsSettings } from "./config/settings";
import { validateSpawnSelectorsSemantic, validateSpawnSelectorsStructural } from "./config/spawn-selector-validation";
import {
	BackgroundPackRenderer,
	countContextImages,
	injectBackgroundPackMessages,
	resolveBackgroundPackManifests,
} from "./context/background-packs";
import { CursorExecHandlers } from "./cursor";
import type { AgentExecutionProfile } from "./orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "./orchestration/collaboration-policy";
import { FastStreamRouter } from "./routing";
import { TRUNCATE_LENGTHS } from "./tools/render-utils";
import type { ResolvedToolProfile, ToolSource } from "./tools/tool-profiles";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import "./discovery";
import { initializeWithSettings } from "./discovery";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
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
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
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
import { IrcBus } from "./irc/bus";
import { IrcIpc } from "./irc/ipc";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	discoverAndLoadMCPTools,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import {
	createMCPHostInteractionBridge,
	type MCPHostInteractionFormRequest,
	type MCPHostInteractionPresenter,
} from "./mcp/host-interaction";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import type { MnemopiSessionState } from "./mnemopi/state";
import { estimateToolSchemaTokens } from "./modes/utils/context-usage";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import lateDiagnosticTemplate from "./prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	collectEnvSecrets,
	deobfuscateSessionContext,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	SecretObfuscator,
} from "./secrets";
import { AgentSession } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import type { ClientBridge } from "./session/client-bridge";
import { parseFusionPoolEntries } from "./session/fusion-router";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
	wrapSteeringForModel,
} from "./session/messages";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import { countToolsForAutoDiscovery, resolveEffectiveToolDiscoveryMode } from "./tool-discovery/mode";
import {
	collectDiscoverableTools,
	type DiscoverableTool,
	filterBySource,
	formatDiscoverableToolServerSummary,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
	summarizeDiscoverableTools,
} from "./tool-discovery/tool-index";
import {
	BashTool,
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	type DeferredDiagnosticsEntry,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	filterInitialToolsForDiscoveryAll,
	getSearchTools,
	HIDDEN_TOOLS,
	isAllowedByToolProfile,
	isImageProviderPreference,
	isSearchProviderId,
	isSearchProviderPreference,
	type LspStartupServerInfo,
	loadSshTool,
	ReadTool,
	ResolveTool,
	renderSearchToolBm25Description,
	SearchToolBm25Tool,
	setExcludedSearchProviders,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { normalizeToolNames } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { queueResolveHandler } from "./tools/resolve";
import { ttsTool } from "./tools/tts";
import { EventBus } from "./utils/event-bus";
import { openPath } from "./utils/open";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type AsyncResultEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncResultJobDetails = {
	jobId: string;
	type?: "bash" | "task";
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

/**
 * Binds the protocol-neutral interaction bridge to the normal terminal UI.
 * Each field is reviewed before the user can explicitly submit it; Escape is
 * intentionally distinct from Decline.
 */
export function createTuiMCPHostInteractionPresenter(ui: ExtensionUIContext): MCPHostInteractionPresenter {
	const sanitizeText = (text: string, maxWidth: number) => truncateToWidth(replaceTabs(text), maxWidth);
	const formTitle = (request: MCPHostInteractionFormRequest, detail: string) => {
		const server = sanitizeText(request.serverName, TRUNCATE_LENGTHS.TITLE);
		const msg = request.message
			.split("\n")
			.map(line => sanitizeText(line, TRUNCATE_LENGTHS.LONG))
			.join("\n");
		return `MCP server: ${server}\n\n${msg}\n\n${detail}`;
	};
	return {
		async presentForm(request, signal) {
			const content = Object.create(null) as Record<string, unknown>;
			for (const field of request.fields) {
				const title = sanitizeText(field.title, TRUNCATE_LENGTHS.TITLE);
				const desc = field.description ? sanitizeText(field.description, TRUNCATE_LENGTHS.CONTENT) : undefined;
				const detail = [`${title}${field.required ? " (required)" : ""}`, desc, `Expected: ${field.type}`]
					.filter((line): line is string => Boolean(line))
					.join("\n");
				if (field.enum) {
					const values = new Map(
						field.enum.map(value => [sanitizeText(JSON.stringify(value), TRUNCATE_LENGTHS.CONTENT), value]),
					);
					const selected = await ui.select(formTitle(request, detail), [...values.keys()], { signal });
					if (selected === undefined) return { action: "cancel" };
					content[field.name] = values.get(selected);
				} else if (field.type === "boolean" || field.type === "null") {
					const selected = await ui.select(
						formTitle(request, detail),
						field.type === "boolean" ? ["true", "false"] : ["null"],
						{ signal },
					);
					if (selected === undefined) return { action: "cancel" };
					content[field.name] = selected;
				} else {
					const defaultStr =
						field.default !== undefined
							? sanitizeText(JSON.stringify(field.default), TRUNCATE_LENGTHS.CONTENT)
							: undefined;
					const value = await ui.input(
						formTitle(request, `${detail}${defaultStr !== undefined ? `\nDefault: ${defaultStr}` : ""}`),
						field.default === undefined ? undefined : String(field.default),
						{ signal },
					);
					if (value === undefined) return { action: "cancel" };
					content[field.name] = value;
				}
			}

			const review = request.fields
				.map(field => {
					const title = sanitizeText(field.title, TRUNCATE_LENGTHS.TITLE);
					const valStr = sanitizeText(JSON.stringify(content[field.name]), TRUNCATE_LENGTHS.CONTENT);
					return `${title}: ${valStr}`;
				})
				.join("\n");
			const action = await ui.select(
				formTitle(request, `Review the submitted values:\n${review}\n\nChoose Submit to send them.`),
				["Submit", "Decline"],
				{ signal },
			);
			if (action === "Submit") return { action: "accept", content };
			return { action: action === "Decline" ? "decline" : "cancel" };
		},
		async presentUrl(request, signal) {
			const server = sanitizeText(request.serverName, TRUNCATE_LENGTHS.TITLE);
			const msg = request.message
				.split("\n")
				.map(line => sanitizeText(line, TRUNCATE_LENGTHS.LONG))
				.join("\n");
			const origin = sanitizeText(request.origin, TRUNCATE_LENGTHS.LINE);
			const url = sanitizeText(request.url, TRUNCATE_LENGTHS.LINE);
			const action = await ui.select(
				`MCP server: ${server}\n\n${msg}\n\nOrigin: ${origin}\nURL: ${url}\n\nOpen this HTTPS URL?`,
				["Open", "Decline"],
				{ signal },
			);
			return { action: action === "Open" ? "accept" : action === "Decline" ? "decline" : "cancel" };
		},
		openUrl: openPath,
	};
}

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(asyncResultTemplate, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

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

type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};

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

function collectPendingMCPToolNames(
	explicitToolNames: readonly string[] | undefined,
	restoredSelectedToolNames: readonly string[],
): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	for (const name of restoredSelectedToolNames) {
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
	/** Global config directory. Default: ~/.ompk/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;
	/** External client bridge installed before this session can execute tools. */
	clientBridge?: ClientBridge;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;
	/** Optional per-run model-request cap forwarded to the Agent (Fusion sidekick budget). */
	maxModelRequestsPerRun?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Trusted registration provenance for `customTools`; omitted entries are custom, never inferred from their names. */
	customToolSources?: ReadonlyMap<string, Extract<ToolSource, "mcp" | "custom">>;
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
	 * Pre-discovered custom-tool source paths from `.ompk/tools/`, `.claude/tools/`,
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
	contextFiles?: Array<{ path: string; content: string; depth?: number; _source?: SourceMeta }>;
	/** Disable discovery of standalone AGENTS.md files (preserves other context-file providers). */
	disableAgentsMd?: boolean;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.ompk/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;
	/** Enable local cross-process IRC discovery and delivery. Default: true. */
	enableIrc?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip Python kernel availability check and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
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
	/** Optional theme color for roster displays. */
	agentColor?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
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

	/** Frozen execution envelope for subagent sessions. */
	executionProfile?: AgentExecutionProfile;
	/** Source-aware tool capability ceiling applied during tool construction/activation. */
	toolProfile?: ResolvedToolProfile;
	/** Collaboration authorization restored/applied for roster and IRC. */
	collaborationPolicy?: CollaborationPolicy;
	/** When true, Yield schema retries fail closed for assignment-contract mode. */
	assignmentContractActive?: boolean;

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
	HIDDEN_TOOLS,
	loadSshTool,
	ReadTool,
	ResolveTool,
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
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
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
 * `~/.ompk/agent/extensions/`) never reach model resolution. Mirrors the
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
	options?: { excludeProviders?: string[] },
): Promise<Array<{ path: string; content: string; depth?: number; _source?: SourceMeta }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		excludeProviders: options?.excludeProviders,
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
	contextFiles?: Array<{ path: string; content: string; depth?: number; _source?: SourceMeta }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const providedTools = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		tools: providedTools ? buildSystemPromptToolMetadata(providedTools) : undefined,
		toolNames: options.tools?.map(tool => tool.name),
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

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
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

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
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
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@pk-nerdsaver-ai/pi-ai';
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
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerPythonCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
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
	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	const fusionPoolEntries = settings.get("fusion.modelPool") ?? [];
	const fusionPoolSelectors = fusionPoolEntries.map(entry => parseFusionPoolEntries([entry])[0]?.selector ?? "");
	const structuralSpawnDiagnostics = validateSpawnSelectorsStructural({
		aliases: settings.get("subagent.modelAliases"),
		agentPolicies: settings.getAgentPolicies(),
		modelPools: {
			"fusion.modelPool": fusionPoolSelectors,
		},
	});
	if (structuralSpawnDiagnostics.length > 0) {
		const message = structuralSpawnDiagnostics
			.map(
				diagnostic =>
					`- [${diagnostic.code}] ${diagnostic.path ? `${diagnostic.path}: ` : ""}${diagnostic.message}`,
			)
			.join("\n");
		throw new Error(`Spawn selector structural validation failed:\n${message}`);
	}
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	// Kick off workspace tree discovery early. The native workspace scan returns
	// both the rendered-tree input and the AGENTS.md directory-context index, so
	// startup does not perform a second recursive filesystem search. Subagents
	// inherit the parent's resolved values via options.
	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }));
	workspaceTreePromise.catch(() => {});

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const contextFileExcludeProviders = options.disableAgentsMd ? ["agents-md"] : undefined;
	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", () =>
				discoverContextFiles(cwd, agentDir, {
					excludeProviders: contextFileExcludeProviders,
				}),
			);
	contextFilesPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
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
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}

	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (isImageProviderPreference(imageProvider)) {
		setPreferredImageProvider(imageProvider);
	}

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
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
	let obfuscator: SecretObfuscator | undefined;
	if (settings.get("secrets.enabled")) {
		const fileEntries = await logger.time("loadSecrets", loadSecrets, cwd, agentDir);
		const envEntries = collectEnvSecrets();
		const allEntries = [...envEntries, ...fileEntries];
		if (allEntries.length > 0) {
			obfuscator = new SecretObfuscator(allEntries);
		}
	}
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	// Check if session has existing data to restore
	const existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
			modelRegistry,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
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
	let restoredSessionThinkingLevel: ThinkingLevel | undefined;
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxAlias: true,
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
			level = parseThinkingLevel(existingSession.thinkingLevel);
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
	let effectiveThinkingLevel: ThinkingLevel | undefined = thinkingLevel === AUTO_THINKING ? undefined : thinkingLevel;
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

	// Mutable holder: `rebuildSystemPrompt` closes over this object (not the raw
	// array) so a mid-session `reloadSkills()` is visible to the next prompt build.
	const skillsState: { current: Skill[] } = { current: [] };
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skillsState.current = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skillsState.current = discovered.skills;
		skillWarnings = discovered.warnings;
	}
	const skills = (): Skill[] => skillsState.current;

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
	const [rawContextFiles, resolvedWorkspaceTree, watchdogFiles] = await Promise.all([
		contextFilesPromise,
		raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
		watchdogFilesPromise,
	]);
	const contextFiles = options.disableAgentsMd
		? rawContextFiles.filter(file => (file as { _source?: SourceMeta })._source?.provider !== "agents-md")
		: rawContextFiles;

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	const enableLsp = options.enableLsp ?? true;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const ircIpc = IrcIpc.global();
	if ((options.taskDepth ?? 0) === 0 && !options.parentTaskPrefix) {
		void ircIpc.setEnabled(options.enableIrc !== false);
	}
	IrcBus.global().attachIpc(ircIpc);
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string, ownerSession: AgentSession): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await ownerSession.sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				ownerId: ownerSession.getAgentId(),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	// A single process manager schedules jobs for every live root and subagent.
	// Its completion callback resolves the job owner through this shared registry
	// instead of closing over the first session that happened to create it.
	const asyncJobManager =
		!options.parentTaskPrefix && !AsyncJobManager.instance()
			? new AsyncJobManager({
					maxRunningJobs: asyncMaxJobs,
					onJobComplete: async (jobId, result, job) => {
						if (asyncJobManager!.isDeliverySuppressed(jobId)) return;
						const ownerId = job?.ownerId;
						const ownerSession = ownerId ? agentRegistry.get(ownerId)?.session : undefined;
						if (!ownerId || !ownerSession) {
							logger.warn("Dropping async completion because its owner session is unavailable", {
								jobId,
								ownerId,
							});
							return;
						}

						const formattedResult = await formatAsyncResultForFollowUp(result, ownerSession);
						if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

						const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
						ownerSession.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
							jobId,
							result: formattedResult,
							job,
							durationMs,
						});
					},
				})
			: undefined;

	const scopedAsyncJobManager = asyncJobManager ?? AsyncJobManager.instance();
	/**
	 * Forget the agent ref on teardown — unless the agent is being parked (or is
	 * already parked). Parking disposes the session but keeps the ref addressable
	 * (history://, revive); only process teardown / explicit kill unregisters.
	 */
	const unregisterUnlessParked = (): void => {
		if (agentRegistry.get(resolvedAgentId)?.status === "parked") return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId)) return;
		agentRegistry.unregister(resolvedAgentId);
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
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			hasUI: options.hasUI ?? false,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames
					? [...new Set(options.toolNames.map(name => name.toLowerCase()))]
					: undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			// Getter, not a captured array: tool-facing `skill://` resolution reads
			// `context.skills` and would otherwise keep the construction-time set
			// after a mid-session reloadSkills().
			get skills() {
				return skillsState.current;
			},
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			assignmentContractActive: options.assignmentContractActive,
			toolProfile: options.toolProfile,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			getAgentId: () => resolvedAgentId,
			getForkContext: () =>
				session
					? {
							systemPrompt: [...(session.systemPrompt ?? [])],
							toolNames: (session.agent?.state.tools ?? []).map(tool => tool.name),
							model: session.model,
							messages: [...session.messages],
						}
					: undefined,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			ircIpc,
			ircEnabled: () => ircIpc.enabled,
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModel: () => agent?.state.model ?? model,
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
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setActiveTaskContract: snapshot => session.setActiveTaskContract(snapshot),
			getActiveTaskContract: () => session.getActiveTaskContract(),
			evaluateRootCompletionGate: input => session.evaluateRootCompletionGate(input),
			setTodoPhases: phases => session.setTodoPhases(phases),
			isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
			getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
			activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
			// Generic tool discovery (unified — covers built-in + MCP + extension)
			isToolDiscoveryEnabled: () => session.isToolDiscoveryEnabled(),
			getDiscoverableTools: filter => session.getDiscoverableTools(filter),
			getDiscoverableToolSearchIndex: () => session.getDiscoverableToolSearchIndex(),
			getSelectedDiscoveredToolNames: () => session.getSelectedDiscoveredToolNames(),
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getXdevRegistry: () => session?.getXdevRegistry(),
			executeXdevTool: (toolName, args, signal, context) => session.executeXdevTool(toolName, args, signal, context),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
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
			peekStandingResolveHandler: () => session.peekStandingResolveHandler(),
			setStandingResolveHandler: handler => session.setStandingResolveHandler(handler),
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
			setActiveSkills(skills());
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
		if (options.localProtocolOptions) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Discover MCP tools from .mcp.json files
		let mcpManager: MCPManager | undefined = options.mcpManager;
		toolSession.mcpManager = mcpManager;
		const enableMCP = options.enableMCP ?? true;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const mcpHostInteraction = options.hasUI === true ? createMCPHostInteractionBridge() : undefined;
		let deferredMCPDiscoveryStarted = false;
		const customTools: CustomTool[] = [];
		let startDeferredMCPDiscovery:
			| ((liveSession: AgentSession, activation: DeferredMCPActivation) => void)
			| undefined;
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
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null, {
					hostInteraction: mcpHostInteraction,
				});
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}

				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = (liveSession, activation) => {
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
							// `tools.discoveryMode: "auto"` was resolved against a registry that
							// held only built-ins plus persisted placeholder names. Recompute with
							// the real MCP tool count. `isMCPDiscoveryEnabled()` is the only
							// readiness signal consumers can poll, so every effect of the flip
							// (search_tool_bm25 active, registry + discoverable set populated)
							// must be final before it flips: a pre-flip refresh registers the
							// tools without activating any (discovery selection resolves empty
							// while the flag is off), and the post-flip refresh below applies
							// selection defaults, persistence, and the prompt rebuild.
							let discoveryEnabled = activation.mcpDiscoveryEnabled;
							let activateAll = activation.activateAllMCPTools;
							if (!discoveryEnabled) {
								const nonMCPToolNames = [...toolRegistry.keys()].filter(name => !isMCPToolName(name));
								const projectedMode = resolveEffectiveToolDiscoveryMode(
									settings,
									countToolsForAutoDiscovery([...nonMCPToolNames, ...mcpResult.tools.map(tool => tool.name)]),
									estimateToolSchemaTokens([
										...[...toolRegistry.values()].filter(tool => !isMCPToolName(tool.name)),
										...mcpResult.tools,
									]),
								);
								if (projectedMode !== "off") {
									effectiveDiscoveryMode = projectedMode;
									mcpDiscoveryEnabled = true;
									discoveryEnabled = true;
									activateAll = false;
									if (!toolRegistry.has("search_tool_bm25")) {
										const searchTool: Tool | null = SearchToolBm25Tool.create(toolSession, {
											toolProfile: options.toolProfile ?? toolSession.toolProfile,
										});
										if (searchTool) {
											toolRegistry.set(
												searchTool.name,
												new ExtensionToolWrapper(
													wrapToolWithMetaNotice(searchTool),
													extensionRunner,
												) as Tool,
											);
										}
									}
									await liveSession.setActiveToolsByName([
										...liveSession.getActiveToolNames(),
										"search_tool_bm25",
									]);
									await liveSession.refreshMCPTools(mcpResult.tools, { activateAll: false });
									liveSession.enableMCPDiscovery();
								}
							}
							await liveSession.refreshMCPTools(mcpResult.tools, { activateAll });
							if (activation.explicitlyRequestedMCPToolNames.length > 0) {
								if (discoveryEnabled && !activation.mcpDiscoveryEnabled) {
									// Discovery flipped on mid-flight: route the explicit request
									// through discovery-aware activation so selection persists.
									await liveSession.activateDiscoveredMCPTools(activation.explicitlyRequestedMCPToolNames);
								} else if (!discoveryEnabled) {
									await liveSession.setActiveToolsByName([
										...liveSession.getActiveToolNames(),
										...activation.explicitlyRequestedMCPToolNames,
									]);
								}
							}
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

				if (mcpResult.tools.length > 0) {
					// MCP tools are LoadedCustomTool, extract the tool property
					customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
				}
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		// Add image tools when the active model or configured image providers can generate images.
		const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
		if (imageGenTools.length > 0) {
			customTools.push(...(imageGenTools as unknown as CustomTool[]));
		}

		if (settings.get("speechgen.enabled")) {
			customTools.push(ttsTool as unknown as CustomTool);
		}

		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			customTools.push(...getSearchTools());
		}

		// Discover custom tools from `.ompk/tools/`, `.claude/tools/`, plugins, etc.
		// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
		// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
		// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
		// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
		// execution back through the parent — wrong for isolated tasks and for
		// pending-action queueing.
		const builtInToolNames = builtinTools.map(t => t.name);
		const customToolPaths: ToolPathWithSource[] =
			options.preloadedCustomToolPaths ??
			(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd)));
		const customToolsLoadResult = await logger.time("loadCustomTools", () =>
			loadCustomTools(customToolPaths, cwd, builtInToolNames, action => queueResolveHandler(toolSession, action)),
		);
		for (const { path, error } of customToolsLoadResult.errors) {
			logger.error("Custom tool load failed", { path, error });
		}
		if (customToolsLoadResult.tools.length > 0) {
			customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
		inlineExtensions.push((await import("./autoresearch")).createAutoresearchExtension);
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}

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
		if (options.preloadedExtensions) {
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
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}
		// Discover runtime (extension) provider catalogs now that they are
		// registered. The startup refreshInBackground() ran before extensions
		// loaded, so dynamic extension providers are only discovered here. Runs in
		// the background (cache-aware) so startup is never blocked on the fetch; the
		// model list re-renders when the catalog arrives, like other dynamic providers.
		try {
			await modelRegistry.refreshRuntimeProviders();
		} catch (error) {
			logger.warn("runtime provider discovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		{
			const requiredSelectors = new Set<string>();
			const addRequiredSelector = (selector: unknown): void => {
				if (typeof selector === "string" && selector.trim()) requiredSelectors.add(selector.trim());
			};
			for (const policy of Object.values(settings.getAgentPolicies())) {
				for (const selector of policy.modelPool ?? []) addRequiredSelector(selector);
			}
			for (const selector of Object.values(settings.get("subagent.modelAliases"))) addRequiredSelector(selector);
			for (const selector of Object.values(settings.get("task.agentModelOverrides"))) addRequiredSelector(selector);
			for (const selector of Object.values(settings.get("modelRoles"))) addRequiredSelector(selector);
			if (settings.get("fusion.enabled")) {
				for (const selector of fusionPoolSelectors) addRequiredSelector(selector);
				addRequiredSelector(settings.get("fusion.sidekickModel"));
				addRequiredSelector(settings.get("fusion.sidekickStrongModel"));
				addRequiredSelector(settings.get("fusion.compactModel"));
			}
			if (requiredSelectors.size > 0) {
				const semanticSpawnDiagnostics = validateSpawnSelectorsSemantic({
					selectors: [...requiredSelectors],
					resolveStatus: selector => {
						const resolved = resolveModelRoleValue(selector, modelRegistry.getAll() as Model[], {
							settings,
							matchPreferences: getModelMatchPreferences(settings),
							modelRegistry,
						}).model;
						if (!resolved) {
							return { selector, resolved: false, authenticated: false };
						}
						return {
							selector,
							resolved: true,
							authenticated: modelRegistry.hasConfiguredAuth(resolved),
							provider: resolved.provider,
							modelId: resolved.id,
						};
					},
				});
				// Missing credentials are not a startup failure: the selector names a
				// real model, so the session proceeds and the default-model fallback
				// (with its allow-list filters) decides what actually runs.
				const fatalSpawnDiagnostics = semanticSpawnDiagnostics.filter(
					diagnostic => diagnostic.code !== "unauthenticated-selector",
				);
				if (fatalSpawnDiagnostics.length > 0) {
					const message = fatalSpawnDiagnostics
						.map(diagnostic => `- [${diagnostic.code}] ${diagnostic.selector ?? ""} ${diagnostic.message}`.trim())
						.join("\n");
					throw new Error(`Spawn selector semantic validation failed:\n${message}`);
				}
				for (const diagnostic of semanticSpawnDiagnostics) {
					logger.warn("Spawn selector resolved without configured auth", { selector: diagnostic.selector });
				}
			}
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
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxAlias: true,
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
					effectiveThinkingLevel = thinkingLevel === AUTO_THINKING ? undefined : thinkingLevel;
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(restoredModel)
							: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
					);
					preconnectModelHost(restoredModel.baseUrl);
					break;
				}
			}
		}
		// Resolve deferred --model pattern now that extension models are registered.
		if (!model && options.modelPattern) {
			const availableModels = modelRegistry.getAll();
			const matchPreferences = getModelMatchPreferences(settings);
			const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences, {
				modelRegistry,
			});
			if (resolved) {
				model = resolved;
				modelFallbackMessage = undefined;
			} else {
				modelFallbackMessage = `Model "${options.modelPattern}" not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && !options.modelPattern) {
			// Re-resolve the allowed set: extension factories above may have
			// registered providers/models that weren't visible at startup.
			const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
			// Retry `modelRoles.default` against the post-extension set before the
			// generic fallback: a role pointing at an extension-registered provider
			// was invisible to the early defaultRoleSpec resolution (issue #3569).
			if (!hasExplicitModel) {
				const retriedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
					modelRegistry,
				});
				const roleModel = retriedRoleSpec.model;
				if (roleModel && hasModelAuth(roleModel)) {
					model = roleModel;
					modelFallbackMessage = undefined;
					thinkingLevel = retriedRoleSpec.explicitThinkingLevel
						? retriedRoleSpec.thinkingLevel
						: pickInitialThinkingLevel(roleModel);
					autoThinking = thinkingLevel === AUTO_THINKING;
					effectiveThinkingLevel = thinkingLevel === AUTO_THINKING ? undefined : thinkingLevel;
					effectiveThinkingLevel = autoThinking
						? resolveProvisionalAutoLevel(roleModel)
						: resolveThinkingLevelForModel(roleModel, effectiveThinkingLevel);
					preconnectModelHost(roleModel.baseUrl);
				}
			}
			if (!model) {
				const defaultModel = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));
				if (defaultModel) {
					model = defaultModel;
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

		// Discover custom commands (TypeScript slash commands)
		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery) {
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
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = extensionRunner.getAllRegisteredTools();
		const sdkCustomTools = options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? [];
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
		const wrappedExtensionTools: Tool[] = wrapRegisteredTools(allCustomTools, extensionRunner).map(
			wrapToolWithMetaNotice,
		);

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const toolRegistry = new Map<string, Tool>();
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (!toolRegistry.has("goal") && settings.get("goal.enabled")) {
			const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
			if (goalTool) {
				toolRegistry.set(goalTool.name, wrapToolWithMetaNotice(goalTool));
			}
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (deferMCPDiscoveryForUI && mcpManager) {
			for (const name of collectPendingMCPToolNames(options.toolNames, existingSession.selectedMCPToolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
		}

		// `resolve` is hidden but must stay in the registry whenever any code path can invoke it:
		// either a deferrable tool stages a preview action, or plan mode installs a standing handler
		// that consumes `resolve { action: "apply" }` to submit the plan for approval (issue #1428).
		// Dropping it on read-only sessions (e.g. plan-mode toolset `read`, `search`, `find`,
		// `web_search`) leaves plan mode unable to exit through the intended path.
		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		const planModeAvailable = settings.get("plan.enabled");
		const needsResolveTool = hasDeferrableTools || planModeAvailable;
		if (!needsResolveTool) {
			toolRegistry.delete("resolve");
		} else if (!toolRegistry.has("resolve")) {
			const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
			if (resolveTool) {
				toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
			}
		}

		// `let`: the deferred MCP discovery closure upgrades these when the real
		// MCP tool count pushes `auto` past its threshold; `rebuildSystemPrompt`
		// below reads the live bindings.
		let effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
			settings,
			countToolsForAutoDiscovery(toolRegistry.keys()),
		);
		if (effectiveDiscoveryMode !== "off" && !toolRegistry.has("search_tool_bm25")) {
			const searchTool: Tool | null = SearchToolBm25Tool.create(toolSession, {
				toolProfile: options.toolProfile ?? toolSession.toolProfile,
			});
			if (searchTool) {
				toolRegistry.set(
					searchTool.name,
					new ExtensionToolWrapper(wrapToolWithMetaNotice(searchTool), extensionRunner) as Tool,
				);
			}
		}
		let mcpDiscoveryEnabled = effectiveDiscoveryMode !== "off"; // back-compat: true when any discovery active

		const reloadSshTool = async (): Promise<AgentTool | null> => {
			if (!requestedToolNameSet.has("ssh")) return null;
			const sshTool = (await loadSshTool({
				...toolSession,
				cwd: sessionManager.getCwd(),
			})) as unknown as AgentTool | null;
			if (!sshTool) return null;
			const wrapped = wrapToolWithMetaNotice(sshTool);
			return new ExtensionToolWrapper(wrapped, extensionRunner) as AgentTool;
		};

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		const inlineToolDescriptorsSetting = settings.get("inlineToolDescriptors");
		// "auto" inlines only for owned (non-native) tool dialects, which require
		// the descriptor catalog in-prompt; native tool calling keeps the compact
		// name list and provider-side schemas.
		const resolveInlineToolDescriptors = (nativeTools: boolean): boolean =>
			inlineToolDescriptorsSetting === "on" || (inlineToolDescriptorsSetting === "auto" && !nativeTools);
		const eagerTasks = settings.get("task.eager") !== "default";
		const eagerTasksAlways = settings.get("task.eager") === "always";
		const intentField = $flag("PI_INTENT_TRACING", settings.get("tools.intentTracing")) ? INTENT_FIELD : undefined;
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
		): Promise<BuildSystemPromptResult> => {
			toolContextStore.setToolNames(toolNames);
			const discoverableMCPTools: DiscoverableTool[] = mcpDiscoveryEnabled
				? filterBySource(collectDiscoverableTools(tools.values()), "mcp")
				: [];
			const activeToolNames = new Set(toolNames);
			const discoverableBuiltinTools: DiscoverableTool[] =
				effectiveDiscoveryMode === "all"
					? collectDiscoverableTools(
							Array.from(tools.values()).filter(
								tool => tool.loadMode === "discoverable" && !activeToolNames.has(tool.name),
							),
							{ source: "builtin" },
						)
					: [];
			const discoverableToolsForDesc: DiscoverableTool[] = [...discoverableBuiltinTools, ...discoverableMCPTools];
			const discoverableToolSummary = summarizeDiscoverableTools(discoverableToolsForDesc);
			const hasDiscoverableTools =
				mcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableToolsForDesc.length > 0;
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: { description: renderSearchToolBm25Description(discoverableToolsForDesc) },
			});
			const memoryBackend = await resolveMemoryBackend(settings);
			const memoryInstructions = await memoryBackend.buildDeveloperInstructions(agentDir, settings, session);

			// Build combined append prompt: memory instructions + auto-learn guidance
			// + MCP server instructions. For UI sessions MCP discovery is deferred, so
			// `getServerInstructions()` is empty until the background connect completes;
			// the rebuild that `refreshMCPTools` triggers post-discovery then picks up
			// the now-connected servers' instructions, so they join the prompt for the
			// rest of the session.
			const serverInstructions = mcpManager?.getServerInstructions();
			// Drive guidance off the auto-learn BUILTINS that createTools actually built
			// (provenance, not just an active name): `builtInToolNames` excludes a
			// custom/extension tool that merely shares the name, and reflects the
			// session-start build — so a subagent that filtered them out, a mid-session
			// enable that never built them, or a same-named custom tool while auto-learn
			// is off all get no guidance.
			const autoLearnInstructions = buildAutoLearnInstructions({
				manageSkill: builtInToolNames.includes("manage_skill"),
				learn: builtInToolNames.includes("learn"),
			});
			const appendParts: string[] = [];
			if (memoryInstructions) appendParts.push(memoryInstructions);
			if (autoLearnInstructions) appendParts.push(autoLearnInstructions);
			let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
			if (serverInstructions && serverInstructions.size > 0) {
				const parts: string[] = [];
				if (appendPrompt) parts.push(appendPrompt);
				parts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					parts.push(`### ${srvName}\n${truncated}`);
				}
				appendPrompt = parts.join("\n\n");
			}
			// Owned/in-band tool dialects (non-native) require the catalog as `# Tool:`
			// sections; native tool calling lets the compact name list suffice.
			const nativeTools = resolveDialect(settings.get("tools.format"), agent?.state.model ?? model) === undefined;
			if (options.appendSystemPrompt) {
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			// Only advertise the warm Sidekick when a mode has actually spawned one.
			// Raw SDK callers that do not host the sidekick lifecycle still get Fusion's
			// compaction routing, but no phantom IRC target in the prompt.
			const sidekickId =
				agentKind === "main" ? (session as AgentSession | undefined)?.getFusionSidekickId() : undefined;
			const defaultPrompt = await buildSystemPromptInternal({
				cwd,
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: skills(),
				contextFiles,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				inlineToolDescriptors: resolveInlineToolDescriptors(nativeTools),
				nativeTools,
				intentField,
				mcpDiscoveryMode: hasDiscoverableTools,
				mcpDiscoveryServerSummaries: discoverableToolSummary.servers.map(formatDiscoverableToolServerSummary),
				xdevEnabled: settings.get("tools.xdev"),
				eagerTasks,
				eagerTasksAlways,
				taskBatch: settings.get("task.batch"),
				fusionSidekick:
					agentKind === "main" &&
					settings.get("fusion.enabled") === true &&
					settings.get("fusion.mode") !== "off" &&
					sidekickId !== undefined,
				fusionEscalate:
					agentKind === "main" &&
					settings.get("fusion.enabled") === true &&
					settings.get("fusion.mode") === "escalate" &&
					sidekickId !== undefined,
				sidekickModel: settings.get("fusion.sidekickModel") || "pi/smol",
				sidekickId,
				secretsEnabled,
				workspaceTree: workspaceTreePromise,
				memoryRootEnabled: memoryBackend.id === "local",
				model: settings.get("includeModelInPrompt") ? getActiveModelString() : undefined,
				personality: agentKind === "sub" ? "none" : settings.get("personality"),
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
		if (explicitlyRequestedToolNames) {
			for (const name of ["manage_skill", "learn"]) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const requestedToolNameSet = new Set(normalizedRequested);
		// Effective discovery mode is resolved after the full registry exists so auto mode can count MCP/extension tools.
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = normalizedRequested.filter(name => name !== "goal");
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		const explicitlyRequestedMCPToolNames = options.toolNames
			? requestedActiveToolNames.filter(name => name.startsWith("mcp__"))
			: [];
		const discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
			? selectDiscoverableToolNamesByServer(
					filterBySource(collectDiscoverableTools(toolRegistry.values()), "mcp"),
					discoveryDefaultServers,
				)
			: [];
		let initialSelectedMCPToolNames: string[] = [];
		let defaultSelectedMCPToolNames: string[] = [];
		let initialToolNames = [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames.filter(name =>
				toolRegistry.has(name),
			);
			defaultSelectedMCPToolNames = [
				...new Set([...discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
			];
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
			initialToolNames = [
				...new Set([
					...initialRequestedActiveToolNames.filter(name => !name.startsWith("mcp__")),
					...initialSelectedMCPToolNames,
				]),
			];
		}

		// Custom tools and extension-registered tools are always included regardless of toolNames filter,
		// but still cannot exceed an explicit source-qualified toolProfile ceiling (revive/MCP/custom).
		const customToolNames = new Set(sdkCustomTools.map(t => (isCustomTool(t) ? t.name : t.name)));
		const extensionToolNames = new Set(
			registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
		);
		const resolveToolSource = (name: string): ToolSource | undefined => {
			// Registration provenance wins over spelling. In particular, mcp__ is
			// never authority by itself: an SDK custom/extension tool cannot
			// self-promote into an MCP-only capability ceiling by choosing a name.
			if (mcpManager?.getTools().some(tool => tool.name === name)) return "mcp";
			if (customToolNames.has(name)) return options.customToolSources?.get(name) ?? "custom";
			if (extensionToolNames.has(name) || registeredTools.some(t => t.definition.name === name)) {
				return "extension";
			}
			if (name in BUILTIN_TOOLS) return "builtin";
			if (name in HIDDEN_TOOLS) return "hidden";
			return undefined;
		};
		const alwaysInclude: string[] = [...customToolNames, ...extensionToolNames];
		for (const name of alwaysInclude) {
			if (mcpDiscoveryEnabled && name.startsWith("mcp__")) {
				continue;
			}
			const source = resolveToolSource(name);
			if (options.toolProfile && (!source || !isAllowedByToolProfile(options.toolProfile, source, name))) {
				continue;
			}
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		// When tools.discoveryMode === "all", hide non-essential built-in discoverable tools
		// from the initial set unless they were explicitly requested or restored from persistence.
		// The model finds them via search_tool_bm25 and activates them on demand.
		if (effectiveDiscoveryMode === "all") {
			// Tools a forced tool_choice will target must stay active, or the named
			// choice references a tool absent from the request (provider 400). Eager
			// todos force a named `todo` choice on the first turn. `task` is also kept
			// active under discovery-all when `task.eager` is not `default`, so eager delegation is
			// possible and the Eager Tasks prompt section renders, even though nothing
			// forces a `task` tool_choice.
			const forceActive = new Set<string>();
			if (settings.get("todo.eager") !== "default" && settings.get("todo.enabled") && toolRegistry.has("todo")) {
				forceActive.add("todo");
			}
			if (settings.get("task.eager") !== "default" && toolRegistry.has("task")) {
				forceActive.add("task");
			}
			initialToolNames = filterInitialToolsForDiscoveryAll(initialToolNames, {
				loadModeOf: name => toolRegistry.get(name)?.loadMode,
				essentialNames: new Set(computeEssentialBuiltinNames(settings)),
				explicitlyRequested: new Set(options.toolNames ? normalizeToolNames(options.toolNames) : []),
				// Back-compat: persisted activations live under selectedMCPToolNames today (built-in
				// activation persistence is a follow-up). MCP names won't collide with built-in names.
				restored: new Set(existingSession.selectedMCPToolNames),
				forceActive,
				toolProfile: options.toolProfile,
				sourceOf: resolveToolSource,
			});
		} else if (options.toolProfile) {
			// Non-discovery-all paths (including cold revive) must still clamp restored MCP/custom
			// activations to the source-qualified ceiling before the session becomes visible.
			initialToolNames = initialToolNames.filter(name => {
				const source = resolveToolSource(name);
				return !!source && isAllowedByToolProfile(options.toolProfile, source, name);
			});
		}

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		agentRegistry.register({
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running",
			color: options.agentColor,
			cwd,
			collaborationPolicy: options.collaborationPolicy,
		});
		if (ircIpc) {
			void ircIpc.configure({ cwd, registry: agentRegistry, bus: IrcBus.global() }).catch(error => {
				logger.debug("IRC IPC registration failed", { error: String(error) });
			});
		}
		hasRegistered = true;

		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			// Check setting dynamically so mid-session changes take effect
			if (!settings.get("images.blockImages")) {
				return converted;
			}
			// Filter out ImageContent from all messages, replacing with text placeholder
			return converted.map(msg => {
				if (msg.role === "user" || msg.role === "toolResult") {
					const content = msg.content;
					if (Array.isArray(content)) {
						const hasImages = content.some(c => c.type === "image");
						if (hasImages) {
							const filteredContent = content
								.map(c =>
									c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
								)
								.filter((c, i, arr) => {
									// Dedupe consecutive "Image reading is disabled." texts
									if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
									const prev = arr[i - 1];
									return !(prev.type === "text" && prev.text === "Image reading is disabled.");
								});
							return { ...msg, content: filteredContent };
						}
					}
				}
				return msg;
			});
		};

		// Final convertToLlm: chain block-images filter with secret obfuscation
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlmWithBlockImages(messages);
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};
		// Background-pack rendering is intentionally separated from the request:
		// only manifest-resolved source text crosses into BackgroundPackRenderer.
		const backgroundPackRenderer = new BackgroundPackRenderer();
		const reportedBackgroundPackWarnings = new Set<string>();
		let backgroundPackUiContext: ExtensionUIContext | undefined;
		let backgroundPackHasUi = false;
		const reportBackgroundPackWarning = (message: string): void => {
			if (reportedBackgroundPackWarnings.has(message)) return;
			reportedBackgroundPackWarnings.add(message);
			logger.warn(message);
			if (backgroundPackHasUi) backgroundPackUiContext?.notify(message, "warning");
		};
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			const transformed = obfuscator ? obfuscateProviderContext(obfuscator, context) : context;
			const backgroundPacksEnabled: unknown = settings.getGlobal("backgroundPacks.enabled");
			if (backgroundPacksEnabled !== true) return transformed;
			const globalBlockImages: unknown = settings.getGlobal("images.blockImages");
			const effectiveBlockImages: unknown = settings.get("images.blockImages");
			if (globalBlockImages === true || effectiveBlockImages === true) {
				reportBackgroundPackWarning("Background packs skipped: image reading is disabled.");
				return transformed;
			}

			const manifestPaths: unknown = settings.getGlobal("backgroundPacks.manifests");
			if (Array.isArray(manifestPaths) && manifestPaths.length === 0) {
				reportBackgroundPackWarning("Background packs are enabled, but no user-level manifests are configured.");
				return transformed;
			}
			try {
				const activeCwd = sessionManager.getCwd();
				const repositoryRoot = await findRepoRoot(activeCwd);
				const workspaceRoots =
					repositoryRoot && repositoryRoot !== activeCwd ? [activeCwd, repositoryRoot] : [activeCwd];
				const resolved = await resolveBackgroundPackManifests(manifestPaths, {
					agentDir,
					workspaceRoots,
				});
				for (const warning of resolved.warnings) reportBackgroundPackWarning(warning.message);
				const prepared = await backgroundPackRenderer.prepare(resolved.packs, transformModel, {
					reservedImageCount: countContextImages(transformed),
				});
				for (const warning of prepared.warnings) reportBackgroundPackWarning(warning.message);
				if (prepared.messages.length === 0) return transformed;

				return injectBackgroundPackMessages(transformed, prepared.messages);
			} catch {
				reportBackgroundPackWarning("Background packs skipped: optional image preparation failed.");
				return transformed;
			}
		};
		const onPayload = async (payload: unknown, _model?: Model) => {
			return await extensionRunner.emitBeforeProviderRequest(payload);
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const triggerDeferredDiscovery = () => {
			if (deferredMCPDiscoveryStarted || !startDeferredMCPDiscovery) return;
			deferredMCPDiscoveryStarted = true;
			startDeferredMCPDiscovery(session, {
				mcpDiscoveryEnabled,
				explicitlyRequestedMCPToolNames,
				activateAllMCPTools: !mcpDiscoveryEnabled && options.toolNames === undefined,
			});
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			backgroundPackUiContext = uiContext;
			backgroundPackHasUi = hasUI;
			toolContextStore.setUIContext(uiContext, hasUI);
			if (!mcpHostInteraction) return;
			if (!hasUI) {
				mcpHostInteraction.unbind();
				return;
			}
			mcpHostInteraction.bind(createTuiMCPHostInteractionPresenter(uiContext));
			triggerDeferredDiscovery();
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const serviceTierSetting = settings.get("serviceTier");

		const initialServiceTier = hasServiceTierEntry
			? existingSession.serviceTier
			: serviceTierSetting === "none"
				? undefined
				: serviceTierSetting;

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		// Resolve MOA from settings BEFORE Agent construction so `moa` can be
		// passed into AgentOptions and become the streamFn wrapper for read-only
		// candidate lanes. Falls back to no MOA when disabled or unresolved.
		const moaSettings = settings.getGroup("moa");
		const moaActive = moaSettings.enabled && moaSettings.preset !== "off";
		const moaResolved = moaActive
			? resolveMoaConfig({
					presetId: moaSettings.preset,
					overrideSelectors: moaSettings.preset === "custom" ? Object.values(moaSettings.lanes) : undefined,
					availableModels: modelRegistry.getAvailable(),
					maxLanes: Math.max(0, moaSettings.maxLanes | 0),
				})
			: { moa: undefined, skipped: [] };
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: options.providerPromptCacheKey,
			deadline: options.deadline,
			maxModelRequestsPerRun: options.maxModelRequestsPerRun,
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
			serviceTier: initialServiceTier,
			hideThinkingSummary: settings.get("hideThinkingBlock"),
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: requestModel => modelRegistry.resolver(requestModel, agent.sessionId),
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
				const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
				const openrouterVariant =
					openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
				const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
				const dispatchStream = (modelToStream: Model, ctx: Context, opts?: SimpleStreamOptions) => {
					return streamSimple(modelToStream, ctx, {
						...opts,
						openrouterVariant: opts?.openrouterVariant ?? openrouterVariant,
						antigravityEndpointMode: opts?.antigravityEndpointMode ?? antigravityEndpointMode,
						loopGuard: {
							enabled: settings.get("model.loopGuard.enabled"),
							checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
							...opts?.loopGuard,
						},
					});
				};

				// High-performance dynamic multi-provider routing (zero-overhead if no pool configured)
				const pool = modelRegistry.resolvePool(streamModel);
				if (pool && pool.candidates.length > 1) {
					const router = new FastStreamRouter(modelRegistry.poolManager, target =>
						modelRegistry.resolver(target, agent.sessionId),
					);
					return router.streamWithRouting(
						streamModel,
						context,
						streamOptions,
						pool,
						dispatchStream,
						agent.sessionId,
					);
				}

				return dispatchStream(streamModel, context, streamOptions);
			},
			cursorExecHandlers,
			transformToolCallArguments: (args, _toolName) => {
				let result = args;
				const maxTimeout = settings.get("tools.maxTimeout");
				if (maxTimeout > 0 && typeof result.timeout === "number") {
					result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
				}
				if (obfuscator?.hasSecrets()) {
					result = obfuscator.deobfuscateObject(result);
				}
				return result;
			},
			intentTracing: !!intentField,
			pruneToolDescriptions: resolveInlineToolDescriptors(
				resolveDialect(settings.get("tools.format"), model) === undefined,
			),
			dialect: resolveDialect(settings.get("tools.format"), model),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
			...(moaResolved.moa ? { moa: moaResolved.moa } : {}),
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
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
			if (initialServiceTier) {
				sessionManager.appendServiceTierChange(initialServiceTier);
			}
		}

		// Hard-isolated read-only toolset for the advisor (built unconditionally so
		// it can be toggled at runtime). Fresh ReadTool/SearchTool/FindTool bound to a
		// DISTINCT ToolSession so the advisor's investigative reads never touch the
		// primary's snapshot, seen-lines, conflict, or summary caches (all keyed on
		// session identity). `cwd` stays dynamic; edit/yield capabilities are off.
		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			hasEditTool: false,
			requireYieldTool: false,
			conflictHistory: undefined,
			fileSnapshotStore: undefined,
			getSessionId: () => {
				const id = sessionManager.getSessionId?.();
				return id ? `${id}-advisor` : null;
			},
			getAgentId: () => "advisor",
		};
		const built = await Promise.all(
			[...ADVISOR_READONLY_TOOL_NAMES].map(name =>
				BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession),
			),
		);
		const advisorReadOnlyTools: Tool[] = built
			.filter((tool): tool is Tool => tool != null)
			.map(wrapToolWithMetaNotice);

		let advisorWatchdogPrompt: string | undefined;
		const advisorWatchdogBlocks = [...(watchdogFiles ?? [])];
		// Built-in active-repo watchdog: when the cwd sits outside git with exactly
		// one direct child repo, the advisor gets the same "check under <repo>/"
		// guardrail the primary system prompt renders — appended after user
		// watchdog files so user rules stay first.
		const advisorActiveRepoContext = await resolveActiveRepoContext(cwd);
		if (advisorActiveRepoContext) {
			advisorWatchdogBlocks.push(formatActiveRepoWatchdogPrompt(advisorActiveRepoContext));
		}
		if (advisorWatchdogBlocks.length > 0) {
			advisorWatchdogPrompt = advisorWatchdogBlocks.join("\n\n");
		}
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		session = new AgentSession({
			advisorWatchdogPrompt,
			agent,
			pruneToolDescriptions: resolveInlineToolDescriptors(
				resolveDialect(settings.get("tools.format"), model) === undefined,
			),
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			sessionManager,
			settings,
			autoApprove: options.autoApprove,
			clientBridge: options.clientBridge,
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
			skills: skills(),
			skillWarnings,
			reloadSkills:
				options.skills === undefined
					? async () =>
							await logger.time("discoverSkills", discoverSkills, sessionManager.getCwd(), agentDir, {
								...settings.getGroup("skills"),
								disabledExtensions: settings.get("disabledExtensions") ?? [],
							})
					: undefined,
			onSkillsChanged: next => {
				skillsState.current = next;
				if (!options.parentTaskPrefix) {
					setActiveSkills(next);
				}
			},
			skillsSettings: settings.getGroup("skills"),
			moa: moaResolved.moa
				? {
						laneLabels: moaResolved.moa.lanes.map(
							lane => lane.label ?? `${lane.model.provider}/${lane.model.id}`,
						),
					}
				: undefined,
			modelRegistry,
			toolRegistry,
			builtInToolNames,
			transformContext,
			onPayload,
			onResponse,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			reloadSshTool,
			requestedToolNames: requestedToolNameSet,
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
			mcpDiscoveryEnabled,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: [...discoveryDefaultServers],
			ttsrManager,
			obfuscator,
			agentId: resolvedAgentId,
			collaborationPolicy: options.collaborationPolicy,
			toolProfile: options.toolProfile,
			toolSourceOf: resolveToolSource,
			agentKind,
			providerSessionId: options.providerSessionId,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorReadOnlyTools,
		});
		hasSession = true;
		if (scopedAsyncJobManager) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => scopedAsyncJobManager.isDeliverySuppressed(entry.jobId),
				build: buildAsyncResultBatchMessage,
			});
		}
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
			isStale: entry => entry.isStale(),
			build: buildLateDiagnosticsBatchMessage,
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		agentRegistry.attachSession(resolvedAgentId, session, sessionManager.getSessionFile() ?? null);
		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					// Reject new session work (Python/eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose();
				} finally {
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
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
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
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

		// Auto-learn can immediately trigger a synthetic capture turn after the
		// first real stop. When a memory backend is selected, install that backend's
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
		if (settings.get("autolearn.enabled") && taskDepth === 0) {
			await logger.time("startMemoryStartupTask", startMemoryBackend);
			new AutoLearnController({ session, settings });
		} else {
			void logger.time("startMemoryStartupTask", startMemoryBackend);
		}

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(tools => {
				void (async () => {
					try {
						await session.refreshMCPTools(
							tools,
							deferMCPDiscoveryForUI && !mcpDiscoveryEnabled && options.toolNames === undefined
								? { activateAll: true }
								: undefined,
						);
						if (deferMCPDiscoveryForUI && !mcpDiscoveryEnabled && explicitlyRequestedMCPToolNames.length > 0) {
							await session.setActiveToolsByName([
								...session.getActiveToolNames(),
								...explicitlyRequestedMCPToolNames,
							]);
						}
					} catch (error) {
						logger.warn("MCP tool refresh failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
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
		if (deferMCPDiscoveryForUI) {
			// The fallback must not race the one-shot trigger against the
			// `AgentSession` assignment above. Schedule only after the live session
			// and manager callbacks are fully wired.
			const fallbackTimer = setTimeout(() => {
				triggerDeferredDiscovery();
			}, 0);
			fallbackTimer.unref?.();
		}

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
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
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
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
