import type { Database, SQLQueryBindings } from "bun:sqlite";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { transaction } from "../../db";
import { toUtcIso } from "../../util/datetime";
import { generateId } from "../../util/ids";
import { currentEmbeddingModel, embeddingsDisabled } from "../embeddings";
import { EpisodicGraph } from "../episodic-graph";
import { extractFactsSafe } from "../extraction";
import { getMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "../runtime-options";
import { storeFactStrings } from "./consolidate";
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

function invalidateCaches(beam: BeamMemoryState): void {
	const cache = beam.caches as {
		queryCache?: { invalidate?: () => void };
		_queryCache?: { invalidate?: () => void };
	};
	cache.queryCache?.invalidate?.();
	cache._queryCache?.invalidate?.();
}

function findDuplicate(beam: BeamMemoryState, content: string): string | null {
	const row = beam.db
		.prepare("SELECT id FROM working_memory WHERE content = ? AND session_id = ? LIMIT 1")
		.get(content, beam.sessionId) as { id: string } | null;
	return row?.id ?? null;
}

function trimWorkingMemory(beam: BeamMemoryState): void {
	const limit = beam.config.workingMemoryLimit;
	if (!Number.isFinite(limit) || limit <= 0) return;
	const ttlHours = beam.config.workingMemoryTtlHours;
	const cutoff = toUtcIso(new Date(Date.now() - ttlHours * 3_600_000));
	beam.db
		.prepare(`
			DELETE FROM working_memory
			WHERE session_id = ?
			  AND consolidated_at IS NULL
			  AND (
				timestamp < ? OR
				id NOT IN (
					SELECT id FROM working_memory
					WHERE session_id = ? AND consolidated_at IS NULL
					ORDER BY timestamp DESC
					LIMIT ?
				)
			  )
		`)
		.run(beam.sessionId, cutoff, beam.sessionId, limit);
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
		});
	} catch {
		// Proactive graph enrichment must never block durable memory storage.
	}
}

/**
 * Run the LLM fact extractor over freshly stored content and persist the
 * resulting facts. Best-effort: failures (no LLM, closed DB, malformed output)
 * are swallowed so they can never disrupt the synchronous `remember` that
 * scheduled them.
 */
