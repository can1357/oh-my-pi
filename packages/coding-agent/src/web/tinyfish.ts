/**
 * TinyFish Fetch API Client
 *
 * Shared TinyFish REST helpers: endpoint resolution (honouring the
 * `TINYFISH_FETCH_BASE_URL` / `TINYFISH_FETCH_URL` self-hosting overrides) and
 * the `/fetch` reader backend used by the fetch/read URL tool.
 *
 * See https://docs.tinyfish.ai.
 */
import { type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import { findCredential, withHardTimeout } from "./search/providers/utils";

const TINYFISH_DEFAULT_FETCH_URL = "https://api.fetch.tinyfish.ai";
/** Cap on honoured `Retry-After` hints; longer hints fail fast to the next backend. */
const RETRY_MAX_DELAY_MS = 2_000;

/**
 * Resolve a TinyFish fetch endpoint URL, applying the `TINYFISH_FETCH_BASE_URL` (or
 * its `TINYFISH_FETCH_URL` alias) override when set.
 */
export function resolveTinyFishFetchUrl(): string {
	const configured = process.env.TINYFISH_FETCH_BASE_URL ?? process.env.TINYFISH_FETCH_URL;
	if (!configured?.trim()) return TINYFISH_DEFAULT_FETCH_URL;
	let url: URL;
	try {
		url = new URL(configured.trim());
	} catch {
		throw new Error("Invalid TinyFish fetch base URL: expected an HTTP or HTTPS URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Invalid TinyFish fetch base URL: expected an HTTP or HTTPS URL");
	}
	if (url.username || url.password) {
		throw new Error("Invalid TinyFish fetch base URL: URL credentials are not allowed");
	}
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

/**
 * Error thrown when a TinyFish fetch request or API response fails.
 */
export class TinyFishFetchError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "TinyFishFetchError";
		this.statusCode = statusCode;
	}
}

/**
 * Execution options for {@link scrapeWithTinyFish}.
 */
export interface TinyFishFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

/**
 * Resolve TinyFish API credentials from environment variables or agent storage.
 */
export function findTinyFishApiKey(storage: AgentStorage | null | undefined): string | null {
	return findCredential(storage, getEnvApiKey("tinyfish"), "tinyfish");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function getObjectArray(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const candidate = value[key];
	if (!Array.isArray(candidate)) return [];
	return candidate.filter(isObject);
}

function parseTinyFishErrorResponse(statusCode: number, responseText: string): TinyFishFetchError {
	const trimmed = responseText.trim();
	if (trimmed.length === 0) {
		return new TinyFishFetchError(`TinyFish API error (${statusCode})`, statusCode);
	}
	try {
		const payload: unknown = JSON.parse(trimmed);
		if (isObject(payload)) {
			const detail = getString(payload, "error") ?? getString(payload, "message");
			if (detail && detail.trim().length > 0) {
				return new TinyFishFetchError(`TinyFish API error (${statusCode}): ${detail.trim()}`, statusCode);
			}
		}
		return new TinyFishFetchError(`TinyFish API error (${statusCode}): ${trimmed}`, statusCode);
	} catch {
		return new TinyFishFetchError(`TinyFish API error (${statusCode}): ${trimmed}`, statusCode);
	}
}

/**
 * Scrape a single URL through TinyFish and return its markdown rendering, or
 * `null` when the response carries no markdown. Unlike local renderers,
 * TinyFish renders dynamic pages in a full browser environment.
 */
export async function scrapeWithTinyFish(
	url: string,
	options: TinyFishFetchOptions,
	storage: AgentStorage | null | undefined,
): Promise<string | null> {
	const apiKey = findTinyFishApiKey(storage);
	if (!apiKey) {
		throw new TinyFishFetchError("TinyFish credentials not found. Set TINYFISH_API_KEY.");
	}

	const body = {
		urls: [url],
		format: "markdown",
		links: false,
		image_links: false,
		ttl: 0,
	};

	const response = await fetchWithRetry(resolveTinyFishFetchUrl(), {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-API-Key": apiKey,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal, options.timeoutMs),
		fetch: options.fetch,
		maxAttempts: 2,
		maxDelayMs: RETRY_MAX_DELAY_MS,
	});

	if (!response.ok) {
		throw parseTinyFishErrorResponse(response.status, await response.text());
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new TinyFishFetchError(`TinyFish fetch returned invalid JSON: ${detail}`);
	}

	if (!isObject(payload)) {
		throw new TinyFishFetchError("TinyFish fetch returned an unexpected response shape");
	}

	const errors = getObjectArray(payload, "errors");
	const results = getObjectArray(payload, "results");

	if (errors.length > 0) {
		const firstError = getString(errors[0]!, "error");
		if (firstError && results.length === 0) {
			throw new TinyFishFetchError(firstError);
		}
	}

	const firstResult = results[0];
	if (!firstResult) return null;

	return getString(firstResult, "text") ?? null;
}
