import * as path from "node:path";
import { escapeXmlText, logger, prompt, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { redactMemorySecrets } from "../memory-backend/redact";
import { type HindsightMessage, prepareRetentionTranscript } from "../hindsight/content";
import { countUserTurns, extractMessages, retentionStart, userTurnEntryIds } from "../hindsight/transcript";
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
import type { SessionEntry } from "../session/session-entries";
import {
	type SupermemoryClient,
	type SupermemoryDocument,
	type SupermemoryDocumentInput,
	type SupermemoryForgetResult,
	SupermemoryHttpError,
	type SupermemoryMemory,
	type SupermemoryMemoryMatch,
	type SupermemorySearchItem,
} from "./client";
import type { ConfiguredSupermemoryConfig } from "./config";

/** `notice` source of Supermemory failures. */
export const SUPERMEMORY_NOTICE_SOURCE = "Supermemory";

const MAX_RECALL_QUERY_CHARS = 1_000;
/** Semantic forget queries are limited to 2,000 chars server-side. */
const MAX_FORGET_QUERY_CHARS = 2_000;
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
	/** Written when automatic retention stopped (dispose): user turns the branch held then. Turns added later were exchanged while it was off. */
	stoppedAt?: number;
	/** With {@link stoppedAt}: messages the branch held then; an answer added while off (a continuation, a late reply) grows past it. */
	stoppedMessages?: number;
}

/** Window uploads of each session, chained so a replacement state never overtakes its predecessor's upload. */
const retentionTails = new WeakMap<AgentSession, Promise<void>>();

/** Transcript messages captured for one retention job, with the identity they belong to. */
interface SettledHistory {
	messages: HindsightMessage[];
	/** The last turn is unfinished (no answer, or an aborted/errored one): bare resume or `/retry` completes it without a new user turn. */
	openTail: boolean;
	generation: number;
	transcriptId: string;
	/** Entry id of each user turn, keying its window's document. */
	userIds: string[];
	/** Leaf of the branch the messages were read from; a job never records a cursor once the session left it. */
	leaf: string | undefined;
}

