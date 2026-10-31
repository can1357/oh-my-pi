/**
 * Main-thread mirror of an agent session homed on a subagent worker.
 *
 * Created when the worker's `SessionPublisher` posts `opened` and held by the
 * session directory until `closed` (or the worker dies). It serves both the
 * cross-agent {@link AgentSessionHandle} surface and the TUI's
 * {@link AgentViewSession} surface, without ever blocking on the worker:
 *
 * - handle state reads come from the mirrored {@link SessionMirrorState} and
 *   message list the publisher keeps current;
 * - view reads come from the {@link SessionViewState} and entry list the
 *   publisher pushes while main watches the session (any `subscribe`
 *   listener, e.g. the focused TUI view; the entry list is kept between
 *   watches, so a new watch only catches it up), or are computed on main
 *   from them: the transcript context (entries + leaf), role-model cycles,
 *   temporary model thinking levels and service tiers (main-side settings
 *   and model registry), async job views (the root job manager scoped to the
 *   child's agent id), and generation tok/s (a main-local meter fed by
 *   forwarded events);
 * - `settings` is rebuilt on main from the main instance the worker's
 *   settings mirror plus the child's own overlay layers, and `modelRegistry`
 *   is the main registry the worker's registry mirrors;
 * - tool renderers and extension renderers resolve through the nearest
 *   main-thread ancestor session (worker tool copies carry no render hooks);
 * - synchronous commands (thinking level, queued-message restore, todo
 *   phases, custom entries) apply optimistically to the mirror and are sent
 *   to the home worker, whose next patch reconciles; asynchronous commands
 *   are RPC to the publisher.
 *
 * `subscribe` turns the worker's event stream (and view state) on while any
 * listener is attached; run-state listeners are fed by every transition the
 * publisher reports. A closed mirror keeps its last state, rejects commands
 * with an error naming the worker, and treats `dispose` as already done.
 */
import { type AgentMessage, type AgentTool, ThinkingLevel, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Effort, ImageContent, Model, ServiceTier, ToolResultMessage, UsageReport } from "@oh-my-pi/pi-ai";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { JobWidgetEntry } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManagerApi } from "../async";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState } from "../goals/state";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent, AgentSessionEventListener } from "../session/agent-session-events";
import {
	type AgentSessionAdvisorOverview,
	type AgentViewLoop,
	type AgentViewRuleSource,
	type AgentViewSession,
	type AgentViewSessionManager,
	type AgentViewState,
	isLocalAgentSession,
	type ToolExecutionUpdateEvent,
} from "../session/agent-session-handle";
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
} from "../session/agent-session-types";
import {
	asyncJobSnapshot,
	asyncJobTree,
	cancelOwnedAsyncJob,
	inspectAsyncJob,
	requestJobTreeCaptions,
	runningJobWidgets,
} from "../session/async-job-views";
import { BlobStore, type BlobPutOptions, type BlobPutResult, lazyImageDataSync } from "../session/blob-store";
import type { IdleMaintenanceOptions } from "../session/idle-maintenance";
import type { CustomMessage } from "../session/messages";
import { resolveRoleModelCycle, roleThinkingLevelForModel, serviceTierForModel } from "../session/model-controls";
import type { ServingModel } from "../session/retry-fallback-chains";
import {
	buildSessionContext,
	type SessionContext,
	type TranscriptSessionContextOptions,
} from "../session/session-context";
import type { CustomEntry, SessionEntry } from "../session/session-entries";
import { conversationTip, lastModelChangeRole, SessionEntryIndex } from "../session/session-manager";
import type { AgentDefinition } from "../task/types";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import { type ApprovalGrantStore, getApprovalGrants } from "../tools/approval-cache";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import { TokenRateMeter } from "../utils/token-rate";
import type { ThreadId } from "./identity";
import { type RemoteObject, RpcClosedError, rpcSync } from "./rpc";
import {
	type SessionAbortOptions,
	type SessionEntriesDelta,
	type SessionHostProtocol,
	type SessionMessagesDelta,
	type SessionMirrorState,
	type SessionQueuedEntry,
	type SessionRestorableQueue,
	type SessionRunState,
	type SessionViewState,
	toWireData,
} from "./session-mirror";

/** Main-side proxy of a worker's publisher (remote-object kind `"agent-session-host"`). */
export class SessionHostClient {
	constructor(readonly remote: RemoteObject<SessionHostProtocol>) {}
}

/** State of a mirror that never received (or no longer has) data from its home. */
export function emptyMirrorState(): SessionMirrorState {
	return {
		isStreaming: false,
		runStartedAt: undefined,
		ircWakesPending: false,
		ircQueuedFrom: [],
		isPaused: false,
		streamMessage: null,
		pendingToolCalls: [],
		model: undefined,
		servingModel: undefined,
		thinkingLevel: undefined,
		sessionFile: undefined,
		sessionId: "",
		cwd: "",
		artifactsDir: null,
		usageStatistics: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			subagentCost: 0,
		},
		sessionStats: {
			sessionFile: undefined,
			sessionId: "",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			premiumRequests: 0,
			cost: 0,
		},
		advisorOverview: { configured: false, advisors: [] },
		sessionAgents: [],
		hindsightActive: false,
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
	};
}

