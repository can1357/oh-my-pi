import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cosineSimilarityPairs } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import * as embeddings from "./embeddings";
import { cosineSimilarity } from "./vector-math";

export { cosineSimilarity };

export const SHMR_BATCH_SIZE = Number.parseInt(process.env.MNEMOPI_SHMR_BATCH_SIZE ?? "50", 10);
export const SHMR_MAX_ITERATIONS = Number.parseInt(process.env.MNEMOPI_SHMR_MAX_ITERATIONS ?? "3", 10);
export const SHMR_SIMILARITY_THRESHOLD = Number.parseFloat(process.env.MNEMOPI_SHMR_SIMILARITY_THRESHOLD ?? "0.70");
export const SHMR_HARMONY_THRESHOLD = Number.parseFloat(process.env.MNEMOPI_SHMR_HARMONY_THRESHOLD ?? "0.60");
export const SHMR_MIN_CLUSTER_SIZE = Number.parseInt(process.env.MNEMOPI_SHMR_MIN_CLUSTER_SIZE ?? "2", 10);
export const EMBEDDING_DIM = 384;

export type Vector = Float32Array;
export interface ShmrItem {
	readonly fact_id?: string;
	readonly subject?: string;
	readonly predicate?: string;
	readonly object?: string;
	readonly content?: string;
	readonly confidence?: number;
	readonly timestamp?: string;
	readonly source?: string;
	readonly embedding?: Vector;
}
export interface Belief {
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly action?: "create" | "update" | "dampen";
	readonly target_fact_id?: string | null;
	readonly rationale?: string;
}
export interface HarmonizeStats {
	readonly clusters_found: number;
	readonly beliefs_generated: number;
	readonly contradictions_resolved: number;
	readonly harmony_score_avg: number;
	readonly duration_ms: number;
	readonly status: "insufficient_candidates" | "harmonized" | "no_convergence";
}

type BeamLike = {
	readonly conn?: Database;
	readonly db?: Database;
	readonly session_id?: string;
	readonly sessionId?: string;
};

type FactRow = {
	fact_id: string;
	subject: string;
	predicate: string;
	object: string;
	confidence: number | null;
	timestamp: string | null;
};
type EpisodeRow = {
	id: string;
	content: string;
	importance: number | null;
	created_at: string | null;
};
type BeliefRow = {
	belief_id: string;
	subject: string | null;
	predicate: string | null;
	object: string;
	confidence: number | null;
	provenance: string | null;
	created_at: string | null;
};

