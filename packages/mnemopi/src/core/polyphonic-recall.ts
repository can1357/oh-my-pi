import type { Database } from "bun:sqlite";
import { type Env, polyphonicRecallEnabled } from "../config";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import type { BeamMemoryState, JsonValue, Metadata, RecallResult } from "./beam/types";
import { EpisodicGraph } from "./episodic-graph";
import { VeracityConsolidator } from "./veracity-consolidation";

export type PolyphonicVoice = "vector" | "graph" | "fact" | "temporal";

export interface VoiceRecallResult {
	readonly memoryId: string;
	readonly score: number;
	readonly voice: PolyphonicVoice;
	readonly metadata: Metadata;
}

export interface PolyphonicResult {
	readonly memoryId: string;
	combinedScore: number;
	readonly voiceScores: Partial<Record<PolyphonicVoice, number>>;
	readonly metadata: Metadata;
}

export interface PolyphonicMemoryResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	score: number;
	combined_score: number;
	voice_scores: Partial<Record<PolyphonicVoice, number>>;
	metadata: Metadata;
	tier: "working" | "episodic";
}

export interface PolyphonicRecallOptions {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly contextBudget?: number;
}

interface PolyphonicEngineOptions {
	readonly dbPath?: DatabasePath;
	readonly db?: Database;
	readonly graph?: EpisodicGraph;
	readonly consolidator?: VeracityConsolidator;
	readonly sessionId?: string | null;
	readonly channelId?: string | null;
}

interface MemoryHydrationRow {
	readonly id: string;
	readonly content: string;
	readonly source: string | null;
	readonly timestamp: string | null;
	readonly session_id: string;
	readonly importance: number;
	readonly metadata_json: string | null;
	readonly veracity: string;
	readonly memory_type: string | null;
	readonly recall_count: number | null;
	readonly last_recalled: string | null;
	readonly valid_until: string | null;
	readonly superseded_by: string | null;
	readonly scope: string | null;
	readonly author_id: string | null;
	readonly author_type: string | null;
	readonly channel_id: string | null;
	readonly trust_tier: string | null;
	readonly created_at: string;
	readonly rowid?: number;
	readonly summary_of?: string;
	readonly tier?: number;
	readonly tier_name: "working" | "episodic";
}

interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly embedding_tier: "working" | "episodic";
}

interface TemporalRow {
	readonly id: string;
	readonly timestamp: string | null;
	readonly importance: number;
}

const RRF_K = 60;
const POLYPHONIC_VOICES: readonly PolyphonicVoice[] = ["vector", "graph", "fact", "temporal"];

export function polyphonicRecallIsEnabled(env: Env = process.env): boolean {
	return polyphonicRecallEnabled(env);
}
function envDisabled(name: string, env: Env = process.env): boolean {
	const value = env[name];
	if (value === undefined) return false;
	return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function metadataValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(metadataValue);
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		const record = value as Record<string, unknown>;
		for (const key in record) {
			out[key] = metadataValue(record[key]);
		}
		return out;
	}
	return String(value);
}

function parseMetadata(raw: string | null): Metadata {
	if (raw === null || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return metadataValue(parsed) as Metadata;
		}
	} catch {
		// Malformed metadata must not make recall fail.
	}
	return {};
}

function normalizeVector(vector: readonly number[] | Float32Array): Float32Array | null {
	if (vector.length === 0) return null;
	let normSq = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i];
		if (value === undefined || !Number.isFinite(value)) return null;
		normSq += value * value;
	}
	if (normSq === 0) return null;
	const norm = Math.sqrt(normSq);
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
	return out;
}

function cosineAgainstUnit(unit: Float32Array, raw: unknown): number | null {
	if (!Array.isArray(raw) || raw.length !== unit.length) return null;
	let normSq = 0;
	let dot = 0;
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		normSq += value * value;
		const unitValue = unit[i];
		if (unitValue === undefined) return null;
		dot += unitValue * value;
	}
	if (normSq === 0) return null;
	return dot / Math.sqrt(normSq);
}

function extractEntities(text: string): string[] {
	const seen = new Set<string>();
	const matches = text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
	for (const match of matches) {
		const entity = match[0];
		if (entity.length > 0) seen.add(entity);
	}
	return [...seen];
}

function queryWords(query: string): string[] {
	const seen = new Set<string>();
	for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)) {
		const word = match[0];
		if (word.length >= 3) seen.add(word);
	}
	return [...seen];
}

