/** Shared inference request identity headers. */

import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

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
	const isOpenCode = options.provider === "opencode-go" || options.provider === "opencode-zen";
	const sessionId = options.sessionId;
	if (!sessionId) return;

	if (options.protocol === "anthropic") {
		setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai") {
		setHeader(headers, "session_id", sessionId);
		setHeader(headers, "x-client-request-id", sessionId);
	}

	if (isOpenCode) {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		setHeader(headers, "x-opencode-session", sessionId);
	}
}

/**
 * Apply omp's process-wide inference User-Agent default. Any explicit header,
 * including Anthropic and Codex OAuth fingerprints, remains authoritative.
 */
export function withInferenceUserAgent(fetchImpl: FetchImpl): FetchImpl {
	return (input, init) => {
		const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		const headers = new Headers(sourceHeaders);
		if (headers.has("User-Agent")) return fetchImpl(input, init);
		headers.set("User-Agent", USER_AGENT);
		return fetchImpl(input, { ...init, headers });
	};
}
