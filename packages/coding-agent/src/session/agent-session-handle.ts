/**
 * Cross-agent views of an {@link AgentSession}.
 *
 * Code that reaches another agent's session — through the agent registry,
 * lifecycle revival, IRC delivery, `agent://`/`history://`/`proc://`, the
 * Agent Hub, or RPC-mode subagent control — holds an {@link AgentSessionHandle}
 * instead of the concrete class, so a session homed on another thread can be
 * represented by a proxy with the same surface. The TUI's focused-subagent
 * view additionally reads {@link AgentViewSession}.
 */
import type { AgentMessage, AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, ImageContent, Model, ServiceTier, ToolResultMessage, UsageReport } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { JobWidgetEntry } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { Rule } from "../capability/rule";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState } from "../goals/state";
import type { ApprovalGrantStore } from "../tools/approval-cache";
import type { TokenRateMeter } from "../utils/token-rate";
import type { AgentDefinition } from "../task/types";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import { currentThreadId } from "../thread/identity";
import type { AgentSession } from "./agent-session";
import type { AgentSessionEvent, AgentSessionEventListener } from "./agent-session-events";
import type {
	AgentSessionDisposeOptions,
	AsyncJobInspection,
	AsyncJobSnapshot,
	AsyncJobTree,
	EphemeralTurnOptions,
	EphemeralTurnResult,
	Prewalk,
	PromptOptions,
	ResolvedRoleModel,
	RestoredQueuedMessage,
	RoleModelCycle,
	RoleModelCycleResult,
	SessionStats,
	SteerOptions,
} from "./agent-session-types";
import type { BlobPutOptions, BlobPutResult } from "./blob-store";
import type { IdleMaintenanceOptions } from "./idle-maintenance";
import type { CustomMessage } from "./messages";
import type { ServingModel } from "./retry-fallback-chains";
import type { AdvisorStatusOverviewEntry } from "./session-advisors";
import type { SessionContext, TranscriptSessionContextOptions } from "./session-context";
import type { ModelUsageEntry, SessionEntry, UsageStatistics } from "./session-entries";

/** Session-manager reads other agents' code performs on a session it does not own. */
export interface AgentSessionManagerHandle {
	/** Working directory of the session (its worktree for isolated subagents). */
	getCwd(): string;
	/** Stable session id. */
	getSessionId(): string;
	/** Transcript path, or undefined when the session is not persisted. */
	getSessionFile(): string | undefined;
	/** Artifacts directory, or null when the session is not persisted. */
	getArtifactsDir(): string | null;
	/** Cumulative usage, including off-transcript model calls and nested task results. */
	getUsageStatistics(): UsageStatistics;
}

/** Live agent-loop state other agents' code reads on a session it does not own. */
export interface AgentSessionLoopStateHandle {
	/** Full message list, including custom message types. */
	readonly messages: AgentMessage[];
	/** Assistant message still streaming (never persisted until `message_end`). */
	readonly streamMessage: AgentMessage | null;
	/** Ids of tool calls dispatched but not finished. */
	readonly pendingToolCalls: Set<string>;
}

/** Agent-loop surface other agents' code reads on a session it does not own. */
export interface AgentSessionLoopHandle {
	/** Whether the loop is held at a pause gate. */
	readonly isPaused: boolean;
	/** Live loop state. */
	readonly state: AgentSessionLoopStateHandle;
}

/** Advisor overview of a session, as reported by `getAdvisorStatusOverview`. */
export interface AgentSessionAdvisorOverview {
	/** Whether any advisor is configured for the session. */
	configured: boolean;
	/** Per-advisor status rows. */
	advisors: AdvisorStatusOverviewEntry[];
}

