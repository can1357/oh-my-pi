/**
 * Worker-side publisher that keeps the main thread's `RemoteAgentSession`
 * mirror of one worker-homed `AgentSession` current.
 *
 * Created for every session constructed on a worker (through the session
 * directory's registration hook, which runs at the end of the constructor), so
 * `opened` — key, agent id, full initial state, the message list, and the
 * main-owned registry and job manager the session was built over — is posted
 * before anything can reference the session across the link: every
 * worker→main frame, `callSync` included, shares one FIFO port.
 *
 * After that it posts:
 * - state patches, coalesced per microtask and diffed field by field against
 *   the last published state, whenever an event, run-state transition, or
 *   command may have changed something (a forwarded event first flushes any
 *   pending patch so main never sees an event ahead of the state it implies);
 * - message-list deltas (`append` for messages added after the last
 *   published one, `replace` when the list was rebuilt: compaction, branch
 *   switch, `replaceMessages`);
 * - every run-state transition, unconditionally (registry status sync);
 * - while main watches it (`watch(true)`): the full event stream, plus the
 *   view state and the entry list (a full `view` snapshot when the watch
 *   starts, then `entries` deltas and `viewPatch` diffs in the same flush as
 *   the state patch, ahead of the event that caused them). Main keeps its
 *   entry list between watches, so the snapshot carries only the entries
 *   added since main last received any (the whole list after a rewrite) and
 *   refocusing a long session does not re-send its history. Entries are sent
 *   in display form: model-authored text has its secret placeholders restored,
 *   as `buildTranscriptSessionContext` would. While unwatched,
 *   `message_update`/`tool_execution_update` do not even refresh state, since
 *   main derives `streamMessage` and running tool updates from forwarded
 *   events;
 * - `closed` when the session begins disposing.
 *
 * The publisher is exported to main as the session's command host (kind
 * `"agent-session-host"`), so main's mirror keeps it, and through it the
 * session, alive until `closed`.
 *
 * Main restores queued messages to its composer synchronously from the
 * mirror, so it owns the arbitration between that and delivery: published
 * user-authored queued messages carry an id (a Symbol-keyed tag on the
 * message), and the publisher installs itself as the agent's queued-message
 * gate, asking main synchronously which tagged candidates it already took
 * back before a batch leaves the queue. Candidates the gate lets through are
 * marked claimed, which the queue publishes for a batch still being prepared.
 * A claimed message that goes back to a queue loses its id and mark, so main
 * sees it as a fresh, restorable entry.
 */
