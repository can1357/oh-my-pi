/**
 * Per-session Dakera runtime state.
 *
 * Carried on the owning `AgentSession` behind a symbol key, the same way
 * `mnemopi/state.ts` does it: the backend owns its state's lifetime, and the
 * memory tools resolve it through `ToolSession.getDakeraSessionState` instead
 * of the session growing a field per backend.
 *
 * Transcript framing, recall-query composition and anti-feedback tag stripping
 * are imported from `hindsight/content.ts` rather than copied — Mnemopi already
 * reuses them the same way.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { logger } from "@oh-my-pi/pi-utils";
import {
	composeRecallQuery,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import { redactMemorySecrets, redactMemoryTextFields } from "../memory-backend/redact";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import {
	type DakeraApi,
	type DakeraMemoryType,
	type DakeraRecallHit,
	type DakeraStoreInput,
	collectMemoryIds,
	formatDakeraTimestamp,
	recallHitRank,
} from "./client";
import { DAKERA_RECALL_PREAMBLE, type DakeraConfig } from "./config";

/** Server-side content ceiling (per its INVALID_REQUEST); truncate below it. */
const SERVER_CONTENT_LIMIT = 99_000;
/** Metadata marker stored with the full-session transcript row so a resumed process can recover its id. */
const OMP_TRANSCRIPT_MARKER = { "omp-transcript": true } as const;
/** Upper bound for recoverTranscriptMemory()'s listing. */
const RECOVERY_LIST_LIMIT = 1_000;

