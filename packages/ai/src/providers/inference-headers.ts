/** Shared inference request identity headers. */

import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";

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
	// The conversation id and the explicit cache key are independently
	// optional: a Go sibling lane can carry its family affinity with no
	// conversation session in hand (V1 compaction, direct client-options
	// builds), while every other lane still needs the conversation id.
	if (!sessionId && !options.cacheAffinity) return;

	if (sessionId) {
		if (options.protocol === "anthropic") {
			setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
		} else if (options.protocol === "openai" && backend === "openai") {
			setHeader(headers, "session_id", sessionId);
			setHeader(headers, "x-client-request-id", sessionId);
		}
	}

	if (isOpenCode) {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
		// Go's session header doubles as the gateway's cache-affinity handle:
		// opted-in sibling lanes (see resolveOpenCodeGoCacheAffinity) share one
		// task cache key there; every other lane keeps the conversation id.
		const goSession = backend === "opencode-go" ? (options.cacheAffinity ?? sessionId) : sessionId;
		if (goSession) setHeader(headers, "x-opencode-session", goSession);
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
