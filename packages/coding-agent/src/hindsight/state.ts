import { logger } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { shortenPath } from "../utils/render-utils";
import { memoryNoticeErrorText } from "../memory-backend/messages";
import { findPersistedRecall, persistRecall } from "../memory-backend/recall-entry";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import { type BankScope, ensureBankExists, type HindsightBankSet } from "./bank";
import type { HindsightClientApi } from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
	tryLoadMentalModelsBlock,
} from "./mental-models";
import { RecallFailureWait, type RecallWait, recallSkippedNotice } from "./recall-wait";
import { countUserTurns, extractMessages, retentionStart } from "./transcript";
import { type DrainResult, HindsightOutbox, type RetainInput } from "./outbox";

/** `notice` source of Hindsight recall/retain failures; print mode writes these to stderr. */
export const HINDSIGHT_NOTICE_SOURCE = "Hindsight";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;
const RETAIN_RETRY_MAX_MS = 30 * 60 * 1000;
const MENTAL_MODEL_LOAD_TIMED_OUT = Symbol("mental-model-load-timed-out");

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}
/**
 * What a subagent alias reads from its parent state: the routing it copies, the snippets
 * the developer prompt shows, and the recall pause it shares. A subagent worker holds a
 * remote implementation whose client, bank set and recall pause are main's live ones.
 */
export interface HindsightSessionStateApi {
	readonly client: HindsightClientApi;
	readonly bankId: string;
	readonly retainTags?: string[];
	readonly recallTags?: string[];
	readonly recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	readonly config: HindsightConfig;
	readonly banksSet: HindsightBankSet;
	readonly lastRecallSnippet?: string;
	readonly mentalModelsSnippet?: string;
	/**
	 * The pause after a failed automatic recall, which this state and its subagent aliases
	 * share. An alias of a parent without one keeps a pause of its own.
	 */
	readonly recallWait?: RecallWait;
}

export interface HindsightSessionStateOptions {
	agentDir?: string;
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightClientApi;
	bankId: string;
	/** Tags on project-scoped retains (transcripts and tool writes) — non-empty in per-project-tagged mode. Global tool writes omit them. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: HindsightBankSet;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
	/**
	 * When set, this entry is a subagent alias that reuses the parent's bank,
	 * scope, config, client, and banksSet. Aliases run no first-turn recall and
	 * no auto-retain — those run on the parent only — and their compaction
	 * recall shares the parent's pause after a failed recall. The
	 * recall/retain/reflect tools resolve via the alias so they persist to the
	 * same bank as the parent.
	 */
	aliasOf?: HindsightSessionStateApi;
}

