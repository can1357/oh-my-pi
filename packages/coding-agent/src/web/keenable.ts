import { type FetchImpl, getEnvApiKey } from "@oh-my-pi/pi-ai";
import { APP_NAME, asRecord } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../session/agent-storage";
import { findCredential, withHardTimeout } from "./search/providers/utils";

export const KEENABLE_API_BASE = "https://api.keenable.ai";
export const KEENABLE_SEARCH_URL = `${KEENABLE_API_BASE}/v1/search`;
export const KEENABLE_SEARCH_PUBLIC_URL = `${KEENABLE_API_BASE}/v1/search/public`;
export const KEENABLE_FETCH_URL = `${KEENABLE_API_BASE}/v1/fetch`;
export const KEENABLE_FETCH_PUBLIC_URL = `${KEENABLE_API_BASE}/v1/fetch/public`;
/** Application identifier required on keyless `/public` endpoints. */
export const KEENABLE_APP_TITLE = APP_NAME;

export function findKeenableApiKey(storage: AgentStorage | null | undefined): string | null {
	return findCredential(storage, getEnvApiKey("keenable"), "keenable");
}

export function keenableAuthHeaders(apiKey: string | undefined): Record<string, string> {
	if (apiKey) return { "X-API-Key": apiKey };
	return { "X-Keenable-Title": KEENABLE_APP_TITLE };
}

export function keenableSearchUrl(apiKey: string | undefined): string {
	return apiKey ? KEENABLE_SEARCH_URL : KEENABLE_SEARCH_PUBLIC_URL;
}

export function keenableFetchUrl(apiKey: string | undefined): string {
	return apiKey ? KEENABLE_FETCH_URL : KEENABLE_FETCH_PUBLIC_URL;
}

export interface KeenableFetchOptions {
	url: string;
	apiKey?: string | null;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	/** Fetch live from the source. Default true so unindexed URLs still resolve. */
	live?: boolean;
	maxChars?: number;
}

/**
 * Fetch a URL as markdown via Keenable. Returns null on HTTP/parse failure so
 * the reader chain can fall through to the next backend.
 */
export async function fetchKeenablePage(options: KeenableFetchOptions): Promise<string | null> {
	const apiKey = options.apiKey?.trim() || undefined;
	const endpoint = new URL(keenableFetchUrl(apiKey));
	endpoint.searchParams.set("url", options.url);
	if (options.live !== false) endpoint.searchParams.set("live", "true");
	if (options.maxChars != null) endpoint.searchParams.set("max_chars", String(options.maxChars));

	const headers = keenableAuthHeaders(apiKey);

	const response = await (options.fetch ?? fetch)(endpoint, {
		headers,
		signal: withHardTimeout(options.signal, options.timeoutMs),
	});
	if (!response.ok) return null;

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const content = asRecord(payload)?.content;
	if (typeof content !== "string") return null;
	const trimmed = content.trim();
	return trimmed.length > 0 ? trimmed : null;
}
