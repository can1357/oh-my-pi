import type { Database } from "bun:sqlite";

import { embeddingDim, type VecType } from "../config";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";

export { cosineSimilarity } from "./vector-math";

export const BITS_PER_BYTE = 8;
export const EMBEDDING_DIM = embeddingDim();
export const BYTES_PER_VECTOR = Math.ceil(EMBEDDING_DIM / BITS_PER_BYTE);

const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < POPCOUNT_TABLE.length; i += 1) {
	let value = i;
	let count = 0;
	while (value !== 0) {
		value &= value - 1;
		count += 1;
	}
	POPCOUNT_TABLE[i] = count;
}

export interface BinaryVectorSearchResult {
	memory_id: string;
	distance: number;
	score: number;
}

export interface BinaryVectorStats {
	total_vectors: number;
	avg_bytes_per_vector: number;
	max_bytes: number;
	min_bytes: number;
	compression_ratio: number;
	theoretical_size_mb: number;
}

export interface BinaryVectorStoreOptions {
	dbPath?: DatabasePath;
	tableName?: string;
	conn?: Database;
}

interface VectorRow {
	memory_id: string;
	binary_vector: Uint8Array | ArrayBuffer | Buffer;
	original_dim: number | null;
	magnitude: number | null;
}

interface StatsRow {
	count: number;
	avg_bytes: number | null;
	max_bytes: number | null;
	min_bytes: number | null;
}

function assertSqlIdentifier(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`Invalid SQL identifier: ${name}`);
	}
	return name;
}

function toFiniteNumber(value: number | string | boolean | null | undefined): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function magnitude(embedding: readonly number[]): number {
	let sum = 0;
	for (let i = 0; i < embedding.length; i += 1) {
		const value = toFiniteNumber(embedding[i]);
		sum += value * value;
	}
	return Math.sqrt(sum);
}

function bytesFromBlob(blob: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
	if (blob instanceof Uint8Array) {
		return blob;
	}
	return new Uint8Array(blob);
}

function isReadonlyMap(
	value: ReadonlyMap<string, Uint8Array | ArrayBuffer> | Record<string, Uint8Array | ArrayBuffer>,
): value is ReadonlyMap<string, Uint8Array | ArrayBuffer> {
	const candidate = value as Partial<ReadonlyMap<string, Uint8Array | ArrayBuffer>> & {
		[Symbol.iterator]?: unknown;
	};
	return (
		typeof candidate.get === "function" &&
		typeof candidate.has === "function" &&
		typeof candidate.forEach === "function" &&
		typeof candidate.size === "number" &&
		typeof candidate[Symbol.iterator] === "function"
	);
}

export function getVecType(env: NodeJS.ProcessEnv = process.env): VecType {
	const value = (env.MNEMOPI_VEC_TYPE ?? "int8").trim().toLowerCase();
	if (value === "float32" || value === "int8" || value === "bit") {
		return value;
	}
	return "float32";
}

export const VEC_TYPE: VecType = getVecType();

export function quantizeInt8(embedding: readonly number[]): Int8Array {
	const out = new Int8Array(embedding.length);
	for (let i = 0; i < embedding.length; i += 1) {
		const value = Math.max(-1, Math.min(1, toFiniteNumber(embedding[i])));
		out[i] = value >= 0 ? Math.round(value * 127) : -Math.round(-value * 127);
	}
	return out;
}

export function maximallyInformativeBinarization(embedding: readonly number[]): Uint8Array {
	const dim = Math.min(embedding.length, EMBEDDING_DIM);
	const nBytes = Math.ceil(dim / BITS_PER_BYTE);
	const out = new Uint8Array(nBytes);
	for (let i = 0; i < dim; i += 1) {
		if (toFiniteNumber(embedding[i]) > 0) {
			const byteIndex = i >> 3;
			out[byteIndex] = (out[byteIndex] ?? 0) | (1 << (7 - (i & 7)));
		}
	}
	return out;
}

