import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	AppendOnlyContextManager,
	type CompactionSummaryMessage,
	resolveTelemetry,
	type StreamFn,
	ThinkingLevel,
	type Tokenizer,
} from "@oh-my-pi/pi-agent-core";
import {
	type CompactionResult,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	estimateTranscriptTokens,
	NativeCompactionError,
	prepareCompaction,
	type SessionMessageEntry,
	shouldCompact,
	shouldUseProviderNativeCompaction,
} from "@oh-my-pi/pi-agent-core/compaction";
import type {
	AssistantMessage,
	CodexCompactionContext,
	Context,
	Message,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { isUsageLimitOutcome, resolveModelServiceTier, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	AdviseTool,
	type AdvisorAgent,
	type AdvisorConfig,
	AdvisorEmissionGuard,
	AdvisorLoopGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorRuntimeStatus,
	type AdvisorSeverity,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	buildAdvisorQuarantineSourceText,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../advisor";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
} from "../config/model-resolver";
import { MODEL_ROLES } from "../config/model-roles";
import { serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import type { Settings } from "../config/settings";
import { CursorExecHandlers, type CursorMcpResourceAdapter } from "../cursor";
import { bridgeToolMap } from "../cursor-bridge-tools";
import { estimateToolSchemaTokens } from "../modes/utils/context-usage";
import type { PlanModeState } from "../plan-mode/state";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ClientBridge } from "./client-bridge";
import { resolveCompactionMethodOrder } from "./compaction-methods";
import type { CustomMessage, CustomMessagePayload } from "./messages";
import { isAdvisorCard, isTerminalTextAssistantAnswer } from "./queued-messages";
import {
	formatRetryFallbackSelector,
	getRetryFallbackRevertPolicy,
	parseRetryFallbackSelector,
	type RetryFallbackSelector,
} from "./retry-fallback-chains";
import { formatSessionDumpText } from "./session-dump-format";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import type { SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";
import type { YieldQueue } from "./yield-queue";

const ADVISOR_CODEX_SSE_MAX_ATTEMPTS = 1;
/** Advisor statistics for the advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
	/** Per-advisor breakdown for every configured advisor. */
	advisors: PerAdvisorStat[];
}

/** One advisor's status, token usage, cost, and message counts. */
export interface PerAdvisorStat {
	name: string;
	status: AdvisorRuntimeStatus;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
	sessionId?: string;
}

interface AdvisorRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel;
	lastAppliedThinkingLevel: ThinkingLevel;
}

interface ActiveAdvisor {
	name: string;
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;
	recorderClosed: Promise<void>;
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	providerSessionId: string | undefined;
	retryFallback?: AdvisorRetryFallbackState;
	retryFallbackPendingSuccess: boolean;
	signature: string;
}

interface AdvisorCompactionSummaryMessage extends CompactionSummaryMessage {
	firstKeptEntryId?: string;
	advisorUsageAnchorStartIndex?: number;
}

interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

/** Inputs that configure the advisor roster owned by a session. */
export interface SessionAdvisorsOptions {
	enabled: boolean;
	tools?: AgentTool[];
	/**
	 * Build a `grep` honoring a Cursor `pi_grep` frame's own context width and
	 * match cap. The advisor's tools are fixed instances carrying session
	 * defaults, so without this an advisor running against Cursor silently
	 * drops both fields — the same gap the primary bridge closes.
	 */
	createGrepTool?(options: { context?: number; totalMatchLimit?: number }): AgentTool | undefined;
	/**
	 * Build the `replace`-mode `edit` a Cursor `pi_edit` frame needs. The
	 * advisor's own instance follows the configured `edit.mode` (`hashline` by
	 * default), whose schema the frame's `old_string`/`new_string` args do not
	 * match, so without this every native advisor edit fails validation.
	 */
	createEditTool?(): AgentTool | undefined;
	/**
	 * The execute-time context the bridge's tools resolve approval from.
	 *
	 * `ExtensionToolWrapper` reads the approval mode, per-tool policies and
	 * `autoApprove` only from here; with none it falls back to `yolo` and empty
	 * policies, so a native frame would run past a configured `ask` or `deny`.
	 */
	getToolContext?: () => AgentToolContext | undefined;
	/**
	 * The live MCP connections Cursor's resource frames answer from.
	 *
	 * Advisors share the session's connections and may hold tools from those
	 * same servers, so without this their frames report that every server
	 * advertises nothing.
	 */
	mcpResources?: CursorMcpResourceAdapter;
	watchdogPrompt?: string;
	sharedInstructions?: string;
	contextPrompt?: string;
	configs?: AdvisorConfig[];
	streamFn?: StreamFn;
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
}

/** Options accepted when an advisor injects a primary-session message. */
export interface AdvisorMessageDeliveryOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
	queueChipText?: string;
	acceptTerminalEmptyStop?: boolean;
}

/** Session capabilities borrowed by the advisor controller. */
export interface SessionAdvisorsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	yieldQueue: YieldQueue;
	obfuscator: SecretObfuscator | undefined;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	isDisposed(): boolean;
	abortInProgress(): boolean;
	allowAgentInitiatedTurns(): boolean;
	planModeState(): PlanModeState | undefined;
	clientBridge(): ClientBridge | undefined;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(message: CustomMessagePayload, options?: AdvisorMessageDeliveryOptions): Promise<boolean>;
	extractQueuedAdvisorCards(): CustomMessage[];
	dropPendingAdvisorCards(): void;
	preserveAdvisorCard(card: CustomMessage): void;
	hasPendingNextTurnMessages(): boolean;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	resolveContextPromotionTarget(
		currentModel: Model,
		contextWindow: number,
		signal: AbortSignal,
	): Promise<Model | undefined>;
	resolveCompactionModelCandidates(preferredModel: Model | null | undefined, availableModels: Model[]): Model[];
	resolveRetryFallbackRole(
		currentSelector: string,
		currentModel?: Model | null,
		roleHint?: string,
	): string | undefined;
	retryFallbackChainKeys(
		currentSelector: string,
		currentModel?: Model | null,
		options?: { pinnedRole?: string; roleHint?: string },
	): string[];
	findRetryFallbackCandidates(
		role: string,
		currentSelector: string,
		currentModel?: Model | null,
	): RetryFallbackSelector[];
	isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean;
	noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void;
	createCodexCompactionContext(options: {
		trigger: CodexCompactionContext["trigger"];
		reason: CodexCompactionContext["reason"];
		phase: CodexCompactionContext["phase"];
	}): CodexCompactionContext;
	sessionId(): string;
}

/**
 * One advisor's status-line slice: runtime status plus whether it has
 * finished reviewing the current yield — i.e. it is not going to add any
 * more comments until a new primary turn starts (or an explicit reset).
 */
export interface AdvisorStatusOverviewEntry {
	name: string;
	status: AdvisorRuntimeStatus;
	yielded: boolean;
}

/** Owns advisor runtimes, delivery policy, context maintenance, and status reporting. */
export class SessionAdvisors {
	readonly #host: SessionAdvisorsHost;
	#advisorEnabled: boolean;
	#advisorTools: AgentTool[] | undefined;
	#advisorCreateGrepTool: SessionAdvisorsOptions["createGrepTool"];
	#advisorCreateEditTool: SessionAdvisorsOptions["createEditTool"];
	#advisorGetToolContext: SessionAdvisorsOptions["getToolContext"];
	#advisorMcpResources: SessionAdvisorsOptions["mcpResources"];
	#advisorWatchdogPrompt: string | undefined;
	#advisorSharedInstructions: string | undefined;
	#advisorContextPrompt: string | undefined;
	#advisorStreamFn: StreamFn | undefined;
	#transformProviderContext: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
	#advisors: ActiveAdvisor[] = [];
	#advisorConfigs: AdvisorConfig[] | undefined;
	#advisorStatuses = new Map<string, { name: string; status: AdvisorRuntimeStatus }>();
	#advisorProviderSessionIds = new Map<string, string>();
	#advisorCosts = new Map<string, number>();
	/**
	 * Slugs whose recorded spend ran on an OAuth/subscription model. Kept in
	 * lockstep with {@link #advisorCosts} so {@link isUsingSubscription} can
	 * attribute historical advisor spend without rescanning the model catalog
	 * once the advisor runtime is gone (#10131).
	 */
	#advisorSubscriptionSlugs = new Set<string>();
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	/** Holds recorder writes behind the active resume-cost byte snapshot. */
	#advisorCostSnapshotBarrier: Promise<void> | undefined;
	#advisorAutoResumeSuppressed = false;
	#preserveAdvisorAdvice = false;
	#preserveTerminalYieldAdvice = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#pendingAdvisorCardEvents = new Set<Promise<void>>();
	#advisorYieldQueueUnsubscribe: (() => void) | undefined;

