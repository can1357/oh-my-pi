/** Shared inference request identity headers. */

import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";

/** Options controlling provider and protocol inference headers. */
export interface InferenceHeaderOptions {
	provider: string;
	protocol: "anthropic" | "google" | "openai";
	sessionId?: string;
}

/** Set a header unless the map already contains that field under any casing. */
export function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

/**
 * Project omp's identity and authoritative conversation id onto the headers
 * understood by the active inference protocol and host.
 */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	if (options.provider === "vercel-ai-gateway") {
		// Vercel AI Gateway app attribution; caller/config headers take precedence.
		setHeaderIfAbsent(headers, "http-referer", APP_URL);
		setHeaderIfAbsent(headers, "x-title", APP_NAME);
	}

	const isOpenCode = options.provider === "opencode-go" || options.provider === "opencode-zen";
	const sessionId = options.sessionId;
	if (!sessionId) return;

	if (options.protocol === "anthropic") {
		setHeaderIfAbsent(headers, "X-Claude-Code-Session-Id", sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai") {
		setHeaderIfAbsent(headers, "session_id", sessionId);
		setHeaderIfAbsent(headers, "x-client-request-id", sessionId);
	}

	if (isOpenCode) {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		setHeaderIfAbsent(headers, "x-opencode-session", sessionId);
	}
}

function isHeaderRecord(headers: RequestInit["headers"]): headers is Record<string, string> {
	return headers !== undefined && !(headers instanceof Headers) && !Array.isArray(headers);
}

/**
 * Return `init` with omp's process-wide inference User-Agent default applied.
 * Any explicit header, including Anthropic and Codex OAuth fingerprints,
 * remains authoritative. Called per request by `transportFetch`.
 *
 * Plain-object headers stay plain objects: custom `fetch` implementations
 * (proxies, tests) index `init.headers` by name and must not be handed a
 * `Headers` instance instead.
 */
export function withInferenceUserAgent(
	input: string | URL | Request,
	init: RequestInit | undefined,
): RequestInit | undefined {
	const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
	if (isHeaderRecord(sourceHeaders)) {
		const headers = { ...sourceHeaders };
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		return { ...init, headers };
	}
	const headers = new Headers(sourceHeaders);
	if (headers.has("User-Agent")) return init;
	headers.set("User-Agent", USER_AGENT);
	return { ...init, headers };
}