/** The surface other agents' code uses on a session obtained from the registry, lifecycle, or IRC delivery. */
export interface AgentSessionHandle {
	/** Cross-thread identity token: `${homeThreadId}:${snowflake}`, unique per session object. */
	readonly instanceKey: string;
	/** Agent loop pause flag and live state. */
	readonly agent: AgentSessionLoopHandle;
	/** Session-manager reads. */
	readonly sessionManager: AgentSessionManagerHandle;
	/** Whether the agent is currently streaming a response. */
	readonly isStreaming: boolean;
	/** When the current run started; undefined between runs. */
	readonly runStartedAt: number | undefined;
	/** Whether the session still owes turns to IRC messages (held, queued, or awaiting compaction). */
	readonly ircWakesPending: boolean;
	/** Full message list, including custom message types. */
	readonly messages: AgentMessage[];
	/** Current transcript path, or undefined when sessions are disabled. */
	readonly sessionFile: string | undefined;
	/** Current model, when selected. */
	readonly model: Model | undefined;
	/** Effective thinking level applied to the agent. */
	readonly thinkingLevel: ThinkingLevel | undefined;
	/** Model actually serving requests when a fallback is active. */
	readonly servingModel: ServingModel | undefined;
	/** Session-local extension roots for post-startup rediscovery. */
	readonly effectiveExtensionRoots: EffectiveExtensionRoots;
	/** Whether the hindsight memory backend is active for the session. */
	readonly hindsightActive: boolean;
	/** Subscribe to every session event; returns the unsubscribe function. */
	subscribe(listener: AgentSessionEventListener): () => void;
	/** Subscribe to authoritative running/idle transitions; returns the unsubscribe function. */
	subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
	/** Token, request, tool, and cost totals of the session. */
	getSessionStats(): SessionStats;
	/** Advisor overview of the session. */
	getAdvisorStatusOverview(): AgentSessionAdvisorOverview;
	/** Session-local general-purpose agents pinned to user-tagged models. */
	getSessionAgents(): AgentDefinition[];
	/** Whether a message from `from` still waits for a turn of its own. */
	hasQueuedIrcFrom(from: string): boolean;
	/** Surface and consume every pending IRC record before automatic injection; with `ifAny`,
	 *  none unless at least one of them satisfies it. */
	drainPendingIrcInboxMessages(agentId: string, opts?: { ifAny?: (msg: IrcMessage) => boolean }): IrcMessage[];
	/** Emit a display-only IRC relay observation on this session's UI. */
	emitIrcRelayObservation(record: CustomMessage): void;
	/** Deliver an IRC message into this recipient session. */
	deliverIrcMessage(msg: IrcMessage): Promise<"injected" | "woken">;
	/** Wait for any in-flight IRC wake-turn relays. */
	waitForIrcReplies(): Promise<void>;
	/** Send a prompt (or steer/follow up while streaming, per `options.streamingBehavior`). */
	prompt(text: string, options?: PromptOptions): Promise<boolean>;
	/** Queue a steering message for the next step boundary. */
	steer(text: string, images?: ImageContent[], options?: SteerOptions): Promise<void>;
	/** Abort the current operation and wait for the agent to become idle. */
	abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		preserveCompaction?: boolean;
		deliverQueuedMessages?: boolean;
	}): Promise<void>;
	/** Replace the pooled-turn yield contract. */
	setWorkPoolYieldItems(items: readonly WorkPoolYieldItem[]): Promise<void>;
	/** Dispose the session and release its resources. */
	dispose(options?: AgentSessionDisposeOptions): Promise<void>;
}

/** Session-manager surface the TUI uses on the session it shows (transcript, todo HUD, /btw, image chips). */
export interface AgentViewSessionManager extends AgentSessionManagerHandle {
	/** Display name of the session. */
	getSessionName(): string | undefined;
	/** Every entry of the session file. */
	getEntries(): SessionEntry[];
	/** Entries from the root to `fromId` (default: the current leaf). */
	getBranch(fromId?: string): SessionEntry[];
	/** Id of the current leaf entry. */
	getLeafId(): string | null;
	/** The newest entry that moves the conversation, when the active branch ends at it (`conversationTip`). */
	getConversationTip(): SessionEntry | undefined;
	/** Artifacts directory of the consulted seance source, when this is a seance session. */
	getSeanceSourceArtifactsDir(): string | null;
	/** Append a custom entry (a worker-homed session appends on its home thread). */
	appendCustomEntry(customType: string, data?: unknown): void;
	/** Flush pending writes to disk. */
	flush(): Promise<void>;
	/** Materialize the session file on disk. */
	ensureOnDisk(): Promise<void>;
	/** Record an off-transcript model call under the entry `owner.parentId` (a worker-homed session records on its home thread). */
	appendModelUsage(
		usage: Pick<
			ModelUsageEntry,
			"purpose" | "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
		>,
		owner: { sessionId: string; parentId: string | null },
	): void;
	/** Store a blob in the session's blob store. */
	putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult>;
	/** Store a blob in the session's blob store synchronously. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult;
	/** Path of a session artifact, or null when it is gone. */
	getArtifactPath(id: string): Promise<string | null>;
	/** In-memory content of a session artifact (non-persistent sessions), or null; a worker-homed session answers asynchronously. */
	getArtifactContent(id: string): string | null | Promise<string | null>;
}

/** TTSR rule source the TUI's link resolver reads. */
export interface AgentViewRuleSource {
	/** Every loaded rule. */
	getRules(): Rule[];
}