/** A request through a state that was disposed (e.g. a subagent's alias after a settings change). */
function closedError(outcome = "memory NOT stored"): Error {
	return new Error(`Supermemory state is closed after a settings change; ${outcome}. Restart the subagent.`);
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
		Number.isSafeInteger(data.windowStart) &&
		(!("stoppedAt" in data) || Number.isSafeInteger(data.stoppedAt)) &&
		(!("stoppedMessages" in data) || Number.isSafeInteger(data.stoppedMessages))
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
 * What a subagent alias routes to its parent: namespace and every tool read, write and edit.
 * A subagent worker holds a remote implementation whose calls run on main's state, so writes
 * land in the parent's outbox.
 */
export interface SupermemorySessionStateApi {
	readonly namespace: string;
	readonly aliasOf?: SupermemorySessionStateApi;
	search(query: string, limit: number | undefined, signal?: AbortSignal): Promise<SupermemorySearchItem[]>;
	enqueueRetain(toolCallId: string, items: SupermemoryRetainInput[]): Promise<void>;
	save(
		content: string,
		metadata: Record<string, string | number | boolean>,
		id?: string,
		dreaming?: SupermemoryDocumentInput["dreaming"],
	): Promise<SupermemoryDocument>;
	forgetMemory(id: string, signal?: AbortSignal): Promise<SupermemoryForgetResult>;
	previewForget(query: string, signal?: AbortSignal): Promise<SupermemoryMemoryMatch[]>;
	getMemory(id: string, signal?: AbortSignal): Promise<SupermemoryMemory>;
}

/** Config, client and outbox a primary state owns. */
interface SupermemoryOwnResources {
	config: ConfiguredSupermemoryConfig;
	client: SupermemoryClient;
	outbox: MemoryOutboxQueue<SupermemoryOutboxEvent, SupermemoryRetainInput>;
}

/** One recall-block bullet: `text` is cut to the item limit, `note` (id, marker) is kept whole after it. */
interface RecallLine {
	text: string;
	note: string;
}

/** Recall note of a search result: memories carry their editable id and `[inferred]`, chunks are marked. */
export function recallNote(item: SupermemorySearchItem): string {
	if (item.kind === "chunk") return " [document chunk]";
	return ` (id: ${item.id})${item.inferred ? " [inferred]" : ""}`;
}

/** Escaped bullet lines for `items` within `budget` chars; an item that does not fit is skipped, not the rest. */
function renderLines(items: readonly RecallLine[], budget: number): string {
	const lines: string[] = [];
	let remaining = budget;
	for (const item of items) {
		const text = truncate(sanitizeText(item.text).trim(), MAX_RECALL_ITEM_CHARS) + sanitizeText(item.note);
		const line = `- ${escapeXmlText(text)}`;
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
	/** Set once {@link dispose} returns; retention queued behind a slow upload must not run against the session's next transcript. */
	#disposed = false;
	#recallGeneration = 0;
	/** Bumped when the transcript changes identity or the branch moves; stale retention never advances {@link lastRetainedTurn}. */
	#transcriptGeneration = 0;
	/** Whether the active branch already holds a retention cursor for {@link #scope}. */
	#hasCursor = false;
	/** An entry of the branch the in-memory cursor describes; a branch without it is another one (see {@link #followBranch}). */
	#anchor: string | undefined;
	/** Adopted a stop cursor on resume; the first run then writes a plain cursor after it. */
	#stopAdopted = false;
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
	 * Resumes automatic retention at the active branch's latest retention cursor, so a window that
	 * failed or was cut by the dispose timeout is retried; its document id makes the retry add to the
	 * same document. A branch without a cursor was never retained here (retention writes one at its
	 * first run): its turns were exchanged while Supermemory or `autoRetain` was off, or copied from
	 * another transcript, so retention starts at the current turn and never uploads them. An open window keeps its start-based document id, so completing it later re-sends a superset
	 * into that document. A latest cursor from another scope (namespace, account or server switch)
	 * means every turn so far belongs to that scope, and turns added after a stop cursor were
	 * exchanged while retention was off: either way retention here starts at the current turn (after a
	 * stop, turns left unsent before it are still sent once, see {@link #sendBeforeStop}).
	 */
	#resumeRetention(): void {
		const [path, start] = this.#retainedEntries();
		this.#anchor = path.at(-1)?.id;
		const data = this.#pathCursor(path, start);
		this.#hasCursor = data !== undefined;
		const turns = countUserTurns(path, start);
		const scoped = data?.scope === this.#scope() ? data : undefined;
		const stop = scoped?.stoppedAt;
		// Anything added after the stop (a user turn, or an answer without one) was exchanged while off.
		const offPeriod =
			stop !== undefined &&
			(turns > stop ||
				(scoped?.stoppedMessages !== undefined && extractMessages(path, start).length > scoped.stoppedMessages));
		this.#stopAdopted = false;
		if (scoped && !offPeriod) {
			this.lastRetainedTurn = scoped.turn;
			this.#retainedMessages = scoped.messages;
			this.#windowStart = scoped.windowStart;
			// The stop must stop reading as the latest cursor once turns follow it, or a later resume
			// would take them for off-period turns: the first run writes a plain cursor (see the listener).
			this.#stopAdopted = stop !== undefined;
			return;
		}
		if (data) {
			this.lastRetainedTurn = turns;
			this.#retainedMessages = 0;
			this.#windowStart = turns;
			// Only a state that retains records where retention resumes: otherwise a later retaining state
			// would adopt this cursor and upload turns exchanged while nothing retained.
			if (this.automatic && this.#config.autoRetain && !this.#disposed) {
				this.#appendCursor(turns, 0, turns);
				// Turns exchanged before the stop that were never sent (an open window, or one that failed
				// or was cut off) still go out once, best effort, without what was exchanged while off.
				if (scoped && stop !== undefined) this.#sendBeforeStop(scoped, stop);
			}
			return;
		}
		// A copy (`/fork`, `/branch`, `/btw`) holds its source's cursors under the source's id: continue
		// after the source's last retained turn, so the source's unsent open window is not lost. Windows
		// already sent belong to the source's documents, so nothing before that turn is re-sent here.
		const copied = this.#pathCursor(path, start, true);
		const copiedStop = copied?.stoppedAt;
		const copiedOff =
			copiedStop !== undefined &&
			(turns > copiedStop ||
				(copied?.stoppedMessages !== undefined && extractMessages(path, start).length > copied.stoppedMessages));
		if (copied && copied.scope === this.#scope() && !copiedOff && this.automatic && this.#config.autoRetain) {
			const from = Math.min(copied.turn, turns);
			this.lastRetainedTurn = from;
			this.#windowStart = from;
			this.#retainedMessages = 0;
			return;
		}
		// Otherwise a branch without a cursor was never retained by automatic retention: start at its
		// current turn. `/memory enqueue` without automatic retention keeps sending the open tail.
		const base = this.automatic && this.#config.autoRetain ? turns : turns - (turns % this.#config.retainEveryNTurns);
		this.lastRetainedTurn = base;
		this.#retainedMessages = 0;
		this.#windowStart = base;
	}

	/**
	 * Latest cursor of this transcript (or, with `copied`, of the transcript this one was copied from)
	 * whose retained turns all lie on `path`: one appended at an entry of `path` past its retention
	 * start. A cursor appended at a deeper entry wins; a `/tree` move back to an earlier answer leaves
	 * later cursors off the path. A stop applies only to the branch it was written on (the entry itself
	 * is on `path`); from a sibling branch it is a plain cursor.
	 */
	#pathCursor(path: readonly SessionEntry[], start: number, copied = false): RetentionCursorData | undefined {
		const depth = new Map(path.map((entry, index) => [entry.id, index]));
		let best: RetentionCursorData | undefined;
		let bestDepth = -Infinity;
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RETENTION_CURSOR_ENTRY_TYPE) continue;
			if (!isRetentionCursor(entry.data) || (entry.data.transcriptId === this.transcriptId) === copied) continue;
			const at = entry.parentId === null ? -1 : depth.get(entry.parentId);
			if (at === undefined || at < start - 1 || at < bestDepth) continue;
			best = depth.has(entry.id) ? entry.data : { ...entry.data, stoppedAt: undefined, stoppedMessages: undefined };
			bestDepth = at;
		}
		return best;
	}

	/** After a `/tree` move off the branch the in-memory cursor describes, re-derives it from the active one; jobs queued for the old branch go stale. */
	#followBranch(): void {
		const path = this.session.sessionManager.getBranch();
		if (this.#anchor !== undefined && !path.some(entry => entry.id === this.#anchor)) {
			this.#transcriptGeneration++;
			this.#resumeRetention();
			return;
		}
		this.#anchor = path.at(-1)?.id;
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
			if (event.type !== "agent_start" && event.type !== "agent_pause" && event.type !== "agent_end") return;
			this.#followBranch();
			if (this.#config.autoRetain && (!this.#hasCursor || this.#stopAdopted)) {
				// Record where retention starts before any upload: a branch without a cursor reads as
				// pre-cursor on resume, which skips every turn it already holds; after an adopted stop, a
				// later resume would read this run's turns as exchanged while off.
				this.#appendCursor(this.lastRetainedTurn, this.#retainedMessages, this.#windowStart);
				this.#stopAdopted = false;
			}
			// The run's agent_end waits until no job, child agent or peer can resume it; a yielded pause is
			// the model finishing its turn while such work keeps the run open (as for Hindsight and
			// Mnemopi). Non-yielded pauses continue the model's own work, so the window stays open.
			if (event.type !== "agent_end" && !(event.type === "agent_pause" && event.yielded)) return;
			if (this.#config.autoRetain) {
				// Snapshot the settled history now: a job queued behind a slow upload must not read a
				// turn that started afterwards and close its window before the answer exists.
				// Every turn end: a manual continuation can extend the last window without a user turn.
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
	 * Publication and the delivery after it are tracked before anything is awaited, so
	 * {@link flush} and dispose wait for a retain that is still writing its event.
	 */
	async enqueueRetain(toolCallId: string, items: SupermemoryRetainInput[]): Promise<void> {
		if (this.aliasOf) return this.aliasOf.enqueueRetain(toolCallId, items);
		const published = this.#local().outbox.enqueue(toolCallId, items);
		void this.#track(published.then(() => this.drainOutbox()));
		await published;
	}

	/** Delivers this destination's outbox, including events earlier processes left; tracked so {@link flush} awaits it. */
	drainOutbox(): Promise<void> {
		return this.#track(this.#local().outbox.flush());
	}

	/**
	 * Stores one document in this state's namespace (redacted); tracked so {@link flush} awaits it.
	 * `dreaming` omitted keeps the server default.
	 */
	save(
		content: string,
		metadata: Record<string, string | number | boolean>,
		id?: string,
		dreaming?: SupermemoryDocumentInput["dreaming"],
	): Promise<SupermemoryDocument> {
		if (this.aliasOf) return this.aliasOf.save(content, metadata, id, dreaming);
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
				dreaming,
			}),
		);
	}

	/** `memory_edit`: soft-forgets memory `id` in this state's namespace; tracked so {@link flush} awaits it. */
	forgetMemory(id: string, signal?: AbortSignal): Promise<SupermemoryForgetResult> {
		if (this.aliasOf) return this.aliasOf.forgetMemory(id, signal);
		if (this.#disposed) return Promise.reject(closedError());
		return this.#track(this.#local().client.forgetMemories(this.namespace, [id], signal));
	}

	/** `memory_edit preview_forget`: memories a semantic forget of `query` would match; changes nothing, so untracked. */
	previewForget(query: string, signal?: AbortSignal): Promise<SupermemoryMemoryMatch[]> {
		if (this.aliasOf) return this.aliasOf.previewForget(query, signal);
		if (this.#disposed) return Promise.reject(closedError("nothing previewed"));
		// Redact before cutting: a cut inside a token defeats the redactor.
		const sent = this.#redact(query).slice(0, MAX_FORGET_QUERY_CHARS);
		return this.#local().client.previewForget(this.namespace, sent, signal);
	}

	/** `memory://<id>`: one memory with its versions, links and source document. */
	getMemory(id: string, signal?: AbortSignal): Promise<SupermemoryMemory> {
		if (this.aliasOf) return this.aliasOf.getMemory(id, signal);
		if (this.#disposed) return Promise.reject(closedError("nothing read"));
		return this.#local().client.getMemory(this.namespace, id, signal);
	}

	search(query: string, limit: number | undefined, signal?: AbortSignal): Promise<SupermemorySearchItem[]> {
		if (this.aliasOf) return this.aliasOf.search(query, limit, signal);
		return this.#search(query, limit, signal);
	}

	/** `timeoutMs` bounds automatic recall ({@link SupermemoryConfig.recallTimeoutMs}); tools keep the client's. */
	#search(
		query: string,
		limit: number | undefined,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<SupermemorySearchItem[]> {
		if (this.#disposed) return Promise.reject(closedError("nothing recalled"));
		const config = this.#config;
		const resultLimit = Math.max(1, Math.min(limit ?? config.recallLimit, config.recallLimit));
		return this.#local().client.search(
			this.namespace,
			{
				query: this.#redact(query),
				searchMode: config.searchMode,
				limit: resultLimit,
				threshold: config.threshold,
			},
			signal,
			timeoutMs,
		);
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

		const timeoutMs = this.#config.recallTimeoutMs;
		const [profile, memories] = await Promise.allSettled([
			this.#local().client.profile(this.namespace, signal, timeoutMs),
			// Redact before cutting, as for retention: a cut inside a token defeats the redactor.
			this.#search(this.#redact(query).slice(0, MAX_RECALL_QUERY_CHARS), undefined, signal, timeoutMs),
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
		// Synthesized `aggregated_` summaries are no single memory: no id to edit.
		const facts =
			profile.status === "fulfilled"
				? [...profile.value.static, ...profile.value.dynamic].map(fact => ({
						text: fact.memory,
						note: fact.id && !fact.id.startsWith("aggregated_") ? ` (id: ${fact.id})` : "",
					}))
				: [];
		const found =
			memories.status === "fulfilled"
				? memories.value.map(item => ({ text: item.content, note: recallNote(item) }))
				: [];
		const text = prompt
			.render(recallTemplate, { profile: renderLines(facts, half), memories: renderLines(found, half) })
			.trim();
		return {
			context: text || undefined,
			commit: () => this.#commitRecall(generation, text, true),
		};
	}

	/**
	 * Recall for a compaction summary: one search on the latest user turn of the messages being
	 * summarized, adding memories relevant to that turn to the summary prompt (the first-turn
	 * block stays in the system prompt). Only the primary state recalls (an alias or subagent
	 * never does) and only with `autoRecall` on. Fails open: no match, an abort or an error
	 * returns `undefined`; compaction waits at most `supermemory.recallTimeoutMs`.
	 */
	async recallForCompaction(messages: HindsightMessage[], signal?: AbortSignal): Promise<string | undefined> {
		if (this.aliasOf || !this.automatic || this.#disposed || !this.#config.autoRecall) return undefined;
		const query = messages.findLast(message => message.role === "user")?.content.trim();
		if (!query) return undefined;
		try {
			// Redact before cutting, as for first-turn recall.
			const found = await this.#search(
				this.#redact(query).slice(0, MAX_RECALL_QUERY_CHARS),
				undefined,
				signal,
				this.#config.recallTimeoutMs,
			);
			if (signal?.aborted || found.length === 0) return undefined;
			const memories = renderLines(
				found.map(item => ({ text: item.content, note: recallNote(item) })),
				MAX_RECALL_CHARS,
			);
			return prompt.render(recallTemplate, { profile: "", memories, compaction: true }).trim() || undefined;
		} catch (error) {
			// A cancelled compaction is not a failure.
			if (!signal?.aborted) logger.warn("Supermemory: compaction recall failed", { error: String(error) });
			return undefined;
		}
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
			this.#followBranch();
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

	/** The active branch's entries and where retention starts: a `/tan` fork skips the transcript it copied. */
	#retainedEntries(): [SessionEntry[], number] {
		const manager = this.session.sessionManager;
		const entries = manager.getBranch();
		return [entries, retentionStart(entries, manager.getHeader?.())];
	}

	/** The active branch as it stands now, bound to its identity so a later `/new`, reset or `/tree` move discards it. */
	#settledHistory(): SettledHistory {
		const [entries, start] = this.#retainedEntries();
		const messages = extractMessages(entries, start);
		return {
			messages,
			openTail: messages.at(-1)?.role === "user" || lastTurnUnfinished(entries),
			generation: this.#transcriptGeneration,
			transcriptId: this.transcriptId,
			userIds: userTurnEntryIds(entries, start),
			leaf: entries.at(-1)?.id,
		};
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
		// The last closed window gained messages after it was sent (a continuation, or a background
		// job's wake after a yielded pause), possibly followed by newer user turns: re-send it under its
		// document id first, so that text is not left out of every window.
		const closedEnd = userStarts[this.lastRetainedTurn] ?? (history.openTail ? 0 : messages.length);
		// A cursor past the branch's turns belongs to turns this branch no longer holds: nothing to re-send.
		if (
			this.lastRetainedTurn > this.#windowStart &&
			this.lastRetainedTurn <= userStarts.length &&
			closedEnd > this.#retainedMessages
		) {
			if (!(await this.#retainWindow(messages, userStarts, this.#windowStart, this.lastRetainedTurn, history))) {
				return;
			}
		}
		while (settledTurns - this.lastRetainedTurn >= every) {
			const start = this.lastRetainedTurn;
			if (!(await this.#retainWindow(messages, userStarts, start, start + every, history))) return;
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
		if (!(await this.#sendWindow(messages, userStarts, startTurn, endTurn, identity))) return false;
		if (this.#isStale(identity)) return false;
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

	/**
	 * After a stop followed by turns exchanged while retention was off: sends what the stopped state
	 * left unsent before the stop (a grown last window, then every later window up to the stop),
	 * from a snapshot cut at the first turn after the stop. Best effort: a transient failure is not retried.
	 */
	#sendBeforeStop(cursor: RetentionCursorData, stoppedAt: number): void {
		if (!this.automatic || !this.#config.autoRetain) return;
		const history = this.#settledHistory();
		const userStarts = userTurnStarts(history.messages);
		const cut = cursor.stoppedMessages ?? userStarts[stoppedAt] ?? history.messages.length;
		const messages = history.messages.slice(0, cut);
		const every = this.#config.retainEveryNTurns;
		void this.#enqueueRetention(async () => {
			const closedEnd = Math.min(userStarts[cursor.turn] ?? messages.length, messages.length);
			if (cursor.turn > cursor.windowStart && closedEnd > cursor.messages) {
				if (!(await this.#sendWindow(messages, userStarts, cursor.windowStart, cursor.turn, history))) return;
			}
			for (let turn = cursor.turn; turn < stoppedAt; turn += every) {
				if (!(await this.#sendWindow(messages, userStarts, turn, Math.min(turn + every, stoppedAt), history)))
					return;
			}
		});
	}

	/** Uploads user turns `[startTurn, endTurn)` under the window's document id; resolves whether it was sent (or refused for good). */
	async #sendWindow(
		messages: HindsightMessage[],
		userStarts: number[],
		startTurn: number,
		endTurn: number,
		identity: Omit<SettledHistory, "messages">,
	): Promise<boolean> {
		// A late reply, or a job queued before `/new`, a reset or a `/tree` move, must not record its
		// window against another transcript or branch.
		const startId = identity.userIds[startTurn];
		if (startId === undefined || this.#isStale(identity)) return false;
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
					this.#windowDocumentId(startId),
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
		return true;
	}

	/** The job's transcript, generation or branch is gone, or this state was disposed. */
	#isStale({ generation, transcriptId, leaf }: Omit<SettledHistory, "messages">): boolean {
		return (
			this.#disposed ||
			generation !== this.#transcriptGeneration ||
			transcriptId !== this.transcriptId ||
			(leaf !== undefined && !this.session.sessionManager.getBranch().some(entry => entry.id === leaf))
		);
	}

	#appendCursor(
		turn: number,
		messages: number,
		windowStart: number,
		stop?: { stoppedAt: number; stoppedMessages?: number },
	): void {
		this.session.sessionManager.appendCustomEntry(RETENTION_CURSOR_ENTRY_TYPE, {
			version: 1,
			scope: this.#scope(),
			transcriptId: this.transcriptId,
			turn,
			messages,
			windowStart,
			...stop,
		} satisfies RetentionCursorData);
		this.#hasCursor = true;
	}

	/**
	 * Content sent under an existing document `id` updates that document. Keying on the entry of the window's
	 * first user turn lets a retry, resume or continuation update the same window's document, while later
	 * windows never touch it. Branches that split inside a window share its first entry, and so its document.
	 */
	#windowDocumentId(startEntryId: string): string {
		const digest = new Bun.CryptoHasher("sha256")
			.update(`${this.transcriptId}\u0000${this.namespace}\u0000${startEntryId}`)
			.digest("hex");
		return `omp-${digest}`;
	}

	/**
	 * Serializes retention per session, across states: concurrent `agent_end`s never write the same
	 * window twice, and a state replaced by a settings change while its upload is still in flight
	 * never has that upload land after (and overwrite) its successor's re-send of the same document.
	 */
	#enqueueRetention(work: () => Promise<void>): Promise<void> {
		const run = (retentionTails.get(this.session) ?? Promise.resolve()).then(work).catch(error => {
			logger.warn("Supermemory: retention failed", { error: String(error) });
		});
		retentionTails.set(this.session, run);
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
	 * Stops automatic work and gives writes still in flight (and the outbox behind them) a bounded
	 * chance to land. With nothing in flight it returns at once and starts no delivery: starting disk
	 * or network work during shutdown can outlive the event loop (the process exits with dispose
	 * still pending). Events a failed delivery left on disk stay there for the next drain of this
	 * destination (a top-level session's start, or the next write).
	 * An alias owns nothing: its writes sit in the parent's outbox, which the parent disposes.
	 */
	async dispose(): Promise<void> {
		// No transcript-generation bump: the bounded flush below must finish queued due windows.
		this.#recallGeneration++;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		const own = this.#own;
		if (!own) return;
		if (this.#writes.size > 0 || own.outbox.flushing) {
			// Joins a running delivery (a retry timer's included) rather than starting a second one.
			void this.drainOutbox();
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, DISPOSE_FLUSH_TIMEOUT_MS);
			try {
				await Promise.race([this.flush(), promise]);
			} finally {
				clearTimeout(timer);
			}
		}
		this.#disposed = true;
		own.outbox.dispose();
		this.#recordStop();
	}

	/**
	 * Records where automatic retention stopped (after {@link #disposed}, so no late job's cursor
	 * follows it): the next state on this branch skips turns exchanged in between (see
	 * {@link #resumeRetention}) and otherwise resumes, retrying a window cut off here.
	 */
	#recordStop(): void {
		if (!this.automatic || !this.#config.autoRetain) return;
		this.#followBranch();
		const [path, start] = this.#retainedEntries();
		const stoppedAt = countUserTurns(path, start);
		// Nothing to protect yet: no turn, no cursor (keeps an untouched draft session empty).
		if (stoppedAt === 0 && !this.#hasCursor) return;
		// Session teardown mid-run: the aborted run appends its answer after this, so no message bound
		// (that answer still reads as on-period; only later user turns count as exchanged while off).
		// A backend switch mid-run keeps the bound: the rest of that run happens while retention is off.
		const midRunExit = this.session.isDisposed && this.session.isStreaming;
		const stoppedMessages = midRunExit ? undefined : extractMessages(path, start).length;
		const last = this.#pathCursor(path, start);
		if (
			last?.stoppedAt === stoppedAt &&
			last.stoppedMessages === stoppedMessages &&
			last.scope === this.#scope() &&
			last.turn === this.lastRetainedTurn &&
			last.messages === this.#retainedMessages &&
			last.windowStart === this.#windowStart
		) {
			return;
		}
		this.#appendCursor(
			this.lastRetainedTurn,
			this.#retainedMessages,
			this.#windowStart,
			stoppedMessages === undefined ? { stoppedAt } : { stoppedAt, stoppedMessages },
		);
	}
}

/** Message index of each user turn. */
function userTurnStarts(messages: HindsightMessage[]): number[] {
	return messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
}

/** Whether the branch's last answered turn was cut short (aborted or errored), so it stays open. */
function lastTurnUnfinished(entries: readonly SessionEntry[]): boolean {
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