export const FACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS harmonic_beliefs (
	belief_id TEXT PRIMARY KEY,
	subject TEXT,
	predicate TEXT,
	object TEXT NOT NULL,
	confidence REAL DEFAULT 0.5,
	provenance TEXT,
	cluster_id TEXT,
	iteration INTEGER DEFAULT 0,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memory_resonance_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT,
	cluster_count INTEGER,
	beliefs_generated INTEGER,
	contradictions_resolved INTEGER,
	harmony_score_avg REAL,
	duration_ms INTEGER,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_beliefs_subject ON harmonic_beliefs(subject);
CREATE INDEX IF NOT EXISTS idx_beliefs_predicate ON harmonic_beliefs(predicate);
CREATE INDEX IF NOT EXISTS idx_beliefs_confidence ON harmonic_beliefs(confidence);
`;

export function initSchema(db: Database): void {
	db.exec(FACTS_SCHEMA_SQL);
}
function hashEmbedding(text: string): Vector {
	const out = new Float32Array(EMBEDDING_DIM);
	const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const word of words) {
		const digest = createHash("sha1").update(word).digest();
		const slot = digest.readUInt16BE(0) % EMBEDDING_DIM;
		out[slot] = (out[slot] ?? 0) + 1;
	}
	return out;
}

/**
 * Embed a batch of texts with the configured embedding provider. Falls back to the
 * deterministic SHA1 bag-of-words hash for the entire batch when no provider is
 * available or the provider fails, so every returned vector shares one space.
 */
export async function embedBatch(texts: readonly string[]): Promise<Vector[]> {
	if (texts.length === 0) return [];
	let matrix: embeddings.EmbeddingMatrix | null = null;
	try {
		matrix = await embeddings.embed(texts);
	} catch (error) {
		logger.debug("mnemopi shmr embedding failed; using hash fallback", { error: String(error) });
	}
	if (matrix !== null && matrix.length === texts.length) return matrix;
	return texts.map(hashEmbedding);
}

export async function embed(text: string): Promise<Vector> {
	const [vector] = await embedBatch([text]);
	return vector ?? hashEmbedding(text);
}

/**
 * Resolve one vector per item: caller-provided embeddings are kept, the rest are
 * batch-embedded in a single provider call (hash fallback when unavailable).
 */
async function resolveItemVectors(items: readonly ShmrItem[]): Promise<Vector[]> {
	const vectors: (Vector | undefined)[] = items.map(item => item.embedding);
	const missingIndices: number[] = [];
	const missingTexts: string[] = [];
	for (let i = 0; i < items.length; i++) {
		if (vectors[i] !== undefined) continue;
		missingIndices.push(i);
		missingTexts.push(items[i]?.object ?? items[i]?.content ?? "");
	}
	if (missingIndices.length > 0) {
		const fresh = await embedBatch(missingTexts);
		for (let k = 0; k < missingIndices.length; k++) {
			const index = missingIndices[k];
			const vector = fresh[k];
			if (index !== undefined && vector !== undefined) vectors[index] = vector;
		}
	}
	return vectors.map((vector, i) => vector ?? hashEmbedding(items[i]?.object ?? items[i]?.content ?? ""));
}

export async function clusterBySimilarity(items: readonly ShmrItem[], threshold: number): Promise<ShmrItem[][]> {
	if (items.length === 0) return [];
	const vectors = await resolveItemVectors(items);
	const adjacency: number[][] = Array.from({ length: items.length }, () => []);
	// Native batch kernel: one N-API crossing evaluates all O(n^2) pairs.
	// Vectors are zero-padded to a shared dim, matching the TS `?? 0`
	// missing-element semantics of cosineSimilarity.
	let dim = 0;
	for (const vector of vectors) if (vector.length > dim) dim = vector.length;
	const flat = new Float64Array(vectors.length * dim);
	for (let i = 0; i < vectors.length; i++) {
		const vector = vectors[i];
		if (vector === undefined) continue;
		for (let col = 0; col < vector.length; col++) flat[i * dim + col] = vector[col] ?? 0;
	}
	const pairs = cosineSimilarityPairs(flat, vectors.length, dim, threshold);
	for (let p = 0; p < pairs.length; p += 2) {
		const i = pairs[p] ?? 0;
		const j = pairs[p + 1] ?? 0;
		adjacency[i]?.push(j);
		adjacency[j]?.push(i);
	}
	const visited = new Set<number>();
	const clusters: ShmrItem[][] = [];
	for (let i = 0; i < items.length; i++) {
		if (visited.has(i)) continue;
		const cluster: ShmrItem[] = [];
		const stack = [i];
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined || visited.has(node)) continue;
			visited.add(node);
			const item = items[node];
			if (item !== undefined) cluster.push(item);
			for (const next of adjacency[node] ?? []) if (!visited.has(next)) stack.push(next);
		}
		clusters.push(cluster);
	}
	return clusters;
}

export function formatClusterForLlm(cluster: readonly ShmrItem[]): string {
	const lines = ["=== MEMORY CLUSTER ==="];
	for (let i = 0; i < cluster.length; i++) {
		const item = cluster[i];
		if (item === undefined) continue;
		lines.push(
			`[${i}] (${item.source ?? "fact"}, conf=${(item.confidence ?? 0.5).toFixed(2)}) ${item.subject ?? "unknown"} | ${item.predicate ?? "stated"} | ${item.object ?? item.content ?? ""}`,
		);
	}
	return lines.join("\n");
}

export function extractJsonFromLlmOutput(text: string): Belief[] {
	const candidates = [text];
	const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
	if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
	const bare = /\[\s*\{[\s\S]*?\}\s*\]/.exec(text);
	if (bare?.[0] !== undefined) candidates.push(bare[0]);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (Array.isArray(parsed)) return parsed.filter(isBeliefLike).map(normalizeBelief);
			if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { beliefs?: unknown }).beliefs))
				return (parsed as { beliefs: unknown[] }).beliefs.filter(isBeliefLike).map(normalizeBelief);
		} catch {}
	}
	return [];
}

function isBeliefLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && typeof (value as { object?: unknown }).object === "string";
}

function normalizeBelief(value: Record<string, unknown>): Belief {
	const confidence =
		typeof value.confidence === "number" && Number.isFinite(value.confidence)
			? Math.max(0.1, Math.min(1, value.confidence))
			: 0.5;
	const action = value.action === "update" || value.action === "dampen" ? value.action : "create";
	return {
		subject: typeof value.subject === "string" ? value.subject : "entity",
		predicate: typeof value.predicate === "string" ? value.predicate : "related_to",
		object: value.object as string,
		confidence,
		action,
		target_fact_id: typeof value.target_fact_id === "string" ? value.target_fact_id : null,
		rationale: typeof value.rationale === "string" ? value.rationale : undefined,
	};
}

function deterministicBeliefs(cluster: readonly ShmrItem[]): Belief[] {
	const byTriple = new Map<string, { count: number; confidence: number; item: ShmrItem }>();
	for (const item of cluster) {
		const subject = item.subject ?? "memory";
		const predicate = item.predicate ?? "contains";
		const object = item.object ?? item.content ?? "";
		const key = `${subject}\u0000${predicate}\u0000${object.toLowerCase()}`;
		const existing = byTriple.get(key);
		if (existing === undefined) byTriple.set(key, { count: 1, confidence: item.confidence ?? 0.5, item });
		else {
			existing.count++;
			existing.confidence += item.confidence ?? 0.5;
		}
	}
	const beliefs: Belief[] = [];
	for (const value of byTriple.values()) {
		if (value.count < 2 && cluster.length > 1) continue;
		beliefs.push({
			subject: value.item.subject ?? "memory",
			predicate: value.item.predicate ?? "contains",
			object: value.item.object ?? value.item.content ?? "",
			confidence: Math.min(
				0.95,
				Math.max(0.5, value.confidence / value.count + Math.min(0.2, (value.count - 1) * 0.1)),
			),
			action: "create",
			rationale: "Deterministic corroboration within semantic cluster",
		});
	}
	if (beliefs.length > 0) return beliefs.slice(0, 5);
	const first = cluster[0];
	if (first === undefined) return [];
	return [
		{
			subject: first.subject ?? "memory",
			predicate: first.predicate ?? "contains",
			object: first.object ?? first.content ?? "",
			confidence: Math.max(0.5, first.confidence ?? 0.5),
			action: "create",
			rationale: "Deterministic representative belief",
		},
	];
}

export async function computeHarmonyScore(beliefs: readonly Belief[], cluster: readonly ShmrItem[]): Promise<number> {
	if (beliefs.length === 0 || cluster.length === 0) return 0;
	const itemVectors = await resolveItemVectors(cluster);
	const beliefVectors = await embedBatch(beliefs.map(belief => `${belief.predicate} ${belief.object}`));
	let dim = 0;
	for (const vector of itemVectors) if (vector.length > dim) dim = vector.length;
	const centroid = new Float32Array(dim);
	for (const vector of itemVectors)
		for (let i = 0; i < vector.length; i++) centroid[i] = (centroid[i] ?? 0) + (vector[i] ?? 0) / cluster.length;
	let total = 0;
	for (let k = 0; k < beliefs.length; k++) {
		const belief = beliefs[k];
		const vector = beliefVectors[k];
		if (belief === undefined || vector === undefined) continue;
		total += cosineSimilarity(vector, centroid) * belief.confidence;
	}
	return total / beliefs.length;
}

export function applyBeliefs(
	db: Database,
	beliefs: readonly Belief[],
	cluster: readonly ShmrItem[],
	clusterId: string,
): void {
	initSchema(db);
	const now = new Date().toISOString();
	for (const belief of beliefs) {
		const confidence = Math.max(0.1, Math.min(1, belief.confidence));
		if (belief.action === "dampen" && belief.target_fact_id)
			db.run("UPDATE facts SET confidence = MAX(0.1, confidence - 0.15) WHERE fact_id = ?", [belief.target_fact_id]);
		if (belief.action === "update" && belief.target_fact_id)
			db.run("UPDATE facts SET object = ?, confidence = ? WHERE fact_id = ?", [
				belief.object,
				confidence,
				belief.target_fact_id,
			]);
		const beliefId = createHash("sha256")
			.update(`${clusterId}:${belief.subject}:${belief.predicate}:${belief.object.slice(0, 50)}`)
			.digest("hex")
			.slice(0, 24);
		const provenance = JSON.stringify(
			cluster.map(item => item.fact_id).filter((id): id is string => typeof id === "string"),
		);
		db.run(
			`INSERT OR REPLACE INTO harmonic_beliefs (belief_id, subject, predicate, object, confidence, provenance, cluster_id, iteration, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[beliefId, belief.subject, belief.predicate, belief.object, confidence, provenance, clusterId, 0, now],
		);
	}
}

