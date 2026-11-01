import type { Database, SQLQueryBindings } from "bun:sqlite";
import { logger, withLoopPhase } from "@oh-my-pi/pi-utils";
import { transaction } from "../../db";
import { toUtcIso } from "../../util/datetime";
import { generateId } from "../../util/ids";
import { currentEmbeddingModel, embeddingsDisabled } from "../embeddings";
import { EpisodicGraph } from "../episodic-graph";
import { countExtractedFactCategories, extractFactCategoriesSafe } from "../extraction";
import { getMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "../runtime-options";
import { storeExtractedFactCategories } from "./consolidate";
import { sourceMemoryScope } from "./fact-scope";
import { type EmbedItem, scheduleEmbedding, vecAvailable, vecInsert } from "./helpers";
import type {
	BeamEvent,
	BeamMemoryState,
	BeamStats,
	ImportStats,
	Metadata,
	RememberBatchItem,
	RememberBatchOptions,
	RememberOptions,
	TrustTier,
	Veracity,
} from "./types";

type Row = Record<string, unknown>;
type EventPayload = Omit<BeamEvent, "type" | "sessionId" | "timestamp">;

type StoreRememberOptions = RememberOptions & {
	memoryId?: string;
	memory_id?: string;
	validUntil?: string | null;
	valid_until?: string | null;
	authorId?: string | null;
	author_id?: string | null;
	authorType?: string | null;
	author_type?: string | null;
	extractEntities?: boolean;
	extract_entities?: boolean;
	extract_text?: string;
	embed_text?: string;
	channelId?: string | null;
	channel_id?: string | null;
};

type StoreRememberBatchOptions = RememberBatchOptions & {
	forceVeracity?: boolean;
	force_veracity?: boolean;
};

const CANONICAL_VERACITY: Record<string, true> = {
	true: true,
	false: true,
	stated: true,
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
};
const TRUST_TIERS: Record<string, true> = {
	STATED: true,
	DERIVED: true,
	EXTERNAL_WRITE: true,
	IMPORTED: true,
};
const SCRATCHPAD_MAX_ITEMS = Number.parseInt(process.env.MNEMOPI_SP_MAX ?? "1000", 10);

function metadataJson(metadata: Metadata | null | undefined): string | null {
	return metadata == null ? null : JSON.stringify(metadata);
}

function jsonObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isSqlBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		value instanceof ArrayBuffer ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}

function sqlBinding(value: unknown, fallback: SQLQueryBindings): SQLQueryBindings {
	return isSqlBinding(value) ? value : fallback;
}

function embeddingText(content: string, options: { embedText?: string; embed_text?: string }): string {
	return options.embedText ?? options.embed_text ?? content;
}

function storedEmbeddingText(content: string, embedText: string): string | null {
	return embedText === content ? null : embedText;
}

function clampVeracity(value: unknown): Veracity {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	return CANONICAL_VERACITY[normalized] === true ? normalized : "unknown";
}

function sourceToTrustTier(source: string | null | undefined): TrustTier {
	switch ((source ?? "").toLowerCase()) {
		case "conversation":
		case "user":
		case "assistant":
			return "STATED";
		case "tool":
		case "api":
		case "system":
			return "EXTERNAL_WRITE";
		case "import":
		case "imported":
		case "backup":
			return "IMPORTED";
		default:
			return "STATED";
	}
}

function normalizeTrustTier(value: unknown, source: string): TrustTier {
	if (value === null || value === undefined) return sourceToTrustTier(source);
	if (typeof value === "string" && TRUST_TIERS[value] === true) return value;
	return "STATED";
}

