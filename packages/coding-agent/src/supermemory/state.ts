import * as path from "node:path";
import { escapeXmlText, logger, prompt, truncate } from "@oh-my-pi/pi-utils";
import { redactMemorySecrets } from "../memory-backend/redact";
import { type HindsightMessage, prepareRetentionTranscript } from "../hindsight/content";
import { countUserTurns, extractMessages } from "../hindsight/transcript";
import {
	cleanOutboxText,
	MemoryOutbox,
	type MemoryOutboxEvent,
	MemoryOutboxQueue,
	type OutboxSendOutcome,
	outboxEventId,
	sendFailure,
} from "../memory-backend/outbox";
import { findPersistedRecall, persistRecall } from "../memory-backend/recall-entry";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import recallTemplate from "../prompts/system/supermemory-recall.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import {
	type SupermemoryClient,
	type SupermemoryDocument,
	type SupermemoryForgetResult,
	SupermemoryHttpError,
	type SupermemorySearchItem,
} from "./client";
import type { ConfiguredSupermemoryConfig } from "./config";

/** `notice` source of Supermemory failures. */
export const SUPERMEMORY_NOTICE_SOURCE = "Supermemory";

const MAX_RECALL_QUERY_CHARS = 1_000;
const MAX_RECALL_ITEM_CHARS = 1_000;
/** Budget for the escaped lines of one recall block, split evenly between profile and search results. */
const MAX_RECALL_CHARS = 8_000;
/** Automatic retention keeps the newest part of a longer window. */
const MAX_RETAIN_CHARS = 60_000;
const DISPOSE_FLUSH_TIMEOUT_MS = 2_000;
/** Custom transcript entry recording how far automatic retention got; see {@link SupermemorySessionState}. */
const RETENTION_CURSOR_ENTRY_TYPE = "supermemory_retention";
/** Custom transcript entry recording a `/memory clear`, so a resume does not restore the cleared recall. */
const RECALL_CLEAR_ENTRY_TYPE = "supermemory_recall_clear";

/** A tool-initiated write in `<agentDir>/supermemory-outbox/<destination>/`; `id` is its document id. */
interface SupermemoryOutboxEvent extends MemoryOutboxEvent {
	content: string;
	metadata: Record<string, string>;
}

/** One `retain` item or `learn` lesson. */
export interface SupermemoryRetainInput {
	content: string;
	context?: string;
	/** Tool that wrote it, stored as `metadata.source`. */
	source: string;
}

interface RetentionCursorData {
	version: 1;
	/** Server, account and namespace (see `#scope`); a cursor only applies to the same ones. */
	scope: string;
	/** Transcript the turns were counted in; a branched copy has a new id and must not adopt it. */
	transcriptId: string;
	/** User turns `[0, turn)` are retained. */
	turn: number;
	/** Messages covered by the last retained window; a manual continuation that adds an answer without a user turn grows past it. */
	messages: number;
	/** First user turn of the last retained window, so a continuation re-sends that window's document id under any cadence. */
	windowStart: number;
}

/** Transcript messages captured for one retention job, with the identity they belong to. */
interface SettledHistory {
	messages: HindsightMessage[];
	/** The last turn is unfinished (no answer, or an aborted/errored one): bare resume or `/retry` completes it without a new user turn. */
	openTail: boolean;
	generation: number;
	transcriptId: string;
}

/** A write through a state that was disposed (e.g. a subagent's alias after a settings change). */
function closedError(): Error {
	return new Error("Supermemory state is closed after a settings change; memory NOT stored. Restart the subagent.");
}

/**
 * Outcome of a failed write. On the v5 write routes a namespace needs no prior creation, so 404
 * means the route itself is gone, and 410 Gone says so outright: both are as permanent as a
 * refused body, so they quarantine instead of retrying for days. Mapped here, not in the shared
 * `sendFailure`, which Hindsight also uses.
 */
