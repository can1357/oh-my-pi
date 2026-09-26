/**
 * Minimal fetch-based client for the Dakera HTTP API.
 *
 * Hand-rolled for the same reason the Hindsight client is: we depend on the
 * endpoints we actually use and nothing else, so no SDK goes into the lockfile.
 *
 * Deliberate omissions, all verified against a live engine (v0.11.91):
 *   - `valid_from` is never sent on store (the field appeared in the SDK after
 *     v0.11.98; older servers reject it).
 *   - `consolidate` is not wrapped at all. It is a plain concatenation, not a
 *     synthesis, and its `dry_run` is ignored — a "preview" call irreversibly
 *     merges memories. Nothing in this client may present it as read-only.
 *   - `search` (the lexical endpoint) is not wrapped either; its scores are
 *     unnormalized (observed 1.42) so they cannot be ranked beside recall's.
 *   - `DELETE /v1/memories/forget/batch` is not wrapped: its `filter` envelope
 *     could not be satisfied by any shape tried, while `POST /v1/memory/forget`
 *     with `memory_ids` works and is what `forget()` below uses.
 */

import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import type { DakeraConfig } from "./config";

const DEFAULT_USER_AGENT = USER_AGENT;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETAIN_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 10_000;
/** Ceiling for a server-advertised Retry-After — a broken header must not park recall for hours. */
const MAX_RETRY_AFTER_SECONDS = 60;

export type DakeraMemoryType = "episodic" | "semantic" | "procedural" | "working";

/**
 * A stored memory as returned by the server.
 *
 * Timestamps come back as Unix seconds (number) on every endpoint probed, not
 * the ISO strings the Python SDK's models imply; `formatDakeraTimestamp` below
 * is the single place that normalizes them.
 */
export interface DakeraMemory {
	id?: string;
	content: string;
	memory_type?: DakeraMemoryType;
	importance?: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
	created_at?: number | string;
	updated_at?: number | string;
	last_accessed_at?: number | string;
	access_count?: number;
	session_id?: string;
	[key: string]: unknown;
}

/** One `recall` hit: the memory plus however the server scored it. */
export interface DakeraRecallHit {
	memory: DakeraMemory;
	score?: number;
	smart_score?: number;
	weighted_score?: number;
	vector_score?: number;
	text_score?: number;
	[key: string]: unknown;
}

export interface DakeraStoreInput {
	content: string;
	memoryType: DakeraMemoryType;
	importance: number;
	tags?: string[];
	metadata?: Record<string, unknown>;
	sessionId?: string;
}

export interface DakeraRequestOptions {
	signal?: AbortSignal;
}

export interface DakeraRecallOptions extends DakeraRequestOptions {
	topK?: number;
	minImportance?: number;
	rerank?: boolean;
	memoryType?: DakeraMemoryType;
	since?: string;
	until?: string;
	/** ANY-match tag filter: the server keeps memories carrying >=1 of these tags. */
	tags?: string[];
}

export interface DakeraTimeouts {
	request?: number;
	recall?: number;
	retain?: number;
}

export interface DakeraRetryOptions {
	/** Attempts total (1 = no retries). Default 3. */
	maxRetries?: number;
	/** Base backoff delay in ms; doubles per attempt, capped by maxDelay. Default 100. */
	baseDelay?: number;
	/** Backoff ceiling in ms. Default 10_000. */
	maxDelay?: number;
}

export interface DakeraApiOptions {
	baseUrl: string;
	apiKey?: string;
	userAgent?: string;
	timeouts?: DakeraTimeouts;
	retry?: DakeraRetryOptions;
}

export class DakeraError extends Error {
	statusCode?: number;
	details?: unknown;

	constructor(message: string, statusCode?: number, details?: unknown) {
		super(message);
		this.name = "DakeraError";
		this.statusCode = statusCode;
		this.details = details;
	}
}

/** Server asked to slow down (429). Carries `retryAfterSeconds` when advertised. */
export class DakeraRateLimitError extends DakeraError {
	retryAfterSeconds?: number;