function looksTemporal(query: string): boolean {
	const lower = query.toLowerCase();
	return ["yesterday", "today", "recent", "last", "latest", "this week", "this month", "ago", "before"].some(keyword =>
		lower.includes(keyword),
	);
}

export class PolyphonicRecallEngine {
	readonly dbPath: DatabasePath;
	readonly db: Database;
	readonly ownsConnection: boolean;
	readonly graph: EpisodicGraph;
	readonly consolidator: VeracityConsolidator;
	readonly sessionId: string;
	readonly channelId: string | null;
	readonly voiceWeights: Readonly<Record<PolyphonicVoice, number>> = Object.freeze({
		vector: 0.35,
		graph: 0.25,
		fact: 0.25,
		temporal: 0.15,
	});

	constructor(options: PolyphonicEngineOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.db = options.db ?? openDatabase(this.dbPath);
		this.ownsConnection = options.db === undefined;
		this.graph = options.graph ?? new EpisodicGraph({ db: this.db, dbPath: this.dbPath });
		this.consolidator = options.consolidator ?? new VeracityConsolidator(this.dbPath, this.db);
		this.sessionId = options.sessionId ?? "default";
		this.channelId = options.channelId ?? null;
	}

	recall(
		query: string,
		queryEmbedding: readonly number[] | Float32Array | null = null,
		topK = 10,
		contextBudget = 4000,
	): PolyphonicMemoryResult[] {
		const vectorResults = this.vectorVoice(queryEmbedding);
		const graphResults = this.graphVoice(query);
		const factResults = this.factVoice(query);
		const temporalResults = this.temporalVoice(query);
		const combined = this.combineVoices(vectorResults, graphResults, factResults, temporalResults);
		const reranked = this.diversityRerank(combined, topK);
		return this.hydrateResults(this.assembleContext(reranked, contextBudget));
	}

