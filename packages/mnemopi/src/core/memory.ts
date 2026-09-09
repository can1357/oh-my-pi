import type { Database } from "bun:sqlite";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";

import { dbPath as configuredDbPath } from "../config";
import { closeQuietly } from "../db";
import type { MemoryInput, Metadata } from "../types";
import { AnnotationStore } from "./annotations";
import { BankManager } from "./banks";
import { BeamMemory, initBeam } from "./beam/index";
import { reconcileEmbeddingModel } from "./beam/store";
import type { RecallEnhancedOptions, RecallOptions, RecallResult, SleepResult } from "./beam/types";
import { EpisodicGraph } from "./episodic-graph";
import {
	isPiAiModel,
	type MnemopiEmbeddingRuntimeOptions,
	type MnemopiLlmCompletion,
	type MnemopiLlmRuntimeOptions,
	type ResolvedMnemopiRuntimeOptions,
	resolveEmbeddingProvider,
	withMnemopiRuntimeOptions,
} from "./runtime-options";

export interface MnemopiOptions {
	readonly db?: Database;
	readonly dbPath?: string;
	readonly db_path?: string;
	readonly sessionId?: string;
	readonly session_id?: string;
	readonly bank?: string | null;
	readonly authorId?: string | null;
	readonly author_id?: string | null;
	readonly authorType?: string | null;
	readonly author_type?: string | null;
	readonly channelId?: string | null;
	readonly channel_id?: string | null;
	readonly noEmbeddings?: boolean;
	readonly embeddingModel?: string;
	readonly embeddingApiUrl?: string;
	readonly embeddingApiKey?: ApiKey;
	readonly embeddings?: false | MnemopiEmbeddingRuntimeOptions;
	readonly llmEnabled?: boolean;
	readonly llmBaseUrl?: string;
	readonly llmApiKey?: ApiKey;
	readonly llmModel?: string | Model<Api>;
	readonly llm?: false | MnemopiLlmRuntimeOptions | Model<Api> | MnemopiLlmCompletion;
	readonly proactiveLinking?: boolean;
	/** Escalate best-effort failure logs (embedding pipeline) from debug to warn. */
	readonly debug?: boolean;
	/**
	 * When `false`, skip the embedding-model reconcile (wipe-and-rebuild) on open.
	 * Read-only / ephemeral consumers (e.g. a stats snapshot) set this so an open
	 * never triggers a destructive migration whose background rebuild the process
	 * would exit before completing. Defaults to `true`.
	 */
	readonly reconcile?: boolean;
}

export interface RememberInput extends MemoryInput {
	readonly extract?: boolean;
	readonly extractEntities?: boolean;
	readonly extract_entities?: boolean;
	readonly extractText?: string | null;
	readonly extract_text?: string | null;
	readonly embedText?: string | null;
	readonly embed_text?: string | null;
	readonly trustTier?: string | null;
	readonly trust_tier?: string | null;
	readonly memoryType?: string | null;
	readonly memory_type?: string | null;
}

export interface RememberFacadeOptions {
	readonly source?: string | null;
	readonly importance?: number;
	readonly metadata?: Metadata | null;
	readonly validUntil?: string | Date | null;
	readonly valid_until?: string | Date | null;
	readonly scope?: string | null;
	readonly extractEntities?: boolean;
	readonly extract_entities?: boolean;
	readonly extract?: boolean;
	/**
	 * Override the text passed to fact/entity extraction. When unset, the
	 * stored content is used. See {@link RememberOptions.extractText}.
	 */
	readonly extractText?: string | null;
	readonly extract_text?: string | null;
	/**
	 * Override the text passed to embeddings and FTS indexing. Stored content
	 * remains unchanged; when unset, embeddings and FTS use stored content.
	 */
	readonly embedText?: string | null;
	readonly embed_text?: string | null;
	readonly trustTier?: string | null;
	readonly trust_tier?: string | null;
	readonly timestamp?: string | Date | null;
	readonly veracity?: string | null;
	readonly memoryType?: string | null;
	readonly memory_type?: string | null;
}

export interface RecallFacadeOptions extends Omit<
	RecallOptions,
	"temporalHalflife" | "vecWeight" | "ftsWeight" | "importanceWeight"