function emitEvent(beam: BeamMemoryState, type: string, data: EventPayload): void {
	const event: BeamEvent = {
		...data,
		type,
		sessionId: beam.sessionId,
		timestamp: toUtcIso(),
	};
	const candidate = beam as BeamMemoryState & {
		emitEvent?: (type: string, data: EventPayload) => void;
	};
	if (typeof candidate.emitEvent === "function") {
		candidate.emitEvent(type, data);
		return;
	}
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

/** Drop cached recall results after a write that can change what recall returns. */
function invalidateCaches(beam: BeamMemoryState): void {
	beam.caches.queryCache?.invalidate();
}

function findDuplicate(beam: BeamMemoryState, content: string): string | null {
	using statement = beam.db.prepare("SELECT id FROM working_memory WHERE content = ? AND session_id = ? LIMIT 1");
	const row = statement.get(content, beam.sessionId) as { id: string } | null;
	return row?.id ?? null;
}

function tableExists(db: BeamMemoryState["db"], table: string): boolean {
	using statement = db.prepare(
		"SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1",
	);
	return statement.get(table) !== null;
}

/** Tables whose rows point back to a `working_memory` id via `source_memory_id`. */
const MEMORIA_SOURCE_TABLES = [
	"memoria_facts",
	"memoria_instructions",
	"memoria_kg",
	"memoria_preferences",
	"memoria_timelines",
] as const;

/**
 * Remove every artifact linked to the given `working_memory` ids so no deletion
 * path leaves orphans behind. Covers annotations, embeddings, extracted facts
 * (`facts.source_msg_id`), memoria projections (`*.source_memory_id`), episodic
 * gists, and the graph edges tied to those memory / gist / fact node ids.
 *
 * Idempotent and schema-tolerant: `gists` / `graph_edges` only exist once an
 * `EpisodicGraph` has initialised, so they are guarded. Callers own the
 * transaction and the base `working_memory` delete.
 */
function factTierPredicate(tiers: readonly string[]): string {
	const parts: string[] = [];
	// Legacy NULL rows are ambiguous (written before provenance existed), so a
	// collision replacement in EITHER tier retires them: leaving them after an
	// episode replacement would keep the replaced episode's statement
	// recallable, and beam extraction is working-driven anyway.
	if (tiers.includes("working")) parts.push("(source_tier = 'working' OR source_tier IS NULL)");
	if (tiers.includes("episodic")) parts.push("(source_tier = 'episodic' OR source_tier IS NULL)");
	return parts.length > 0 ? parts.join(" OR ") : "1 = 0";
}

function purgeWorkingMemoryArtifacts(
	db: BeamMemoryState["db"],
	ids: readonly string[],
	options: { preserveAnnotations?: boolean; factTiers?: readonly ("working" | "episodic")[] } = {},
): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	// When factTiers is set (an id collision across tiers) only that tier's
	// fact derivatives and their edges are retired; the shared projections
	// (memoria, embeddings, annotations, gists) carry no provenance and are
	// left untouched.
	const tierFilter = options.factTiers === undefined ? "" : ` AND ${factTierPredicate(options.factTiers)}`;

	// Tier-scoped (collision) purges remove only edges tied to the selected
	// fact ids: the raw memory and gist ids are shared with the untouched
	// tier, whose ctx/related edges must survive.
	const graphRefs = new Set<string>(options.factTiers === undefined ? ids : []);
	if (options.factTiers === undefined) {
		for (const id of ids) graphRefs.add(`gist_${id}`);
	}
	if (tableExists(db, "facts")) {
		using factStatement = db.prepare(`SELECT fact_id FROM facts WHERE source_msg_id IN (${placeholders})${tierFilter}`);
		const factRows = factStatement.all(...ids) as {
			fact_id: string;
		}[];
		for (const row of factRows) graphRefs.add(row.fact_id);
		db.run(`DELETE FROM facts WHERE source_msg_id IN (${placeholders})${tierFilter}`, [...ids]);
	}

	if (options.factTiers === undefined) {
		// Content edits reuse this helper but must keep the source's
		// annotations: they describe the memory itself (occurred_on, has_source,
		// caller-added metadata) and survive a rewording, so the edit path opts
		// out here.
		if (!options.preserveAnnotations) {
			db.run(`DELETE FROM annotations WHERE memory_id IN (${placeholders})`, [...ids]);
		}
		db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`, [...ids]);
		for (const table of MEMORIA_SOURCE_TABLES) {
			db.run(`DELETE FROM ${table} WHERE source_memory_id IN (${placeholders})`, [...ids]);
		}

		if (tableExists(db, "gists")) {
			db.run(`DELETE FROM gists WHERE memory_id IN (${placeholders})`, [...ids]);
		}
	}
	if (tableExists(db, "graph_edges")) {
		const refs = [...graphRefs];
		const refPlaceholders = refs.map(() => "?").join(", ");
		db.run(`DELETE FROM graph_edges WHERE source IN (${refPlaceholders}) OR target IN (${refPlaceholders})`, [
			...refs,
			...refs,
		]);
	}
}

/**
 * TTL / overflow trim for transient working memory. Only genuine scratch is
 * eligible: `consolidated_at IS NULL` no longer suffices on its own, since
 * restored or imported durable rows legitimately carry a NULL consolidation
 * marker with an old event timestamp (issue #4819). Rows flagged `IMPORTED`
 * are treated as durable and never trimmed, and trimmed rows cascade all linked
 * artifacts via `purgeWorkingMemoryArtifacts`.
 */
function trimWorkingMemory(beam: BeamMemoryState): void {
	const limit = beam.config.workingMemoryLimit;
	if (!Number.isFinite(limit) || limit <= 0) return;
	const ttlHours = beam.config.workingMemoryTtlHours;
	const cutoff = toUtcIso(new Date(Date.now() - ttlHours * 3_600_000));
	transaction(beam.db, () => {
		using selectStatement = beam.db.prepare(`
			SELECT id FROM working_memory
			WHERE session_id = ?
			  AND consolidated_at IS NULL
			  AND trust_tier IS NOT 'IMPORTED'
			  AND (
				timestamp < ? OR
				id NOT IN (
					SELECT id FROM working_memory
					WHERE session_id = ? AND consolidated_at IS NULL AND trust_tier IS NOT 'IMPORTED'
					ORDER BY timestamp DESC
					LIMIT ?
				)
			  )
		`);
		const ids = (selectStatement.all(beam.sessionId, cutoff, beam.sessionId, limit) as { id: string }[]).map(
			row => row.id,
		);
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(", ");
		beam.db.run(`DELETE FROM working_memory WHERE id IN (${placeholders}) AND session_id = ?`, [
			...ids,
			beam.sessionId,
		]);
		purgeWorkingMemoryArtifacts(beam.db, ids);
	});
}

function addTemporalAnnotations(beam: BeamMemoryState, memoryId: string, timestamp: string, source: string): void {
	try {
		beam.annotations?.add?.(memoryId, "occurred_on", timestamp.slice(0, 10));
		if (source && source !== "conversation" && source !== "user" && source !== "assistant") {
			beam.annotations?.add?.(memoryId, "has_source", source);
		}
	} catch {
		// Annotation enrichment is best-effort, matching Python's non-blocking path.
	}
}

function proactiveLinkingAllowed(beam: BeamMemoryState): boolean {
	const override = process.env.MNEMOPI_PROACTIVE_LINKING;
	return override === undefined ? beam.config.proactiveLinking === true : override === "1";
}

function proactiveLinkIfEnabled(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	extractEntities: boolean,
): void {
	if (!proactiveLinkingAllowed(beam)) return;
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(content, memoryId, {
			sessionId: beam.sessionId,
			linkExisting: true,
			extractEntities,
			scope: sourceMemoryScope(beam, memoryId),
		});
	} catch {
		// Proactive graph enrichment must never block durable memory storage.
	}
}

/**
 * Fresh per-insert generation token for a working-memory row. Unlike
 * created_at (one-second precision, preserved by force imports) and the
 * rowid (reused after deletes), this value changes on every insert, so it
 * distinguishes a delete + re-create even within the same second.
 */
function freshGeneration(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Run the LLM fact extractor over freshly stored content and persist the
 * resulting facts. Best-effort: failures (no LLM, closed DB, malformed output)
 * are swallowed so they can never disrupt the synchronous `remember` that
 * scheduled them.
 */
async function runFactExtraction(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	scheduled: { rowid: number; content: string; generation: string | null; cancelSeq: number } | null,
	scheduledScope: string,
): Promise<void> {
	try {
		const extracted = await extractFactCategoriesSafe(content);
		withLoopPhase("mnemopi.extract", () => {
			if (countExtractedFactCategories(extracted) === 0) return;
			// Discard stale results: the task is bound to the source row's
			// incarnation at schedule time — the per-insert generation token,
			// the rowid, the stored content, and the inherited scope. Every
			// insert path writes a fresh generation value, so a delete +
			// re-create with identical content and scope (even within the same
			// second, where the rowid and the one-second-precision created_at
			// can both be reused, and even a force import that preserves
			// exported timestamps) fails the check; an edit or re-scope changes
			// content/scope directly. In-place refreshes (duplicate remember,
			// edit with identical content) keep the generation, so they do not
			// cancel a pending extraction. A null snapshot (source already
			// trimmed before the task captured its version) is rejected
			// outright. Facts otherwise inherit the scheduled scope, never
			// wider than their source.
			// Validation and persistence are one write unit: a concurrent
			// forget or force-replace that already committed is seen by the
			// check inside the transaction (and discarded); one that started
			// earlier blocks on the write lock until the facts commit — at
			// which point its own cascade purges them.
			transaction(beam.db, () => {
				const source = beam.db
					.prepare("SELECT rowid, content, generation, scope FROM working_memory WHERE id = ?")
					.get(memoryId) as { rowid: number; content: string; generation: string | null; scope: string | null } | null;
				if (
					source == null ||
					scheduled == null ||
					source.rowid !== scheduled.rowid ||
					source.content !== scheduled.content ||
					source.generation !== scheduled.generation ||
					// Compare against the INHERITED scope (the conservative
					// combination over any colliding rows), not the raw working
					// row's scope: a collision can make the inherited scope
					// narrower than the working row alone, and the raw compare
					// would reject every background extraction for exactly that
					// shape.
					sourceMemoryScope(beam, memoryId) !== scheduledScope
				) {
					return;
				}
				// A newer schedule for the same row version (changed extraction
				// text) invalidated this task.
				const liveCancelSeq = beam.extractionCancelSeq?.get(memoryId + "\0" + scheduled.generation);
				if (liveCancelSeq !== undefined && liveCancelSeq !== scheduled.cancelSeq) {
					return;
				}
				storeExtractedFactCategories(beam, extracted, 0, memoryId, 0.7, scheduledScope);
				invalidateCaches(beam);
			});
		});
	} catch {
		// Background fact extraction is best-effort and never surfaces to the caller.
	}
}

/**
 * Schedule background fact extraction for a stored memory. `remember` is
 * synchronous, so the async extractor is fired-and-forgotten; the promise is
 * tracked on `beam.pendingExtractions` so callers can drain it via
 * `flushExtractions()` (tests, graceful shutdown). The active runtime options
 * (host LLM `complete`, model, prompt overrides) are captured here and
 * re-entered inside the task because the AsyncLocalStorage scope set by
 * `Mnemopi.#withRuntimeOptions` has already exited by the time the task runs.
 */
function scheduleFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): void {
	if (content.trim() === "") return;
	const runtimeOptions = getMnemopiRuntimeOptions();
	// Bind the task to the source row's incarnation at schedule time: the
	// per-insert generation token, the rowid, the stored content, and the
	// inherited scope are captured now, and runFactExtraction discards the
	// result if the source row no longer matches the whole token in the
	// meantime (covers edits, re-scopes, and delete + re-create with
	// identical content and scope — even within the same second, where the
	// rowid and the one-second-precision created_at can both be reused).
	const scheduled = beam.db
		.prepare("SELECT rowid, content, generation FROM working_memory WHERE id = ?")
		.get(memoryId) as { rowid: number; content: string; generation: string | null } | null;
	const scheduledScope = sourceMemoryScope(beam, memoryId);
	// Replacement counter: every schedule for a (id, generation) version
	// increments it, and the task records its value. A later schedule with
	// different extraction text for the same row version invalidates the
	// older task — both would otherwise pass the row validation (which binds
	// to the stored row, not the text override), and facts unique to the
	// abandoned override would silently never be extracted.
	let cancelSeq = 0;
	if (scheduled !== null) {
		const cancelKey = memoryId + "\0" + scheduled.generation;
		const prev = beam.extractionCancelSeq?.get(cancelKey);
		if (prev !== undefined) cancelSeq = prev + 1;
		beam.extractionCancelSeq?.set(cancelKey, cancelSeq);
	}
	const task = withMnemopiRuntimeOptions(runtimeOptions, () =>
		runFactExtraction(beam, memoryId, content, scheduled === null ? null : { ...scheduled, cancelSeq }, scheduledScope),
	);
	const pending = beam.pendingExtractions;
	const pendingIds = beam.pendingExtractionIds;
	if (pending !== undefined) {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
	if (pendingIds !== undefined) {
		// Keyed by id, generation, AND extraction text, holding the cancel
		// sequence of every task still in flight under that key: only a task
		// at the LIVE sequence for its generation may suppress a duplicate —
		// a superseded (canceled) task must not keep blocking requests (an
		// A → B → A sequence must honor the latest A), and a task bound to
		// an older generation discards itself and must not block either.
		if (scheduled !== null) {
			// The inherited scope is part of the key: a mid-flight collision
			// (a same-id episode appearing or re-scoping to something narrower)
			// changes the scope this task validates against, so the old task
			// will discard itself and must NOT suppress the next request.
			const key = memoryId + "\0" + scheduled.generation + "\0" + content + "\0" + scheduledScope;
			const generation = scheduled.generation;
			const set = pendingIds.get(key) ?? new Set<number>();
			set.add(cancelSeq);
			pendingIds.set(key, set);
			void task.finally(() => {
				const live = pendingIds.get(key);
				if (live !== undefined) {
					live.delete(cancelSeq);
					if (live.size === 0) pendingIds.delete(key);
				}
				// Retire the generation's cancel entry only once EVERY task
				// under it — including superseded ones — has settled, so a
				// still-running canceled task can never mistake a missing
				// entry for "live" in the guard.
				if (beam.extractionCancelSeq !== undefined) {
					const prefix = memoryId + "\0" + generation + "\0";
					let anyPending = false;
					for (const [k, entries] of pendingIds) {
						if (k.startsWith(prefix) && entries.size > 0) {
							anyPending = true;
							break;
						}
					}
					if (!anyPending) beam.extractionCancelSeq.delete(memoryId + "\0" + generation);
				}
			});
		}
	}
}

function rowToDict(row: Row): Row {
	return { ...row };
}

/** Re-embedding batch size for a model-change rebuild — bounds each background
 *  embedding request instead of embedding the whole corpus in one call. */
const EMBED_REBUILD_BATCH = 128;

/**
 * Reconcile stored embeddings against the active embedding model at store open.
 *
 * Every `memory_embeddings` row is stamped with the model that produced it (see
 * `runEmbedding` in `helpers.ts`). When the configured embedding model changes,
 * its vector dimension changes too, so the previously-stored vectors are no
 * longer comparable. On a mismatch we wipe every stored vector — the
 * `memory_embeddings` table, the `episodic_memory.binary_vector` column, and the
 * sqlite-vec `vec_episodes` index — then enqueue all live memories for
 * background re-embedding under the new model via `scheduleEmbedding`.
 *
 * Runs once per store open; a fresh store (no embeddings) or an already-current
 * store is a no-op. The destructive wipe is skipped whenever it could not be
 * rebuilt — embeddings disabled via the runtime option OR the
 * `MNEMOPI_NO_EMBEDDINGS` env, or an unresolved (empty) active model — so a
 * stale-but-valid corpus is never destroyed without a replacement. MUST run
 * inside the active runtime-options scope so `currentEmbeddingModel()` /
 * `embeddingsDisabled()` reflect the per-instance configuration.
 */
export function reconcileEmbeddingModel(beam: BeamMemoryState): void {
	if (embeddingsDisabled()) return;
	const active = currentEmbeddingModel().trim();
	if (active === "") return;

	// Re-embed in bounded batches so a corpus-wide rebuild never issues one giant
	// embedding request; each batch is its own tracked background task.
	const rebuild = (items: readonly EmbedItem[]): void => {
		for (let offset = 0; offset < items.length; offset += EMBED_REBUILD_BATCH) {
			scheduleEmbedding(beam, items.slice(offset, offset + EMBED_REBUILD_BATCH));
		}
	};

	// Stop at the first row whose stamped model differs from the active one
	// (NULL/unstamped counts as a mismatch via `IS NOT`).
	const mismatch = beam.db.query("SELECT 1 FROM memory_embeddings WHERE model IS NOT ? LIMIT 1").get(active);
	if (mismatch) {
		const staleModels = beam.db
			.query("SELECT DISTINCT model FROM memory_embeddings WHERE model IS NOT ?")
			.all(active) as { model: string | null }[];
		const live = beam.db
			.query(`
				SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory WHERE superseded_by IS NULL
				UNION ALL
				SELECT id AS memoryId, content FROM episodic_memory WHERE superseded_by IS NULL
			`)
			.all() as EmbedItem[];

		transaction(beam.db, () => {
			beam.db.run("DELETE FROM memory_embeddings");
			beam.db.run("UPDATE episodic_memory SET binary_vector = NULL");
			if (vecAvailable(beam.db)) {
				try {
					beam.db.run("DELETE FROM vec_episodes");
				} catch {
					// sqlite-vec cleanup is best-effort; rebuild correctness takes precedence.
				}
			}
		});

		logger.info("mnemopi: embedding model changed, rebuilding", {
			from: staleModels.map(row => row.model ?? "(unstamped)"),
			to: active,
			count: live.length,
		});
		rebuild(live);
		return;
	}

	// No stale embeddings, but a previously-interrupted rebuild (a failed embed or a process
	// exit after the wipe) can leave live memories with no active-model embedding. Treating an
	// empty/partial table as "reconciled" would strand them FTS-only, so re-enqueue any live
	// row still missing an active-model embedding.
	const missing = beam.db
		.query(`
			SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
			UNION ALL
			SELECT id AS memoryId, content FROM episodic_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
		`)
		.all(active, active) as EmbedItem[];
	if (missing.length === 0) return;
	logger.info("mnemopi: resuming interrupted embedding rebuild", { to: active, count: missing.length });
	rebuild(missing);
}

export function remember(beam: BeamMemoryState, content: string, options: StoreRememberOptions = {}): string {
	const source = options.source ?? "conversation";
	const importance = options.importance ?? 0.5;
	const timestamp = options.timestamp ?? toUtcIso();
	const scope = options.scope ?? "session";
	const veracity = clampVeracity(options.veracity);
	const trustTier = normalizeTrustTier(options.trustTier, source);
	const memoryType = options.memoryType ?? "unknown";
	const validUntil = options.validUntil ?? options.valid_until ?? null;
	const authorId = options.authorId ?? options.author_id ?? beam.authorId;
	const authorType = options.authorType ?? options.author_type ?? beam.authorType;
	const channelId = options.channelId ?? options.channel_id ?? beam.channelId;
	const metadata = options.metadata ?? null;
	const embedText = embeddingText(content, options);

	const existingId = findDuplicate(beam, content);
	if (existingId !== null) {
		// The duplicate write must hold the write lock across the stored-row
		// read and the UPDATE, and re-verify the row still matches `content`
		// under that lock: a concurrent edit between the duplicate match and
		// the write would otherwise snapshot the edited row's generation while
		// scheduling extraction of the OLD text — the async validation (which
		// re-reads the row) would pass and attach old-text facts to the new
		// source. A stale match rolls back and falls through to a fresh insert.
		const refresh = transaction(beam.db, () => {
			const stored = beam.db
				.prepare("SELECT content, scope, generation FROM working_memory WHERE id = ? AND session_id = ?")
				.get(existingId, beam.sessionId) as { content: string; scope: string | null; generation: string | null } | undefined;
			if (stored == null || stored.content !== content) return null;
			// The scope as stored before this duplicate write, so the extraction
			// reschedule below can tell a real re-scope from a repeated value.
			const scopeChanged =
				options.scope !== undefined && options.scope !== (stored.scope ?? "session");
			beam.db.run(
			`
				UPDATE working_memory
				SET importance = MAX(importance, ?), timestamp = ?, source = ?,
					generation = ?,
					valid_until = COALESCE(?, valid_until),
					scope = COALESCE(?, scope),
					author_id = COALESCE(?, author_id),
					author_type = COALESCE(?, author_type),
					channel_id = COALESCE(?, channel_id),
					memory_type = COALESCE(?, memory_type),
					veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END,
					trust_tier = COALESCE(?, trust_tier),
					embed_text = COALESCE(?, embed_text),
					consolidated_at = NULL
				WHERE id = ? AND session_id = ?
			`,
			[
				importance,
				timestamp,
				source,
				// A real scope change rotates the extraction generation (an ABA
				// re-scope must not let a pending task bound to the earlier state
				// revalidate); anything else re-binds the stored token untouched.
				scopeChanged ? freshGeneration() : stored.generation,
				validUntil,
				// An omitted scope keeps the stored value (the variable above was
				// defaulted to 'session', which would silently narrow a global source).
				options.scope ?? null,
				authorId,
				authorType,
				channelId,
				memoryType,
				veracity,
				veracity,
				trustTier,
				storedEmbeddingText(content, embedText),
				existingId,
				beam.sessionId,
			],
			);
			return { scopeChanged, generation: stored.generation };
		});
		if (refresh !== null) {
			emitEvent(beam, "MEMORY_UPDATED", {
				memoryId: existingId,
			content,
			source,
			importance,
			metadata: metadata ?? undefined,
		});
		if (embedText !== content) scheduleEmbedding(beam, [{ memoryId: existingId, content: embedText }]);
		// An explicit extraction request is honored whenever no task is actually
		// pending for this row — e.g. after a content change retired the earlier
		// derivatives (the in-flight task then discarded itself). A real scope
		// change always schedules the replacement: its snapshot is stale and the
		// generation rotated above kills the old task. Only a genuinely pending
		// task is suppressed — re-requesting identical content while the
		// extraction is still in flight would double-run the LLM.
		// Suppression only counts a task pending for the CURRENT generation
		// AND the same extraction text: a different override is a replacement
		// (the cancellation counter invalidates the in-flight task), while an
		// identical pending request coalesces. An older-generation task will
		// discard itself and must not block this request. Legacy rows
		// (pre-upgrade) carry a NULL generation: both tasks validate against
		// the same NULL snapshot, so the NULL key suppresses exactly like any
		// other.
			const extractionSource = options.extractText ?? options.extract_text ?? content;
			const genForKey = refresh.scopeChanged ? null : refresh.generation;
			// The inherited scope is part of the key (see scheduleFactExtraction):
			// if a same-id episode appeared or re-scoped while the pending task
			// was waiting on the LLM, the task will discard itself, so the next
			// request must be scheduled as a replacement, not suppressed.
			const inheritedScope = refresh.scopeChanged ? null : sourceMemoryScope(beam, existingId);
			const pendingKey = existingId + "\0" + genForKey + "\0" + extractionSource + "\0" + inheritedScope;
			// Suppression only counts a task at the LIVE cancellation sequence
			// for this exact (generation, text): a superseded task must not
			// block the latest request (A → B → A honors the last A), an
			// older-generation task discards itself, and legacy NULL-generation
			// rows suppress exactly like any other key.
			const liveSeq = beam.extractionCancelSeq?.get(existingId + "\0" + genForKey);
			const pendingHere =
				liveSeq !== undefined && (beam.pendingExtractionIds?.get(pendingKey)?.has(liveSeq) ?? false);
			if (options.extract === true && (refresh.scopeChanged || !pendingHere)) {
				scheduleFactExtraction(beam, existingId, extractionSource);
			}
			invalidateCaches(beam);
			return existingId;
		}
		// Stale duplicate match: the row changed under us, so insert fresh.
	}

	const memoryId = options.memoryId ?? options.memory_id ?? generateId(content, new Date(timestamp));
	beam.db.run(
		`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, valid_until, scope,
			 author_id, author_type, channel_id, veracity, memory_type, trust_tier, generation)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		[
			memoryId,
			content,
			storedEmbeddingText(content, embedText),
			source,
			timestamp,
			beam.sessionId,
			importance,
			metadataJson(metadata),
			validUntil,
			scope,
			authorId,
			authorType,
			channelId,
			veracity,
			memoryType,
			trustTier,
			freshGeneration(),
		],
	);
	addTemporalAnnotations(beam, memoryId, timestamp, source);
	// `extractText` lets a caller decouple "what gets stored" from "what facts are
	// mined". coding-agent retains full multi-author transcripts but wants
	// fact/entity heuristics to read only the user-authored turns (issue #3372).
	const extractionSource = options.extractText ?? options.extract_text ?? content;
	proactiveLinkIfEnabled(
		beam,
		memoryId,
		extractionSource,
		Boolean(options.extractEntities ?? options.extract_entities),
	);
	trimWorkingMemory(beam);
	emitEvent(beam, "MEMORY_ADDED", {
		memoryId,
		content,
		source,
		importance,
		metadata: metadata ?? undefined,
	});
	scheduleEmbedding(beam, [{ memoryId, content: embedText }]);
	if (options.extract === true) scheduleFactExtraction(beam, memoryId, extractionSource);
	invalidateCaches(beam);
	return memoryId;
}

export function rememberBatch(
	beam: BeamMemoryState,
	items: readonly RememberBatchItem[],
	options: StoreRememberBatchOptions = {},
): string[] {
	const timestamp = toUtcIso();
	const ids: string[] = [];
	const forceVeracity = options.forceVeracity ?? options.force_veracity ?? false;
	const defaultVeracity = clampVeracity(options.veracity);
	const defaultScope = options.scope ?? "session";
	const trustTier = normalizeTrustTier(options.trustTier ?? "IMPORTED", "imported");

	transaction(beam.db, () => {
		using statement = beam.db.prepare(`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json,
			 author_id, author_type, channel_id, memory_type, veracity, trust_tier, scope, generation)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const item of items) {
			const itemTimestamp = item.timestamp ?? timestamp;
			const memoryId = generateId(item.content, new Date(itemTimestamp));
			ids.push(memoryId);
			const source = item.source ?? "conversation";
			const storeItem = item as StoreRememberOptions;
			const embedText = embeddingText(item.content, storeItem);
			const itemVeracity = forceVeracity
				? defaultVeracity
				: item.veracity !== undefined
					? clampVeracity(item.veracity)
					: defaultVeracity;
			statement.run(
				memoryId,
				item.content,
				storedEmbeddingText(item.content, embedText),
				source,
				itemTimestamp,
				beam.sessionId,
				item.importance ?? 0.5,
				metadataJson(item.metadata ?? null),
				storeItem.authorId ?? storeItem.author_id ?? beam.authorId,
				storeItem.authorType ?? storeItem.author_type ?? beam.authorType,
				storeItem.channelId ?? storeItem.channel_id ?? beam.channelId,
				item.memoryType ?? options.memoryType ?? "unknown",
				itemVeracity,
				trustTier,
				item.scope ?? defaultScope,
				freshGeneration(),
			);
			addTemporalAnnotations(beam, memoryId, itemTimestamp, source);
			emitEvent(beam, "MEMORY_ADDED", {
				memoryId,
				content: item.content,
				source,
				importance: item.importance ?? 0.5,
				metadata: item.metadata ?? undefined,
			});
		}
		trimWorkingMemory(beam);
	});
	invalidateCaches(beam);
	const embeddingItems: { memoryId: string; content: string }[] = [];
	items.forEach((item, index) => {
		const id = ids[index];
		if (id === undefined) return;
		embeddingItems.push({ memoryId: id, content: embeddingText(item.content, item as StoreRememberOptions) });
	});
	scheduleEmbedding(beam, embeddingItems);
	items.forEach((item, index) => {
		const id = ids[index];
		if (id !== undefined && (item.extract === true || options.extract === true)) {
			scheduleFactExtraction(beam, id, item.content);
		}
	});
	return ids;
}

