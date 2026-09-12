import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { type BankScope, ensureBankExists } from "./bank";
import type { HindsightApi, MemoryItemInput, UpdateMode } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	loadMentalModelsBlock,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
} from "./mental-models";
import { countRetainableUserTurns, extractMessages } from "./transcript";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;

interface PendingRetainItem {
	content: string;
	context?: string;
	timestamp: Date;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

export interface HindsightConversationTrackingSnapshot {
	lastRetainedTurn: number;
	closeRetainBaselineTurns: number;
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	lastRetainedMessageIndex: number;
	cachedTranscript: string;
	lastRetainedPrefixKey: string;
	loadedMessageCount: number;
	loadedPrefixKey: string;
}

export interface HindsightSessionStateOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	/** User turns loaded before this process added new activity. */
	closeRetainBaselineTurns?: number;
	/** Retainable messages present at delayed-startup baseline capture. */
	loadedMessageCount?: number;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and banksSet. Aliases skip auto-recall and
	 * auto-retain — those run on the parent only — but the recall/retain/reflect
	 * tools resolve via the alias so they persist to the same bank as the parent.
	 */
	aliasOf?: HindsightSessionState;
}

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and waits for server-side processing (`async: false`) so the local cursor
 * only advances after that retain is durable.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string): void {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		this.#items.push({ content, context, timestamp: new Date() });

		if (this.#items.length >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				void this.flush();
			}, RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight flush, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#items.length > 0) await this.flush();
			return;
		}

		if (this.#items.length === 0) return;

		const items = this.#items.splice(0);
		const flushPromise = this.#doFlush(items);
		this.#flushing = flushPromise;
		try {
			await flushPromise;
		} finally {
			this.#flushing = undefined;
		}
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#items = [];
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const state = this.#state;
		const sessionId = state.sessionId;
		if (state.session.getHindsightSessionState() !== state) {
			// Session went away before we could flush. We can't notify anyone, so
			// log and drop — these are best-effort facts, not transactional writes.
			logger.warn("Hindsight retain queue: session vanished, dropping batch", {
				sessionId,
				items: items.length,
			});
			return;
		}

		try {
			await ensureBankExists(state.client, state.bankId, state.config, state.banksSet);
			const batch: MemoryItemInput[] = items.map(item => ({
				content: item.content,
				context: item.context ?? state.config.retainContext,
				metadata: { session_id: sessionId },
				tags: state.retainTags,
				timestamp: item.timestamp,
			}));
			await state.client.retainBatch(state.bankId, batch, { async: true });
			if (state.config.debug) {
				logger.debug("Hindsight retain queue: batch flushed", {
					sessionId,
					bankId: state.bankId,
					items: items.length,
				});
			}
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight retain queue: batch flush failed", {
				sessionId,
				bankId: state.bankId,
				items: items.length,
				error: errorText,
			});
			this.#notifyRetainFailure(items.length, errorText);
		}
	}

	#notifyRetainFailure(count: number, errorText: string): void {
		const noun = count === 1 ? "memory" : "memories";
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${count} ${noun}: ${errorText}`,
			"Hindsight",
		);
	}
}

/** Rolling hash of messages[0, count) for retention-cache validation (see #lastRetainedPrefixKey). */
function retentionPrefixKey(messages: HindsightMessage[], count: number): string {
	let key = "";
	for (let i = 0; i < count; i++) {
		const m = messages[i];
		if (m === undefined) break;
		key = Bun.hash(`${key}\u0000${m.role}\u0000${m.content}\u0000${m.timestamp ?? ""}`).toString(36);
	}
	return key;
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightApi;
	bankId: string;
	/** Tags applied to every retain — non-empty in per-project-tagged mode. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: Set<string>;
	lastRetainedTurn: number;
	#lastRetainedMessageIndex: number = 0;
	#cachedTranscript: string = "";
	// Rolling hash of ALL messages in [0, #lastRetainedMessageIndex) at cache
	// time. The incremental full-session cache assumes the branch is append-only;
	// a rewind, branch switch, compaction, or in-place edit rewrites the prefix
	// without changing the session id. Re-hashing the current prefix at use time
	// makes the cache self-healing: on ANY prefix change (not just the boundary
	// message) we rebuild the full transcript instead of retaining stale content
	// or silently retaining nothing forever. Hashing is orders of magnitude
	// cheaper than the re-formatting this cache avoids.
	#lastRetainedPrefixKey: string = "";
	#retainInFlight: Promise<void> = Promise.resolve();
	#sessionRetainInFlight: Promise<void> = Promise.resolve();
	#retainGeneration = 0;
	#closeRetainBaselineTurns = 0;
	#loadedMessageCount = 0;
	#loadedPrefixKey = "";
	#forceNextRetainReplace = false;
	#lastCompletedLastTurnRetainBySession = new Map<
		string,
		{ messageCount: number; prefixKey: string; userTurns: number }
	>();
	#lastTurnRollbackSessions = new Set<string>();
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the cached snippet was last refreshed; gates the agent_end re-list. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight ensure+load promise. `beforeAgentStartPrompt` awaits this on
	 * the first turn so the MM block lands in the system prompt before the
	 * LLM generates, even though `start()` returns before the load completes.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	unsubscribe?: () => void;
	/**
	 * Releases the `onHindsightScopeChanged` subscription that drives live
	 * rebuilds when `hindsight.bankId` / `bankIdPrefix` / `scoping` change.
	 * Only set on primary states; aliases inherit the parent's subscription.
	 */
	unsubscribeScope?: () => void;
	/** Alias states delegate persistence config to a primary parent state. */
	aliasOf?: HindsightSessionState;
	readonly retainQueue: HindsightRetainQueue;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.bankId = options.bankId;
		this.retainTags = options.retainTags;
		this.recallTags = options.recallTags;
		this.recallTagsMatch = options.recallTagsMatch;
		this.config = options.config;
		this.session = options.session;
		this.banksSet = options.banksSet;
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.aliasOf = options.aliasOf;
		this.retainQueue = new HindsightRetainQueue(this);
		this.#closeRetainBaselineTurns =
			options.closeRetainBaselineTurns ??
			(this.session.sessionManager ? countRetainableUserTurns(this.session.sessionManager) : 0);
		this.#captureLoadedBranchIdentity(options.loadedMessageCount);
	}

	setSessionId(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.sessionId = sessionId;
		this.#invalidateRetainCache();
	}

	/** Snapshot retain/recall counters so a failed `/resume` can roll them back. */
	captureConversationTracking(): HindsightConversationTrackingSnapshot {
		return {
			lastRetainedTurn: this.lastRetainedTurn,
			closeRetainBaselineTurns: this.#closeRetainBaselineTurns,
			hasRecalledForFirstTurn: this.hasRecalledForFirstTurn,
			lastRecallSnippet: this.lastRecallSnippet,
			lastRetainedMessageIndex: this.#lastRetainedMessageIndex,
			cachedTranscript: this.#cachedTranscript,
			lastRetainedPrefixKey: this.#lastRetainedPrefixKey,
			loadedMessageCount: this.#loadedMessageCount,
			loadedPrefixKey: this.#loadedPrefixKey,
		};
	}

	restoreConversationTracking(snapshot: HindsightConversationTrackingSnapshot): void {
		this.lastRetainedTurn = snapshot.lastRetainedTurn;
		this.#closeRetainBaselineTurns = snapshot.closeRetainBaselineTurns;
		this.hasRecalledForFirstTurn = snapshot.hasRecalledForFirstTurn;
		this.lastRecallSnippet = snapshot.lastRecallSnippet;
		this.#loadedMessageCount = snapshot.loadedMessageCount;
		this.#loadedPrefixKey = snapshot.loadedPrefixKey;
		this.#lastTurnRollbackSessions.add(this.sessionId);
		// Rekeying fences any retain that was already in flight. It may still
		// have reached Hindsight, so a pre-switch append cursor is no longer a
		// trustworthy server boundary after rollback. Rebuild canonically next.
		this.#forceNextRetainReplace = true;
		this.#invalidateRetainCache();
		if (this.config.retainMode === "last-turn") {
			// Last-turn docs are unique by timestamp. The saved branch identity
			// remains the close-tail boundary unless a completed retain recorded
			// a newer one; wiping it makes `loadedMessageCount === 0` sessions
			// re-emit the already-persisted window.
			this.#lastRetainedMessageIndex = snapshot.lastRetainedMessageIndex;
			this.#lastRetainedPrefixKey = snapshot.lastRetainedPrefixKey;
		}
		this.#reconcileCompletedLastTurnRetain();
	}

	resetConversationTracking(closeRetainBaselineTurns?: number): void {
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#closeRetainBaselineTurns =
			closeRetainBaselineTurns ??
			(this.session.sessionManager ? countRetainableUserTurns(this.session.sessionManager) : 0);
		this.#invalidateRetainCache();
		this.#captureLoadedBranchIdentity();
	}

	#invalidateRetainCache(): void {
		this.#retainGeneration++;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	#captureLoadedBranchIdentity(loadedMessageCount?: number): void {
		const loaded = this.session.sessionManager ? extractMessages(this.session.sessionManager) : [];
		this.#loadedMessageCount = loadedMessageCount ?? loaded.length;
		this.#loadedPrefixKey = retentionPrefixKey(loaded, this.#loadedMessageCount);
	}

	#recordCompletedLastTurnRetain(sessionId: string, messages: HindsightMessage[]): void {
		const completed = {
			messageCount: messages.length,
			prefixKey: retentionPrefixKey(messages, messages.length),
			userTurns: messages.filter(message => message.role === "user").length,
		};
		this.#lastCompletedLastTurnRetainBySession.set(sessionId, completed);
		if (this.#lastTurnRollbackSessions.has(sessionId)) this.#reconcileCompletedLastTurnRetain();
	}

	#reconcileCompletedLastTurnRetain(): void {
		if (this.config.retainMode !== "last-turn") return;
		if (!this.#lastTurnRollbackSessions.has(this.sessionId)) return;
		const completed = this.#lastCompletedLastTurnRetainBySession.get(this.sessionId);
		if (!completed || !this.session.sessionManager) return;
		const active = extractMessages(this.session.sessionManager);
		if (active.length < completed.messageCount) return;
		if (retentionPrefixKey(active, completed.messageCount) !== completed.prefixKey) return;
		this.lastRetainedTurn = Math.max(this.lastRetainedTurn, completed.userTurns);
		if (completed.messageCount >= this.#lastRetainedMessageIndex) {
			this.#lastRetainedMessageIndex = completed.messageCount;
			this.#lastRetainedPrefixKey = completed.prefixKey;
		}
		this.#lastTurnRollbackSessions.delete(this.sessionId);
	}

	#scheduleSessionRetain(task: () => Promise<void>): Promise<void> {
		const run = this.#sessionRetainInFlight.then(task, task);
		this.#sessionRetainInFlight = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async waitForSessionRetainIdle(): Promise<void> {
		await this.#sessionRetainInFlight;
	}

	#retainedPrefixDiverged(messages: HindsightMessage[]): boolean {
		if (this.#lastRetainedMessageIndex === 0) return false;
		if (this.#lastRetainedMessageIndex > messages.length) return true;
		return retentionPrefixKey(messages, this.#lastRetainedMessageIndex) !== this.#lastRetainedPrefixKey;
	}

	#sessionHistoryDiverged(messages: HindsightMessage[]): boolean {
		if (this.#retainedPrefixDiverged(messages)) return true;
		// Resume starts with no retained-prefix identity. Detect `/tree` rewinds
		// against the loaded branch so a shorter replacement is not treated as
		// already-retained history.
		if (this.#lastRetainedMessageIndex > 0 || this.#loadedMessageCount === 0) return false;
		if (messages.length < this.#loadedMessageCount) return true;
		return retentionPrefixKey(messages, this.#loadedMessageCount) !== this.#loadedPrefixKey;
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	async flushPendingSessionRetain(): Promise<void> {
		if (this.aliasOf) return;
		await this.#scheduleSessionRetain(() => this.#flushPendingSessionRetainLocked());
	}

	async #flushPendingSessionRetainLocked(): Promise<void> {
		if (!this.config.autoRetain) return;
		await this.#retainInFlight;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		const retainedThrough = Math.max(this.lastRetainedTurn, this.#closeRetainBaselineTurns);
		// Resume starts lastRetainedTurn at 0 even when the transcript already
		// contains history. Treat loaded history as already retained on the close
		// path so idle open/close does not reconsolidate the full document; only
		// a below-cadence tail of new turns is flushed. Last-turn retains still
		// record the retained branch identity so `/tree` rewinds can diverge.
		const prefixDiverged = this.#sessionHistoryDiverged(messages);
		const retainedMessageCount =
			this.#lastRetainedMessageIndex > 0 ? this.#lastRetainedMessageIndex : this.#loadedMessageCount;
		const messageTailPending = messages.length > retainedMessageCount;
		if (userTurns <= retainedThrough && !prefixDiverged && !messageTailPending) return;
		try {
			const generation = this.#retainGeneration;
			const lastTurnWindow =
				this.config.retainMode === "last-turn"
					? Math.max(prefixDiverged ? userTurns : userTurns - retainedThrough, 1) + this.config.retainOverlapTurns
					: undefined;
			await this.retainSession(messages, lastTurnWindow === undefined ? undefined : { lastTurnWindow });
			if (generation === this.#retainGeneration) this.lastRetainedTurn = userTurns;
		} catch (err) {
			logger.warn("Hindsight: session-end retain flush failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async drainOnClose(): Promise<void> {
		if (this.aliasOf) {
			// Aliases skip auto-retain, but retain/learn tools still enqueue on
			// the alias queue. Flush those items before dispose; skipping here
			// drops them because aliases never attach agent_end.
			await this.flushRetainQueue();
			return;
		}
		await this.#scheduleSessionRetain(async () => {
			// Reserve the same session-retain barrier as `/memory enqueue`
			// before flushing tool items. Otherwise both callers can finish the
			// shared flush and race while installing their transcript retains.
			await this.flushRetainQueue();
			await this.#flushPendingSessionRetainLocked();
		});
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length === 0) return { context: null, ok: true };
			const formatted = formatMemories(results);
			const block = `<memories>\n${this.config.recallPromptPreamble}\nCurrent time: ${formatCurrentTime()} UTC\n\n${formatted}\n</memories>`;
			return { context: block, ok: true };
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Hindsight: recall failed", { bankId: this.bankId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	#sessionSourceTimestamp(): Date | undefined {
		const header = this.session.sessionManager?.getHeader?.();
		const timestamp = header?.timestamp;
		if (typeof timestamp !== "string") return undefined;
		const trimmed = timestamp.trim();
		if (!trimmed) return undefined;
		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	async retainSession(
		messages: HindsightMessage[],
		opts?: { forceReplace?: boolean; lastTurnWindow?: number },
	): Promise<void> {
		const identity = { sessionId: this.sessionId, generation: this.#retainGeneration };
		const run = this.#retainInFlight.then(
			() => this.#retainSessionLocked(messages, opts, identity),
			() => this.#retainSessionLocked(messages, opts, identity),
		);
		this.#retainInFlight = run.then(
			() => undefined,
			() => undefined,
		);
		await run;
	}

	async #retainSessionLocked(
		messages: HindsightMessage[],
		opts: { forceReplace?: boolean; lastTurnWindow?: number } | undefined,
		identity: { sessionId: string; generation: number },
	): Promise<void> {
		const forceReplace = opts?.forceReplace || this.#forceNextRetainReplace;
		if (forceReplace) {
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
		}
		const { sessionId, generation } = identity;
		const retainedAt = new Date();
		const sourceTimestamp = this.#sessionSourceTimestamp() ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;
		let updateMode: UpdateMode | undefined;
		let appendDelta = false;

		if (retainFullWindow) {
			documentId = sessionId;
			const previousBoundary = this.#lastRetainedMessageIndex;
			let rebuiltDivergentPrefix = false;
			if (
				previousBoundary > messages.length ||
				retentionPrefixKey(messages, previousBoundary) !== this.#lastRetainedPrefixKey
			) {
				rebuiltDivergentPrefix = previousBoundary > 0;
				this.#lastRetainedMessageIndex = 0;
				this.#cachedTranscript = "";
				this.#lastRetainedPrefixKey = "";
			}
			const start = this.#lastRetainedMessageIndex;
			const newMessages = messages.slice(start);
			const { transcript: newPart } = prepareRetentionTranscript(newMessages, true, { includeTimestamps: true });
			if (!newPart) return;
			nextCachedTranscript = this.#cachedTranscript ? `${this.#cachedTranscript}\n\n${newPart}` : newPart;
			appendDelta = this.config.retainUpdateMode === "append" && start > 0 && !forceReplace;
			if (appendDelta) {
				transcript = newPart;
				updateMode = "append";
			} else {
				transcript = nextCachedTranscript;
				if (forceReplace || rebuiltDivergentPrefix) updateMode = "replace";
			}
		} else {
			const windowTurns = opts?.lastTurnWindow ?? this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			const target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${sessionId}-${retainedAt.getTime()}`;
			this.#cachedTranscript = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(target, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		try {
			await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);
			await this.client.retain(this.bankId, transcript, {
				documentId,
				context: this.config.retainContext,
				metadata: { session_id: sessionId },
				tags: this.retainTags,
				timestamp: sourceTimestamp,
				async: false,
				updateMode,
			});
		} catch (err) {
			// A timed-out or dropped append may already be durable server-side.
			// Retrying the same delta as another append would duplicate it.
			if (appendDelta) this.#forceNextRetainReplace = true;
			throw err;
		}
		if (!retainFullWindow) this.#recordCompletedLastTurnRetain(sessionId, messages);
		if (generation === this.#retainGeneration) {
			if (nextCachedTranscript !== undefined) this.#cachedTranscript = nextCachedTranscript;
			this.#lastRetainedMessageIndex = messages.length;
			this.#lastRetainedPrefixKey = retentionPrefixKey(messages, messages.length);
			this.#forceNextRetainReplace = false;
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		const generation = this.#retainGeneration;
		await this.#scheduleSessionRetain(() => this.#maybeRetainOnAgentEndLocked(generation));
	}

	async #maybeRetainOnAgentEndLocked(generation: number): Promise<void> {
		if (!this.config.autoRetain) return;
		// A queued cadence retain can outlive /resume, /new, or a fork. The
		// generation fence after client.retain only skips the cursor write; this
		// check drops the call before it extracts and sends the replacement
		// session's transcript under the new document id.
		if (generation !== this.#retainGeneration) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (
			userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns &&
			!this.#sessionHistoryDiverged(messages)
		) {
			return;
		}

		try {
			await this.retainSession(messages);
			if (generation === this.#retainGeneration) this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					sessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const generation = this.#retainGeneration;
		await this.#scheduleSessionRetain(async () => {
			// The command belongs to the session active when it was invoked. If it
			// queued behind another retain and the session changed, do not flush or
			// force-retain the replacement transcript.
			if (generation !== this.#retainGeneration) return;
			// Reserve the session-retain barrier before flushing tool items so a
			// concurrent close cannot schedule a duplicate last-turn document.
			await this.flushRetainQueue();
			if (generation !== this.#retainGeneration) return;
			await this.#forceRetainCurrentSessionLocked(generation);
		});
	}

	async #forceRetainCurrentSessionLocked(generation: number): Promise<void> {
		if (generation !== this.#retainGeneration) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		// Forced retains are user-initiated rebuilds (`/memory enqueue`). The
		// incremental cache is dropped inside the serialized retain so an
		// in-flight cadence retain cannot repopulate the cursor and suppress
		// the canonical replace.
		try {
			await this.retainSession(messages, { forceReplace: true });
			if (generation === this.#retainGeneration) {
				this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
			}
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return undefined;

		this.hasRecalledForFirstTurn = true;
		if (!context) return undefined;

		this.lastRecallSnippet = context;
		return context;
	}

	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;

		// Create/ensure the bank BEFORE the first mental-model POST so we don't
		// land `createMentalModel` against a bank the server has never seen —
		// that surfaces as a FK / 404 on Hindsight's side. `ensureBankExists`
		// is idempotent (PUT) and skips after the first call via `banksSet`.
		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);

		// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
		// read-only: we surface whatever models the operator has curated on the
		// bank, but we do NOT POST to create new ones unless they explicitly
		// asked. `/memory mm seed` remains the explicit-write entry point.
		if (this.config.mentalModelAutoSeed) {
			const seeds = resolveSeedsForScope(scope, this.config.scoping);
			if (seeds.length > 0) {
				await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
			}
		}

		await this.refreshMentalModelsSnippet();
		await this.#refreshBaseSystemPromptAfter("MM load");
	}

	async refreshMentalModelsSnippet(): Promise<void> {
		const snippet = await loadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		this.mentalModelsSnippet = snippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		await this.refreshMentalModelsSnippet();
		await this.#refreshBaseSystemPromptAfter("MM reload");
		return true;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// MM TTL refresh: re-list once we're past the cache deadline. List
				// is cheap (no reflect call); the LLM doesn't see this happen.
				if (
					this.config.mentalModelsEnabled &&
					this.mentalModelsLoadedAt !== undefined &&
					Date.now() - this.mentalModelsLoadedAt >= this.config.mentalModelRefreshIntervalMs
				) {
					void this.refreshMentalModelsSnippet().then(async () => {
						await this.#refreshBaseSystemPromptAfter("MM TTL reload");
					});
				}
			}
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeScope?.();
		this.unsubscribeScope = undefined;
		this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(reason: "MM load" | "MM reload" | "MM TTL reload"): Promise<void> {
		try {
			await this.session.refreshBaseSystemPrompt();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
		}
	}
}
