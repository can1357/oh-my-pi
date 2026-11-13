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
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import {
	composeRecallQuery,
	type HindsightMessage,
	prepareRetentionTranscript,
	shearMemoryContent,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import { redactMemorySecrets, redactMemoryTextFields } from "../memory-backend/redact";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession } from "../session/agent-session";
import { withTimeoutSignal } from "../utils/fetch-timeout";
import {
	type DakeraApi,
	type DakeraDocumentImportResult,
	type DakeraMemory,
	type DakeraMemoryType,
	type DakeraRecallHit,
	type DakeraRecallOptions,
	type DakeraStoreInput,
	collectMemoryIds,
	formatDakeraTimestamp,
	recallHitRank,
} from "./client";
import { DAKERA_DELTA_PREAMBLE, DAKERA_PROFILE_PREAMBLE, DAKERA_RECALL_PREAMBLE, type DakeraConfig } from "./config";
import { ConflictLedger } from "./conflicts";
import { extractiveHandoff, isDegenerateHandoff, synthesizeHandoff } from "./handoff";
import { type DocIngest, docIngestSourceFor, docTextOf } from "./ingest";
import { runDakeraReflect } from "./reflect";
import { detectSuspectContent } from "./suspect";
import { collectTouchedPaths, filterTriggerHits, parseDakeraTrigger, type DakeraTriggerSpec } from "./triggers";

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

/**
 * Normalize a server timestamp to epoch MILLIS so it can be compared against
 * `Date.now()`-derived cutoffs.
 *
 * The engine sends Unix SECONDS (`formatDakeraTimestamp` multiplies by 1000),
 * while {@link timestampOf} passes numbers through untouched — comparing a
 * seconds value against a millis cutoff reads every fresh row as 1970 and would
 * sweep the whole agent on the first close. The 1e12 boundary separates the
 * conventions cleanly: seconds reach it in year 33658, millis in 2001-09 (all
 * memory rows are on the near side of one convention or the other). ISO-8601
 * strings parse straight to millis.
 */
function serverTimestampOf(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		return value < 1e12 ? value * 1000 : value;
	}
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * No-model compaction fallback: the newest {@link EXTRACTIVE_SUMMARY_ROWS} cold
 * rows, first {@link EXTRACTIVE_SUMMARY_CHARS} of each, one per line — enough
 * to keep the sweep's outcome visible (and the sources marked) without a model.
 */
