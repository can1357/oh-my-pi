import type {
	Agent,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	StreamFn,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	OAuthAccountSummary,
	ServiceTierByFamily,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import type { postmortem } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CursorMcpResourceAdapter } from "../cursor";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import type { EvalPreludeDefinition } from "../eval/preludes";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { ExtensionRunner, PreparedExtension } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { XdevState } from "../tools/xdev";
import type { CodexAutoRedeemCoordinator } from "./codex-auto-reset";
import type { SessionManager } from "./session-manager";

/** Maximum time the interactive shutdown path waits for Mnemopi consolidation. */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

/** Options controlling session disposal. */
export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/**
	 * Deadline for the settle/drain wait before the terminal memory release
	 * (default 5s). The bounded-teardown paths (signal handlers, tests) may
	 * shorten it; late event handlers are still finalized after they settle.
	 */
	drainTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
	reason?: postmortem.Reason;
}

/** Listener notified when command metadata changes. */
export type CommandMetadataChangedListener = () => void | Promise<void>;
/** Public summary of an asynchronous job. */
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime" | "agentId">;

/** Snapshot of running, recent, and pending-delivery asynchronous jobs. */
export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult } from "./shake-types";

/**
 * Prewalk switches an active session one-way from its starting model to a
 * fast/cheap target after implementation begins.
 */
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * PlanYolo starts in read-only plan mode, auto-approves the proposal, then
 * switches to a target model for implementation.
 */
export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** Details shown when confirming a usage-reserve-triggered model fallback. */
export interface UsageFallbackConfirmation {
	from: string;
	to: string;
	remainingPercent: number | undefined;
}

/**
 * Confirms whether a reserve-triggered model fallback may proceed.
 *
 * Interactive callers use the confirmation details to present the pending
 * route change; aborting `signal` cancels that pending confirmation.
 */
export type UsageFallbackConfirmer = (confirmation: UsageFallbackConfirmation, signal: AbortSignal) => Promise<boolean>;

/** Identifies a retry fallback chain already entered during startup model resolution. */
export interface InitialRetryFallbackState {
	/** Role whose configured primary was unavailable. */
	role: string;
	/** Configured primary selector retained for restoration when it becomes available. */
	originalSelector: string;
	/** Thinking selector configured for the unavailable primary. */
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	/** Prevent cooldown restoration when startup selected this fallback from live usage health. */
	pinned?: boolean;
}

