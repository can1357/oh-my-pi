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

/** A tool-initiated write in `<agentDir>/supermemory-outbox/<destination>/`; `id` is its `customId`. */
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
	/** Server, account and container (see `#scope`); a cursor only applies to the same ones. */
	scope: string;
	/** User turns `[0, turn)` are retained. */
	turn: number;
}

function isRetentionCursor(data: unknown): data is RetentionCursorData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"turn" in data &&
		Number.isSafeInteger(data.turn)
	);
}

export interface SupermemorySessionStateOptions {
	session: AgentSession;
	client: SupermemoryClient;
	config: ConfiguredSupermemoryConfig;
	containerTag: string;
	/** False for subagents: the tools work, automatic recall and retention never run. */
	automatic: boolean;
	/** Holds `supermemory-outbox/`. */
	agentDir: string;
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
export class SupermemorySessionState {
	readonly session: AgentSession;
	readonly client: SupermemoryClient;
	readonly config: ConfiguredSupermemoryConfig;
	readonly containerTag: string;
	readonly automatic: boolean;
	lastRecallSnippet?: string;
	hasRecalledForFirstTurn = false;
	/** User turns already covered by automatic retention documents. */
	lastRetainedTurn = 0;
	readonly #writes = new Set<Promise<unknown>>();
	readonly #outbox: MemoryOutboxQueue<SupermemoryOutboxEvent, SupermemoryRetainInput>;
	#retention: Promise<void> = Promise.resolve();
	#recallGeneration = 0;
	/** Bumped when the transcript changes identity; stale retention never advances {@link lastRetainedTurn}. */
	#transcriptGeneration = 0;
	#unsubscribe?: () => void;

