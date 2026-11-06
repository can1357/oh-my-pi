/**
 * Thin client for the documented Supermemory v3 documents and v4 search/profile
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
	content: string;
	similarity?: number;
	updatedAt?: string;
}

export interface SupermemoryProfile {
	static: string[];
	dynamic: string[];
}

export interface SupermemoryDocumentInput {
	content: string;
	containerTag: string;
	/** Upsert key: a later write with the same id replaces the document. */
	customId?: string;
	metadata?: Record<string, string | number | boolean>;
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
		const object = asRecord(await this.#post("/v3/documents", input, signal));
		if (!object || typeof object.id !== "string" || typeof object.status !== "string") {
			throw new Error("Supermemory returned an invalid document response.");
		}
		return { id: object.id, status: object.status };
	}

	async search(input: SupermemorySearchInput, signal?: AbortSignal): Promise<SupermemorySearchItem[]> {
		const rawResults = asRecord(await this.#post("/v4/search", input, signal))?.results;
		if (!Array.isArray(rawResults)) throw new Error("Supermemory returned an invalid search response.");
		const results: SupermemorySearchItem[] = [];
		for (const raw of rawResults) {
			const item = asRecord(raw);
			if (!item || typeof item.id !== "string") continue;
			const content =
				typeof item.memory === "string" ? item.memory : typeof item.chunk === "string" ? item.chunk : undefined;
			if (!content) continue;
			results.push({
				id: item.id,
				content,
				similarity: typeof item.similarity === "number" ? item.similarity : undefined,
				updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
			});
		}
		return results;
	}

	async profile(containerTag: string, signal?: AbortSignal): Promise<SupermemoryProfile> {
		const profile = asRecord(asRecord(await this.#post("/v4/profile", { containerTag }, signal))?.profile);
		if (!profile) throw new Error("Supermemory returned an invalid profile response.");
		return { static: asStringArray(profile.static), dynamic: asStringArray(profile.dynamic) };
	}

	async #post(pathname: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
		if (callerSignal?.aborted) throw new Error("Supermemory request cancelled.");
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}${pathname}`, {
				method: "POST",
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
		if (!response.ok) throw new Error(`Supermemory request failed with HTTP ${response.status}.`);
		try {
			return await response.json();
		} catch {
			throw new Error("Supermemory returned invalid JSON.");
		}
	}
}
