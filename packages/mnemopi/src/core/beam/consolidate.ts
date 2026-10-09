import type { SQLQueryBindings } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { generateId, stableMemoryId } from "../../util/ids";
import { aaakEncode } from "../aaak";
import { REGEX_EXTRACTION_MAX_INPUT_CHARS } from "../entities";
import { EpisodicGraph } from "../episodic-graph";
import { type ExtractedFactCategories, type ExtractedMemoryFact, heuristicExtractFacts } from "../extraction";
import { hasRetainableContent } from "../content-noise";
import {
	classifyObservation,
	clampVeracity,
	mergeEvidenceSources,
	normalizeObservationText,
	observationIdentityText,
	recordMemoryValidation,
	SINGLE_VALUED_PREDICATES,
	VERACITY_WEIGHTS,
	type Veracity,
	VeracityConsolidator,
} from "../veracity-consolidation";
import { scheduleEmbedding } from "./helpers";
import type {
	BeamMemoryState,
	BeamStats,
	JsonValue,
	MemoryFactKind,
	MemoriaRetrieveResult,
	Metadata,
	SleepResult,
} from "./types";

type Row = Record<string, unknown>;

type FactCounts = {
	metric: number;
	date: number;
	version: number;
	entity: number;
	sequence: number;
	timeline: number;
	negation: number;
	decision: number;
};

type ConsolidateOptions = {
	metadata?: Metadata | null;
	validUntil?: string | null;
	scope?: string;
	veracity?: string | null;
};

const CONTAMINATED_VERACITY: Record<string, true> = {
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
	false: true,
};

const EPISODIC_VERACITY_WEIGHT = {
	true: 1.0,
	stated: 1.0,
	unknown: 0.8,
	inferred: 0.7,
	imported: 0.6,
	tool: 0.5,
	false: 0.0,
} as const;

type EpisodicVeracity = keyof typeof EPISODIC_VERACITY_WEIGHT;