const EXTRACTIVE_SUMMARY_ROWS = 10;
const EXTRACTIVE_SUMMARY_CHARS = 200;
function extractiveSummary(newestFirst: DakeraMemory[]): string {
	return newestFirst
		.slice(0, EXTRACTIVE_SUMMARY_ROWS)
		.map(memory => {
			const head = memory.content.trim().slice(0, EXTRACTIVE_SUMMARY_CHARS);
			return head.length < memory.content.trim().length ? `${head}…` : head;
		})
		.join("\n");
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

/** A row carrying a parsable `metadata.trigger` — the deterministic-surfacing channel. */
function isTriggeredRow(hit: DakeraRecallHit): boolean {
	return parseDakeraTrigger(hit.memory.metadata) !== undefined;
}

/**
 * Block-mode precedence ladder (auto-injected context is curated, not a
 * scoreboard): the previous session's handoff leads, then triggered mandates,
 * then procedures by execution evidence, then everything else in server-rank
 * order (the sort is stable). Ledger-marked conflicts sink past everything —
 * a contradicted fact is noise — and injection-shaped rows sink past even those.
 * Research basis: DAKERA_FRONTIER_RESEARCH.md Tier A.
 *
 * @returns 0 handoff · 1 triggered · 2 verified procedure · 3 unverified procedure · 4 fact · 5 outdated · 6 suspect
 */
function recallTier(
	hit: DakeraRecallHit,
	isOutdated: (id: string) => boolean,
	isSuspect: (hit: DakeraRecallHit) => boolean,
): number {
	const memory = hit.memory;
	if (isSuspect(hit)) return 6;
	if (memory.id !== undefined && isOutdated(memory.id)) return 5;
	if (memory.tags?.includes("handoff")) return 0;
	if (isTriggeredRow(hit)) return 1;
	if (memory.memory_type === "procedural") return memory.metadata?.verified === true ? 2 : 3;
	return 4;
}

/** Public/global-mixed rows sink below per-project rows of the same tier (per-project is the default scope). */
function scopeRank(hit: DakeraRecallHit, globalTag: string): 0 | 1 {
	return hit.memory.tags?.includes(globalTag) === true ? 1 : 0;
}

/** Compacted-source rows: marked `compacted` at close, or carrying the content prefix when tags were lost. */
function isCompactedRow(hit: DakeraRecallHit): boolean {
	if (hit.memory.tags?.includes("compacted") === true) return true;
	return hit.memory.content.startsWith("[compacted]");
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

/** Compare form for supersede matching: lowercase, collapse every non-alphanumeric run to one space. */
function normalizeForCompare(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Below this, a retain item is a label, not a fact worth supersede's recall round-trip. */
const SUPERSEDE_MIN_CHARS = 40;

/** Jaccard floor at which a near-miss recall hit counts as a conflict worth marking (below supersede, above noise). */
const CONFLICT_NEAR_MIN = 0.4;

/** Outcome of the retain supersede probe: an in-place match and/or the best near-miss conflict. */
interface SupersedeProbe {
	matched?: { id: string; metadata?: Record<string, unknown> };
	conflict?: { id: string; near: number };
}

/** Recall query that surfaces the previous session's handoff row on a first turn
 * (mirrors the four handoff labels, so the query and the row content share tokens). */
const HANDOFF_RECALL_QUERY = "handoff: where we stopped, what failed, still open, next step";
/** Always-in profile tier budget (exact native tokenizer); the section holds standing facts, not recall. */
const PROFILE_TOKEN_BUDGET = 250;

/** Close time of a lead handoff: its `closed_at` metadata, else the row's server
 * timestamp (Unix seconds on every probed endpoint), else 0 (sorts last). */
function handoffClosedAt(hit: DakeraRecallHit): number {
	const closed = hit.memory.metadata?.closed_at;
	if (typeof closed === "string") {
		const parsed = Date.parse(closed);
		if (Number.isFinite(parsed)) return parsed;
	}
	const created = hit.memory.created_at;
	if (typeof created === "number") return created * 1000;
	if (typeof created === "string") {
		const parsed = Date.parse(created);
		if (Number.isFinite(parsed)) return parsed;
		const numeric = Number(created);
		return Number.isFinite(numeric) ? numeric * 1000 : 0;
	}
	return 0;
}

/** Drop repeated memory ids, keeping the first (best) occurrence — handoff rows must keep their lead slot. */
function dedupeHits(hits: DakeraRecallHit[]): DakeraRecallHit[] {
	const seen = new Set<string>();
	return hits.filter(hit => {
		const id = hit.memory.id;
		if (id === undefined) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
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
	/** Execution evidence: the procedure was run and its checks passed. */
	verified?: boolean;
	/** Extra row tags merged after the scope tags; `profile` opts a row into the always-in tier. */
	tags?: string[];
	/** Deterministic surfacing spec; pre-validated by the retain tool, re-checked by `parseDakeraTrigger` at recall. */
	trigger?: DakeraTriggerSpec;
}

/**
 * Metadata persisted for a retain row: `context` provenance plus the
 * verified/trigger fields when present. Absent fields stay absent — the
 * renderer distinguishes "never verified" (no key) from "explicitly
 * unverified" (`verified: false`), and an absent trigger keeps the row out of
 * the deterministic channel entirely. `suspect` is the audit trail for the
 * content-risk heuristic (mark, never delete); the render-time check is the
 * actual defense — rows can also reach the server past this client.
 */
function retainedMetadata(item: DakeraRetainItem): Record<string, unknown> | undefined {
	const metadata: Record<string, unknown> = {};
	if (item.context) metadata.context = item.context;
	if (item.verified !== undefined) metadata.verified = item.verified;
	if (item.trigger !== undefined) metadata.trigger = item.trigger;
	const suspect = detectSuspectContent(item.content);
	if (suspect !== undefined) metadata.suspect = suspect;
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
	/** Ids rendered into the block; the caller marks them delivered at commit. */
	renderedIds: string[];
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
	/** Conflict-ledger file override (tests pin a scratch path; defaults under the agent dir). */
	conflictsPath?: string;
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
	/** Ids already delivered into some context (block, delta, pull): the delta re-sends nothing. */
	#deliveredIds = new Set<string>();
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
	/** Session row listing (limit 300), fetched once for triggers and the profile tier. */
	#listed?: DakeraMemory[];
	/**
	 * Near-duplicate conflict ledger, loaded lazily once; `undefined` (load
	 * failed) silences every conflict behavior. Sync reads only — the renderer
	 * must never await.
	 */
	#conflicts?: ConflictLedger;
	#conflictsAttempted = false;
	/** Ledger file; defaults under the agent dir, slugged per agent id (ids may contain `/`). */
	readonly #conflictsPath: string;
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
		this.#conflictsPath =
			options.conflictsPath ??
			path.join(getAgentDir(), "dakera", `${this.agentId.replace(/[^\w.-]+/gu, "_")}.conflicts.json`);
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
		// The context those rows reached is gone with the transcript; the new
		// conversation must see them again.
		this.#deliveredIds.clear();
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
	/** Recall hits ranked best-first, shared by the `recall` and `reflect` tools.
	 *
	 * `overrides` wins over the config-derived options — the `recall` tool passes
	 * narrowing params (`memory_type`, `tags`, `since`, `until`, `min_importance`)
	 * here; callers that pass nothing keep the configured recall unchanged.
	 */
	async recallHits(
		query: string,
		signal?: AbortSignal,
		overrides?: Partial<DakeraRecallOptions>,
	): Promise<DakeraRecallHit[]> {
		const hits = await this.client.recall(this.agentId, query, {
			topK: this.config.recallTopK,
			minImportance: this.config.recallMinImportance,
			rerank: this.config.recallRerank,
			tags: this.recallTags,
			// After the spread: the positional signal is the caller's cancellation
			// channel, so an overrides object with an explicit `signal: undefined`
			// key must not clobber it.
			...overrides,
			signal,
		});
		const ranked = [...hits].sort((a, b) => recallHitRank(b) - recallHitRank(a));
		// The server honors top_k on 0.12.3 (probed 2026-10-31: top_k=2 → 2 hits) but
		// appends `retrieval: "neighborhood"` rows past it (top_k=8 → 9), and older
		// builds ignored it entirely. Trim here so the knob always means "top-K by
		// final rank", regardless of server version or association expansion.
		return ranked.slice(0, overrides?.topK ?? this.config.recallTopK);
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
		overrides?: Partial<DakeraRecallOptions>,
	): Promise<{ hits: DakeraRecallHit[]; text: string; renderedCount: number }> {
		// Block rendering reads the conflict ledger synchronously; load it before
		// the first render (a no-op once loaded, and pull recall never needs it).
		if (mode === "block") await this.#ensureConflicts();
		const hits = await this.recallHits(query, signal, overrides);
		const { text, renderedCount, renderedIds } = this.#formatHits(hits, mode);
		for (const id of renderedIds) this.#deliveredIds.add(id);
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

	/**
	 * Render a pre-ranked hit list within the block budget. Split from
	 * {@link DakeraSessionState.recallFormatted} so the first-turn path can render
	 * a merged list (handoff rows first, then the query's hits) without a second
	 * recall round-trip.
	 */
	#formatHits(
		hits: DakeraRecallHit[],
		mode: "block" | "pull",
	): { text: string; renderedCount: number; renderedIds: string[] } {
		return this.#renderRecallBlock(hits, this.config.recallBlockTokens, mode);
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
			const title = group.title ?? "untitled document";
			const line = `- ${title}${heading} — ${count} ${count === 1 ? "chunk" : "chunks"}`;
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
	): { text: string; renderedCount: number; renderedIds: string[] } {
		const parts: string[] = [];
		let used = 0;
		const giantFloor = Math.floor(tokenLimit / 3);
		// The server returns a transcript plus fragments derived from it; rendering both double-spends the budget.
		const renderedIds = new Set<string>();
		const supersededIds = new Set<string>();
		// Render-time risk check is authoritative: rows reach the server past this
		// client too (direct API writes), so the write-time flag is only the audit
		// trail. Verdicts compute once here, not per sort comparison.
		const suspectVerdicts = new Map<DakeraRecallHit, "injection" | "wrapper" | undefined>();
		if (this.config.suspectFlagging) {
			for (const hit of hits) suspectVerdicts.set(hit, detectSuspectContent(hit.memory.content));
		}
		const isSuspect = (hit: DakeraRecallHit): boolean => suspectVerdicts.get(hit) === "injection";
		const push = (hit: DakeraRecallHit): boolean => {
			const id = hit.memory.id;
			if (id !== undefined && renderedIds.has(id)) return false;
			// Two tokens is the conservative cost of a "\n\n" join.
			const separator = parts.length > 0 ? 2 : 0;
			const remaining = tokenLimit - used - separator;
			if (remaining <= 0) return false;
			// Shear envelope wrapper tags: one hostile row must not close (or open)
			// an injected wrapper and shear the envelope (`stripMemoryTags` windows
			// depend on the wrappers staying balanced).
			const raw = shearMemoryContent(hit.memory.content.replace(/\s+\n/g, "\n").trim());
			const typeStr = recallTypeLabel(hit);
			// Execution evidence is surfaced, not hidden: an explicitly-unverified
			// procedure (verified === false, never a missing key) warns the reader.
			const unverifiedStr =
				hit.memory.memory_type === "procedural" && hit.memory.metadata?.verified === false ? " [unverified]" : "";
			// Block mode only: pull recall is explicit retrieval, where the caller
			// gets the rows it asked for, unannotated.
			const outdatedStr =
				mode === "block" && hit.memory.id !== undefined && this.#conflicts?.get(hit.memory.id) !== undefined
					? " [outdated?]"
					: "";
			// The risk verdict surfaces, it does not hide: the row stays visible,
			// demoted and marked, never deleted.
			const suspectStr = isSuspect(hit) ? " [suspect]" : "";
			const dateStr = formatDakeraTimestamp(hit.memory.created_at);
			const scoreStr = this.config.recallScoreHints ? ` s:${recallHitRank(hit).toFixed(2)}` : "";
			const suffix = `${typeStr}${unverifiedStr}${outdatedStr}${suspectStr}${dateStr ? ` (${dateStr})` : ""}${scoreStr}`;
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
		// Block mode reorders by the tier ladder (stable, so server rank survives
		// ties); pull mode keeps server order — the caller asked for the ranking.
		const isOutdated =
			this.#conflicts === undefined ? () => false : (id: string) => this.#conflicts?.get(id) !== undefined;
		const ordered =
			mode === "block"
				? hits.toSorted(
						(a, b) =>
							recallTier(a, isOutdated, isSuspect) - recallTier(b, isOutdated, isSuspect) ||
							scopeRank(a, this.config.globalTag) - scopeRank(b, this.config.globalTag),
					)
				: hits;
		for (const hit of ordered) {
			// Block mode (auto-injection) hides the compacted sources — their
			// summary row carries the distilled facts, and the raw transcripts
			// would crowd it out. Pull mode keeps them: `recall` is explicit
			// retrieval, where the source rows are what the caller asked for.
			if (mode === "block" && (isDocRow(hit) || isCompactedRow(hit))) continue;
			if (hit.memory.id !== undefined && supersededIds.has(hit.memory.id)) continue;
			if (used >= tokenLimit) break;
			push(hit);
		}
		return { text: parts.join("\n\n"), renderedCount: parts.length, renderedIds: [...renderedIds] };
	}

	/**
	 * Store caller-supplied memories (the `retain` tool, `/memory` save, `learn`).
	 *
	 * With `retainSupersede`, an item of at least {@link SUPERSEDE_MIN_CHARS} whose
	 * content matches an existing non-episodic recall hit at the configured Jaccard
	 * floor rewrites that row in place (stamping `metadata.restated_at`) instead of
	 * appending a near-duplicate — this is what keeps replaying the same facts every
	 * session from piling up rows. Recall misses/errors and update failures fall
	 * through to a plain store: a fact must never be dropped because the dedup
	 * path hiccuped.
	 */
	async retainItems(items: DakeraRetainItem[]): Promise<number> {
		const remaining: DakeraRetainItem[] = [];
		/** Conflict probes aligned by index with `remaining`. */
		const conflicts: (SupersedeProbe["conflict"] | undefined)[] = [];
		let superseded = 0;
		for (const item of items) {
			const probe =
				this.config.retainSupersede && item.content.trim().length >= SUPERSEDE_MIN_CHARS
					? await this.#supersedeTarget(item.content)
					: undefined;
			if (probe?.matched) {
				try {
					await this.client.update(
						this.agentId,
						probe.matched.id,
						redactMemoryTextFields({
							content: item.content,
							// Restated fields override the target's old values: a row
							// superseded by a verified/triggered restatement carries them.
							metadata: {
								...probe.matched.metadata,
								restated_at: new Date().toISOString(),
								...retainedMetadata(item),
							},
						}),
					);
					superseded += 1;
					if (this.config.debug) {
						logger.debug("Dakera: retain superseded a near-duplicate", {
							agentId: this.agentId,
							rowId: probe.matched.id,
							chars: item.content.length,
						});
					}
					continue;
				} catch (err) {
					if (this.config.debug) {
						logger.debug("Dakera: supersede update failed, storing instead", {
							rowId: probe.matched.id,
							error: String(err),
						});
					}
				}
			}
			remaining.push(item);
			conflicts.push(probe?.conflict);
		}
		const ids = await this.#store(
			remaining.map(item => ({
				content: item.content,
				memoryType: item.memoryType ?? "semantic",
				importance: item.importance ?? this.config.retainImportance,
				tags: item.tags?.length ? [...new Set([...(this.retainTags ?? []), ...item.tags])] : undefined,
				metadata: retainedMetadata(item),
			})),
		);
		// ids align with the non-empty subset of `remaining`, in order; a stored
		// row that landed near a below-threshold hit marks that hit outdated.
		// Mark-never-delete: the ledger only demotes the old row in the renderer.
		// The ledger loads lazily here — a retain batch with no conflicts never
		// pays the file read on the hot store path.
		if (this.config.conflictDetection && conflicts.some(entry => entry !== undefined)) {
			await this.#ensureConflicts();
			const storableIndex = remaining.reduce<number[]>((acc, item, index) => {
				if (item.content.trim().length > 0) acc.push(index);
				return acc;
			}, []);
			ids.forEach((id, position) => {
				const conflict = conflicts[storableIndex[position]];
				if (!id || !conflict || this.#conflicts === undefined) return;
				this.#conflicts.record(conflict.id, {
					supersededBy: id,
					at: new Date().toISOString(),
					near: conflict.near,
				});
				void this.#conflicts.flush().catch(err => {
					logger.debug("Dakera: conflict ledger flush failed", { agentId: this.agentId, error: String(err) });
				});
			});
		}
		return ids.length + superseded;
	}

	/**
	 * The existing row a retain item supersedes: the first recall hit that is a
	 * fact (not an episodic transcript, not a `handoff`/`compacted` row) whose
	 * content reaches the configured Jaccard floor against the item, or an exact
	 * normalized match. The same response also reports the best hit in the
	 * conflict band ({@link CONFLICT_NEAR_MIN} up to the floor) — a fact stored
	 * next to a near-miss is a likely contradiction, recorded in the client-side
	 * ledger so the renderer can demote the old row. A recall error returns an
	 * empty probe so the caller stores the item as its own row.
	 */
	async #supersedeTarget(content: string): Promise<SupersedeProbe> {
		let hits: DakeraRecallHit[];
		try {
			hits = await this.client.recall(this.agentId, content, {
				topK: 3,
				rerank: true,
				tags: this.recallTags,
			});
		} catch {
			return {};
		}
		const source = normalizeForCompare(content);
		let conflict: SupersedeProbe["conflict"];
		for (const hit of hits) {
			const memory = hit.memory;
			if (memory.id === undefined) continue;
			if (memory.memory_type === "episodic") continue;
			const tags = memory.tags ?? [];
			if (tags.includes("handoff") || tags.includes("compacted")) continue;
			const target = normalizeForCompare(memory.content);
			const similarity = target === source ? 1 : tokenJaccard(source, target);
			if (similarity >= this.config.retainSupersedeThreshold) {
				return {
					matched: { id: memory.id, metadata: isRecord(memory.metadata) ? memory.metadata : undefined },
					conflict,
				};
			}
			if (similarity >= CONFLICT_NEAR_MIN && conflict === undefined) {
				conflict = { id: memory.id, near: similarity };
			}
		}
		return { conflict };
	}

	/**
	 * Load the conflict ledger once per session; a load failure leaves it
	 * `undefined` and every conflict behavior silently off.
	 */
	async #ensureConflicts(): Promise<void> {
		if (this.#conflictsAttempted) return;
		this.#conflictsAttempted = true;
		try {
			this.#conflicts = await ConflictLedger.load(this.#conflictsPath);
		} catch (err) {
			this.#conflicts = undefined;
			logger.debug("Dakera: conflict ledger load failed", { agentId: this.agentId, error: String(err) });
		}
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
					// Caller tags win: handoff/compaction merge the scope tags in
					// themselves (they add `handoff`/`compacted-summary` alongside).
					// Everything else (retain, transcript) takes the scope tags.
					tags: input.tags ?? this.retainTags,
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
			await this.client.update(this.agentId, existing, { content });
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
	 *
	 * When handoffs are enabled, the four-label handoff row is stored BEFORE the
	 * server row ends: `#store` lazily registers the session, and storing after
	 * the end would open a fresh row. A failed handoff (no model, timeout, store
	 * error) is logged at debug and never blocks the close.
	 */
	async endSessionWithSummary(summary: string): Promise<void> {
		if (this.config.handoffEnabled && this.#autonomous) {
			try {
				const messages = extractMessages(this.session.sessionManager);
				const handoff = await synthesizeHandoff({
					config: this.config,
					settings: this.session.settings,
					modelRegistry: this.session.modelRegistry,
					sessionId: this.sessionId,
					messages,
					closingSummary: summary,
				}).catch(() => extractiveHandoff(messages, summary));
				// An all-placeholder handoff (empty close: the model echoed the
				// template, or extractive had nothing to cut) carries no
				// continuation fact — storing it would let the first-turn lead
				// probe promote dashes above real handoffs.
				if (isDegenerateHandoff(handoff)) {
					if (this.config.debug) {
						logger.debug("Dakera: skipping blank handoff", { agentId: this.agentId });
					}
				} else {
					await this.#store([
						{
							content: handoff,
							memoryType: "semantic",
							importance: 0.7,
							tags: [...(this.retainTags ?? []), "handoff"],
							metadata: { kind: "handoff", closed_at: new Date().toISOString() },
						},
					]);
				}
			} catch (err) {
				if (this.config.debug) {
					logger.debug("Dakera: handoff store failed", { agentId: this.agentId, error: String(err) });
				}
			}
		}
		// Fire-and-forget: compaction is a maintenance sweep, never a gate on
		// closing. `awaitPending()` (called by disposal) still drains it.
		if (this.config.compactColdEpisodic && this.#autonomous) {
			this.#track(this.#maybeCompactColdEpisodic());
		}
		// Persist the conflict ledger before the session row seals; a failed
		// flush must not block the close.
		try {
			await this.#conflicts?.flush();
		} catch (err) {
			logger.debug("Dakera: conflict ledger flush failed", { agentId: this.agentId, error: String(err) });
		}
		await this.#endServerSession(this.#serverSessionId, summary);
	}

	/**
	 * Summarize cold episodic rows into one semantic row and mark the sources
	 * `compacted` (with `metadata.compacted_into` pointing at the summary), so a
	 * later reader can reverse the sweep. Block-mode recall then skips the
	 * sources and carries only the summary; `recall` pull still reaches them.
	 *
	 * Reversible by design: rows are marked, never deleted — `forget` on the
	 * summary plus clearing the marks restores the originals. The sweep is
	 * bounded (2 pages, `compactMaxRows`, 60s) and every failure path leaves the
	 * sources untouched.
	 */
	async #maybeCompactColdEpisodic(): Promise<void> {
		const { config } = this;
		// One deadline for the whole sweep: client calls and the synthesis read
		// the signal, so a hung listing or model call aborts the run (the outer
		// catch logs it) instead of pinning session close open.
		const signal = withTimeoutSignal(60_000);
		try {
			const cutoff = Date.now() - config.compactAfterDays * 86_400_000;
			// Two pages max (1000 each) keeps the listing bounded even on a
			// large agent; rows past it wait for the next close.
			const candidates: DakeraMemory[] = [];
			for (const offset of [0, 1000]) {
				const page = await this.client.listMemories(this.agentId, { limit: 1000, offset, signal });
				candidates.push(...page);
				if (page.length < 1000) break;
			}
			const cold = candidates
				.filter(memory => {
					if (memory.memory_type !== "episodic") return false;
					if (memory.id === undefined) return false;
					const tags = memory.tags ?? [];
					if (tags.includes("compacted") || tags.includes("handoff")) return false;
					const created = serverTimestampOf(memory.created_at);
					if (created === undefined || created >= cutoff) return false;
					const accessed = serverTimestampOf(memory.last_accessed_at);
					return accessed === undefined || accessed < cutoff;
				})
				// Oldest first: the sweep compacts history, not last week.
				.sort((a, b) => (timestampOf(a.created_at) ?? 0) - (timestampOf(b.created_at) ?? 0))
				.slice(0, config.compactMaxRows);
			// Under two rows the sweep costs more than it saves (a summary of a
			// single transcript is just the transcript again).
			if (cold.length < 2) return;

			const selectedIds = cold.map(memory => memory.id).filter((id): id is string => typeof id === "string");
			const newest = cold
				.slice()
				.sort((a, b) => (timestampOf(b.created_at) ?? 0) - (timestampOf(a.created_at) ?? 0));
			const window = {
				from: formatDakeraTimestamp(newest.at(-1)?.created_at),
				to: formatDakeraTimestamp(newest[0]?.created_at),
			};
			const hits: DakeraRecallHit[] = cold.map(memory => ({ memory }));
			const summary = await runDakeraReflect({
				config,
				hits,
				settings: this.session.settings,
				modelRegistry: this.session.modelRegistry,
				sessionId: this.sessionId,
				query: "Distill the chronology into durable facts: decisions, file paths, errors, open questions",
				signal,
			}).catch(() => extractiveSummary(newest));
			const [summaryId] = await this.#store([
				{
					content: summary,
					memoryType: "semantic",
					importance: 0.6,
					tags: [...(this.retainTags ?? []), "compacted-summary"],
					metadata: { kind: "compacted-episodic", supersedes: selectedIds, window },
				},
			]);
			if (summaryId === undefined) return;
			// Mark every source with its summary pointer. A partial mark is fine:
			// unmarked rows are simply eligible for the next sweep again.
			for (const memory of cold) {
				if (memory.id === undefined) continue;
				await this.client.update(this.agentId, memory.id, {
					tags: [...(memory.tags ?? []), "compacted"],
					metadata: { ...memory.metadata, compacted_into: summaryId },
				});
			}
			if (this.config.debug) {
				logger.debug("Dakera: cold episodic compacted", {
					agentId: this.agentId,
					sources: cold.length,
					summaryId,
				});
			}
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: episodic compaction failed", { agentId: this.agentId, error: String(err) });
			}
		}
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

	/**
	 * The session's row listing, fetched once and shared: deterministic triggers
	 * and the always-in profile tier both read it, so neither costs a request per
	 * turn. A listing failure caches an empty pool — both are additive channels
	 * and must never fail recall.
	 */
	async #listedRows(): Promise<DakeraMemory[]> {
		if (this.#listed === undefined) {
			try {
				this.#listed = await this.client.listMemories(this.agentId, { limit: 300 });
			} catch (err) {
				this.#listed = [];
				logger.debug("Dakera: memory listing failed", { agentId: this.agentId, error: String(err) });
			}
		}
		return this.#listed;
	}

	/**
	 * Deterministic trigger rows for this query: the `metadata.trigger` pool is
	 * listed once per session (kept out of the embedding-score race), then
	 * filtered per call.
	 */
	async #triggerHits(query: string, touchedPaths: string[]): Promise<DakeraRecallHit[]> {
		if (!this.config.triggersEnabled) return [];
		const rows = (await this.#listedRows()).filter(
			memory => memory.memory_type !== "episodic" && parseDakeraTrigger(memory.metadata) !== undefined,
		);
		return filterTriggerHits(
			rows.map(memory => ({ memory })),
			{ query, touchedPaths },
		);
	}

	/**
	 * The always-in profile tier: rows the user tagged `profile`, surfaced with
	 * no retrieval semantics at all — stable facts never match query wording
	 * (the retrieval paradox). Fetched from the shared listing; own small budget;
	 * rendered inside every injected block context (first turn and each swap) so
	 * a rebuild can never drop it.
	 */
	async #profileSection(): Promise<{ text: string; renderedIds: string[] } | undefined> {
		if (!this.config.profileEnabled) return undefined;
		const rows = await this.#listedRows();
		const hits = rows
			.filter(memory => memory.memory_type !== "episodic" && memory.tags?.includes("profile") === true)
			.map(memory => ({ memory }));
		if (hits.length === 0) return undefined;
		const { text, renderedIds } = this.#renderRecallBlock(hits, PROFILE_TOKEN_BUDGET, "pull");
		if (!text) return undefined;
		return { text: `<profile>\n${DAKERA_PROFILE_PREAMBLE}\n\n${text}\n</profile>`, renderedIds };
	}

	/**
	 * A profile row that also matches the query keeps its profile slot only —
	 * one row renders once, in the tier the user curated it for.
	 */
	#withoutProfileRows(hits: DakeraRecallHit[], profileIds: ReadonlySet<string>): DakeraRecallHit[] {
		if (profileIds.size === 0) return hits;
		return hits.filter(hit => hit.memory.id === undefined || !profileIds.has(hit.memory.id));
	}

	async #recallForContext(
		query: string,
		leadHits?: DakeraRecallHit[],
		includeProfile = false,
	): Promise<RecallOutcome> {
		try {
			// Block mode renders ledger marks synchronously (see recallFormatted).
			await this.#ensureConflicts();
			const touchedPaths = collectTouchedPaths(this.session.sessionManager.getEntries());
			const triggerHits = await this.#triggerHits(query, touchedPaths);
			// The always-in profile tier rides every injected block context (first
			// turn and each swap), so a rebuild can never drop standing rules.
			const profile = includeProfile ? await this.#profileSection() : undefined;
			const profileIds = new Set(profile?.renderedIds ?? []);
			let text: string;
			let renderedIds: string[];
			if (leadHits === undefined) {
				const hits = dedupeHits([...triggerHits, ...(await this.recallHits(query))]);
				({ text, renderedIds } = this.#formatHits(this.#withoutProfileRows(hits, profileIds), "block"));
			} else {
				// First turn: the previous session's handoff rows lead the list, then
				// triggered rows, then the query's own hits (deduped by id so a
				// handoff that the query also matches keeps its lead slot).
				const hits = dedupeHits([...leadHits, ...triggerHits, ...(await this.recallHits(query))]);
				({ text, renderedIds } = this.#formatHits(this.#withoutProfileRows(hits, profileIds), "block"));
			}
			const block = text ? `<memories>\n${DAKERA_RECALL_PREAMBLE}\n\n${text}\n</memories>` : undefined;
			const sections = [profile?.text, block].filter((part): part is string => typeof part === "string");
			if (sections.length === 0) return { context: null, ok: true, renderedIds: [] };
			return {
				context: sections.join("\n\n"),
				ok: true,
				renderedIds: [...renderedIds, ...(profile?.renderedIds ?? [])],
			};
		} catch (err) {
			if (this.config.debug) {
				logger.debug("Dakera: recall failed", { agentId: this.agentId, error: String(err) });
			}
			return { context: null, ok: false, renderedIds: [] };
		}
	}

	/** The previous session's handoff rows for a first turn; a failed recall just yields none.
	 * Rows stored before the write guard existed can still be all-placeholder —
	 * they are dropped here — and lead order is close time, so server relevance
	 * rank decides which rows compete, never which one the session continues from. */
	async #handoffHits(): Promise<DakeraRecallHit[]> {
		try {
			const hits = await this.recallHits(HANDOFF_RECALL_QUERY, undefined, { topK: 3 });
			return hits
				.filter(hit => hit.memory.tags?.includes("handoff"))
				.filter(hit => !isDegenerateHandoff(hit.memory.content))
				.sort((a, b) => handoffClosedAt(b) - handoffClosedAt(a));
		} catch {
			return [];
		}
	}

	/**
	 * Per-turn freshness (cadence plan B): rows the session has not delivered yet,
	 * staged as a `<memory_delta>` notice riding the turn's user message — never a
	 * system-prompt rebuild (#11961). Query hits are deduped by delivered id;
	 * triggered rows re-fire per matching turn (their contract is "whenever a
	 * query matches"). A failed or slow recall degrades to no notice: freshness
	 * must never break the turn.
	 */
	async #deltaPreparation(latestPrompt: string): Promise<MemoryPromptPreparation | undefined> {
		if (!this.config.recallDelta) return undefined;
		const generation = this.#recallGeneration;
		try {
			const history = extractMessages(this.session.sessionManager);
			const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
			const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
			const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
			const touchedPaths = collectTouchedPaths(this.session.sessionManager.getEntries());
			const triggerHits = await this.#triggerHits(truncated, touchedPaths);
			const fresh = await this.recallHits(truncated, undefined, {
				timeoutMs: this.config.recallDeltaTimeoutMs,
			});
			const hits = dedupeHits([...triggerHits, ...fresh]).filter(
				hit => isTriggeredRow(hit) || hit.memory.id === undefined || !this.#deliveredIds.has(hit.memory.id),
			);
			const { text, renderedIds } = this.#renderRecallBlock(hits, this.config.recallDeltaTokens, "pull");
			if (!text) return undefined;
			return {
				notice: {
					content: `<memory_delta>\n${DAKERA_DELTA_PREAMBLE}\n\n${text}\n</memory_delta>`,
					details: { kind: "dakera-delta", ids: renderedIds },
				},
				commit: () => {
					if (this.#recallGeneration !== generation) return false;
					for (const id of renderedIds) this.#deliveredIds.add(id);
					return true;
				},
			};
		} catch (err) {
			logger.debug("Dakera: delta recall failed", { agentId: this.agentId, error: String(err) });
			return undefined;
		}
	}

	/** Stage the auto-recall; `commit` publishes it only while this turn still owns the generation.
	 *
	 * The first turn injects the block through the preparation. A re-recall (the
	 * topic-shift gate passed) REPLACES the sticky block instead of appending —
	 * the snippet is swapped first and the base prompt rebuilt around it, so the
	 * old block leaves with the rebuild. Mid-session rebuilds are kept rare (they
	 * bust the provider prompt-cache prefix, #11961) by the gate's cooldown and
	 * prompt-distance checks; turns the gates hold back get their freshness from
	 * {@link DakeraSessionState.#deltaPreparation} instead.
	 */
	async beforeAgentStartPrompt(promptText: string): Promise<MemoryPromptPreparation | undefined> {
		// The renderer reads the conflict ledger synchronously, so it must be in
		// memory before the first block renders; a failed load is a no-op.
		await this.#ensureConflicts();
		if (!this.#autonomous || !this.config.autoRecall) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;
		const firstTurn = !this.hasRecalledForFirstTurn;
		if (!firstTurn) {
			this.#promptsSinceLastRecall += 1;
			// No block recall this turn: the delta notice delivers the freshness
			// instead — ungated and cache-safe, so the sticky block stays put.
			if (!this.#topicShifted(latestPrompt)) return this.#deltaPreparation(latestPrompt);
		}
		const generation = ++this.#recallGeneration;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		// First turn: lead the block with the previous session's handoff row so the
		// continuation facts land in the first slots (the packer iterates in order).
		// A failed handoff recall just yields no lead rows.
		const leadHits = firstTurn && this.config.handoffEnabled ? await this.#handoffHits() : undefined;
		const { context, ok, renderedIds } = await this.#recallForContext(truncated, leadHits, true);
		if (!ok) return undefined;
		if (this.#recallGeneration !== generation) return undefined;

		if (firstTurn) {
			return {
				context: context ?? undefined,
				commit: () => {
					if (this.#recallGeneration !== generation) return false;
					this.#recordRecall(truncated, context, renderedIds);
					return true;
				},
			};
		}
		// Re-recall: an empty result keeps the current block; a real one swaps it.
		// The write happens before `commit` on purpose (the base rebuild needs the
		// new snippet); the generation guard makes a superseded turn a no-op.
		if (!context) return undefined;
		this.#recordRecall(truncated, context, renderedIds);
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
	#recordRecall(query: string, context: string | null, renderedIds: readonly string[]): void {
		this.hasRecalledForFirstTurn = true;
		if (context) this.lastRecallSnippet = context;
		this.lastRecallQuery = query;
		this.lastRecallAt = Date.now();
		this.#promptsSinceLastRecall = 0;
		for (const id of renderedIds) this.#deliveredIds.add(id);
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
		const suspect = detectSuspectContent(ingest.content);
		return this.client.importDocument(this.agentId, {
			content: ingest.content,
			mediaType: ingest.mediaType,
			title: ingest.title,
			documentId: ingest.documentId,
			// Doc chunks must carry the same scope tags as retains: under
			// per-project-tagged scoping recall ANY-matches on those tags only,
			// so untagged `document:<id>`-only chunks are invisible to recall.
			tags: this.retainTags,
			metadata: suspect === undefined ? undefined : { suspect },
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