> {
	readonly from_date?: string | null;
	readonly to_date?: string | null;
	readonly source?: string | null;
	readonly topic?: string | null;
	readonly temporalWeight?: number;
	readonly temporal_weight?: number;
	readonly query_time?: string | Date | null;
	readonly temporalHalflife?: number | null;
	readonly temporal_halflife?: number | null;
	readonly vecWeight?: number | null;
	readonly vec_weight?: number | null;
	readonly ftsWeight?: number | null;
	readonly fts_weight?: number | null;
	readonly importanceWeight?: number | null;
	readonly importance_weight?: number | null;
}

export interface MemoryFacadeStats {
	total_memories: number;
	total_sessions: number;
	sources: Record<string, number>;
	last_memory: string | null;
	database: string;
	mode: "beam";
	banks: string[];
	beam: {
		working_memory: unknown;
		episodic_memory: unknown;
		triples: { total: number };
	};
}

type Row = Record<string, unknown>;
type BeamRecallFacadeOptions = RecallOptions & {
	source?: string | null;
	topic?: string | null;
	temporalWeight?: number;
	temporalHalflife?: number;
	vecWeight?: number;
	ftsWeight?: number;
	importanceWeight?: number;
};

type ModuleRememberOptions = RememberFacadeOptions & { readonly bank?: string | null };
type ModuleRecallOptions = RecallFacadeOptions & { readonly bank?: string | null };
type ModuleRecallEnhancedOptions = RecallFacadeOptions & RecallEnhancedOptions & { readonly bank?: string | null };
type FacadeRememberOptions = {
	source: string;
	importance: number;
	metadata: Metadata | null;
	valid_until: string | null | undefined;
	scope: string;
	extractEntities: boolean;
	extract: boolean;
	extractText: string | undefined;
	embedText: string | undefined;
	trustTier: string | undefined;
	veracity: string | undefined;
	memoryType: string | undefined;
	timestamp?: string;
};

function hasOwn(options: MnemopiOptions, key: keyof MnemopiOptions): boolean {
	return Object.hasOwn(options, key);
}

function resolveRuntimeOptions(options: MnemopiOptions): ResolvedMnemopiRuntimeOptions | undefined {
	const nestedEmbeddings =
		options.embeddings !== false && options.embeddings !== undefined ? options.embeddings : undefined;
	const embeddingDisabled =
		options.embeddings === false
			? true
			: hasOwn(options, "noEmbeddings")
				? options.noEmbeddings
				: nestedEmbeddings?.disabled;
	const embeddingModel = options.embeddingModel ?? nestedEmbeddings?.model;
	const embeddingApiUrl = options.embeddingApiUrl ?? nestedEmbeddings?.apiUrl;
	const embeddingApiKey = options.embeddingApiKey ?? nestedEmbeddings?.apiKey;
	const embeddingProvider = resolveEmbeddingProvider(nestedEmbeddings?.provider);
	const embeddingMaxInputChars = nestedEmbeddings?.maxInputChars;

	const embeddings =
		embeddingDisabled !== undefined ||
		embeddingModel !== undefined ||
		embeddingApiUrl !== undefined ||
		embeddingApiKey !== undefined ||
		embeddingProvider !== undefined ||
		embeddingMaxInputChars !== undefined
			? {
					disabled: embeddingDisabled,
					model: embeddingModel,
					apiUrl: embeddingApiUrl,
					apiKey: embeddingApiKey,
					provider: embeddingProvider,
					maxInputChars: embeddingMaxInputChars,
				}
			: undefined;

	let llm: ResolvedMnemopiRuntimeOptions["llm"];
	if (options.llm === false) {
		llm = { enabled: false };
	} else if (typeof options.llm === "function") {
		llm = { enabled: true, complete: options.llm };
	} else if (isPiAiModel(options.llm)) {
		llm = { enabled: true, model: options.llm };
	} else {
		const nestedLlm = options.llm !== undefined && !isPiAiModel(options.llm) ? options.llm : undefined;
		const llmModel = nestedLlm?.model ?? options.llmModel;
		const llmEnabled = hasOwn(options, "llmEnabled")
			? options.llmEnabled
			: (nestedLlm?.enabled ??
				  (nestedLlm?.baseUrl !== undefined ||
						nestedLlm?.apiKey !== undefined ||
						nestedLlm?.maxTokens !== undefined ||
						nestedLlm?.complete !== undefined ||
						llmModel !== undefined ||
						hasOwn(options, "llmBaseUrl") ||
						hasOwn(options, "llmApiKey") ||
						hasOwn(options, "llmModel")))
				? true
				: undefined;
		const llmBaseUrl = options.llmBaseUrl ?? nestedLlm?.baseUrl;
		const llmApiKey = options.llmApiKey ?? nestedLlm?.apiKey;
		const llmMaxTokens = nestedLlm?.maxTokens;
		const llmComplete = nestedLlm?.complete;
		const llmExtractionPrompt = nestedLlm?.extractionPrompt;
		const llmConsolidationPrompt = nestedLlm?.consolidationPrompt;
		if (
			llmEnabled !== undefined ||
			llmBaseUrl !== undefined ||
			llmApiKey !== undefined ||
			llmModel !== undefined ||
			llmMaxTokens !== undefined ||
			llmComplete !== undefined ||
			llmExtractionPrompt !== undefined ||
			llmConsolidationPrompt !== undefined
		) {
			llm = {
				enabled: llmEnabled,
				baseUrl: llmBaseUrl,
				apiKey: llmApiKey,
				model: llmModel,
				maxTokens: llmMaxTokens,
				complete: llmComplete,
				extractionPrompt: llmExtractionPrompt,
				consolidationPrompt: llmConsolidationPrompt,
			};
		}
	}

	const debug = options.debug ? true : undefined;
	if (embeddings === undefined && llm === undefined && debug === undefined) {
		return undefined;
	}
	return { embeddings, llm, debug };
}