	constructor(host: SessionAdvisorsHost, options: SessionAdvisorsOptions) {
		this.#host = host;
		this.#advisorEnabled = options.enabled;
		this.#advisorTools = options.tools;
		this.#advisorCreateGrepTool = options.createGrepTool;
		this.#advisorCreateEditTool = options.createEditTool;
		this.#advisorGetToolContext = options.getToolContext;
		this.#advisorMcpResources = options.mcpResources;
		this.#advisorWatchdogPrompt = options.watchdogPrompt;
		this.#advisorSharedInstructions = options.sharedInstructions;
		this.#advisorContextPrompt = options.contextPrompt;
		this.#advisorConfigs = options.configs;
		this.#advisorStreamFn = options.streamFn;
		this.#transformProviderContext = options.transformProviderContext;
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();
	}

	/** Delivers one completed primary turn to every live advisor. */
	async onPrimaryTurnEnd(
		messages: AgentMessage[],
		willContinue: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		this.#advisorPrimaryTurnsCompleted++;
		for (const advisor of this.#advisors) {
			if (advisor.runtime.disposed) continue;
			try {
				advisor.runtime.onTurnEnd(messages, { willContinue });
			} catch (error) {
				logger.warn("advisor onTurnEnd threw; delta dropped", { advisor: advisor.name, err: String(error) });
			}
		}
		const syncBacklog = this.#host.settings.get("advisor.syncBacklog");
		if (this.#advisors.length === 0 || syncBacklog === "off") return;
		const threshold = Number.parseInt(syncBacklog, 10);
		await Promise.all(this.#advisors.map(advisor => advisor.runtime.waitForCatchup(30_000, threshold, signal)));
	}

	/** Rebuilds live advisors when role assignments alter their resolved runtime inputs. */
	onModelRolesChanged(): void {
		if (!this.#advisorEnabled || this.#host.isDisposed()) return;
		if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
	}

	/**
	 * True when the enabled advisor roster still has an entry left at `no_model`.
	 *
	 * At construction the advisor role is resolved against whatever the model
	 * catalog holds at that instant. Discovery-backed providers (e.g. GitHub
	 * Copilot) may not have populated the registry yet, so a valid configured
	 * model can transiently fail to resolve and record `no_model`. See #9010.
	 */
	hasInactiveNoModelAdvisor(): boolean {
		if (!this.#advisorEnabled) return false;
		for (const entry of this.#advisorStatuses.values()) {
			if (entry.status === "no_model") return true;
		}
		return false;
	}

	/**
	 * Reactivate an enabled advisor stuck at `no_model` after the initial
	 * background model discovery settles, so a valid configured model that was
	 * merely late to the catalog starts without a manual `/advisor` toggle. The
	 * rebuild is quiet (no warnings) because a warning was already emitted at
	 * construction. Returns true when the rebuild brought an advisor online so the
	 * caller can refresh the status line. See #9010.
	 */
	retryAfterModelDiscovery(): boolean {
		if (this.#host.isDisposed() || !this.hasInactiveNoModelAdvisor()) return false;
		const before = this.#advisors.length;
		if (before > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true, false);
		return this.#advisors.length > before;
	}

	/** Starts configured advisor runtimes when they are eligible. */
	buildRuntime(seedToCurrent = false): boolean {
		return this.#buildAdvisorRuntime(seedToCurrent);
	}

	/** Stops every advisor runtime and starts recorder shutdown. */
	stopRuntime(): void {
		this.#stopAdvisorRuntime();
	}

	/**
	 * Pause advisor work while old-session recorder feeds remain attached, then
	 * detach only after any active prompt has settled.
	 */
	async drainAndDetachRecorders(): Promise<void> {
		await Promise.all(this.#advisors.map(advisor => advisor.runtime.pauseForSessionTransition()));
		await this.detachAndCloseRecorders();
	}

	/** Detaches and drains recorder feeds before transcript artifacts are removed. */
	async detachAndCloseRecorders(): Promise<void> {
		const closes: Promise<void>[] = [];
		for (const advisor of this.#advisors) {
			advisor.agentUnsubscribe?.();
			advisor.agentUnsubscribe = undefined;
			advisor.recorderClosed = advisor.recorder.close();
			closes.push(advisor.recorderClosed);
		}
		await Promise.all(closes);
	}

	/** Reattach recorder feeds and resume work after a rolled-back or preserving transition. */
	reattachRecorderFeeds(): void {
		for (const advisor of this.#advisors) {
			if (!advisor.agentUnsubscribe) this.#attachAdvisorRecorderFeed(advisor);
			advisor.runtime.resumeAfterSessionTransition();
		}
	}

	/** Re-primes advisor transcript views across a conversation boundary. */
	resetSessionState(options: { preserveCost?: boolean } = {}): void {
		this.#resetAdvisorSessionState(options.preserveCost === true);
	}

	/** Drop the recorded spend once a conversation boundary has committed. */
	clearCost(): void {
		this.#advisorCosts.clear();
		this.#advisorSubscriptionSlugs.clear();
	}

	/**
	 * Replace the ledger with the spend recorded for the session becoming active.
	 * `providersBySlug` (from {@link loadAdvisorTranscriptCosts}) re-derives the
	 * subscription attribution the torn-down runtime can no longer report.
	 */
	restoreCost(costs: ReadonlyMap<string, number>, providersBySlug?: ReadonlyMap<string, ReadonlySet<string>>): void {
		this.#advisorCosts = new Map(costs);
		this.#advisorSubscriptionSlugs = this.#deriveSubscriptionSlugs(costs, providersBySlug);
	}

	/**
	 * Slugs whose restored spend ran on a provider that currently authenticates
	 * via OAuth — the persisted-spend equivalent of the live {@link isUsingSubscription}
	 * check, so resumed sessions attribute subscription usage without a catalog scan.
	 */
	#deriveSubscriptionSlugs(
		costs: ReadonlyMap<string, number>,
		providersBySlug: ReadonlyMap<string, ReadonlySet<string>> | undefined,
	): Set<string> {
		const slugs = new Set<string>();
		if (!providersBySlug) return slugs;
		const auth = this.#host.modelRegistry.authStorage;
		for (const [slug, providers] of providersBySlug) {
			if ((costs.get(slug) ?? 0) <= 0) continue;
			for (const provider of providers) {
				if (auth.hasOAuth(provider)) {
					slugs.add(slug);
					break;
				}
			}
		}
		return slugs;
	}

	/** Capture the current per-advisor spend ledger. */
	costSnapshot(): ReadonlyMap<string, number> {
		return new Map(this.#advisorCosts);
	}
	/**
	 * Freeze active recorder writes after everything billed so far. The returned
	 * baseline and byte snapshot therefore describe the same turn boundary.
	 */
	beginCostRestoreSnapshot(): {
		costsAtSnapshot: ReadonlyMap<string, number>;
		ready: Promise<unknown>;
		release: () => void;
	} {
		const costsAtSnapshot = this.costSnapshot();
		const gate = Promise.withResolvers<void>();
		this.#advisorCostSnapshotBarrier = gate.promise;
		const ready = Promise.all(this.#advisors.map(advisor => advisor.recorder.blockWritesUntil(gate.promise)));
		let released = false;
		return {
			costsAtSnapshot,
			ready,
			release: () => {
				if (released) return;
				released = true;
				if (this.#advisorCostSnapshotBarrier === gate.promise) this.#advisorCostSnapshotBarrier = undefined;
				gate.resolve();
			},
		};
	}

	/**
	 * Restore spend persisted at `costsAtSnapshot`, then add only the process-local
	 * delta billed after that fixed transcript snapshot. This preserves turns
	 * completed while the background scan runs without double-counting entries
	 * the scan already includes.
	 */
	restoreInitialCost(
		costs: ReadonlyMap<string, number>,
		costsAtSnapshot: ReadonlyMap<string, number>,
		providersBySlug?: ReadonlyMap<string, ReadonlySet<string>>,
	): void {
		const restored = new Map(costs);
		const subscription = this.#deriveSubscriptionSlugs(costs, providersBySlug);
		for (const [slug, current] of this.#advisorCosts) {
			const accrued = current - (costsAtSnapshot.get(slug) ?? 0);
			if (accrued <= 0) continue;
			restored.set(slug, (restored.get(slug) ?? 0) + accrued);
			// The delta billed after the snapshot carries its own live attribution.
			if (this.#advisorSubscriptionSlugs.has(slug)) subscription.add(slug);
		}
		this.#advisorCosts = restored;
		this.#advisorSubscriptionSlugs = subscription;
	}

	/**
	 * Rebind every live advisor to the active primary conversation's provider
	 * identity (session id, prompt-cache key, credential + metadata resolvers,
	 * telemetry). Invoked on every provider-session change — including branch
	 * paths that skip conversation restore — so advisors never keep emitting the
	 * previous conversation's session id/metadata (issue #6625).
	 */
	refreshProviderIdentity(): void {
		for (const advisor of this.#advisors) this.#refreshAdvisorProviderIdentity(advisor);
	}

	/** Re-primes advisor transcript views after an in-conversation history rewrite. */
	resetAllRuntimes(reason?: string): void {
		this.#resetAllAdvisorRuntimes(reason);
	}

	/** Whether live runtimes still match the resolved advisor configuration. */
	runtimeMatchesCurrentConfig(): boolean {
		return this.#advisorRuntimeMatchesCurrentConfig();
	}

	/** Whether concern/blocker delivery is inside the post-interrupt immunity window. */
	isInterruptImmuneTurnActive(): boolean {
		return this.#isAdvisorInterruptImmuneTurnActive();
	}

	/** Latest aggregate recorder-close barrier. */
	recorderClosed(): Promise<void> {
		return this.#advisorRecorderClosed;
	}

	/** Whether a user interrupt currently suppresses advisor-driven auto-resume. */
	get autoResumeSuppressed(): boolean {
		return this.#advisorAutoResumeSuppressed;
	}

	set autoResumeSuppressed(value: boolean) {
		this.#advisorAutoResumeSuppressed = value;
	}

	/** Tracks persistence of a visible advisor card emitted outside the primary loop. */
	trackCardEvent(processing: Promise<void>): void {
		this.#pendingAdvisorCardEvents.add(processing);
		void processing.finally(() => this.#pendingAdvisorCardEvents.delete(processing)).catch(() => {});
	}

	/** Waits for all advisor-card persistence handlers currently in flight. */
	async waitForPendingCardEvents(): Promise<void> {
		await Promise.allSettled(this.#pendingAdvisorCardEvents);
	}

	// Advisor runtime lifecycle
	// -------------------------------------------------------------------------
	#advisorImmuneTurnLimit(): number {
		const immuneTurns = this.#host.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	/** Rebind one advisor to the active primary conversation's provider identity. */
	#refreshAdvisorProviderIdentity(advisor: ActiveAdvisor): void {
		const primaryProviderSessionId = this.#host.sessionId();
		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			primaryProviderSessionId,
			advisor.slug,
		);
		advisor.providerSessionId = providerSessionId;
		advisor.agent.sessionId = providerSessionId;
		advisor.agent.promptCacheKey = this.#host.agent.promptCacheKey ?? providerSessionId;
		advisor.agent.getApiKey = requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId);
		advisor.agent.setMetadataResolver(
			providerSessionId
				? provider => buildSessionMetadata(providerSessionId, provider, this.#host.modelRegistry.authStorage)
				: undefined,
		);

		const telemetry = advisor.agent.telemetry;
		if (telemetry?.agent) {
			advisor.agent.setTelemetry({
				...telemetry,
				agent: {
					...telemetry.agent,
					id: advisor.slug
						? `${primaryProviderSessionId}-advisor-${advisor.slug}`
						: `${primaryProviderSessionId}-advisor`,
				},
			});
		}
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#advisorPrimaryTurnsCompleted`, `#advisorInterruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	#resetAdvisorSessionState(preserveCost: boolean): void {
		if (!preserveCost) {
			this.#advisorCosts.clear();
			this.#advisorSubscriptionSlugs.clear();
		}
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset("conversation-boundary");
			a.adviseTool.resetDeliveredNotes();
			a.emissionGuard.reset();
			this.#attachAdvisorRecorderFeed(a);
		}
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.#host.yieldQueue.clear("advisor");
		this.#host.extractQueuedAdvisorCards();
		this.#host.dropPendingAdvisorCards();
	}

	#resolveAdvisorRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#advisorConfigs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#advisorConfigs!;
		const descriptors: AdvisorRuntimeDescriptor[] = [];
		const usedSlugs = new Set<string>();
		for (const config of roster) {
			let slug = legacy ? "" : slugifyAdvisorName(config.name);
			if (slug) {
				let candidate = slug;
				let n = 2;
				while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
				slug = candidate;
				usedSlugs.add(slug);
			}
			// Per-advisor toggle: skip disabled advisors but keep them in the
			// status map so they show `○` rather than disappearing.
			if (config.enabled === false) {
				this.#advisorStatuses.set(slug, { name: config.name, status: "paused" });
				continue;
			}

			// Resolve the advisor's model: an explicit `model` override wins; else the
			// `advisor` role chain. A model that fails to resolve skips just this advisor.
			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], this.#host.modelRegistry, this.#host.settings);
				model = resolved.model;
				thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
				if (!model) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						this.#host.emitNotice(
							"warning",
							`Advisor "${config.name}": no model matched "${config.model}"`,
							"advisor",
						);
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
				if (!sel) {
					this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
					if (emitWarnings) {
						logger.debug("advisor enabled but no model assigned to the 'advisor' role; advisor inactive", {
							advisor: config.name,
						});
					}
					continue;
				}
				model = sel.model;
				thinkingLevel = concreteThinkingLevel(sel.thinkingLevel);
			}
			// Clamp the effort against the resolved model. Historically we defaulted
			// to `ThinkingLevel.Medium` unconditionally, which threw at first stream
			// on reasoning models that expose no controllable effort surface
			// (e.g. `devin-agent`: Cascade routes by sibling model id, not a wire
			// param; `getSupportedEfforts` returns `[]`). `resolveThinkingLevelForModel`
			// preserves an explicit `off`, clamps a concrete effort into the model's
			// supported range, and returns `undefined` for reasoning models without
			// controllable efforts — for that case we forward `Inherit` so no effort
			// is sent and reasoning stays enabled (matching the `auto`-path fix for
			// Devin models via `clampAutoThinkingEffort`). See #4579.
			const requestedLevel = thinkingLevel ?? ThinkingLevel.Medium;
			const resolvedLevel = resolveThinkingLevelForModel(model, requestedLevel);
			const advisorThinkingLevel: ThinkingLevel = resolvedLevel ?? ThinkingLevel.Inherit;
			// Record the status entry now (in roster order) so the Map's insertion
			// order matches the configured roster even when earlier advisors were
			// skipped as paused/no_model. The build loop overwrites this to "running"
			// without changing insertion order.
			this.#advisorStatuses.set(slug, { name: config.name, status: "running" });
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				signature: this.#advisorRuntimeSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#advisorRuntimeSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join(
			"\u001f",
		);
	}

	#advisorRuntimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#buildAdvisorRuntime(seedToCurrent = false, emitWarnings = true): boolean {
		if (this.#host.isDisposed()) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#advisorEnabled) return false;

		// Rebuild the status map from scratch so removed/renamed advisors don't
		// leave stale entries. #resolveAdvisorRuntimeDescriptors populates every
		// entry (`paused`/`no_model`/`running`) in roster order; the build loop
		// below confirms `running` for successfully built advisors.
		this.#advisorStatuses.clear();
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(emitWarnings);

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.
		const advisorTierSetting = this.#host.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? this.#host.effectiveServiceTier(model)
				: resolveModelServiceTier(advisorTierMap, model);

		for (const descriptor of descriptors) {
			const {
				config,
				slug,
				model: advisorModel,
				name: advisorName,
				thinkingLevel: advisorThinkingLevel,
				signature,
			} = descriptor;

			const emissionGuard = new AdvisorEmissionGuard();
			const adviseTool = new AdviseTool(
				(note, severity) => this.#routeAdvice(advisorRef, note, severity),
				note => this.#acceptAdvice(advisorRef, note),
			);

			// `#advisorWatchdogPrompt` already carries WATCHDOG.md + YAML shared
			// instructions; `config.instructions` adds this advisor's specialization.
			const systemPrompt = [advisorSystemPrompt];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#advisorTools ?? []).filter(t => names.has(t.name));
			const advisorLoopTools: AgentTool<any>[] = [adviseTool, ...tools];
			const advisorToolMap = new Map<string, AgentTool<any>>();
			const availableAdvisorToolNames = new Set<string>();
			for (const tool of advisorLoopTools) {
				availableAdvisorToolNames.add(tool.name);
				advisorToolMap.set(tool.name, tool);
				if (tool.customWireName !== undefined) {
					availableAdvisorToolNames.add(tool.customWireName);
					advisorToolMap.set(tool.customWireName, tool);
				}
			}
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.#host.sessionId();
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
				this.#advisorProviderSessionIds,
				primaryProviderSessionId,
				slug,
			);
			const appendOnlyContext = new AppendOnlyContextManager();

			// Thread the primary's telemetry into the advisor loop so the advisor
			// model's GenAI spans + usage/cost hooks fire stamped with the local advisor
			// identity. `conversationId` is cleared so provider telemetry falls back to
			// the UUIDv7 provider session id, not the local `-advisor` label.
			const advisorTelemetry = this.#host.agent.telemetry
				? {
						...this.#host.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
							description: formatModelString(advisorModel),
						},
						conversationId: undefined,
					}
				: undefined;
			// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
			// providerSessionState, promptCacheKey, transformProviderContext) so each
			// advisor's requests cache, route, and obfuscate like the main turn.
			// `promptCacheKey` preserves an explicitly pinned provider cache key
			// unchanged so tan/shared-session advisor calls read the exact shard the
			// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
			// Codex request identity remains UUID-shaped while local labels keep the
			// `-advisor` suffix.
			const advisorPromptCacheKey = this.#host.agent.promptCacheKey ?? advisorProviderSessionId;
			// On the Cursor provider every tool runs server-side and is dispatched
			// back through `cursorExecHandlers`; without this bridge the advisor's
			// own tools (including the MCP `advise` tool) return `toolNotFound` and
			// no advice is ever routed (issue #5680). Mirrors the primary agent's
			// bridge (`sdk.ts`), scoped to this advisor's granted tool set.
			// Cursor's native `delete` frame removes files directly, bypassing the
			// tool map, so gate it on the advisor actually holding a file-mutating
			// tool. A default read-only advisor (advise/read/grep/glob) never gets
			// to delete workspace files it was never granted (issue #5680 review).
			const advisorCanMutateFiles = advisorToolMap.has("write") || advisorToolMap.has("edit");
			if (advisorCanMutateFiles) availableAdvisorToolNames.add("delete");
			// `pi_edit` speaks `replace`'s `old_string`/`new_string` schema, which the
			// advisor's ordinary `EditTool` (built at the session's configured
			// `edit.mode`, `hashline` by default) does not accept. The bridge map
			// swaps in a `replace` instance for the exec channel only — the
			// advisor's own loop keeps the tool it was given — and only when
			// `edit` was actually granted.
			const advisorCursorExecHandlers = new CursorExecHandlers({
				cwd: this.#host.sessionManager.getCwd(),
				getCwd: () => this.#host.sessionManager.getCwd(),
				tools: bridgeToolMap(advisorToolMap, this.#advisorCreateEditTool),
				// Approval mode, per-tool policies and `autoApprove` live only on
				// this context; without it every bridge tool resolves as `yolo`.
				getToolContext: this.#advisorGetToolContext,
				allowDirectFileMutation: advisorCanMutateFiles,
				// Gated on the advisor's own grant: the factory builds a fresh
				// tool, so handing it over unconditionally would give a roster
				// without `grep` a search tool it was denied.
				createGrepTool: advisorToolMap.has("grep") ? this.#advisorCreateGrepTool : undefined,
				// Advisors share the session's live MCP connections, so their
				// resource frames answer from the same catalog the primary sees.
				// Not gated on a tool grant: reading what a server advertises is
				// not the same permission as calling one of its tools.
				mcpResources: this.#advisorMcpResources,
			});
			const baseAdvisorStreamFn = this.#advisorStreamFn ?? streamSimple;
			const advisorStreamFn: StreamFn = (requestModel, context, options) => {
				if (requestModel.api === "openai-codex-responses") {
					return baseAdvisorStreamFn(requestModel, context, {
						...options,
						codexSseMaxAttempts: ADVISOR_CODEX_SSE_MAX_ATTEMPTS,
					});
				}
				if (
					requestModel.api === "google-generative-ai" ||
					requestModel.api === "google-gemini-cli" ||
					requestModel.api === "google-vertex"
				) {
					return baseAdvisorStreamFn(requestModel, context, { ...options, acceptEmptyResponse: true });
				}
				return baseAdvisorStreamFn(requestModel, context, options);
			};
			const advisorAgent = new Agent({
				initialState: {
					systemPrompt,
					model: advisorModel,
					thinkingLevel: toReasoningEffort(advisorThinkingLevel),
					tools: advisorLoopTools,
				},
				appendOnlyContext,
				sessionId: advisorProviderSessionId,
				promptCacheKey: advisorPromptCacheKey,
				providerSessionState: this.#host.providerSessionState,
				cursorExecHandlers: advisorCursorExecHandlers,
				cwdResolver: () => this.#host.sessionManager.getCwd(),
				preferWebsockets: this.#host.preferWebsockets,
				getApiKey: requestModel => this.#host.modelRegistry.resolver(requestModel, advisorProviderSessionId),
				streamFn: advisorStreamFn,
				onPayload: this.#host.onPayload,
				onResponse: this.#host.onResponse,
				onSseEvent: this.#host.onSseEvent,
				transformProviderContext: this.#transformProviderContext,
				intentTracing: false,
				transformAssistantMessage: message => {
					quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
						message,
						availableAdvisorToolNames,
						buildAdvisorQuarantineSourceText(currentAdvisorInput, advisorAgent.state.messages),
					);
				},
				telemetry: advisorTelemetry,
				serviceTier: undefined,
				serviceTierResolver: advisorServiceTierResolver,
			});
			advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
			let advisorLoopGuardStopped = false;
			// The advisor's own loop needs the same repeated-tool-call bound the
			// primary gets from `LoopGuards`; nothing else stops it reissuing one
			// failing call until the update is abandoned.
			const advisorLoopGuard = new AdvisorLoopGuard({
				settings: this.#host.settings,
				name: advisorName,
				liveMessages: () => advisorAgent.state.messages,
				appendMessage: message => advisorAgent.appendMessage(message),
				abort: reason => {
					advisorLoopGuardStopped = true;
					advisorAgent.abort(reason);
				},
			});
			advisorAgent.setOnTurnEnd((messages, signal, context) => {
				if (signal?.aborted) return;
				advisorLoopGuard.recordTurn(messages, context);
			});

			const advisorAgentFacade: AdvisorAgent = {
				prompt: async input => {
					let quarantined: string | undefined;
					advisorLoopGuard.reset();
					advisorLoopGuardStopped = false;
					try {
						quarantinedAdvisorOutput = undefined;
						// Multi-message input (candidate 4) must serialize deterministically
						// for quarantine source text; reuse the session history formatter
						// rather than ad-hoc joins so all message kinds (text/tool/
						// custom/structured) are preserved exactly as rendered.
						currentAdvisorInput = Array.isArray(input)
							? formatSessionHistoryMarkdown(input, { watchedRoles: true })
							: input;
						// Agent.prompt's overloads accept string OR AgentMessage[] but not
						// the union, so narrow first; both branches intentionally identical.
						if (Array.isArray(input)) await advisorAgent.prompt(input);
						else await advisorAgent.prompt(input);
						quarantined = quarantinedAdvisorOutput;
					} finally {
						if (advisorLoopGuardStopped) {
							// A loop guard stop is a deliberate, bounded silent review, not
							// a provider failure for AdvisorRuntime to retry/fallback.
							advisorAgent.state.error = undefined;
							advisorLoopGuardStopped = false;
						}
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = "";
					}
					if (quarantined) throw new AdvisorOutputQuarantinedError(quarantined);
				},
				abort: reason => advisorAgent.abort(reason),
				reset: () => {
					advisorLoopGuard.reset();
					advisorLoopGuardStopped = false;
					advisorAgent.reset();
					appendOnlyContext.log.clear();
				},
				rollbackTo: count => {
					// Drop the failed user batch + synthetic assistant-error turn
					// `Agent.#runLoop` appended for a turn ending in `stopReason: "error"`.
					const messages = advisorAgent.state.messages;
					if (count < messages.length) {
						messages.length = count;
					}
					appendOnlyContext.resetSyncCursor();
					advisorAgent.state.error = undefined;
				},
				state: advisorAgent.state,
			};

			// Persist this advisor's turns to `<session>/__advisor[.<slug>].jsonl`
			// (resolved lazily so it follows session switches) for stats attribution
			// and Agent Hub observability, without registering it as a peer.
			const recorder = new AdvisorTranscriptRecorder(
				() => this.#host.sessionManager.getSessionFile(),
				() => this.#host.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),
				// On the advisor on→off→on toggle, wait for the prior recorders' closes
				// so two SessionManagers never hold the same file at once.
				this.#advisorCostSnapshotBarrier
					? Promise.all([this.#advisorRecorderClosed, this.#advisorCostSnapshotBarrier])
					: this.#advisorRecorderClosed,
			);
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.#host.agent.state.messages,
				enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
				maintainContext: (incoming, signal) => this.#maintainAdvisorContext(advisorRef, incoming, signal),
				obfuscator: this.#host.obfuscator,
				getModelIdentity: () => formatModelString(advisorRef.agent.state.model),
				beginAdvisorUpdate: inProgress => {
					advisorRef.recorder.beginTurn();
					// Flush the deferred backlog (notes already cleared the emission guard
					// when reserved), then reset the guard's per-update budget for this
					// prompt's live notes.
					advisorRef.adviseTool.beginUpdate(inProgress);
					advisorRef.emissionGuard.beginUpdate();
				},
				onTurnError: (error, failedMessages, signal) =>
					this.#recoverAdvisorTurn(advisorRef, error, failedMessages, signal),
				onTurnSuccess: async () => {
					// Commit the delivered batch so retries of a failed turn stay deduped
					// while this successful turn's context is persisted once (issue #9553).
					advisorRef.recorder.commitTurn();
					const fallback = advisorRef.retryFallback;
					if (!advisorRef.retryFallbackPendingSuccess || !fallback) return;
					advisorRef.retryFallbackPendingSuccess = false;
					await this.#host.emitSessionEvent({
						type: "retry_fallback_succeeded",
						model: formatRetryFallbackSelector(advisorRef.agent.state.model, advisorRef.thinkingLevel),
						role: fallback.role,
					});
				},
				onTurnAbandoned: () => advisorRef.recorder.abandonTurn(),
				notifyFailure: error => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "error" });
					const message = error instanceof Error ? error.message : String(error);
					this.#host.emitNotice(
						"warning",
						`Advisor${slug ? ` "${advisorName}"` : ""} unavailable for ${formatModelString(advisorAgent.state.model)}: ${message}`,
						"advisor",
					);
				},
				notifyQuotaExhausted: () => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "quota_exhausted" });
					this.#host.emitNotice(
						"warning",
						`Advisor "${advisorName}" quota exhausted — pausing until reset.`,
						"advisor",
					);
				},
				notifyIdle: () => {
					// Repaint on every idle transition, streaming or not: the status
					// line masks `yielded` back to open while the primary streams, so
					// mid-turn drain completions stay open, while post-yield
					// completions — including the quota/halt latches, which can land
					// after the agent_end repaint — close the eye without waiting for
					// an unrelated event.
					void this.#host
						.emitSessionEvent({ type: "advisor_yielded" })
						.catch(err => logger.debug("advisor yield notification failed", { err: String(err) }));
				},
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				agent: advisorAgent,
				runtime,
				adviseTool,
				emissionGuard,
				recorder,
				recorderClosed: Promise.resolve(),
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				providerSessionId: advisorProviderSessionId,
				retryFallbackPendingSuccess: false,
				signature,
			};
			this.#refreshAdvisorProviderIdentity(advisorRef);
			this.#attachAdvisorRecorderFeed(advisorRef);
			if (seedToCurrent) runtime.seedTo(this.#host.agent.state.messages.length);
			this.#advisorStatuses.set(slug, { name: advisorName, status: "running" });
			this.#advisors.push(advisorRef);
		}

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
		if (this.#advisors.length > 0 && !this.#advisorYieldQueueUnsubscribe) {
			this.#advisorYieldQueueUnsubscribe = this.#host.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content: formatAdvisorBatchContent(entries),
								details: { notes: entries } satisfies AdvisorMessageDetails,
							} satisfies CustomMessage),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	/**
	 * Route one accepted advice note from `advisor` to the primary. Concern and
	 * blocker interrupt the running agent through the steering channel; once the
	 * loop has yielded, `triggerTurn` resumes it. After a terminal text answer with
	 * no queued work, a concern is preserved as a visible advisor card, while a
	 * blocker wakes the primary to acknowledge work it handed off incorrectly.
	 * After a deliberate user interrupt auto-resume is suppressed while idle/unwinding
	 * (the note becomes a preserved card re-entering on resume); a live-streaming turn is
	 * steered in directly. A plain nit always rides the non-interrupting YieldQueue
	 * aside. Suppression by the per-advisor emission guard drops the note silently —
	 * the model still saw `Recorded.`, so it isn't tempted to rephrase the same note
	 * past the dedupe.
	 */
	#hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.#host.agent.hasQueuedMessages() || this.#host.hasPendingNextTurnMessages()) return false;
		const messages = this.#host.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	/** Emission-guard gate: the noise/empty/dedupe filter plus the
	 *  one-advise-per-update budget, consumed the moment a note is emitted —
	 *  whether it is delivered live or held for a deferred flush. A suppressed
	 *  note never consumes the budget, so it cannot burn an update's slot ahead
	 *  of a substantive concern. Returns whether the note may reach the primary. */
	#acceptAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): boolean {
		if (advisor.emissionGuard.accept(note)) return true;
		logger.debug("advisor advice suppressed by emission guard", { severity, advisor: advisor.name });
		return false;
	}

	/** Route an already-accepted advice note to the primary. Never re-runs the
	 *  emission guard — the note passed {@link #acceptAdvice} when it was emitted,
	 *  so a deferred flush replays the backlog without re-filtering. */
	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): void {
		// The implicit single ("default") advisor stamps no source name, so its
		// agent-facing `<advisory>` bytes stay identical to the pre-multi-advisor path.
		const source = advisor.slug ? advisor.name : undefined;
		const interrupting = isInterruptingSeverity(severity);
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			preserveOnly: this.#preserveAdvisorAdvice,
			// Key on the live agent-core loop, not session `isStreaming` (which also
			// counts `#promptInFlightCount` during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
			streaming: this.#host.agent.state.isStreaming && !this.#preserveTerminalYieldAdvice,
			aborting: this.#host.abortInProgress(),
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isAdvisorInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.#host.yieldQueue.enqueue("advisor", { note, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note, severity, advisor: source }];
		const content = formatAdvisorBatchContent(notes);
		const details = { notes } satisfies AdvisorMessageDetails;
		if (channel === "preserve") {
			this.#host.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		// A steered interrupting note only continues the run when the session can
		// actually start (or is already running) a turn. Two idle cases cannot, so
		// `sendCustomMessage({ triggerTurn: true })` would silently bury the card in
		// `#pendingNextTurnMessages` until the next user prompt — strictly worse than
		// the visible preserved card. Preserve instead:
		//  - Plan mode: only user-driven turns converge on ask/resolve.
		//  - ACP bridges with `deferAgentInitiatedTurns`: the client cannot show an
		//    agent-initiated turn as busy, so idle triggers are refused (#5628 review).
		const cannotAutoTrigger =
			!this.#host.agent.state.isStreaming &&
			this.#host.clientBridge()?.deferAgentInitiatedTurns === true &&
			!this.#host.allowAgentInitiatedTurns();
		if (this.#host.planModeState()?.enabled || cannotAutoTrigger) {
			this.#host.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		// Arm the post-interrupt immune window only now that a turn is actually
		// being steered/triggered. A merely preserved card never interrupts, so
		// arming earlier would downgrade the next `advisor.immuneTurns` worth of
		// real concerns/blockers to skip-idle-flush asides (#5628 review).
		this.#recordAdvisorInterruptDelivered();
		void this.#host
			.sendCustomMessage(
				{ customType: "advisor", content, display: true, attribution: "agent", details },
				{ deliverAs: "steer", triggerTurn: true },
			)
			.catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
	}

	/** Re-prime every advisor's transcript view after an in-conversation history rewrite. */
	#resetAllAdvisorRuntimes(reason?: string): void {
		for (const a of this.#advisors) a.runtime.reset(reason);
	}

	#stopAdvisorRuntime(): void {
		// Detach each recorder feed BEFORE aborting its advisor agent: dispose() aborts
		// the loop, and an abort emits a final `message_end` we must not enqueue against
		// a closing recorder (it would reopen and resurrect an already-released file).
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();
			// Capture each close so dispose()/`/drop` can await the queued open+append+close —
			// the last advisor turn would otherwise be lost on a fast process exit.
			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	#recordAdvisorCost(advisor: ActiveAdvisor, message: AssistantMessage): void {
		const cost = message.usage.cost.total;
		this.#advisorCosts.set(advisor.slug, (this.#advisorCosts.get(advisor.slug) ?? 0) + cost);
		// Cheap in-memory OAuth-credential check; captured now so subscription
		// attribution survives the advisor runtime being torn down (#10131).
		if (cost > 0 && Number.isFinite(cost) && this.#host.modelRegistry.isUsingOAuth(advisor.model)) {
			this.#advisorSubscriptionSlugs.add(advisor.slug);
		}
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachAdvisorRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") this.#recordAdvisorCost(advisor, event.message);
			advisor.recorder.record(event.message);
		});
	}

	/** Switch one advisor model while preserving its context and effort invariants. */
	#setAdvisorModel(advisor: ActiveAdvisor, model: Model, requestedThinkingLevel: ThinkingLevel): ThinkingLevel {
		const resolvedThinkingLevel = resolveThinkingLevelForModel(model, requestedThinkingLevel);
		const nextThinkingLevel = resolvedThinkingLevel ?? ThinkingLevel.Inherit;
		advisor.agent.setModel(model);
		advisor.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
		advisor.agent.setDisableReasoning(shouldDisableReasoning(nextThinkingLevel));
		advisor.agent.appendOnlyContext?.invalidateForModelChange();
		advisor.model = model;
		advisor.thinkingLevel = nextThinkingLevel;
		return nextThinkingLevel;
	}

	/** Restore an advisor's configured primary once its fallback cooldown expires. */
	async #maybeRestoreAdvisorRetryFallbackPrimary(advisor: ActiveAdvisor, signal: AbortSignal): Promise<void> {
		const fallback = advisor.retryFallback;
		if (!fallback || getRetryFallbackRevertPolicy(this.#host.settings) !== "cooldown-expiry") return;

		const originalSelector = parseRetryFallbackSelector(fallback.originalSelector, this.#host.modelRegistry);
		if (!originalSelector) {
			advisor.retryFallback = undefined;
			advisor.retryFallbackPendingSuccess = false;
			return;
		}
		const currentSelector = formatRetryFallbackSelector(advisor.agent.state.model, advisor.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#host.isRetryFallbackSelectorSuppressed(originalSelector)) {
				advisor.retryFallback = undefined;
				advisor.retryFallbackPendingSuccess = false;
			}
			return;
		}
		if (this.#host.isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#host.modelRegistry,
			this.#host.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#host.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#host.modelRegistry.getApiKey(primaryModel, advisor.providerSessionId, { signal });
		if (!apiKey) return;
		signal.throwIfAborted();

		const thinkingToApply =
			advisor.thinkingLevel === fallback.lastAppliedThinkingLevel
				? fallback.originalThinkingLevel
				: advisor.thinkingLevel;
		this.#setAdvisorModel(advisor, primaryModel, thinkingToApply);
		this.#host.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(primaryModel));
		advisor.retryFallback = undefined;
		advisor.retryFallbackPendingSuccess = false;
	}

	/**
	 * Apply the advisor's configured provider-failure fallback chain after
	 * same-provider credential rotation has no usable sibling.
	 */
	async #recoverAdvisorTurn(
		advisor: ActiveAdvisor,
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean> {
		if (error instanceof AdvisorOutputQuarantinedError) return false;

		const failedMessage = failedMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const assistantFailure = failedMessage?.stopReason === "error" ? failedMessage : undefined;
		if (assistantFailure?.content.some(block => block.type === "toolCall")) return false;

		const currentModel = advisor.agent.state.model;
		const message = assistantFailure?.errorMessage ?? (error instanceof Error ? error.message : String(error));
		const errorId = assistantFailure
			? AIError.classifyMessage({
					api: currentModel.api,
					errorId: assistantFailure.errorId,
					errorMessage: message,
					errorStatus: assistantFailure.errorStatus,
				})
			: AIError.classify(error, currentModel.api);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) return false;
		// Text-ambiguous overflows waive the veto; usage-backed do not — see AIError.isTextAmbiguousContextOverflow (#9235).
		const contextWindow = currentModel.contextWindow ?? 0;
		const overflowVeto =
			(AIError.is(errorId, AIError.Flag.ContextOverflow) ||
				(assistantFailure !== undefined && AIError.isContextOverflow(assistantFailure, contextWindow))) &&
			!AIError.isTextAmbiguousContextOverflow(errorId, assistantFailure, contextWindow);
		if (overflowVeto) {
			return false;
		}

		const accountPolicyDenial = AIError.is(errorId, AIError.Flag.AccountPolicy);
		if (accountPolicyDenial) {
			const switched = await this.#host.modelRegistry.authStorage.rotateSessionCredential(
				currentModel.provider,
				advisor.providerSessionId,
				{ error: message, modelId: currentModel.id, signal },
			);
			if (switched) return true;
		}

		const retryAfterMs = extractRetryHint(undefined, message);
		const usageLimit =
			AIError.is(errorId, AIError.Flag.UsageLimit) ||
			isUsageLimitOutcome(extractHttpStatusFromError(error), message);
		if (usageLimit) {
			const outcome = await this.#host.modelRegistry.authStorage.markUsageLimitReached(
				currentModel.provider,
				advisor.providerSessionId,
				{
					retryAfterMs,
					baseUrl: currentModel.baseUrl,
					modelId: currentModel.id,
					signal,
				},
			);
			if (outcome.switched) return true;
		}
		if (!assistantFailure && !accountPolicyDenial && !usageLimit) return false;

		const currentSelector = formatRetryFallbackSelector(currentModel, advisor.thinkingLevel);

		const retrySettings = this.#host.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		// Same two-key walk the main loop uses: the chain that owns this advisor's
		// active fallback, then the chain the current model owns. Without the
		// second key an advisor that lands on the last entry of one chain never
		// reaches that entry's own chain and re-hits the dead model instead.
		const chainKeys = this.#host.retryFallbackChainKeys(currentSelector, currentModel, {
			pinnedRole: advisor.retryFallback?.role,
			roleHint: "advisor",
		});
		if (
			!chainKeys.some(role => this.#host.findRetryFallbackCandidates(role, currentSelector, currentModel).length > 0)
		) {
			return false;
		}

		this.#host.noteRetryFallbackCooldown(currentSelector, retryAfterMs, message);
		for (const role of chainKeys) {
			for (const selector of this.#host.findRetryFallbackCandidates(role, currentSelector, currentModel)) {
				if (this.#host.isRetryFallbackSelectorSuppressed(selector)) continue;
				const resolved = resolveModelOverride([selector.raw], this.#host.modelRegistry, this.#host.settings);
				const candidate = resolved.model ?? this.#host.modelRegistry.find(selector.provider, selector.id);
				if (!candidate || modelsAreEqual(candidate, currentModel)) continue;
				const apiKey = await this.#host.modelRegistry.getApiKey(candidate, advisor.providerSessionId, { signal });
				if (!apiKey) continue;
				signal.throwIfAborted();

				const originalThinkingLevel = advisor.thinkingLevel;
				const requestedThinkingLevel = selector.thinkingLevel ?? originalThinkingLevel;
				const nextThinkingLevel = this.#setAdvisorModel(advisor, candidate, requestedThinkingLevel);
				if (advisor.retryFallback) {
					advisor.retryFallback.lastAppliedThinkingLevel = nextThinkingLevel;
				} else {
					advisor.retryFallback = {
						role,
						originalSelector: currentSelector,
						originalThinkingLevel,
						lastAppliedThinkingLevel: nextThinkingLevel,
					};
				}
				advisor.retryFallbackPendingSuccess = true;
				this.#host.settings.getStorage()?.recordModelUsage(formatModelStringWithRouting(candidate));
				await this.#host.emitSessionEvent({
					type: "retry_fallback_applied",
					from: currentSelector,
					to: selector.raw,
					role,
				});
				return true;
			}
		}
		return false;
	}

	async #promoteAdvisorContextModel(
		advisor: ActiveAdvisor,
		currentModel: Model,
		signal: AbortSignal,
	): Promise<boolean> {
		const promotionSettings = this.#host.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#host.resolveContextPromotionTarget(currentModel, contextWindow, signal);
		if (!targetModel) return false;
		signal.throwIfAborted();

		// Preserve this advisor's own thinking level (a configured `model:...:high`
		// keeps its suffix across a promotion); only the model changes.
		const advisorThinkingLevel = advisor.thinkingLevel;
		try {
			this.#setAdvisorModel(advisor, targetModel, advisorThinkingLevel);
			logger.debug("Advisor context promotion switched model on overflow", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #maintainAdvisorContext(
		advisor: ActiveAdvisor,
		incoming: AgentMessage,
		signal: AbortSignal,
	): Promise<boolean> {
		await this.#maybeRestoreAdvisorRetryFallbackPrimary(advisor, signal);
		const agent = advisor.agent;
		const incomingTokens = agent.tokenizer.countMessage(incoming);

		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (!compactionSettings.enabled || resolveCompactionMethodOrder(compactionSettings.methodOrder).length === 0) {
			return false;
		}

		const advisorModel = agent.state.model;
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = agent.state.messages;
		const storedConversationTokens = agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		// Provider usage (including cache reads and generated output) is the
		// trustworthy anchor for accumulated context. Add only the trailing incoming
		// delta to that arm. Floor it by a full local estimate — fixed advisor system
		// prompt, tool schemas, stored messages, and incoming delta — so provider
		// under-reporting or payload transforms cannot suppress maintenance.
		const providerContextTokens = this.#estimateAdvisorContextTokens(messages, agent.tokenizer) + incomingTokens;
		const localContextTokens =
			agent.tokenizer.countTokens(agent.state.systemPrompt) +
			estimateToolSchemaTokens(agent.state.tools, agent.tokenizer) +
			storedConversationTokens +
			incomingTokens;
		const contextTokens = compactionContextTokens(providerContextTokens, localContextTokens);

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		// 1. Try promotion first
		if (await this.#promoteAdvisorContextModel(advisor, advisorModel, signal)) {
			// Promotion succeeded, check if new model has enough space
			const newModel = agent.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

		// 2. Run compaction on advisor messages
		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				const advisorSummary = message as AdvisorCompactionSummaryMessage;
				return {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId: advisorSummary.firstKeptEntryId || `msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const availableModels = this.#host.modelRegistry.getAvailable();
		const candidates = this.#host.resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			// No compaction candidates, fallback to re-prime
			return true;
		}
		const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			this.#host.sessionId(),
			advisor.slug,
		);
		const preparation = prepareCompaction(pathEntries, compactionSettings, advisorModel, agent.tokenizer);
		if (!preparation) {
			// Cannot prepare compaction, fallback to re-prime
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		// Advisor state is in-memory-only, so snapcompact's frame archive has no
		// stable SessionEntry preserveData slot to carry across future advisor
		// maintenance runs. Use an LLM summary even when the primary session is
		// configured for snapcompact.

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;
		let nativeCompactionFailure: { error: NativeCompactionError; provider: string } | undefined;
		// Instrument the advisor's overflow-compaction one-shot like the primary
		// compaction path so the advisor model's maintenance call also emits spans.
		const telemetry = resolveTelemetry(agent.telemetry, advisorProviderSessionId);

		const codexCompaction = this.#host.createCodexCompactionContext({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});

		for (const candidate of candidates) {
			const apiKey = await this.#host.modelRegistry.getApiKey(candidate, advisorProviderSessionId, { signal });
			if (!apiKey) continue;
			if (
				nativeCompactionFailure &&
				(candidate.provider !== nativeCompactionFailure.provider ||
					!shouldUseProviderNativeCompaction(candidate, compactionSettings))
			) {
				throw nativeCompactionFailure.error;
			}

			// The advisor overflow-compaction one-shot bypasses the advisor `Agent`,
			// so its installed metadata resolver never runs. Emit the same
			// `metadata.user_id` identity here (resolved per candidate provider,
			// after the session-sticky credential is selected) so summarization
			// requests carry the advisor session id like every other advisor call
			// (issue #6625).
			const advisorMetadata = advisorProviderSessionId
				? buildSessionMetadata(advisorProviderSessionId, candidate.provider, this.#host.modelRegistry.authStorage)
				: undefined;
			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#host.modelRegistry.resolver(candidate, advisorProviderSessionId),
					undefined,
					signal,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
						telemetry,
						tools: agent.state.tools,
						sessionId: advisorProviderSessionId,
						promptCacheKey: advisorProviderSessionId,
						metadata: advisorMetadata,
						providerSessionState: this.#host.providerSessionState,
						preferWebsockets: this.#host.preferWebsockets,
						codexCompaction,
					},
				);
				break;
			} catch (error) {
				if (signal.aborted) throw error;
				const id = AIError.classify(error, candidate.api);
				if (error instanceof NativeCompactionError && !AIError.is(id, AIError.Flag.AuthFailed)) {
					nativeCompactionFailure ??= { error, provider: candidate.provider };
					lastError = nativeCompactionFailure.error;
					continue;
				}
				lastError = error;
			}
		}

		if (!compactResult && nativeCompactionFailure) throw nativeCompactionFailure.error;

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		// The retained messages still carry provider usage from before this
		// compaction. Record their exact array boundary on the in-memory summary so
		// only assistants appended afterward can become the next usage anchor.
		const advisorUsageAnchorStartIndex = preparation.recentMessages.length + 1;
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), { shortSummary }),
			firstKeptEntryId,
			advisorUsageAnchorStartIndex,
		} satisfies AdvisorCompactionSummaryMessage;

		agent.replaceMessages([summaryMessage, ...preparation.recentMessages]);
		return false;
	}
	/**
	 * Prevent advisor notes from starting hidden primary turns while a headless
	 * caller prints and drains the final primary response.
	 */
	prepareForHeadlessAdvisorDrain(): void {
		this.#preserveAdvisorAdvice = true;
	}

	/** Preserve advisor output for a terminal yield whose loop is unwinding. */
	prepareForTerminalYieldAdvisorDrain(): void {
		this.#preserveAdvisorAdvice = true;
		this.#preserveTerminalYieldAdvice = true;
	}

	/** Restore normal advisor routing when a kept-alive subagent starts new work. */
	onPrimaryTurnStart(): void {
		if (!this.#preserveTerminalYieldAdvice) return;
		this.#preserveTerminalYieldAdvice = false;
		this.#preserveAdvisorAdvice = false;
	}

	async #waitForPendingAdvisorCardEvents(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (this.#pendingAdvisorCardEvents.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = Promise.allSettled(this.#pendingAdvisorCardEvents).then(() => true as const);
			const { promise: timedOut, resolve } = Promise.withResolvers<false>();
			const timer = setTimeout(() => resolve(false), remainingMs);
			try {
				if (!(await Promise.race([settled, timedOut]))) return false;
			} finally {
				clearTimeout(timer);
			}
		}
		return true;
	}

	/**
	 * Wait for active advisor reviews and their emitted card events before a
	 * headless caller disposes the session. Returns `false` and logs work disposal
	 * will abandon when the shared deadline expires or an advisor fails.
	 */
	async waitForAdvisorCatchup(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const results = await Promise.all(this.#advisors.map(advisor => advisor.runtime.waitForCatchup(timeoutMs, 1)));
		const cardEventsCaughtUp = await this.#waitForPendingAdvisorCardEvents(Math.max(0, deadline - Date.now()));
		const abandoned = this.#advisors.filter(
			(advisor, index) => results[index] === false && advisor.runtime.backlog > 0,
		);
		if (abandoned.length > 0 || !cardEventsCaughtUp) {
			logger.warn("advisor shutdown drain incomplete; disposal will abandon reviews or cards", {
				timeoutMs,
				advisors: abandoned.map(advisor => ({ name: advisor.name, backlog: advisor.runtime.backlog })),
				pendingAdvisorCards: this.#pendingAdvisorCardEvents.size,
			});
			return false;
		}
		return true;
	}
	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		if (!this.#advisorEnabled) return 0;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
		return this.#advisors.length;
	}

	/**
	 * Swap the project context prompt handed to advisor sessions after context
	 * files change (`/reload-plugins` edit/disable). Rebuilds live runtimes in
	 * place so the next advisor turn evaluates against the current instructions;
	 * a no-op when the rendered prompt is unchanged.
	 */
	setContextPrompt(contextPrompt: string | undefined): void {
		if (contextPrompt === this.#advisorContextPrompt) return;
		this.#advisorContextPrompt = contextPrompt;
		if (!this.#advisorEnabled || this.#advisors.length === 0) return;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set for this session (subagents opt in per agent via
	 * frontmatter `advisor` / `task.agentAdvisor`) AND a model resolved for the
	 * `advisor` role — i.e. the actual runtime exists, not merely the setting.
	 * Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	/**
	 * Lightweight advisor status for the status line: returns just the configured
	 * flag and per-advisor name/status without computing token/cost breakdowns.
	 * Avoids re-tokenizing the advisor transcript on every render frame.
	 */
	getAdvisorStatusOverview(): { configured: boolean; advisors: AdvisorStatusOverviewEntry[] } {
		// Override stale map entries with live runtime status: failureNotified/quotaExhausted
		// clear on reset() but #advisorStatuses lags until the next build.
		const liveStatusBySlug = new Map<
			string,
			{ status: AdvisorRuntimeStatus; yielded: boolean; canReview: boolean }
		>();
		for (const a of this.#advisors) {
			liveStatusBySlug.set(a.slug, {
				status: a.runtime.quotaExhausted ? "quota_exhausted" : a.runtime.failureNotified ? "error" : "running",
				yielded: a.runtime.yielded,
				canReview: !a.runtime.quotaExhausted && !a.runtime.halted && !a.runtime.disposed,
			});
		}
		const advisors = [...this.#advisorStatuses.entries()].map(([slug, { name, status }]) => {
			const live = liveStatusBySlug.get(slug);
			return {
				name,
				status: live?.status ?? status,
				// The eye only closes after the primary itself has yielded: while it
				// is streaming, an advisor that can still accept review work may
				// receive (and comment on) new deltas even when its backlog is
				// empty. Advisors that cannot accept work — no live runtime
				// (paused/no-model) or a quota-exhausted/halted runtime — stay
				// yielded regardless of the primary's stream state.
				yielded: live?.canReview && this.#host.agent.state.isStreaming ? false : (live?.yielded ?? true),
			};
		});
		return { configured: this.#advisorEnabled, advisors };
	}

	/** Return cumulative advisor cost recorded for the current session. */
	getAdvisorCost(): number {
		let cost = 0;
		for (const advisorCost of this.#advisorCosts.values()) cost += advisorCost;
		return cost;
	}
	/**
	 * Whether advisor spend should be attributed to an OAuth/subscription plan.
	 * With live advisors it reflects their current models; once the runtime is
	 * gone it consults the attribution recorded as spend accrued, so the status
	 * line never rescans the model catalog per render (#10131).
	 */
	isUsingSubscription(): boolean {
		if (this.#advisors.length > 0) {
			return this.#advisors.some(a => this.#host.modelRegistry.isUsingOAuth(a.model));
		}
		return this.#advisorSubscriptionSlugs.size > 0;
	}
	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const liveAdvisors = this.#advisors.map(a => this.#computeAdvisorStat(a));
		// Build the complete roster from #advisorStatuses, which already has the
		// correct de-duped slugs as keys. Live advisors (from #advisors) carry full
		// token/cost data; disabled/no-model/quota-exhausted advisors appear as
		// skeleton entries with just name + status so the status line renders a dot.
		const liveStatBySlug = new Map(this.#advisors.map((a, i) => [a.slug, liveAdvisors[i]]));
		const roster: PerAdvisorStat[] = [];
		for (const [slug, entry] of this.#advisorStatuses) {
			const live = liveStatBySlug.get(slug);
			if (live) {
				roster.push(live);
			} else {
				roster.push({
					name: entry.name,
					status: entry.status,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: this.#advisorCosts.get(slug) ?? 0,
					messages: { user: 0, assistant: 0, total: 0 },
				});
			}
		}
		const active = liveAdvisors.length > 0;
		const cost = this.getAdvisorCost();
		if (liveAdvisors.length === 0) {
			return {
				configured,
				active,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: roster,
			};
		}
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const messages = { user: 0, assistant: 0, total: 0 };
		let contextTokens = 0;
		for (const a of liveAdvisors) {
			tokens.input += a.tokens.input;
			tokens.output += a.tokens.output;
			tokens.reasoning += a.tokens.reasoning;
			tokens.cacheRead += a.tokens.cacheRead;
			tokens.cacheWrite += a.tokens.cacheWrite;
			tokens.total += a.tokens.total;
			messages.user += a.messages.user;
			messages.assistant += a.messages.assistant;
			messages.total += a.messages.total;
			contextTokens += a.contextTokens;
		}
		// Single-advisor displays read the top-level model/window directly; surface the
		// first advisor's so the legacy status line stays byte-identical.
		return {
			configured,
			active,
			model: liveAdvisors[0].model,
			contextWindow: liveAdvisors[0].contextWindow,
			contextTokens,
			tokens,
			cost,
			messages,
			advisors: roster,
		};
	}

	/** Compute one advisor's stats slice (tokens, cost, context, message counts). */
	#computeAdvisorStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(messages, advisor.agent.tokenizer);
		let input = 0;
		let output = 0;
		let reasoning = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				reasoning += assistantMsg.usage.reasoningTokens ?? 0;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
			}
		}
		return {
			name: advisor.name,
			status: advisor.runtime.quotaExhausted
				? "quota_exhausted"
				: advisor.runtime.failureNotified
					? "error"
					: "running",
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost: this.#advisorCosts.get(advisor.slug) ?? 0,
			messages: { user, assistant, total: messages.length },
			sessionId: advisor.agent.sessionId,
		};
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
		if (!stats.active && stats.advisors.length === 0) {
			return stats.configured
				? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
				: "Advisor is disabled.";
		}
		if (stats.advisors.length <= 1) {
			const s = stats.advisors[0];
			if (s && s.status === "no_model") {
				return stats.configured
					? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
					: "Advisor is disabled.";
			}
			const contextLine =
				s.contextWindow > 0
					? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `Context: ${s.contextTokens.toLocaleString()} tokens`;
			const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
			if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
			if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
			const spendLine = `Spend: ${spendParts.join(", ")}, $${stats.cost.toFixed(4)}`;
			if (!s.model || s.status !== "running") return `Advisor "${s.name}" is ${s.status.replace("_", " ")}.`;
			return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
		}
		const lines = [`Advisors enabled (${stats.advisors.length}):`];
		for (const s of stats.advisors) {
			const ctx =
				s.contextWindow > 0
					? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `${s.contextTokens.toLocaleString()}`;
			lines.push(
				`  • ${s.name}${s.model && s.status === "running" ? ` (${s.model.provider}/${s.model.id})` : ` [${s.status}]`} — context ${ctx} tokens, $${s.cost.toFixed(4)}`,
			);
		}
		lines.push(
			`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
		);
		return lines.join("\n");
	}

	/**
	 * Estimate the advisor's current context tokens. A successful provider usage
	 * after the latest advisor compaction is ground truth for the prompt plus its
	 * generated output; only messages after that anchor are estimated. Usage from
	 * retained pre-compaction messages is stale and must not immediately retrigger
	 * maintenance on the newly compacted context.
	 */
	#estimateAdvisorContextTokens(messages: AgentMessage[], tokenizer: Tokenizer): number {
		let usageAnchorStartIndex = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "compactionSummary") continue;
			const advisorSummary = message as AdvisorCompactionSummaryMessage;
			// Advisor summaries created before this runtime-only boundary existed have
			// no trustworthy way to distinguish retained from newly appended messages.
			// Conservatively ignore every current assistant until the next compaction.
			usageAnchorStartIndex = advisorSummary.advisorUsageAnchorStartIndex ?? messages.length;
			break;
		}
		return estimateTranscriptTokens(messages, tokenizer, {
			anchorFromIndex: usageAnchorStartIndex,
			excludeEncryptedReasoning: true,
		});
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		if (this.#advisors.length === 0) return null;
		const dump = (a: ActiveAdvisor): string =>
			options?.compact
				? formatSessionHistoryMarkdown(a.agent.state.messages)
				: formatSessionDumpText({
						messages: a.agent.state.messages,
						systemPrompt: a.agent.state.systemPrompt,
						model: a.agent.state.model,
						thinkingLevel: a.agent.state.thinkingLevel,
						tools: a.agent.state.tools,
					});
		if (this.#advisors.length === 1) return dump(this.#advisors[0]);
		return this.#advisors
			.map(a => `### Advisor: ${a.name} (${a.agent.state.model.provider}/${a.agent.state.model.id})\n\n${dump(a)}`)
			.join("\n\n");
	}
}