	constructor(message: string, retryAfterSeconds?: number, details?: unknown) {
		super(message, 429, details);
		this.name = "DakeraRateLimitError";
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export class DakeraApi {
	#baseUrl: string;
	#headers: Record<string, string>;
	#requestTimeoutMs: number;
	#recallTimeoutMs: number;
	#retainTimeoutMs: number;
	#maxRetries: number;
	#baseDelayMs: number;
	#maxDelayMs: number;

	constructor(options: DakeraApiOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#headers = {
			"User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
			"Content-Type": "application/json",
		};
		if (options.apiKey) {
			this.#headers.Authorization = `Bearer ${options.apiKey}`;
		}
		this.#requestTimeoutMs = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#recallTimeoutMs = options.timeouts?.recall ?? DEFAULT_RECALL_TIMEOUT_MS;
		this.#retainTimeoutMs = options.timeouts?.retain ?? DEFAULT_RETAIN_TIMEOUT_MS;
		this.#maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#baseDelayMs = options.retry?.baseDelay ?? DEFAULT_BASE_DELAY_MS;
		this.#maxDelayMs = options.retry?.maxDelay ?? DEFAULT_MAX_DELAY_MS;
	}

	async store(agentId: string, input: DakeraStoreInput, options?: DakeraRequestOptions): Promise<DakeraMemory> {
		const response = await this.#request<unknown>(
			"POST",
			"/v1/memory/store",
			"store",
			buildStoreBody(agentId, input),
			{ signal: options?.signal, timeoutMs: this.#retainTimeoutMs },
		);
		// `{"memory": {...}, "embedding_time_ms": n}`, but a flat memory object is
		// what some deployments return — accept either.
		return unwrapMemory(response);
	}

	/**
	 * Store several memories in one request so the server embeds them in a
	 * single pass. The batch endpoint answers with a flat `{stored: [...]}`
	 * list — no per-item wrapper and no scores.
	 */
	async storeBatch(
		agentId: string,
		inputs: DakeraStoreInput[],
		options?: DakeraRequestOptions,
	): Promise<DakeraMemory[]> {
		if (inputs.length === 0) return [];
		const response = await this.#request<unknown>(
			"POST",
			"/v1/memories/store/batch",
			"storeBatch",
			{
				agent_id: agentId,
				memories: inputs.map(input => buildStoreBody(agentId, input)),
			},
			{ signal: options?.signal, timeoutMs: this.#retainTimeoutMs },
		);
		return unwrapMemoryList(response);
	}
	/**
	 * Register a session row server-side so the Dakera UI groups this session's
	 * memories and shows live activity. A failed registration is non-fatal.
	 */
	async sessionStart(
		agentId: string,
		sessionId: string,
		metadata?: Record<string, unknown>,
	): Promise<string | undefined> {
		const response = await this.#request<unknown>(
			"POST",
			"/v1/sessions/start",
			"sessionStart",
			pruneUndefined({ agent_id: agentId, session_id: sessionId, metadata }),
			{ timeoutMs: this.#requestTimeoutMs },
		);
		// `{session: {id}}`; older servers ignore session_id and mint their own,
		// so the returned id (when present) is the one memories must reference.
		const id = isRecord(response) && isRecord(response.session) ? response.session.id : undefined;
		return typeof id === "string" ? id : undefined;
	}

	/**
	 * Close a session row and pin the final summary. The server sets `ended_at`
	 * itself and answers `{session, memory_count}`; failures are non-fatal.
	 */
	async sessionEnd(agentId: string, sessionId: string, summary: string): Promise<void> {
		await this.#request<unknown>(
			"POST",
			`/v1/sessions/${encodeURIComponent(sessionId)}/end`,
			"sessionEnd",
			pruneUndefined({ agent_id: agentId, summary }),
			{ timeoutMs: this.#requestTimeoutMs },
		);
	}

	async recall(agentId: string, query: string, options?: DakeraRecallOptions): Promise<DakeraRecallHit[]> {
		const response = await this.#request<unknown>(
			"POST",
			"/v1/memory/recall",
			"recall",
			pruneUndefined({
				agent_id: agentId,
				query,
				top_k: options?.topK,
				min_importance: options?.minImportance,
				rerank: options?.rerank,
				memory_type: options?.memoryType,
				since: options?.since,
				until: options?.until,
				// ANY-match on zero tags matches nothing; an empty filter must not blank recall.
				tags: options?.tags?.length ? options.tags : undefined,
			}),
			{ signal: options?.signal, timeoutMs: this.#recallTimeoutMs },
		);
		return unwrapRecallHits(response);
	}

	/**
	 * List memories stored under `agentId`.
	 *
	 * `GET /v1/agents/{id}/memories` answers with a bare array — no envelope.
	 * The server's own default page size is undocumented, so callers pass an
	 * explicit `limit` and treat a result of exactly that length as possibly
	 * truncated.
	 */
	async listMemories(agentId: string, options?: DakeraRequestOptions & { limit?: number }): Promise<DakeraMemory[]> {
		const query = options?.limit === undefined ? "" : `?limit=${encodeURIComponent(String(options.limit))}`;
		const response = await this.#request<unknown>(
			"GET",
			`/v1/agents/${encodeURIComponent(agentId)}/memories${query}`,
			"listMemories",
			undefined,
			{ signal: options?.signal },
		);
		// The engine answers a bare array; accept a `{memories: [...]}` wrapper too.
		const list = Array.isArray(response) ? response : isRecord(response) ? response.memories : undefined;
		return Array.isArray(list)
			? list.filter(isRecord).map(item => normalizeMemoryContent(item as unknown as DakeraMemory))
			: [];
	}

