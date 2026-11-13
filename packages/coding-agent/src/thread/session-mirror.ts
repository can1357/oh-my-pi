/**
 * Wire model of agent sessions homed on another thread.
 *
 * A worker's `SessionPublisher` pushes a {@link SessionMirrorState} (plus the
 * message list and, while watched, the event stream) to the main thread, where
 * a `RemoteAgentSession` serves the {@link AgentSessionHandle} surface from it.
 * Workers reach sessions homed elsewhere through `PeerAgentSession`, which
 * reads the same fields from main through {@link SessionBridgeProtocol.read}.
 *
 * While main watches a session (the main-thread TUI focused on it, or any
 * other main subscriber), the publisher also pushes a {@link SessionViewState}
 * and the session's entry list, which back the `AgentViewSession` surface of
 * the mirror; unwatched sessions never pay for them.
 *
 * Everything here is data: models, messages, and events pass through
 * {@link toWireData}, which strips functions and flattens foreign class
 * instances so a session's state never drags live objects across a link. The
 * exceptions are main-owned objects a worker session was built over (its
 * model registry, async job manager, settings), which travel back to main as
 * references to the originals.
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, ImageContent, Model, ServiceTierByFamily, ToolResultMessage, UsageReport } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { AsyncJobManagerApi } from "../async";
import type { Rule } from "../capability/rule";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { ModelRegistry } from "../config/model-registry";
import type { OverlayLayers, Settings } from "../config/settings";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState } from "../goals/state";
import type {
	AgentSessionAdvisorOverview,
	AgentSessionHandle,
	AgentViewToolSchema,
	ToolExecutionUpdateEvent,
} from "../session/agent-session-handle";
import type { AgentSessionEvent, AgentSessionEventListener } from "../session/agent-session-events";
import type {
	AgentSessionDisposeOptions,
	EphemeralTurnOptions,
	EphemeralTurnResult,
	Prewalk,
	PromptOptions,
	ResolvedRoleModel,
	RestoredQueuedMessage,
	RoleModelCycleResult,
	SessionStats,
	SteerOptions,
} from "../session/agent-session-types";
import type { IdleMaintenanceOptions } from "../session/idle-maintenance";
import type { CustomMessage } from "../session/messages";
import type { ServingModel } from "../session/retry-fallback-chains";
import type { ModelUsageEntry, SessionEntry, UsageStatistics } from "../session/session-entries";
import type { AgentDefinition } from "../task/types";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import type { RemoteObject, RpcMethod } from "./rpc";

/** Data a session homed on another thread exposes synchronously. */
export interface SessionMirrorState {
	isStreaming: boolean;
	runStartedAt: number | undefined;
	ircWakesPending: boolean;
	/** Senders with a message still queued for a turn of its own (backs `hasQueuedIrcFrom`). */
	ircQueuedFrom: string[];
	isPaused: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: string[];
	model: Model | undefined;
	servingModel: ServingModel | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	sessionFile: string | undefined;
	sessionId: string;
	cwd: string;
	artifactsDir: string | null;
	usageStatistics: UsageStatistics;
	sessionStats: SessionStats;
	advisorOverview: AgentSessionAdvisorOverview;
	sessionAgents: AgentDefinition[];
	hindsightActive: boolean;
	effectiveExtensionRoots: EffectiveExtensionRoots;
}

/** One field of {@link SessionMirrorState}. */
export type SessionStateField = keyof SessionMirrorState;

/** Fields a worker can read on a session homed elsewhere (queued senders are only mirrored, never polled). */
export type PeerStateField = Exclude<SessionStateField, "ircQueuedFrom">;

/** Change to a mirrored message list. */
export type SessionMessagesDelta =
	| { readonly kind: "append"; readonly messages: AgentMessage[] }
	| { readonly kind: "replace"; readonly messages: AgentMessage[] };

/** Run-state transition reported by `subscribeRunState`. */
export type SessionRunState = "running" | "idle";

/** Change to a mirrored session entry list. */
export type SessionEntriesDelta =
	| { readonly kind: "append"; readonly entries: SessionEntry[] }
	| { readonly kind: "replace"; readonly entries: SessionEntry[] };

/**
 * Where a worker session's settings come from: the main instance its worker
 * chain mirrors (null when the chain's root is a worker-local instance) and the
 * own layers of every worker-local overlay below it, outermost first. Main
 * rebuilds an equivalent with `restoreOverlay`.
 */
export interface SessionSettingsSource {
	readonly base: Settings | null;
	readonly layers: OverlayLayers[];
}

/** Queue chips of a session (see `AgentSession.getQueuedMessages`). */
export interface SessionQueuedMessages {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
	readonly liveSteered: number;
}