import type { AgentMessage, AgentTool, QueuedMessageGate } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { OverlayLayers, Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import { deobfuscateAssistantContent } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { AgentViewToolSchema } from "../session/agent-session-handle";
import {
	isHiddenUserCompanion,
	isUserAuthoredQueuedMessage,
	toRestoredQueuedMessage,
} from "../session/queued-messages";
import type { SessionEntry } from "../session/session-entries";
import { sessionApprovalGrantKeys } from "../tools/approval-cache";
import { isRpcProxy, type RpcServe } from "./rpc";
import {
	SESSION_STATE_READERS as read,
	type SessionBridgeClient,
	type SessionEntriesDelta,
	type SessionHostProtocol,
	type SessionMirrorState,
	type SessionQueuedEntry,
	type SessionRunState,
	type SessionSettingsSource,
	type SessionViewState,
	toWireData,
} from "./session-mirror";

/** Full state of a local session, as published to main. */
export function captureSessionState(session: AgentSession): SessionMirrorState {
	return {
		isStreaming: read.isStreaming(session),
		runStartedAt: read.runStartedAt(session),
		ircWakesPending: read.ircWakesPending(session),
		ircQueuedFrom: session.queuedIrcSenders(),
		isPaused: read.isPaused(session),
		streamMessage: read.streamMessage(session),
		pendingToolCalls: read.pendingToolCalls(session),
		model: read.model(session),
		servingModel: read.servingModel(session),
		thinkingLevel: read.thinkingLevel(session),
		sessionFile: read.sessionFile(session),
		sessionId: read.sessionId(session),
		cwd: read.cwd(session),
		artifactsDir: read.artifactsDir(session),
		usageStatistics: read.usageStatistics(session),
		sessionStats: read.sessionStats(session),
		advisorOverview: read.advisorOverview(session),
		sessionAgents: read.sessionAgents(session),
		hindsightActive: read.hindsightActive(session),
		effectiveExtensionRoots: read.effectiveExtensionRoots(session),
	};
}

/** Id main knows a queued message by (see the module doc). */
const kQueuedMessageId = Symbol("omp.queuedMessageId");
/** Set on a queued message the gate let through for delivery. */
const kQueuedMessageClaimed = Symbol("omp.queuedMessageClaimed");
let queuedMessageSeq = 0;

/** The id `message` was published under, if it was. */
function publishedQueuedMessageId(message: AgentMessage): string | undefined {
	const id: unknown = Reflect.get(message, kQueuedMessageId);
	return typeof id === "string" ? id : undefined;
}

/** `message` as a restorable queue entry, tagging it with an id on first publication. */
function queuedEntry(message: AgentMessage): SessionQueuedEntry {
	let id = publishedQueuedMessageId(message);
	if (id === undefined) {
		id = `q${++queuedMessageSeq}`;
		Reflect.set(message, kQueuedMessageId, id);
	}
	return {
		id,
		message: toRestoredQueuedMessage(message),
		claimed: Reflect.get(message, kQueuedMessageClaimed) === true,
	};
}

/** Queued message published under `id`, if `messages` hold it. */
function findQueuedMessage(messages: Iterable<AgentMessage>, id: string): AgentMessage | undefined {
	for (const message of messages) if (publishedQueuedMessageId(message) === id) return message;
	return undefined;
}

/** View state without the event-maintained running tool updates, as diffed between flushes. */
/** View state without the event-maintained running tool updates, as diffed between flushes. */
type DiffedViewState = Omit<SessionViewState, "activeToolExecutionUpdates">;

/** Live objects behind the wire copies of the heavy view fields; an unchanged source reuses its copy. */
interface ViewSources {
	readonly tools: readonly AgentTool[];
	readonly systemPrompt: readonly string[];
	readonly skills: readonly Skill[];
	readonly rules: Rule[] | null;
	readonly toolNames: readonly string[];
}

/** Whether two lists hold the same items in the same order (identity). */
function sameItems(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Main-side rebuild recipe of `settings` (see {@link SessionSettingsSource}). */
function settingsSource(settings: Settings): SessionSettingsSource {
	const layers: OverlayLayers[] = [];
	let current: Settings | undefined = settings;
	while (current && !isRpcProxy(current)) {
		layers.push(current.overlayLayers());
		current = current.overlayParent();
	}
	layers.reverse();
	return { base: current ?? null, layers };
}

/** `entry` as the transcript shows it: model-authored text with secret placeholders restored. */
function displayEntry(entry: SessionEntry, obfuscator: SecretObfuscator): SessionEntry {
	if (entry.type === "message" && entry.message.role === "assistant") {
		const content = deobfuscateAssistantContent(obfuscator, entry.message.content);
		return content === entry.message.content ? entry : { ...entry, message: { ...entry.message, content } };
	}
	if (entry.type === "compaction") {
		const summary = obfuscator.deobfuscate(entry.summary);
		const shortSummary = entry.shortSummary === undefined ? undefined : obfuscator.deobfuscate(entry.shortSummary);
		return summary === entry.summary && shortSummary === entry.shortSummary
			? entry
			: { ...entry, summary, shortSummary };
	}
	if (entry.type === "branch_summary") {
		const summary = obfuscator.deobfuscate(entry.summary);
		return summary === entry.summary ? entry : { ...entry, summary };
	}
	return entry;
}

/** Wire copies of `entries` in display form. */
function displayEntries(entries: SessionEntry[], obfuscator: SecretObfuscator | undefined): SessionEntry[] {
	if (!obfuscator?.hasSecrets()) return toWireData(entries);
	return toWireData(entries.map(entry => displayEntry(entry, obfuscator)));
}

/** Publishes one worker-homed session to main; see the module doc. */
export class SessionPublisher {
	readonly session: AgentSession;
	readonly #bridge: SessionBridgeClient;
	readonly #key: string;
	#state: SessionMirrorState;
	/** Messages main holds, by identity, in order. */
	#published: AgentMessage[];
	/**
	 * The live message array last published. The loop appends in place, while
	 * history rewrites (compaction, pruning, branch switch) install a new array
	 * whose interior can differ even when its endpoints match.
	 */
	#publishedSource: AgentMessage[];
	#watched = false;
	/** Last published view state; undefined until the current watch sent its snapshot. */
	#view: DiffedViewState | undefined;
	#viewSources: ViewSources | undefined;
	/** Entries main holds (kept across watches), by identity, in order, and the body revision they were read at. */
	#entries: SessionEntry[] = [];
	#entriesRevision = 0;
	#scheduled = false;
	#closed = false;
	readonly #gate: QueuedMessageGate;
	readonly #unsubscribe: () => void;
	readonly #unsubscribeRunState: () => void;
	readonly #unsubscribeIrcWakeHolds: () => void;

	constructor(session: AgentSession, bridge: SessionBridgeClient) {
		this.session = session;
		this.#bridge = bridge;
		this.#key = session.instanceKey;
		this.#state = captureSessionState(session);
		this.#publishedSource = session.messages;
		this.#published = [...this.#publishedSource];
		const jobs = session.asyncJobManager;
		bridge.remote.notify("opened", {
			key: this.#key,
			agentId: session.getAgentId(),
			host: this,
			state: this.#state,
			messages: toWireData(this.#published),
			modelRegistry: isRpcProxy(session.modelRegistry) ? session.modelRegistry : null,
			asyncJobManager: jobs && isRpcProxy(jobs) ? jobs : null,
		});
		this.#gate = {
			claim: (_queue, candidates) => this.#claimQueued(candidates),
			release: messages => {
				for (const message of messages) {
					Reflect.deleteProperty(message, kQueuedMessageId);
					Reflect.deleteProperty(message, kQueuedMessageClaimed);
				}
			},
		};
		session.agent.queuedMessageGate = this.#gate;
		this.#unsubscribe = session.subscribe(event => this.#onEvent(event));
		this.#unsubscribeRunState = session.subscribeRunState(state => this.#onRunState(state));
		// `ircWakesPending` gates main's idle parking and changes without an event.
		this.#unsubscribeIrcWakeHolds = session.subscribeIrcWakeHolds(() => this.schedule());
		session.addDisposer(() => this.close());
	}

	/** Post any state change now instead of at the end of the microtask. */
	flush(): void {
		this.#scheduled = false;
		if (this.#closed) return;
		try {
			this.#publishMessages();
			if (this.#watched && this.#view) this.#publishEntries();
			const next = captureSessionState(this.session);
			const patch: Partial<SessionMirrorState> = {};
			let changed = false;
			for (const field in next) {
				if (!isStateField(field, next)) continue;
				if (Bun.deepEquals(next[field], this.#state[field])) continue;
				copyField(patch, next, field);
				changed = true;
			}
			this.#state = next;
			if (changed) this.#bridge.remote.notify("patch", this.#key, patch);
			if (this.#watched) this.#publishView();
		} catch (error) {
			logger.warn("SessionPublisher failed to publish state", { key: this.#key, error: String(error) });
		}
	}

	/** Start or stop forwarding the full event stream and the view state. */
	watch(on: boolean): void {
		this.#watched = on;
		if (on) {
			this.flush();
			return;
		}
		this.#view = undefined;
		this.#viewSources = undefined;
	}

	/** Post `closed` and stop observing the session. Idempotent. */
	close(): void {
		if (this.#closed) return;
		this.flush();
		this.#closed = true;
		if (this.session.agent.queuedMessageGate === this.#gate) this.session.agent.queuedMessageGate = undefined;
		this.#unsubscribe();
		this.#unsubscribeRunState();
		this.#unsubscribeIrcWakeHolds();
		this.#bridge.remote.notify("closed", this.#key);
	}

	/** Coalesce a publish into the end of the current microtask. */
	schedule(): void {
		if (this.#scheduled || this.#closed) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			if (this.#scheduled) this.flush();
		});
	}

	#onEvent(event: AgentSessionEvent): void {
		if (this.#closed) return;
		// Streaming ticks only move the cursor; main derives `streamMessage` from forwarded updates.
		const tick = event.type === "message_update" || event.type === "tool_execution_update";
		if (!this.#watched) {
			if (!tick) this.schedule();
			return;
		}
		if (!tick || this.#scheduled) this.flush();
		try {
			this.#bridge.remote.notify("event", this.#key, toWireData(event));
		} catch (error) {
			logger.warn("SessionPublisher failed to forward an event", {
				key: this.#key,
				type: event.type,
				error: String(error),
			});
		}
	}

	/**
	 * Gate claim: main decides, synchronously and in order with its own restores,
	 * which published candidates it already took back. Those go, together with
	 * the hidden companions queued right before them; never-published
	 * candidates cannot have been restored and skip the round trip. The rest
	 * are marked claimed.
	 */
	#claimQueued(candidates: readonly AgentMessage[]): AgentMessage[] {
		if (this.#closed) return [];
		const ids: string[] = [];
		for (const message of candidates) {
			const id = publishedQueuedMessageId(message);
			if (id !== undefined) ids.push(id);
		}
		const restored = new Set(ids.length > 0 ? this.#bridge.remote.callSync("claimQueued", this.#key, ids) : []);
		const dropped = new Set<AgentMessage>();
		for (let i = 0; i < candidates.length && restored.size > 0; i++) {
			const id = publishedQueuedMessageId(candidates[i]);
			if (id === undefined || !restored.has(id)) continue;
			let start = i;
			while (start > 0 && isHiddenUserCompanion(candidates[start - 1])) start--;
			for (let j = start; j <= i; j++) dropped.add(candidates[j]);
		}
		for (const message of candidates) if (!dropped.has(message)) Reflect.set(message, kQueuedMessageClaimed, true);
		return [...dropped];
	}

	#onRunState(state: SessionRunState): void {
		if (this.#closed) return;
		this.flush();
		this.#bridge.remote.notify("runState", this.#key, state);
	}

	#publishMessages(): void {
		const current = this.session.messages;
		const published = this.#published;
		const last = published.length - 1;
		const extends_ =
			current === this.#publishedSource &&
			current.length >= published.length &&
			(published.length === 0 || (current[0] === published[0] && current[last] === published[last]));
		if (extends_ && current.length === published.length) return;
		this.#publishedSource = current;
		if (extends_) {
			const added = current.slice(published.length);
			this.#published = [...current];
			this.#bridge.remote.notify("messages", this.#key, { kind: "append", messages: toWireData(added) });
			return;
		}
		this.#published = [...current];
		this.#bridge.remote.notify("messages", this.#key, { kind: "replace", messages: toWireData(this.#published) });
	}

	#publishEntries(): void {
		const delta = this.#entriesDelta();
		if (delta) this.#bridge.remote.notify("entries", this.#key, delta);
	}

	/**
	 * What main's entry list lacks, recorded as sent: the entries appended since
	 * it last received any, or the whole list once the journal was rewritten
	 * (body revision bump, or a published endpoint no longer in place).
	 * Undefined when main is current.
	 */
	#entriesDelta(): SessionEntriesDelta | undefined {
		const manager = this.session.sessionManager;
		const current = manager.getEntries();
		const revision = manager.bodyRevision;
		const published = this.#entries;
		const last = published.length - 1;
		const extends_ =
			revision === this.#entriesRevision &&
			current.length >= published.length &&
			(published.length === 0 || (current[0] === published[0] && current[last] === published[last]));
		if (extends_ && current.length === published.length) return undefined;
		this.#entries = current;
		this.#entriesRevision = revision;
		const obfuscator = this.session.obfuscator;
		if (extends_) return { kind: "append", entries: displayEntries(current.slice(published.length), obfuscator) };
		return { kind: "replace", entries: displayEntries(current, obfuscator) };
	}

	#publishView(): void {
		const next = this.#captureView();
		const previous = this.#view;
		this.#view = next;
		if (!previous) {
			const state: SessionViewState = {
				...next,
				activeToolExecutionUpdates: toWireData([...this.session.activeToolExecutionUpdates()]),
			};
			this.#bridge.remote.notify("view", this.#key, state, this.#entriesDelta());
			return;
		}
		const patch: Partial<SessionViewState> = {};
		let changed = false;
		for (const field in next) {
			if (!isViewField(field, next)) continue;
			const same =
				field === "settings"
					? next.settings.base === previous.settings.base &&
						Bun.deepEquals(next.settings.layers, previous.settings.layers)
					: Bun.deepEquals(next[field], previous[field]);
			if (same) continue;
			copyViewField(patch, next, field);
			changed = true;
		}
		if (changed) this.#bridge.remote.notify("viewPatch", this.#key, patch);
	}

	#captureView(): DiffedViewState {
		const session = this.session;
		const manager = session.sessionManager;
		const previous = this.#view;
		const prior = this.#viewSources;
		const sources: ViewSources = {
			tools: session.agent.state.tools,
			systemPrompt: session.systemPrompt,
			skills: session.skills,
			rules: session.ttsrManager?.getRules() ?? null,
			toolNames: session.getAllToolNames(),
		};
		this.#viewSources = sources;
		const reuse = <K extends keyof ViewSources>(key: K): boolean =>
			previous !== undefined && prior !== undefined && sameItems(prior[key], sources[key]);
		const tools: AgentViewToolSchema[] =
			previous && reuse("tools")
				? previous.tools
				: toWireData(
						sources.tools.map(tool => ({
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						})),
					);
		const steering = session.agent.peekSteeringQueue().filter(isUserAuthoredQueuedMessage);
		const followUp = session.agent.peekFollowUpQueue().filter(isUserAuthoredQueuedMessage);
		return {
			providerSessionId: session.sessionId,
			sessionName: manager.getSessionName(),
			seanceSourceArtifactsDir: manager.getSeanceSourceArtifactsDir(),
			leafId: manager.getLeafId(),
			agentEffort: session.agent.state.thinkingLevel,
			tools,
			toolNames: previous && reuse("toolNames") ? previous.toolNames : [...sources.toolNames],
			builtInTools:
				previous && reuse("toolNames")
					? previous.builtInTools
					: sources.toolNames.filter(name => session.hasBuiltInTool(name)),
			pendingToolResults: toWireData([...session.agent.getPendingToolResults()]),
			runToolCallIds: [...session.runToolCallIds],
			systemPrompt: previous && reuse("systemPrompt") ? previous.systemPrompt : [...sources.systemPrompt],
			skills: previous && reuse("skills") ? previous.skills : toWireData([...session.skills]),
			rules: previous && reuse("rules") ? previous.rules : sources.rules && toWireData(sources.rules),
			// Mid-run its transcript fallback rebuilds the display context on every flush; main reads it only idle.
			hasAbortedToolCallTail: !session.isStreaming && session.hasAbortedToolCallTail,
			isAutoThinking: session.isAutoThinking,
			isCompacting: session.isCompacting,
			compactionSpeculation: session.compactionSpeculation,
			contextUsageRevision: session.contextUsageRevision,
			contextUsage: toWireData(session.getContextUsage()),
			isGeneratingHandoff: session.isGeneratingHandoff,
			isRetrying: session.isRetrying,
			retryAttempt: session.retryAttempt,
			isTtsrAbortPending: session.isTtsrAbortPending,
			hasInterruptibleInput: session.hasInterruptibleInput,
			autoResolvedThinkingLevel: session.autoResolvedThinkingLevel(),
			configuredThinkingLevel: session.configuredThinkingLevel(),
			availableEffortSelectors: session.getAvailableEffortSelectors(),
			serviceTierByFamily: toWireData(session.serviceTierByFamily),
			fastModeActive: session.isFastModeActive(),
			anthropicSlowModeLabel: session.getAnthropicSlowModeLabel(),
			prewalk: toWireData(session.getPrewalkState()),
			goalMode: toWireData(session.getGoalModeState()),
			advisorCost: session.getAdvisorCost(),
			advisorUsingSubscription: session.isAdvisorUsingSubscription(),
			todoPhases: toWireData(session.getTodoPhases()),
			queuedMessages: toWireData(session.getQueuedMessages()),
			restorableQueue: toWireData({ steering: steering.map(queuedEntry), followUp: followUp.map(queuedEntry) }),
			approvals: {
				scopes: session.extensionRunner?.sessionApprovalKeys() ?? [],
				grants: sessionApprovalGrantKeys(session.settings.getAgentDir(), session.sessionManager.getSessionId()),
			},
			ephemeralMaxTokensPreservesRequest: session.ephemeralMaxTokensPreservesRequest(),
			settings: settingsSource(session.settings),
		};
	}
}

function isStateField(field: string, state: SessionMirrorState): field is keyof SessionMirrorState {
	return Object.hasOwn(state, field);
}

function copyField<K extends keyof SessionMirrorState>(
	patch: Partial<SessionMirrorState>,
	state: SessionMirrorState,
	field: K,
): void {
	patch[field] = state[field];
}

function isViewField(field: string, state: DiffedViewState): field is keyof DiffedViewState {
	return Object.hasOwn(state, field);
}

function copyViewField<K extends keyof DiffedViewState>(
	patch: Partial<SessionViewState>,
	state: DiffedViewState,
	field: K,
): void {
	patch[field] = state[field];
}

/** `model` as resolved by the worker session's own registry (main sends plain model data). */
function localModel(session: AgentSession, model: Model): Model {
	return session.modelRegistry.find(model.provider, model.id) ?? model;
}

/** Worker-side implementation of {@link SessionHostProtocol}; commands flush state before their result posts. */
export const SESSION_HOST_SERVE: RpcServe<SessionPublisher, SessionHostProtocol> = {
	prompt: async (publisher, text, options) => settle(publisher, publisher.session.prompt(text, options)),
	steer: async (publisher, text, images, options) => settle(publisher, publisher.session.steer(text, images, options)),
	abort: async (publisher, options) => settle(publisher, publisher.session.abort(options)),
	dispose: async (publisher, options) => settle(publisher, publisher.session.dispose(options)),
	deliverIrcMessage: async (publisher, msg) => settle(publisher, publisher.session.deliverIrcMessage(msg)),
	waitForIrcReplies: async publisher => settle(publisher, publisher.session.waitForIrcReplies()),
	setWorkPoolYieldItems: async (publisher, items) => settle(publisher, publisher.session.setWorkPoolYieldItems(items)),
	emitIrcRelayObservation: (publisher, record) => publisher.session.emitIrcRelayObservation(record),
	watch: (publisher, on) => publisher.watch(on),
	settleInFlightMessagePersistence: async publisher =>
		settle(publisher, publisher.session.settleInFlightMessagePersistence()),
	setThinkingLevel: (publisher, level, persist) => {
		publisher.session.setThinkingLevel(level, persist);
		publisher.schedule();
	},
	popQueuedMessage: (publisher, id) => {
		const session = publisher.session;
		// Neither queued nor held aside: it already left for good and can never be delivered.
		const message =
			findQueuedMessage(session.agent.peekSteeringQueue(), id) ??
			findQueuedMessage(session.agent.peekFollowUpQueue(), id) ??
			findQueuedMessage(session.heldQueuedMessages, id);
		if (message) session.withdrawQueuedMessage(message);
		publisher.schedule();
	},
	setTodoPhases: (publisher, phases) => {
		publisher.session.setTodoPhases(phases);
		publisher.schedule();
	},
	appendCustomEntry: (publisher, customType, data) => {
		publisher.session.sessionManager.appendCustomEntry(customType, data);
		publisher.schedule();
	},
	appendModelUsage: (publisher, usage, owner) => {
		publisher.session.sessionManager.appendModelUsage(usage, owner);
		publisher.schedule();
	},
	flushSession: async publisher => settle(publisher, publisher.session.sessionManager.flush()),
	ensureOnDisk: async publisher => settle(publisher, publisher.session.sessionManager.ensureOnDisk()),
	getArtifactPath: (publisher, id) => publisher.session.sessionManager.getArtifactPath(id),
	getArtifactContent: (publisher, id) => publisher.session.sessionManager.getArtifactContent(id),
	resume: async publisher => settle(publisher, publisher.session.resume()),
	retry: async publisher => settle(publisher, publisher.session.retry()),
	abortRetry: publisher => {
		publisher.session.abortRetry();
		publisher.schedule();
	},
	abortCompaction: (publisher, reason) => {
		publisher.session.abortCompaction(reason);
		publisher.schedule();
	},
	abortHandoff: publisher => {
		publisher.session.abortHandoff();
		publisher.schedule();
	},
	setModelTemporary: async (publisher, model, thinkingLevel, options) =>
		settle(
			publisher,
			publisher.session.setModelTemporary(localModel(publisher.session, model), thinkingLevel, options),
		),
	cycleRoleModels: async (publisher, roleOrder, direction) =>
		toWireData(await settle(publisher, publisher.session.cycleRoleModels(roleOrder, direction))),
	applyRoleModel: async (publisher, entry) =>
		settle(
			publisher,
			publisher.session.applyRoleModel({ ...entry, model: localModel(publisher.session, entry.model) }),
		),
	fetchUsageReports: async (publisher, signal) => toWireData(await publisher.session.fetchUsageReports(signal)),
	runEphemeralTurn: async (publisher, args) => toWireData(await publisher.session.runEphemeralTurn(args)),
	exportToHtml: async (publisher, outputPath, useUserThemes) =>
		publisher.session.exportToHtml(outputPath, useUserThemes),
	enableIdleMaintenance: (publisher, options) => publisher.session.enableIdleMaintenance(options),
	refreshIdleMaintenance: publisher => publisher.session.refreshIdleMaintenance(),
};

async function settle<T>(publisher: SessionPublisher, pending: Promise<T>): Promise<T> {
	try {
		return await pending;
	} finally {
		publisher.flush();
	}
}
