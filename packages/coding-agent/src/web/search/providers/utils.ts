import type { AgentStorage } from "../../../session/agent-storage";
import { DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS, SearchProviderError } from "../../../web/search/types";
import { SEARCH_PROVIDER_LABELS, type SearchProviderId, type SearchSource } from "../types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * The caller MUST supply an open {@link AgentStorage} handle so the helper
 * never reaches out to global filesystem state; both the unified web_search
 * chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param storage - Open agent storage handle
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * The 60-second default tolerates legitimate slow LLM-mediated responses
 * (Anthropic web_search_20250305, Perplexity, Gemini, Codex) while bounding
 * Windows stalls when Bun's `AbortSignal` fails to propagate. Callers may
 * configure a longer provider deadline, capped at five minutes by the
 * dispatcher; pure search APIs typically settle far faster.
 */
export const SEARCH_HARD_TIMEOUT_MS = DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1_000;

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle within `ms` even when the
 * runtime fails to propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number = SEARCH_HARD_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}

/**
 * Collapse runs of whitespace in a loosely-typed provider field, returning
 * `undefined` for missing/non-string/blank values. Shared so tab/newline
 * folding cannot drift between providers.
 */
export function normalizeSearchText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : undefined;
}

/**
 * Bare, deduplicated hosts from `site:` values (`github.com/anthropics` → `github.com`)
 * for provider domain filters; path parts are enforced by the central lenient post-filter.
 */
export function siteHosts(sites: readonly string[]): string[] {
	const hosts = new Set<string>();
	for (const site of sites) {
		const host = site.split("/", 1)[0];
		if (host) hosts.add(host);
	}
	return [...hosts];
}

/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then a cheap <meta charset> sniff), falling back to UTF-8.
 */
export function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentTypeHeader)?.[1];
	if (!label) {
		// All charsets we can decode are ASCII-compatible in the prefix, so a
		// latin1 view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			// Bun.Encoding's union is narrower than the runtime, which accepts
			// WHATWG labels (shift_jis, euc-kr, gbk, big5, …); unknowns throw here.
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall back to UTF-8.
		}
	}
	return bytes.toString("utf-8");
}

/**
 * Read a response body up to `maxBytes`, stopping once the cap is crossed.
 * `bytes` never exceeds the cap; `truncated` reports whether the body was cut
 * mid-stream. Returns `null` when the response carries no readable body.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean } | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;

	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			const accepted = Math.min(value.byteLength, maxBytes - totalSize);
			if (accepted < value.byteLength) {
				// Crossing chunk: keep the head up to the cap, mark the body cut
				// and stop reading so an oversized response cannot balloon memory.
				if (accepted > 0) {
					chunks.push(value.subarray(0, accepted));
					totalSize += accepted;
				}
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
			chunks.push(value);
			totalSize += accepted;
		}
	} finally {
		reader.releaseLock();
	}

	// A single chunk is decoded in place; only multi-chunk bodies need a concat copy.
	const bytes =
		chunks.length === 1
			? Buffer.from(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength)
			: Buffer.concat(chunks, totalSize);
	return { bytes, truncated };
}

/**
 * Read a provider response body up to a byte cap, truncating or throwing when
 * the limit is exceeded. Shared so streaming-cap fixes land in one place.
 */
export async function readLimitedText(
	response: Response,
	provider: SearchProviderId,
	maxBytes: number,
	truncate = false,
): Promise<string> {
	const body = await readBodyCapped(response, maxBytes);
	if (!body) return "";
	if (body.truncated && !truncate) {
		throw new SearchProviderError(provider, `${SEARCH_PROVIDER_LABELS[provider]} API response exceeded 2 MiB`, 500);
	}
	return decodeBody(body.bytes, response.headers.get("content-type") ?? "");
}