/** User-authored queued messages in queue order, as `popLastQueuedMessage` restores them. */
export interface SessionRestorableQueue {
	readonly steering: SessionQueuedEntry[];
	readonly followUp: SessionQueuedEntry[];
}

/**
 * One user-authored queued message under the id its home tagged it with. The
 * id stays put while the message sits in a queue; a message that goes back to
 * a queue after it was claimed for delivery comes back under a fresh id.
 */
export interface SessionQueuedEntry {
	readonly id: string;
	readonly message: RestoredQueuedMessage;
	/** Already claimed for delivery (its batch is being prepared); not restorable. */
	readonly claimed: boolean;
}

/** View-only data of a worker-homed session, published while main watches it (see the module doc). */
export interface SessionViewState {
	/** Provider-facing session id (`AgentSession.sessionId`). */
	providerSessionId: string;
	sessionName: string | undefined;
	seanceSourceArtifactsDir: string | null;
	leafId: string | null;
	/** Effort applied to the agent loop (`agent.state.thinkingLevel`). */
	agentEffort: Effort | undefined;
	tools: AgentViewToolSchema[];
	/** Every registered tool name (active or not), which `getToolByName` can answer for. */
	toolNames: string[];
	/** The registered names that came from a built-in factory. */
	builtInTools: string[];
	pendingToolResults: ToolResultMessage[];
	/** Tool calls emitted by the current run (kept live by a mid-turn transcript rebuild). */
	runToolCallIds: string[];
	systemPrompt: string[];
	skills: Skill[];
	/** TTSR rules; null when the session has no TTSR manager. */
	rules: Rule[] | null;
	/** Published only while idle (false mid-run), the one time the retry hint reads it. */
	hasAbortedToolCallTail: boolean;
	isAutoThinking: boolean;
	isCompacting: boolean;
	compactionSpeculation: "idle" | "running" | "armed";
	contextUsageRevision: number;
	contextUsage: ContextUsage | undefined;
	isGeneratingHandoff: boolean;
	isRetrying: boolean;
	retryAttempt: number;
	isTtsrAbortPending: boolean;
	hasInterruptibleInput: boolean;
	autoResolvedThinkingLevel: Effort | undefined;
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined;
	availableEffortSelectors: ConfiguredThinkingLevel[];
	serviceTierByFamily: ServiceTierByFamily;
	fastModeActive: boolean;
	anthropicSlowModeLabel: string | undefined;
	prewalk: Prewalk | undefined;
	goalMode: GoalModeState | undefined;
	advisorCost: number;
	advisorUsingSubscription: boolean;
	todoPhases: TodoPhase[];
	queuedMessages: SessionQueuedMessages;
	restorableQueue: SessionRestorableQueue;
	ephemeralMaxTokensPreservesRequest: boolean;
	settings: SessionSettingsSource;
	/**
	 * Latest updates of tools still running. Sent only in the full snapshot that
	 * starts a watch; main keeps it current from the forwarded event stream.
	 */
	activeToolExecutionUpdates: ToolExecutionUpdateEvent[];
}

/** One field of {@link SessionViewState}. */
export type SessionViewField = keyof SessionViewState;

/** Payload of {@link SessionBridgeProtocol.opened}. */
export interface SessionOpened {
	readonly key: string;
	/** Registry id the session runs as, when it has one. */
	readonly agentId: string | undefined;
	/** The worker's publisher, imported on main as a `SessionHostClient`. */
	readonly host: object;
	readonly state: SessionMirrorState;
	readonly messages: AgentMessage[];
	/** Main registry the session's registry mirrors; null when the worker built its own. */
	readonly modelRegistry: ModelRegistry | null;
	/** Main async job manager the session registers jobs with; null when it has none or a worker-local one. */
	readonly asyncJobManager: AsyncJobManagerApi | null;
}

/** Abort options of `AgentSessionHandle.abort`. */
export interface SessionAbortOptions {
	goalReason?: "interrupted" | "internal";
	reason?: string;
	preserveCompaction?: boolean;
	deliverQueuedMessages?: boolean;
}

/**
 * Remote-object protocol (kind `"agent-session-host"`) the main thread speaks
 * to a worker's publisher: commands on the worker-homed session plus the
 * event-stream watch toggle.
 */