export function getContext(beam: BeamMemoryState, limit = 10): Row[] {
	const now = toUtcIso();
	using statement = beam.db.prepare(`
		SELECT id, content, source, timestamp, importance, scope
		FROM working_memory
		WHERE (session_id = ? OR scope = 'global')
		  AND (valid_until IS NULL OR valid_until > ?)
		  AND superseded_by IS NULL
		ORDER BY
			CASE WHEN scope = 'global' THEN 0 ELSE 1 END,
			importance DESC,
			timestamp DESC
		LIMIT ?
	`);
	return (statement.all(beam.sessionId, now, limit) as Row[]).map(rowToDict);
}

export function invalidate(beam: BeamMemoryState, memoryId: string, replacementId: string | null = null): boolean {
	const now = toUtcIso();
	const working = beam.db.run(
		`
			UPDATE working_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
		[now, replacementId, memoryId, beam.sessionId],
	);
	if (working.changes > 0) {
		// Recall filters `valid_until`/`superseded_by` in SQL, but the enhanced path consults the
		// query cache BEFORE it reaches SQL. Without this the row a caller just retired keeps being
		// served to an identical query for the rest of the cache TTL -- the one thing an explicit
		// invalidation is supposed to guarantee against. Every other mutator here already does this;
		// this one was the omission. Gated on an actual row change, like `forgetWorking`, so a
		// no-op invalidation never discards a valid cache.
		invalidateCaches(beam);
		return true;
	}
	const episodic = beam.db.run(
		`
			UPDATE episodic_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
		[now, replacementId, memoryId, beam.sessionId],
	);
	if (episodic.changes > 0) {
		invalidateCaches(beam);
		return true;
	}
	return false;
}