function writeFailure(error: unknown): OutboxSendOutcome {
	const status = error instanceof SupermemoryHttpError ? error.status : undefined;
	return status === 404 || status === 410 ? "rejected" : sendFailure(error, status);
}

function isRetentionCursor(data: unknown): data is RetentionCursorData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"transcriptId" in data &&
		typeof data.transcriptId === "string" &&
		"turn" in data &&
		Number.isSafeInteger(data.turn) &&
		"messages" in data &&
		Number.isSafeInteger(data.messages) &&
		"windowStart" in data &&
		Number.isSafeInteger(data.windowStart)
	);
}

export interface SupermemorySessionStateOptions {
	session: AgentSession;
	client: SupermemoryClient;
	config: ConfiguredSupermemoryConfig;
	namespace: string;
	/** False for subagents: the tools work, automatic recall and retention never run. */
	automatic: boolean;
	/** Holds `supermemory-outbox/`. */
	agentDir: string;
}

/** A subagent's alias of its parent's state; see {@link SupermemorySessionState.aliasOf}. */
export interface SupermemoryAliasOptions {
	session: AgentSession;
	aliasOf: SupermemorySessionStateApi;
}

/**
 * What a subagent alias routes to its parent: namespace, recall snippet, and every
 * tool read, write and edit. A subagent worker holds a remote implementation whose calls run
 * on main's state, so writes land in the parent's outbox.
 */
export interface SupermemorySessionStateApi {
	readonly namespace: string;
	readonly aliasOf?: SupermemorySessionStateApi;
	readonly lastRecallSnippet?: string;
	search(query: string, limit: number | undefined, signal?: AbortSignal): Promise<SupermemorySearchItem[]>;
	enqueueRetain(toolCallId: string, items: SupermemoryRetainInput[]): Promise<void>;
	save(
		content: string,
		metadata: Record<string, string | number | boolean>,
		id?: string,
	): Promise<SupermemoryDocument>;
	forgetMemory(id: string, signal?: AbortSignal): Promise<SupermemoryForgetResult>;
}

/** Config, client and outbox a primary state owns. */
interface SupermemoryOwnResources {
	config: ConfiguredSupermemoryConfig;
	client: SupermemoryClient;
	outbox: MemoryOutboxQueue<SupermemoryOutboxEvent, SupermemoryRetainInput>;
}

/** Escaped bullet lines for `items` within `budget` chars; an item that does not fit is skipped, not the rest. */
function renderLines(items: readonly string[], budget: number): string {
	const lines: string[] = [];
	let remaining = budget;
	for (const item of items) {
		const line = `- ${escapeXmlText(truncate(item.trim(), MAX_RECALL_ITEM_CHARS))}`;
		if (line.length > remaining) continue;
		remaining -= line.length + 1;
		lines.push(line);
	}
	return lines.join("\n");
}

/** Per-session Supermemory runtime state owned by its AgentSession. */
export class SupermemorySessionState implements SupermemorySessionStateApi {
	readonly session: AgentSession;
	readonly namespace: string;
	readonly automatic: boolean;
	/**
	 * Parent state of a subagent alias: every tool read, write and edit runs there (its namespace,
	 * outbox and notices). An alias never auto-recalls, auto-retains, or writes retention cursors.
	 */
	readonly aliasOf?: SupermemorySessionStateApi;
	lastRecallSnippet?: string;
	hasRecalledForFirstTurn = false;
	/** User turns already covered by automatic retention documents. */
	lastRetainedTurn = 0;
	/** Messages covered by the last retained window (see {@link RetentionCursorData.messages}). */
	#retainedMessages = 0;
	/** First user turn of the last retained window (see {@link RetentionCursorData.windowStart}). */
	#windowStart = 0;
	readonly #writes = new Set<Promise<unknown>>();
	/** Config, client and outbox of a primary state; an alias has none. */
	readonly #own: SupermemoryOwnResources | undefined;
	#retention: Promise<void> = Promise.resolve();
	/** Set once {@link dispose} returns; retention queued behind a slow upload must not run against the session's next transcript. */
	#disposed = false;
	#recallGeneration = 0;
	/** Bumped when the transcript changes identity; stale retention never advances {@link lastRetainedTurn}. */
	#transcriptGeneration = 0;
	/** Whether this transcript already holds a retention cursor for {@link #scope}. */
	#hasCursor = false;
	#unsubscribe?: () => void;