function envInt(name: string, defaultValue: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

const SLEEP_BATCH_SIZE = envInt("MNEMOPI_SLEEP_BATCH", 5000);
const TIER2_DAYS = envInt("MNEMOPI_TIER2_DAYS", 30);
const TIER3_DAYS = envInt("MNEMOPI_TIER3_DAYS", 180);
const DEGRADE_BATCH_SIZE = envInt("MNEMOPI_DEGRADE_BATCH", 100);
const TIER3_MAX_CHARS = envInt("MNEMOPI_TIER3_MAX_CHARS", 300);
const DEFAULT_MAX_EPISODE_CHARS = 100_000;
const SLEEP_SUMMARY_SEPARATOR = " | ";
const SLEEP_TRUNCATION_MARKER = "\n[... sleep_consolidation episode truncated by maxEpisodeChars ...]";
const PATTERN_FACT_EXTRACTION_MAX_INPUT_CHARS = REGEX_EXTRACTION_MAX_INPUT_CHARS;

type SleepSummary = {
	summary: string;
	originalChars: number;
	truncated: boolean;
	maxChars: number;
};
type SleepChunk = {
	items: Row[];
	originalChars: number;
};

function normalizedMaxEpisodeChars(beam: BeamMemoryState): number {
	const configured = Math.trunc(beam.config?.maxEpisodeChars ?? DEFAULT_MAX_EPISODE_CHARS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_EPISODE_CHARS;
}

function markTruncated(content: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (maxChars <= SLEEP_TRUNCATION_MARKER.length) return content.slice(0, maxChars);
	const bodyChars = maxChars - SLEEP_TRUNCATION_MARKER.length;
	return `${content.slice(0, bodyChars).trimEnd()}${SLEEP_TRUNCATION_MARKER}`;
}

function splitSleepItems(beam: BeamMemoryState, source: string, items: readonly Row[]): SleepChunk[] {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefixChars = `[${source}] `.length;
	const joinedLimit = Math.max(0, maxChars - prefixChars);
	const chunks: SleepChunk[] = [];
	let current: Row[] = [];
	let currentChars = 0;

	for (const item of items) {
		const contentChars = (rowValue(item, "content") ?? "").length;
		const separatorChars = current.length === 0 ? 0 : SLEEP_SUMMARY_SEPARATOR.length;
		if (current.length > 0 && currentChars + separatorChars + contentChars > joinedLimit) {
			chunks.push({ items: current, originalChars: currentChars });
			current = [];
			currentChars = 0;
		}
		current.push(item);
		currentChars += (current.length === 1 ? 0 : SLEEP_SUMMARY_SEPARATOR.length) + contentChars;
	}
	if (current.length > 0) chunks.push({ items: current, originalChars: currentChars });
	return chunks;
}

function buildSleepSummary(beam: BeamMemoryState, source: string, chunk: SleepChunk): SleepSummary {
	const maxChars = normalizedMaxEpisodeChars(beam);
	const prefix = `[${source}] `;
	const joined = chunk.items.map(item => rowValue(item, "content") ?? "").join(SLEEP_SUMMARY_SEPARATOR);
	const uncapped = `${prefix}${aaakEncode(joined)}`;
	const truncated = uncapped.length > maxChars;
	return {
		summary: truncated ? markTruncated(uncapped, maxChars) : uncapped,
		originalChars: chunk.originalChars,
		truncated,
		maxChars,
	};
}

function isoNow(): string {
	return new Date().toISOString();
}

function cutoffIso(amount: number, unitMs: number): string {
	return new Date(Date.now() - amount * unitMs).toISOString();
}

function json(metadata: Metadata | null | undefined): string {
	return JSON.stringify(metadata ?? {});
}

function rowValue(row: Row, key: string): string | null {
	const value = row[key];
	return value == null ? null : String(value);
}

function isEpisodicVeracity(value: string): value is EpisodicVeracity {
	return Object.hasOwn(EPISODIC_VERACITY_WEIGHT, value);
}

function clampEpisodicVeracity(raw: unknown): EpisodicVeracity {
	if (raw === null || raw === undefined) return "unknown";
	const norm = String(raw).trim().toLowerCase();
	if (norm === "") return "unknown";
	if (isEpisodicVeracity(norm)) return norm;
	const clamped = clampVeracity(raw, "consolidateToEpisodic.veracity");
	return isEpisodicVeracity(clamped) ? clamped : "unknown";
}

function aggregateEpisodicVeracity(sourceVeracities: readonly string[]): EpisodicVeracity {
	let winner: EpisodicVeracity | null = null;
	let maxCount = 0;
	const counts = new Map<EpisodicVeracity, number>();
	for (const raw of sourceVeracities) {
		const value = clampEpisodicVeracity(raw);
		if (value === "unknown") continue;
		const count = (counts.get(value) ?? 0) + 1;
		counts.set(value, count);
		if (
			count > maxCount ||
			(count === maxCount && (winner === null || EPISODIC_VERACITY_WEIGHT[value] < EPISODIC_VERACITY_WEIGHT[winner]))
		) {
			winner = value;
			maxCount = count;
		}
	}
	if (winner !== null) return winner;
	for (const raw of sourceVeracities) {
		if (clampEpisodicVeracity(raw) === "unknown") return "unknown";
	}
	return "unknown";
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function contextSnippet(content: string, index: number, width = 50): string {
	const start = Math.max(0, index - width);
	const end = Math.min(content.length, index + width);
	return compactWhitespace(content.slice(start, end));
}

function sourceSession(beam: BeamMemoryState): string {
	return beam.sessionId || "default";
}

function asRows(value: unknown): Row[] {
	return Array.isArray(value) ? (value as Row[]) : [];
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, m => `\\${m}`);
}

function makeQuestionTokens(query: string): string[] {
	const stop = new Set([
		"a",
		"an",
		"and",
		"are",
		"as",
		"at",
		"did",
		"do",
		"does",
		"for",
		"from",
		"how",
		"i",
		"in",
		"is",
		"it",
		"me",
		"my",
		"of",
		"on",
		"or",
		"the",
		"to",
		"was",
		"were",
		"what",
		"when",
		"where",
		"which",
		"who",
		"with",
	]);
	return [...query.toLowerCase().matchAll(/[\p{L}\p{N}_.-]+/gu)]
		.map(m => m[0] ?? "")
		.filter(token => token.length > 1 && !stop.has(token))
		.slice(0, 8);
}

function emitEvent(
	beam: BeamMemoryState,
	type: string,
	memoryId: string,
	content: string,
	source: string,
	importance: number,
	metadata: Metadata,
): void {
	const event = {
		type,
		sessionId: beam.sessionId,
		timestamp: isoNow(),
		memoryId,
		content,
		source,
		importance,
		metadata,
	};
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

interface ObservationFactRow {
	readonly fact_id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly sources_json: string | null;
	readonly superseded_by: string | null;
	readonly source_msg_id: string | null;
}

interface ObservationPreferenceRow {
	readonly id: number;
	readonly preference: string | null;
	readonly sources_json: string | null;
	readonly superseded_by: string | null;
	readonly source_memory_id: string | null;
}

interface EvidenceSource {
	readonly sourceId: string;
	readonly fromSummary: boolean;
	readonly scope: string;
}

function memoryScope(beam: BeamMemoryState, memoryId: string): string | null {
	const working = beam.db.query("SELECT scope FROM working_memory WHERE id = ?").get(memoryId) as {
		scope: string | null;
	} | null;
	if (working !== null) return working.scope;
	const episodic = beam.db.query("SELECT scope FROM episodic_memory WHERE id = ?").get(memoryId) as {
		scope: string | null;
	} | null;
	return episodic?.scope ?? null;
}

function evidenceSource(beam: BeamMemoryState, sourceMemoryId: string | null): EvidenceSource {
	const raw = sourceMemoryId?.trim() ?? "";
	if (raw === "") return { sourceId: `session:${sourceSession(beam)}`, fromSummary: false, scope: "session" };
	const episodic = beam.db.query("SELECT summary_of, scope FROM episodic_memory WHERE id = ?").get(raw) as {
		summary_of: string | null;
		scope: string | null;
	} | null;
	if (episodic?.summary_of) {
		const summaryScope = episodic.scope && episodic.scope !== "" ? episodic.scope : "session";
		return { sourceId: raw, fromSummary: true, scope: summaryScope };
	}
	const scope = memoryScope(beam, raw) ?? "session";
	return { sourceId: raw, fromSummary: false, scope: scope === "" ? "session" : scope };
}

function seededSources(raw: string | null, legacySource: string | null): string | null {
	if (raw !== null && raw !== "") return raw;
	const legacy = legacySource?.trim() ?? "";
	return legacy === "" ? null : JSON.stringify([legacy]);
}

function canonicalFactId(
	memoryKind: MemoryFactKind,
	factType: string,
	key: string,
	value: string,
	scope: string,
	sessionId: string,
): string {
	const visibility = scope === "global" ? "global" : `${scope}\0${sessionId}`;
	return stableMemoryId(
		`${memoryKind}\0${factType}\0${key}\0${observationIdentityText(value)}\0${visibility}`,
		"",
	);
}

function sameVisibility(scope: string, sessionId: string): { sql: string; params: string[] } {
	if (scope === "global") return { sql: "scope = 'global'", params: [] };
	return { sql: "(session_id = ? AND (scope IS NULL OR scope != 'global'))", params: [sessionId] };
}

function findCanonicalFact(
	beam: BeamMemoryState,
	memoryKind: MemoryFactKind,
	factType: string,
	key: string,
	value: string,
	factId: string,
	scope: string,
	sessionId: string,
): ObservationFactRow | null {
	const visibility = sameVisibility(scope, sessionId);
	// Existing banks used an unscoped, punctuation-normalized id. Reuse that row
	// only when its actual claim and visibility match; C++ and C# shared that id.
	const legacyId = stableMemoryId(`${memoryKind}\0${factType}\0${key}\0${normalizeObservationText(value)}`, "");
	const rows = beam.db
		.query(
			`SELECT fact_id, subject, predicate, object, confidence, sources_json, superseded_by, source_msg_id
			 FROM facts
			 WHERE memory_kind = ? AND predicate = ? AND subject = ? AND (fact_id IN (?, ?) OR object = ?)
			   AND ${visibility.sql}
			 ORDER BY CASE WHEN fact_id = ? THEN 0 ELSE 1 END,
			          CASE WHEN superseded_by IS NULL THEN 0 ELSE 1 END`,
		)
		.all(memoryKind, factType, key, factId, legacyId, value, ...visibility.params, factId) as ObservationFactRow[];
	const identity = observationIdentityText(value);
	return rows.find(row => observationIdentityText(row.object) === identity) ?? null;
}

function strengthenCanonicalFact(
	beam: BeamMemoryState,
	row: ObservationFactRow,
	sourceId: string,
	quote: string,
	revive: boolean,
): boolean {
	const merged = mergeEvidenceSources(seededSources(row.sources_json, row.source_msg_id), sourceId);
	if (!merged.added && !revive) return false;
	const confidence = Math.min(1, row.confidence + (1 - row.confidence) * 0.15);
	beam.db.run(
		`UPDATE facts
		 SET proof_count = ?, sources_json = ?, confidence = ?, timestamp = ?,
		     superseded_by = CASE WHEN ? = 1 THEN NULL ELSE superseded_by END
		 WHERE fact_id = ?`,
		[merged.sources.length, JSON.stringify(merged.sources), confidence, isoNow(), revive ? 1 : 0, row.fact_id],
	);
	if (!merged.added) return true;
	recordMemoryValidation(beam.db, { memoryId: row.fact_id, sourceId, action: "reinforce", quote });
	return true;
}

function ageFact(
	beam: BeamMemoryState,
	old: ObservationFactRow,
	winnerId: string,
	sourceId: string,
	quote: string,
	newContent: string,
): void {
	beam.db.run(`UPDATE facts SET superseded_by = ?, confidence = ? WHERE fact_id = ? AND superseded_by IS NULL`, [
		winnerId,
		Math.max(0.05, old.confidence * 0.5),
		old.fact_id,
	]);
	recordMemoryValidation(beam.db, {
		memoryId: old.fact_id,
		sourceId,
		action: "weaken",
		quote,
		newContent,
	});
}

function explicitContradictions(
	beam: BeamMemoryState,
	factType: string,
	key: string,
	memoryKind: MemoryFactKind,
	exceptId: string,
	value: string,
	scope: string,
	sessionId: string,
): ObservationFactRow[] {
	const visibility = sameVisibility(scope, sessionId);
	const rows = beam.db
		.query(
			`SELECT fact_id, subject, predicate, object, confidence, sources_json, superseded_by, source_msg_id
			 FROM facts
			 WHERE predicate = ? AND subject = ? AND memory_kind = ? AND superseded_by IS NULL AND fact_id != ?
			   AND ${visibility.sql}
			 ORDER BY rowid DESC
			 LIMIT 40`,
		)
		.all(factType, key, memoryKind, exceptId, ...visibility.params) as ObservationFactRow[];
	return rows.filter(row => classifyObservation(value, row.object) === "contradicts");
}

function insertFactRows(
	beam: BeamMemoryState,
	messageIdx: number,
	factType: string,
	key: string,
	value: string,
	context: string,
	importance: number,
	sourceMemoryId: string | null,
	memoryKind: MemoryFactKind = "world",
): void {
	const timestamp = isoNow();
	const sessionId = sourceSession(beam);
	beam.db.run(
		`INSERT INTO memoria_facts
		 (session_id, message_idx, fact_type, memory_kind, key, value, context_snippet, importance, timestamp, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[sessionId, messageIdx, factType, memoryKind, key, value, context, importance, timestamp, sourceMemoryId],
	);

	const evidence = evidenceSource(beam, sourceMemoryId);
	const quote = context.trim() === "" ? value : context;
	const canonicalId = canonicalFactId(memoryKind, factType, key, value, evidence.scope, sessionId);
	const same = findCanonicalFact(
		beam,
		memoryKind,
		factType,
		key,
		value,
		canonicalId,
		evidence.scope,
		sessionId,
	);
	if (same !== null) {
		if (evidence.fromSummary && same.superseded_by !== null) return;
		strengthenCanonicalFact(
			beam,
			same,
			evidence.sourceId,
			quote,
			same.superseded_by !== null && !evidence.fromSummary,
		);
		if (same.superseded_by !== null && !evidence.fromSummary) {
			for (const old of explicitContradictions(
				beam,
				factType,
				key,
				memoryKind,
				same.fact_id,
				value,
				evidence.scope,
				sessionId,
			)) {
				ageFact(beam, old, same.fact_id, evidence.sourceId, quote, value);
			}
		}
		return;
	}

	const inserted = beam.db.run(
		`INSERT OR IGNORE INTO facts
		 (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence, memory_kind, scope, proof_count, sources_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
		[
			canonicalId,
			sessionId,
			key,
			factType,
			value,
			timestamp,
			sourceMemoryId,
			importance,
			memoryKind,
			evidence.scope,
			JSON.stringify([evidence.sourceId]),
		],
	);
	if (inserted.changes === 0) {
		const raced = findCanonicalFact(
			beam,
			memoryKind,
			factType,
			key,
			value,
			canonicalId,
			evidence.scope,
			sessionId,
		);
		if (raced === null || (evidence.fromSummary && raced.superseded_by !== null)) return;
		strengthenCanonicalFact(
			beam,
			raced,
			evidence.sourceId,
			quote,
			raced.superseded_by !== null && !evidence.fromSummary,
		);
		return;
	}
	for (const old of explicitContradictions(
		beam,
		factType,
		key,
		memoryKind,
		canonicalId,
		value,
		evidence.scope,
		sessionId,
	)) {
		ageFact(beam, old, canonicalId, evidence.sourceId, quote, value);
	}
}

function insertTimeline(
	beam: BeamMemoryState,
	messageIdx: number,
	date: string | null,
	description: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_timelines (session_id, date, message_idx, description, source, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), date, messageIdx, description, "extraction", sourceMemoryId],
	);
}

function insertKg(
	beam: BeamMemoryState,
	messageIdx: number,
	subject: string,
	predicate: string,
	object: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_kg (session_id, subject, predicate, object, message_idx, confidence, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), subject, predicate, object, messageIdx, 0.65, sourceMemoryId],
	);
	beam.db.run(
		`INSERT INTO triples (subject, predicate, object, valid_from, source, confidence)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[subject, predicate, object, isoNow(), sourceMemoryId ?? "extraction", 0.65],
	);
	void beam.triples?.add?.(subject, predicate, object, {
		source: sourceMemoryId ?? "extraction",
		confidence: 0.65,
	});
	consolidateKgFact(beam, subject, predicate, object, sourceMemoryId);
}

/** Veracity of the memory a fact was extracted from, restricted to the consolidator's vocabulary. */
function sourceMemoryVeracity(beam: BeamMemoryState, sourceMemoryId: string | null): Veracity {
	if (sourceMemoryId === null) return "unknown";
	const row = (beam.db.query("SELECT veracity FROM working_memory WHERE id = ?").get(sourceMemoryId) ??
		beam.db.query("SELECT veracity FROM episodic_memory WHERE id = ?").get(sourceMemoryId)) as {
		veracity: string | null;
	} | null;
	const veracity = row?.veracity ?? "unknown";
	return Object.hasOwn(VERACITY_WEIGHTS, veracity) ? (veracity as Veracity) : "unknown";
}

/**
 * This beam's veracity consolidator, created on first fact write. `consolidated_facts`
 * is the cross-session observation store, not a polyphonic-only side table.
 */
export function ensureVeracityConsolidator(beam: BeamMemoryState): VeracityConsolidator {
	const existing = beam.veracityConsolidator;
	if (existing instanceof VeracityConsolidator && existing.conn === beam.db) return existing;
	const consolidator = new VeracityConsolidator(beam.dbPath ?? ":memory:", beam.db);
	beam.veracityConsolidator = consolidator;
	return consolidator;
}

/**
 * Feed an extracted subject/predicate/object fact into the veracity consolidator so
 * repeated mentions gain confidence in `consolidated_facts`. Runs on every KG write,
 * including while polyphonic recall is off. A matching claim from a new source
 * strengthens; a single-valued contradiction is aged with `superseded_by` instead of
 * being left as a second current fact. Best-effort: a failure never blocks the write.
 */
function consolidateKgFact(
	beam: BeamMemoryState,
	subject: string,
	predicate: string,
	object: string,
	sourceMemoryId: string | null,
): void {
	const cleanSubject = subject.trim();
	const cleanPredicate = predicate.trim();
	const cleanObject = object.trim();
	if (cleanSubject === "" || cleanPredicate === "" || cleanObject === "") return;
	const evidence = evidenceSource(beam, sourceMemoryId);
	const sourceId = evidence.sourceId;
	const quote = `${cleanSubject} ${cleanPredicate} ${cleanObject}`;
	try {
		const consolidator = ensureVeracityConsolidator(beam);
		if (evidence.fromSummary) {
			const existing = consolidator.conn
				.query(
					"SELECT superseded_by, sources_json FROM consolidated_facts WHERE subject = ? AND predicate = ? AND object = ?",
				)
				.get(cleanSubject, cleanPredicate, cleanObject) as {
				superseded_by: string | null;
				sources_json: string | null;
			} | null;
			if (existing !== null && existing.superseded_by !== null) return;
			if (existing !== null && !mergeEvidenceSources(existing.sources_json, sourceId).added) return;
		}
		const prior = consolidator.conn
			.query("SELECT sources_json FROM consolidated_facts WHERE subject = ? AND predicate = ? AND object = ?")
			.get(cleanSubject, cleanPredicate, cleanObject) as { sources_json: string | null } | null;
		const priorCount = mergeEvidenceSources(prior?.sources_json ?? null, "").sources.length;
		const consolidated = consolidator.consolidateFact(
			cleanSubject,
			cleanPredicate,
			cleanObject,
			sourceMemoryVeracity(beam, sourceMemoryId),
			sourceId,
		);
		if (priorCount > 0 && consolidated.sources.length > priorCount && consolidated.id !== null) {
			recordMemoryValidation(beam.db, {
				memoryId: consolidated.id,
				sourceId,
				action: "reinforce",
				quote,
			});
		}
		if (!Object.hasOwn(SINGLE_VALUED_PREDICATES, cleanPredicate.toLowerCase())) return;
		const winnerId = consolidated.id;
		if (winnerId === null) return;
		if (!evidence.fromSummary) {
			consolidator.conn.run(
				`UPDATE consolidated_facts SET superseded_by = NULL, updated_at = ? WHERE id = ? AND superseded_by IS NOT NULL`,
				[isoNow(), winnerId],
			);
		}
		const losers = beam.db
			.query(
				`SELECT id FROM consolidated_facts
				 WHERE subject = ? AND predicate = ? AND object != ? AND superseded_by IS NULL`,
			)
			.all(cleanSubject, cleanPredicate, cleanObject) as { id: string }[];
		for (const loser of losers) {
			if (loser.id === winnerId) continue;
			ensureVeracityConsolidator(beam).resolveConflictByFacts(winnerId, loser.id);
			recordMemoryValidation(beam.db, {
				memoryId: loser.id,
				sourceId,
				action: "weaken",
				quote,
				newContent: cleanObject,
			});
		}
	} catch (error) {
		logger.warn("mnemopi: fact consolidation failed", { subject: cleanSubject, error: String(error) });
	}
}

/**
 * Consolidate extracted KG facts (`memoria_kg`) whose source is not yet among that
 * fact's `consolidated_facts` sources. New writes consolidate immediately; this
 * catches legacy banks and writes whose consolidation failed. Idempotent: a
 * (fact, source) pair is only ever counted once. Facts without a source memory
 * are skipped; the fact voice could not return them.
 */
export function backfillConsolidatedFacts(beam: BeamMemoryState, consolidator: VeracityConsolidator): number {
	const rows = beam.db
		.query(`
			SELECT trim(k.subject) AS subject, trim(k.predicate) AS predicate, trim(k.object) AS object,
				k.source_memory_id AS source
			FROM memoria_kg k
			WHERE k.source_memory_id IS NOT NULL AND k.source_memory_id != ''
				AND trim(k.subject) != '' AND trim(k.predicate) != '' AND trim(k.object) != ''
				AND NOT EXISTS (
					SELECT 1 FROM consolidated_facts cf, json_each(cf.sources_json) s
					WHERE cf.subject = trim(k.subject) AND cf.predicate = trim(k.predicate)
						AND cf.object = trim(k.object) AND s.value = k.source_memory_id
				)
			GROUP BY 1, 2, 3, 4
			ORDER BY MIN(k.id)
		`)
		.all() as { subject: string; predicate: string; object: string; source: string }[];
	if (rows.length === 0) return 0;
	consolidator.serializedWrite(() => {
		for (const row of rows) {
			consolidator.consolidateFact(
				row.subject,
				row.predicate,
				row.object,
				sourceMemoryVeracity(beam, row.source),
				row.source,
			);
		}
	});
	return rows.length;
}

function insertPreference(
	beam: BeamMemoryState,
	messageIdx: number,
	preference: string,
	topic: string | null,
	sourceMemoryId: string | null,
): void {
	const evidence = evidenceSource(beam, sourceMemoryId);
	const same = beam.db
		.query(
			`SELECT id, preference, sources_json, superseded_by, source_memory_id
			 FROM memoria_preferences
			 WHERE preference = ? AND session_id = ?
			 ORDER BY CASE WHEN superseded_by IS NULL THEN 0 ELSE 1 END, id DESC
			 LIMIT 1`,
		)
		.get(preference, sourceSession(beam)) as ObservationPreferenceRow | null;
	let winnerId: string;
	if (same !== null) {
		if (evidence.fromSummary && same.superseded_by !== null) return;
		const merged = mergeEvidenceSources(seededSources(same.sources_json, same.source_memory_id), evidence.sourceId);
		const revive = same.superseded_by !== null && !evidence.fromSummary;
		if (!merged.added && !revive) return;
		beam.db.run(
			`UPDATE memoria_preferences
			 SET proof_count = ?, sources_json = ?, evolution = 'reinforced',
			     superseded_by = CASE WHEN ? = 1 THEN NULL ELSE superseded_by END
			 WHERE id = ?`,
			[merged.sources.length, JSON.stringify(merged.sources), revive ? 1 : 0, same.id],
		);
		if (!revive) return;
		winnerId = String(same.id);
	} else {
		const inserted = beam.db.run(
			`INSERT INTO memoria_preferences
			 (session_id, message_idx, preference, topic, evolution, context_snippet, source_memory_id, proof_count, sources_json)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?)`,
			[
				sourceSession(beam),
				messageIdx,
				preference,
				topic,
				preference,
				sourceMemoryId,
				JSON.stringify([evidence.sourceId]),
			],
		);
		winnerId = String(inserted.lastInsertRowid);
	}
	const active = beam.db
		.query(
			`SELECT id, preference, sources_json, superseded_by, source_memory_id
			 FROM memoria_preferences
			 WHERE superseded_by IS NULL AND id != ? AND session_id = ?
			 ORDER BY id DESC
			 LIMIT 40`,
		)
		.all(Number(winnerId), sourceSession(beam)) as ObservationPreferenceRow[];
	for (const row of active) {
		if (classifyObservation(preference, row.preference ?? "") !== "contradicts") continue;
		beam.db.run(
			"UPDATE memoria_preferences SET superseded_by = ?, evolution = 'superseded' WHERE id = ? AND superseded_by IS NULL",
			[winnerId, row.id],
		);
	}
}

function insertInstruction(
	beam: BeamMemoryState,
	messageIdx: number,
	instruction: string,
	context: string,
	sourceMemoryId: string | null,
): void {
	beam.db.run(
		`INSERT INTO memoria_instructions (session_id, message_idx, instruction, active, topic, context_snippet, source_memory_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[sourceSession(beam), messageIdx, instruction, 1, null, context, sourceMemoryId],
	);
}