export function getWorkingStats(
	beam: BeamMemoryState,
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): BeamStats {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (authorId) {
		clauses.push("author_id = ?");
		params.push(authorId);
	}
	if (authorType) {
		clauses.push("author_type = ?");
		params.push(authorType);
	}
	if (channelId) {
		clauses.push("channel_id = ?");
		params.push(channelId);
	}
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	using totalStatement = beam.db.prepare(`SELECT COUNT(*) AS total FROM working_memory${where}`);
	const total = totalStatement.get(...params) as {
		total: number;
	};
	using lastStatement = beam.db.prepare(
		`SELECT timestamp FROM working_memory${where} ORDER BY timestamp DESC LIMIT 1`,
	);
	const last = lastStatement.get(...params) as { timestamp: string | null } | null;
	return { total: total.total, count: total.total, last: last?.timestamp ?? null };
}

export function getGlobalWorkingStats(beam: BeamMemoryState): BeamStats {
	return getWorkingStats(beam);
}

export function updateWorking(
	beam: BeamMemoryState,
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
): boolean {
	const baseAssignments: string[] = [];
	const baseParams: SQLQueryBindings[] = [];
	if (content !== null) {
		baseAssignments.push("content = ?", "embed_text = NULL");
		baseParams.push(content);
	}
	if (importance !== null) {
		baseAssignments.push("importance = ?");
		baseParams.push(importance);
	}
	if (baseAssignments.length === 0) return false;
	// The source update and the derivative cleanup must commit as one unit:
	// an exit, a cleanup error, or a concurrent recall between an
	// autocommitted UPDATE and a later purge would see the new content while
	// the old (possibly global) facts still pass the live-source checks. The
	// old-content read happens INSIDE the same transaction: a concurrent
	// writer changing the row between the comparison and the UPDATE would
	// otherwise masquerade as "no content change", skipping the generation
	// rotation and the derivative cleanup.
	const result = transaction(beam.db, () => {
		const oldContent = content !== null
			? (beam.db
					.prepare("SELECT content FROM working_memory WHERE id = ? AND session_id = ?")
					.get(memoryId, beam.sessionId) as { content: string } | null)
			: null;
		const contentChanged = content !== null && oldContent != null && oldContent.content !== content;
		const assignments = [...baseAssignments];
		const params = [...baseParams];
		if (contentChanged) {
			// Advance the extraction generation on every real content change: a
			// pending task bound to the old text must be discarded even when a
			// later edit restores the identical content — the rowid, the created
			// stamp, and the content itself all match again, and only a
			// per-change token tells the incarnations apart.
			assignments.push("generation = ?");
			params.push(freshGeneration());
		}
		params.push(memoryId, beam.sessionId);
		const updated = beam.db.run(
			`UPDATE working_memory SET ${assignments.join(", ")} WHERE id = ? AND session_id = ?`,
			params,
		);
		if (updated.changes > 0) {
			invalidateCaches(beam);
			if (contentChanged) {
				// An edited source no longer supports what was extracted from its
				// old content: retire its fact and graph derivatives so they
				// cannot outlive the statement that produced them (the next
				// extraction pass re-derives facts from the new content). No-op
				// updates keep derivatives. When the other tier holds a row with
				// the same id, provenance retires only this tier's derivatives
				// (working, plus the legacy NULL rows) and leaves the episode's
				// own facts intact.
				const episodeCollision =
					beam.db.prepare("SELECT 1 FROM episodic_memory WHERE id = ?").get(memoryId) !== null;
				purgeWorkingMemoryArtifacts(beam.db, [memoryId], {
					preserveAnnotations: true,
					factTiers: episodeCollision ? ["working"] : undefined,
				});
			}
		}
		return updated;
	});
	if (result.changes > 0 && content !== null) {
		scheduleEmbedding(beam, [{ memoryId, content }]);
	}
	return result.changes > 0;
}