	constructor(options: SupermemorySessionStateOptions | SupermemoryAliasOptions) {
		this.session = options.session;
		if ("aliasOf" in options) {
			this.aliasOf = options.aliasOf;
			this.namespace = options.aliasOf.namespace;
			this.automatic = false;
			return;
		}
		const { client, config } = options;
		this.namespace = options.namespace;
		this.automatic = options.automatic;
		const outbox = new MemoryOutboxQueue<SupermemoryOutboxEvent, SupermemoryRetainInput>({
			label: "Supermemory",
			destination: this.namespace,
			// One document per request: drain as soon as a write lands.
			flushBatchSize: 1,
			notice: message => this.session.emitNotice("warning", message, SUPERMEMORY_NOTICE_SOURCE),
			toEvents: (toolCallId, items) => {
				const key = config.apiKey;
				const sessionId = cleanOutboxText(this.transcriptId, key);
				return items.map((item, index) => {
					const content = cleanOutboxText(item.content, key);
					const metadata: Record<string, string> = { source: item.source, sessionId };
					if (item.context) metadata.context = cleanOutboxText(item.context, key);
					// Tool call ids are not guaranteed unique: a reused id with new content is a new document.
					const id = outboxEventId([sessionId, toolCallId, index, content, metadata]);
					return { version: 1, id, content, metadata };
				});
			},
			createOutbox: () =>
				new MemoryOutbox<SupermemoryOutboxEvent>({
					root: path.join(options.agentDir, "supermemory-outbox"),
					apiUrl: config.baseUrl,
					// Account too: a write queued under one key is never delivered with another.
					container: this.#scope(),
					label: "Supermemory",
					isEvent: event =>
						typeof event.content === "string" &&
						typeof event.metadata === "object" &&
						event.metadata !== null &&
						Object.values(event.metadata).every(value => typeof value === "string"),
					send: async ([event]) => {
						try {
							await client.addDocument(this.namespace, {
								content: event.content,
								id: event.id,
								metadata: event.metadata,
							});
							return "accepted";
						} catch (error) {
							return writeFailure(error);
						}
					},
				}),
		});
		this.#own = { config, client, outbox };
		this.#resumeRetention();
	}