	vectorVoice(queryEmbedding: readonly number[] | Float32Array | null): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_VECTOR") || queryEmbedding === null) return [];
		const queryUnit = normalizeVector(queryEmbedding);
		if (queryUnit === null) return [];
		const now = new Date().toISOString();
		let rows: EmbeddingRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT me.memory_id, me.embedding_json, 'working' AS embedding_tier
					FROM memory_embeddings me
					JOIN working_memory wm ON wm.id = me.memory_id
					WHERE wm.superseded_by IS NULL
						AND (wm.valid_until IS NULL OR wm.valid_until > ?)
						AND (wm.session_id = ? OR wm.scope = 'global')
					UNION ALL
					SELECT me.memory_id, me.embedding_json, 'episodic' AS embedding_tier
					FROM memory_embeddings me
					JOIN episodic_memory em ON em.id = me.memory_id
					WHERE em.superseded_by IS NULL
						AND (em.valid_until IS NULL OR em.valid_until > ?)
						AND (em.session_id = ? OR em.scope = 'global')
					LIMIT 50000
				`)
				.all(now, this.sessionId, now, this.sessionId) as EmbeddingRow[];
		} catch {
			return [];
		}

		const byId = new Map<string, VoiceRecallResult>();
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.embedding_json) as unknown;
			} catch {
				continue;
			}
			const cosine = cosineAgainstUnit(queryUnit, parsed);
			if (cosine === null) continue;
			const similarity = (cosine + 1) / 2;
			const existing = byId.get(row.memory_id);
			if (existing === undefined || similarity > existing.score) {
				byId.set(row.memory_id, {
					memoryId: row.memory_id,
					score: similarity,
					voice: "vector",
					metadata: {
						similarity,
						cosine_similarity: cosine,
						embedding_tier: row.embedding_tier,
						backend: "memory_embeddings",
					},
				});
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId)).slice(0, 20);
	}
	graphVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_GRAPH")) return [];
		const results: VoiceRecallResult[] = [];
		const seedIds = new Set<string>();
		for (const entity of extractEntities(query)) {
			for (const gist of this.graph.findGistsByParticipant(entity)) {
				const memoryId = gist.id.startsWith("gist_") ? gist.id.slice(5) : gist.id;
				seedIds.add(memoryId);
				results.push({
					memoryId,
					score: 0.6,
					voice: "graph",
					metadata: { entity, gist: gist.text },
				});
			}
			for (const fact of this.graph.findFactsBySubject(entity)) {
				const memoryId = fact.id.includes("_") ? (fact.id.split("_").at(-1) ?? fact.id) : fact.id;
				seedIds.add(memoryId);
				results.push({
					memoryId,
					score: fact.confidence * 0.5,
					voice: "graph",
					metadata: { entity, fact: `${fact.subject} ${fact.predicate} ${fact.object}` },
				});
			}
		}
		const traversed = new Set<string>();
		for (const seedId of seedIds) {
			for (const related of this.graph.findRelatedMemories(seedId, 2, "ctx", 0.3)) {
				if (seedIds.has(related.memoryId) || traversed.has(related.memoryId)) continue;
				traversed.add(related.memoryId);
				results.push({
					memoryId: related.memoryId,
					score: 0.4 / Math.max(1, related.depth),
					voice: "graph",
					metadata: {
						seed: seedId,
						edge_type: related.edgeType,
						depth: related.depth,
						weight: related.weight,
					},
				});
			}
		}
		return results;
	}
	factVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_FACT")) return [];
		const byId = new Map<string, VoiceRecallResult>();
		for (const word of queryWords(query)) {
			const subject = word[0] === undefined ? word : word[0].toUpperCase() + word.slice(1);
			for (const fact of this.consolidator.getConsolidatedFacts(subject, 0.5)) {
				for (const source of fact.sources) {
					const memoryId = source.trim();
					if (memoryId.length === 0) continue;
					const existing = byId.get(memoryId);
					if (existing !== undefined && existing.score >= fact.confidence) continue;
					byId.set(memoryId, {
						memoryId,
						score: fact.confidence,
						voice: "fact",
						metadata: {
							fact_id: fact.id ?? "",
							subject: fact.subject,
							predicate: fact.predicate,
							object: fact.object,
							mentions: fact.mention_count,
						},
					});
				}
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
	}
	temporalVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_TEMPORAL") || !looksTemporal(query)) return [];
		const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		let rows: TemporalRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT id, timestamp, importance
					FROM working_memory
					WHERE timestamp > ?
						AND superseded_by IS NULL
						AND (valid_until IS NULL OR valid_until > ?)
						AND (session_id = ? OR scope = 'global')
					ORDER BY timestamp DESC
					LIMIT 20
				`)
				.all(weekAgo, new Date().toISOString(), this.sessionId) as TemporalRow[];
		} catch {
			return [];
		}
		const now = Date.now();
		const results: VoiceRecallResult[] = [];
		for (const row of rows) {
			if (row.timestamp === null) continue;
			const then = Date.parse(row.timestamp);
			if (!Number.isFinite(then)) continue;
			const ageDays = Math.max(0, (now - then) / 86_400_000);
			const temporalScore = Math.exp(-ageDays / 7) * row.importance;
			results.push({
				memoryId: row.id,
				score: temporalScore,
				voice: "temporal",
				metadata: { age_days: ageDays, importance: row.importance },
			});
		}
		return results;
	}
	combineVoices(...voiceResults: readonly VoiceRecallResult[][]): Map<string, PolyphonicResult> {
		const combined = new Map<string, PolyphonicResult>();
		for (const results of voiceResults) {
			if (results.length === 0) continue;
			const sorted = [...results].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
			for (let i = 0; i < sorted.length; i++) {
				const result = sorted[i];
				if (result === undefined) continue;
				const rank = i + 1;
				let existing = combined.get(result.memoryId);
				if (existing === undefined) {
					existing = { memoryId: result.memoryId, combinedScore: 0, voiceScores: {}, metadata: {} };
					combined.set(result.memoryId, existing);
				}
				const contribution = 1 / (RRF_K + rank);
				existing.voiceScores[result.voice] = (existing.voiceScores[result.voice] ?? 0) + contribution;
				existing.combinedScore += contribution;
				Object.assign(existing.metadata, result.metadata);
			}
		}
		return combined;
	}
	diversityRerank(results: ReadonlyMap<string, PolyphonicResult>, topK: number): PolyphonicResult[] {
		const sorted = [...results.values()].sort(
			(a, b) => b.combinedScore - a.combinedScore || a.memoryId.localeCompare(b.memoryId),
		);
		const selected: PolyphonicResult[] = [];
		const limit = Math.max(0, Math.trunc(topK));
		for (const result of sorted) {
			if (selected.length >= limit) break;
			let diverse = true;
			for (const prior of selected) {
				if (this.estimateSimilarity(result, prior) > 0.8) {
					diverse = false;
					break;
				}
			}
			if (diverse) selected.push(result);
		}
		return selected;
	}
	estimateSimilarity(a: PolyphonicResult, b: PolyphonicResult): number {
		let aCount = 0;
		let bCount = 0;
		let intersection = 0;
		for (const voice of POLYPHONIC_VOICES) {
			const inA = a.voiceScores[voice] !== undefined;
			const inB = b.voiceScores[voice] !== undefined;
			if (inA) aCount++;
			if (inB) bCount++;
			if (inA && inB) intersection++;
		}
		if (aCount === 0 || bCount === 0) return 0;
		return intersection / (aCount + bCount - intersection);
	}
	assembleContext(results: readonly PolyphonicResult[], budget: number): PolyphonicResult[] {
		const maxChars = Math.max(0, Math.trunc(budget)) * 4;
		let chars = 0;
		const selected: PolyphonicResult[] = [];
		for (const result of results) {
			const size = JSON.stringify(result.metadata).length + 100;
			if (chars + size > maxChars) break;
			selected.push(result);
			chars += size;
		}
		return selected;
	}
	getStats(): Record<string, JsonValue> {
		let embeddedRows = 0;
		try {
			const row = this.db.query("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			embeddedRows = row.count;
		} catch {
			embeddedRows = 0;
		}
		return {
			voice_weights: {
				vector: this.voiceWeights.vector,
				graph: this.voiceWeights.graph,
				fact: this.voiceWeights.fact,
				temporal: this.voiceWeights.temporal,
			},
			vector_stats: { embedded_rows: embeddedRows },
			graph_stats: this.graph.getStats() as unknown as Record<string, JsonValue>,
			consolidation_stats: this.consolidator.getStats() as unknown as Record<string, JsonValue>,
		};
	}
	close(): void {
		if (this.ownsConnection) closeQuietly(this.db);
	}

	private hydrateResults(results: readonly PolyphonicResult[]): PolyphonicMemoryResult[] {
		const hydrated: PolyphonicMemoryResult[] = [];
		for (const result of results) {
			const row = this.lookupMemory(result.memoryId);
			if (row === null) continue;
			const rowMetadata = parseMetadata(row.metadata_json);
			const voiceScores = sortedVoiceScores(result.voiceScores);
			hydrated.push({
				...row,
				metadata: { ...rowMetadata, polyphonic: result.metadata },
				recall_count: row.recall_count ?? undefined,
				score: result.combinedScore,
				combined_score: result.combinedScore,
				voice_scores: voiceScores,
				tier: row.tier_name,
				tier_label: row.tier_name,
			});
		}
		return hydrated;
	}

	private lookupMemory(memoryId: string): MemoryHydrationRow | null {
		const now = new Date().toISOString();
		const working = this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, 'working' AS tier_name
				FROM working_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
			`)
			.get(memoryId, now, this.sessionId) as MemoryHydrationRow | null;
		if (working !== null) return working;
		return this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, rowid, summary_of,
					tier, 'episodic' AS tier_name
				FROM episodic_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
			`)
			.get(memoryId, now, this.sessionId) as MemoryHydrationRow | null;
	}
}

function sortedVoiceScores(scores: Partial<Record<PolyphonicVoice, number>>): Partial<Record<PolyphonicVoice, number>> {
	const out: Partial<Record<PolyphonicVoice, number>> = {};
	for (const voice of POLYPHONIC_VOICES) {
		const score = scores[voice];
		if (score !== undefined && Number.isFinite(score)) out[voice] = score;
	}
	return out;
}

export function getPolyphonicEngine(beam: BeamMemoryState): PolyphonicRecallEngine {
	const cached = beam.caches.polyphonicEngine;
	if (cached instanceof PolyphonicRecallEngine) return cached;
	const engine = new PolyphonicRecallEngine({
		db: beam.db,
		dbPath: beam.dbPath,
		sessionId: beam.sessionId,
		channelId: beam.channelId,
	});
	beam.caches.polyphonicEngine = engine;
	return engine;
}
export function polyphonicRecall(
	beam: BeamMemoryState,
	query: string,
	topK = 10,
	options: PolyphonicRecallOptions = {},
): PolyphonicMemoryResult[] {
	return getPolyphonicEngine(beam).recall(query, options.queryEmbedding ?? null, topK, options.contextBudget ?? 4000);
}
