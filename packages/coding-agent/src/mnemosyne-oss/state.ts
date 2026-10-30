import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import {
	composeRecallQuery,
	formatMemories,
	prepareRetentionTranscript,
	truncateRecallQuery,
} from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import type { MemoryBackendSaveInput, MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { MnemosyneOssBackendConfig } from "./config";
import { MnemosyneOssWorkerClient, type MnemosyneOssWorkerRequestOptions } from "./worker-client";
import type {
	MnemosyneOssWorkerMethod,
	MnemosyneOssWorkerMutation,
	MnemosyneOssWorkerRecallItem,
	MnemosyneOssWorkerRecord,
	MnemosyneOssWorkerStatus,
} from "./worker-protocol";

const kMnemosyneOssSessionState = Symbol("mnemosyne-oss.sessionState");
const RETENTION_CURSOR_TYPE = "mnemosyne-oss-retention-cursor";

interface AgentSessionWithMnemosyneOssState extends AgentSession {
	[kMnemosyneOssSessionState]?: MnemosyneOssSessionState;
}

export function getMnemosyneOssSessionState(session: AgentSession | undefined): MnemosyneOssSessionState | undefined {
	return session ? (session as AgentSessionWithMnemosyneOssState)[kMnemosyneOssSessionState] : undefined;
}

/** State that owns the worker for `session`: subagent states alias the root session's state. */
export function getMnemosyneOssOwner(session: AgentSession | undefined): MnemosyneOssSessionState | undefined {
	const state = getMnemosyneOssSessionState(session);
	return state?.aliasOf ?? state;
}

export function setMnemosyneOssSessionState(
	session: AgentSession,
	state: MnemosyneOssSessionState | undefined,
): MnemosyneOssSessionState | undefined {
	const typed = session as AgentSessionWithMnemosyneOssState;
	const previous = typed[kMnemosyneOssSessionState];
	if (state) typed[kMnemosyneOssSessionState] = state;
	else delete typed[kMnemosyneOssSessionState];
	return previous;
}

export interface MnemosyneOssWorkerLike {
	request<T>(
		method: MnemosyneOssWorkerMethod,
		params?: Record<string, unknown>,
		options?: MnemosyneOssWorkerRequestOptions,
	): Promise<T>;
	shutdown(): Promise<void>;
}

export type MnemosyneOssWorkerFactory = () => MnemosyneOssWorkerLike;

export interface MnemosyneOssSessionStateOptions {
	sessionId: string;
	config: MnemosyneOssBackendConfig;
	session: AgentSession;
	aliasOf?: MnemosyneOssSessionState;
	/** Test seam and embedding host seam; production uses the supervised worker. */
	worker?: MnemosyneOssWorkerLike;
	workerFactory?: MnemosyneOssWorkerFactory;
}

interface RetentionCursor {
	sessionId: string;
	retainedThroughUserTurn: number;
	sourceId: string;
}

export class MnemosyneOssSessionState {
	readonly sessionId: string;
	readonly config: MnemosyneOssBackendConfig;
	readonly session: AgentSession;
	readonly aliasOf?: MnemosyneOssSessionState;
	lastRecallSnippet?: string;
	hasRecalledForFirstTurn = false;
	lastRetainedTurn = 0;
	lastRecallAt?: string;
	lastWriteAt?: string;
	#worker!: MnemosyneOssWorkerLike;
	/** Bumped per first-turn recall and on transcript reset; a stale lookup cannot commit. */
	#recallGeneration = 0;
	#workerFactory?: MnemosyneOssWorkerFactory;
	#unsubscribe?: () => void;
	#retentionQueue: Promise<void> = Promise.resolve();

	constructor(options: MnemosyneOssSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.config = options.config;
		this.session = options.session;
		this.aliasOf = options.aliasOf;
		if (options.aliasOf) {
			this.#worker = options.aliasOf.worker;
		} else {
			this.#workerFactory = options.worker
				? options.workerFactory
				: (options.workerFactory ??
					(() =>
						new MnemosyneOssWorkerClient({
							context: {
								session_id: options.sessionId,
								cwd: options.session.sessionManager.getCwd(),
								store_data_dir: options.config.dataDir,
								retain_bank: options.config.retainBank,
								recall_banks: options.config.recallBanks,
								shared_banks: options.config.sharedBanks,
								ownership: options.config.ownership,
								author_id: "omp",
								author_type: "agent",
								channel_id: options.sessionId,
								embedding_mode: options.config.localEmbeddings ? "local" : "lexical",
								embedding_model: options.config.embeddingModel,
								consolidation_mode: options.config.consolidationMode,
								local_llm_repo: options.config.localLlmRepo,
								local_llm_file: options.config.localLlmFile,
								auto_migrate: options.config.autoMigrate,
							},
							cwd: options.session.sessionManager.getCwd(),
							executable: options.config.executable,
							requestTimeoutMs: options.config.requestTimeoutMs,
							shutdownTimeoutMs: options.config.shutdownTimeoutMs,
						})));
		}
		if (!options.aliasOf) this.#worker = options.worker ?? this.#workerFactory!();
		this.lastRetainedTurn = loadRetentionCursor(options.session, options.sessionId);
	}

	get worker(): MnemosyneOssWorkerLike {
		return this.aliasOf?.worker ?? this.#worker;
	}

	get #owner(): MnemosyneOssSessionState {
		return this.aliasOf ?? this;
	}

	attachSessionListeners(): void {
		if (this.aliasOf) return;
		this.#unsubscribe?.();
		this.#unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_start") {
				void this.maybeRecallOnAgentStart().catch(error => this.#logLifecycleFailure("agent_start recall", error));
			}
			if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd(event.messages).catch(error =>
					this.#logLifecycleFailure("agent_end retention", error),
				);
			}
		});
	}

	async recall(query: string, signal?: AbortSignal): Promise<MnemosyneOssWorkerRecallItem[]> {
		const primary = this.#owner;
		const result = await primary.worker.request<{ items: MnemosyneOssWorkerRecallItem[] }>(
			"recall",
			{ query, limit: primary.config.recallLimit },
			{ signal },
		);
		primary.lastRecallAt = new Date().toISOString();
		const byId = new Map<string, MnemosyneOssWorkerRecallItem>();
		for (const item of result.items ?? []) {
			const previous = byId.get(item.id);
			if (!previous || (item.score ?? 0) > (previous.score ?? 0)) byId.set(item.id, item);
		}
		return [...byId.values()]
			.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
			.slice(0, primary.config.recallLimit);
	}

	async remember(content: string, options: Record<string, unknown>): Promise<string | undefined> {
		const primary = this.#owner;
		const result = await primary.worker.request<{ id?: string }>(
			"remember",
			{ content, options },
			{ mutation: true },
		);
		if (result.id) primary.lastWriteAt = new Date().toISOString();
		return result.id;
	}

	/** Explicit save (`retain`, `learn`, `/memory save`): one global-scope row in the retain bank. */
	async save(input: MemoryBackendSaveInput): Promise<string> {
		const content = input.content.trim();
		if (!content) throw new Error("Memory content is empty.");
		const primary = this.#owner;
		const importance = input.importance;
		const id = await primary.remember(content, {
			source: input.source ?? "coding-agent-memory-command",
			importance:
				importance === undefined || !Number.isFinite(importance) ? 0.65 : Math.max(0, Math.min(1, importance)),
			scope: "global",
			extract: false,
			extract_entities: false,
			metadata: {
				sessionId: primary.sessionId,
				cwd: primary.session.sessionManager.getCwd(),
				context: input.context ?? null,
				operation: "memory.save",
				authorId: "omp",
				authorType: "agent",
			},
		});
		if (!id) throw new Error("Mnemosyne did not return a stored memory id.");
		return id;
	}

	async get(id: string): Promise<{ status: "found" | "not_found"; record?: MnemosyneOssWorkerRecord }> {
		const primary = this.#owner;
		return await primary.worker.request("get", { id });
	}

	async edit(
		operation: "update" | "forget" | "invalidate",
		id: string,
		options: { content?: string; importance?: number; replacementId?: string } = {},
	): Promise<MnemosyneOssWorkerMutation> {
		const primary = this.#owner;
		// Forward only what the SDK method accepts: update(content, importance), invalidate(replacement_id).
		const params: Record<string, unknown> = { id };
		if (operation === "update") {
			if (options.content !== undefined) params.content = options.content;
			if (options.importance !== undefined) params.importance = Math.max(0, Math.min(1, options.importance));
		} else if (operation === "invalidate" && options.replacementId !== undefined) {
			params.replacement_id = options.replacementId;
		}
		const result = await primary.worker.request<MnemosyneOssWorkerMutation>(operation, params, { mutation: true });
		if (result.status === "updated" || result.status === "deleted" || result.status === "invalidated") {
			primary.lastWriteAt = new Date().toISOString();
		}
		return result;
	}

	async capabilities(): Promise<{
		protocol: number;
		sdk_version: string;
		python_version: string;
		embedding_mode: "local" | "lexical";
		consolidation_mode: "local" | "heuristic";
		clear_mode: string;
	}> {
		return await this.#owner.worker.request("capabilities");
	}

	/** Stages the first-turn recall; nothing is published until the owning turn commits it. */
	async beforeAgentStartPrompt(
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		if (this.aliasOf || !this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;
		const latest = promptText.trim();
		if (!latest) return undefined;
		const generation = ++this.#recallGeneration;
		try {
			const history = extractMessages(this.session.sessionManager);
			const query = truncateRecallQuery(
				composeRecallQuery(latest, [...history, { role: "user", content: latest }], this.config.recallContextTurns),
				latest,
				this.config.recallMaxQueryChars,
			);
			const memories = await this.recall(query, signal);
			const snippet = memories.length === 0 ? undefined : this.#formatRecallBlock(memories);
			return {
				context: snippet,
				commit: () => {
					if (this.#recallGeneration !== generation) return false;
					this.hasRecalledForFirstTurn = true;
					if (snippet) this.lastRecallSnippet = snippet;
					return true;
				},
			};
		} catch (error) {
			logger.warn("Mnemosyne OSS auto-recall failed", { error: String(error) });
			return undefined;
		}
	}

	/** New transcript: forget the first-turn recall and the retention cursor of the previous one. */
	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.lastRetainedTurn = 0;
	}

	async recallForCompaction(messages: AgentMessage[]): Promise<string | undefined> {
		if (this.aliasOf) return undefined;
		const latest = messages.findLast(message => message.role === "user");
		if (!latest || typeof latest.content !== "string") return undefined;
		try {
			const flat = messages
				.filter(message => message.role === "user" || message.role === "assistant")
				.map(message => ({
					role: message.role,
					content: typeof message.content === "string" ? message.content : "",
				}));
			const query = truncateRecallQuery(
				composeRecallQuery(latest.content, flat, this.config.recallContextTurns),
				latest.content,
				this.config.recallMaxQueryChars,
			);
			const memories = await this.recall(query);
			return memories.length === 0 ? undefined : this.#formatRecallBlock(memories);
		} catch {
			return undefined;
		}
	}

	async maybeRecallOnAgentStart(): Promise<void> {
		if (this.aliasOf) return;
		const messages = extractMessages(this.session.sessionManager);
		const lastUser = messages.findLast(message => message.role === "user");
		if (!lastUser) return;
		const preparation = await this.beforeAgentStartPrompt(lastUser.content);
		if (!preparation?.commit() || !preparation.context) return;
		await this.session.refreshBaseSystemPrompt();
	}

	async maybeRetainOnAgentEnd(_messages: AgentMessage[]): Promise<void> {
		if (!this.config.autoRetain || this.aliasOf) return;
		await this.#queueRetention(async () => {
			const messages = extractMessages(this.session.sessionManager);
			const throughTurn = countUserTurns(messages);
			if (throughTurn - this.lastRetainedTurn < this.config.retainEveryNTurns) return;
			await this.retain(messages, throughTurn);
		});
	}

	async forceRetainCurrentSession(): Promise<void> {
		if (this.aliasOf) return;
		await this.#queueRetention(async () => {
			const messages = extractMessages(this.session.sessionManager);
			await this.retain(messages, countUserTurns(messages));
		});
	}

	async probe(): Promise<void> {
		if (this.aliasOf) return;
		await this.worker.request("capabilities");
	}

	async sleep(): Promise<void> {
		if (this.aliasOf) return;
		await this.worker.request(
			"sleep",
			{ dry_run: false, force: false },
			{ mutation: true, timeoutMs: this.config.sleepTimeoutMs },
		);
	}

	async status(): Promise<MnemosyneOssWorkerStatus> {
		return await this.#owner.worker.request("status");
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		if (this.aliasOf) return;
		await this.forceRetainCurrentSession().catch(error =>
			logger.warn("Mnemosyne OSS final retention failed", { error: String(error) }),
		);
		await this.worker.shutdown();
	}

	async clearAndRehydrate(): Promise<void> {
		const primary = this.#owner;
		if (primary.aliasOf) return;
		await primary.worker.request("clear", {}, { mutation: true });
		primary.lastRecallSnippet = undefined;
		primary.hasRecalledForFirstTurn = false;
		primary.lastRetainedTurn = 0;
		await persistRetentionCursor(primary.session, {
			sessionId: primary.sessionId,
			retainedThroughUserTurn: 0,
			sourceId: `${primary.sessionId}:cleared`,
		});
		if (!primary.#workerFactory) return;
		const oldWorker = primary.#worker;
		await oldWorker.shutdown();
		primary.#worker = primary.#workerFactory();
	}

	async retain(messages: Array<{ role: string; content: string }>, throughTurn: number): Promise<void> {
		const primary = this.#owner;
		if (primary.aliasOf || throughTurn <= primary.lastRetainedTurn) return;
		const unretained = sliceUnretainedMessages(messages, primary.lastRetainedTurn);
		const { transcript } = prepareRetentionTranscript(unretained, true);
		if (!transcript) return;
		const start = primary.lastRetainedTurn + 1;
		const sourceId = `${primary.sessionId}:turns:${start}-${throughTurn}`;
		const id = await primary.remember(transcript, {
			source: "coding-agent-transcript",
			scope: "global",
			dedupe: true,
			extract: false,
			extract_entities: false,
			metadata: {
				sessionId: primary.sessionId,
				sourceId,
				cwd: primary.session.sessionManager.getCwd(),
				turnStart: start,
				turnEnd: throughTurn,
				operation: "auto-retain",
				authorId: "omp",
				authorType: "agent",
			},
		});
		if (!id) return;
		await persistRetentionCursor(primary.session, {
			sessionId: primary.sessionId,
			retainedThroughUserTurn: throughTurn,
			sourceId,
		});
		primary.lastRetainedTurn = throughTurn;
	}

	#formatRecallBlock(memories: readonly MnemosyneOssWorkerRecallItem[]): string {
		const rendered = `<memories>\n${formatMemories(
			memories.map(item => ({ text: item.content, type: item.source, mentioned_at: item.timestamp })),
		)}\n</memories>`;
		return truncateInjection(rendered, this.config.injectionTokenLimit);
	}
	async #queueRetention(task: () => Promise<void>): Promise<void> {
		const next = this.#retentionQueue.then(task, task);
		this.#retentionQueue = next.catch(() => undefined);
		await next;
	}

	#logLifecycleFailure(operation: string, error: unknown): void {
		if (this.config.debug) logger.warn("Mnemosyne OSS lifecycle hook failed", { operation, error: String(error) });
	}
}