	/**
	 * Delete memories by id and report how many the server says it removed.
	 *
	 * A forget with no filter predicate is refused server-side (it cannot be
	 * used to wipe an agent). The count is inflated: it includes derived rows
	 * (observed 6 for 3 ids), so never compare it to `memoryIds.length`.
	 */
	async forget(agentId: string, memoryIds: string[], options?: DakeraRequestOptions): Promise<number> {
		if (memoryIds.length === 0) return 0;
		const response = await this.#request<unknown>(
			"POST",
			"/v1/memory/forget",
			"forget",
			{ agent_id: agentId, memory_ids: memoryIds },
			{ signal: options?.signal, timeoutMs: this.#retainTimeoutMs },
		);
		return isRecord(response) && typeof response.deleted_count === "number" ? response.deleted_count : 0;
	}

	/**
	 * Replace a memory's content in place, so a growing transcript stays one memory.
	 *
	 * `agent_id` is a *query* parameter here — verified against a live server,
	 * which answers 400 (`Failed to deserialize query string: missing field
	 * agent_id`) when it is only present in the body.
	 */
	async update(
		agentId: string,
		memoryId: string,
		content: string,
		options?: DakeraRequestOptions,
	): Promise<DakeraMemory> {
		const path = `/v1/memory/update/${encodeURIComponent(memoryId)}?agent_id=${encodeURIComponent(agentId)}`;
		const response = await this.#request<unknown>(
			"PUT",
			path,
			"update",
			{ content },
			{ signal: options?.signal, timeoutMs: this.#retainTimeoutMs },
		);
		return unwrapMemory(response);
	}