export type SessionHostProtocol = {
	prompt: RpcMethod<[text: string, options?: PromptOptions], boolean>;
	steer: RpcMethod<[text: string, images?: ImageContent[], options?: SteerOptions], void>;
	abort: RpcMethod<[options?: SessionAbortOptions], void>;
	dispose: RpcMethod<[options?: AgentSessionDisposeOptions], void>;
	deliverIrcMessage: RpcMethod<[msg: IrcMessage], "injected" | "woken">;
	waitForIrcReplies: RpcMethod<[], void>;
	setWorkPoolYieldItems: RpcMethod<[items: readonly WorkPoolYieldItem[]], void>;
	emitIrcRelayObservation: RpcMethod<[record: CustomMessage], void>;
	/** Start (true) or stop (false) forwarding the full event stream and the view state. */
	watch: RpcMethod<[on: boolean], void>;
	settleInFlightMessagePersistence: RpcMethod<[], void>;
	setThinkingLevel: RpcMethod<[level: ConfiguredThinkingLevel | undefined, persist?: boolean], void>;
	/**
	 * Retire queued message `id` (main restored it): take it out of its queue,
	 * or keep whatever holds it aside from putting it back. Resolves once it can
	 * never be delivered.
	 */
	popQueuedMessage: RpcMethod<[id: string], void>;
	setTodoPhases: RpcMethod<[phases: TodoPhase[]], void>;
	appendCustomEntry: RpcMethod<[customType: string, data: unknown], void>;
	appendModelUsage: RpcMethod<
		[
			usage: Pick<
				ModelUsageEntry,
				"purpose" | "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
			>,
			owner: { sessionId: string; parentId: string | null },
		],
		void
	>;
	flushSession: RpcMethod<[], void>;
	ensureOnDisk: RpcMethod<[], void>;
	getArtifactPath: RpcMethod<[id: string], string | null>;
	getArtifactContent: RpcMethod<[id: string], string | null>;
	resume: RpcMethod<[], void>;
	retry: RpcMethod<[], boolean>;
	abortRetry: RpcMethod<[], void>;
	abortCompaction: RpcMethod<[reason?: unknown], void>;
	abortHandoff: RpcMethod<[], void>;
	setModelTemporary: RpcMethod<
		[model: Model, thinkingLevel?: ConfiguredThinkingLevel, options?: { ephemeral?: boolean }],
		void
	>;
	cycleRoleModels: RpcMethod<
		[roleOrder: readonly string[], direction?: "forward" | "backward"],
		RoleModelCycleResult | undefined
	>;
	applyRoleModel: RpcMethod<[entry: ResolvedRoleModel], void>;
	fetchUsageReports: RpcMethod<[signal?: AbortSignal], UsageReport[] | null>;
	runEphemeralTurn: RpcMethod<[args: EphemeralTurnOptions], EphemeralTurnResult>;
	exportToHtml: RpcMethod<[outputPath?: string, useUserThemes?: boolean], string>;
	enableIdleMaintenance: RpcMethod<[options: IdleMaintenanceOptions], void>;
	refreshIdleMaintenance: RpcMethod<[], void>;
};

/**
 * Remote-object protocol (kind `"agent-session-bridge"`) a worker speaks to
 * its main-thread bridge: publisher notifications for sessions homed on the
 * worker, and peer access to sessions homed elsewhere (main answers from its
 * local session or its mirror, and routes commands to the home thread).
 */
export type SessionBridgeProtocol = {
	opened: RpcMethod<[opened: SessionOpened], void>;
	patch: RpcMethod<[key: string, patch: Partial<SessionMirrorState>], void>;
	messages: RpcMethod<[key: string, delta: SessionMessagesDelta], void>;
	event: RpcMethod<[key: string, event: AgentSessionEvent], void>;
	runState: RpcMethod<[key: string, state: SessionRunState], void>;
	/**
	 * Watch started: the full view state, and what main's entry list (kept across
	 * watches) lacks; undefined when it is current.
	 */
	view: RpcMethod<[key: string, state: SessionViewState, entries: SessionEntriesDelta | undefined], void>;
	viewPatch: RpcMethod<[key: string, patch: Partial<SessionViewState>], void>;
	/**
	 * Synchronous, from the agent's queued-message gate: queued entries `ids` are
	 * about to be delivered. Returns those main already restored (they must be
	 * dropped); the rest count as claimed and are no longer restorable on main.
	 */
	claimQueued: RpcMethod<[key: string, ids: string[]], string[]>;
	entries: RpcMethod<[key: string, delta: SessionEntriesDelta], void>;
	closed: RpcMethod<[key: string], void>;
	read: RpcMethod<[session: AgentSessionHandle, fields: readonly PeerStateField[]], Partial<SessionMirrorState>>;
	readMessages: RpcMethod<[session: AgentSessionHandle], AgentMessage[]>;
	hasQueuedIrcFrom: RpcMethod<[session: AgentSessionHandle, from: string], boolean>;
	subscribe: RpcMethod<[session: AgentSessionHandle, listener: AgentSessionEventListener], () => void>;
	subscribeRunState: RpcMethod<[session: AgentSessionHandle, listener: (state: SessionRunState) => void], () => void>;
	prompt: RpcMethod<[session: AgentSessionHandle, text: string, options?: PromptOptions], boolean>;
	steer: RpcMethod<[session: AgentSessionHandle, text: string, images?: ImageContent[], options?: SteerOptions], void>;
	abort: RpcMethod<[session: AgentSessionHandle, options?: SessionAbortOptions], void>;
	dispose: RpcMethod<[session: AgentSessionHandle, options?: AgentSessionDisposeOptions], void>;
	deliverIrcMessage: RpcMethod<[session: AgentSessionHandle, msg: IrcMessage], "injected" | "woken">;
	waitForIrcReplies: RpcMethod<[session: AgentSessionHandle], void>;
	setWorkPoolYieldItems: RpcMethod<[session: AgentSessionHandle, items: readonly WorkPoolYieldItem[]], void>;
	emitIrcRelayObservation: RpcMethod<[session: AgentSessionHandle, record: CustomMessage], void>;
};

