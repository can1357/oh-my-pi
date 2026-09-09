import type { Database } from "bun:sqlite";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Metadata = Record<string, JsonValue>;

export type MemoryScope = "global" | "session" | "channel" | string;
export type TrustTier = "STATED" | "OBSERVED" | "INFERRED" | "SYSTEM" | string;
export type Veracity =
	| "unknown"
	| "likely_true"
	| "true"
	| "false"
	| "stated"
	| "inferred"
	| "tool"
	| "imported"
	| "contested"
	| string;

export interface BeamPluginManager {
	emit?(event: BeamEvent): void | Promise<void>;
	close?(): void | Promise<void>;
}

export interface AnnotationStoreLike {
	add?(memoryId: string, kind: string, value: string, options?: AnnotationWriteOptions): unknown;
	addMany?(memoryId: string, kind: string, values: readonly string[], options?: AnnotationWriteOptions): unknown;
	queryByMemory?(memoryId: string, kind?: string): unknown;
	queryByKind?(kind: string, value?: string): unknown;
	getDistinctValues?(kind: string): string[];
}

export interface TripleStoreLike {
	add?(subject: string, predicate: string, object: string, options?: TripleWriteOptions): unknown;
	query?(subject?: string, predicate?: string, asOf?: string): unknown;
}

export interface BeamCaches {
	timestampParse: Map<string, Date>;
	polyphonicEngine?: unknown;
	extractionClient?: unknown;
	extractionBuffer: unknown[];
	[key: string]: unknown;
}

export interface BeamConfig {
	workingMemoryLimit: number;
	workingMemoryTtlHours: number;
	recencyHalflifeHours: number;
	vecWeight: number;
	ftsWeight: number;
	importanceWeight: number;
	useCloud: boolean;
	localLlmEnabled: boolean;
	maxEpisodeChars: number;
	proactiveLinking?: boolean;
}

export interface BeamMemoryOptions {
	sessionId?: string;
	dbPath?: string;
	authorId?: string | null;
	authorType?: string | null;
	channelId?: string | null;
	useCloud?: boolean;
	proactiveLinking?: boolean;
	eventEmitter?: (event: BeamEvent) => void;
	pluginManager?: BeamPluginManager | null;
	annotations?: AnnotationStoreLike | null;
	triples?: TripleStoreLike | null;
	config?: Partial<BeamConfig>;
}

export interface BeamMemoryState {
	db: Database;
	dbPath?: string;
	sessionId: string;
	authorId: string | null;
	authorType: string | null;
	channelId: string;
	useCloud: boolean;
	eventEmitter?: (event: BeamEvent) => void;
	pluginManager: BeamPluginManager | null;
	annotations: AnnotationStoreLike | null;
	triples: TripleStoreLike | null;
	episodicGraph: unknown | null;
	veracityConsolidator: unknown | null;
	caches: BeamCaches;
	config: BeamConfig;
	/** Tracks in-flight background fact-extraction tasks scheduled by `remember(..., { extract: true })`. */
	pendingExtractions?: Set<Promise<void>>;
}

export interface AnnotationWriteOptions {
	source?: string;
	confidence?: number;
}

export interface TripleWriteOptions {
	validFrom?: string;
	source?: string;
	confidence?: number;
}

export interface BeamEvent {
	type: string;
	memoryId?: string;
	content?: string;
	source?: string;
	importance?: number;
	sessionId: string;
	timestamp: string;
	metadata?: Metadata;
}

export interface RememberOptions {
	source?: string;
	importance?: number;
	metadata?: Metadata | null;
	extract?: boolean;
	extractEntities?: boolean;
	/**
	 * Override the text passed to fact and graph extraction. When unset
	 * (default) extraction runs over the stored `content`. Use this when the
	 * stored memory is a multi-author transcript but only a subset (e.g. the
	 * user-authored turns) should drive deterministic fact extraction — see
	 * coding-agent issue #3372 where assistant prose was being mis-attributed
	 * as user `Instruction:` memories.
	 */
	extractText?: string;
	/**
	 * Override the text passed to embeddings and FTS indexing. Stored `content`
	 * remains unchanged; when unset, embeddings and FTS use `content`.
	 */
	embedText?: string;
	veracity?: Veracity;
	memoryType?: string;
	scope?: MemoryScope;
	trustTier?: TrustTier;
	timestamp?: string;
}