function timelineDate(description: string): string | null {
	return /\b\d{4}-\d{2}-\d{2}\b/.exec(description)?.[0] ?? null;
}

/**
 * Populate the episodic graph (gists, facts, edges) for a freshly consolidated
 * memory. The graph backs Polyphonic Recall's `graph` voice, which relies on
 * `findGistsByParticipant`, `findFactsBySubject`, and `findRelatedMemories`.
 *
 * Best-effort: failures (closed DB, missing optional tables) MUST NOT roll back
 * the consolidation that already wrote the episodic row, so any throw here is
 * swallowed. Unlike the proactive-link path in `store.ts` this is unconditional
 * — consolidation is the explicit "settle and compress" step where the graph
 * is supposed to gain edges.
 */
function ingestIntoEpisodicGraph(beam: BeamMemoryState, memoryId: string, summary: string): void {
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(summary, memoryId, {
			sessionId: sourceSession(beam),
			linkExisting: true,
			extractEntities: true,
		});
	} catch {
		// Graph enrichment is best-effort and never blocks consolidation.
	}
}

export function consolidateToEpisodic(
	beam: BeamMemoryState,
	summary: string,
	sourceWmIds: readonly string[],
	source = "consolidation",
	importance = 0.6,
	options: ConsolidateOptions = {},
): string {
	const memoryId = generateId(summary);
	const timestamp = isoNow();
	const scope = options.scope ?? "session";
	const veracity = clampEpisodicVeracity(options.veracity ?? "unknown");
	const metadata = options.metadata ?? {};
	beam.db.run(
		`INSERT INTO episodic_memory
		 (id, content, source, timestamp, session_id, importance, metadata_json, summary_of,
		  valid_until, scope, author_id, author_type, channel_id, memory_type, veracity, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			memoryId,
			summary,
			source,
			timestamp,
			sourceSession(beam),
			importance,
			json(metadata),
			sourceWmIds.join(","),
			options.validUntil ?? null,
			scope,
			beam.authorId,
			beam.authorType,
			beam.channelId,
			"unknown",
			veracity,
			timestamp,
		],
	);
	extractAndStoreFacts(beam, summary, 0, memoryId);
	ingestIntoEpisodicGraph(beam, memoryId, summary);
	scheduleEmbedding(beam, [{ memoryId, content: summary }]);
	emitEvent(beam, "MEMORY_CONSOLIDATED", memoryId, summary, source, importance, {
		summary_of: [...sourceWmIds],
		...metadata,
	});
	return memoryId;
}
export function detectLanguage(_beam: BeamMemoryState, text: string): string {
	if (typeof text !== "string" || text.length === 0) return "en";
	const lower = text.toLowerCase();
	const russianChars = [...lower].filter(c => "абвгдеёжзийклмнопрстуфхцчшщъыьэюя".includes(c)).length;
	if (russianChars >= 5) return "ru";
	if (russianChars >= 2) {
		const markers = new Set(["я", "ты", "он", "она", "мы", "вы", "они", "не", "на", "что", "как", "это"]);
		let hits = 0;
		for (const word of lower.split(/\s+/)) if (markers.has(word)) hits++;
		if (hits >= 2) return "ru";
	}
	if (/[äöüß]/.test(lower)) return "de";
	const words = new Set(lower.match(/[\p{L}\p{N}_]+/gu) ?? []);
	let german = 0;
	for (const marker of [
		"ich",
		"du",
		"wir",
		"ist",
		"nicht",
		"für",
		"und",
		"der",
		"die",
		"das",
		"ein",
		"eine",
		"habe",
		"bin",
		"sind",
	]) {
		if (words.has(marker)) german++;
	}
	if (german >= 2) return "de";
	if (/[ñáéíóúü¿¡]/.test(lower)) return "es";
	let spanish = 0;
	for (const marker of [
		"y",
		"de",
		"por",
		"con",
		"para",
		"que",
		"qué",
		"como",
		"el",
		"la",
		"un",
		"una",
		"mi",
		"tu",
		"soy",
		"estoy",
	]) {
		if (words.has(marker)) spanish++;
	}
	return spanish >= 3 ? "es" : "en";
}
type StoreFactStringOptions = {
	routeHeuristicCategories?: boolean;
};

export function storeFactStrings(
	beam: BeamMemoryState,
	facts: readonly (string | ExtractedMemoryFact)[],
	messageIdx = 0,
	sourceMemoryId: string | null = null,
	importance = 0.7,
	options: StoreFactStringOptions = {},
): number {
	const routeHeuristicCategories = options.routeHeuristicCategories ?? true;
	let stored = 0;
	for (const item of facts) {
		const fact = typeof item === "string" ? item : item.text;
		if (!hasRetainableContent(fact)) continue;
		const memoryKind = typeof item === "string" ? "world" : item.kind;
		insertFactRows(beam, messageIdx, "entity", "fact", fact, fact, importance, sourceMemoryId, memoryKind);
		stored++;
		if (!routeHeuristicCategories || memoryKind === "experience") continue;
		const pref = /^The user (prefers|dislikes) (.+)$/i.exec(fact);
		if (pref?.[2]) {
			insertPreference(beam, messageIdx, fact, pref[2], sourceMemoryId);
		}
		const instruction = /^Instruction: (.+)$/i.exec(fact);
		if (instruction?.[1]) {
			insertInstruction(beam, messageIdx, instruction[1], fact, sourceMemoryId);
		}
	}
	return stored;
}

/** Store category-preserving LLM extraction output in MEMORIA and KG tables. */
export function storeExtractedFactCategories(
	beam: BeamMemoryState,
	extracted: ExtractedFactCategories,
	messageIdx = 0,
	sourceMemoryId: string | null = null,
	importance = 0.7,
): number {
	let stored = storeFactStrings(beam, extracted.facts, messageIdx, sourceMemoryId, importance);
	stored += storeFactStrings(beam, extracted.instructions, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	stored += storeFactStrings(beam, extracted.preferences, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	stored += storeFactStrings(beam, extracted.timelines, messageIdx, sourceMemoryId, importance, {
		routeHeuristicCategories: false,
	});
	for (const instruction of extracted.instructions) {
		insertInstruction(beam, messageIdx, instruction.text, instruction.text, sourceMemoryId);
	}
	for (const preference of extracted.preferences) {
		insertPreference(beam, messageIdx, preference.text, null, sourceMemoryId);
	}
	for (const timeline of extracted.timelines) {
		insertTimeline(beam, messageIdx, timelineDate(timeline.text), timeline.text, sourceMemoryId);
	}
	for (const triple of extracted.kg) {
		insertKg(beam, messageIdx, triple.subject, triple.predicate, triple.object, sourceMemoryId);
	}
	return stored;
}
export function extractAndStoreFacts(
	beam: BeamMemoryState,
	content: string,
	messageIdx = 0,
	sourceMemoryId: string | null = null,
): FactCounts {
	const counts: FactCounts = {
		metric: 0,
		date: 0,
		version: 0,
		entity: 0,
		sequence: 0,
		timeline: 0,
		negation: 0,
		decision: 0,
	};
	const text = String(content ?? "");
	if (text.length > PATTERN_FACT_EXTRACTION_MAX_INPUT_CHARS) return counts;
	for (const match of text.matchAll(
		/(\d+(?:[.,]\d+)?)\s*(ms|sec|seconds?|minutes?|hours?|days?|weeks?|months?|%|KB|MB|GB|TB|rows?|columns?|roles?|features?|bugs?|commits?|cards?|users?|items?|tests?|APIs?|endpoints?|sprints?|tickets?)\b/gi,
	)) {
		const rawUnit = match[2] ?? "";
		let unit = rawUnit.toLowerCase();
		if (unit.endsWith("s") && !unit.endsWith("ms")) unit = unit.slice(0, -1);
		// The naive fixed 50-char lookbehind can cross a markdown table cell, a code fence, or
		// a sentence boundary and glue unrelated words into one underscore-joined key (e.g.
		// "iam-role_smrx/sm-secrets_ssm-parameters_api" -> "2api" from a table row, or
		// "cadence_90/60/5_30-_second" from a run-on list). Clamping the window to start after
		// the nearest preceding structural boundary -- newline, table pipe, sentence-ending
		// punctuation, or a backtick -- keeps the phrase within one cell/sentence/line, matching
		// what a human would read as "the words right before this number" rather than 50 raw
		// characters regardless of what they cross.
		//
		// A bare `.` is NOT always a sentence boundary: "v1.2", "3.14", "18.0.8" all contain
		// dots that are part of a version/decimal number, not sentence punctuation. Only count
		// `.`/`!`/`?` as a boundary when followed by whitespace or the end of the window -- i.e.
		// it actually ends a sentence.
		const windowStart = Math.max(0, (match.index ?? 0) - 50);
		let window = text.slice(windowStart, match.index ?? 0);
		const boundaryMatch = /\n|\||`|[.!?](?=\s|$)|;/g;
		let lastBoundary = -1;
		for (let m = boundaryMatch.exec(window); m; m = boundaryMatch.exec(window)) lastBoundary = m.index;
		if (lastBoundary !== -1) window = window.slice(lastBoundary + 1);
		const prefixWords = window
			.replace(/`[^`]*`/g, " ")
			.split(/\s+/)
			.map(w => w.replace(/[.,:;!?()[\]"'`*_]/g, ""))
			.filter(w => w.length > 2 && !/^(the|and|for|was|of|to|an?|in|on|at|by|is|are|has|had|not|but|or)$/i.test(w))
			.slice(-3)
			.join("_")
			.toLowerCase();
		let key = prefixWords === "" ? unit : `${prefixWords}_${unit}`;
		if (unit === "%") key = prefixWords === "" ? "pct" : `${prefixWords}_pct`;
		insertFactRows(
			beam,
			messageIdx,
			"metric",
			key,
			`${match[1]}${rawUnit}`,
			contextSnippet(text, match.index ?? 0),
			0.65,
			sourceMemoryId,
		);
		counts.metric++;
		if (counts.metric >= 10) break;
	}

	for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
		const date = match[1] ?? "";
		const ctx = contextSnippet(text, match.index ?? 0, 100);
		insertFactRows(beam, messageIdx, "date", "iso_date", date, ctx, 0.5, sourceMemoryId);
		counts.date++;
		if (/\b(release|deadline|meeting|launch|ship|shipped|due|start|started|finish|finished)\b/i.test(ctx)) {
			insertTimeline(beam, messageIdx, date, ctx, sourceMemoryId);
			counts.timeline++;
		}
	}

	for (const match of text.matchAll(/\b(v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)\b/g)) {
		const value = match[1] ?? "";
		if (/^\d{4}-\d{2}$/.test(value)) continue;
		insertFactRows(
			beam,
			messageIdx,
			"version",
			"version",
			value,
			contextSnippet(text, match.index ?? 0),
			0.6,
			sourceMemoryId,
		);
		counts.version++;
	}

	counts.entity += storeFactStrings(beam, heuristicExtractFacts(text), messageIdx, sourceMemoryId);

	for (const match of text.matchAll(
		/\b([A-Z][A-Za-z0-9_-]{2,})\s+(?:is|uses|runs|owns|depends on)\s+([^.!?;]{2,80})/g,
	)) {
		insertKg(beam, messageIdx, match[1] ?? "", "related_to", compactWhitespace(match[2] ?? ""), sourceMemoryId);
	}
	if (/\b(no longer|not|never|don't|do not|isn't|wasn't)\b/i.test(text)) counts.negation++;
	if (/\b(decided|decision|choose|chose|approved|rejected)\b/i.test(text)) counts.decision++;
	return counts;
}
function classifyAbility(query: string): string {
	const q = query.toLowerCase();
	if (
		[
			"how many days",
			"how many weeks",
			"how many months",
			"how long",
			"what date",
			"what day",
			"when did",
			"when does",
			"deadline",
			"timeline",
			"how far apart",
		].some(w => q.includes(w))
	)
		return "TR";
	if (
		["list the order", "walk me through", "chronological", "in what order", "sequence of events"].some(w =>
			q.includes(w),
		)
	)
		return "EO";
	if (["have i", "did i", "am i", "has this", "contradict", "contradiction", "conflict"].some(w => q.includes(w)))
		return "CR";
	if (["across my", "across all", "in my project", "in my sessions", "across sessions"].some(w => q.includes(w)))
		return "MR";
	if (
		/^(what|when|where|which|who|how)\s/.test(q) ||
		["how many", "what is", "what was", "which version", "how much"].some(w => q.includes(w))
	)
		return "IE";
	return "";
}

function factRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push(
			"(lower(key) LIKE ? ESCAPE '\\' OR lower(value) LIKE ? ESCAPE '\\' OR lower(context_snippet) LIKE ? ESCAPE '\\')",
		);
		const like = `%${escapeLike(token)}%`;
		params.push(like, like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_facts WHERE session_id = ? AND (${where}) ORDER BY importance DESC, id DESC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "IE", query, results };
}

function timelineRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push("(lower(description) LIKE ? ESCAPE '\\' OR date LIKE ? ESCAPE '\\')");
		const like = `%${escapeLike(token)}%`;
		params.push(like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_timelines WHERE session_id = ? AND (${where}) ORDER BY date ASC, event_id ASC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "TR", query, results };
}

function kgRetrieve(beam: BeamMemoryState, query: string, topK: number): MemoriaRetrieveResult {
	const tokens = makeQuestionTokens(query);
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [sourceSession(beam)];
	for (const token of tokens) {
		clauses.push(
			"(lower(subject) LIKE ? ESCAPE '\\' OR lower(predicate) LIKE ? ESCAPE '\\' OR lower(object) LIKE ? ESCAPE '\\')",
		);
		const like = `%${escapeLike(token)}%`;
		params.push(like, like, like);
	}
	const where = clauses.length === 0 ? "1=1" : clauses.join(" OR ");
	params.push(topK);
	const results = asRows(
		beam.db
			.query(
				`SELECT * FROM memoria_kg WHERE session_id = ? AND (${where}) ORDER BY confidence DESC, id DESC LIMIT ?`,
			)
			.all(...params),
	);
	return { ability: "MR", query, results };
}

export function memoriaRetrieve(
	beam: BeamMemoryState,
	query: string,
	ability: string | null = null,
	topK = 10,
): MemoriaRetrieveResult {
	const selected = ability ?? classifyAbility(query);
	if (selected === "TR" || selected === "EO") return timelineRetrieve(beam, query, topK);
	if (selected === "MR") return kgRetrieve(beam, query, topK);
	if (selected === "IE" || selected === "KU" || selected === "PF" || selected === "IF" || selected === "CR")
		return factRetrieve(beam, query, topK);
	return { ability: selected, query, results: [] };
}
export function getEpisodicStats(
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
	const total = (
		beam.db.query(`SELECT COUNT(*) AS count FROM episodic_memory${where}`).get(...params) as {
			count: number;
		}
	).count;
	const last = beam.db
		.query(`SELECT timestamp FROM episodic_memory${where} ORDER BY timestamp DESC LIMIT 1`)
		.get(...params) as { timestamp: string | null } | null;
	return { count: total, total, last: last?.timestamp ?? null, vectors: 0, vec_type: "none" };
}
export function getMemoriaStats(beam: BeamMemoryState): BeamStats {
	const stats: Record<string, number> = Object.create(null);
	let total = 0;
	for (const table of [
		"memoria_facts",
		"memoria_timelines",
		"memoria_kg",
		"memoria_instructions",
		"memoria_preferences",
	] as const) {
		const count = (beam.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		stats[table] = count;
		total += count;
	}
	return { count: total, ...stats };
}
function extractKeySignal(content: string, maxChars: number): string {
	const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
	if (sentences.length === 0) return content.slice(0, maxChars);
	const scored = sentences.map((sentence, idx) => {
		const score =
			(sentence.match(/\b[A-Z][a-zA-Z0-9_-]+\b/g)?.length ?? 0) * 2 +
			(sentence.match(/\b(prefer|always|never|deadline|release|version|decided|important|must|should)\b/gi)
				?.length ?? 0);
		return { sentence, idx, score };
	});
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	const selected: typeof scored = [];
	let used = 0;
	for (const item of scored) {
		const next = item.sentence.trim();
		if (used + next.length + 1 > maxChars && selected.length > 0) continue;
		selected.push(item);
		used += next.length + 1;
		if (used >= maxChars) break;
	}
	selected.sort((a, b) => a.idx - b.idx);
	const text = selected.map(s => s.sentence.trim()).join(" ");
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 6)).trim()} [...]`;
}

function invalidateEpisodicVectors(beam: BeamMemoryState, memoryId: string): void {
	beam.db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [memoryId]);
	beam.db.run("UPDATE episodic_memory SET binary_vector = NULL WHERE id = ?", [memoryId]);
}

export function degradeEpisodic(beam: BeamMemoryState, dryRun = false): Record<string, JsonValue> {
	const now = isoNow();
	const tier2Cutoff = cutoffIso(TIER2_DAYS, 24 * 60 * 60 * 1000);
	const tier3Cutoff = cutoffIso(TIER3_DAYS, 24 * 60 * 60 * 1000);
	const tier1Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 1 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier2Cutoff, DEGRADE_BATCH_SIZE),
	);
	const tier2Rows = asRows(
		beam.db
			.query(
				`SELECT id, content FROM episodic_memory WHERE tier = 2 AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(tier3Cutoff, Math.max(1, Math.floor(DEGRADE_BATCH_SIZE / 2))),
	);
	const result = {
		status: dryRun ? "dry_run" : "degraded",
		tier1_to_tier2: tier1Rows.length,
		tier2_to_tier3: tier2Rows.length,
	};
	if (dryRun) return result;
	for (const row of tier1Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.slice(0, 800);
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 2, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier1_to_tier2--;
		}
	}
	for (const row of tier2Rows) {
		const id = rowValue(row, "id");
		const content = rowValue(row, "content") ?? "";
		if (!id) continue;
		const compressed = content.length > TIER3_MAX_CHARS ? extractKeySignal(content, TIER3_MAX_CHARS) : content;
		beam.db.run("SAVEPOINT degrade_episodic");
		try {
			beam.db.run("UPDATE episodic_memory SET content = ?, tier = 3, degraded_at = ? WHERE id = ?", [
				compressed,
				now,
				id,
			]);
			if (compressed !== content) invalidateEpisodicVectors(beam, id);
			beam.db.run("RELEASE degrade_episodic");
		} catch {
			beam.db.run("ROLLBACK TO degrade_episodic");
			beam.db.run("RELEASE degrade_episodic");
			result.tier2_to_tier3--;
		}
	}
	return result;
}
export function getContaminated(beam: BeamMemoryState, limit = 50, minImportance = 0.0): Row[] {
	const rows = asRows(
		beam.db
			.query(
				`SELECT id, content, source, veracity, tier, importance, created_at, degraded_at, session_id
		 FROM episodic_memory
		 WHERE veracity IN ('inferred', 'tool', 'imported', 'unknown', 'false') AND importance >= ?
		 ORDER BY importance DESC, created_at DESC LIMIT ?`,
			)
			.all(minImportance, limit),
	);
	return rows.filter(row => CONTAMINATED_VERACITY[rowValue(row, "veracity") ?? "unknown"] === true);
}
export function health(
	beam: BeamMemoryState,
	staleThresholdHours = 24.0,
): Record<string, JsonValue | Record<string, JsonValue>> {
	const last = beam.db
		.query(`SELECT max(created_at) AS last_consolidation FROM consolidation_log WHERE items_consolidated > 0`)
		.get() as { last_consolidation: string | null } | null;
	const errors = beam.db
		.query(
			`SELECT count(*) AS err_count FROM consolidation_log
		 WHERE created_at > datetime('now', '-7 days')
		 AND ((items_consolidated = 0 AND summary_preview LIKE '%error%') OR summary_preview LIKE '%fail%')`,
		)
		.get() as { err_count: number };
	const lastTs = last?.last_consolidation ?? null;
	if (lastTs === null) {
		return {
			status: "no_data",
			last_successful_consolidation: null,
			error_count: errors.err_count,
			stale_hours: null,
			stale_threshold_hours: staleThresholdHours,
			details: { stale: true, consolidation_log_entries_checked: "last 7 days" },
			recommendation:
				"No consolidation_log entries found with items_consolidated > 0. Run sleepAllSessions() or check logs.",
		};
	}
	const staleHours = Math.round(((Date.now() - Date.parse(lastTs)) / 3_600_000) * 100) / 100;
	const status = staleHours > staleThresholdHours ? "stale" : "healthy";
	return {
		status,
		last_successful_consolidation: lastTs,
		error_count: errors.err_count,
		stale_hours: staleHours,
		stale_threshold_hours: staleThresholdHours,
		details: { stale: status === "stale", consolidation_log_entries_checked: "last 7 days" },
		recommendation:
			status === "stale"
				? `Last successful consolidation was ${staleHours.toFixed(1)} hours ago (threshold: ${staleThresholdHours.toFixed(0)}h). Run sleepAllSessions().`
				: "Consolidation is within the healthy window.",
	};
}