/** Worker-side proxy of the main thread's bridge (remote-object kind `"agent-session-bridge"`). */
export class SessionBridgeClient {
	constructor(readonly remote: RemoteObject<SessionBridgeProtocol>) {}
}

/** Readers of every {@link PeerStateField} on any handle, returning wire-safe data. */
export const SESSION_STATE_READERS: {
	readonly [K in PeerStateField]: (session: AgentSessionHandle) => SessionMirrorState[K];
} = {
	isStreaming: session => session.isStreaming,
	runStartedAt: session => session.runStartedAt,
	ircWakesPending: session => session.ircWakesPending,
	isPaused: session => session.agent.isPaused,
	streamMessage: session => toWireData(session.agent.state.streamMessage),
	pendingToolCalls: session => [...session.agent.state.pendingToolCalls],
	model: session => toWireData(session.model),
	servingModel: session => toWireData(session.servingModel),
	thinkingLevel: session => session.thinkingLevel,
	sessionFile: session => session.sessionFile,
	sessionId: session => session.sessionManager.getSessionId(),
	cwd: session => session.sessionManager.getCwd(),
	artifactsDir: session => session.sessionManager.getArtifactsDir(),
	usageStatistics: session => toWireData(session.sessionManager.getUsageStatistics()),
	sessionStats: session => toWireData(session.getSessionStats()),
	advisorOverview: session => toWireData(session.getAdvisorStatusOverview()),
	sessionAgents: session => toWireData(session.getSessionAgents()),
	hindsightActive: session => session.hindsightActive,
	effectiveExtensionRoots: session => toWireData(session.effectiveExtensionRoots),
};

/** Read `fields` of `session` into a partial state. */
export function readSessionFields(
	session: AgentSessionHandle,
	fields: readonly PeerStateField[],
): Partial<SessionMirrorState> {
	const state: Partial<SessionMirrorState> = {};
	for (const field of fields) assignField(state, field, session);
	return state;
}

function assignField<K extends PeerStateField>(
	state: Partial<SessionMirrorState>,
	field: K,
	session: AgentSessionHandle,
): void {
	state[field] = SESSION_STATE_READERS[field](session);
}

/** Built-in structured-clone types passed through unchanged. */
function isCloneableBuiltin(value: object): boolean {
	return (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Map ||
		value instanceof Set ||
		value instanceof Error ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value) ||
		value instanceof Blob
	);
}

function wire(value: unknown): unknown {
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		let copy: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			const next = wire(item);
			if (next !== item && !copy) copy = value.slice(0, i);
			copy?.push(next);
		}
		return copy ?? value;
	}
	if (isCloneableBuiltin(value)) return value;
	const proto: unknown = Object.getPrototypeOf(value);
	const plain = proto === Object.prototype || proto === null;
	let copy: Record<string, unknown> | undefined = plain ? undefined : {};
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const item: unknown = Reflect.get(value, key);
		const next = wire(item);
		if (next !== item && !copy) {
			copy = {};
			for (const prior in value) {
				if (prior === key) break;
				if (Object.hasOwn(value, prior)) copy[prior] = Reflect.get(value, prior);
			}
		}
		if (copy && next !== undefined) copy[key] = next;
	}
	return copy ?? value;
}

/**
 * Wire-safe copy of session data: functions and symbols are dropped, foreign
 * class instances become plain records of their own enumerable fields, and
 * already-clean values are returned as-is (copy on write).
 */
export function toWireData<T>(value: T): T {
	let result!: T;
	// Trust boundary: the copy has the declared shape minus behavior; method
	// bivariance lets the typed sink accept it.
	const sink: { put(item: unknown): void } = {
		put: (item: T) => {
			result = item;
		},
	};
	sink.put(wire(value));
	return result;
}
