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

import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
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
	type DakeraDocumentImportResult,
	type DakeraMemoryType,
	type DakeraRecallHit,
	type DakeraStoreInput,
	collectMemoryIds,
	formatDakeraTimestamp,
	recallHitRank,
} from "./client";
import { DAKERA_RECALL_PREAMBLE, type DakeraConfig } from "./config";
import { type DocIngest, docIngestSourceFor, docTextOf } from "./ingest";

/** Server-side content ceiling (per its INVALID_REQUEST); truncate below it. */
const SERVER_CONTENT_LIMIT = 99_000;
/** Below this a tool result is a snippet, not a document worth importing. */
const AUTO_INGEST_MIN_CHARS = 200;
/** Metadata key storing the session id owning a full-session transcript row. */
const OMP_TRANSCRIPT_MARKER_KEY = "omp-transcript";

/** Upper bound for recoverTranscriptMemory()'s listing. */
const RECOVERY_LIST_LIMIT = 1_000;

/** Normalize a server timestamp (epoch millis or ISO-8601) to millis, or undefined when absent/invalid. */
function timestampOf(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
/** Block-mode document index budget: pointer lines replace chunk text (paging pattern). */
const DOC_INDEX_TOKEN_LIMIT = 75;
/** Per-document index line display cap (title + heading). */
const DOC_INDEX_LINE_MAX = 80;
/** Document provenance the server stamps on document-chunk rows (tag `document:doc-*`). */
interface DakeraDocumentProvenance {
	title: string;
	chunk_index: number;
	chunk_count: number;
	heading_path?: string[];
}

function isDakeraDocumentProvenance(value: unknown): value is DakeraDocumentProvenance {
	if (!isRecord(value)) return false;
	if (!("title" in value && "chunk_index" in value && "chunk_count" in value)) return false;
	return (
		typeof value.title === "string" && typeof value.chunk_index === "number" && typeof value.chunk_count === "number"
	);
}

/** `[doc:memory.md #15/18 «heading»]` when the row is a document chunk, else the plain memory_type tag. */
function recallTypeLabel(hit: DakeraRecallHit): string {
	const meta = hit.memory.metadata;
	const provenance = meta !== undefined && "_dakera_document" in meta ? meta._dakera_document : undefined;
	if (isDakeraDocumentProvenance(provenance)) {
		const heading = provenance.heading_path?.filter(part => part.length > 0).at(-1);
		const position = `#${provenance.chunk_index + 1}/${provenance.chunk_count}`;
		return ` [doc:${provenance.title} ${position}${heading ? ` «${heading}»` : ""}]`;
	}
	if (hit.memory.tags?.some(tag => tag.startsWith("document:"))) return " [document]";
	return hit.memory.memory_type ? ` [${hit.memory.memory_type}]` : "";
}

/** Document-chunk rows (server provenance, or just the `document:*` tag) collapse to an index line in block mode. */
function isDocRow(hit: DakeraRecallHit): boolean {
	const meta = hit.memory.metadata;
	if (meta !== undefined && "_dakera_document" in meta) return true;
	return hit.memory.tags?.some(tag => tag.startsWith("document:")) === true;
}

/** Cut a bullet body so `- ${body}${suffix}` fits `maxLineTokens`, at the last sentence
 * boundary (a mid-sentence cut reads as garbage). The ellipsis is accounted for.
 */
function truncateLineBody(body: string, maxLineTokens: number, suffix: string): string {
	if (countTokens(`- ${body}${suffix}`, Encoding.O200kBase) <= maxLineTokens) return body;
	let lo = 0;
	let hi = body.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (countTokens(`- ${body.slice(0, mid)}${suffix}`, Encoding.O200kBase) <= maxLineTokens) lo = mid;
		else hi = mid - 1;
	}
	const window = body.slice(0, lo);
	const cut = Math.max(
		window.lastIndexOf("."),
		window.lastIndexOf("!"),
		window.lastIndexOf("?"),
		window.lastIndexOf("\n"),
	);
	return cut >= window.length / 2 ? `${window.slice(0, cut + 1)}…` : `${window}…`;
}

/** Normalized-token Jaccard similarity of two texts (lowercase alphanumeric runs). */
function tokenJaccard(a: string, b: string): number {
	const setA = new Set(
		a
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean),
	);
	const setB = new Set(
		b
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean),
	);
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const token of setA) if (setB.has(token)) intersection += 1;
	return intersection / (setA.size + setB.size - intersection);
}

