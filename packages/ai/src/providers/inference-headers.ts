/** Shared inference request identity headers. */

import { USER_AGENT } from "@oh-my-pi/pi-utils";

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

/** Canonical OpenCode client user-agent. Required for free-tier validation (issue #12306). */
export const OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Canonical OpenCode session identifier format: ses_ + 12 hex + 14 Base62 chars. */
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Format a caller-provided or fallback session id into OpenCode's canonical
 * identifier format (`ses_<hex:12><base62:14>`), deterministic for the same
 * input so conversational turns maintain attribution and prompt-cache affinity.
 */
export function canonicalizeOpenCodeSessionId(sessionId?: string): string {
	if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
		return sessionId.trim();
	}
	const digest = new Bun.CryptoHasher("sha256")
		.update(`opencode\0omp\0${sessionId || "default"}`)
		.digest();
	const timeHex = Buffer.from(digest.subarray(0, 6)).toString("hex");
	let randomPart = "";
	for (let i = 6; i < 20; i++) {
		randomPart += BASE62_CHARS[digest[i] % 62];
	}
	return `ses_${timeHex}${randomPart}`;
}

/**
 * Project omp's identity and authoritative conversation id onto the headers
 * understood by the active inference protocol and host.
 */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	const isOpenCode = options.provider === "opencode-go" || options.provider === "opencode-zen";
	const sessionId = options.sessionId;

	if (isOpenCode) {
		const isClaudeOAuth = headers["User-Agent"]?.startsWith("claude-cli/");
		if (!isClaudeOAuth) {
			setHeader(headers, "User-Agent", OPENCODE_USER_AGENT);
		}
		setHeader(headers, "x-opencode-session", canonicalizeOpenCodeSessionId(sessionId));
		setHeaderIfAbsent(headers, "x-opencode-client", "desktop");
	}

	if (!sessionId) return;

	if (options.protocol === "anthropic") {
		setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
	} else if (options.protocol === "openai" && options.provider === "openai") {
		setHeader(headers, "session_id", sessionId);
		setHeader(headers, "x-client-request-id", sessionId);
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