	async #request<T>(
		method: "DELETE" | "GET" | "POST" | "PUT",
		path: string,
		operation: string,
		body?: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<T> {
		const timeoutMs = opts?.timeoutMs ?? this.#requestTimeoutMs;
		let lastError: Error = new DakeraError(`${operation} failed`);

		for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
			if (attempt > 0) {
				// Honor caller cancellation between attempts; then back off.
				if (opts?.signal?.aborted) break;
				await Bun.sleep(this.#backoffMs(attempt));
				if (opts?.signal?.aborted) break;
			}

			const init: RequestInit = {
				method,
				headers: this.#headers,
				signal: withTimeoutSignal(timeoutMs, opts?.signal),
			};
			if (body !== undefined) init.body = JSON.stringify(body);

			let response: Response;
			try {
				response = await fetch(`${this.#baseUrl}${path}`, init);
			} catch (err) {
				const message = isTimeoutError(err)
					? `${operation} request timed out after ${Math.round(timeoutMs / 1000)}s`
					: `${operation} request failed: ${err instanceof Error ? err.message : String(err)}`;
				lastError = new DakeraError(message, undefined, err);
				// The request may or may not have been committed — retrying a
				// non-idempotent POST (store/storeBatch/sessionStart) here could
				// duplicate memories or session rows, so surface immediately.
				if (method === "POST") throw lastError;
				continue;
			}

			const text = await response.text();
			const parsed = text ? safeJsonParse(text) : null;

			if (!response.ok) {
				const details =
					(parsed && typeof parsed === "object"
						? ((parsed as { error?: unknown; message?: unknown; detail?: unknown }).error ??
							(parsed as { message?: unknown }).message ??
							(parsed as { detail?: unknown }).detail)
						: undefined) ??
					parsed ??
					text;
				// 4xx (except 429) are caller mistakes — never retried.
				if (response.status === 429) {
					// The server refused without committing, so a retry is safe
					// even for POST. Parse both header forms (delay-seconds and
					// HTTP-date) and cap it in the sleep below.
					lastError = new DakeraRateLimitError(
						`${operation} rate limited`,
						parseRetryAfter(response.headers.get("Retry-After")),
						details,
					);
				} else if (response.status >= 400 && response.status < 500) {
					lastError = new DakeraError(
						`${operation} failed: ${typeof details === "string" ? details : JSON.stringify(details)}`,
						response.status,
						details,
					);
				} else {
					// 5xx: transient server-side failure — retryable.
					lastError = new DakeraError(
						`${operation} failed: ${typeof details === "string" ? details : JSON.stringify(details)}`,
						response.status,
						details,
					);
				}
				if (lastError instanceof DakeraRateLimitError) {
					// Respect Retry-After when the server advertises one — inside
					// the cap and observable by the caller's AbortSignal, so a
					// misconfigured server cannot park recall past Esc.
					const seconds = Math.min(lastError.retryAfterSeconds ?? 0, MAX_RETRY_AFTER_SECONDS);
					if (seconds > 0) await abortableSleep(seconds * 1000, opts?.signal);
				} else if (lastError instanceof DakeraError && lastError.statusCode && lastError.statusCode < 500) {
					throw lastError;
				} else if (method === "POST" && response.status >= 500) {
					// The handler may have committed before failing — same
					// duplication hazard as the network-error branch above.
					throw lastError;
				}
				continue;
			}

			return (parsed ?? {}) as T;
		}

		throw lastError instanceof Error ? lastError : new DakeraError(`${operation} failed after retries`);
	}

	/** Exponential backoff with jitter, capped by #maxDelayMs. */
	#backoffMs(attempt: number): number {
		const delay = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
		return Math.round(delay * (0.5 + Math.random()));
	}
}

/**
 * The wire record for one memory. `POST /v1/memory/store` takes this flat,
 * and `POST /v1/memories/store/batch` takes it as each item of `memories` —
 * the engine never nests it under a `memory` key on the request side (only
 * the single-store *response* is `{memory, embedding_time_ms}`).
 */