export function get(beam: BeamMemoryState, memoryId: string, channelId?: string | null): Row | null {
	using workingStatement = beam.db.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at, valid_until, superseded_by
		FROM working_memory
		WHERE id = ?
	`);
	const working = workingStatement.get(memoryId) as Row | null | undefined;
	if (working != null) return { ...working, metadata: working.metadata_json, memory_store: "working" };

	using episodicStatement = beam.db.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at, valid_until, superseded_by
		FROM episodic_memory
		WHERE id = ? AND (session_id = ? OR scope = 'global')
	`);
	const episodic = episodicStatement.get(memoryId, beam.sessionId) as Row | null | undefined;
	if (episodic != null) return { ...episodic, metadata: episodic.metadata_json, memory_store: "episodic" };

	return getFact(beam, memoryId, channelId);
}

/**
 * Read-only resolution for ids minted from the `facts` table. `recall`
 * surfaces `facts.fact_id` as a result id (`factRecall`), so `get` must
 * resolve those ids too — otherwise every surfaced fact id is a dead end
 * for the read path (issue #4725). Visibility mirrors `factRecall`:
 * same-session facts plus explicitly global ones (`scope` is an optional
 * column on `facts`; `SELECT *` tolerates banks without it, in which case
 * only same-session facts resolve). The row is shaped like the
 * working/episodic hits with the full triple as content;
 * `memory_store: "fact"` marks it read-only — no update/forget/invalidate
 * path mutates `facts`.
 */