function eligibleWorkingRows(beam: BeamMemoryState, sessionId: string): Row[] {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	return asRows(
		beam.db
			.query(
				`SELECT id, COALESCE(embed_text, content) AS content, source, timestamp, importance, metadata_json, scope, valid_until, veracity
		 FROM working_memory
		 WHERE COALESCE(session_id, 'default') = ? AND timestamp < ? AND consolidated_at IS NULL
		 ORDER BY timestamp ASC LIMIT ?`,
			)
			.all(sessionId, cutoff, SLEEP_BATCH_SIZE),
	);
}

export function sleep(beam: BeamMemoryState, dryRun = false): SleepResult {
	let rows = eligibleWorkingRows(beam, sourceSession(beam));
	if (rows.length === 0)
		return { dry_run: dryRun, status: "no_op", message: "No old working memories to consolidate" };
	if (!dryRun) {
		const claimTs = isoNow();
		const ids = rows.map(row => rowValue(row, "id")).filter((id): id is string => id !== null);
		const placeholders = ids.map(() => "?").join(",");
		beam.db.run(
			`UPDATE working_memory SET consolidated_at = ? WHERE id IN (${placeholders}) AND consolidated_at IS NULL`,
			[claimTs, ...ids],
		);
		const claimed = new Set(
			asRows(
				beam.db
					.query(`SELECT id FROM working_memory WHERE id IN (${placeholders}) AND consolidated_at = ?`)
					.all(...ids, claimTs),
			).map(row => rowValue(row, "id")),
		);
		if (claimed.size === 0)
			return {
				dry_run: false,
				status: "no_op",
				message: "All eligible rows claimed by concurrent sleep",
			};
		rows = rows.filter(row => claimed.has(rowValue(row, "id")));
	}

	const grouped = new Map<string, Row[]>();
	for (const row of rows) {
		const source = rowValue(row, "source") ?? "unknown";
		const group = grouped.get(source);
		if (group) group.push(row);
		else grouped.set(source, [row]);
	}

	const consolidatedIds: string[] = [];
	let summariesCreated = 0;
	for (const [source, items] of grouped) {
		for (const chunk of splitSleepItems(beam, source, items)) {
			const ids = chunk.items.map(item => rowValue(item, "id")).filter((id): id is string => id !== null);
			const scope = chunk.items.every(item => rowValue(item, "scope") === "global") ? "global" : "session";
			let validUntil: string | null = null;
			for (const item of chunk.items) {
				const itemValidUntil = rowValue(item, "valid_until");
				if (itemValidUntil && (validUntil === null || itemValidUntil < validUntil)) validUntil = itemValidUntil;
			}
			const sleepSummary = buildSleepSummary(beam, source, chunk);
			const metadata: Metadata = { original_count: chunk.items.length, source, llm_used: false };
			if (sleepSummary.truncated) {
				metadata.truncated = true;
				metadata.original_chars = sleepSummary.originalChars;
				metadata.max_chars = sleepSummary.maxChars;
			}
			const summary = sleepSummary.summary;
			if (!dryRun) {
				consolidateToEpisodic(beam, summary, ids, "sleep_consolidation", 0.6, {
					scope,
					validUntil,
					veracity: aggregateEpisodicVeracity(chunk.items.map(item => rowValue(item, "veracity") ?? "unknown")),
					metadata,
				});
			}
			consolidatedIds.push(...ids);
			summariesCreated++;
		}
	}
	if (!dryRun) {
		beam.db.run(
			`INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)`,
			[
				sourceSession(beam),
				consolidatedIds.length,
				`${summariesCreated} summaries (aaak) from ${consolidatedIds.length} items`,
				isoNow(),
			],
		);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : "consolidated",
		items_consolidated: consolidatedIds.length,
		summaries_created: summariesCreated,
		conflicts_resolved: 0,
		llm_used: 0,
		method: "aaak",
		consolidated_ids: consolidatedIds,
		degradation,
	};
}