/** Dependencies and initial state used to construct an AgentSession. */
export interface AgentSessionConfig {
	agent: Agent;
	/** Shared with the provider stream wrapper: current Codex Code Mode tool exposure snapshot for turn metadata. */
	codeModeState?: { namespacesInfo?: unknown };
	sessionManager: SessionManager;
	settings: Settings;
	/**
	 * Live extension-root policy inherited from the owning session. Subagents use
	 * this provider so explicit roots, discovery mode, configured roots, and
	 * provenance survive recursive task discovery.
	 */
	extensionRoots?: () => EffectiveExtensionRoots;
	/**
	 * Parent-imported extension factories rebound to this session's own
	 * ExtensionAPI. Forwarded by session forks (e.g. `/tan`) so the child
	 * re-registers the parent's runtime providers before the SDK's
	 * `syncExtensionSources` prune runs against the shared model registry.
	 */
	preparedExtensions?: readonly PreparedExtension[];
	/**
	 * Source paths of the parent's loaded extensions. Forwarded alongside
	 * {@link preparedExtensions} as the fallback the child rebinds from when a
	 * parent construction path produced no prepared factories (mirrors the task
	 * subagent forward) — keeps the child from building an empty extension set.
	 */
	extensionPaths?: readonly string[];
	/** Raw SDK `additionalExtensionPaths`; used when no inherited root provider exists. */
	additionalExtensionPaths?: readonly string[];
	/** Mirror of `disableExtensionDiscovery`; used when no inherited root provider exists. */
	disableExtensionDiscovery?: boolean;
	/** Whether the session spawn policy permits the read-only `scout` subagent. Defaults to true. */
	scoutAllowedBySpawnPolicy?: boolean;
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/** Models to cycle through with Ctrl+P (from --models flag). */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); every later change, including retry-fallback recovery, is re-clamped to it. */
	thinkingLevelCeiling?: Effort;
	/** Retry chain ownership when startup selected one of its fallback entries. */
	initialRetryFallback?: InitialRetryFallbackState;
	/** Prewalk from the starting model to a fast/cheap target after implementation begins. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve, then switch to the target. */
	planYolo?: PlanYolo;
	/** Initial per-family service tiers for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion. */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion. */
	slashCommands?: FileSlashCommand[];
	/** Extension runner created with wrapped tools. */
	extensionRunner?: ExtensionRunner;
	/** Returns the current enabled eval prelude definitions. */
	getEvalPreludes?: () => readonly EvalPreludeDefinition[];
	/** Loaded skills already discovered by the SDK. */
	skills?: Skill[];
	/** Skill loading warnings already captured by the SDK. */
	skillWarnings?: SkillWarning[];
	/** Whether runtime reloads may rediscover disk-backed skills. */
	skillsReloadable?: boolean;
	/** Custom TypeScript slash commands. */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Agent directory used when changing memory backends in a live session. */
	memoryAgentDir?: string;
	/** Recursion depth used to suppress live backend replacement in subagents. */
	memoryTaskDepth?: number;
	/** Creates built-in memory tools for the current backend. */
	createMemoryTools?: () => Promise<AgentTool[]>;
	/** Creates the private `think` scratchpad tool for runtime setting changes. */
	createThinkTool?: () => Promise<AgentTool | null>;
	/** Model registry for API key resolution and model discovery. */
	modelRegistry: ModelRegistry;
	/** Whether the startup model may be replaced by refreshed same-selector registry metadata. */
	rebindModelAfterDiscovery?: boolean;
	/** Tool registry for LSP and settings. */
	toolRegistry?: Map<string, AgentTool>;
	/** Creates tools registered only while vibe mode is active. */
	createVibeTools?: () => AgentTool[];
	/** Names whose current registry entry is the built-in implementation. */
	builtInToolNames?: Iterable<string>;
	/** MCP names whose initial registry entries came from the manager snapshot. */
	mcpManagerToolNames?: Iterable<string>;
	/** Reconcile browser MCP connections after browser prelude availability changes. */
	reconcileBrowserMcpFilter?: (enabled: boolean) => Promise<CustomTool[]>;
	/** Updates tool-session predicates from the live active tool set. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Registers the built-in write transport when it is needed at runtime. */
	ensureWriteRegistered?: () => Promise<boolean>;
	/** Reports whether the registered write tool is currently transport-only. */
	isDeviceOnlyWrite?: () => boolean;
	/** Switches the registered write tool between transport-only and full access. */
	setDeviceOnlyWrite?: (enabled: boolean) => void;
	/** Previews the full-write description without changing execution access. */
	setPendingFullWriteDescription?: (enabled: boolean) => void;
	/** Registers the hidden `goal` tool when goal mode is enabled at runtime. */
	ensureGoalRegistered?: () => Promise<boolean>;
	/** Current session pre-LLM message transform pipeline. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider request transform applied after message conversion. */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/** Stream wrapper for side-channel requests. */
	sideStreamFn?: StreamFn;
	/** Stream wrapper for advisor requests. */
	advisorStreamFn?: StreamFn;
	/** Prefer websocket transport for OpenAI Codex requests when supported. */
	preferWebsockets?: boolean;
	/** Codex saved-reset coordinator; defaults to the process-wide singleton so concurrent sessions can't double-spend. Inject a fresh one in tests. */
	codexResetCoordinator?: CodexAutoRedeemCoordinator;
	/** Provider payload hook used by the active session request path. */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path. */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path. */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer. */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline. */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. */
	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;
	/** Tools mounted under `xd://`, for `/tools` display. */
	getXdevToolEntries?: () => Array<{ name: string; summary: string }>;
	/** `xd://` presentation state backed by the canonical tool map. */
	xdev?: XdevState;
	/** Names pinned top-level during runtime repartitioning. */
	presentationPinnedToolNames?: ReadonlySet<string>;
	/** Accessor for live MCP server instructions. */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Time-traveling stream-rule manager. */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for provider and edit content. */
	obfuscator?: SecretObfuscator;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained eval kernels created by this session. */
	evalKernelOwnerId?: string;
	/** Async job manager owned and disposed by this session. */
	ownedAsyncJobManager?: AsyncJobManager;
	/** Async job manager visible to this session. */
	asyncJobManager?: AsyncJobManager;
	/** Registry identity used for IRC routing. */
	agentId?: string;
	/** Whether this is a top-level or subagent session. */
	agentKind?: "main" | "sub";
	/** Provider-facing session ID override. */
	providerSessionId?: string;
	/** Whether the provider prompt-cache key was explicit or fork-inherited. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Full advisor toolset built against an advisor-scoped tool session. */
	advisorTools?: AgentTool[];
	/**
	 * Build a `grep` honoring a Cursor `pi_grep` frame's own context width and
	 * match cap, against the advisor-scoped tool session. Without it an advisor
	 * running on Cursor silently drops both fields.
	 */
	advisorCreateGrepTool?(options: { context?: number; totalMatchLimit?: number }): AgentTool | undefined;
	/**
	 * Build the `replace`-mode `edit` a Cursor `pi_edit` frame needs, against the
	 * advisor-scoped tool session. The advisor's ordinary instance follows the
	 * configured `edit.mode` and rejects the frame's `old_string`/`new_string` args.
	 */
	advisorCreateEditTool?(): AgentTool | undefined;
	/**
	 * The execute-time context the advisor's bridge tools resolve approval from.
	 *
	 * `ExtensionToolWrapper` reads `tools.approvalMode`, per-tool
	 * `tools.approval.<tool>` policies and `autoApprove` only from this context;
	 * with none it defaults to `yolo` with empty policies, so a bridge tool would
	 * run a native frame the user configured `ask` or `deny` for.
	 */
	advisorGetToolContext?: () => AgentToolContext | undefined;
	/**
	 * The live MCP connections the advisor's Cursor resource frames answer from.
	 *
	 * Advisors share the session's connections and may be granted tools from
	 * those same servers; without this their `list_mcp_resources` reports an
	 * empty catalog and every `read_mcp_resource` a `not_found`.
	 */
	advisorMcpResources?: CursorMcpResourceAdapter;
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Shared advisor instructions loaded from WATCHDOG.yml. */
	advisorSharedInstructions?: string;
	/** Project context rendered for advisor sessions. */
	advisorContextPrompt?: string;
	/** Memory backend developer instructions rendered for advisor sessions. */
	advisorMemoryPrompt?: string;
	/** Advisors discovered from WATCHDOG.yml. */
	advisorConfigs?: AdvisorConfig[];
	/** Strip tool descriptions from provider-bound side-request tool specs. */
	pruneToolDescriptions?: boolean;
	/** Disconnect the MCP manager owned by this session during disposal. */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/** System prompt used by automatic session-title generation. */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt(). */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Image attachments. */
	images?: ImageContent[];
	/** Queue behavior while streaming. `"aside"` is non-interrupting — it does not steer/follow-up
	 *  an in-flight tool batch, injecting at the next step boundary instead (see
	 *  AgentSession.sendUserMessage's `deliverAs: "aside"`). */
	streamingBehavior?: "steer" | "followUp" | "aside";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as a developer/system message instead of user. */
	synthetic?: boolean;
	/** Whether this prompt is a deliberate user action. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt. */
	skipCompactionCheck?: boolean;
}