/**
 * Debounced delivery of tool-initiated `retain` calls owned by one Hindsight
 * session state. Items are persisted in the {@link HindsightOutbox} before
 * `enqueue` resolves; flushes deliver every pending event for this destination,
 * including ones earlier processes left behind.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and already runs `async: true` server-side.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	readonly #agentDir: string;
	#outbox?: HindsightOutbox;
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;
	/** Events this queue published since its last drain started. */
	#pending = 0;
	/** Consecutive drains stopped by a retryable failure; drives the retry backoff. */
	#failures = 0;

	constructor(state: HindsightSessionState, agentDir: string) {
		this.#state = state;
		this.#agentDir = agentDir;
	}

	/** Created on first use: states that never retain touch no disk. */
	#getOutbox(): HindsightOutbox {
		const state = this.#state;
		this.#outbox ??= new HindsightOutbox({
			agentDir: this.#agentDir,
			apiUrl: state.config.hindsightApiUrl!,
			bankId: state.bankId,
			apiToken: state.config.hindsightApiToken,
			client: state.client,
			ensureBank: () => ensureBankExists(state.client, state.bankId, state.config, state.banksSet),
		});
		return this.#outbox;
	}

	/** Resolves once every item is durable; rejects, queueing nothing, when it cannot be. */
	async enqueue(toolCallId: string, items: RetainInput[]): Promise<void> {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		const state = this.#state;
		if (items.some(item => item.scope === "global")) state.assertGlobalRetainAvailable();
		this.#pending += await this.#getOutbox().enqueue(
			{ sessionId: state.sessionId, toolCallId, context: state.config.retainContext, tags: state.retainTags },
			items,
		);
		if (this.#pending >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		this.#schedule(RETAIN_FLUSH_INTERVAL_MS);
	}

	#schedule(delay: number): void {
		if (!this.#closed && !this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.flush();
			}, delay);
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
			// Coalesce: wait for the in-flight drain, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#pending > 0) await this.flush();
			return;
		}

		this.#pending = 0;
		this.#flushing = this.#drain();
		try {
			await this.#flushing;
		} finally {
			this.#flushing = undefined;
		}
	}

	async #drain(): Promise<void> {
		const notice = (message: string) => this.#state.session.emitNotice("warning", message, HINDSIGHT_NOTICE_SOURCE);
		let outbox: HindsightOutbox;
		let result: DrainResult;
		try {
			outbox = this.#getOutbox();
			result = await outbox.drain();
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Hindsight outbox drain failed", { bankId: this.#state.bankId, error: errorText });
			notice(
				`Hindsight outbox unavailable: ${memoryNoticeErrorText(errorText)}. Undelivered memories stay on disk.`,
			);
			this.#schedule(RETAIN_FLUSH_INTERVAL_MS);
			return;
		}
		if (result.quarantined > 0) {
			notice(
				`${result.quarantined} Hindsight ${result.quarantined === 1 ? "memory" : "memories"} moved to ${shortenPath(outbox.quarantineDir)} (refused by the server, malformed, or undelivered for 7 days); review within 30 days.`,
			);
		}
		if (result.error === undefined) {
			this.#failures = 0;
			// Another holder owns this destination (draining it, or enqueueing a batch
			// that may still roll back); events it did not list wait for us.
			if (result.busy) this.#schedule(RETAIN_FLUSH_INTERVAL_MS);
			return;
		}
		logger.warn("Hindsight retain delivery failed", {
			bankId: this.#state.bankId,
			kept: result.kept,
			error: result.error,
		});
		// One notice per outage, not per retry.
		if (++this.#failures === 1) {
			notice(
				`Memory retention failed; ${result.kept} ${result.kept === 1 ? "memory" : "memories"} kept in the Hindsight outbox for retry: ${memoryNoticeErrorText(result.error)}`,
			);
		}
		// Exponential backoff from the debounce interval; ±20% jitter spreads processes sharing an outage.
		const backoff = Math.min(RETAIN_RETRY_MAX_MS, RETAIN_FLUSH_INTERVAL_MS * 2 ** (this.#failures - 1));
		this.#schedule(Math.round(backoff * (0.8 + Math.random() * 0.4)));
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}

/**
 * Rolling hash of messages[0, to) for retention-cache validation (see #lastRetainedPrefixKey),
 * continued from `key` = the rolling hash of messages[0, from).
 */
function extendRetentionPrefixKey(key: string, messages: HindsightMessage[], from: number, to: number): string {
	for (let i = from; i < to; i++) {
		const m = messages[i];
		if (m === undefined) break;
		key = Bun.hash(`${key}\u0000${m.role}\u0000${m.content}\u0000${m.timestamp ?? ""}`).toString(36);
	}
	return key;
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState implements HindsightSessionStateApi {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	client: HindsightClientApi;
	bankId: string;
	/** Tags on project-scoped retains (transcripts and tool writes) — non-empty in per-project-tagged mode. Global tool writes omit them. */
	retainTags?: string[];
	/** Tag filter applied to every recall/reflect — non-empty in per-project-tagged mode. */
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	session: AgentSession;
	banksSet: HindsightBankSet;
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
	/** In-flight transcript retain run; see {@link #requestRetain}. */
	#retainRun?: Promise<void>;
	/** Retain requested while {@link #retainRun} is in flight. */
	#pendingRetain?: "auto" | "forced";
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	#recallGeneration = 0;
	/** Pause after a failed automatic recall (`hindsight.recallCooldownMs`); an alias holds its parent's. */
	readonly recallWait: RecallWait;
	/** The failure record whose first skip this state already announced. */
	#shownFailureId: number | undefined;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the current bootstrap/boundary load settled; gates the first-turn race. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight bootstrap or transcript-boundary load. `beforeAgentStartPrompt`
	 * awaits it on the first turn so a timely snapshot lands before generation,
	 * even though startup and transcript transitions remain non-blocking.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	#mentalModelsLoadGeneration = 0;
	unsubscribe?: () => void;
	/** Alias states delegate persistence config to a primary parent state and share its recall pause. */
	aliasOf?: HindsightSessionStateApi;
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
		this.recallWait = options.aliasOf?.recallWait ?? new RecallFailureWait(this.config.recallCooldownMs);
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.aliasOf = options.aliasOf;
		this.retainQueue = new HindsightRetainQueue(this, options.agentDir ?? getAgentDir());
	}

	setSessionId(sessionId: string): void {
		if (this.sessionId !== sessionId) this.#recallGeneration++;
		this.sessionId = sessionId;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	/**
	 * Whether `scope: "global"` is enabled (`hindsight.globalScope`, off by default) and has a destination every
	 * project recalls: untagged memories in the shared bank. `per-project` scoping recalls only the project's own bank,
	 * so a global write there would never surface. Reads this state's config, which a subagent alias copies from its
	 * parent, so tool exposure and enforcement agree even after the live settings change.
	 */
	isGlobalRetainAvailable(): boolean {
		return this.config.globalScope && this.config.scoping !== "per-project";
	}

	/** Throws, naming the reason, unless {@link isGlobalRetainAvailable}. */
	assertGlobalRetainAvailable(): void {
		if (!this.config.globalScope) {
			throw new Error("Hindsight global scope is off; set hindsight.globalScope to true to enable it.");
		}
		if (this.config.scoping === "per-project") {
			throw new Error("Hindsight global scope requires global or per-project-tagged scoping.");
		}
	}

	/** Queues a tool-initiated retain; `scope: "global"` retains it untagged (see {@link assertGlobalRetainAvailable}). */
	async enqueueRetain(toolCallId: string, items: RetainInput[]): Promise<void> {
		await this.retainQueue.enqueue(toolCallId, items);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	/**
	 * The automatic recall, of the first turn and of compaction. It records the outcome in
	 * {@link recallWait}: an answer ends the pause. A failure of the current generation starts
	 * a pause, or a doubled one when an earlier pause has ended; a failure while a pause runs
	 * changes nothing. An aborted recall and a stale failure record nothing. The `recall` tool
	 * calls the client directly and does not use it.
	 */
	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		const generation = this.#recallGeneration;
		let context: string | null = null;
		try {
			const response = await this.client.recall(this.bankId, query, {
				budget: this.config.recallBudget,
				maxTokens: this.config.recallMaxTokens,
				types: this.config.recallTypes.length > 0 ? this.config.recallTypes : undefined,
				tags: this.recallTags,
				tagsMatch: this.recallTagsMatch,
				signal,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length > 0) {
				const formatted = formatMemories(results);
				context = `<memories>\n${this.config.recallPromptPreamble}\n\n${formatted}\n</memories>`;
			}
		} catch (err) {
			// A cancelled turn (Esc) is not a failure.
			if (signal?.aborted) return { context: null, ok: false };
			const errorText = err instanceof Error ? err.message : String(err);
			// A conversation reset or session switch since the request makes its failure stale.
			const failure = this.#recallGeneration === generation ? memoryNoticeErrorText(errorText) : undefined;
			const retryAt = failure !== undefined ? this.recallWait.record({ ok: false, failure }) : undefined;
			const retryAfter = retryAt !== undefined ? new Date(retryAt).toISOString() : undefined;
			logger.warn("Hindsight: recall failed", { bankId: this.bankId, error: errorText, retryAfter });
			if (failure !== undefined) {
				this.session.emitNotice("warning", `Memory recall failed: ${failure}`, HINDSIGHT_NOTICE_SOURCE);
			}
			return { context: null, ok: false };
		}
		// Outside the `try`, so nothing the record does reads as a failed recall.
		this.recallWait.record({ ok: true });
		return { context, ok: true };
	}

	/**
	 * Whether an automatic recall waits out a recent failure. The first skip of each failure
	 * record logs and notifies in this state's session, later ones stay quiet; an alias
	 * shares the record but announces its first skip in its own session.
	 */
	#skipRecallAfterFailure(): boolean {
		const skip = this.recallWait.skip();
		if (!skip) return false;
		if (skip.failure.id !== this.#shownFailureId) {
			const now = Date.now();
			const cause = skip.failure.error;
			logger.warn("Hindsight: recall skipped after a recent failure", {
				bankId: this.bankId,
				failedAt: new Date(skip.failure.at).toISOString(),
				retryAfter: new Date(skip.retryAt).toISOString(),
				failures: skip.failure.failures,
				error: cause,
			});
			this.session.emitNotice("warning", recallSkippedNotice(skip.retryAt, cause, now), HINDSIGHT_NOTICE_SOURCE);
			this.#shownFailureId = skip.failure.id;
		}
		return true;
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

	async retainSession(messages: HindsightMessage[]): Promise<void> {
		const retainedAt = new Date();
		const sourceTimestamp = this.#sessionSourceTimestamp() ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;
		let prefixKey = "";
		let hashedThrough = 0;

		if (retainFullWindow) {
			documentId = this.sessionId;
			const boundary = this.#lastRetainedMessageIndex;
			if (boundary <= messages.length) prefixKey = extendRetentionPrefixKey("", messages, 0, boundary);
			if (boundary > messages.length || prefixKey !== this.#lastRetainedPrefixKey) {
				this.#lastRetainedMessageIndex = 0;
				this.#cachedTranscript = "";
				this.#lastRetainedPrefixKey = "";
				prefixKey = "";
			}
			hashedThrough = this.#lastRetainedMessageIndex;
			const newMessages = messages.slice(hashedThrough);
			const { transcript: newPart } = prepareRetentionTranscript(newMessages, true, { includeTimestamps: true });
			if (!newPart) return;
			nextCachedTranscript = this.#cachedTranscript ? `${this.#cachedTranscript}\n\n${newPart}` : newPart;
			transcript = nextCachedTranscript;
		} else {
			const windowTurns = this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			const target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${this.sessionId}-${retainedAt.getTime()}`;
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(target, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);
		await this.client.retain(this.bankId, transcript, {
			documentId,
			context: this.config.retainContext,
			metadata: { session_id: this.sessionId },
			tags: this.retainTags,
			timestamp: sourceTimestamp,
			async: true,
		});
		if (nextCachedTranscript !== undefined) {
			this.#cachedTranscript = nextCachedTranscript;
			// prefixKey hashes [0, hashedThrough) of this same snapshot; extend it instead of rehashing from 0.
			this.#lastRetainedPrefixKey = extendRetentionPrefixKey(prefixKey, messages, hashedThrough, messages.length);
			this.#lastRetainedMessageIndex = messages.length;
		}
	}

	/**
	 * Single-flight entry for transcript retains. At most one retain runs per session;
	 * requests arriving meanwhile coalesce into one follow-up that re-reads the session
	 * when it starts, so it carries the latest turns. A forced request wins over a
	 * pending auto one. Resolves once the queue drains.
	 */
	#requestRetain(forced: boolean): Promise<void> {
		this.#pendingRetain = forced || this.#pendingRetain === "forced" ? "forced" : "auto";
		// #drainRetains always awaits before returning, so its `finally` cannot clear
		// #retainRun before this assignment lands.
		this.#retainRun ??= this.#drainRetains();
		return this.#retainRun;
	}

	async #drainRetains(): Promise<void> {
		try {
			while (this.#pendingRetain) {
				const kind = this.#pendingRetain;
				this.#pendingRetain = undefined;
				if (kind === "forced") await this.#forceRetain();
				else await this.#retainIfDue();
			}
		} finally {
			this.#retainRun = undefined;
		}
	}

	async #retainIfDue(): Promise<void> {
		if (!this.config.autoRetain) return;
		// Cheap gate first: most turn ends are not retain turns, so skip text extraction.
		const manager = this.session.sessionManager;
		const entries = manager.getEntries();
		const start = retentionStart(entries, manager.getHeader?.());
		const userTurns = countUserTurns(entries, start);
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;
		const messages = extractMessages(entries, start);
		if (messages.length === 0) return;

		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					providerSessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				providerSessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	/** `/memory enqueue`: rebuild retention for the current session, after any in-flight retain settles. */
	forceRetainCurrentSession(): Promise<void> {
		return this.#requestRetain(true);
	}

	async #forceRetain(): Promise<void> {
		const manager = this.session.sessionManager;
		const entries = manager.getEntries();
		const messages = extractMessages(entries, retentionStart(entries, manager.getHeader?.()));
		if (messages.length === 0) return;
		// Forced retains are user-initiated rebuilds (`/memory enqueue`): drop the
		// incremental cache so the full transcript is reformatted and resent even
		// when no new messages arrived since the last auto-retain — otherwise a
		// rebuild could never recover an upstream document that was deleted or a
		// previous async retain that never materialized.
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				providerSessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		const generation = ++this.#recallGeneration;
		// Reuse this transcript's recall so a resumed session sends the same prompt. Hindsight
		// memories cannot be looked up by id, so changes since are not reported.
		const persisted = findPersistedRecall(this.session.sessionManager, this.#recallScope());
		if (persisted !== undefined) {
			return {
				context: persisted.text || undefined,
				commit: () => this.#commitRecall(generation, persisted.text, false),
			};
		}
		if (this.#skipRecallAfterFailure()) return undefined;

		const history = extractMessages(this.session.sessionManager.getEntries());
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated, signal);
		if (!ok) return undefined;

		return {
			context: context ?? undefined,
			commit: () => this.#commitRecall(generation, context ?? "", true),
		};
	}

	/** Adopts a first-turn recall unless a newer turn or reset superseded it; `""` means it found nothing. */
	#commitRecall(generation: number, context: string, persist: boolean): boolean {
		if (this.#recallGeneration !== generation) return false;
		this.hasRecalledForFirstTurn = true;
		if (context) this.lastRecallSnippet = context;
		if (persist) persistRecall(this.session.sessionManager, this.#recallScope(), { text: context, memories: [] });
		return true;
	}

	/**
	 * Identifies the server, account, bank and tag filter a recall reads, so a persisted
	 * recall is only reused for the same ones. The account is a hash of the API token.
	 */
	#recallScope(): string {
		return JSON.stringify([
			"hindsight",
			this.config.hindsightApiUrl,
			Bun.hash(this.config.hindsightApiToken ?? "").toString(16),
			this.bankId,
			this.recallTags ?? [],
			this.recallTagsMatch ?? null,
		]);
	}

	async recallForCompaction(messages: HindsightMessage[], signal?: AbortSignal): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;
		if (this.#skipRecallAfterFailure()) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated, signal);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;

		const bootstrap = (async () => {
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

			await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM load");
		})();
		await this.#settleMentalModelsLoadWithinDeadline(bootstrap, generation, previousSnippet);
	}

	/**
	 * Starts a bounded reload for a new transcript without blocking the session
	 * transition. A result that misses the first-turn deadline is discarded so
	 * the previous snapshot stays frozen for the whole transcript.
	 */
	beginMentalModelsTranscriptReload(): void {
		if (!this.config.mentalModelsEnabled) return;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		this.mentalModelsLoadedAt = undefined;
		const reload = this.#settleMentalModelsLoadWithinDeadline(
			this.#loadAndPublishMentalModels(generation, previousSnippet, "MM transcript reload"),
			generation,
			previousSnippet,
		).catch(error => {
			if (generation === this.#mentalModelsLoadGeneration) {
				this.mentalModelsSnippet = previousSnippet;
				this.mentalModelsLoadedAt = Date.now();
			}
			logger.debug("Hindsight: mental-model transcript reload failed", { error: String(error) });
		});
		this.mentalModelsLoadPromise = reload;
	}

	async #settleMentalModelsLoadWithinDeadline(
		load: Promise<void>,
		generation: number,
		previousSnippet: string | undefined,
	): Promise<void> {
		const outcome = await Promise.race([
			load,
			Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS).then(() => MENTAL_MODEL_LOAD_TIMED_OUT),
		]);
		if (outcome !== MENTAL_MODEL_LOAD_TIMED_OUT || generation !== this.#mentalModelsLoadGeneration) return;

		// Invalidate the still-running load before restoring the stable snapshot.
		// SessionTools checks the same generation before committing a prompt build,
		// so a queued publication cannot rewrite the prefix after this deadline.
		this.#mentalModelsLoadGeneration++;
		this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async #loadAndPublishMentalModels(
		generation: number,
		previousSnippet: string | undefined,
		reason: "MM load" | "MM reload" | "MM transcript reload",
	): Promise<void> {
		const result = await tryLoadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!result.ok) {
			this.mentalModelsLoadedAt = Date.now();
			return;
		}

		this.mentalModelsSnippet = result.block;
		const published = await this.#refreshBaseSystemPromptAfter(
			reason,
			() => generation === this.#mentalModelsLoadGeneration,
		);
		if (generation !== this.#mentalModelsLoadGeneration) return;
		if (!published) this.mentalModelsSnippet = previousSnippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.aliasOf) return false;
		if (!this.config.mentalModelsEnabled) return false;
		const generation = ++this.#mentalModelsLoadGeneration;
		const previousSnippet = this.mentalModelsSnippet;
		await this.#loadAndPublishMentalModels(generation, previousSnippet, "MM reload");
		return generation === this.#mentalModelsLoadGeneration;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			// The run's `agent_end` waits until no job, child agent or peer can resume it;
			// a yielded pause is the model finishing its turn while such work keeps the run
			// open. Non-yielded pauses continue the model's own work (retry, compaction).
			if (event.type === "agent_end" || (event.type === "agent_pause" && event.yielded)) {
				void this.#requestRetain(false);
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// Mental models are deliberately NOT re-listed here. Rewriting the
				// cached <mental_models> block mid-session changes the base system
				// prompt bytes and busts the provider prompt-cache prefix (#11961).
				// The block is frozen for the current transcript — like local-memory
				// guidance after #3745 — so a background reflect applies when the
				// next transcript/session boundary reloads it. `/memory mm reload`
				// stays the explicit in-session invalidation.
			}
		});
	}

	dispose(): void {
		this.#recallGeneration++;
		this.#mentalModelsLoadGeneration++;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(
		reason: "MM load" | "MM reload" | "MM transcript reload",
		commitIf?: () => boolean,
	): Promise<boolean> {
		try {
			await this.session.refreshBaseSystemPrompt(commitIf);
			return !commitIf || commitIf();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
			return false;
		}
	}
}