/** Normalize a server timestamp (epoch millis or ISO-8601) to millis, or undefined when absent/invalid. */
function timestampOf(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
/** Injection budget for the recall block rendered into every prompt. */
const RECALL_BLOCK_CHAR_LIMIT = 1_500;
/** A memory the caller wants stored. */
export interface DakeraRetainItem {
	content: string;
	/** Provenance for the memory; stored as metadata, never merged into the content. */
	context?: string;
	memoryType?: DakeraMemoryType;
	importance?: number;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

const kDakeraSessionState = Symbol("dakera.sessionState");

interface DakeraAgentSession extends AgentSession {
	[kDakeraSessionState]?: DakeraSessionState;
}

/** Session-owned Dakera state, or `undefined` when this session has no backend. */
export function getDakeraSessionState(session: AgentSession | undefined): DakeraSessionState | undefined {
	return session ? (session as DakeraAgentSession)[kDakeraSessionState] : undefined;
}

/** Install (or with `undefined`, detach) the session's state, returning the previous one. */
export function setDakeraSessionState(
	session: AgentSession,
	state: DakeraSessionState | undefined,
): DakeraSessionState | undefined {
	const typed = session as DakeraAgentSession;
	const previous = typed[kDakeraSessionState];
	if (state) typed[kDakeraSessionState] = state;
	else delete typed[kDakeraSessionState];
	return previous;
}

export interface DakeraSessionStateOptions {
	sessionId: string;
	client: DakeraApi;
	agentId: string;
	/** Tags attached to every store — set in `global`/`per-project-tagged` scoping, where the agent id alone cannot name the project. */
	retainTags?: string[];
	/** ANY-match tag filter for every recall — set in `per-project-tagged` scoping; `undefined` leaves recall unfiltered. */
	recallTags?: string[];
	config: DakeraConfig;
	session: AgentSession;
	/** False for subagent sessions: auto-recall and auto-retain belong to the parent turn loop. */
	autonomous?: boolean;
}

/**
 * Owns one session's Dakera agent id, its recall cache, and its retain cursors.
 *
 * `full-session` retain keeps ONE memory per transcript and updates it in place;
 * `last-turn` retain stores one memory per user-turn window.
 */
export class DakeraSessionState {
	sessionId: string;
	readonly client: DakeraApi;
	readonly agentId: string;
	readonly retainTags?: string[];
	readonly recallTags?: string[];
	readonly config: DakeraConfig;
	readonly session: AgentSession;
	/** User-turn count at the last successful auto-retain. */
	lastRetainedTurn = 0;
	hasRecalledForFirstTurn = false;
	/** Last committed `<memories>` block, re-injected on prompt rebuilds. */
	lastRecallSnippet?: string;
	unsubscribe?: () => void;
	#recallGeneration = 0;
	/**
	 * Bumped on every session switch / conversation reset. Continuations of
	 * async writes capture the value at entry and re-check it after every
	 * await — a rekey mid-flight invalidates the queued task's outputs so a
	 * stale continuation cannot repopulate `#serverSessionId` or store the
	 * old transcript under the new session state.
	 */
	#retainGeneration = 0;
	/** Whether the server session row for the current sessionId exists (registered lazily with the first store). */
	#sessionRegisteredFor?: string;
	/** Session id whose transcript memory recovery already ran (or failed permanently). */
	#sessionRecoveredFor?: string;
	/** Server-minted session id; the requested one is advisory and gets ignored. */
	#serverSessionId?: string;
	/** Memory maintained in place by `full-session` retain. */
	#transcriptMemoryId?: string;
	/** Tail of the transcript-write queue — see {@link DakeraSessionState.#enqueueTranscript}. */
	#retainTail: Promise<void> = Promise.resolve();
	readonly #autonomous: boolean;
	readonly #pending = new Set<Promise<void>>();

	constructor(options: DakeraSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.agentId = options.agentId;
		this.retainTags = options.retainTags;
		this.recallTags = options.recallTags;
		this.config = options.config;
		this.session = options.session;
		this.#autonomous = options.autonomous !== false;
	}

	/** Rekey after a session switch: the transcript memory and any in-flight prompt belong to the old id. */
	setSessionId(sessionId: string): void {
		if (this.sessionId !== sessionId) {
			this.#recallGeneration++;
			this.#retainGeneration++;
		}
		this.sessionId = sessionId;
		this.#transcriptMemoryId = undefined;
		this.#serverSessionId = undefined;
		this.#sessionRegisteredFor = undefined;
		this.#sessionRecoveredFor = undefined;
	}

	/** New transcript: drop the recalled block and every retain cursor. */
	resetConversationTracking(): void {
		this.#recallGeneration++;
		this.#retainGeneration++;
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#transcriptMemoryId = undefined;
	}

	/** Recall hits ranked best-first, shared by the `recall` and `reflect` tools. */
	async recallHits(query: string, signal?: AbortSignal): Promise<DakeraRecallHit[]> {
		const hits = await this.client.recall(this.agentId, query, {
			topK: this.config.recallTopK,
			minImportance: this.config.recallMinImportance,
			rerank: this.config.recallRerank,
			tags: this.recallTags,
			signal,
		});
		return [...hits].sort((a, b) => recallHitRank(b) - recallHitRank(a));
	}

	/** One recall for both consumers: ranked hits plus the `- content [type] (date)` list they render to.
	 *
	 * Injection budget: the server ignores `top_k` and returns a reranked mix of
	 * full turn transcripts plus their derived fragments, so an untrimmed block
	 * grows to 10–20k characters (~3–6k tokens) and lands in every prompt. The
	 * renderer keeps semantic fragments whole, truncates episodic transcripts
	 * (the full dialog stays in the session JSONL), and caps the total block.
	 */
	async recallFormatted(query: string, signal?: AbortSignal): Promise<{ hits: DakeraRecallHit[]; text: string }> {
		const hits = await this.recallHits(query, signal);
		const fragments = hits.filter(hit => hit.memory.memory_type !== "episodic");
		const transcripts = hits.filter(hit => hit.memory.memory_type === "episodic");
		const text = this.#renderRecallBlock(fragments, transcripts, RECALL_BLOCK_CHAR_LIMIT);
		return { hits, text };
	}

	/** Render fragments first, then transcript tails, until the character budget runs out. */
	#renderRecallBlock(fragments: DakeraRecallHit[], transcripts: DakeraRecallHit[], charLimit: number): string {
		const render = (hit: DakeraRecallHit, maxChars: number): string => {
			const text = hit.memory.content.replace(/\s+\n/g, "\n").trim();
			const trimmed = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
			const typeStr = hit.memory.memory_type ? ` [${hit.memory.memory_type}]` : "";
			const dateStr = formatDakeraTimestamp(hit.memory.created_at) ?? null;
			return `- ${trimmed}${typeStr}${dateStr ? ` (${dateStr})` : ""}`;
		};
		const budget = (used: number): number => Math.max(150, charLimit - used);
		const parts: string[] = [];
		let used = 0;
		for (const hit of fragments) {
			const line = render(hit, 400);
			parts.push(line);
			used += line.length;
			if (used >= charLimit) return parts.join("\n\n");
		}
		for (const hit of transcripts) {
			const line = render(hit, budget(used));
			parts.push(line);
			used += line.length;
			if (used >= charLimit) break;
		}
		return parts.join("\n\n");
	}

	/** Store caller-supplied memories (the `retain` tool, `/memory` save, `learn`). */
	async retainItems(items: DakeraRetainItem[]): Promise<number> {
		const ids = await this.#store(
			items.map(item => ({
				content: item.content,
				memoryType: item.memoryType ?? "semantic",
				importance: item.importance ?? this.config.retainImportance,
				metadata: item.context ? { context: item.context } : undefined,
			})),
		);
		return ids.length;
	}

	/**
	 * Sole write path for caller content, so redaction happens once for every
	 * field the server persists — `context` rides in `metadata`, which
	 * `redactMemorySecrets(content)` alone would leave untouched.
	 */
	async #store(inputs: DakeraStoreInput[]): Promise<string[]> {
		const usable = inputs.filter(input => input.content.trim().length > 0);
		if (usable.length === 0) return [];
		const generation = this.#retainGeneration;
		await this.#ensureSessionRegistered();
		// A rekey raced the registration: these rows belong to the old session —
		// drop them instead of storing the old transcript under the new state.
		if (this.#retainGeneration !== generation) return [];
		const memories = await this.client.storeBatch(
			this.agentId,
			usable.map(input =>
				redactMemoryTextFields({
					...input,
					tags: this.retainTags,
					sessionId: this.#serverSessionId ?? this.sessionId,
				}),
			),
		);
		return collectMemoryIds(memories);
	}
	/**
	 * Register the server-side session row once per sessionId so the Dakera UI
	 * groups this session's memories. The server mints its own session id and
	 * ignores the requested one, so every store must reference the returned id.
	 * A failed registration is non-fatal — memories then carry the local id.
	 */
	async #ensureSessionRegistered(): Promise<void> {
		if (this.#sessionRegisteredFor === this.sessionId) return;
		const generation = this.#retainGeneration;
		const requestedId = this.sessionId;
		this.#sessionRegisteredFor = requestedId;
		try {
			const serverId = await this.client.sessionStart(this.agentId, requestedId, {
				source: "omp",
				cwd: this.session.sessionManager?.getCwd?.(),
			});
			// A rekey raced the registration: the server row belongs to the old
			// session now — drop it so the next store re-registers for the new id.
			if (this.#retainGeneration !== generation || this.sessionId !== requestedId) {
				this.#sessionRegisteredFor = undefined;
				this.#serverSessionId = undefined;
				return;
			}
			if (serverId) this.#serverSessionId = serverId;
		} catch (err) {
			// A briefly-down server at the first store must not orphan the whole
			// session's grouping — let the next store retry the registration.
			this.#sessionRegisteredFor = undefined;
			if (this.config.debug) {
				logger.debug("Dakera: session registration failed", { agentId: this.agentId, error: String(err) });
			}
		}
	}

	/** Format the window the active `retainMode` covers and publish it. */
	async retainTranscript(messages: HindsightMessage[]): Promise<void> {
		await this.#enqueueTranscript(() => this.#publishTranscript(messages, false));
	}

	/** `/memory enqueue`: republish the current transcript from scratch. */
	async forceRetainCurrentSession(): Promise<void> {
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		await this.#enqueueTranscript(() => this.#publishTranscript(messages, true));
		this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
	}

	/**
	 * One transcript write at a time. Two overlapping publishes would each see an
	 * unset `#transcriptMemoryId` and leave a second permanent transcript memory
	 * behind, with the older snapshot free to win on the server.
	 */
	#enqueueTranscript(task: () => Promise<void>): Promise<void> {
		const run = this.#retainTail.then(task);
		this.#retainTail = run.catch(() => undefined);
		return run;
	}

	async #publishTranscript(messages: HindsightMessage[], republish: boolean): Promise<void> {
		// Capture the generation at entry: a session switch or /memory clear that
		// lands while this task awaits invalidates its outputs — the stale
		// continuation must not write under the new session state.
		const generation = this.#retainGeneration;
		// Drop the maintained memory so a forced retain re-publishes the whole
		// transcript even when nothing new arrived — otherwise a deleted or
		// never-materialised upstream memory could never be recovered.
		if (republish) this.#transcriptMemoryId = undefined;
		const lastTurn = this.config.retainMode === "last-turn";
		const window = lastTurn ? sliceLastTurnsByUserBoundary(messages, this.config.retainEveryNTurns) : messages;
		// includeTimestamps stays off: the server fragments transcripts
		// line-by-line, so each timestamp header would become its own junk
		// memory row (observed 10+ standalone rows per day on live data).
		const { transcript } = prepareRetentionTranscript(window, true, { includeTimestamps: false });
		if (!transcript) return;
		// Redact before truncating: a credential straddling the cut would
		// otherwise survive as a fragment. The server rejects content over
		// 100,000 characters (INVALID_REQUEST) — leave headroom for the marker.
		const safe = redactMemorySecrets(transcript);
		const content = safe.length > SERVER_CONTENT_LIMIT ? `${safe.slice(0, SERVER_CONTENT_LIMIT)}\n[truncated]` : safe;
		if (!lastTurn && this.#transcriptMemoryId === undefined) {
			// A resumed process has no in-process id; find the row the previous
			// process maintained before storing a duplicate.
			await this.recoverTranscriptMemory();
		}
		const existing = this.#transcriptMemoryId;
		if (existing && !lastTurn) {
			// `full-session` rewrites the whole transcript each retain, so
			// the server re-extracts facts from already-processed turns — O(turns²)
			// per session. `last-turn` avoids it by storing each window separately.
			await this.client.update(this.agentId, existing, content);
			return;
		}
		// `last-turn` keeps every window as its own episodic memory — updating one
		// row in place would overwrite the previous window's history.
		const [id] = await this.#store([
			{
				content,
				memoryType: "episodic",
				importance: this.config.retainImportance,
				metadata: OMP_TRANSCRIPT_MARKER,
			},
		]);
		// No id means the server answered in a shape we cannot address; the next
		// retain stores again rather than silently keeping nothing durable.
		if (this.#retainGeneration !== generation) return;
		if (id && !lastTurn) this.#transcriptMemoryId = id;
	}

	/**
	 * A resumed session constructs a fresh state, so the in-process
	 * `#transcriptMemoryId` is gone. Recover the row the previous process
	 * maintained by listing this agent's memories and matching the
	 * `omp-transcript` marker stored with every full-session publish —
	 * otherwise resume would POST a second transcript row per session.
	 *
	 * The row carries a server-side session id this process has not seen yet,
	 * so the match is on the marker (scoped to the current session id only
	 * when a row already uses the local id). Multiple marker rows pick the
	 * most recently updated.
	 */
	async recoverTranscriptMemory(): Promise<void> {
		if (this.#transcriptMemoryId !== undefined || this.config.retainMode !== "full-session") return;
		if (this.#sessionRecoveredFor === this.sessionId) return;
		this.#sessionRecoveredFor = this.sessionId;
		try {
			const memories = await this.client.listMemories(this.agentId, { limit: RECOVERY_LIST_LIMIT });
			const candidates = memories.filter(
				memory =>
					memory.id !== undefined &&
					memory.memory_type === "episodic" &&
					isRecord(memory.metadata) &&
					memory.metadata["omp-transcript"] === true,
			);
			if (candidates.length === 0) return;
			const latest = candidates.reduce((best, current) =>
				(timestampOf(current.updated_at) ?? 0) > (timestampOf(best.updated_at) ?? 0) ? current : best,
			);
			if (latest.id) this.#transcriptMemoryId = latest.id;
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: transcript memory recovery failed", { agentId: this.agentId, error: String(err) });
			}
			this.#sessionRecoveredFor = undefined;
		}
	}

	/**
	 * Close the server-side session row with a final summary. Called from
	 * session disposal AFTER `awaitPending()` settled — closing while a
	 * just-fired auto-retain is still in flight would seal a session row
	 * that does not yet contain the final transcript write. Failed close is
	 * non-fatal and must not mask the pending-drain step that follows it.
	 */
	async endSessionWithSummary(summary: string): Promise<void> {
		try {
			// sessionStart() records a server-minted id for older servers; the
			// requested id is only advisory there, so close what was opened.
			await this.client.sessionEnd(this.agentId, this.#serverSessionId ?? this.sessionId, summary);
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: session end failed", { agentId: this.agentId, error: String(err) });
			}
		}
	}

	/** Render the closing summary for the UI/session row from the final exchange. */
	buildClosingSummary(): string | undefined {
		const messages = extractMessages(this.session.sessionManager);
		const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
		if (!lastAssistant) return undefined;
		const text = lastAssistant.content.trim();
		if (text.length < 10) return undefined;
		return text.length > 500 ? `${text.slice(0, 500)}…` : text;
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.#autonomous || !this.config.autoRetain) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		// A turn aborted with ESC still fires `agent_end` — with the user prompt
		// present and no assistant reply yet. Storing that husk and advancing the
		// cursor would lose the real answer when the resumed turn completes (the
		// delta check is already spent). Skip; the next completed agent_end
		// re-slices the same window with the reply in it.
		if (messages[messages.length - 1]?.role === "user") return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;

		try {
			await this.retainTranscript(messages);
			this.lastRetainedTurn = userTurns;
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn("Dakera: auto-retain failed", {
				sessionId: this.sessionId,
				agentId: this.agentId,
				error: errorText,
			});
			this.session.emitNotice("warning", `Memory retention failed: ${errorText}`, "Dakera");
		}
	}

	async #recallForContext(query: string): Promise<RecallOutcome> {
		try {
			const { text } = await this.recallFormatted(query);
			if (!text) return { context: null, ok: true };
			return {
				context: `<memories>\n${DAKERA_RECALL_PREAMBLE}\n\n${text}\n</memories>`,
				ok: true,
			};
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: recall failed", { agentId: this.agentId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	/** Stage the first-turn recall; `commit` publishes it only while this turn still owns the generation. */
	async beforeAgentStartPrompt(promptText: string): Promise<MemoryPromptPreparation | undefined> {
		if (!this.#autonomous || !this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		const generation = ++this.#recallGeneration;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.#recallForContext(truncated);
		if (!ok) return undefined;

		return {
			context: context ?? undefined,
			commit: () => {
				if (this.#recallGeneration !== generation) return false;
				this.hasRecalledForFirstTurn = true;
				if (context) this.lastRecallSnippet = context;
				return true;
			},
		};
	}

	/** Recall over the messages about to be summarized, for compaction context. */
	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.#recallForContext(truncated);
		return context ?? undefined;
	}

	/**
	 * Let a fast exit wait for writes already in flight instead of dropping them.
	 *
	 * No deadline — session disposal awaits this plainly, so a server
	 * that never answers holds the exit open until its own socket timeout fires.
	 * Upgrade path is a bounded drain like the Sharpshooter flush beside it.
	 */
	async awaitPending(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
	}

	/** Keep a fire-and-forget retain observable so disposal can wait for it. */
	#track(promise: Promise<unknown>): void {
		const tracked = promise.then(
			() => undefined,
			() => undefined,
		);
		this.#pending.add(tracked);
		void tracked.finally(() => {
			this.#pending.delete(tracked);
		});
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		if (!this.#autonomous) return;
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_end") this.#track(this.maybeRetainOnAgentEnd());
		});
	}

	dispose(): void {
		this.#recallGeneration++;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
