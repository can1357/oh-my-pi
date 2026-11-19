/** Shared inference request identity headers. */

import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { APP_NAME, APP_URL, prompt, USER_AGENT } from "@oh-my-pi/pi-utils";
import openCodeEnvTemplate from "./opencode-env.md" with { type: "text" };

/** Options controlling provider and protocol inference headers. */
export interface InferenceHeaderOptions {
	/**
	 * Credential-bearing provider id. Wire decisions (protocol session
	 * headers, OpenCode attribution) resolve against the declared backend
	 * instead — see {@link providerType}.
	 */
	provider: string;
	/**
	 * Declared backend identity for a custom provider (`providerType ?? provider`,
	 * the same target the catalog policy cascade resolves). Carried through so
	 * a credential-bearing custom provider declared as an OpenCode backend
	 * gets that backend's wire headers while auth and registry keep using
	 * {@link provider}.
	 */
	providerType?: string;
	protocol: "anthropic" | "google" | "openai";
	sessionId?: string;
	/**
	 * Shared prompt-cache affinity key (see {@link resolveOpenCodeGoCacheAffinity}).
	 * Carried only by `x-opencode-session` on the `opencode-go` backend;
	 * protocol-native session headers and every other backend keep `sessionId`.
	 */
	cacheAffinity?: string;
	/** Whether the model route requires OpenCode client headers and session format. */
	requiresOpenCodeClient?: boolean;
}

/**
 * Shared prompt-cache affinity for the OpenCode Go backend: on lanes opted
 * into KDL `shared-prompt-cache`, related requests (Task siblings, forks,
 * explicit-key callers) warm and hit the gateway's prefix cache under one
 * shared key, so Go's session header carries that key instead of the
 * conversation id.
 *
 * `promptCacheKey` MUST be an explicit, already retention-gated cache key —
 * never the sessionId-derived fallback. The backend identity is
 * `providerType ?? provider`; catalog policy is the only opt-in authority.
 */
export function resolveOpenCodeGoCacheAffinity(
	model: CatalogPolicyInputs,
	promptCacheKey: string | undefined,
): string | undefined {
	if ((model.providerType ?? model.provider) !== "opencode-go") return undefined;
	// An empty key must never replace a known real conversation header.
	if (!promptCacheKey) return undefined;
	return resolveCatalogPolicy(model).sharedPromptCache === true ? promptCacheKey : undefined;
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
 * Label a request with the conversation id under the model's resolved
 * `compat.sessionHeader` (KDL `session-header`). A header the caller or config
 * already set wins; without a conversation id nothing is sent.
 */
export function applySessionHeader(
	headers: Record<string, string> | Headers,
	compat: object | undefined,
	sessionId: string | undefined,
): void {
	const name = compat && "sessionHeader" in compat ? compat.sessionHeader : undefined;
	if (typeof name !== "string" || !sessionId) return;
	if (headers instanceof Headers) {
		if (!headers.has(name)) headers.set(name, sessionId);
		return;
	}
	setHeaderIfAbsent(headers, name, sessionId);
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

export const OPENCODE_USER_AGENT = "opencode/1.19.3";
const OPENCODE_SESSION_ID_REGEX = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function formatOpenCodeSessionId(sessionId?: string): string {
	if (sessionId && OPENCODE_SESSION_ID_REGEX.test(sessionId)) {
		return sessionId;
	}
	const hex = sessionId?.replace(/[^0-9a-fA-F]/g, "").toLowerCase() ?? "";
	let current: bigint;
	const bytes = new Uint8Array(14);
	if (hex.length >= 12) {
		current = BigInt(`0x${hex.slice(0, 12)}`) * 0x1000n + 1n;
		for (let i = 0; i < 14; i++) {
			const idx = 12 + ((i * 2) % (hex.length - 12 || 1));
			bytes[i] = Number.parseInt(hex.slice(idx, idx + 2) || "a5", 16);
		}
	} else if (sessionId) {
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;
		for (let i = 0; i < sessionId.length; i++) {
			const ch = sessionId.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
		current = BigInt(Math.abs(h1)) * 0x1000n + 1n;
		for (let i = 0; i < 14; i++) {
			h1 = Math.imul(h1 ^ (h2 >>> 5), 2246822507);
			h2 = Math.imul(h2 ^ (h1 >>> 3), 3266489909);
			bytes[i] = (h1 ^ (h2 >>> (i % 8))) & 0xff;
		}
	} else {
		const timestamp = Date.now();
		current = BigInt(timestamp) * 0x1000n + 1n;
		crypto.getRandomValues(bytes);
	}
	const value = ~current;
	const time = Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
	return `ses_${time}${Array.from(bytes, byte => BASE62_CHARS[byte % 62]).join("")}`;
}

/** Ensures the system prompt contains the environment working directory block required by OpenCode gateway. */
export function ensureOpenCodeSystemPrompt(prompts: string[], cwd?: string): string[] {
	if (prompts.some(p => p.includes("<env>") && p.includes("Working directory:"))) {
		return prompts;
	}
	const envBlock = prompt.render(openCodeEnvTemplate, { cwd: cwd ?? process.cwd() }).trim();
	if (prompts.length === 0) {
		return [envBlock];
	}
	return [...prompts, envBlock];
}

/**
 * Project omp's identity and authoritative conversation id onto the headers
 * understood by the active inference protocol and host.
 */
export function applyInferenceHeaders(headers: Record<string, string>, options: InferenceHeaderOptions): void {
	// Wire identity: what the endpoint is, not which credential reaches it.
	// A custom provider declaring `providerType` is that backend on the wire
	// while its provider id stays authoritative for auth and the registry.
	const backend = options.providerType ?? options.provider;
	if (backend === "vercel-ai-gateway") {
		// Vercel AI Gateway app attribution; caller/config headers take precedence.
		setHeaderIfAbsent(headers, "http-referer", APP_URL);
		setHeaderIfAbsent(headers, "x-title", APP_NAME);
	}
	const isOpenCode = backend === "opencode-go" || backend === "opencode-zen";
	const sessionId = options.sessionId;
	const requiresClient = isOpenCode && backend === "opencode-zen" && options.requiresOpenCodeClient;
	if (!sessionId && !options.cacheAffinity && !requiresClient) return;

	if (sessionId) {
		if (options.protocol === "anthropic") {
			setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
		} else if (options.protocol === "openai" && backend === "openai") {
			setHeader(headers, "session_id", sessionId);
			setHeader(headers, "x-client-request-id", sessionId);
		}
	}

	if (isOpenCode) {
		if (backend === "opencode-zen" && options.requiresOpenCodeClient) {
			if (!headers["User-Agent"] || !headers["User-Agent"].startsWith("claude-cli/")) {
				setHeaderIfAbsent(headers, "User-Agent", `${OPENCODE_USER_AGENT} (${USER_AGENT})`);
			}
			setHeader(headers, "x-opencode-client", "cli");
			setHeader(headers, "x-opencode-session", formatOpenCodeSessionId(sessionId));
		} else {
			setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
			const goSession = backend === "opencode-go" ? (options.cacheAffinity ?? sessionId) : sessionId;
			if (goSession) setHeader(headers, "x-opencode-session", goSession);
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
