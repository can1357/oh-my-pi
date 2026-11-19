export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type Metadata = Record<string, JsonValue>;
export type Veracity = "stated" | "inferred" | "tool" | "imported" | "unknown" | (string & {});
export type Vector = Float32Array | readonly number[];
export type VecType = "float32" | "int8" | "bit";

export interface MemoryRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	session_id: string;
	importance: number;
	metadata_json: string | null;
	veracity: Veracity;
	created_at: string;
	recall_count?: number | null;
	last_recalled?: string | null;
	valid_until?: string | null;
	superseded_by?: string | null;
	scope?: string | null;
	memory_type?: string | null;
	trust_tier?: string | null;
	author_id?: string | null;
	author_type?: string | null;
	channel_id?: string | null;
	topic?: string | null;
}

export type WorkingMemoryRow = MemoryRow;

export interface EpisodicMemoryRow extends MemoryRow {
	rowid: number;
	summary_of: string;
	tier?: number | null;
	degraded_at?: string | null;
	event_date?: string | null;
	episode_type?: string | null;
}

export interface MemoryInput {
	content: string;
	source?: string | null;
	timestamp?: string | Date | null;
	session_id?: string;
	importance?: number;
	metadata?: Metadata | null;
	veracity?: Veracity;
	scope?: string | null;
	valid_until?: string | Date | null;
}

export interface WorkingMemory {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	sessionId: string;
	importance: number;
	metadata: Metadata | null;
	veracity: Veracity;
	createdAt: string;
}

export interface EpisodicMemory extends WorkingMemory {
	rowid: number;
	summaryOf: string;
	tier: number;
	degradedAt: string | null;
}

export interface RecallResult {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	session_id?: string;
	importance?: number;
	metadata?: Metadata | null;
	metadata_json?: string | null;
	veracity?: Veracity;
	score: number;
	vec_score?: number;
	fts_score?: number;
	importance_score?: number;
	recency_score?: number;
	temporal_score?: number;
	rank?: number;
	distance?: number;
	memory_type?: string | null;
	trust_tier?: string | null;
}

export interface AnnotationRow {
	id: number;
	memory_id: string;
	kind: string;
	value: string;
	source: string | null;
	confidence: number;
	created_at: string;
}

export interface TripleRow {
	id: number;
	subject: string;
	predicate: string;
	object: string;
	valid_from: string;
	valid_until: string | null;
	source: string | null;
	confidence: number;
	created_at: string;
}

export interface FactRow {
	fact_id: string;
	session_id: string;
	subject: string;
	predicate: string;
	object: string;
	timestamp: string | null;
	source_msg_id: string | null;
	confidence: number;
	created_at: string;
}

export interface EmbeddingRow {
	memory_id: string;
	embedding_json: string;
	model: string | null;
	created_at: string;
}

export interface EmbeddingResult {
	memory_id: string;
	embedding: Vector;
	model: string | null;
	dim: number;
}

export interface VectorSearchResult {
	rowid?: number;
	id?: string;
	memory_id?: string;
	distance: number;
	score?: number;
}

export interface MemoryStats {
	working_count: number;
	episodic_count: number;
	embedding_count?: number;
	annotation_count?: number;
	triple_count?: number;
}