	constructor(options: SupermemorySessionStateOptions) {
		this.session = options.session;
		this.client = options.client;
		this.config = options.config;
		this.containerTag = options.containerTag;
		this.automatic = options.automatic;
		this.#outbox = new MemoryOutboxQueue({
			label: "Supermemory",
			// One document per request: drain as soon as a write lands.
			flushBatchSize: 1,
			notice: message => this.session.emitNotice("warning", message, SUPERMEMORY_NOTICE_SOURCE),
			toEvents: (toolCallId, items) => {
				const key = this.config.apiKey;
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
					apiUrl: this.config.baseUrl,
					container: this.containerTag,
					label: "Supermemory",
					isEvent: event =>
						typeof event.content === "string" &&
						typeof event.metadata === "object" &&
						event.metadata !== null &&
						Object.values(event.metadata).every(value => typeof value === "string"),
					send: async ([event]) => {
						try {
							await this.client.createDocument({
								content: event.content,
								containerTag: this.containerTag,
								customId: event.id,
								metadata: event.metadata,
							});
							return "accepted";
						} catch (error) {
							return sendFailure(error, error instanceof SupermemoryHttpError ? error.status : undefined);
						}
					},
				}),
		});
		this.#resumeRetention();
	}

	/**
	 * Resumes automatic retention at this transcript's latest retention cursor, so a window that
	 * failed or was cut by the dispose timeout is retried; its customId makes the retry an upsert.
	 * A transcript without a cursor predates them: its complete windows are assumed retained and
	 * retention starts at the open window, so resuming an old session never bulk-uploads it. An
	 * open window keeps its start-based customId, so completing it later upserts a superset.
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
					entry.data.scope === scope,
			);
		if (cursor?.type === "custom" && isRetentionCursor(cursor.data)) {
			this.lastRetainedTurn = cursor.data.turn;
			return;
		}
		const every = this.config.retainEveryNTurns;
		this.lastRetainedTurn = Math.floor(countUserTurns(this.session.sessionManager) / every) * every;
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
			if (event.type !== "agent_end") return;
			if (this.config.autoRetain) void this.#enqueueRetention(() => this.#retainDue());
			void this.drainOutbox();
		});
	}

	/** Persisted transcript id; survives resume, unlike the provider session id. */
	get transcriptId(): string {
		return this.session.sessionManager.getSessionId();
	}

	/** Strips the API key and recognizable secrets from text bound for the server. */
	#redact(text: string): string {
		return redactMemorySecrets(text.replaceAll(this.config.apiKey, "[REDACTED]"));
	}

	/**
	 * Persists one tool call's items, all or none, before resolving, then starts delivering
	 * them. A retried call has the same event ids, so it neither queues nor uploads twice.
	 */
	async enqueueRetain(toolCallId: string, items: SupermemoryRetainInput[]): Promise<void> {
		await this.#outbox.enqueue(toolCallId, items);
	}

	/** Delivers this destination's outbox, including events earlier processes left; tracked so {@link flush} awaits it. */
	drainOutbox(): Promise<void> {
		return this.#track(this.#outbox.flush());
	}

	/** Stores one document in this state's container (redacted); tracked so {@link flush} awaits it. */
	save(
		content: string,
		metadata: Record<string, string | number | boolean>,
		customId?: string,
	): Promise<SupermemoryDocument> {
		return this.#track(
			this.client.createDocument({
				content: this.#redact(content),
				containerTag: this.containerTag,
				customId,
				metadata,
			}),
		);
	}

	/** `memory_edit update`: new version of memory `id` in this state's container (redacted). */
	updateMemory(id: string, content: string, signal?: AbortSignal): Promise<string | undefined> {
		return this.client.updateMemory(
			{ id, containerTag: this.containerTag, newContent: this.#redact(content) },
			signal,
		);
	}

	async search(query: string, limit: number | undefined, signal?: AbortSignal): Promise<SupermemorySearchItem[]> {
		const resultLimit = Math.max(1, Math.min(limit ?? this.config.recallLimit, this.config.recallLimit));
		const results = await this.client.search(
			{
				q: this.#redact(query),
				containerTag: this.containerTag,
				searchMode: this.config.searchMode,
				// The search API rejects limit < 2; ask for at least 2 and trim locally.
				limit: Math.max(2, resultLimit),
				threshold: this.config.threshold,
			},
			signal,
		);
		return results.slice(0, resultLimit);
	}

	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (!this.automatic || !this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;
		const query = promptText.trim();
		if (!query) return undefined;
		const generation = ++this.#recallGeneration;
		// Reuse this transcript's recall so a resumed session sends the same prompt bytes.
		const persisted = findPersistedRecall(this.session.sessionManager, this.#scope());
		if (persisted !== undefined) {
			return {
				context: persisted.text || undefined,
				commit: () => this.#commitRecall(generation, persisted.text, false),
			};
		}

		const [profile, memories] = await Promise.allSettled([
			this.client.profile(this.containerTag, signal),
			this.search(query.slice(0, MAX_RECALL_QUERY_CHARS), undefined, signal),
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
		if (persist) persistRecall(this.session.sessionManager, this.#scope(), { text: context, memories: [] });
		return true;
	}

	/** Server, account (hashed key) and container; a persisted recall or retention cursor applies only to the same ones. */
	#scope(): string {
		return JSON.stringify([
			"supermemory",
			this.config.baseUrl,
			Bun.hash(this.config.apiKey).toString(16),
			this.containerTag,
		]);
	}

	/** `/memory enqueue`: retain every due window, then the unretained tail. */
	async forceRetainCurrentSession(): Promise<void> {
		await this.#enqueueRetention(async () => {
			await this.#retainDue();
			const messages = extractMessages(this.session.sessionManager);
			const userStarts = userTurnStarts(messages);
			if (userStarts.length > this.lastRetainedTurn) {
				await this.#retainWindow(messages, userStarts, this.lastRetainedTurn, userStarts.length);
			}
		});
	}

	/** Every complete `retainEveryNTurns` window not stored yet, oldest first. */
	async #retainDue(): Promise<void> {
		const every = this.config.retainEveryNTurns;
		if (countUserTurns(this.session.sessionManager) - this.lastRetainedTurn < every) return;
		const messages = extractMessages(this.session.sessionManager);
		const userStarts = userTurnStarts(messages);
		while (userStarts.length - this.lastRetainedTurn >= every) {
			const start = this.lastRetainedTurn;
			if (!(await this.#retainWindow(messages, userStarts, start, start + every))) return;
		}
	}

	/** Upserts user turns `[startTurn, endTurn)`; resolves whether {@link lastRetainedTurn} advanced. */
	async #retainWindow(
		messages: HindsightMessage[],
		userStarts: number[],
		startTurn: number,
		endTurn: number,
	): Promise<boolean> {
		const generation = this.#transcriptGeneration;
		const window = messages.slice(userStarts[startTurn], userStarts[endTurn] ?? messages.length);
		const { transcript } = prepareRetentionTranscript(window, true, { includeTimestamps: true });
		if (transcript) {
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
					this.#windowCustomId(startTurn),
				);
			} catch (error) {
				logger.warn("Supermemory: auto-retain failed", { error: String(error) });
				return false;
			}
		}
		if (generation !== this.#transcriptGeneration) return false;
		this.lastRetainedTurn = endTurn;
		// A `/memory enqueue` tail is an open window: a resume re-sends it complete under the same customId.
		if (endTurn - startTurn === this.config.retainEveryNTurns) {
			this.session.sessionManager.appendCustomEntry(RETENTION_CURSOR_ENTRY_TYPE, {
				version: 1,
				scope: this.#scope(),
				turn: endTurn,
			} satisfies RetentionCursorData);
		}
		return true;
	}

	/**
	 * Supermemory upserts by `customId`. Keying on the window's first turn lets a retry or
	 * resume update the same window while later windows never overwrite earlier ones.
	 */
	#windowCustomId(startTurn: number): string {
		const digest = new Bun.CryptoHasher("sha256")
			.update(`${this.transcriptId}\u0000${this.containerTag}\u0000${startTurn}`)
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

	/** Stops automatic work and gives pending writes and the outbox a bounded chance to land. */
	async dispose(): Promise<void> {
		// No transcript-generation bump: the bounded flush below must finish queued due windows.
		this.#recallGeneration++;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		void this.drainOutbox();
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, DISPOSE_FLUSH_TIMEOUT_MS);
		try {
			await Promise.race([this.flush(), promise]);
		} finally {
			clearTimeout(timer);
			this.#outbox.dispose();
		}
	}
}

/** Message index of each user turn. */
function userTurnStarts(messages: HindsightMessage[]): number[] {
	return messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
}