let defaultInstance: Mnemopi | null = null;
let defaultBank = "default";

function normalizeDate(value: string | Date | null | undefined): string | null | undefined {
	if (value instanceof Date) return value.toISOString();
	return value ?? undefined;
}

function resolveDbPath(options: MnemopiOptions, bank: string): string | undefined {
	const explicit = options.dbPath ?? options.db_path;
	if (explicit !== undefined) return explicit;
	if (options.db !== undefined) return undefined;
	if (bank !== "default") return new BankManager().getBankDbPath(bank);
	return configuredDbPath();
}

function toRememberOptions(input: string | RememberInput, options: RememberFacadeOptions) {
	const memory = typeof input === "string" ? null : input;
	const timestamp = normalizeDate(options.timestamp ?? memory?.timestamp);
	const extractText =
		options.extractText ?? options.extract_text ?? memory?.extractText ?? memory?.extract_text ?? null;
	const embedText = options.embedText ?? options.embed_text ?? memory?.embedText ?? memory?.embed_text ?? null;
	const rememberOptions: FacadeRememberOptions = {
		source: options.source ?? memory?.source ?? "conversation",
		importance: options.importance ?? memory?.importance ?? 0.5,
		metadata: options.metadata ?? memory?.metadata ?? null,
		valid_until: normalizeDate(options.valid_until ?? options.validUntil ?? memory?.valid_until),
		scope: options.scope ?? memory?.scope ?? "session",
		extractEntities:
			options.extractEntities ??
			options.extract_entities ??
			memory?.extractEntities ??
			memory?.extract_entities ??
			false,
		extract: options.extract ?? memory?.extract ?? false,
		extractText: extractText ?? undefined,
		embedText: embedText ?? undefined,
		trustTier: options.trustTier ?? options.trust_tier ?? memory?.trustTier ?? memory?.trust_tier ?? undefined,
		veracity: options.veracity ?? memory?.veracity ?? undefined,
		memoryType: options.memoryType ?? options.memory_type ?? memory?.memoryType ?? memory?.memory_type ?? undefined,
	};
	if (timestamp !== null && timestamp !== undefined) rememberOptions.timestamp = timestamp;
	return rememberOptions;
}