/** View state of a mirror main has not watched yet. */
function emptyViewState(): SessionViewState {
	return {
		providerSessionId: "",
		sessionName: undefined,
		seanceSourceArtifactsDir: null,
		leafId: null,
		agentEffort: undefined,
		tools: [],
		toolNames: [],
		builtInTools: [],
		pendingToolResults: [],
		runToolCallIds: [],
		systemPrompt: [],
		skills: [],
		rules: null,
		hasAbortedToolCallTail: false,
		isAutoThinking: false,
		isCompacting: false,
		compactionSpeculation: "idle",
		contextUsageRevision: 0,
		contextUsage: undefined,
		isGeneratingHandoff: false,
		isRetrying: false,
		retryAttempt: 0,
		isTtsrAbortPending: false,
		hasInterruptibleInput: false,
		autoResolvedThinkingLevel: undefined,
		configuredThinkingLevel: undefined,
		availableEffortSelectors: [],
		serviceTierByFamily: {},
		fastModeActive: false,
		anthropicSlowModeLabel: undefined,
		prewalk: undefined,
		goalMode: undefined,
		advisorCost: 0,
		advisorUsingSubscription: false,
		todoPhases: [],
		queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
		restorableQueue: { steering: [], followUp: [] },
		approvals: { scopes: [], grants: [] },
		ephemeralMaxTokensPreservesRequest: false,
		settings: { base: null, layers: [] },
		activeToolExecutionUpdates: [],
	};
}

/** Options for {@link RemoteAgentSession}. */
export interface RemoteAgentSessionInit {
	readonly key: string;
	readonly home: ThreadId;
	readonly agentId: string | undefined;
	readonly host: SessionHostClient | undefined;
	readonly state: SessionMirrorState;
	readonly messages: AgentMessage[];
	/** Main registry the worker session's registry mirrors. */
	readonly modelRegistry?: ModelRegistry | null;
	/** Main job manager the worker session registers its async jobs with. */
	readonly asyncJobManager?: AsyncJobManagerApi | null;
}

/** Content-addressed blob store shared by every session of this process (the worker writes to the same directory). */
let sharedBlobs: BlobStore | undefined;
function blobs(): BlobStore {
	sharedBlobs ??= new BlobStore(getBlobsDir());
	return sharedBlobs;
}

/** `list` without the item at `index` (unchanged when out of range). */
function withoutIndex<T>(list: readonly T[], index: number): T[] {
	return index < 0 || index >= list.length ? [...list] : [...list.slice(0, index), ...list.slice(index + 1)];
}

/** {@link AgentViewSession} for a session homed on a subagent worker; see the module doc. */
export class RemoteAgentSession implements AgentViewSession {
	readonly instanceKey: string;
	/** Worker the session lives on. */
	readonly home: ThreadId;
	/** Registry id the session reported when it opened. */
	readonly agentId: string | undefined;
	readonly agent: AgentViewLoop;
	readonly state: AgentViewState;
	readonly sessionManager: AgentViewSessionManager;
	readonly tokenRate: TokenRateMeter;
	readonly #host: SessionHostClient | undefined;
	readonly #modelRegistry: ModelRegistry | undefined;
	readonly #asyncJobs: AsyncJobManagerApi | undefined;
	#state: SessionMirrorState;
	#pendingToolCalls: Set<string>;
	readonly #messages: AgentMessage[];
	#view: SessionViewState = emptyViewState();
	/**
	 * Queued entries that can no longer be restored (the home claimed them for
	 * delivery, dropped them, or retired them) while the mirror, until a queue
	 * the home published after that arrives, still lists them as restorable.
	 */
	readonly #settledQueued = new Set<string>();
	/** Queued entries restored here that the home has not retired yet; its gate drops them. */
	readonly #withdrawnQueued = new Set<string>();
	#toolNames = new Set<string>();
	#builtInTools = new Set<string>();
	#runToolCallIds = new Set<string>();
	readonly #activeUpdates = new Map<string, ToolExecutionUpdateEvent>();
	#entries: SessionEntry[] = [];
	readonly #entryIndex = new SessionEntryIndex();
	/** Custom entries appended here and not yet echoed back by the home worker. */
	readonly #provisional = new Set<SessionEntry>();
	#provisionalSeq = 0;
	#settings: Settings | undefined;
	#tokenizer: { model: Model | undefined; tokenizer: Tokenizer } | undefined;
	readonly #ruleSource: AgentViewRuleSource;
	readonly #listeners = new Set<AgentSessionEventListener>();
	readonly #runStateListeners = new Set<(state: SessionRunState) => void>();
	#closed: string | undefined;