	/**
	 * Resumes automatic retention at this transcript's latest retention cursor, so a window that
	 * failed or was cut by the dispose timeout is retried; its document id makes the retry add to the
	 * same document. A transcript without a cursor predates them: its complete windows are assumed
	 * retained and retention starts at the open window, so resuming an old session never bulk-uploads
	 * it. An open window keeps its start-based document id, so completing it later re-sends a superset
	 * into that document.
	 */
	#resumeRetention(): void {
		const scope = this.#scope();
		const cursor = this.session.sessionManager
			.getEntries()
			.findLast(
				entry =>
					entry.type === "custom" &&
					entry.customType === RETENTION_CURSOR_ENTRY_TYPE &&
					isRetentionCursor(entry.data) &&
					entry.data.scope === scope &&
					entry.data.transcriptId === this.transcriptId,
			);
		this.#hasCursor = cursor?.type === "custom" && isRetentionCursor(cursor.data);
		if (cursor?.type === "custom" && isRetentionCursor(cursor.data)) {
			this.lastRetainedTurn = cursor.data.turn;
			this.#retainedMessages = cursor.data.messages;
			this.#windowStart = cursor.data.windowStart;
			return;
		}
		const every = this.#config.retainEveryNTurns;
		this.lastRetainedTurn = Math.floor(countUserTurns(this.session.sessionManager) / every) * every;
		this.#retainedMessages = 0;
		this.#windowStart = this.lastRetainedTurn;
	}

	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.#transcriptGeneration++;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#resumeRetention();
	}

	attachSessionListeners(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (!this.automatic) return;
		this.#unsubscribe = this.session.subscribe(event => {
			if (
				(event.type === "agent_start" || event.type === "agent_end") &&
				this.#config.autoRetain &&
				!this.#hasCursor
			) {
				// Record where retention starts before any upload: a transcript without a cursor reads as
				// pre-cursor on resume, which skips every turn it already holds.
				this.#appendCursor(this.lastRetainedTurn, this.#retainedMessages, this.#windowStart);
			}
			if (event.type !== "agent_end") return;
			// A non-terminal settle is followed by the agent's own continuation; closing the window now
			// would leave that continuation's answer out of every window.
			if (this.#config.autoRetain && event.isTerminal !== false) {
				// Snapshot the settled history now: a job queued behind a slow upload must not read a
				// turn that started afterwards and close its window before the answer exists.
				// Every terminal settle: a manual continuation can extend the last window without a user turn.
				const settled = this.#settledHistory();
				void this.#enqueueRetention(() => this.#retainDue(settled));
			}
			void this.drainOutbox();
		});
	}

	/** Persisted transcript id; survives resume, unlike the provider session id. */
	get transcriptId(): string {
		return this.session.sessionManager.getSessionId();
	}

	/** This state's config, client and outbox; an alias routes through {@link aliasOf} before reaching here. */
	#local(): SupermemoryOwnResources {
		if (this.#own) return this.#own;
		throw new Error("A Supermemory subagent alias has no client or outbox; use its parent state.");
	}

	get #config(): ConfiguredSupermemoryConfig {
		return this.#local().config;
	}

	/** Strips the API key and recognizable secrets from text bound for the server. */
	#redact(text: string): string {
		return redactMemorySecrets(text.replaceAll(this.#config.apiKey, "[REDACTED]"));
	}

	/**
	 * Persists one tool call's items, all or none, before resolving, then starts delivering
	 * them. A retried call has the same event ids, so it neither queues nor uploads twice.
	 */
	async enqueueRetain(toolCallId: string, items: SupermemoryRetainInput[]): Promise<void> {
		if (this.aliasOf) return this.aliasOf.enqueueRetain(toolCallId, items);
		await this.#local().outbox.enqueue(toolCallId, items);
	}

	/** Delivers this destination's outbox, including events earlier processes left; tracked so {@link flush} awaits it. */
	drainOutbox(): Promise<void> {
		return this.#track(this.#local().outbox.flush());
	}

	/** Stores one document in this state's namespace (redacted); tracked so {@link flush} awaits it. */
	save(
		content: string,
		metadata: Record<string, string | number | boolean>,
		id?: string,
	): Promise<SupermemoryDocument> {
		if (this.aliasOf) return this.aliasOf.save(content, metadata, id);
		if (this.#disposed) return Promise.reject(closedError());
		return this.#track(
			this.#local().client.addDocument(this.namespace, {
				content: this.#redact(content),
				id,
				metadata: Object.fromEntries(
					Object.entries(metadata).map(([key, value]) => [
						key,
						typeof value === "string" ? this.#redact(value) : value,
					]),
				),
			}),
		);
	}

	/** `memory_edit`: soft-forgets memory `id` in this state's namespace; tracked so {@link flush} awaits it. */
	forgetMemory(id: string, signal?: AbortSignal): Promise<SupermemoryForgetResult> {
		if (this.aliasOf) return this.aliasOf.forgetMemory(id, signal);
		if (this.#disposed) return Promise.reject(closedError());
		return this.#track(this.#local().client.forgetMemories(this.namespace, [id], signal));
	}

	async search(query: string, limit: number | undefined, signal?: AbortSignal): Promise<SupermemorySearchItem[]> {
		if (this.aliasOf) return this.aliasOf.search(query, limit, signal);
		const config = this.#config;
		const resultLimit = Math.max(1, Math.min(limit ?? config.recallLimit, config.recallLimit));
		const results = await this.#local().client.search(
			this.namespace,
			{
				query: this.#redact(query),
				searchMode: config.searchMode,
				// The search API rejects limit < 2; ask for at least 2 and trim locally.
				limit: Math.max(2, resultLimit),
				threshold: config.threshold,
			},
			signal,
		);
		return results.slice(0, resultLimit);
	}

	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (!this.automatic || !this.#config.autoRecall || this.hasRecalledForFirstTurn) return undefined;
		const query = promptText.trim();
		if (!query) return undefined;
		const generation = ++this.#recallGeneration;
		// Reuse this transcript's recall so a resumed session sends the same prompt bytes.
		const persisted = findPersistedRecall(this.session.sessionManager, this.#recallScope());
		if (persisted !== undefined) {
			return {
				context: persisted.text || undefined,
				commit: () => this.#commitRecall(generation, persisted.text, false),
			};
		}

		const [profile, memories] = await Promise.allSettled([
			this.#local().client.profile(this.namespace, signal),
			// Redact before cutting, as for retention: a cut inside a token defeats the redactor.
			this.search(this.#redact(query).slice(0, MAX_RECALL_QUERY_CHARS), undefined, signal),
		]);
		if (signal?.aborted || generation !== this.#recallGeneration) return undefined;
		if (profile.status === "rejected" && memories.status === "rejected") {
			const error = String(profile.reason instanceof Error ? profile.reason.message : profile.reason);
			logger.warn("Supermemory: recall failed", { error });
			this.session.emitNotice("warning", `Memory recall failed: ${error}`, SUPERMEMORY_NOTICE_SOURCE);
			return undefined;
		}
		if (profile.status === "rejected" || memories.status === "rejected") {
			logger.warn("Supermemory: partial recall", {
				profile: profile.status === "rejected" ? String(profile.reason) : "ok",
				search: memories.status === "rejected" ? String(memories.reason) : "ok",
			});
		}

		const half = MAX_RECALL_CHARS / 2;
		const facts = profile.status === "fulfilled" ? [...profile.value.static, ...profile.value.dynamic] : [];
		const found = memories.status === "fulfilled" ? memories.value.map(item => item.content) : [];
		const text = prompt
			.render(recallTemplate, { profile: renderLines(facts, half), memories: renderLines(found, half) })
			.trim();
		return {
			context: text || undefined,
			commit: () => this.#commitRecall(generation, text, true),
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
	 * `/memory clear`: drop the cached recall, and record the clear so a resumed session asks the
	 * server again instead of restoring the cleared block from the transcript.
	 */
	clearRecall(): void {
		this.lastRecallSnippet = undefined;
		// Revokes a recall still in flight or staged but not yet committed.
		this.#recallGeneration++;
		if (this.aliasOf) return;
		this.session.sessionManager.appendCustomEntry(RECALL_CLEAR_ENTRY_TYPE, { version: 1, scope: this.#scope() });
	}

	/** Recall scope: {@link #scope} plus how many times `/memory clear` ran on this branch. */
	#recallScope(): string {
		const scope = this.#scope();
		const clears = this.session.sessionManager
			.getBranch()
			.filter(
				entry =>
					entry.type === "custom" &&
					entry.customType === RECALL_CLEAR_ENTRY_TYPE &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"scope" in entry.data &&
					entry.data.scope === scope,
			).length;
		return clears === 0 ? scope : JSON.stringify([scope, clears]);
	}

	/** Server, account (hashed key) and namespace; a persisted recall or retention cursor applies only to the same ones. */
	#scope(): string {
		return JSON.stringify([
			"supermemory",
			this.#config.baseUrl,
			Bun.hash(this.#config.apiKey).toString(16),
			this.namespace,
		]);
	}

	/** `/memory enqueue`: retain every due window, then the unretained tail. */
	async forceRetainCurrentSession(): Promise<void> {
		await this.#enqueueRetention(async () => {
			const history = this.#settledHistory();
			await this.#retainDue(history);
			const { messages } = history;
			const userStarts = userTurnStarts(messages);
			// Only a genuine partial tail: if a complete window failed above, uploading everything
			// after it as one document would truncate it and skip those windows for good.
			const open = userStarts.length - this.lastRetainedTurn;
			if (open > 0 && open < this.#config.retainEveryNTurns) {
				await this.#retainWindow(messages, userStarts, this.lastRetainedTurn, userStarts.length, history);
			}
		});
	}

	/** The transcript as it stands now, bound to its identity so a later `/new` or reset discards it. */
	#settledHistory(): SettledHistory {
		const messages = extractMessages(this.session.sessionManager);
		return {
			messages,
			openTail: messages.at(-1)?.role === "user" || this.#lastTurnUnfinished(),
			generation: this.#transcriptGeneration,
			transcriptId: this.transcriptId,
		};
	}

	#lastTurnUnfinished(): boolean {
		const entries = this.session.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") return false;
			if (entry.message.role === "assistant") {
				return entry.message.stopReason === "aborted" || entry.message.stopReason === "error";
			}
		}
		return false;
	}

	/** Every complete `retainEveryNTurns` window of `history` not stored yet, oldest first. */
	async #retainDue(history: SettledHistory): Promise<void> {
		if (this.#disposed) return;
		const every = this.#config.retainEveryNTurns;
		const { messages } = history;
		const userStarts = userTurnStarts(messages);
		// An unfinished last turn stays open: a bare resume or `/retry` completes it without adding a
		// user turn, so closing it now would leave the finished answer out of every window.
		const settledTurns = history.openTail ? userStarts.length - 1 : userStarts.length;
		while (settledTurns - this.lastRetainedTurn >= every) {
			const start = this.lastRetainedTurn;
			if (!(await this.#retainWindow(messages, userStarts, start, start + every, history))) return;
		}
		// A continuation (`.`/`c`) answered after the last full window without a new user turn:
		// re-send that window under its document id so the answer is added to it.
		if (
			!history.openTail &&
			settledTurns === this.lastRetainedTurn &&
			this.lastRetainedTurn > this.#windowStart &&
			messages.length > this.#retainedMessages
		) {
			await this.#retainWindow(messages, userStarts, this.#windowStart, this.lastRetainedTurn, history);
		}
	}

	/** Sends user turns `[startTurn, endTurn)` under the window's document id; resolves whether {@link lastRetainedTurn} advanced. */
	async #retainWindow(
		messages: HindsightMessage[],
		userStarts: number[],
		startTurn: number,
		endTurn: number,
		identity: Omit<SettledHistory, "messages">,
	): Promise<boolean> {
		// A late reply, or a job queued before `/new` or a reset, must not record its window
		// against the session's next transcript.
		const { generation, transcriptId } = identity;
		if (this.#disposed || generation !== this.#transcriptGeneration || transcriptId !== this.transcriptId) {
			return false;
		}
		const window = messages.slice(userStarts[startTurn], userStarts[endTurn] ?? messages.length);
		const { transcript: raw } = prepareRetentionTranscript(window, true, { includeTimestamps: true });
		// Redact the whole window before cutting it: a cut right after a secret's prefix (`ghp_`) would
		// leave a suffix the redactor no longer recognizes.
		const transcript = raw ? this.#redact(raw) : raw;
		if (transcript) {
			// Before this transcript's first send, record where retention starts: without it, a
			// resume after a failed or cut-off first window would read the transcript as pre-cursor
			// and skip that window.
			if (!this.#hasCursor) this.#appendCursor(startTurn, userStarts[startTurn] ?? 0, startTurn);
			const omittedChars = Math.max(0, transcript.length - MAX_RETAIN_CHARS);
			try {
				await this.save(
					omittedChars > 0 ? transcript.slice(omittedChars) : transcript,
					{
						source: "omp-conversation",
						sessionId: this.transcriptId,
						turnStart: startTurn,
						turnEnd: endTurn,
						...(omittedChars > 0 ? { transcriptTruncated: true, omittedChars } : {}),
					},
					this.#windowDocumentId(startTurn),
				);
			} catch (error) {
				if (writeFailure(error) !== "rejected") {
					logger.warn("Supermemory: auto-retain failed", { error: String(error) });
					return false;
				}
				// Refused for good: retrying it forever would block every later window.
				const status = error instanceof SupermemoryHttpError ? error.status : undefined;
				logger.warn("Supermemory: auto-retain refused", { error: String(error) });
				this.session.emitNotice(
					"warning",
					`Memory retention skipped turns ${startTurn + 1}-${endTurn}: the server refused them (HTTP ${status}).`,
					SUPERMEMORY_NOTICE_SOURCE,
				);
			}
		}
		if (this.#disposed || generation !== this.#transcriptGeneration || transcriptId !== this.transcriptId) {
			return false;
		}
		// A `/memory enqueue` tail is an open window: it stays the next window's start, so a later
		// enqueue or the completed window re-sends a superset into the same document.
		// Re-sending an already retained window (`endTurn === lastRetainedTurn`) refreshes its cursor whatever its size.
		if (endTurn - startTurn < this.#config.retainEveryNTurns && endTurn > this.lastRetainedTurn) return true;
		this.lastRetainedTurn = endTurn;
		this.#windowStart = startTurn;
		this.#retainedMessages = userStarts[endTurn] ?? messages.length;
		this.#appendCursor(endTurn, this.#retainedMessages, startTurn);
		return true;
	}

	#appendCursor(turn: number, messages: number, windowStart: number): void {
		this.session.sessionManager.appendCustomEntry(RETENTION_CURSOR_ENTRY_TYPE, {
			version: 1,
			scope: this.#scope(),
			transcriptId: this.transcriptId,
			turn,
			messages,
			windowStart,
		} satisfies RetentionCursorData);
		this.#hasCursor = true;
	}

	/**
	 * Supermemory adds content sent under the same document `id` to that document. Keying on the
	 * window's first turn lets a retry or resume extend the same window's document while later
	 * windows never touch earlier ones.
	 */
	#windowDocumentId(startTurn: number): string {
		const digest = new Bun.CryptoHasher("sha256")
			.update(`${this.transcriptId}\u0000${this.namespace}\u0000${startTurn}`)
			.digest("hex");
		return `omp-${digest}`;
	}

	/** Serializes retention so concurrent `agent_end`s never write the same window twice. */
	#enqueueRetention(work: () => Promise<void>): Promise<void> {
		const run = this.#retention.then(work).catch(error => {
			logger.warn("Supermemory: retention failed", { error: String(error) });
		});
		this.#retention = run;
		return this.#track(run);
	}

	#track<T>(promise: Promise<T>): Promise<T> {
		this.#writes.add(promise);
		const done = () => this.#writes.delete(promise);
		void promise.then(done, done);
		return promise;
	}

	/** Waits for every write started so far, including ones started while waiting. */
	async flush(): Promise<void> {
		while (this.#writes.size > 0) await Promise.allSettled(this.#writes);
	}

	/**
	 * Stops automatic work and gives pending writes and the outbox a bounded chance to land.
	 * An alias owns nothing: its writes sit in the parent's outbox, which the parent disposes.
	 */
	async dispose(): Promise<void> {
		// No transcript-generation bump: the bounded flush below must finish queued due windows.
		this.#recallGeneration++;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const own = this.#own;
		if (!own) return;
		void this.drainOutbox();
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, DISPOSE_FLUSH_TIMEOUT_MS);
		try {
			await Promise.race([this.flush(), promise]);
		} finally {
			clearTimeout(timer);
			this.#disposed = true;
			own.outbox.dispose();
		}
	}
}

/** Message index of each user turn. */
function userTurnStarts(messages: HindsightMessage[]): number[] {
	return messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
}