export function hammingDistance(binaryA: Uint8Array | ArrayBuffer, binaryB: Uint8Array | ArrayBuffer): number {
	const a = binaryA instanceof Uint8Array ? binaryA : new Uint8Array(binaryA);
	const b = binaryB instanceof Uint8Array ? binaryB : new Uint8Array(binaryB);
	const shared = Math.min(a.length, b.length);
	let distance = 0;
	for (let i = 0; i < shared; i += 1) {
		distance += POPCOUNT_TABLE[(a[i] ?? 0) ^ (b[i] ?? 0)] ?? 0;
	}
	for (let i = shared; i < a.length; i += 1) {
		distance += POPCOUNT_TABLE[a[i] ?? 0] ?? 0;
	}
	for (let i = shared; i < b.length; i += 1) {
		distance += POPCOUNT_TABLE[b[i] ?? 0] ?? 0;
	}
	return distance;
}

function hammingDistanceForDimension(
	binaryA: Uint8Array | ArrayBuffer,
	binaryB: Uint8Array | ArrayBuffer,
	dim: number,
): number {
	const a = binaryA instanceof Uint8Array ? binaryA : new Uint8Array(binaryA);
	const b = binaryB instanceof Uint8Array ? binaryB : new Uint8Array(binaryB);
	const effectiveDim = Math.max(0, Math.trunc(dim));
	const wholeBytes = effectiveDim >> 3;
	let distance = 0;
	for (let i = 0; i < wholeBytes; i += 1) {
		distance += POPCOUNT_TABLE[(a[i] ?? 0) ^ (b[i] ?? 0)] ?? 0;
	}
	const remainingBits = effectiveDim & 7;
	if (remainingBits > 0) {
		const mask = (0xff << (BITS_PER_BYTE - remainingBits)) & 0xff;
		distance += POPCOUNT_TABLE[((a[wholeBytes] ?? 0) ^ (b[wholeBytes] ?? 0)) & mask] ?? 0;
	}
	return distance;
}

export function informationTheoreticScore(distance: number, dim: number = EMBEDDING_DIM): number {
	if (dim <= 0) {
		return 0;
	}
	return 1.0 - distance / dim;
}

export class BinaryVectorStore {
	readonly conn: Database;
	readonly dbPath: DatabasePath;
	readonly tableName: string;
	private readonly ownsConnection: boolean;

	constructor(options: BinaryVectorStoreOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.tableName = assertSqlIdentifier(options.tableName ?? "binary_vectors");
		this.conn = options.conn ?? openDatabase(this.dbPath, { create: true, readwrite: true });
		this.ownsConnection = options.conn === undefined;
		this.initTable();
	}

