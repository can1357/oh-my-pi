/**
 * Thin client for the Supermemory v5 namespace API (`/ns/{namespace}/…`). Redirects are refused so
 * the bearer token never follows one. Error messages carry only the endpoint outcome (HTTP status,
 * timeout, cancellation) — never the API key, request body, or response body.
 */
import { asRecord } from "@oh-my-pi/pi-utils";
import type { SupermemorySearchMode } from "./config";

export interface SupermemoryDocument {
	id: string;
	status: string;
}

export interface SupermemorySearchItem {
	id: string;
	/** `memory` ids are accepted by `forgetMemories`; `chunk` ids address document chunks and are not editable. */
	kind: "memory" | "chunk";
	content: string;
	similarity?: number;
	updatedAt?: string;
	/** Inferred rather than stated directly; chunks never are. */
	inferred?: boolean;
}

/** A profile fact; plain-string entries carry no id. Ids starting `aggregated_` are synthesized summaries. */
export interface SupermemoryProfileFact {
	id?: string;
	memory: string;
}

export interface SupermemoryProfile {
	static: SupermemoryProfileFact[];
	dynamic: SupermemoryProfileFact[];
}

/** A memory matched by a semantic forget preview. */
export interface SupermemoryMemoryMatch {
	id: string;
	memory: string;
}

/** An earlier/later version or linked memory of a {@link SupermemoryMemory}. */
export interface SupermemoryRelatedMemory {
	id: string;
	memory: string;
	relation?: string;
}

export interface SupermemorySourceDocument {
	id: string;
	title?: string;
	summary?: string;
}

/** One memory with its version history, links and source document (`GET /memories/{id}`). */
export interface SupermemoryMemory {
	id: string;
	memory: string;
	metadata: Record<string, unknown>;
	isStatic: boolean;
	isInference: boolean;
	isLatest: boolean;
	isForgotten: boolean;
	version?: number;
	createdAt?: string;
	updatedAt?: string;
	/** Earlier versions, nearest first. */
	parents: SupermemoryRelatedMemory[];
	/** Later versions, nearest first. */
	children: SupermemoryRelatedMemory[];
	/** Direct extends/derives links. */
	siblings: SupermemoryRelatedMemory[];
	document?: SupermemorySourceDocument;
}

/** Per-id outcome of `forgetMemories`: HTTP success does not mean every id changed. */
export interface SupermemoryForgetResult {
	/** Ids that were forgotten. */
	matches: string[];
	/** Ids that were not, with the server's reason (`Memory not found`, …). */
	errors: { id: string; error: string }[];
}

/** HTTP failure; `status` lets callers map documented error codes. */
export class SupermemoryHttpError extends Error {
	constructor(readonly status: number) {
		super(`Supermemory request failed with HTTP ${status}.`);
		this.name = "SupermemoryHttpError";
	}
}

export interface SupermemoryDocumentInput {
	content: string;
	/** Caller id: a later write with the same id adds to (diffs into) that document. */
	id?: string;
	metadata?: Record<string, string | number | boolean>;
}

export interface SupermemorySearchInput {
	query: string;
	searchMode: SupermemorySearchMode;
	limit: number;
	threshold: number;
}