function toRecallOptions(options: RecallFacadeOptions): BeamRecallFacadeOptions {
	const beamOptions: BeamRecallFacadeOptions = {
		fromDate: options.fromDate ?? options.from_date ?? null,
		toDate: options.toDate ?? options.to_date ?? null,
		authorId: options.authorId ?? null,
		authorType: options.authorType ?? null,
		channelId: options.channelId ?? null,
		includeWorking: options.includeWorking,
		queryTime: options.queryTime ?? options.query_time ?? null,
		source: options.source ?? null,
		topic: options.topic ?? null,
		temporalWeight: options.temporalWeight ?? options.temporal_weight ?? undefined,
		temporalHalflife: options.temporalHalflife ?? options.temporal_halflife ?? undefined,
		vecWeight: options.vecWeight ?? options.vec_weight ?? undefined,
		ftsWeight: options.ftsWeight ?? options.fts_weight ?? undefined,
		importanceWeight: options.importanceWeight ?? options.importance_weight ?? undefined,
		contentPreviewChars: options.contentPreviewChars,
	};
	// Preserve the three-state semantics (`undefined` = auto-derive, `null` = explicitly
	// FTS-only, `number[]` = caller-supplied) so callers can opt out of `recall()`'s
	// auto-embed without being forced into it.
	if ("queryEmbedding" in options) beamOptions.queryEmbedding = options.queryEmbedding;
	return beamOptions;
}

function countRows(db: Database, sql: string, ...params: (string | number | null)[]): number {
	using statement = db.prepare(sql);
	const row = statement.get(...params) as { total?: number; count?: number } | null;
	return row?.total ?? row?.count ?? 0;
}

function dataDirForDbPath(path: string): string | undefined {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (slash < 0) return undefined;
	const parent = path.slice(0, slash);
	const marker = `${parent.includes("\\") ? "\\" : "/"}banks${parent.includes("\\") ? "\\" : "/"}`;
	const bankIndex = parent.lastIndexOf(marker);
	return bankIndex < 0 ? parent : parent.slice(0, bankIndex);
}

function sourceCounts(db: Database): Record<string, number> {
	const counts: Record<string, number> = {};
	using statement = db.prepare("SELECT source, COUNT(*) AS total FROM working_memory GROUP BY source");
	for (const row of statement.all() as Row[]) {
		counts[String(row.source ?? "") || "conversation"] = Number(row.total ?? 0);
	}
	return counts;
}

function buildBeamAnnotations(db: Database, dbPath: string | undefined): BeamMemory["annotations"] {
	const annotationStore = dbPath === undefined ? new AnnotationStore({ db }) : new AnnotationStore({ db, dbPath });
	return {
		add: (memoryId, kind, value, writeOptions) =>
			annotationStore.add(memoryId, kind, value, writeOptions?.source, writeOptions?.confidence),
		addMany: (memoryId, kind, values, writeOptions) =>
			annotationStore.addMany(memoryId, kind, values, writeOptions?.source, writeOptions?.confidence),
		queryByMemory: (memoryId, kind) => annotationStore.queryByMemory(memoryId, kind),
		queryByKind: (kind, value) => annotationStore.queryByKind(kind, { value }),
		getDistinctValues: kind => annotationStore.getDistinctValues(kind),
	};
}

function buildEpisodicGraph(db: Database, dbPath: string | undefined): EpisodicGraph {
	return dbPath === undefined ? new EpisodicGraph({ db }) : new EpisodicGraph({ db, dbPath });
}

function defaultFor(bank: string | null | undefined = null): Mnemopi {
	const targetBank = bank ?? defaultBank ?? "default";
	if (defaultInstance === null || defaultInstance.bank !== targetBank) {
		defaultInstance?.close();
		defaultBank = targetBank;
		defaultInstance = new Mnemopi({ bank: targetBank });
	}
	return defaultInstance;
}

export class Mnemopi {
	readonly sessionId: string;
	readonly bank: string;
	readonly dbPath?: string;
	readonly authorId: string | null;
	readonly authorType: string | null;
	readonly channelId: string;
	readonly beam: BeamMemory;
	readonly conn: Database;
	readonly db: Database;
	readonly runtimeOptions?: ResolvedMnemopiRuntimeOptions;
	#ownsDb: boolean;
	#closed = false;

