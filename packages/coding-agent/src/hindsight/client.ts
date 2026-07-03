/**
 * Minimal fetch-based client for the Hindsight HTTP API.
 *
 * Replaces the `@vectorize-io/hindsight-client` SDK with hand-rolled fetch
 * calls so we depend on nothing more than the API endpoints we actually use:
 * `retain`, `retainBatch`, `recall`, `reflect`, bank + document management,
 * and bulk listing. Centralising construction here keeps a single seam for
 * tests to spy on.
 */

import type { HindsightConfig } from "./config";

const USER_AGENT = "oh-my-pk-coding-agent";
const DEFAULT_USER_AGENT = USER_AGENT;

export type Budget = "low" | "mid" | "high" | string;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export type UpdateMode = "replace" | "append";
export type ConsolidationState = "failed" | "pending" | "done";

export interface HindsightApiOptions {
	baseUrl: string;
	apiKey?: string;
	userAgent?: string;
}

export interface RecallResult {
	id?: string;
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
	[key: string]: unknown;
}

export interface RecallResponse {
	results: RecallResult[];
	[key: string]: unknown;
}

export interface ReflectResponse {
	text?: string;
	[key: string]: unknown;
}

export interface RetainResponse {
	[key: string]: unknown;
}

export interface BankProfileResponse {
	[key: string]: unknown;
}

export interface ListMemoriesResponse {
	[key: string]: unknown;
}

export interface DocumentResponse {
	[key: string]: unknown;
}

export interface ListDocumentsResponse {
	[key: string]: unknown;
}

/** Mirrors the shape accepted by `POST /v1/default/banks/{bank_id}/memories`. */
export interface MemoryItemInput {
	content: string;
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	tags?: string[];
	/** Scoping policy for observations derived from this item. */
	observationScopes?: "per_tag" | "combined" | "all_combinations" | string[][];
	/** Per-item extraction strategy override. */
	strategy?: string;
	updateMode?: UpdateMode;
}

export interface RetainOptions {
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	async?: boolean;
	tags?: string[];
	updateMode?: UpdateMode;
}

export interface RetainBatchOptions {
	/** Document id applied to every item that doesn't carry its own. */
	documentId?: string;
	/** Tags attached to the resulting document(s), not individual items. */
	documentTags?: string[];
	async?: boolean;
}