/** The part of a registered tool the status line sizes (its prompt schema). */
export type AgentViewToolSchema = Pick<AgentTool, "name" | "description" | "parameters">;

/** Live agent-loop state the TUI reads on the session it shows. */
export interface AgentViewLoopState extends AgentSessionLoopStateHandle {
	/** Schemas of the tools registered on the loop (the status line sizes them). */
	readonly tools: readonly AgentViewToolSchema[];
}

/** Agent-loop surface the TUI reads on the session it shows. */
export interface AgentViewLoop extends AgentSessionLoopHandle {
	/** Live loop state, including registered tools. */
	readonly state: AgentViewLoopState;
	/** Tool results recorded for calls not yet folded into the transcript. */
	getPendingToolResults(): readonly ToolResultMessage[];
}

/** Agent state the status line reads on the session it shows. */
export interface AgentViewState {
	/** Model of the agent loop, when one is selected. */
	readonly model: Model | undefined;
	/** Effort applied to the agent loop. */
	readonly thinkingLevel?: Effort;
	/** Full message list, including custom message types. */
	readonly messages: AgentMessage[];
}

/** Live `tool_execution_update` event replayed when the TUI attaches mid-tool. */
export type ToolExecutionUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

/**
 * Whether `session` is homed on this thread. Thread bridges decode a handle
 * homed here to the local {@link AgentSession} object itself, so code running on
 * an agent's home thread (its executor, prompt builders, revivers) may use the
 * full class. Test doubles carry no identity token and stand in for local sessions.
 */
export function isLocalAgentSession(session: AgentSessionHandle): session is AgentSession {
	const key: unknown = Reflect.get(session, "instanceKey");
	return typeof key !== "string" || key.startsWith(`${currentThreadId()}:`);
}

/**
 * Whether `session` exposes the TUI view surface. Local sessions and the main
 * thread's mirrors of worker-homed sessions (`RemoteAgentSession`) do; a
 * worker's peer handle of a session homed elsewhere does not, and the TUI never
 * runs on a worker. Structural so test doubles of a view session qualify.
 */
export function isAgentViewSession(session: AgentSessionHandle): session is AgentViewSession {
	return typeof Reflect.get(session, "activeToolExecutionUpdates") === "function";
}

