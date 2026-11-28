/** Shared inference request identity headers. */

import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { getOpenCodeUserAgent, toOpenCodeSessionToken } from "@oh-my-pi/pi-catalog/wire/opencode";
import { APP_NAME, APP_URL, USER_AGENT } from "@oh-my-pi/pi-utils";
import { usesOpenCodeClientIdentity } from "./opencode-free";

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
	/**
	 * Conversation a side request branches from (`parentSessionId`). OpenCode's
	 * `x-opencode-session` routes by it so the side request lands on the
	 * worker holding the parent's prompt cache; every other session header
	 * keeps {@link sessionId}. {@link cacheAffinity} still wins on Go. The
	 * generic `x-session-id` fallback routes by it too, for the same reason.
	 */
	parentSessionId?: string;
	/**
	 * Model compat. A session header it declares (KDL `session-header` or
	 * `prompt-cache-session-header`) is the host's own affinity header, so the
	 * generic `x-session-id` fallback stays off. An `additive-session-header`
	 * is sent next to the protocol's session headers instead. It also carries
	 * the free Zen client-identity opt-in.
	 */
	compat?: object;
}

/** Session header most gateways and proxies route on (bifrost, llmgateway, agentgateway, …). */
const GENERIC_SESSION_HEADER = "x-session-id";

function additiveSessionHeader(compat: object | undefined): string | undefined {
	if (!compat || !("additiveSessionHeader" in compat)) return undefined;
	return typeof compat.additiveSessionHeader === "string" ? compat.additiveSessionHeader : undefined;
}

function declaresSessionHeader(compat: object | undefined): boolean {
	if (!compat) return false;
	return (
		("sessionHeader" in compat && compat.sessionHeader !== undefined) ||
		("promptCacheSessionHeader" in compat && compat.promptCacheSessionHeader !== undefined)
	);
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
	const clientIdentity = isOpenCode && usesOpenCodeClientIdentity(options.compat);
	const sessionId = options.sessionId;
	// The conversation id and the explicit cache key are independently
	// optional: a Go sibling lane can carry its family affinity with no
	// conversation session in hand (V1 compaction, direct client-options
	// builds), while every other lane still needs the conversation id. A gated
	// free lane always owes the gateway a User-Agent, session or not.
	if (!sessionId && !options.cacheAffinity && !clientIdentity) return;

	if (sessionId) {
		// A host with its own session header gets only that. Every other OpenAI-
		// or Anthropic-protocol host also gets `x-session-id`, which most
		// gateways and proxies route on; a caller-set value wins.
		let hostHeader = isOpenCode || declaresSessionHeader(options.compat);
		if (options.protocol === "anthropic") {
			setHeader(headers, "X-Claude-Code-Session-Id", sessionId);
			// Official Anthropic keeps Claude Code's exact header set.
			hostHeader ||= backend === "anthropic";
		} else if (options.protocol === "openai" && backend === "openai") {
			// codex-rs `build_session_headers` sends hyphenated ids on every auth
			// path, API key included; a root thread's session and thread ids coincide.
			setHeader(headers, OPENAI_HEADERS.SESSION_ID, sessionId);
			setHeader(headers, OPENAI_HEADERS.THREAD_ID, sessionId);
			setHeader(headers, "x-client-request-id", sessionId);
			hostHeader = true;
		} else if (backend === "openai-codex") {
			// The Codex transport sets codex-rs's session headers itself.
			hostHeader = true;
		}
		if (!hostHeader && options.protocol !== "google") {
			setHeaderIfAbsent(headers, GENERIC_SESSION_HEADER, options.parentSessionId ?? sessionId);
		}
		// e.g. Copilot's `/v1/messages` answers `msg_blocked` without `X-Client-Session-Id` (#20678).
		const additive = additiveSessionHeader(options.compat);
		if (additive) setHeaderIfAbsent(headers, additive, sessionId);
	}

	if (isOpenCode) {
		// Free Zen models are gated on the OpenCode client's own identity: a
		// different User-Agent or session shape is refused with a plain 429
		// before the model is reached (see ./opencode-free).
		setHeaderIfAbsent(headers, "User-Agent", clientIdentity ? getOpenCodeUserAgent() : USER_AGENT);
		// Go's session header doubles as the gateway's cache-affinity handle:
		// opted-in sibling lanes (see resolveOpenCodeGoCacheAffinity) share one
		// task cache key there; side requests ride their parent conversation's
		// id; every other lane keeps the conversation id.
		const conversation = options.parentSessionId ?? sessionId;
		const goSession = backend === "opencode-go" ? (options.cacheAffinity ?? conversation) : conversation;
		// A gated lane with no conversation id cannot be cached, so a fresh
		// token per request is the honest answer rather than a missing header.
		if (clientIdentity)
			setHeader(headers, "x-opencode-session", toOpenCodeSessionToken(goSession ?? crypto.randomUUID()));
		else if (goSession) setHeader(headers, "x-opencode-session", goSession);
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
