/**
 * HTTP header precedence and redirect-origin policy for remote MCP transports.
 *
 * Two invariants, applied at every transport fetch:
 *
 * 1. Client-generated headers (protocol headers like `Content-Type`, `Accept`,
 *    `Mcp-Session-Id`, and authorization) take precedence over configured
 *    headers with the same case-insensitive name. Configured headers can never
 *    corrupt the MCP wire protocol via casing tricks.
 * 2. Origin-locked servers (Agent Plugins §7.2.1) never forward configured
 *    headers to a different origin: redirects are followed manually and
 *    configured headers are attached only when the hop targets the configured
 *    origin. Method-changing redirects of non-GET requests are refused.
 */

/** Header buckets for one MCP HTTP request. */
interface MCPHeaderSources {
	/** Client-generated HTTP/MCP/authorization headers; win case-insensitively. */
	generated: Record<string, string>;
	/** Configured headers from the server entry (package or user config). */
	configured?: Record<string, string>;
}

/**
 * Merge configured headers under client-generated ones: a configured entry is
 * dropped when a generated header with the same case-insensitive name exists.
 */
export function mergeMCPHeaders({ generated, configured }: MCPHeaderSources): Record<string, string> {
	if (!configured) return { ...generated };
	const generatedNames = new Set<string>();
	for (const name in generated) generatedNames.add(name.toLowerCase());
	const merged: Record<string, string> = {};
	for (const name in configured) {
		if (!generatedNames.has(name.toLowerCase())) merged[name] = configured[name];
	}
	return { ...merged, ...generated };
}

/**
 * Set a client-generated header, removing any existing entry with the same
 * case-insensitive name so the generated value is the only one sent.
 */
export function setGeneratedHeader(headers: Record<string, string>, name: string, value: string): void {
	const lower = name.toLowerCase();
	for (const existing in headers) {
		if (existing.toLowerCase() === lower) delete headers[existing];
	}
	headers[name] = value;
}

/**
 * Return `headers` without any entry whose name case-insensitively matches
 * `name`. Used to keep transport-reserved protocol headers (e.g.
 * `MCP-Protocol-Version`) out of user-configured headers so config can never
 * inject them. Returns the original reference when there is nothing to strip,
 * so the common (no-match) path allocates nothing.
 */
export function withoutHeader(
	headers: Record<string, string> | undefined,
	name: string,
): Record<string, string> | undefined {
	if (!headers) return headers;
	const lower = name.toLowerCase();
	let hasMatch = false;
	for (const key in headers) {
		if (key.toLowerCase() === lower) {
			hasMatch = true;
			break;
		}
	}
	if (!hasMatch) return headers;
	const result: Record<string, string> = {};
	for (const key in headers) {
		if (key.toLowerCase() !== lower) result[key] = headers[key];
	}
	return result;
}

const REDIRECT_STATUSES: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };
const MAX_REDIRECT_HOPS = 5;

export interface MCPFetchInit {
	method: "GET" | "POST" | "DELETE";
	body?: string;
	signal?: AbortSignal;
}

/**
 * Fetch an MCP endpoint with header precedence and, for origin-locked servers,
 * manual redirect handling that strips configured headers on cross-origin hops.
 *
 * Non-locked servers keep the platform default redirect behavior. Locked
 * non-GET requests only follow 307/308 (method-preserving); a 301/302/303
 * redirect of a JSON-RPC POST is a connection error, never a silent GET.
 */
export async function mcpFetch(
	url: string,
	init: MCPFetchInit,
	sources: MCPHeaderSources,
	originLocked: boolean,
): Promise<Response> {
	if (!originLocked) {
		return fetch(url, { ...init, headers: mergeMCPHeaders(sources) });
	}

	const configuredOrigin = new URL(url).origin;
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
		const attachConfigured = new URL(currentUrl).origin === configuredOrigin;
		const headers = mergeMCPHeaders(attachConfigured ? sources : { generated: sources.generated });
		const response = await fetch(currentUrl, { ...init, headers, redirect: "manual" });
		if (!REDIRECT_STATUSES[response.status]) return response;

		const location = response.headers.get("Location");
		if (!location) return response;
		await response.body?.cancel();
		if (init.method !== "GET" && response.status !== 307 && response.status !== 308) {
			throw new Error(`HTTP ${response.status}: server redirected a ${init.method} request; refusing to follow`);
		}
		currentUrl = new URL(location, currentUrl).href;
	}
	throw new Error(`Too many redirects (> ${MAX_REDIRECT_HOPS}) fetching ${url}`);
}