function buildStoreBody(agentId: string, input: DakeraStoreInput): Record<string, unknown> {
	return pruneUndefined({
		agent_id: agentId,
		content: input.content,
		memory_type: input.memoryType,
		importance: input.importance,
		tags: input.tags,
		metadata: input.metadata,
		session_id: input.sessionId,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Engine marker for a server-compressed (curator/consolidation) memory body:
 * `z64:` + base64 of a zstd frame. Raw payloads must never reach the model. */
const Z64_PREFIX = "z64:";

/** Decode a `z64:` content string to its stored plaintext. Returns the input
 * unchanged when it is not z64-prefixed or cannot be decoded, so an unrelated
 * value and a malformed frame degrade to the pre-fix passthrough instead of
 * throwing or blanking a memory. */
export function decodeDakeraContent(content: string): string {
	// The curator can compress an already-compressed body (observed: consolidated
	// transcripts wrapped twice), so peel layers until plaintext; the cap bounds
	// a pathological payload that re-decodes to another frame.
	let current = content;
	for (let layer = 0; layer < 8 && current.startsWith(Z64_PREFIX); layer++) {
		try {
			const bytes = Buffer.from(current.slice(Z64_PREFIX.length), "base64");
			if (bytes.length === 0) return current;
			current = Bun.zstdDecompressSync(bytes).toString("utf8");
		} catch {
			return current;
		}
	}
	return current;
}

/** Replace a compressed `content` with its decoded plaintext, in place. */
function normalizeMemoryContent(memory: DakeraMemory): DakeraMemory {
	if (typeof memory.content === "string" && memory.content.startsWith(Z64_PREFIX)) {
		memory.content = decodeDakeraContent(memory.content);
	}
	return memory;
}

function unwrapMemory(response: unknown): DakeraMemory {
	if (isRecord(response) && isRecord(response.memory))
		return normalizeMemoryContent(response.memory as unknown as DakeraMemory);
	if (isRecord(response) && typeof response.content === "string")
		return normalizeMemoryContent(response as unknown as DakeraMemory);
	return { content: "" };
}

/**
 * Accept every batch response shape the engine has been observed to use:
 * `{stored: [...]}`, `{memories: [...]}`, or a bare array.
 */
function unwrapMemoryList(response: unknown): DakeraMemory[] {
	const list = Array.isArray(response)
		? response
		: isRecord(response)
			? (response.stored ?? response.memories ?? response.memory)
			: undefined;
	if (!Array.isArray(list)) return [];
	return list.filter(isRecord).map(item => normalizeMemoryContent(item as unknown as DakeraMemory));
}

/**
 * Unwrap `{memories: [{memory: {...}, score}]}`. A flat array of memory objects
 * (what the batch surface returns) is wrapped with no score so both shapes
 * reach one consumer. Rows without a usable `content` string are dropped —
 * rendering calls `.replace()` on it unconditionally.
 */
function unwrapRecallHits(response: unknown): DakeraRecallHit[] {
	const list = Array.isArray(response) ? response : isRecord(response) ? response.memories : undefined;
	if (!Array.isArray(list)) return [];

	const hits: DakeraRecallHit[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		if (isRecord(entry.memory)) {
			// Skip rows whose memory has no usable content string: a malformed
			// or older-server payload would crash rendering (`.replace()` on
			// undefined) in both auto-recall and the `recall` tool.
			if (typeof (entry.memory as { content?: unknown }).content !== "string") continue;
			hits.push({
				...entry,
				memory: normalizeMemoryContent(entry.memory as unknown as DakeraMemory),
			} as DakeraRecallHit);
			continue;
		}
		if (typeof entry.content === "string")
			hits.push({ memory: normalizeMemoryContent(entry as unknown as DakeraMemory) });
	}
	return hits;
}

/**
 * Ranking key for a recall hit.
 *
 * `score` alone lies: the server sorts by `smart_score`, and an observed
 * duplicate pair ranked 0.627 (smart) against 0.119 (score). Fall through to
 * the other keys so a build that omits one still orders.
 */
export function recallHitRank(hit: DakeraRecallHit): number {
	return hit.smart_score ?? hit.weighted_score ?? hit.score ?? 0;
}

/**
 * Normalize a server timestamp to ISO 8601 for `MemoryBackendSearchItem`.
 *
 * Observed responses carry Unix *seconds* as a number; a digits-only string is
 * read the same way, anything else is already displayable and passed through.
 */
export function formatDakeraTimestamp(value: number | string | undefined): string | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const seconds = Number(trimmed);
	return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : trimmed;
}

/**
 * Ids of rows the server actually addressed.
 *
 * `id` is declared on {@link DakeraMemory}, but a deployment that answers a
 * store or listing without it is readable content that nothing can address —
 * so it is filtered here rather than trusted at every call site.
 */
export function collectMemoryIds(memories: DakeraMemory[]): string[] {
	return memories.map(memory => memory.id).filter((id): id is string => typeof id === "string" && id.length > 0);
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

/**
 * Parse both Retry-After forms the spec allows: delay-seconds and HTTP-date.
 * Returns whole seconds, or undefined when absent/invalid/negative.
 */
export function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return seconds > 0 ? seconds : undefined;
	}
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	const seconds = Math.ceil((at - Date.now()) / 1000);
	return seconds > 0 ? seconds : undefined;
}

/** Sleep that resolves early when the caller's signal aborts (never rejects). */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export function createDakeraClient(config: DakeraConfig & { apiUrl: string }): DakeraApi {
	return new DakeraApi({
		baseUrl: config.apiUrl,
		apiKey: config.apiToken ?? undefined,
		userAgent: USER_AGENT,
		timeouts: {
			request: config.requestTimeoutMs,
			recall: config.recallTimeoutMs,
			retain: config.retainTimeoutMs,
		},
	});
}