export interface RecallOptions {
	types?: string[];
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface ReflectOptions {
	context?: string;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface CreateBankOptions {
	reflectMission?: string;
	retainMission?: string;
}

export interface ListMemoriesOptions {
	limit?: number;
	offset?: number;
	type?: string;
	q?: string;
	consolidationState?: ConsolidationState;
}

export interface ListDocumentsOptions {
	limit?: number;
	offset?: number;
}

export interface UpdateDocumentOptions {
	tags?: string[];
}

export type MentalModelDetail = "metadata" | "content" | "full";
export type MentalModelMode = "full" | "delta";

export interface MentalModelTrigger {
	mode?: MentalModelMode;
	refresh_after_consolidation?: boolean;
}

/** Shape returned by list/get on the mental-models endpoint. Fields are populated by `detail`. */
export interface MentalModelSummary {
	id: string;
	bank_id: string;
	name: string;
	tags?: string[];
	last_refreshed_at?: string | null;
	created_at?: string | null;
	source_query?: string;
	content?: string;
	max_tokens?: number;
	trigger?: MentalModelTrigger;
	[key: string]: unknown;
}

export interface MentalModelListResponse {
	items: MentalModelSummary[];
	[key: string]: unknown;
}

export interface MentalModelHistoryEntry {
	previous_content: string | null;
	changed_at: string;
	[key: string]: unknown;
}

export interface CreateMentalModelOptions {
	id?: string;
	tags?: string[];
	maxTokens?: number;
	trigger?: MentalModelTrigger;
}

export interface CreateMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface RefreshMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface ListMentalModelsOptions {
	detail?: MentalModelDetail;
}

export interface GetMentalModelOptions {
	detail?: MentalModelDetail;
}

export class HindsightError extends Error {
	statusCode?: number;
	details?: unknown;

	constructor(message: string, statusCode?: number, details?: unknown) {
		super(message);
		this.name = "HindsightError";
		this.statusCode = statusCode;
		this.details = details;
	}
}

interface RequestOptions {
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
	/** Return null instead of throwing on a 404 response. */
	allow404?: boolean;
}

export class HindsightApi {
	#baseUrl: string;
	#headers: Record<string, string>;

	constructor(options: HindsightApiOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#headers = {
			"User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
			"Content-Type": "application/json",
		};
		if (options.apiKey) {
			this.#headers.Authorization = `Bearer ${options.apiKey}`;
		}
	}

	async retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		const item = buildMemoryItem({
			content,
			timestamp: options?.timestamp,
			context: options?.context,
			metadata: options?.metadata,
			documentId: options?.documentId,
			tags: options?.tags,
			updateMode: options?.updateMode,
		});

		return this.#request<RetainResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
			"retain",
			{ body: { items: [item], async: options?.async } },
		);
	}

	/**
	 * Retain multiple memories in a single request. Mirrors the official
	 * client's `retainBatch` — items hit `POST /memories` together so the
	 * server can dedupe and consolidate as a batch instead of N round-trips.
	 *
	 * Per-item `documentId` wins; `options.documentId` only fills the gaps.
	 */
	async retainBatch(bankId: string, items: MemoryItemInput[], options?: RetainBatchOptions): Promise<RetainResponse> {
		const processed = items.map(item => {
			const built = buildMemoryItem(item);
			if (built.document_id === undefined && options?.documentId !== undefined) {
				built.document_id = options.documentId;
			}
			return built;
		});

		return this.#request<RetainResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
			"retainBatch",
			{
				body: {
					items: processed,
					document_tags: options?.documentTags,
					async: options?.async,
				},
			},
		);
	}

	async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		return this.#request<RecallResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
			"recall",
			{
				body: {
					query,
					types: options?.types,
					max_tokens: options?.maxTokens,
					budget: options?.budget ?? "mid",
					tags: options?.tags,
					tags_match: options?.tagsMatch,
				},
			},
		);
	}

	async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse> {
		return this.#request<ReflectResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/reflect`,
			"reflect",
			{
				body: {
					query,
					context: options?.context,
					budget: options?.budget ?? "low",
					tags: options?.tags,
					tags_match: options?.tagsMatch,
				},
			},
		);
	}

	async createBank(bankId: string, options: CreateBankOptions = {}): Promise<BankProfileResponse> {
		return this.#request<BankProfileResponse>(
			"PUT",
			`/v1/default/banks/${encodeURIComponent(bankId)}`,
			"createBank",
			{
				body: {
					reflect_mission: options.reflectMission,
					retain_mission: options.retainMission,
				},
			},
		);
	}

	/**
	 * Bulk-list memory units in a bank with optional filters and pagination.
	 * Endpoint: `GET /v1/default/banks/{bank_id}/memories/list`.
	 */
	async listMemories(bankId: string, options?: ListMemoriesOptions): Promise<ListMemoriesResponse> {
		return this.#request<ListMemoriesResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/list`,
			"listMemories",
			{
				query: {
					type: options?.type,
					q: options?.q,
					consolidation_state: options?.consolidationState,
					limit: options?.limit,
					offset: options?.offset,
				},
			},
		);
	}

	/** Bulk-list documents in a bank. */
	async listDocuments(bankId: string, options?: ListDocumentsOptions): Promise<ListDocumentsResponse> {
		return this.#request<ListDocumentsResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents`,
			"listDocuments",
			{ query: { limit: options?.limit, offset: options?.offset } },
		);
	}

	/** Fetch a document. Returns `null` on 404 instead of throwing. */
	async getDocument(bankId: string, documentId: string): Promise<DocumentResponse | null> {
		return this.#request<DocumentResponse | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"getDocument",
			{ allow404: true },
		);
	}

	/** Update a document's mutable fields (currently just tags). */
	async updateDocument(bankId: string, documentId: string, options: UpdateDocumentOptions): Promise<DocumentResponse> {
		return this.#request<DocumentResponse>(
			"PATCH",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"updateDocument",
			{ body: { tags: options.tags } },
		);
	}

	/**
	 * Delete a document and every memory derived from it. Returns `true` on
	 * success, `false` if the document was already gone (404).
	 */
	async deleteDocument(bankId: string, documentId: string): Promise<boolean> {
		const result = await this.#request<{ __deleted: boolean } | null>(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
			"deleteDocument",
			{ allow404: true },
		);
		return result !== null;
	}

	/**
	 * List mental models in a bank. Default `detail=content` includes the
	 * generated `content` text but excludes the heavyweight `reflect_response`
	 * provenance chain (which can exceed 200KB). Use `detail=metadata` for
	 * inventory and `detail=full` only for debug surfaces.
	 */
	async listMentalModels(bankId: string, options?: ListMentalModelsOptions): Promise<MentalModelListResponse> {
		return this.#request<MentalModelListResponse>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
			"listMentalModels",
			{ query: { detail: options?.detail ?? "content" } },
		);
	}

	/** Fetch a single mental model. Returns `null` on 404. */
	async getMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: GetMentalModelOptions,
	): Promise<MentalModelSummary | null> {
		return this.#request<MentalModelSummary | null>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}`,
			"getMentalModel",
			{ query: { detail: options?.detail ?? "content" }, allow404: true },
		);
	}

	/**
	 * Create a mental model. Asynchronous on the server: returns an
	 * `operation_id`; the model's `content` populates after the background
	 * reflect completes.
	 */
	async createMentalModel(
		bankId: string,
		name: string,
		sourceQuery: string,
		options?: CreateMentalModelOptions,
	): Promise<CreateMentalModelResponse> {
		return this.#request<CreateMentalModelResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`,
			"createMentalModel",
			{
				body: {
					id: options?.id,
					name,
					source_query: sourceQuery,
					tags: options?.tags,
					max_tokens: options?.maxTokens,
					trigger: options?.trigger,
				},
			},
		);
	}

	/** Trigger an out-of-band refresh of a mental model. Returns the operation handle. */
	async refreshMentalModel(bankId: string, mentalModelId: string): Promise<RefreshMentalModelResponse> {
		return this.#request<RefreshMentalModelResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}/refresh`,
			"refreshMentalModel",
			{},
		);
	}

	/** Delete a mental model. Returns `true` on success, `false` if it was already gone (404). */
	async deleteMentalModel(bankId: string, mentalModelId: string): Promise<boolean> {
		const result = await this.#request<{ __deleted: boolean } | null>(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}`,
			"deleteMentalModel",
			{ allow404: true },
		);
		return result !== null;
	}

	/**
	 * Fetch the change history of a mental model. Each entry captures the
	 * content snapshot BEFORE that change; the current content is read via
	 * `getMentalModel`. Most-recent first.
	 */
	async getMentalModelHistory(bankId: string, mentalModelId: string): Promise<MentalModelHistoryEntry[]> {
		const response = await this.#request<MentalModelHistoryEntry[] | { items?: MentalModelHistoryEntry[] }>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${encodeURIComponent(mentalModelId)}/history`,
			"getMentalModelHistory",
			{},
		);
		if (Array.isArray(response)) return response;
		return response.items ?? [];
	}

	async #request<T>(method: string, path: string, operation: string, opts?: RequestOptions): Promise<T> {
		let url = `${this.#baseUrl}${path}`;
		if (opts?.query) {
			const qs = buildQueryString(opts.query);
			if (qs) url += `?${qs}`;
		}

		const init: RequestInit = { method, headers: this.#headers };
		if (opts?.body !== undefined) {
			init.body = JSON.stringify(pruneUndefined(opts.body));
		}

		let response: Response;
		try {
			response = await fetch(url, init);
		} catch (err) {
			throw new HindsightError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				err,
			);
		}

		if (opts?.allow404 && response.status === 404) {
			return null as T;
		}

		const text = await response.text();
		const parsed = text ? safeJsonParse(text) : null;

		if (!response.ok) {
			const details =
				(parsed && typeof parsed === "object"
					? ((parsed as { detail?: unknown; message?: unknown }).detail ??
						(parsed as { message?: unknown }).message)
					: undefined) ??
				parsed ??
				text;
			throw new HindsightError(
				`${operation} failed: ${typeof details === "string" ? details : JSON.stringify(details)}`,
				response.status,
				details,
			);
		}

		return (parsed ?? {}) as T;
	}
}