function getFact(beam: BeamMemoryState, memoryId: string, channelId?: string | null): Row | null {
	using statement = beam.db.prepare("SELECT * FROM facts WHERE fact_id = ?");
	const fact = statement.get(memoryId) as Row | null | undefined;
	if (fact == null) return null;
	// Callers that surfaced a fact through a channel (factRecall / enhanced
	// recall with a channelId) must be able to resolve it by id: default the
	// context to the beam's own channel so a plain get() still works.
	const effectiveChannel = channelId ?? beam.channelId ?? null;
	const factChannel = typeof fact.channel_id === "string" ? fact.channel_id : null;
	// The channel match admits the caller only for facts that are themselves
	// channel-scoped — the same no-retroactive-widening guard factRecall
	// applies: a session-scoped fact whose source was later widened must stay
	// private to its session.
	const factChannelOk = fact.scope === "channel" && factChannel !== null && factChannel === effectiveChannel;
	if (fact.session_id !== beam.sessionId && fact.scope !== "global" && !factChannelOk) return null;
	// Mirror factRecall's source rules (factVisibilityWhere in recall.ts): a
	// fact retires with its source when the source is superseded or expired,
	// and stops resolving when the source row is visible to fewer sessions
	// than the fact — otherwise get-by-id is a back door around factRecall.
	const sourceId = typeof fact.source_msg_id === "string" ? fact.source_msg_id : "";
	if (sourceId.length > 0) {
		type SourceRow = { superseded_by: string | null; valid_until: string | null; session_id: string | null; scope: string | null; channel_id: string | null };
		// bun:sqlite get() returns null (not undefined) for a missing row.
		// The tiers' primary keys are independent, so the same id can exist in
		// both; probe both conservatively (mirrors factVisibilityWhere) — a
		// visible row in one tier must not mask a retired or private row in
		// the other.
		const wmSource = beam.db.prepare("SELECT superseded_by, valid_until, session_id, scope, channel_id FROM working_memory WHERE id = ?").get(sourceId) as SourceRow | null;
		const epSource = beam.db.prepare("SELECT superseded_by, valid_until, session_id, scope, channel_id FROM episodic_memory WHERE id = ?").get(sourceId) as SourceRow | null;
		const now = toUtcIso(new Date());
		// Follow the recorded provenance tier: a working-derived fact is judged
		// by the working row alone and an episode-derived fact by the episode
		// row alone, so a private same-id row in the other tier does not hide
		// it. Legacy rows without provenance keep the conservative both-tiers
		// probe.
		const tier = typeof fact.source_tier === "string" ? fact.source_tier : null;
		const sources: (SourceRow | null)[] =
			tier === "working" ? [wmSource] : tier === "episodic" ? [epSource] : [wmSource, epSource];
		for (const source of sources) {
			if (source == null) continue;
			if (source.superseded_by != null) return null;
			if (source.valid_until != null && source.valid_until <= now) return null;
			const sourceChannelOk = source.scope === "channel" && source.channel_id !== null && source.channel_id === effectiveChannel;
			if (source.session_id !== beam.sessionId && source.scope !== "global" && !sourceChannelOk) return null;
		}
	}
	const subject = typeof fact.subject === "string" ? fact.subject : "";
	const predicate = typeof fact.predicate === "string" ? fact.predicate : "";
	const object = typeof fact.object === "string" ? fact.object : "";
	return {
		id: fact.fact_id,
		content: [subject, predicate, object].filter(part => part.length > 0).join(" "),
		source: "facts",
		timestamp: fact.timestamp ?? null,
		session_id: fact.session_id ?? null,
		importance: fact.confidence ?? null,
		metadata: JSON.stringify({
			subject,
			predicate,
			object,
			source_msg_id: fact.source_msg_id ?? null,
		}),
		created_at: fact.created_at ?? null,
		memory_store: "fact",
	};
}