	constructor(options: MnemopiOptions = {}) {
		this.sessionId = options.sessionId ?? options.session_id ?? "default";
		this.bank = options.bank ?? "default";

		this.authorId = options.authorId ?? options.author_id ?? null;
		this.authorType = options.authorType ?? options.author_type ?? null;
		this.channelId = options.channelId ?? options.channel_id ?? this.sessionId;
		this.dbPath = resolveDbPath(options, this.bank);
		this.runtimeOptions = resolveRuntimeOptions(options);

		this.beam = new BeamMemory({
			sessionId: this.sessionId,
			dbPath: options.db === undefined ? this.dbPath : ":memory:",
			authorId: this.authorId,
			authorType: this.authorType,
			channelId: this.channelId,
			proactiveLinking: options.proactiveLinking,
		});
		this.#ownsDb = options.db === undefined;
		if (options.db !== undefined) {
			const opened = this.beam.db;
			initBeam(options.db);
			Object.defineProperty(this.beam, "db", { value: options.db });
			Object.defineProperty(this.beam, "annotations", {
				value: buildBeamAnnotations(options.db, this.dbPath),
			});
			Object.defineProperty(this.beam, "episodicGraph", {
				value: buildEpisodicGraph(options.db, this.dbPath),
			});
			closeQuietly(opened);
		}
		this.conn = this.beam.db;
		this.db = this.beam.db;
		// Wipe-and-rebuild stale embeddings when the configured model changed since
		// the vectors were written. Runs inside the runtime scope so
		// `currentEmbeddingModel()` reflects this instance's configured model.
		// Skipped for read-only opens (`reconcile: false`) so an ephemeral stats
		// reader never triggers a destructive migration whose async rebuild it would
		// exit before completing — which would otherwise lose the embeddings.
		if (options.reconcile !== false) {
			this.#withRuntimeOptions(() => reconcileEmbeddingModel(this.beam));
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#ownsDb) this.beam.close();
	}

	async flushExtractions(): Promise<void> {
		await this.beam.flushExtractions();
	}

	remember(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		const content = typeof memory === "string" ? memory : memory.content;
		return this.#withRuntimeOptions(() => this.beam.remember(content, toRememberOptions(memory, options)));
	}

	recall(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.#withRuntimeOptions(() => this.beam.recall(query, topK, toRecallOptions(options)));
	}

	recallEnhanced(
		query: string,
		topK = 5,
		options: RecallFacadeOptions & RecallEnhancedOptions = {},
	): Promise<RecallResult[]> {
		return this.#withRuntimeOptions(() =>
			this.beam.recallEnhanced(query, topK, {
				...toRecallOptions(options),
				useCache: options.useCache,
				includeFacts: options.includeFacts,
			}),
		);
	}

	getContext(limit = 10): unknown[] {
		return this.#withRuntimeOptions(() => this.beam.getContext(limit));
	}

	getStats(
		authorId: string | null = null,
		authorType: string | null = null,
		channelId: string | null = null,
	): MemoryFacadeStats {
		const working = this.#withRuntimeOptions(() => this.beam.getWorkingStats(authorId, authorType, channelId));
		const episodic = this.#withRuntimeOptions(() => this.beam.getEpisodicStats(authorId, authorType, channelId));
		const totalMemories = countRows(this.conn, "SELECT COUNT(*) AS total FROM working_memory");
		const totalSessions = countRows(this.conn, "SELECT COUNT(DISTINCT session_id) AS total FROM working_memory");
		using lastStatement = this.conn.prepare("SELECT timestamp FROM working_memory ORDER BY timestamp DESC LIMIT 1");
		const last = lastStatement.get() as {
			timestamp: string | null;
		} | null;
		const tripleTotal = countRows(this.conn, "SELECT COUNT(*) AS total FROM triples");
		let banks = ["default"];
		if (this.dbPath !== undefined && this.dbPath !== ":memory:") {
			const dataDir = dataDirForDbPath(this.dbPath);
			banks = new BankManager(dataDir).listBanks();
		}
		return {
			total_memories: totalMemories,
			total_sessions: totalSessions,
			sources: sourceCounts(this.conn),
			last_memory: last?.timestamp ?? null,
			database: this.dbPath ?? ":memory:",
			mode: "beam",
			banks,
			beam: { working_memory: working, episodic_memory: episodic, triples: { total: tripleTotal } },
		};
	}

	get(memoryId: string): unknown | null {
		return this.#withRuntimeOptions(() => this.beam.get(memoryId));
	}

	forget(memoryId: string): boolean {
		return this.#withRuntimeOptions(() => this.beam.forgetWorking(memoryId));
	}

	update(memoryId: string, content: string | null = null, importance: number | null = null): boolean {
		return this.#withRuntimeOptions(() => this.beam.updateWorking(memoryId, content, importance));
	}

	sleep(dryRun = false): SleepResult {
		return this.#withRuntimeOptions(() => this.beam.sleep(dryRun));
	}

	sleepAllSessions(dryRun = false): SleepResult {
		return this.#withRuntimeOptions(() => this.beam.sleepAllSessions(dryRun));
	}