	constructor(init: RemoteAgentSessionInit) {
		this.instanceKey = init.key;
		this.home = init.home;
		this.agentId = init.agentId;
		this.#host = init.host;
		this.#modelRegistry = init.modelRegistry ?? undefined;
		this.#asyncJobs = init.asyncJobManager ?? undefined;
		this.#state = init.state;
		this.#pendingToolCalls = new Set(init.state.pendingToolCalls);
		this.#messages = init.messages;
		if (!init.host) this.#closed = "never opened on its worker";
		this.tokenRate = new TokenRateMeter(text => this.#countTokens(text));
		this.#reseedTokenRate();
		const mirror = this;
		const loopState = {
			get messages(): AgentMessage[] {
				return mirror.#messages;
			},
			get streamMessage(): AgentMessage | null {
				return mirror.#state.streamMessage;
			},
			get pendingToolCalls(): Set<string> {
				return mirror.#pendingToolCalls;
			},
			get tools() {
				return mirror.#view.tools;
			},
		};
		this.agent = {
			get isPaused(): boolean {
				return mirror.#state.isPaused;
			},
			state: loopState,
			getPendingToolResults: (): readonly ToolResultMessage[] => this.#view.pendingToolResults,
		};
		this.state = {
			get model(): Model | undefined {
				return mirror.#state.model;
			},
			get thinkingLevel(): Effort | undefined {
				return mirror.#view.agentEffort;
			},
			get messages(): AgentMessage[] {
				return mirror.#messages;
			},
		};
		this.#ruleSource = { getRules: () => this.#view.rules ?? [] };
		this.sessionManager = {
			getCwd: () => this.#state.cwd,
			getSessionId: () => this.#state.sessionId,
			getSessionFile: () => this.#state.sessionFile,
			getArtifactsDir: () => this.#state.artifactsDir,
			getUsageStatistics: () => this.#state.usageStatistics,
			getSessionName: () => this.#view.sessionName,
			getEntries: () => [...this.#entries],
			getBranch: fromId => this.#entryIndex.pathTo(fromId),
			getLeafId: () => this.#entryIndex.leafId(),
			getConversationTip: () => conversationTip(this.#entries, this.#entryIndex.branchView()),
			getSeanceSourceArtifactsDir: () => this.#view.seanceSourceArtifactsDir,
			appendCustomEntry: (customType, data) => this.#appendCustomEntry(customType, data),
			flush: () => this.#command("flushSession"),
			ensureOnDisk: () => this.#command("ensureOnDisk"),
			appendModelUsage: (usage, owner) => this.#notify("appendModelUsage", toWireData(usage), owner),
			putBlob: (data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> => blobs().put(data, options),
			putBlobSync: (data: Buffer, options?: BlobPutOptions): BlobPutResult => blobs().putSync(data, options),
			getArtifactPath: id => this.#command("getArtifactPath", id),
			getArtifactContent: id => this.#command("getArtifactContent", id),
		};
	}

	/** A closed mirror for a key whose home no longer has (or never published) the session. */
	static gone(key: string, home: ThreadId, reason: string): RemoteAgentSession {
		const session = new RemoteAgentSession({
			key,
			home,
			agentId: undefined,
			host: undefined,
			state: emptyMirrorState(),
			messages: [],
		});
		session.#closed = reason;
		return session;
	}

	/** Whether the home worker closed the session (dispose) or died. */
	get closed(): boolean {
		return this.#closed !== undefined;
	}

	get isStreaming(): boolean {
		return this.#state.isStreaming;
	}

	get runStartedAt(): number | undefined {
		return this.#state.runStartedAt;
	}

	get ircWakesPending(): boolean {
		return this.#state.ircWakesPending;
	}

	get messages(): AgentMessage[] {
		return this.#messages;
	}

	get sessionFile(): string | undefined {
		return this.#state.sessionFile;
	}

	get model(): Model | undefined {
		return this.#state.model;
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#state.thinkingLevel;
	}

	get servingModel(): ServingModel | undefined {
		return this.#state.servingModel;
	}

	get effectiveExtensionRoots(): EffectiveExtensionRoots {
		return this.#state.effectiveExtensionRoots;
	}

	get hindsightActive(): boolean {
		return this.#state.hindsightActive;
	}

	/** Main-side equivalent of the child's settings: the mirrored main instance under the child's own overlay layers. */
	get settings(): Settings {
		if (this.#settings) return this.#settings;
		const source = this.#view.settings;
		let settings = source.base ?? Settings.isolated();
		for (const layers of source.layers) settings = settings.restoreOverlay(layers);
		this.#settings = settings;
		return settings;
	}

	/** The main registry the worker session's registry mirrors. */
	get modelRegistry(): ModelRegistry {
		if (this.#modelRegistry) return this.#modelRegistry;
		throw new Error(
			`Agent session ${this.agentId ?? this.instanceKey} on worker ${this.home} uses a worker-local model registry; ` +
				"worker-homed sessions must be built over a main registry to be viewed",
		);
	}

	/** Extension runner of the nearest main-thread ancestor session, which loaded the extensions the worker re-imported. */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#mainAncestor()?.extensionRunner;
	}

	get sessionId(): string {
		return this.#view.providerSessionId || this.#state.sessionId;
	}

	get ttsrManager(): AgentViewRuleSource | undefined {
		return this.#view.rules ? this.#ruleSource : undefined;
	}

	get hasAbortedToolCallTail(): boolean {
		return this.#view.hasAbortedToolCallTail;
	}

	get systemPrompt(): string[] {
		return this.#view.systemPrompt;
	}

	get skills(): readonly Skill[] {
		return this.#view.skills;
	}

	get isAutoThinking(): boolean {
		return this.#view.isAutoThinking;
	}

	get isCompacting(): boolean {
		return this.#view.isCompacting;
	}

	get compactionSpeculation(): "idle" | "running" | "armed" {
		return this.#view.compactionSpeculation;
	}

	get contextUsageRevision(): number {
		return this.#view.contextUsageRevision;
	}

	get isGeneratingHandoff(): boolean {
		return this.#view.isGeneratingHandoff;
	}

	get isRetrying(): boolean {
		return this.#view.isRetrying;
	}

	get retryAttempt(): number {
		return this.#view.retryAttempt;
	}

	get isTtsrAbortPending(): boolean {
		return this.#view.isTtsrAbortPending;
	}

	get hasInterruptibleInput(): boolean {
		return this.#view.hasInterruptibleInput;
	}

	getSessionStats(): SessionStats {
		return this.#state.sessionStats;
	}

	getAdvisorStatusOverview(): AgentSessionAdvisorOverview {
		return this.#state.advisorOverview;
	}

	getSessionAgents(): AgentDefinition[] {
		return this.#state.sessionAgents;
	}

	hasQueuedIrcFrom(from: string): boolean {
		return this.#state.ircQueuedFrom.includes(from);
	}

	/**
	 * Only ever called on the caller's own session, which is homed on the
	 * caller's thread; draining another thread's queue from a mirror would
	 * consume records its owner is about to inject.
	 */
	drainPendingIrcInboxMessages(_agentId: string, _opts?: { ifAny?: (msg: IrcMessage) => boolean }): IrcMessage[] {
		throw new Error(
			`drainPendingIrcInboxMessages must run on the session's home thread (${this.home}), not on a mirror`,
		);
	}

	emitIrcRelayObservation(record: CustomMessage): void {
		this.#notify("emitIrcRelayObservation", record);
	}

	activeToolExecutionUpdates(): readonly ToolExecutionUpdateEvent[] {
		return [...this.#activeUpdates.values()];
	}

	settleInFlightMessagePersistence(): Promise<void> {
		if (this.#closed !== undefined) return Promise.resolve();
		return this.#command("settleInFlightMessagePersistence");
	}

	/** Display transcript built on main from the mirrored entries (already in display form) and leaf. */
	buildTranscriptSessionContext(options?: TranscriptSessionContextOptions): SessionContext {
		const keepLive = options?.keepInFlightToolCalls === true && this.#state.isStreaming;
		return buildSessionContext(this.#entries, this.#entryIndex.leafId(), this.#entryIndex.entriesById(), {
			transcript: true,
			collapseCompactedHistory: options?.collapseCompactedHistory,
			inFlightToolCallIds: keepLive ? this.#runToolCallIds : undefined,
			resolveFrameData: data => lazyImageDataSync(blobs(), data),
		});
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const usage = this.#view.contextUsage;
		if (!usage || options?.contextWindow === undefined) return usage;
		const contextWindow =
			Number.isFinite(options.contextWindow) && options.contextWindow > 0 ? options.contextWindow : 0;
		return { ...usage, contextWindow, percent: contextWindow > 0 ? (usage.tokens / contextWindow) * 100 : 0 };
	}

	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#view.autoResolvedThinkingLevel;
	}

	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#view.configuredThinkingLevel;
	}

	getAvailableEffortSelectors(): ConfiguredThinkingLevel[] {
		return this.#view.availableEffortSelectors;
	}

	/** Applied to the mirror at once; the home worker applies it (with clamping) and its next patch reconciles. */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist?: boolean): void {
		this.#view = { ...this.#view, configuredThinkingLevel: level, isAutoThinking: level === AUTO_THINKING };
		if (level !== AUTO_THINKING) this.#state = { ...this.#state, thinkingLevel: level };
		this.#notify("setThinkingLevel", level, persist);
	}

	/** Next selector in the mirrored cycle order (off → auto → minimal..max → off), applied like {@link setThinkingLevel}. */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		const levels = this.#view.availableEffortSelectors;
		if (levels.length === 0) return undefined;
		const configured = this.#view.configuredThinkingLevel;
		const current = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const index = current ? levels.indexOf(current) : -1;
		const next = levels[(index + 1) % levels.length];
		if (!next) return undefined;
		this.setThinkingLevel(next);
		return next;
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		return roleThinkingLevelForModel(this.settings, this.modelRegistry.getAvailable(), model);
	}

	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		return this.#command("setModelTemporary", toWireData(model), thinkingLevel, options);
	}

	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		return resolveRoleModelCycle(
			this.settings,
			this.modelRegistry.getAvailable(),
			this.#state.model,
			lastModelChangeRole(this.#entryIndex.branchView()),
			roleOrder,
		);
	}

	cycleRoleModels(
		roleOrder: readonly string[],
		direction?: "forward" | "backward",
	): Promise<RoleModelCycleResult | undefined> {
		return this.#command("cycleRoleModels", roleOrder, direction);
	}

	applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		return this.#command("applyRoleModel", toWireData(entry));
	}