export function forgetWorking(beam: BeamMemoryState, memoryId: string): boolean {
	let deleted = 0;
	transaction(beam.db, () => {
		const result = beam.db.run("DELETE FROM working_memory WHERE id = ? AND session_id = ?", [
			memoryId,
			beam.sessionId,
		]);
		deleted = result.changes;
		if (deleted > 0) {
			purgeWorkingMemoryArtifacts(beam.db, [memoryId]);
		}
	});
	if (deleted > 0) invalidateCaches(beam);
	return deleted > 0;
}

export function scratchpadWrite(beam: BeamMemoryState, content: string): string {
	const padId = generateId(content);
	const timestamp = toUtcIso();
	beam.db.run(
		`
			INSERT INTO scratchpad (id, content, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
		`,
		[padId, content, beam.sessionId, timestamp, timestamp],
	);
	return padId;
}

export function scratchpadRead(beam: BeamMemoryState): Row[] {
	using statement = beam.db.prepare(`
		SELECT id, content, created_at, updated_at
		FROM scratchpad
		WHERE session_id = ?
		ORDER BY updated_at DESC
		LIMIT ?
	`);
	return (
		statement.all(beam.sessionId, Number.isFinite(SCRATCHPAD_MAX_ITEMS) ? SCRATCHPAD_MAX_ITEMS : 1000) as Row[]
	).map(rowToDict);
}

export function scratchpadClear(beam: BeamMemoryState): void {
	beam.db.run("DELETE FROM scratchpad WHERE session_id = ?", [beam.sessionId]);
}

export function exportToDict(beam: BeamMemoryState): Record<string, unknown> {
	const db = beam.db;
	using workingStatement = db.prepare(`
		SELECT id, content, source, timestamp, session_id, importance,
			   embed_text,
			   metadata_json, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, consolidated_at,
			   memory_type, author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM working_memory
		ORDER BY session_id, timestamp
	`);
	using episodicStatement = db.prepare(`
		SELECT rowid, id, content, source, timestamp, session_id, importance,
			   metadata_json, summary_of, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, memory_type,
			   author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM episodic_memory
		ORDER BY session_id, timestamp
	`);
	using scratchpadStatement = db.prepare(`
		SELECT id, content, session_id, created_at, updated_at
		FROM scratchpad
		ORDER BY session_id, updated_at
	`);
	using consolidationStatement = db.prepare(`
		SELECT id, session_id, items_consolidated, summary_preview, created_at
		FROM consolidation_log
		ORDER BY session_id, created_at
	`);
	return {
		mnemopi_export: {
			version: "1.0",
			export_date: toUtcIso(),
			source_db: beam.dbPath ?? ":memory:",
			component: "beam",
		},
		working_memory: workingStatement.all(),
		episodic_memory: episodicStatement.all(),
		episodic_embeddings: [],
		scratchpad: scratchpadStatement.all(),
		consolidation_log: consolidationStatement.all(),
	};
}

