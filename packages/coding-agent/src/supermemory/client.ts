/**
 * Thin client for the documented Supermemory v3 documents and v4 search/profile/memories
 * endpoints. Redirects are refused so the bearer token never follows one. Error messages carry only the endpoint outcome (HTTP status, timeout,
 * cancellation) — never the API key, request body, or response body.
 */
import type { SupermemorySearchMode } from "./config";

export interface SupermemoryDocument {
	id: string;
	status: string;
}

export interface SupermemorySearchItem {
	id: string;
	/** `memory` ids are accepted by `/v4/memories`; `chunk` ids address document chunks and are not editable. */
	kind: "memory" | "chunk";
	content: string;
	similarity?: number;
	updatedAt?: string;
}

export interface SupermemoryProfile {
	static: string[];
	dynamic: string[];
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
	containerTag: string;
	/** Upsert key: a later write with the same id replaces the document. */
	customId?: string;
	metadata?: Record<string, string | number | boolean>;
}

/** One memory in one container, by id. */
export interface SupermemoryMemoryRef {
	id: string;
	containerTag: string;
}

export interface SupermemorySearchInput {
	q: string;
	containerTag: string;
	searchMode: SupermemorySearchMode;
	limit: number;
	threshold: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

	async createDocument(input: SupermemoryDocumentInput, signal?: AbortSignal): Promise<SupermemoryDocument> {
		const object = asRecord(await this.#request("POST", "/v3/documents", input, signal));
		if (!object || typeof object.id !== "string" || typeof object.status !== "string") {
			throw new Error("Supermemory returned an invalid document response.");
		}
		return { id: object.id, status: object.status };
	}

	async search(input: SupermemorySearchInput, signal?: AbortSignal): Promise<SupermemorySearchItem[]> {
		const rawResults = asRecord(await this.#request("POST", "/v4/search", input, signal))?.results;
		if (!Array.isArray(rawResults)) throw new Error("Supermemory returned an invalid search response.");
		const results: SupermemorySearchItem[] = [];
		for (const raw of rawResults) {
			const item = asRecord(raw);
			if (!item || typeof item.id !== "string") continue;
			const kind = typeof item.memory === "string" ? "memory" : "chunk";
			const content = kind === "memory" ? item.memory : item.chunk;
			if (typeof content !== "string" || !content) continue;
			results.push({
				id: item.id,
				kind,
				content,
				similarity: typeof item.similarity === "number" ? item.similarity : undefined,
				updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
			});
		}
		return results;
	}

	async profile(containerTag: string, signal?: AbortSignal): Promise<SupermemoryProfile> {
		const profile = asRecord(asRecord(await this.#request("POST", "/v4/profile", { containerTag }, signal))?.profile);
		if (!profile) throw new Error("Supermemory returned an invalid profile response.");
		return { static: asStringArray(profile.static), dynamic: asStringArray(profile.dynamic) };
	}

	/** Replaces a memory's content by creating a new version; resolves the new version's id when the server returns one. */
	async updateMemory(
		input: SupermemoryMemoryRef & { newContent: string },
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const id = asRecord(await this.#request("PATCH", "/v4/memories", input, signal))?.id;
		return typeof id === "string" ? id : undefined;
	}

	/** Soft-forgets a memory: excluded from search, preserved server-side. */
	async forgetMemory(input: SupermemoryMemoryRef & { reason?: string }, signal?: AbortSignal): Promise<void> {
		await this.#request("DELETE", "/v4/memories", input, signal);
	}

	async #request(method: string, pathname: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
		if (callerSignal?.aborted) throw new Error("Supermemory request cancelled.");
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}${pathname}`, {
				method,
				headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
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