	private initTable(): void {
		this.conn.exec(`
			CREATE TABLE IF NOT EXISTS ${this.tableName} (
				memory_id TEXT PRIMARY KEY,
				binary_vector BLOB NOT NULL,
				original_dim INTEGER DEFAULT ${EMBEDDING_DIM},
				magnitude REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
	}

	static maximallyInformativeBinarization(embedding: readonly number[]): Uint8Array {
		return maximallyInformativeBinarization(embedding);
	}
	static hammingDistance(binaryA: Uint8Array | ArrayBuffer, binaryB: Uint8Array | ArrayBuffer): number {
		return hammingDistance(binaryA, binaryB);
	}
	static informationTheoreticScore(distance: number, dim: number = EMBEDDING_DIM): number {
		return informationTheoreticScore(distance, dim);
	}
	storeVector(memoryId: string, embedding: readonly number[]): void {
		const binary = maximallyInformativeBinarization(embedding);
		this.conn
			.query(
				`INSERT OR REPLACE INTO ${this.tableName}
				 (memory_id, binary_vector, original_dim, magnitude)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(memoryId, binary, Math.min(embedding.length, EMBEDDING_DIM), magnitude(embedding));
	}
	search(queryEmbedding: readonly number[], topK = 10): BinaryVectorSearchResult[] {
		const queryDim = Math.min(queryEmbedding.length, EMBEDDING_DIM);
		const queryBinary = maximallyInformativeBinarization(queryEmbedding);
		const rows = this.conn
			.query(`SELECT memory_id, binary_vector, original_dim, magnitude FROM ${this.tableName}`)
			.all() as VectorRow[];
		const results: BinaryVectorSearchResult[] = [];
		for (const row of rows) {
			const storedDim = Math.max(0, Math.min(EMBEDDING_DIM, Math.trunc(toFiniteNumber(row.original_dim))));
			const comparedDim = Math.min(queryDim, storedDim);
			const distance = hammingDistanceForDimension(queryBinary, bytesFromBlob(row.binary_vector), comparedDim);
			results.push({
				memory_id: row.memory_id,
				distance,
				score: informationTheoreticScore(distance, comparedDim),
			});
		}
		results.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
		return results.slice(0, Math.max(0, Math.trunc(topK)));
	}

	searchBatch(queryEmbeddings: readonly (readonly number[])[], topK = 10): BinaryVectorSearchResult[][] {
		return queryEmbeddings.map(embedding => this.search(embedding, topK));
	}
	deleteVector(memoryId: string): void {
		this.conn.query(`DELETE FROM ${this.tableName} WHERE memory_id = ?`).run(memoryId);
	}
	getStats(): BinaryVectorStats {
		const row = this.conn
			.query(
				`SELECT COUNT(*) AS count,
					AVG(LENGTH(binary_vector)) AS avg_bytes,
					MAX(LENGTH(binary_vector)) AS max_bytes,
					MIN(LENGTH(binary_vector)) AS min_bytes
				 FROM ${this.tableName}`,
			)
			.get() as StatsRow;
		const count = row.count;
		const bytesPerVector = row.avg_bytes ?? 0;
		return {
			total_vectors: count,
			avg_bytes_per_vector: bytesPerVector,
			max_bytes: row.max_bytes ?? 0,
			min_bytes: row.min_bytes ?? 0,
			compression_ratio: BYTES_PER_VECTOR / (EMBEDDING_DIM * 4),
			theoretical_size_mb: (count * BYTES_PER_VECTOR) / (1024 * 1024),
		};
	}
	close(): void {
		if (this.ownsConnection) {
			closeQuietly(this.conn);
		}
	}
}

export class FastBinarySearch {
	private readonly memoryIds: string[];
	private readonly vectors: Uint8Array[];

	constructor(
		binaryVectors: ReadonlyMap<string, Uint8Array | ArrayBuffer> | Record<string, Uint8Array | ArrayBuffer>,
	) {
		this.memoryIds = [];
		this.vectors = [];
		if (isReadonlyMap(binaryVectors)) {
			for (const [memoryId, vector] of binaryVectors) {
				this.memoryIds.push(memoryId);
				this.vectors.push(vector instanceof Uint8Array ? vector : new Uint8Array(vector));
			}
		} else {
			for (const memoryId in binaryVectors) {
				const vector = binaryVectors[memoryId];
				if (vector !== undefined) {
					this.memoryIds.push(memoryId);
					this.vectors.push(vector instanceof Uint8Array ? vector : new Uint8Array(vector));
				}
			}
		}
	}

	search(queryBinary: Uint8Array | ArrayBuffer, topK = 10): BinaryVectorSearchResult[] {
		const query = queryBinary instanceof Uint8Array ? queryBinary : new Uint8Array(queryBinary);
		const results: BinaryVectorSearchResult[] = [];
		for (let i = 0; i < this.vectors.length; i += 1) {
			const distance = hammingDistance(query, this.vectors[i] ?? new Uint8Array());
			results.push({
				memory_id: this.memoryIds[i] ?? "",
				distance,
				score: informationTheoreticScore(distance),
			});
		}
		results.sort((a, b) => a.distance - b.distance || a.memory_id.localeCompare(b.memory_id));
		return results.slice(0, Math.max(0, Math.trunc(topK)));
	}
}