export function sleepAllSessions(beam: BeamMemoryState, dryRun = false): SleepResult {
	const ttl = beam.config?.workingMemoryTtlHours ?? 24;
	const cutoff = cutoffIso(Math.floor(ttl / 2), 60 * 60 * 1000);
	const sessions = asRows(
		beam.db
			.query(
				`SELECT session_id, COUNT(*) AS eligible FROM working_memory
		 WHERE timestamp < ? AND consolidated_at IS NULL GROUP BY session_id ORDER BY MIN(timestamp) ASC`,
			)
			.all(cutoff),
	);
	if (sessions.length === 0) {
		return {
			dry_run: dryRun,
			status: "no_op",
			message: "No old working memories to consolidate",
			sessions_scanned: 0,
			sessions_consolidated: 0,
			items_consolidated: 0,
			summaries_created: 0,
			llm_used: 0,
			errors: 0,
			session_results: [],
		};
	}
	const originalSession = beam.sessionId;
	const results: Row[] = [];
	let items = 0;
	let summaries = 0;
	let consolidated = 0;
	for (const row of sessions) {
		const sessionId = rowValue(row, "session_id") ?? "default";
		const scoped = Object.create(Object.getPrototypeOf(beam)) as BeamMemoryState;
		Object.assign(scoped, beam, { sessionId, channelId: sessionId });
		const result = sleep(scoped, dryRun) as Row;
		result.session_id = sessionId;
		result.eligible = row.eligible;
		results.push(result);
		if (result.status === "consolidated" || result.status === "dry_run") consolidated++;
		items += Number(result.items_consolidated ?? 0);
		summaries += Number(result.summaries_created ?? 0);
	}
	const degradation = degradeEpisodic(beam, dryRun);
	return {
		dry_run: dryRun,
		status: dryRun ? "dry_run" : items > 0 ? "consolidated" : "no_op",
		sessions_scanned: sessions.length,
		sessions_consolidated: consolidated,
		items_consolidated: items,
		summaries_created: summaries,
		llm_used: 0,
		errors: 0,
		error_details: [],
		session_results: results,
		degradation,
		original_session: originalSession,
	};
}
export function getConsolidationLog(beam: BeamMemoryState, limit = 10): Row[] {
	return asRows(
		beam.db
			.query(
				`SELECT id, session_id, items_consolidated, summary_preview, created_at
		 FROM consolidation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(sourceSession(beam), limit),
	);
}