export interface RememberBatchOptions {
	extract?: boolean;
	extractEntities?: boolean;
	veracity?: Veracity;
	memoryType?: string;
	scope?: MemoryScope;
	trustTier?: TrustTier;
}

export interface RememberBatchItem extends RememberOptions {
	content: string;
}

export interface RecallOptions {
	fromDate?: string | null;
	toDate?: string | null;
	authorId?: string | null;
	authorType?: string | null;
	channelId?: string | null;
	includeWorking?: boolean;
	queryTime?: string | Date | null;
	temporalWeight?: number;
	temporalHalflife?: number;
	vecWeight?: number;
	ftsWeight?: number;
	importanceWeight?: number;
	queryEmbedding?: readonly number[] | null;
	useSynonyms?: boolean;
	useIntent?: boolean;
	useMmr?: boolean;
	mmrLambda?: number;
	/**
	 * Maximum characters of `content` returned per {@link RecallResult}. When the
	 * stored content exceeds this, the preview is clipped and the trailing
	 * character is replaced with `…` so callers can see it was truncated. The
	 * full row is always reachable via {@link BeamMemoryState.get}. `0` or a
	 * negative value disables clipping. Defaults to
	 * {@link RECALL_CONTENT_PREVIEW_CHARS} (500).
	 */
	contentPreviewChars?: number;
}

export interface RecallEnhancedOptions extends RecallOptions {
	useCache?: boolean;
	includeFacts?: boolean;
}

export interface MemoryRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	session_id: string;
	importance: number;
	metadata_json: string | null;
	veracity: Veracity;
	memory_type?: string | null;
	recall_count?: number;
	last_recalled?: string | null;
	valid_until?: string | null;
	superseded_by?: string | null;
	scope?: MemoryScope;
	author_id?: string | null;
	author_type?: string | null;
	channel_id?: string | null;
	trust_tier?: TrustTier;
	validator?: string | null;
	validated_at?: string | null;
	validation_count?: number;
	event_date?: string | null;
	event_date_precision?: string | null;
	temporal_tags?: string | null;
	corrected_by?: number | null;
	created_at: string;
}

export interface WorkingMemoryRow extends MemoryRow {
	consolidated_at?: string | null;
}

export interface EpisodicMemoryRow extends MemoryRow {
	rowid: number;
	summary_of: string;
	tier: number;
	degraded_at?: string | null;
	binary_vector?: Uint8Array | null;
}

export type RecallTierLabel = "working" | "episodic" | "fact" | string;

export interface RecallVoiceScores {
	vec?: number;
	fts?: number;
	keyword?: number;
	importance?: number;
	recency_decay?: number;
	temporal?: number;
	[key: string]: number | undefined;
}

type RecallRowFields = Omit<Partial<EpisodicMemoryRow>, "tier"> & Partial<WorkingMemoryRow>;

export type RecallResult = RecallRowFields & {
	[key: string]: unknown;
	id: string;
	content: string;
	/**
	 * True when {@link content} is a clipped preview of the stored row. The
	 * clip is capped at {@link RecallOptions.contentPreviewChars} (default 500)
	 * and the last character is replaced with `…`. Fetch the full row via
	 * `memory://<id>` (mnemopi backend) or the `Mnemopi.get(id)` API.
	 */
	truncated?: boolean;
	/** Original character count of `content` before {@link truncated} clipping. */
	full_length?: number;
	score?: number;
	distance?: number;
	rank?: number;
	tier?: RecallTierLabel;
	tier_label?: RecallTierLabel;
	degradation_tier?: number;
	keyword_score?: number;
	dense_score?: number;
	fts_score?: number;
	importance_score?: number;
	recency_score?: number;
	temporal_score?: number;
	explanation?: string;
	voice_scores?: RecallVoiceScores;
	metadata?: Metadata;
};

export interface BeamStats {
	count: number;
	by_source?: Record<string, number>;
	by_session?: Record<string, number>;
	oldest?: string | null;
	newest?: string | null;
	[key: string]: JsonValue | Record<string, number> | undefined;
}

export interface MemoriaRetrieveResult {
	ability: string;
	query: string;
	results: unknown[];
}

export interface SleepResult {
	dry_run: boolean;
	sessions?: Record<string, unknown>;
	items_consolidated?: number;
	[key: string]: unknown;
}

export interface ImportStats {
	working_memory: Record<string, number>;
	episodic_memory: Record<string, number>;
	scratchpad: Record<string, number>;
	consolidation_log: Record<string, number>;
}