function dbOf(beam: BeamLike): Database {
	const db = beam.conn ?? beam.db;
	if (db === undefined) throw new TypeError("SHMR requires a beam with conn or db");
	return db;
}

function tableExists(db: Database, table: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
}

function parseEmbeddingJson(raw: unknown): Vector | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const out = new Float32Array(parsed.length);
		for (let i = 0; i < parsed.length; i++) {
			const value = Number(parsed[i]);
			if (!Number.isFinite(value)) return null;
			out[i] = value;
		}
		return out;
	} catch {
		return null;
	}
}

/** Precomputed vectors from `memory_embeddings` (written by `scheduleEmbedding()`). */
function precomputedVectors(db: Database, memoryIds: readonly (string | undefined)[]): Map<string, Vector> {
	const out = new Map<string, Vector>();
	const ids = memoryIds.filter((id): id is string => id !== undefined);
	if (ids.length === 0 || !tableExists(db, "memory_embeddings")) return out;
	for (let offset = 0; offset < ids.length; offset += 500) {
		const chunk = ids.slice(offset, offset + 500);
		const rows = db
			.query(
				`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.all(...chunk) as Array<{ memory_id: string; embedding_json: string | null }>;
		for (const row of rows) {
			const vector = parseEmbeddingJson(row.embedding_json);
			if (vector !== null) out.set(row.memory_id, vector);
		}
	}
	return out;
}

export async function harmonize(
	beam: BeamLike,
	batchSize = SHMR_BATCH_SIZE,
	maxIterations = SHMR_MAX_ITERATIONS,
	similarityThreshold = SHMR_SIMILARITY_THRESHOLD,
): Promise<HarmonizeStats> {
	const started = performance.now();
	const db = dbOf(beam);
	initSchema(db);
	const bare: ShmrItem[] = [];
	const memoryIds: (string | undefined)[] = [];
	if (tableExists(db, "facts")) {
		const rows = db
			.query(
				"SELECT fact_id, subject, predicate, object, confidence, timestamp FROM facts ORDER BY created_at DESC LIMIT ?",
			)
			.all(batchSize) as FactRow[];
		for (const row of rows) {
			bare.push({
				fact_id: row.fact_id,
				subject: row.subject,
				predicate: row.predicate,
				object: row.object,
				confidence: row.confidence ?? 0.5,
				timestamp: row.timestamp ?? undefined,
				source: "fact",
			});
			memoryIds.push(undefined);
		}
	}
	if (tableExists(db, "episodic_memory")) {
		const rows = db
			.query("SELECT id, content, importance, created_at FROM episodic_memory ORDER BY created_at DESC LIMIT ?")
			.all(Math.max(1, Math.floor(batchSize / 2))) as EpisodeRow[];
		for (const row of rows)
			if (row.content.length > 10) {
				bare.push({
					fact_id: `ep_${row.id}`,
					subject: "memory",
					predicate: "contains",
					object: row.content.slice(0, 300),
					confidence: row.importance ?? 0.5,
					timestamp: row.created_at ?? undefined,
					source: "episodic",
				});
				memoryIds.push(row.id);
			}
	}
	if (bare.length < SHMR_MIN_CLUSTER_SIZE)
		return {
			clusters_found: 0,
			beliefs_generated: 0,
			contradictions_resolved: 0,
			harmony_score_avg: 0,
			duration_ms: Math.floor(performance.now() - started),
			status: "insufficient_candidates",
		};
	const precomputed = precomputedVectors(db, memoryIds);
	const seeded: ShmrItem[] = bare.map((item, i) => {
		const memoryId = memoryIds[i];
		const vector = memoryId !== undefined ? precomputed.get(memoryId) : undefined;
		return vector === undefined ? item : { ...item, embedding: vector };
	});
	const itemVectors = await resolveItemVectors(seeded);
	const candidates: ShmrItem[] = seeded.map((item, i) => ({ ...item, embedding: itemVectors[i] }));
	const clusters = (await clusterBySimilarity(candidates, similarityThreshold)).filter(
		cluster => cluster.length >= SHMR_MIN_CLUSTER_SIZE,
	);
	let totalBeliefs = 0;
	let totalContradictions = 0;
	const scores: number[] = [];
	for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
		const cluster = clusters[clusterIndex];
		if (cluster === undefined) continue;
		const clusterId = `shmr_${Date.now()}_${clusterIndex}`;
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const beliefs = deterministicBeliefs(cluster);
			const score = Math.max(
				await computeHarmonyScore(beliefs, cluster),
				beliefs.length > 0 ? SHMR_HARMONY_THRESHOLD : 0,
			);
			scores.push(score);
			if (score >= SHMR_HARMONY_THRESHOLD) {
				applyBeliefs(db, beliefs, cluster, clusterId);
				totalBeliefs += beliefs.filter(belief => belief.action !== "dampen").length;
				totalContradictions += beliefs.filter(belief => belief.action === "dampen").length;
				break;
			}
		}
	}
	let avg = 0;
	for (const score of scores) avg += score;
	avg = scores.length === 0 ? 0 : avg / scores.length;
	const duration = Math.floor(performance.now() - started);
	db.run(
		"INSERT INTO memory_resonance_log (session_id, cluster_count, beliefs_generated, contradictions_resolved, harmony_score_avg, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
		[
			beam.session_id ?? beam.sessionId ?? "default",
			clusters.length,
			totalBeliefs,
			totalContradictions,
			Number(avg.toFixed(4)),
			duration,
		],
	);
	return {
		clusters_found: clusters.length,
		beliefs_generated: totalBeliefs,
		contradictions_resolved: totalContradictions,
		harmony_score_avg: Number(avg.toFixed(4)),
		duration_ms: duration,
		status: totalBeliefs > 0 ? "harmonized" : "no_convergence",
	};
}

export async function recallBeliefs(beam: BeamLike, query: string, topK = 10): Promise<Array<Record<string, unknown>>> {
	const db = dbOf(beam);
	initSchema(db);
	const rows = db
		.query(
			"SELECT belief_id, subject, predicate, object, confidence, provenance, created_at FROM harmonic_beliefs ORDER BY confidence DESC LIMIT ?",
		)
		.all(topK * 2) as BeliefRow[];
	const vectors = await embedBatch([query, ...rows.map(row => row.object)]);
	const queryEmbedding = vectors[0] ?? hashEmbedding(query);
	return rows
		.map((row, index) => ({
			row,
			score:
				cosineSimilarity(queryEmbedding, vectors[index + 1] ?? hashEmbedding(row.object)) * (row.confidence ?? 0.5),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, topK)
		.map(({ row, score }) => ({
			content: row.object,
			score: Number(score.toFixed(4)),
			belief_id: row.belief_id,
			subject: row.subject,
			predicate: row.predicate,
			provenance: row.provenance,
			source: "harmonic_belief",
		}));
}
export function reflect(
	_beam: BeamLike | null,
	_question: string,
	facts: Array<Record<string, unknown>> | null = null,
	topK = 10,
): string | null {
	if (facts === null || facts.length === 0) return null;
	const sorted = facts
		.slice()
		.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
		.slice(0, topK);
	return (
		sorted
			.map(fact => String(fact.content ?? fact.object ?? ""))
			.filter(text => text.length > 0)
			.join(" ") || null
	);
}

export function getResonanceLog(beam: BeamLike, limit = 10): Array<Record<string, unknown>> {
	const db = dbOf(beam);
	initSchema(db);
	return db.query("SELECT * FROM memory_resonance_log ORDER BY created_at DESC LIMIT ?").all(limit) as Array<
		Record<string, unknown>
	>;
}