export function importFromDict(beam: BeamMemoryState, data: Record<string, unknown>, force = false): ImportStats {
	const stats = {
		working_memory: { inserted: 0, skipped: 0, overwritten: 0 },
		episodic_memory: { inserted: 0, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
		scratchpad: { inserted: 0, updated: 0 },
		consolidation_log: { inserted: 0 },
	} satisfies ImportStats;
	const db: Database = beam.db;
	// Imported working-memory rows are durable, not scratch: stamp any that
	// arrive unconsolidated so the TTL trim treats them as consolidated and can
	// never silently discard a restored bank (issue #4819).
	const importedAt = toUtcIso();
	const oldToNewRowid = new Map<number, number>();

	// Hoisted out of the per-row loops: `db.query` is Bun's cached-statement
	// API (no per-row prepare/finalize churn), and the vec availability probe
	// is loop-invariant (schema is fixed at open).
	const workingExists = db.query("SELECT 1 FROM working_memory WHERE id = ?");
	const episodicExists = db.query("SELECT 1 FROM episodic_memory WHERE id = ?");
	const episodicRowid = db.query("SELECT rowid FROM episodic_memory WHERE id = ?");
	const scratchExists = db.query("SELECT 1 FROM scratchpad WHERE id = ?");
	const vecEpisodesAvailable = vecAvailable(db);
	// Force imports that replace BOTH tiers of a shared id at once: neither old
	// source survives, so the shared untyped artifacts die with them (the
	// episode branch runs the single full purge; the working branch defers).
	const workingPayloadIds = new Set<string>();
	const episodicPayloadIds = new Set<string>();
	// Ids whose working row is NEW (inserted by this payload), not pre-existing:
	// when such an insertion collides with a force-replaced episode, the
	// inserted row owns none of the old artifacts, so the episode branch must
	// run the full purge (it cannot be a tier-scoped collision).
	const workingInsertedIds = new Set<string>();
	for (const raw of Array.isArray(data.working_memory) ? data.working_memory : []) {
		const id = String(jsonObject(raw).id ?? "");
		if (id.length > 0) workingPayloadIds.add(id);
	}
	for (const raw of Array.isArray(data.episodic_memory) ? data.episodic_memory : []) {
		const id = String(jsonObject(raw).id ?? "");
		if (id.length > 0) episodicPayloadIds.add(id);
	}
	const bothTiersReplaced = new Set<string>();
	if (force) {
		for (const id of workingPayloadIds) {
			if (episodicPayloadIds.has(id) && workingExists.get(id) !== null && episodicExists.get(id) !== null) {
				bothTiersReplaced.add(id);
			}
		}
	}
	transaction(db, () => {
		for (const raw of Array.isArray(data.working_memory) ? data.working_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = workingExists.get(id) !== null;
			if (exists && !force) {
				stats.working_memory.skipped++;
				continue;
			}
			if (exists) {
				db.run("DELETE FROM working_memory WHERE id = ?", [id]);
				if (!bothTiersReplaced.has(id)) {
					// Mirror of the episode branch: with a same-id episode row
					// the untyped id is ambiguous, so retire only the working
					// tier's derivatives (working, plus the legacy NULL rows). A
					// both-tier replacement defers to the episode branch's full
					// purge.
					const episodeCollision = episodicExists.get(id) !== null;
					purgeWorkingMemoryArtifacts(db, [id], {
						factTiers: episodeCollision ? ["working"] : undefined,
					});
				}
				stats.working_memory.overwritten++;
			} else {
				workingInsertedIds.add(id);
				stats.working_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO working_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, consolidated_at, memory_type, embed_text, author_id, author_type, channel_id,
				 trust_tier, event_date, event_date_precision, temporal_tags, generation)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					item.consolidated_at == null ? importedAt : sqlBinding(item.consolidated_at, importedAt),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.embed_text, null),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
					freshGeneration(),
				],
			);
		}

		for (const raw of Array.isArray(data.episodic_memory) ? data.episodic_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = episodicExists.get(id) !== null;
			if (exists && !force) {
				stats.episodic_memory.skipped++;
				continue;
			}
			if (exists) {
				const existingRow = episodicRowid.get(id) as {
					rowid: number;
				} | null;
				if (existingRow !== null && vecEpisodesAvailable) {
					try {
						db.run("DELETE FROM vec_episodes WHERE rowid = ?", [existingRow.rowid]);
					} catch {
						// sqlite-vec cleanup is best-effort; import correctness takes precedence.
					}
				}
				db.run("DELETE FROM episodic_memory WHERE id = ?", [id]);
				// A force overwrite replaces the episode's content entirely:
				// cascade the old row's fact / graph / annotation artifacts so
				// the replacement cannot keep derivatives of the overwritten
				// text (mirrors the working-memory branch above).
				const collisionByInsert = workingExists.get(id) !== null && workingInsertedIds.has(id);
				if (bothTiersReplaced.has(id) || collisionByInsert) {
					// Both old tiers were replaced at once (or the colliding
					// working row was itself inserted by this import and owns none
					// of the old artifacts): the shared, untyped artifacts — facts
					// from both tiers, annotations, embeddings, projections, gists,
					// raw-memory edges — belong to the old content and die with it.
					// One full purge, not a tier-scoped one that would leave them
					// behind.
					purgeWorkingMemoryArtifacts(db, [id]);
				} else {
					// Derivative rows are keyed only by the untyped id, so when a
					// PRE-EXISTING working row with the same id exists, provenance
					// retires only the episode's own fact derivatives and leaves
					// the working row's intact.
					const workingCollision = workingExists.get(id) !== null;
					purgeWorkingMemoryArtifacts(db, [id], {
						factTiers: workingCollision ? ["episodic"] : undefined,
					});
				}
				stats.episodic_memory.overwritten++;
			} else {
				stats.episodic_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO episodic_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 summary_of, valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, memory_type, author_id, author_type, channel_id, trust_tier,
				 event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.summary_of, ""),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
				],
			);
			const oldRowid = Number(item.rowid);
			const newRow = episodicRowid.get(id) as {
				rowid: number;
			} | null;
			if (Number.isFinite(oldRowid) && newRow !== null) oldToNewRowid.set(oldRowid, newRow.rowid);
		}

		for (const raw of Array.isArray(data.episodic_embeddings) ? data.episodic_embeddings : []) {
			const item = jsonObject(raw);
			const oldRowid = Number(item.rowid);
			const mappedRowid = oldToNewRowid.get(oldRowid);
			const embedding = Array.isArray(item.embedding) ? item.embedding.map(value => Number(value)) : null;
			if (mappedRowid === undefined || embedding === null || embedding.some(v => !Number.isFinite(v))) {
				continue;
			}
			if (!vecEpisodesAvailable) continue;
			try {
				vecInsert(db, mappedRowid, embedding);
				stats.episodic_memory.embeddings_inserted++;
			} catch {
				// Embedding import is best-effort when sqlite-vec is unavailable or degraded.
			}
		}

		for (const raw of Array.isArray(data.scratchpad) ? data.scratchpad : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = scratchExists.get(id) !== null;
			if (exists) {
				db.run("UPDATE scratchpad SET content = ?, session_id = ?, created_at = ?, updated_at = ? WHERE id = ?", [
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
					id,
				]);
				stats.scratchpad.updated++;
			} else {
				db.run("INSERT INTO scratchpad (id, content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
				]);
				stats.scratchpad.inserted++;
			}
		}

		for (const raw of Array.isArray(data.consolidation_log) ? data.consolidation_log : []) {
			const item = jsonObject(raw);
			db.run(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
				[
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.items_consolidated, 0),
					sqlBinding(item.summary_preview, ""),
					sqlBinding(item.created_at, null),
				],
			);
			stats.consolidation_log.inserted++;
		}
	});
	invalidateCaches(beam);
	return stats;
}