	scratchpadWrite(content: string): string {
		return this.#withRuntimeOptions(() => this.beam.scratchpadWrite(content));
	}

	scratchpadRead(): unknown[] {
		return this.#withRuntimeOptions(() => this.beam.scratchpadRead());
	}

	scratchpadClear(): void {
		this.#withRuntimeOptions(() => this.beam.scratchpadClear());
	}

	addMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	saveMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	storeMemory(memory: string | RememberInput, options: RememberFacadeOptions = {}): string {
		return this.remember(memory, options);
	}

	search(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.recall(query, topK, options);
	}

	query(query: string, topK = 5, options: RecallFacadeOptions = {}): Promise<RecallResult[]> {
		return this.recall(query, topK, options);
	}

	consolidate(dryRun = false): SleepResult {
		return this.sleep(dryRun);
	}
	#withRuntimeOptions<T>(fn: () => T): T {
		return withMnemopiRuntimeOptions(this.runtimeOptions, fn);
	}
}

export function setBank(bank: string): void {
	defaultBank = bank;
	defaultInstance?.close();
	defaultInstance = null;
}

export function getBank(): string {
	return defaultBank || "default";
}

export function getDefaultInstance(bank: string | null = null): Mnemopi {
	return defaultFor(bank);
}

export function remember(content: string | RememberInput, options: ModuleRememberOptions = {}): string {
	return defaultFor(options.bank).remember(content, options);
}

export function recall(query: string, topK = 5, options: ModuleRecallOptions = {}): Promise<RecallResult[]> {
	return defaultFor(options.bank).recall(query, topK, options);
}

export function recallEnhanced(
	query: string,
	topK = 5,
	options: ModuleRecallEnhancedOptions = {},
): Promise<RecallResult[]> {
	return defaultFor(options.bank).recallEnhanced(query, topK, options);
}

export function getContext(limit = 10, bank: string | null = null): unknown[] {
	return defaultFor(bank).getContext(limit);
}

export function getStats(bank: string | null = null): MemoryFacadeStats {
	return defaultFor(bank).getStats();
}

export function get(memoryId: string, bank: string | null = null): unknown | null {
	return defaultFor(bank).get(memoryId);
}

export function forget(memoryId: string, bank: string | null = null): boolean {
	return defaultFor(bank).forget(memoryId);
}

export function update(
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
	bank: string | null = null,
): boolean {
	return defaultFor(bank).update(memoryId, content, importance);
}

export function sleep(dryRun = false, bank: string | null = null): SleepResult {
	return defaultFor(bank).sleep(dryRun);
}

export function sleepAllSessions(dryRun = false, bank: string | null = null): SleepResult {
	return defaultFor(bank).sleepAllSessions(dryRun);
}

export function flushExtractions(bank: string | null = null): Promise<void> {
	return defaultFor(bank).flushExtractions();
}

export function scratchpadWrite(content: string, bank: string | null = null): string {
	return defaultFor(bank).scratchpadWrite(content);
}

export function scratchpadRead(bank: string | null = null): unknown[] {
	return defaultFor(bank).scratchpadRead();
}

export function scratchpadClear(bank: string | null = null): void {
	defaultFor(bank).scratchpadClear();
}
export function addMemory(memory: string | RememberInput, options: ModuleRememberOptions = {}): string {
	return remember(memory, options);
}

export function saveMemory(memory: string | RememberInput, options: ModuleRememberOptions = {}): string {
	return remember(memory, options);
}

export function storeMemory(memory: string | RememberInput, options: ModuleRememberOptions = {}): string {
	return remember(memory, options);
}

export function search(query: string, topK = 5, options: ModuleRecallOptions = {}): Promise<RecallResult[]> {
	return recall(query, topK, options);
}

export function query(query: string, topK = 5, options: ModuleRecallOptions = {}): Promise<RecallResult[]> {
	return recall(query, topK, options);
}

export function resetDefaultInstanceForTests(): void {
	defaultInstance?.close();
	defaultInstance = null;
	defaultBank = "default";
}

export function resetMemoryForTests(): void {
	resetDefaultInstanceForTests();
}

export function resetModuleStateForTests(): void {
	resetDefaultInstanceForTests();
}

export type { MemoryInput, MemoryStats } from "../types";
export default Mnemopi;