/** Profile entries are `{ id, memory }` objects; plain strings are tolerated (no id). */
function profileMemories(value: unknown): SupermemoryProfileFact[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		if (typeof entry === "string") return entry ? [{ memory: entry }] : [];
		const record = asRecord(entry);
		const memory = record?.memory;
		if (typeof memory !== "string" || !memory) return [];
		return [typeof record?.id === "string" ? { id: record.id, memory } : { memory }];
	});
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function relatedMemories(value: unknown): SupermemoryRelatedMemory[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(raw => {
		const item = asRecord(raw);
		if (!item || typeof item.id !== "string" || typeof item.memory !== "string") return [];
		return [{ id: item.id, memory: item.memory, relation: optionalString(item.relation) }];
	});
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class SupermemoryClient {
	readonly #baseUrl: string;
	readonly #apiKey: string;
	readonly #timeoutMs: number;

	constructor(baseUrl: string, apiKey: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
		this.#apiKey = apiKey;
		this.#timeoutMs = timeoutMs;
	}

	async addDocument(
		namespace: string,
		input: SupermemoryDocumentInput,
		signal?: AbortSignal,
	): Promise<SupermemoryDocument> {
		const object = asRecord(await this.#request("POST", namespace, "document", input, signal));
		if (!object || typeof object.id !== "string" || typeof object.status !== "string") {
			throw new Error("Supermemory returned an invalid document response.");
		}
		return { id: object.id, status: object.status };
	}

	async search(
		namespace: string,
		input: SupermemorySearchInput,
		signal?: AbortSignal,
	): Promise<SupermemorySearchItem[]> {
		const body = { ...input, rewriteQuery: false };
		const rawResults = asRecord(await this.#request("POST", namespace, "search", body, signal))?.results;
		if (!Array.isArray(rawResults)) throw new Error("Supermemory returned an invalid search response.");
		const results: SupermemorySearchItem[] = [];
		for (const raw of rawResults) {
			const item = asRecord(raw);
			if (!item || typeof item.id !== "string") continue;
			const kind = typeof item.memory === "string" ? "memory" : "chunk";
			const content = kind === "memory" ? item.memory : item.chunk;
			if (typeof content !== "string" || !content) continue;
			const updatedAt = asRecord(item.system)?.updatedAt;
			results.push({
				id: item.id,
				kind,
				content,
				similarity: typeof item.similarity === "number" ? item.similarity : undefined,
				updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
				inferred: kind === "memory" && item.isInference === true,
			});
		}
		return results;
	}

	async profile(namespace: string, signal?: AbortSignal): Promise<SupermemoryProfile> {
		const profile = asRecord(asRecord(await this.#request("POST", namespace, "profile", {}, signal))?.profile);
		if (!profile) throw new Error("Supermemory returned an invalid profile response.");
		return { static: profileMemories(profile.static), dynamic: profileMemories(profile.dynamic) };
	}

	/** Soft-forgets memories by id: excluded from search, preserved server-side. */
	async forgetMemories(namespace: string, ids: string[], signal?: AbortSignal): Promise<SupermemoryForgetResult> {
		const object = asRecord(await this.#request("DELETE", namespace, "memories", { ids }, signal));
		if (!object || !Array.isArray(object.matches)) {
			throw new Error("Supermemory returned an invalid forget response.");
		}
		const matches = object.matches.flatMap(raw => {
			const id = asRecord(raw)?.id;
			return typeof id === "string" ? [id] : [];
		});
		const errors = (Array.isArray(object.errors) ? object.errors : []).flatMap(raw => {
			const item = asRecord(raw);
			return item && typeof item.id === "string"
				? [{ id: item.id, error: typeof item.error === "string" ? item.error : "" }]
				: [];
		});
		return { matches, errors };
	}

	/**
	 * Previews a semantic forget (`dryRun: true`, at most 100 matches): changes nothing. A real
	 * forget goes through {@link forgetMemories} with reviewed ids, so the set cannot drift.
	 */
	async previewForget(namespace: string, query: string, signal?: AbortSignal): Promise<SupermemoryMemoryMatch[]> {
		const body = { query, dryRun: true };
		const matches = asRecord(await this.#request("DELETE", namespace, "memories/semantic", body, signal))?.matches;
		if (!Array.isArray(matches)) throw new Error("Supermemory returned an invalid forget preview response.");
		return matches.flatMap(raw => {
			const item = asRecord(raw);
			return item && typeof item.id === "string" && typeof item.memory === "string"
				? [{ id: item.id, memory: item.memory }]
				: [];
		});
	}

	/** One memory with its versions, links and source document; HTTP 404 when it does not exist. */
	async getMemory(namespace: string, id: string, signal?: AbortSignal): Promise<SupermemoryMemory> {
		const resource = `memories/${encodeURIComponent(id)}?include=related,documents&relatedLimit=10`;
		const object = asRecord(await this.#request("GET", namespace, resource, undefined, signal));
		if (!object || typeof object.id !== "string" || typeof object.memory !== "string") {
			throw new Error("Supermemory returned an invalid memory response.");
		}
		const system = asRecord(object.system);
		const included = asRecord(object.included);
		const related = asRecord(included?.related);
		const document = asRecord(included?.document);
		return {
			id: object.id,
			memory: object.memory,
			metadata: asRecord(object.metadata) ?? {},
			isStatic: object.isStatic === true,
			isInference: object.isInference === true,
			isLatest: object.isLatest === true,
			isForgotten: object.isForgotten === true,
			version: typeof object.version === "number" ? object.version : undefined,
			createdAt: optionalString(system?.createdAt),
			updatedAt: optionalString(system?.updatedAt),
			parents: relatedMemories(related?.parents),
			children: relatedMemories(related?.children),
			siblings: relatedMemories(related?.siblings),
			document:
				document && typeof document.id === "string"
					? { id: document.id, title: optionalString(document.title), summary: optionalString(document.summary) }
					: undefined,
		};
	}

	async #request(
		method: string,
		namespace: string,
		resource: string,
		body: unknown,
		callerSignal?: AbortSignal,
	): Promise<unknown> {
		if (callerSignal?.aborted) throw new Error("Supermemory request cancelled.");
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}/ns/${encodeURIComponent(namespace)}/${resource}`, {
				method,
				headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				signal,
			});
		} catch {
			if (callerSignal?.aborted) throw new Error("Supermemory request cancelled.");
			if (timeoutSignal.aborted) throw new Error("Supermemory request timed out.");
			throw new Error("Supermemory request failed.");
		}
		if (!response.ok) throw new SupermemoryHttpError(response.status);
		try {
			return await response.json();
		} catch {
			throw new Error("Supermemory returned invalid JSON.");
		}
	}
}