/** Id of the memory a curator/consolidation fragment was derived from, when the server reports it. */
function derivedFromMemoryId(hit: DakeraRecallHit): string | undefined {
	const meta = hit.memory.metadata;
	if (meta !== undefined && "source_memory_id" in meta && typeof meta.source_memory_id === "string") {
		return meta.source_memory_id;
	}
	const tag = hit.memory.tags?.find(value => value.startsWith("source:"));
	return tag?.slice("source:".length);
}
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
	/** Query of the last successful auto-recall; the re-recall gate measures overlap against it. */
	lastRecallQuery?: string;
	/** Wall-clock time of the last successful auto-recall (re-recall cooldown). */
	lastRecallAt?: number;
	unsubscribe?: () => void;
	#recallGeneration = 0;
	/** Agent-start prompts since the last successful auto-recall (re-recall distance gate). */
	#promptsSinceLastRecall = 0;
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
	/** Registration attempt still in flight; concurrent stores join it instead of passing the half-set guard. */
	#registrationInFlight?: Promise<void>;
	/** Session id whose transcript memory recovery already ran (or failed permanently). */
	#sessionRecoveredFor?: string;
	/** Tool arguments by call id, from `tool_execution_start` until the matching end (auto-ingest needs them). */
	#pendingToolArgs = new Map<string, unknown>();
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
		// The server row registered under the old provider id will never receive
		// another write — end it now instead of leaking an open row. Compaction
		// and context resets rekey several times per session, so skipping this
		// is what piled up open `memory_count: 0` rows in the Dakera UI.
		const orphan = this.#serverSessionId;
		if (orphan !== undefined) this.#track(this.#endServerSession(orphan, "omp: provider session rekeyed"));
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
		this.lastRecallQuery = undefined;
		this.lastRecallAt = undefined;
		this.#promptsSinceLastRecall = 0;
		this.#transcriptMemoryId = undefined;
	}

	/**
	 * Durable owner id for the full-session transcript row's metadata marker.
	 *
	 * `this.sessionId` is the *provider* session id: `freshSession()`, `resetContext()`
	 * and compaction rekeys rotate it to a fresh UUIDv7, and a cold process only
	 * falls back to the session-manager id — so a row stamped with it could never
	 * be matched again after a restart, exactly the duplicate `recoverTranscriptMemory()`
	 * exists to prevent. The session file's id is stable across resume by construction
	 * (re-read from the header), making it the durable owner.
	 *
	 * `undefined` while no session file is open (`#sessionId` starts empty): an
	 * empty marker would be shared by every such state and re-create the
	 * cross-session adoption the id scoping exists to prevent, so callers treat
	 * it as "do not stamp, do not match".
	 */
	#transcriptOwnerId(): string | undefined {
		const id = this.session.sessionManager.getSessionId();
		if (!id) return undefined;
		// #store routes metadata through redactMemoryTextFields, whose nested-string
		// walk redacts this marker value; compare against the same transform so the
		// pair stays byte-equal even if id shapes ever grow a credential-looking run.
		return redactMemorySecrets(id);
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
		const ranked = [...hits].sort((a, b) => recallHitRank(b) - recallHitRank(a));
		// The server honors top_k on 0.12.3 (probed 2026-10-31: top_k=2 → 2 hits) but
		// appends `retrieval: "neighborhood"` rows past it (top_k=8 → 9), and older
		// builds ignored it entirely. Trim here so the knob always means "top-K by
		// final rank", regardless of server version or association expansion.
		return ranked.slice(0, this.config.recallTopK);
	}

	/** One recall for both consumers: ranked hits plus the `- content [type] (date)` list they render to.
	 *
	 * `mode: "block"` (auto-recall injection) collapses document chunks to one
	 * index line per document; `mode: "pull"` (the `recall` tool) renders chunk
	 * bodies with their provenance.
	 *
	 * Injection budget: the server returns a reranked mix of full turn transcripts
	 * plus their derived fragments (and up to top_k such rows), so an untrimmed
	 * block grows to 10–20k characters (~3–6k tokens) and lands in every prompt.
	 * The renderer keeps semantic fragments whole, truncates episodic transcripts
	 * (the full dialog stays in the session JSONL), and caps the total block.
	 */
	async recallFormatted(
		query: string,
		signal?: AbortSignal,
		mode: "block" | "pull" = "pull",
	): Promise<{ hits: DakeraRecallHit[]; text: string; renderedCount: number }> {
		const hits = await this.recallHits(query, signal);
		const { text, renderedCount } = this.#renderRecallBlock(hits, this.config.recallBlockTokens, mode);
		if (this.config.debug) {
			logger.debug("Dakera: recall", {
				agentId: this.agentId,
				query: query.slice(0, 80),
				hits: hits.length,
				rendered: renderedCount,
				chars: text.length,
			});
		}
		return { hits, text, renderedCount };
	}

	/** One pointer line per document for block mode: title, deepest heading, chunk count.
	 * The chunk bodies stay behind the `recall` tool (index in the block, body on pull).
	 */
	#docIndexLines(rows: DakeraRecallHit[]): string[] {
		interface DocGroup {
			title: string | undefined;
			heading: string | undefined;
			chunkCount: number | undefined;
			seen: number;
		}
		const groups = new Map<string, DocGroup>();
		for (const hit of rows) {
			if (!isDocRow(hit)) continue;
			const meta = hit.memory.metadata;
			const candidate = meta !== undefined && "_dakera_document" in meta ? meta._dakera_document : undefined;
			const provenance = isDakeraDocumentProvenance(candidate) ? candidate : undefined;
			const key = hit.memory.tags?.find(value => value.startsWith("document:")) ?? provenance?.title ?? "?";
			const group = groups.get(key) ?? {
				title: provenance?.title,
				heading: undefined,
				chunkCount: undefined,
				seen: 0,
			};
			group.seen += 1;
			const heading = provenance?.heading_path?.filter(part => part.length > 0).at(-1);
			if (group.heading === undefined && heading !== undefined) group.heading = heading;
			if (provenance?.chunk_count !== undefined) group.chunkCount = provenance.chunk_count;
			groups.set(key, group);
		}
		const lines: string[] = [];
		let used = 0;
		for (const group of groups.values()) {
			const heading = group.heading ? ` «${group.heading}»` : "";
			const count = group.chunkCount ?? group.seen;
			const title = group.title ?? "документ без метаданных";
			const line = `- ${title}${heading} — ${count} чанков`;
			const trimmed = line.length > DOC_INDEX_LINE_MAX ? `${line.slice(0, DOC_INDEX_LINE_MAX)}…` : line;
			const cost = countTokens(trimmed, Encoding.O200kBase);
			if (used + cost > DOC_INDEX_TOKEN_LIMIT) break;
			lines.push(trimmed);
			used += cost;
		}
		return lines;
	}

	/** Render the block within the token budget (exact native tokenizer): in `block` mode
	 * document chunks collapse to one index line per document first. Hits pack in rank
	 * order (best first, so the top-ranked keys are always present): items that fit
	 * render whole; one that does not is cut, at a sentence boundary, to its fair
	 * share (a third of the budget) so it cannot starve the hits behind it. The
	 * running total counts join separators conservatively, so the budget is exact.
	 * Reports how many lines survived, so headers can count what the model actually
	 * sees instead of the pre-cut hit list.
	 */
	#renderRecallBlock(
		hits: DakeraRecallHit[],
		tokenLimit: number,
		mode: "block" | "pull",
	): { text: string; renderedCount: number } {
		const parts: string[] = [];
		let used = 0;
		const giantFloor = Math.floor(tokenLimit / 3);
		// The server returns a transcript plus fragments derived from it; rendering both double-spends the budget.
		const renderedIds = new Set<string>();
		const supersededIds = new Set<string>();
		const push = (hit: DakeraRecallHit): boolean => {
			const id = hit.memory.id;
			if (id !== undefined && renderedIds.has(id)) return false;
			// Two tokens is the conservative cost of a "\n\n" join.
			const separator = parts.length > 0 ? 2 : 0;
			const remaining = tokenLimit - used - separator;
			if (remaining <= 0) return false;
			const raw = hit.memory.content.replace(/\s+\n/g, "\n").trim();
			const typeStr = recallTypeLabel(hit);
			const dateStr = formatDakeraTimestamp(hit.memory.created_at);
			const suffix = `${typeStr}${dateStr ? ` (${dateStr})` : ""}`;
			const full = `- ${raw}${suffix}`;
			let rendered = full;
			const fullTokens = countTokens(full, Encoding.O200kBase);
			// Every item costs at most its fair share (a third of the budget): a bigger
			// one is cut at a sentence boundary to that share, so the top-ranked hits
			// can never starve each other and each keeps its head (key) visible.
			// Bench-proven: uncapped heads left later top-3 hits with a sub-key tail.
			const share = Math.min(giantFloor, remaining);
			if (fullTokens > share) {
				rendered = `- ${truncateLineBody(raw, share, suffix)}${suffix}`;
			}
			if (id !== undefined) renderedIds.add(id);
			const sourceId = derivedFromMemoryId(hit);
			if (sourceId !== undefined) supersededIds.add(sourceId);
			parts.push(rendered);
			used += countTokens(rendered, Encoding.O200kBase) + separator;
			return true;
		};
		if (mode === "block") {
			for (const line of this.#docIndexLines(hits)) {
				const separator = parts.length > 0 ? 2 : 0;
				parts.push(line);
				used += countTokens(line, Encoding.O200kBase) + separator;
			}
		}
		for (const hit of hits) {
			if (mode === "block" && isDocRow(hit)) continue;
			if (hit.memory.id !== undefined && supersededIds.has(hit.memory.id)) continue;
			if (used >= tokenLimit) break;
			push(hit);
		}
		return { text: parts.join("\n\n"), renderedCount: parts.length };
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
		// A store entering while a registration is still in flight must join it:
		// the fast guard below is set synchronously before the server answers, so
		// checking it first would let the joiner stamp its rows with the local
		// session id. A failed attempt keeps the documented local-id grouping; the
		// next store retries.
		if (this.#registrationInFlight) {
			await this.#registrationInFlight;
			return;
		}
		if (this.#sessionRegisteredFor === this.sessionId) return;
		const generation = this.#retainGeneration;
		const requestedId = this.sessionId;
		this.#sessionRegisteredFor = requestedId;
		const attempt = this.#registerServerSession(generation, requestedId);
		this.#registrationInFlight = attempt;
		try {
			await attempt;
		} finally {
			if (this.#registrationInFlight === attempt) this.#registrationInFlight = undefined;
		}
	}

	async #registerServerSession(generation: number, requestedId: string): Promise<void> {
		try {
			const serverId = await this.client.sessionStart(this.agentId, requestedId, {
				source: "omp",
				cwd: this.session.sessionManager?.getCwd?.(),
			});
			// A rekey raced the registration: the row was created server-side but
			// the store that would fill it was just invalidated — end it now or it
			// leaks as an open `memory_count: 0` row forever (this race is where
			// the open rows in the Dakera UI came from), then re-register on the
			// next store under the new id.
			if (this.#retainGeneration !== generation || this.sessionId !== requestedId) {
				this.#sessionRegisteredFor = undefined;
				this.#serverSessionId = undefined;
				this.#track(this.#endServerSession(serverId, "omp: abandoned registration"));
				return;
			}
			if (serverId) {
				this.#serverSessionId = serverId;
				if (this.config.debug) {
					logger.debug("Dakera: session registered", { agentId: this.agentId, sessionId: serverId });
				}
			}
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
		const generation = this.#retainGeneration;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		await this.#enqueueTranscript(() => this.#publishTranscript(messages, true));
		// A reset/clear landing mid-publish zeroes the cursor; the stale count
		// would suppress every later auto-retain in the new conversation.
		if (this.#retainGeneration === generation) {
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		}
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
			// A rekey/clear that landed during the listing invalidated this
			// continuation's content — writing it (update or store) would seed
			// the new session state with the old conversation.
			if (this.#retainGeneration !== generation) return;
		}
		const existing = this.#transcriptMemoryId;
		if (existing && !lastTurn) {
			// `full-session` rewrites the whole transcript each retain, so
			// the server re-extracts facts from already-processed turns — O(turns²)
			// per session. `last-turn` avoids it by storing each window separately.
			await this.client.update(this.agentId, existing, content);
			if (this.config.debug) {
				logger.debug("Dakera: transcript updated in place", {
					agentId: this.agentId,
					rowId: existing,
					chars: content.length,
				});
			}
			return;
		}
		// `last-turn` keeps every window as its own episodic memory — updating one
		// row in place would overwrite the previous window's history.
		// No owner id (no session file open) → no marker: an empty-string marker
		// would be shared by every such state, so the row stays unadoptable rather
		// than wrongly adoptable.
		const owner = this.#transcriptOwnerId();
		const [id] = await this.#store([
			{
				content,
				memoryType: "episodic",
				importance: this.config.retainImportance,
				metadata: owner ? { [OMP_TRANSCRIPT_MARKER_KEY]: owner } : undefined,
			},
		]);
		// No id means the server answered in a shape we cannot address; the next
		// retain stores again rather than silently keeping nothing durable.
		if (this.#retainGeneration !== generation) return;
		if (id && !lastTurn) this.#transcriptMemoryId = id;
		if (this.config.debug) {
			logger.debug("Dakera: transcript stored", {
				agentId: this.agentId,
				rowId: id,
				owner: owner ?? "(none)",
				chars: content.length,
			});
		}
	}

	/**
	 * A resumed session constructs a fresh state, so the in-process
	 * `#transcriptMemoryId` is gone. Recover the row the previous process
	 * maintained by listing this agent's memories and matching the
	 * `omp-transcript` marker stored with every full-session publish —
	 * otherwise resume would POST a second transcript row per session.
	 *
	 * The marker carries this session's durable omp id (see {@link DakeraSessionState.#transcriptOwnerId}),
	 * so two sessions sharing an agent id cannot adopt and overwrite each other's
	 * transcript. Duplicate rows for one id can only come from a failed recovery
	 * (listing capped or errored) followed by a store; they pick the most recently updated.
	 */
	async recoverTranscriptMemory(): Promise<void> {
		if (this.#transcriptMemoryId !== undefined || this.config.retainMode !== "full-session") return;
		if (this.#sessionRecoveredFor === this.sessionId) return;
		const owner = this.#transcriptOwnerId();
		// No durable owner id (no session file open): nothing to match — an
		// empty marker is shared by every such state and must adopt nothing.
		if (owner === undefined) return;
		const generation = this.#retainGeneration;
		this.#sessionRecoveredFor = this.sessionId;
		try {
			const memories = await this.client.listMemories(this.agentId, { limit: RECOVERY_LIST_LIMIT });
			// A rekey or conversation reset landed while the listing was in
			// flight: adopting a row now would resurrect an id the reset just
			// invalidated — the caller's own re-check protects its write, but
			// the adopted id would send the next publish into the update branch
			// against the previous conversation's transcript row.
			if (this.#retainGeneration !== generation) return;
			const candidates = memories.filter(
				memory =>
					memory.id !== undefined &&
					memory.memory_type === "episodic" &&
					isRecord(memory.metadata) &&
					memory.metadata[OMP_TRANSCRIPT_MARKER_KEY] === owner,
			);
			if (candidates.length === 0) return;
			const latest = candidates.reduce((best, current) =>
				(timestampOf(current.updated_at) ?? 0) > (timestampOf(best.updated_at) ?? 0) ? current : best,
			);
			if (latest.id) {
				this.#transcriptMemoryId = latest.id;
				if (this.config.debug) {
					logger.debug("Dakera: transcript row recovered", { agentId: this.agentId, rowId: latest.id, owner });
				}
			}
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
		await this.#endServerSession(this.#serverSessionId, summary);
	}

	async #endServerSession(serverId: string | undefined, summary: string): Promise<void> {
		// Only close what the server actually opened: `sessionStart` may never
		// have run (no store this session) or answered without a minted id, and
		// ending the local id would target a row that does not exist server-side.
		if (serverId === undefined) return;
		try {
			await this.client.sessionEnd(this.agentId, serverId, summary);
			if (this.config.debug) {
				logger.debug("Dakera: session ended", {
					agentId: this.agentId,
					sessionId: serverId,
					summary: summary.slice(0, 80),
				});
			}
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
		const generation = this.#retainGeneration;
		try {
			await this.retainTranscript(messages);
			// A reset/clear that landed during the publish already zeroed the
			// cursor; restoring the pre-await count would suppress every later
			// auto-retain in the new conversation (the delta check never re-fires).
			if (this.#retainGeneration !== generation) return;
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
			const { text } = await this.recallFormatted(query, undefined, "block");
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

	/** Stage the auto-recall; `commit` publishes it only while this turn still owns the generation.
	 *
	 * The first turn injects the block through the preparation. A re-recall (the
	 * topic-shift gate passed) REPLACES the sticky block instead of appending —
	 * the snippet is swapped first and the base prompt rebuilt around it, so the
	 * old block leaves with the rebuild. Mid-session rebuilds are kept rare (they
	 * bust the provider prompt-cache prefix, #11961) by the gate's cooldown and
	 * prompt-distance checks.
	 */
	async beforeAgentStartPrompt(promptText: string): Promise<MemoryPromptPreparation | undefined> {
		if (!this.#autonomous || !this.config.autoRecall) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		const firstTurn = !this.hasRecalledForFirstTurn;
		if (!firstTurn) {
			this.#promptsSinceLastRecall += 1;
			if (!this.#topicShifted(latestPrompt)) return undefined;
		}
		const generation = ++this.#recallGeneration;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.#recallForContext(truncated);
		if (!ok) return undefined;
		if (this.#recallGeneration !== generation) return undefined;

		if (firstTurn) {
			return {
				context: context ?? undefined,
				commit: () => {
					if (this.#recallGeneration !== generation) return false;
					this.#recordRecall(truncated, context);
					return true;
				},
			};
		}
		// Re-recall: an empty result keeps the current block; a real one swaps it.
		// The write happens before `commit` on purpose (the base rebuild needs the
		// new snippet); the generation guard makes a superseded turn a no-op.
		if (!context) return undefined;
		this.#recordRecall(truncated, context);
		try {
			await this.session.refreshBaseSystemPrompt(() => this.#recallGeneration === generation);
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: prompt refresh after re-recall failed", { error: String(err) });
			}
		}
		return { context: undefined, commit: () => this.#recallGeneration === generation };
	}

	/** Bookkeeping for a successful auto-recall: the block, its query, the cooldown clock, the prompt distance. */
	#recordRecall(query: string, context: string | null): void {
		this.hasRecalledForFirstTurn = true;
		if (context) this.lastRecallSnippet = context;
		this.lastRecallQuery = query;
		this.lastRecallAt = Date.now();
		this.#promptsSinceLastRecall = 0;
	}

	/** Re-recall gate: enough prompt distance and cooldown elapsed, and the topic demonstrably moved. */
	#topicShifted(latestPrompt: string): boolean {
		if (this.#promptsSinceLastRecall < this.config.reRecallMinTurns) return false;
		if (Date.now() - (this.lastRecallAt ?? 0) < this.config.reRecallMinIntervalMs) return false;
		return tokenJaccard(this.lastRecallQuery ?? "", latestPrompt) < this.config.reRecallOverlapThreshold;
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
			if (event.type === "agent_end") {
				this.#track(this.maybeRetainOnAgentEnd());
				return;
			}
			if (event.type === "tool_execution_start") {
				this.#pendingToolArgs.set(event.toolCallId, event.args);
				return;
			}
			if (event.type === "tool_execution_end") {
				const args = this.#pendingToolArgs.get(event.toolCallId);
				this.#pendingToolArgs.delete(event.toolCallId);
				if (!event.isError && args !== undefined) this.#maybeIngestToolResult(event.toolName, args, event.result);
			}
		});
	}

	/** Store a document server-side: the server chunks it, embeds the chunks and stamps their provenance. */
	async ingestDocument(ingest: DocIngest): Promise<DakeraDocumentImportResult> {
		return this.client.importDocument(this.agentId, {
			content: ingest.content,
			mediaType: ingest.mediaType,
			title: ingest.title,
			documentId: ingest.documentId,
		});
	}

	/** Auto-ingest hook: a successful whitelisted tool result becomes a document import. */
	#maybeIngestToolResult(toolName: string, args: unknown, result: unknown): void {
		if (!this.config.ingestToolResults.includes(toolName)) return;
		const source = docIngestSourceFor(toolName);
		if (!source) return;
		const text = docTextOf(result);
		// A snippet is not a document; tiny results would only churn the store.
		if (!text || text.length < AUTO_INGEST_MIN_CHARS) return;
		const ingest = source.extract(isRecord(args) ? args : {}, text);
		if (!ingest) return;
		this.#track(
			this.ingestDocument(ingest).then(imported => {
				if (this.config.debug) {
					logger.debug("Dakera: document auto-ingested", { toolName, documentId: imported.documentId });
				}
			}),
		);
	}

	dispose(): void {
		this.#recallGeneration++;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