/** Extra surface the TUI reads on a focused subagent (`ctx.viewSession`). */
export interface AgentViewSession extends AgentSessionHandle {
	/** Agent loop pause flag, live state, and pending tool results. */
	readonly agent: AgentViewLoop;
	/** Agent loop state (same object as `agent.state`). */
	readonly state: AgentViewState;
	/** Session-manager surface for transcript rendering and HUD persistence. */
	readonly sessionManager: AgentViewSessionManager;
	/** Settings scope of the session (link resolution, todo HUD timing). */
	readonly settings: Settings;
	/** Model registry the session resolves models and auth through. */
	readonly modelRegistry: ModelRegistry;
	/** Extension runner, when extensions are loaded. */
	readonly extensionRunner: ExtensionRunner | undefined;
	/** Stable session id. */
	readonly sessionId: string;
	/** Generation tok/s meter of this session. */
	readonly tokenRate: TokenRateMeter;
	/** TTSR rule manager, when rules are loaded. */
	readonly ttsrManager: AgentViewRuleSource | undefined;
	/** Whether the transcript ends in a tool call that was aborted before its result. */
	readonly hasAbortedToolCallTail: boolean;
	/** Effective system prompt blocks. */
	readonly systemPrompt: string[];
	/** Skills available to the session. */
	readonly skills: readonly Skill[];
	/** Whether the effective thinking level is resolved automatically. */
	readonly isAutoThinking: boolean;
	/** Whether a compaction is in progress. */
	readonly isCompacting: boolean;
	/** Speculative compaction state. */
	readonly compactionSpeculation: "idle" | "running" | "armed";
	/** Bumped whenever context usage changes. */
	readonly contextUsageRevision: number;
	/** Whether a handoff is being generated. */
	readonly isGeneratingHandoff: boolean;
	/** Whether a retry is pending. */
	readonly isRetrying: boolean;
	/** Current retry attempt (0 when not retrying). */
	readonly retryAttempt: number;
	/** Whether a TTSR abort is pending. */
	readonly isTtsrAbortPending: boolean;
	/** Whether input is queued that an interrupt would act on. */
	readonly hasInterruptibleInput: boolean;
	/** Tool execution updates of tools still running, for mid-tool attach. */
	activeToolExecutionUpdates(): readonly ToolExecutionUpdateEvent[];
	/** Await persistence of messages already emitted. */
	settleInFlightMessagePersistence(): Promise<void>;
	/** Session context for transcript rendering. */
	buildTranscriptSessionContext(options?: TranscriptSessionContextOptions): SessionContext;
	/** Context-window usage of the current conversation. */
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined;
	/** Thinking level resolved by `auto`, when active. */
	autoResolvedThinkingLevel(): Effort | undefined;
	/** Configured (possibly `auto`) thinking level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	/** Thinking levels selectable for the current model. */
	getAvailableEffortSelectors(): ConfiguredThinkingLevel[];
	/** Set the thinking level, optionally persisting it. */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist?: boolean): void;
	/** Advance to the next thinking level. */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined;
	/** Thinking level a temporary switch to `model` would use. */
	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined;
	/** Switch model without persisting it as the default. */
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	/** Model-role cycle for the given role order. */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined;
	/** Cycle through role models. */
	cycleRoleModels(
		roleOrder: readonly string[],
		direction?: "forward" | "backward",
	): Promise<RoleModelCycleResult | undefined>;
	/** Apply a resolved role model. */
	applyRoleModel(entry: ResolvedRoleModel): Promise<void>;
	/** Service tier in effect for `model`. */
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	/** Whether fast mode is active. */
	isFastModeActive(): boolean;
	/** Anthropic usage-limit label, when one applies. */
	getAnthropicSlowModeLabel(): string | undefined;
	/** Active prewalk state. */
	getPrewalkState(): Prewalk | undefined;
	/** Goal-mode state. */
	getGoalModeState(): GoalModeState | undefined;
	/** Total advisor cost. */
	getAdvisorCost(): number;
	/** Whether advisors bill through a subscription. */
	isAdvisorUsingSubscription(): boolean;
	/** Provider usage reports for the active account. */
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null>;
	/** Snapshot of the session's async jobs. */
	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null;
	/** Tree of the session's async jobs. */
	getAsyncJobTree(options?: { recentLimit?: number }): AsyncJobTree | null;
	/** Widgets of running background jobs. */
	getRunningJobWidgets(): JobWidgetEntry[];
	/** Details of one async job. */
	inspectAsyncJob(id: string): AsyncJobInspection | undefined;
	/** Cancel one async job; returns whether it was running. */
	cancelAsyncJob(id: string): boolean;
	/** Ask running jobs to refresh their captions. */
	requestJobCaptions(): void;
	/** Todo phases of the session. */
	getTodoPhases(): TodoPhase[];
	/** Replace the todo phases of the session. */
	setTodoPhases(phases: TodoPhase[]): void;
	/** Replace the list from outside the `todo` tool: update the cache and record a `user_todo_edit` entry so reloads keep it. */
	commitTodoPhases(phases: TodoPhase[]): void;
	/** Whether the user approved approval scope `key` for the rest of this session, so its prompt is skipped. */
	hasSessionApproval(key: string): boolean;
	/** Remembered `always-ask-cached` grants this session's tool calls are checked against. */
	getApprovalGrants(): ApprovalGrantStore;
	/** Registered tool by name. */
	getToolByName(name: string): AgentTool | undefined;
	/** Whether a built-in tool with this name is registered. */
	hasBuiltInTool(name: string): boolean;
	/** Queued steering and follow-up messages. */
	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[]; liveSteered: number };
	/** Remove and return the newest queued message. */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined;
	/** Resume an interrupted turn. */
	resume(): Promise<void>;
	/** Retry the last failed turn. */
	retry(): Promise<boolean>;
	/** Cancel a pending retry. */
	abortRetry(): void;
	/** Cancel an in-progress compaction. */
	abortCompaction(reason?: unknown): void;
	/** Cancel an in-progress handoff. */
	abortHandoff(): void;
	/** Run a side turn (e.g. /btw) against the session's model without touching its transcript. */
	runEphemeralTurn(args: EphemeralTurnOptions): Promise<EphemeralTurnResult>;
	/** Whether an ephemeral turn's `maxTokens` reaches the provider unchanged. */
	ephemeralMaxTokensPreservesRequest(): boolean;
	/** Export the transcript to HTML; returns the written path. */
	exportToHtml(outputPath?: string, useUserThemes?: boolean): Promise<string>;
	/** Bind idle maintenance to this session. */
	enableIdleMaintenance(options?: IdleMaintenanceOptions): void;
	/** Re-evaluate idle maintenance scheduling. */
	refreshIdleMaintenance(): void;
}