/** Agent-facing recall list; ids let `memory_edit` and `read memory://<id>` address each row. */
export function formatMnemosyneOssRecall(items: readonly MnemosyneOssWorkerRecallItem[]): string {
	return items
		.map(item => {
			const source = item.source ? ` [${item.source}]` : "";
			const date = item.timestamp ? ` (${item.timestamp.slice(0, 10)})` : "";
			const score = typeof item.score === "number" ? ` c:${item.score.toFixed(1)}` : "";
			return `- ${item.content} (id: ${item.id})${source}${date}${score}`;
		})
		.join("\n\n");
}

function countUserTurns(messages: readonly { role: string }[]): number {
	return messages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0);
}

function sliceUnretainedMessages(
	messages: Array<{ role: string; content: string }>,
	lastRetainedTurn: number,
): Array<{ role: string; content: string }> {
	if (lastRetainedTurn <= 0) return messages;
	let userTurns = 0;
	for (let index = 0; index < messages.length; index++) {
		if (messages[index].role !== "user") continue;
		userTurns++;
		if (userTurns > lastRetainedTurn) return messages.slice(index);
	}
	return [];
}

function loadRetentionCursor(session: AgentSession, sessionId: string): number {
	const entries = session.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== RETENTION_CURSOR_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const cursor = data as Partial<RetentionCursor>;
		if (
			cursor.sessionId === sessionId &&
			Number.isInteger(cursor.retainedThroughUserTurn) &&
			(cursor.retainedThroughUserTurn ?? 0) >= 0
		) {
			return cursor.retainedThroughUserTurn ?? 0;
		}
	}
	return 0;
}

async function persistRetentionCursor(session: AgentSession, cursor: RetentionCursor): Promise<void> {
	session.sessionManager.appendCustomEntry(RETENTION_CURSOR_TYPE, cursor);
	await session.sessionManager.flush();
}
function truncateInjection(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
