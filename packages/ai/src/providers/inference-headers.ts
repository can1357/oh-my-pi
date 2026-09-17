/** Shared inference request identity headers. */

import { USER_AGENT, getInstallId } from "@oh-my-pi/pi-utils";

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
 * OpenCode Zen gates its contributor free tier on OpenCode client identity
 * (issue #12306): inference requests must carry `User-Agent: opencode/<ver>`
 * and an `x-opencode-session` shaped `ses_<12 hex><14 alnum>`. OMP's own
 * `omp/*` UA with the install id is rejected with 403 FreeTierError, so for
 * `opencode-zen` we present OpenCode client identity with a per-process
 * minted session id. The head derives from the stable install id (a UUID,
 * so its hex prefix always fits the shape); override via `OMP_ZEN_UA`,
 * `OMP_ZEN_SESSION`, or `OMP_ZEN_SESSION_HEAD`.
 */
const ZEN_CLIENT_IDENTITY_HEAD_FALLBACK = "f516cd5fcffe";
const ZEN_CLIENT_IDENTITY_UA = "opencode/1.18.31";
const ZEN_SESSION_TAIL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function resolveZenUserAgent(): string {
	try {
		const override = process.env.OMP_ZEN_UA;
		if (override?.trim()) return override.trim();
	} catch {}
	return ZEN_CLIENT_IDENTITY_UA;
}

function resolveZenSessionHead(): string {
	try {
		const override = process.env.OMP_ZEN_SESSION_HEAD;
		if (override && /^[0-9a-f]{12}$/.test(override)) return override;
	} catch {}
	try {
		const head = getInstallId().replace(/-/g, "").toLowerCase().slice(0, 12);
		if (/^[0-9a-f]{12}$/.test(head)) return head;
	} catch {}
	return ZEN_CLIENT_IDENTITY_HEAD_FALLBACK;
}

const zenSessionId: string = (() => {
	try {
		const pinned = process.env.OMP_ZEN_SESSION;
		if (pinned?.trim()) return pinned.trim();
	} catch {}
	let tail = "";
	for (let i = 0; i < 14; i++) {
		tail += ZEN_SESSION_TAIL_ALPHABET[Math.floor(Math.random() * ZEN_SESSION_TAIL_ALPHABET.length)];
	}
	return `ses_${resolveZenSessionHead()}${tail}`;
})();

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

	if (options.provider === "opencode-zen") {
		setHeader(headers, "User-Agent", resolveZenUserAgent());
		setHeader(headers, "x-opencode-session", zenSessionId);
		return;
	}

	if (isOpenCode) {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		setHeader(headers, "x-opencode-session", sessionId);
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