/** Payload for {@link AgentSession.setPromptDropped}: a user prompt cancelled
 *  before it reached the agent (an abort or usage preflight denial raced turn
 *  setup), so it was never persisted to the session. */
export interface DroppedPrompt {
	/** The prompt exactly as typed, before template/command expansion. */
	text: string;
	/** Image attachments submitted with the prompt. */
	images?: ImageContent[];
}

/** Options for AgentSession.followUp(). */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

/** Options controlling handoff generation. */
export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

/** Result from cycleModel(). */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models or all available models. */
	isScoped: boolean;
}

/** Result from cycleRoleModels(). */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** Resolvable role models and the currently active index. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

/** Token breakdown for the current provider context. */
export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for the `/session` command. */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	credits?: {
		cost: number;
		committedCost: number;
		acuCost: number;
	};
	/** Concrete provider-routed model ids with finalized turn counts. */
	routedModels?: Record<string, number>;
	contextUsage?: ContextUsage;
}

/** Stored OAuth accounts available to the current model provider. */
export interface SessionOAuthAccountList {
	provider: string;
	accounts: OAuthAccountSummary[];
}

/** IDs for a newly created session and the session it replaced. */
export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Outcome of an in-place `/clear` conversation-context reset. */
export interface ResetSessionContextResult {
	/** Number of live messages dropped from the model's context. */
	droppedCount: number;
}

/** Queued user content restored to the editor. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };
