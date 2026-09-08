/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend
 */

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Pinned OpenAI Codex client version (corresponds to @openai/codex package version).
 *
 * The backend version-gates model availability against this value on both
 * `/models?client_version=` and `/responses` (`gpt-6-astra` requires ≥ 0.153.0);
 * an older pin silently hides newer SKUs from discovery.
 */
export const CODEX_CLIENT_VERSION = "0.153.0";

export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	/** Codex feature-negotiation header; values identify opt-in wire protocols. */
	CODEX_BETA_FEATURES: "x-codex-beta-features",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	VERSION: "version",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
	SCOPED_SESSION_ID: "session-id",
	THREAD_ID: "thread-id",
	INSTALLATION_ID: "x-codex-installation-id",
	WINDOW_ID: "x-codex-window-id",
	TURN_METADATA: "x-codex-turn-metadata",
	PARENT_THREAD_ID: "x-codex-parent-thread-id",
	SUBAGENT: "x-openai-subagent",
	/** Responses Lite transport marker (codex-rs `add_responses_lite_header`); value is always `"true"`. */
	RESPONSES_LITE: "x-openai-internal-codex-responses-lite",
	/** DeviceCheck attestation envelope (codex-rs `X_OAI_ATTESTATION_HEADER`); sent on ChatGPT-OAuth requests. */
	ATTESTATION: "x-oai-attestation",
	/** Client-declared data residency for region-pinned enterprise workspaces. */
	RESIDENCY: "x-openai-internal-codex-residency",
	/**
	 * Model routing hint (codex-rs `X_CODEX_ROUTING_HINT_HEADER`): `model=<slug>`
	 * or `model=<slug>;tier=<service_tier>`; sent on every ChatGPT-OAuth
	 * Responses, compaction, and WebSocket handshake request. Built by
	 * {@link codexRoutingHint}.
	 */
	ROUTING_HINT: "x-codex-routing-hint",
} as const;

export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	BETA_RESPONSES_WEBSOCKETS_V2: "responses_websockets=2026-02-06",
	REMOTE_COMPACTION_V2: "remote_compaction_v2",
	ORIGINATOR_CODEX: "omp",
} as const;

export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/**
 * Build the `x-codex-routing-hint` value for a request (codex-rs
 * `build_routing_hint_header`): the requested model slug plus the explicit
 * service tier when one is set. Callers set it only on ChatGPT-OAuth requests
 * to the Codex backend; API-key OpenAI traffic never carries it.
 */
export function codexRoutingHint(model: string, serviceTier: string | null | undefined): string {
	return serviceTier ? `model=${model};tier=${serviceTier}` : `model=${model}`;
}

/**
 * Extract account ID from a Codex JWT access token.
 * Returns undefined if the token is not a valid Codex JWT.
 */
export function getCodexAccountId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
		return auth?.chatgpt_account_id ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract the account's data residency from a Codex JWT access token.
 *
 * Enterprise ChatGPT workspaces can be pinned to a region. Such a workspace
 * rejects a Codex request whose egress does not match it — HTTP 401
 * `Workspace is not authorized in this region.` — unless the client declares
 * the residency itself. The token already carries it, so no configuration is
 * needed: `chatgpt_data_residency` is the authoritative claim, with
 * `chatgpt_compute_residency` as the fallback for tokens that only carry that.
 *
 * Returns undefined for a non-JWT token, or for the (common) accounts whose
 * claims omit residency entirely — those workspaces are not region-pinned.
 */
export function getCodexResidency(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return undefined;
		const decoded = Buffer.from(parts[1] ?? "", "base64").toString("utf-8");
		const payload = JSON.parse(decoded) as Record<string, unknown>;
		const auth = payload[JWT_CLAIM_PATH] as
			| { chatgpt_data_residency?: unknown; chatgpt_compute_residency?: unknown }
			| undefined;
		for (const claim of [auth?.chatgpt_data_residency, auth?.chatgpt_compute_residency]) {
			if (typeof claim !== "string") continue;
			const residency = claim.trim();
			if (residency.length > 0) return residency;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Adds the token's workspace residency to Codex request headers without
 * replacing a caller-supplied value.
 */
export function applyCodexResidencyHeader(headers: Headers | Record<string, string>, accessToken: string): void {
	const headerName = OPENAI_HEADERS.RESIDENCY;
	if (headers instanceof Headers) {
		if (headers.has(headerName)) return;
		const residency = getCodexResidency(accessToken);
		if (residency) headers.set(headerName, residency);
		return;
	}
	for (const configuredName in headers) {
		if (configuredName.toLowerCase() === headerName) return;
	}
	const residency = getCodexResidency(accessToken);
	if (residency) headers[headerName] = residency;
}
