/** Shared inference request identity headers. */

import { isOpenCodeProvider, OPENCODE_USER_AGENT, toOpenCodeSessionToken } from "@oh-my-pi/pi-catalog/wire/opencode";
import { getInstallId, USER_AGENT } from "@oh-my-pi/pi-utils";

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

function setHeader(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() !== normalizedName) continue;
		if (existingName === name && headers[existingName] === value) return;
		delete headers[existingName];
	}
	headers[name] = value;
}

/**
 * Project omp's identity and authoritative conversation id onto the headers
 * understood by the active inference protocol and host.
 */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	const isOpenCode = isOpenCodeProvider(options.provider);

	if (options.protocol === "anthropic") {
		if (options.sessionId) setHeader(headers, "X-Claude-Code-Session-Id", options.sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai" && options.sessionId) {
		setHeader(headers, "session_id", options.sessionId);
		setHeader(headers, "x-client-request-id", options.sessionId);
	}

	if (isOpenCode) {
		// The free-tier gate reads the UA's leading token before anything else;
		// only an explicit caller override (e.g. a Claude OAuth fingerprint) wins.
		setHeaderIfAbsent(headers, "User-Agent", OPENCODE_USER_AGENT);
		if (options.sessionId) {
			setHeader(headers, "x-opencode-session", toOpenCodeSessionToken(options.sessionId));
		} else {
			// Background traffic outside any conversation (usage polls, model
			// discovery) still has to carry the session header shape.
			setHeaderIfAbsent(headers, "x-opencode-session", toOpenCodeSessionToken(getInstallId()));
		}
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