	effectiveServiceTier(model: Model): ServiceTier | undefined {
		return serviceTierForModel(this.settings, model, this.#view.serviceTierByFamily);
	}

	isFastModeActive(): boolean {
		return this.#view.fastModeActive;
	}

	getAnthropicSlowModeLabel(): string | undefined {
		return this.#view.anthropicSlowModeLabel;
	}

	getPrewalkState(): Prewalk | undefined {
		return this.#view.prewalk;
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#view.goalMode;
	}

	getAdvisorCost(): number {
		return this.#view.advisorCost;
	}

	isAdvisorUsingSubscription(): boolean {
		return this.#view.advisorUsingSubscription;
	}

	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#command("fetchUsageReports", signal);
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		return this.#asyncJobs ? asyncJobSnapshot(this.#asyncJobs, this.agentId, options) : null;
	}

	getAsyncJobTree(options?: { recentLimit?: number }): AsyncJobTree | null {
		return this.#asyncJobs ? asyncJobTree(this.#asyncJobs, this.agentId, options) : null;
	}

	getRunningJobWidgets(): JobWidgetEntry[] {
		return this.#asyncJobs ? runningJobWidgets(this.#asyncJobs, this.agentId) : [];
	}

	inspectAsyncJob(id: string): AsyncJobInspection | undefined {
		return this.#asyncJobs ? inspectAsyncJob(this.#asyncJobs, this.agentId, id) : undefined;
	}