interface BuiltMemoryItem {
	content: string;
	timestamp?: string;
	context?: string;
	metadata?: Record<string, string>;
	document_id?: string;
	tags?: string[];
	observation_scopes?: "per_tag" | "combined" | "all_combinations" | string[][];
	strategy?: string;
	update_mode?: UpdateMode;
}

function buildMemoryItem(item: MemoryItemInput): BuiltMemoryItem {
	const out: BuiltMemoryItem = { content: item.content };
	if (item.timestamp !== undefined) {
		out.timestamp = item.timestamp instanceof Date ? formatDateWithLocalOffset(item.timestamp) : item.timestamp;
	}
	if (item.context !== undefined) out.context = item.context;
	if (item.metadata !== undefined) out.metadata = item.metadata;
	if (item.documentId !== undefined) out.document_id = item.documentId;
	if (item.tags !== undefined) out.tags = item.tags;
	if (item.observationScopes !== undefined) out.observation_scopes = item.observationScopes;
	if (item.strategy !== undefined) out.strategy = item.strategy;
	if (item.updateMode !== undefined) out.update_mode = item.updateMode;
	return out;
}

function formatDateWithLocalOffset(date: Date): string {
	const offsetMinutes = date.getTimezoneOffset();
	const offsetSign = offsetMinutes <= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absoluteOffset / 60);
	const offsetRemainderMinutes = absoluteOffset % 60;
	const milliseconds = date.getMilliseconds();
	const millisecondsPart = milliseconds === 0 ? "" : `.${pad3(milliseconds)}`;
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
		date.getHours(),
	)}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${millisecondsPart}${offsetSign}${pad2(
		offsetHours,
	)}:${pad2(offsetRemainderMinutes)}`;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function pad3(value: number): string {
	if (value < 10) return `00${value}`;
	if (value < 100) return `0${value}`;
	return String(value);
}

function buildQueryString(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item === undefined || item === null) continue;
				params.append(key, String(item));
			}
		} else {
			params.set(key, String(value));
		}
	}
	return params.toString();
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
export function createHindsightClient(config: HindsightConfig & { hindsightApiUrl: string }): HindsightApi {
	return new HindsightApi({
		baseUrl: config.hindsightApiUrl,
		apiKey: config.hindsightApiToken ?? undefined,
		userAgent: USER_AGENT,
	});
}