async function runFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): Promise<void> {
	try {
		const facts = await extractFactsSafe(content);
		if (facts.length === 0) return;
		storeFactStrings(beam, facts, 0, memoryId);
		invalidateCaches(beam);
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
	const task = withMnemopiRuntimeOptions(runtimeOptions, () => runFactExtraction(beam, memoryId, content));
	const pending = beam.pendingExtractions;
	if (pending !== undefined) {
		pending.add(task);
		void task.finally(() => pending.delete(task));
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
				SELECT id AS memoryId, content FROM working_memory WHERE superseded_by IS NULL
				UNION ALL
				SELECT id AS memoryId, content FROM episodic_memory WHERE superseded_by IS NULL
			`)
			.all() as EmbedItem[];

		transaction(beam.db, () => {
			beam.db.prepare("DELETE FROM memory_embeddings").run();
			beam.db.prepare("UPDATE episodic_memory SET binary_vector = NULL").run();
			if (vecAvailable(beam.db)) {
				try {
					beam.db.prepare("DELETE FROM vec_episodes").run();
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
			SELECT id AS memoryId, content FROM working_memory
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

	const existingId = findDuplicate(beam, content);
	if (existingId !== null) {
		beam.db
			.prepare(`
				UPDATE working_memory
				SET importance = MAX(importance, ?), timestamp = ?, source = ?,
					valid_until = COALESCE(?, valid_until),
					scope = COALESCE(?, scope),
					author_id = COALESCE(?, author_id),
					author_type = COALESCE(?, author_type),
					channel_id = COALESCE(?, channel_id),
					memory_type = COALESCE(?, memory_type),
					veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END,
					trust_tier = COALESCE(?, trust_tier),
					consolidated_at = NULL
				WHERE id = ? AND session_id = ?
			`)
			.run(
				importance,
				timestamp,
				source,
				validUntil,
				scope,
				authorId,
				authorType,
				channelId,
				memoryType,
				veracity,
				veracity,
				trustTier,
				existingId,
				beam.sessionId,
			);
		emitEvent(beam, "MEMORY_UPDATED", {
			memoryId: existingId,
			content,
			source,
			importance,
			metadata: metadata ?? undefined,
		});
		invalidateCaches(beam);
		return existingId;
	}

	const memoryId = options.memoryId ?? options.memory_id ?? generateId(content, new Date(timestamp));
	beam.db
		.prepare(`
			INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, valid_until, scope,
			 author_id, author_type, channel_id, veracity, memory_type, trust_tier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			memoryId,
			content,
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
	scheduleEmbedding(beam, [{ memoryId, content }]);
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
		const statement = beam.db.prepare(`
			INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json,
			 author_id, author_type, channel_id, memory_type, veracity, trust_tier, scope)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const item of items) {
			const itemTimestamp = item.timestamp ?? timestamp;
			const memoryId = generateId(item.content, new Date(itemTimestamp));
			ids.push(memoryId);
			const source = item.source ?? "conversation";
			const storeItem = item as StoreRememberOptions;
			const itemVeracity = forceVeracity
				? defaultVeracity
				: item.veracity !== undefined
					? clampVeracity(item.veracity)
					: defaultVeracity;
			statement.run(
				memoryId,
				item.content,
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
		embeddingItems.push({ memoryId: id, content: item.content });
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
	return (
		beam.db
			.prepare(`
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
			`)
			.all(beam.sessionId, now, limit) as Row[]
	).map(rowToDict);
}

export function invalidate(beam: BeamMemoryState, memoryId: string, replacementId: string | null = null): boolean {
	const now = toUtcIso();
	const working = beam.db
		.prepare(`
			UPDATE working_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.run(now, replacementId, memoryId, beam.sessionId);
	if (working.changes > 0) return true;
	const episodic = beam.db
		.prepare(`
			UPDATE episodic_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.run(now, replacementId, memoryId, beam.sessionId);
	return episodic.changes > 0;
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
	const total = beam.db.prepare(`SELECT COUNT(*) AS total FROM working_memory${where}`).get(...params) as {
		total: number;
	};
	const last = beam.db
		.prepare(`SELECT timestamp FROM working_memory${where} ORDER BY timestamp DESC LIMIT 1`)
		.get(...params) as { timestamp: string | null } | null;
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
	const assignments: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (content !== null) {
		assignments.push("content = ?");
		params.push(content);
	}
	if (importance !== null) {
		assignments.push("importance = ?");
		params.push(importance);
	}
	if (assignments.length === 0) return false;
	params.push(memoryId, beam.sessionId);
	const result = beam.db
		.prepare(`UPDATE working_memory SET ${assignments.join(", ")} WHERE id = ? AND session_id = ?`)
		.run(...params);
	if (result.changes > 0) {
		invalidateCaches(beam);
		if (content !== null) scheduleEmbedding(beam, [{ memoryId, content }]);
	}
	return result.changes > 0;
}

export function get(beam: BeamMemoryState, memoryId: string): Row | null {
	const working = beam.db
		.prepare(`
			SELECT id, content, source, timestamp, session_id,
				   importance, metadata_json, veracity, created_at
			FROM working_memory
			WHERE id = ?
		`)
		.get(memoryId) as Row | null | undefined;
	if (working != null) return { ...working, metadata: working.metadata_json, memory_store: "working" };

	const episodic = beam.db
		.prepare(`
			SELECT id, content, source, timestamp, session_id,
				   importance, metadata_json, veracity, created_at
			FROM episodic_memory
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`)
		.get(memoryId, beam.sessionId) as Row | null | undefined;
	return episodic == null ? null : { ...episodic, metadata: episodic.metadata_json, memory_store: "episodic" };
}

export function forgetWorking(beam: BeamMemoryState, memoryId: string): boolean {
	let deleted = 0;
	transaction(beam.db, () => {
		const result = beam.db
			.prepare("DELETE FROM working_memory WHERE id = ? AND session_id = ?")
			.run(memoryId, beam.sessionId);
		deleted = result.changes;
		if (deleted > 0) {
			beam.db.prepare("DELETE FROM annotations WHERE memory_id = ?").run(memoryId);
		}
	});
	if (deleted > 0) invalidateCaches(beam);
	return deleted > 0;
}

export function scratchpadWrite(beam: BeamMemoryState, content: string): string {
	const padId = generateId(content);
	const timestamp = toUtcIso();
	beam.db
		.prepare(`
			INSERT INTO scratchpad (id, content, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
		`)
		.run(padId, content, beam.sessionId, timestamp, timestamp);
	return padId;
}

export function scratchpadRead(beam: BeamMemoryState): Row[] {
	return (
		beam.db
			.prepare(`
				SELECT id, content, created_at, updated_at
				FROM scratchpad
				WHERE session_id = ?
				ORDER BY updated_at DESC
				LIMIT ?
			`)
			.all(beam.sessionId, Number.isFinite(SCRATCHPAD_MAX_ITEMS) ? SCRATCHPAD_MAX_ITEMS : 1000) as Row[]
	).map(rowToDict);
}

export function scratchpadClear(beam: BeamMemoryState): void {
	beam.db.prepare("DELETE FROM scratchpad WHERE session_id = ?").run(beam.sessionId);
}

export function exportToDict(beam: BeamMemoryState): Record<string, unknown> {
	const db = beam.db;
	return {
		mnemopi_export: {
			version: "1.0",
			export_date: toUtcIso(),
			source_db: beam.dbPath ?? ":memory:",
			component: "beam",
		},
		working_memory: db
			.prepare(`
				SELECT id, content, source, timestamp, session_id, importance,
					   metadata_json, valid_until, superseded_by, scope,
					   recall_count, last_recalled, created_at, veracity, consolidated_at,
					   memory_type, author_id, author_type, channel_id, trust_tier,
					   event_date, event_date_precision, temporal_tags
				FROM working_memory
				ORDER BY session_id, timestamp
			`)
			.all(),
		episodic_memory: db
			.prepare(`
				SELECT rowid, id, content, source, timestamp, session_id, importance,
					   metadata_json, summary_of, valid_until, superseded_by, scope,
					   recall_count, last_recalled, created_at, veracity, memory_type,
					   author_id, author_type, channel_id, trust_tier,
					   event_date, event_date_precision, temporal_tags
				FROM episodic_memory
				ORDER BY session_id, timestamp
			`)
			.all(),
		episodic_embeddings: [],
		scratchpad: db
			.prepare(`
				SELECT id, content, session_id, created_at, updated_at
				FROM scratchpad
				ORDER BY session_id, updated_at
			`)
			.all(),
		consolidation_log: db
			.prepare(`
				SELECT id, session_id, items_consolidated, summary_preview, created_at
				FROM consolidation_log
				ORDER BY session_id, created_at
			`)
			.all(),
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
	const oldToNewRowid = new Map<number, number>();

	transaction(db, () => {
		for (const raw of Array.isArray(data.working_memory) ? data.working_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = db.prepare("SELECT 1 FROM working_memory WHERE id = ?").get(id) !== null;
			if (exists && !force) {
				stats.working_memory.skipped++;
				continue;
			}
			if (exists) {
				db.prepare("DELETE FROM working_memory WHERE id = ?").run(id);
				stats.working_memory.overwritten++;
			} else {
				stats.working_memory.inserted++;
			}
			db.prepare(`
				INSERT INTO working_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, consolidated_at, memory_type, author_id, author_type, channel_id,
				 trust_tier, event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
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
				sqlBinding(item.consolidated_at, null),
				sqlBinding(item.memory_type, "unknown"),
				sqlBinding(item.author_id, null),
				sqlBinding(item.author_type, null),
				sqlBinding(item.channel_id, null),
				sqlBinding(item.trust_tier, "STATED"),
				sqlBinding(item.event_date, null),
				sqlBinding(item.event_date_precision, "unknown"),
				sqlBinding(item.temporal_tags, "[]"),
			);
		}

		for (const raw of Array.isArray(data.episodic_memory) ? data.episodic_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = db.prepare("SELECT 1 FROM episodic_memory WHERE id = ?").get(id) !== null;
			if (exists && !force) {
				stats.episodic_memory.skipped++;
				continue;
			}
			if (exists) {
				const existingRow = db.prepare("SELECT rowid FROM episodic_memory WHERE id = ?").get(id) as {
					rowid: number;
				} | null;
				if (existingRow !== null && vecAvailable(db)) {
					try {
						db.prepare("DELETE FROM vec_episodes WHERE rowid = ?").run(existingRow.rowid);
					} catch {
						// sqlite-vec cleanup is best-effort; import correctness takes precedence.
					}
				}
				db.prepare("DELETE FROM episodic_memory WHERE id = ?").run(id);
				stats.episodic_memory.overwritten++;
			} else {
				stats.episodic_memory.inserted++;
			}
			db.prepare(`
				INSERT INTO episodic_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 summary_of, valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, memory_type, author_id, author_type, channel_id, trust_tier,
				 event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
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
			);
			const oldRowid = Number(item.rowid);
			const newRow = db.prepare("SELECT rowid FROM episodic_memory WHERE id = ?").get(id) as {
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
			if (!vecAvailable(db)) continue;
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
			const exists = db.prepare("SELECT 1 FROM scratchpad WHERE id = ?").get(id) !== null;
			if (exists) {
				db.prepare(
					"UPDATE scratchpad SET content = ?, session_id = ?, created_at = ?, updated_at = ? WHERE id = ?",
				).run(
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
					id,
				);
				stats.scratchpad.updated++;
			} else {
				db.prepare(
					"INSERT INTO scratchpad (id, content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				).run(
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
				);
				stats.scratchpad.inserted++;
			}
		}

		for (const raw of Array.isArray(data.consolidation_log) ? data.consolidation_log : []) {
			const item = jsonObject(raw);
			db.prepare(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
			).run(
				sqlBinding(item.session_id, "default"),
				sqlBinding(item.items_consolidated, 0),
				sqlBinding(item.summary_preview, ""),
				sqlBinding(item.created_at, null),
			);
			stats.consolidation_log.inserted++;
		}
	});
	invalidateCaches(beam);
	return stats;
}