	cancelAsyncJob(id: string): boolean {
		return this.#asyncJobs !== undefined && cancelOwnedAsyncJob(this.#asyncJobs, this.agentId, id);
	}

	requestJobCaptions(): void {
		if (this.#asyncJobs) requestJobTreeCaptions(this.#asyncJobs, this.agentId);
	}

	getTodoPhases(): TodoPhase[] {
		return this.#view.todoPhases;
	}

	/** Applied to the mirror at once and sent to the home worker. */
	setTodoPhases(phases: TodoPhase[]): void {
		this.#view = { ...this.#view, todoPhases: phases };
		this.#notify("setTodoPhases", toWireData(phases));
	}

	/** Same two steps as a home session: the optimistic entry and the mirror update reach the worker in order. */
	commitTodoPhases(phases: TodoPhase[]): void {
		this.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		this.setTodoPhases(phases);
	}

	/**
	 * Main-thread renderer source for the child's tool `name`: the nearest
	 * main-thread ancestor's tool of that name (worker tool copies drop their
	 * render hooks), and only while the child itself registers the name.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolNames.has(name) ? this.#mainAncestor()?.getToolByName(name) : undefined;
	}

	hasBuiltInTool(name: string): boolean {
		return this.#builtInTools.has(name);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[]; liveSteered: number } {
		return this.#view.queuedMessages;
	}

	/**
	 * Restore the newest user-authored queued message (steering first) the home
	 * has not claimed for delivery, drop it from the mirror, and have the home
	 * take it out of its queue. Main decides: the home's gate asks main before
	 * delivering any restorable entry, so a message restored here is never
	 * delivered too.
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const queue = this.#view.restorableQueue;
		const chips = this.#view.queuedMessages;
		const steering = this.#lastRestorable(queue.steering);
		const followUp = steering < 0 ? this.#lastRestorable(queue.followUp) : -1;
		let popped: SessionQueuedEntry;
		if (steering >= 0) {
			popped = queue.steering[steering];
			// Chips list live-steered messages ahead of the queue: restorable entries align with their tail.
			const chip = chips.steering.length - (queue.steering.length - steering);
			this.#view = {
				...this.#view,
				restorableQueue: { steering: withoutIndex(queue.steering, steering), followUp: queue.followUp },
				queuedMessages: { ...chips, steering: withoutIndex(chips.steering, chip) },
			};
		} else if (followUp >= 0) {
			popped = queue.followUp[followUp];
			const chip = chips.followUp.length - (queue.followUp.length - followUp);
			this.#view = {
				...this.#view,
				restorableQueue: { steering: queue.steering, followUp: withoutIndex(queue.followUp, followUp) },
				queuedMessages: { ...chips, followUp: withoutIndex(chips.followUp, chip) },
			};
		} else {
			return undefined;
		}
		this.#withdraw(popped.id);
		return popped.message;
	}

	/**
	 * Bridge only, synchronous: the home's gate is about to deliver queued
	 * entries `ids`. Returns those already restored here, which the home drops;
	 * either way none of them is restorable any more.
	 */
	claimQueued(ids: readonly string[]): string[] {
		const restored: string[] = [];
		for (const id of ids) {
			if (this.#withdrawnQueued.has(id)) restored.push(id);
			this.#settle(id);
		}
		return restored;
	}

	hasSessionApproval(key: string): boolean {
		return this.#view.approvals.scopes.includes(key);
	}

	/** The child's conversation tier, as mirrored, over the database of its agent directory. */
	getApprovalGrants(): ApprovalGrantStore {
		const grants = getApprovalGrants(this.settings.getAgentDir());
		for (const key of this.#view.approvals.grants) grants.session.record(key);
		return grants;
	}

	resume(options?: { onAccepted?: () => void }): Promise<void> {
		return this.#command("resume", options);
	}

	retry(): Promise<boolean> {
		return this.#command("retry");
	}

	abortRetry(): void {
		this.#notify("abortRetry");
	}

	abortCompaction(reason?: unknown): void {
		this.#notify("abortCompaction", toWireData(reason));
	}

	abortHandoff(): void {
		this.#notify("abortHandoff");
	}

	runEphemeralTurn(args: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
		return this.#command("runEphemeralTurn", args);
	}

	ephemeralMaxTokensPreservesRequest(): boolean {
		return this.#view.ephemeralMaxTokensPreservesRequest;
	}

	exportToHtml(outputPath?: string, useUserThemes?: boolean): Promise<string> {
		return this.#command("exportToHtml", outputPath, useUserThemes);
	}

	/** Idle maintenance runs on the home worker; its blocking predicates are answered synchronously from main. */
	enableIdleMaintenance(options: IdleMaintenanceOptions = {}): void {
		const { isBlocked, scheduledTurn, onRecap } = options;
		this.#notify("enableIdleMaintenance", {
			isBlocked: isBlocked && rpcSync(() => isBlocked()),
			scheduledTurn: scheduledTurn && rpcSync(() => scheduledTurn()),
			onRecap,
		});
	}

	refreshIdleMaintenance(): void {
		this.#notify("refreshIdleMaintenance");
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		const first = this.#listeners.size === 0;
		this.#listeners.add(listener);
		if (first) this.#watch(true);
		return () => {
			if (!this.#listeners.delete(listener)) return;
			if (this.#listeners.size === 0) this.#watch(false);
		};
	}

	subscribeRunState(listener: (state: SessionRunState) => void): () => void {
		this.#runStateListeners.add(listener);
		return () => {
			this.#runStateListeners.delete(listener);
		};
	}

	deliverIrcMessage(msg: IrcMessage): Promise<"injected" | "woken"> {
		return this.#command("deliverIrcMessage", msg);
	}

	waitForIrcReplies(): Promise<void> {
		if (this.#closed !== undefined) return Promise.resolve();
		return this.#command("waitForIrcReplies");
	}

	prompt(text: string, options?: PromptOptions): Promise<boolean> {
		return this.#command("prompt", text, options);
	}

	steer(text: string, images?: ImageContent[], options?: SteerOptions): Promise<void> {
		return this.#command("steer", text, images, options);
	}

	abort(options?: SessionAbortOptions): Promise<void> {
		if (this.#closed !== undefined) return Promise.resolve();
		return this.#command("abort", options);
	}

	setWorkPoolYieldItems(items: readonly WorkPoolYieldItem[]): Promise<void> {
		return this.#command("setWorkPoolYieldItems", items);
	}

	/** Dispose on the home worker; a session that is already gone counts as disposed. */
	async dispose(options?: AgentSessionDisposeOptions): Promise<void> {
		if (this.#closed !== undefined) return;
		try {
			await this.#command("dispose", options);
		} catch (error) {
			if (!(error instanceof RpcClosedError)) throw error;
		}
	}

	/** Bridge only: merge a state patch from the publisher. */
	applyPatch(patch: Partial<SessionMirrorState>): void {
		if (this.#closed !== undefined) return;
		this.#state = { ...this.#state, ...patch };
		if (patch.pendingToolCalls) this.#pendingToolCalls = new Set(patch.pendingToolCalls);
	}

	/** Bridge only: apply a message-list change in place (the array identity is stable). */
	applyMessages(delta: SessionMessagesDelta): void {
		if (this.#closed !== undefined) return;
		if (delta.kind === "replace") this.#messages.length = 0;
		for (const message of delta.messages) this.#messages.push(message);
	}

	/**
	 * Bridge only: a watch started; replace the view state with the publisher's
	 * snapshot and catch the entry list (kept across watches) up with `entries`.
	 */
	applyView(state: SessionViewState, entries: SessionEntriesDelta | undefined): void {
		if (this.#closed !== undefined) return;
		this.#view = state;
		this.#pruneSettled(state.restorableQueue);
		this.#activeUpdates.clear();
		for (const update of state.activeToolExecutionUpdates) this.#activeUpdates.set(update.toolCallId, update);
		if (entries) this.applyEntries(entries);
		this.#entryIndex.setLeaf(state.leafId);
		this.#syncViewDerived(state);
		this.#reseedTokenRate();
	}

	/** Bridge only: merge a view-state patch from the publisher. */
	applyViewPatch(patch: Partial<SessionViewState>): void {
		if (this.#closed !== undefined) return;
		this.#view = { ...this.#view, ...patch };
		if (patch.restorableQueue) this.#pruneSettled(patch.restorableQueue);
		if (patch.leafId !== undefined) this.#entryIndex.setLeaf(patch.leafId);
		this.#syncViewDerived(patch);
	}

	/** Bridge only: apply an entry-list change; locally appended entries give way to the worker's. */
	applyEntries(delta: SessionEntriesDelta): void {
		if (this.#closed !== undefined) return;
		if (delta.kind === "append" && this.#provisional.size === 0) {
			for (const entry of delta.entries) {
				this.#entries.push(entry);
				this.#entryIndex.insert(entry);
			}
			return;
		}
		const kept = delta.kind === "replace" ? [] : this.#entries.filter(entry => !this.#provisional.has(entry));
		this.#provisional.clear();
		this.#entries = [...kept, ...delta.entries];
		this.#entryIndex.rebuild(this.#entries);
		this.#entryIndex.setLeaf(this.#view.leafId);
	}

	/** Bridge only: dispatch one forwarded event to subscribers. */
	applyEvent(event: AgentSessionEvent): void {
		if (this.#closed !== undefined) return;
		this.#trackEvent(event);
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("RemoteAgentSession listener threw", {
					key: this.instanceKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** Bridge only: report a run-state transition to run-state subscribers. */
	applyRunState(state: SessionRunState): void {
		if (this.#closed !== undefined) return;
		for (const listener of [...this.#runStateListeners]) {
			try {
				listener(state);
			} catch (error) {
				logger.warn("RemoteAgentSession run-state listener threw", {
					key: this.instanceKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Bridge only: the home closed the session or died. The mirror keeps its
	 * last data, reports idle to run-state subscribers that saw it running,
	 * and drops every listener.
	 */
	close(reason: string): void {
		if (this.#closed !== undefined) return;
		const wasRunning = this.#state.runStartedAt !== undefined;
		this.#state = { ...this.#state, isStreaming: false, runStartedAt: undefined, streamMessage: null };
		if (wasRunning) this.applyRunState("idle");
		this.#closed = reason;
		this.#settledQueued.clear();
		this.#withdrawnQueued.clear();
		this.#listeners.clear();
		this.#runStateListeners.clear();
	}

	/** Keep the event-derived mirror (stream message, running tool updates, tok/s meter) current. */
	#trackEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role !== "assistant") return;
				this.#state = { ...this.#state, streamMessage: event.message };
				this.tokenRate.begin(event.message.timestamp);
				return;
			case "message_update": {
				if (event.message.role !== "assistant") return;
				this.#state = { ...this.#state, streamMessage: event.message };
				const delta = event.assistantMessageEvent;
				if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
					this.tokenRate.push(delta.delta);
				}
				return;
			}
			case "message_end":
				this.#state = { ...this.#state, streamMessage: null };
				if (event.message.role === "assistant") {
					const message = event.message;
					this.tokenRate.end(
						message.usage.output,
						message.duration !== undefined ? message.timestamp + message.duration : undefined,
					);
				}
				return;
			case "tool_execution_update":
				this.#activeUpdates.set(event.toolCallId, event);
				return;
			case "tool_execution_end":
				this.#activeUpdates.delete(event.toolCallId);
				return;
		}
	}

	/** Refresh lookups derived from view fields present in `changed`. */
	#syncViewDerived(changed: Partial<SessionViewState>): void {
		if (changed.toolNames) this.#toolNames = new Set(changed.toolNames);
		if (changed.builtInTools) this.#builtInTools = new Set(changed.builtInTools);
		if (changed.runToolCallIds) this.#runToolCallIds = new Set(changed.runToolCallIds);
		if (changed.settings) this.#settings = undefined;
	}

	/** Seed the tok/s meter from the newest completed assistant turn (attach, watch restart). */
	#reseedTokenRate(): void {
		for (let i = this.#messages.length - 1; i >= 0; i--) {
			const message = this.#messages[i];
			if (message?.role !== "assistant" || message.duration === undefined) continue;
			this.tokenRate.seed(message.usage.output, message.duration);
			return;
		}
		this.tokenRate.reset();
	}

	#countTokens(text: string): number {
		const model = this.#state.model;
		let cached = this.#tokenizer;
		if (!cached || cached.model !== model) {
			cached = { model, tokenizer: new Tokenizer(model) };
			this.#tokenizer = cached;
		}
		return cached.tokenizer.countTokens(text);
	}

	/** Optimistic local entry, replaced by the worker's own once its entries delta arrives. */
	#appendCustomEntry(customType: string, data: unknown): void {
		const wireData = toWireData(data);
		this.#notify("appendCustomEntry", customType, wireData);
		if (this.#closed !== undefined) return;
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data: wireData,
			id: `pending:${++this.#provisionalSeq}`,
			parentId: this.#entryIndex.leafId(),
			timestamp: new Date().toISOString(),
		};
		this.#provisional.add(entry);
		this.#entries.push(entry);
		this.#entryIndex.insert(entry);
	}

	/** Nearest main-thread session up the registry's parent chain, else the main agent's. */
	#mainAncestor(): AgentSession | undefined {
		const registry = AgentRegistry.global();
		const seen = new Set<string>();
		let id = this.agentId === undefined ? undefined : registry.get(this.agentId)?.parentId;
		while (id !== undefined && !seen.has(id)) {
			seen.add(id);
			const ref = registry.get(id);
			const session = ref?.session;
			if (session && isLocalAgentSession(session)) return session;
			id = ref?.parentId;
		}
		const main = registry.get(MAIN_AGENT_ID)?.session;
		return main && isLocalAgentSession(main) ? main : undefined;
	}

	#goneError(): RpcClosedError {
		return new RpcClosedError(
			`Agent session ${this.agentId ?? this.instanceKey} on worker ${this.home} is gone: ${this.#closed ?? "worker link closed"}`,
		);
	}

	/** Index of the newest entry of `entries` neither claimed for delivery nor already restored; -1 when none. */
	#lastRestorable(entries: readonly SessionQueuedEntry[]): number {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!entry.claimed && !this.#settledQueued.has(entry.id) && !this.#withdrawnQueued.has(entry.id)) return i;
		}
		return -1;
	}

	/**
	 * Have the home retire restored entry `id`: take it out of its queue, or keep
	 * whatever holds it aside (a follow-up parked behind a wake turn) from putting
	 * it back. Until the home confirms, its gate drops the entry.
	 */
	#withdraw(id: string): void {
		if (this.#closed !== undefined || !this.#host) return;
		this.#withdrawnQueued.add(id);
		this.#host.remote.call("popQueuedMessage", id).then(
			() => this.#settle(id),
			(error: unknown) => {
				if (error instanceof RpcClosedError) return;
				logger.warn("RemoteAgentSession failed to withdraw a queued message", {
					key: this.instanceKey,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}

	/**
	 * The home settled entry `id` (claimed it for delivery, dropped it, or
	 * retired it): stop vetoing it, and keep it unrestorable while the mirror
	 * still lists it. Every queue the home publishes after this point lists it
	 * flagged or not at all, so the first one retires the mark.
	 */
	#settle(id: string): void {
		this.#withdrawnQueued.delete(id);
		const queue = this.#view.restorableQueue;
		const listed = (entry: SessionQueuedEntry) => entry.id === id && !entry.claimed;
		if (queue.steering.some(listed) || queue.followUp.some(listed)) this.#settledQueued.add(id);
	}

	/** A newly published queue lists settled entries flagged or not at all: their marks have served. */
	#pruneSettled(queue: SessionRestorableQueue): void {
		if (this.#settledQueued.size === 0) return;
		const restorable = new Set<string>();
		for (const entry of queue.steering) if (!entry.claimed) restorable.add(entry.id);
		for (const entry of queue.followUp) if (!entry.claimed) restorable.add(entry.id);
		for (const id of this.#settledQueued) if (!restorable.has(id)) this.#settledQueued.delete(id);
	}

	#watch(on: boolean): void {
		this.#notify("watch", on);
	}

	/** Fire-and-forget command to the home worker; dropped once the session is gone. */
	#notify<K extends keyof SessionHostProtocol & string>(method: K, ...args: SessionHostProtocol[K]["args"]): void {
		if (this.#closed !== undefined || !this.#host) return;
		this.#host.remote.notify(method, ...args);
	}

	async #command<K extends keyof SessionHostProtocol & string>(
		method: K,
		...args: SessionHostProtocol[K]["args"]
	): Promise<SessionHostProtocol[K]["result"]> {
		if (this.#closed !== undefined || !this.#host) throw this.#goneError();
		try {
			return await this.#host.remote.call(method, ...args);
		} catch (error) {
			if (error instanceof RpcClosedError) throw this.#goneError();
			throw error;
		}
	}
}
