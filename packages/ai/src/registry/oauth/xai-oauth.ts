// Ported from NousResearch/hermes-agent (MIT) — hermes_cli/auth.py xAI sections (L93-111, L2979-3160, L5286-5469).

/**
 * xAI Grok (SuperGrok Subscription) OAuth flow.
 *
 * Loopback PKCE flow on `127.0.0.1:56121/callback`. One token unlocks Grok-4.x
 * chat, Grok Imagine image generation, and Grok Voice TTS via subsequent
 * commits. Endpoint discovery is hardened against MITM via
 * {@link validateXAIEndpoint}: any non-HTTPS or non-`x.ai`/`*.x.ai` host is
 * rejected on every call site, not just the first.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

// Hermes hermes_cli/auth.py L93-111
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_DOCS_URL = "https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth";

// Mirrors the 5-min skew used by anthropic.ts:160 — keeps every provider on the
// same conservative client-side expiry window.
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

interface XAIOAuthDiscovery {
	authorization_endpoint: string;
	token_endpoint: string;
}

/**
 * Validate an xAI OIDC discovery endpoint against scheme + host.
 *
 * Hermes `_xai_validate_oauth_endpoint` L2997-3035. The discovery response is
 * long-lived and cached in {@link OAuthCredentials}; a single MITM during
 * initial login could substitute a malicious `token_endpoint` that would then
 * receive every future refresh_token. Rejecting non-HTTPS or non-`x.ai` /
 * `*.x.ai` hosts pins the cached endpoint to the xAI auth origin.
 *
 * @throws Error with message `Invalid xAI <field>: <url>` when the URL fails
 *         either scheme or host validation.
 */
export function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	if (parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new AIError.OAuthError(`Invalid xAI ${field}: ${url}`, { kind: "validation", provider: "xai" });
	}
	return url;
}

/**
 * Fetch xAI's OIDC discovery document and validate both endpoints.
 *
 * Hermes `_xai_oauth_discovery` L3038-3084.
 */
async function xaiOAuthDiscovery(
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
	fetchOverride?: FetchImpl,
): Promise<XAIOAuthDiscovery> {
	const fetchImpl = fetchOverride ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(XAI_OAUTH_DISCOVERY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				kind: "discovery",
				provider: "xai",
				cause: error,
			},
		);
	}
	if (response.status !== 200) {
		throw new AIError.OAuthError(`xAI OIDC discovery returned status ${response.status}.`, {
			kind: "discovery",
			provider: "xai",
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "xai", cause: error },
		);
	}
	if (!payload || typeof payload !== "object") {
		throw new AIError.OAuthError("xAI OIDC discovery response was not a JSON object.", {
			kind: "validation",
			provider: "xai",
		});
	}
	const obj = payload as Record<string, unknown>;
	const authorizationEndpoint =
		typeof obj.authorization_endpoint === "string" ? obj.authorization_endpoint.trim() : "";
	const tokenEndpoint = typeof obj.token_endpoint === "string" ? obj.token_endpoint.trim() : "";
	if (!authorizationEndpoint || !tokenEndpoint) {
		throw new AIError.OAuthError("xAI OIDC discovery response was missing required endpoints.", {
			kind: "validation",
			provider: "xai",
		});
	}
	validateXAIEndpoint(authorizationEndpoint, "authorization_endpoint");
	validateXAIEndpoint(tokenEndpoint, "token_endpoint");
	return {
		authorization_endpoint: authorizationEndpoint,
		token_endpoint: tokenEndpoint,
	};
}

/**
 * Check whether a JWT access token is at or past its `exp` claim (with an
 * optional refresh-skew margin).
 *
 * Hermes `_xai_access_token_is_expiring` L2979-2994. Returns `false` for any
 * malformed input — this is a refresh-trigger check, not a validation, so
 * non-JWTs ("no token in cache") must NOT trigger a spurious refresh.
 */
export function isXAIAccessTokenExpiring(jwt: string, skewSeconds: number = 0): boolean {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return false;
		const parts = jwt.split(".");
		if (parts.length < 2) return false;
		const payloadPart = parts[1];
		if (!payloadPart) return false;
		const decoded = Buffer.from(payloadPart, "base64url").toString("utf8");
		const payload = JSON.parse(decoded) as { exp?: unknown };
		const exp = payload.exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
		const now = Math.floor(Date.now() / 1000);
		const skew = Math.max(0, Math.floor(skewSeconds));
		return exp <= now + skew;
	} catch {
		return false;
	}
}

interface BuildXAIAuthorizeUrlOptions {
	authorizationEndpoint: string;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	nonce: string;
}

/**
 * Build the xAI authorization URL.
 *
 * Hermes `_xai_oauth_build_authorize_url` L5286-5312. `plan=generic` opts the
 * consent screen into xAI's generic OAuth plan tier; without it,
 * `accounts.x.ai` rejects loopback OAuth from non-allowlisted clients.
 * `referrer=oh-my-pi` lets xAI attribute oh-my-pi-originated logins in their
 * OAuth server logs (Hermes uses `referrer=hermes-agent`; oh-my-pi mirrors the
 * pattern with its own attribution string).
 */
function buildXAIAuthorizeUrl(opts: BuildXAIAuthorizeUrlOptions): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: XAI_OAUTH_CLIENT_ID,
		redirect_uri: opts.redirectUri,
		scope: XAI_OAUTH_SCOPE,
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
		state: opts.state,
		nonce: opts.nonce,
		plan: "generic",
		referrer: "oh-my-pi",
	});
	return `${opts.authorizationEndpoint}?${params.toString()}`;
}

/**
 * xAI Grok OAuth loopback flow (Hermes `_xai_oauth_loopback_login` L5315-5469).
 *
 * Uses a fixed redirect URI so the callback server fails fast instead of
 * falling back to a random port that xAI's redirect_uri allowlist rejects.
 */
export class XAIOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, {
			preferredPort: XAI_OAUTH_REDIRECT_PORT,
			callbackPath: XAI_OAUTH_REDIRECT_PATH,
			callbackHostname: XAI_OAUTH_REDIRECT_HOST,
			redirectUri: `http://${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`,
		} satisfies OAuthCallbackFlowOptions);
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		const nonce = crypto.randomUUID().replace(/-/g, "");

		const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, this.#fetch);
		const url = buildXAIAuthorizeUrl({
			authorizationEndpoint: discovery.authorization_endpoint,
			redirectUri,
			codeChallenge: pkce.challenge,
			state,
			nonce,
		});

		return {
			url,
			instructions: `Complete login in your browser for xAI Grok (SuperGrok). Docs: ${XAI_OAUTH_DOCS_URL}`,
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, this.#fetch);
		const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

		const body = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: XAI_OAUTH_CLIENT_ID,
			code,
			redirect_uri: redirectUri,
			code_verifier: this.#verifier,
		});

		const response = await this.#fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body,
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			let detail = "";
			try {
				detail = (await response.text()).trim();
			} catch {
				// Ignore body-read failures; the status code is the diagnostic.
			}
			throw new AIError.OAuthError(`xAI token exchange failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
				kind: "token-exchange",
				provider: "xai",
				status: response.status,
			});
		}

		let tokenData: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
		try {
			tokenData = (await response.json()) as typeof tokenData;
		} catch (error) {
			throw new AIError.OAuthError(
				`xAI token exchange returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ kind: "validation", provider: "xai", cause: error },
			);
		}

		if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
			throw new AIError.OAuthError("xAI token exchange response missing access_token", {
				kind: "validation",
				provider: "xai",
			});
		}
		if (typeof tokenData.refresh_token !== "string" || !tokenData.refresh_token) {
			throw new AIError.OAuthError("xAI token exchange response missing refresh_token", {
				kind: "validation",
				provider: "xai",
			});
		}
		if (typeof tokenData.expires_in !== "number" || !Number.isFinite(tokenData.expires_in)) {
			throw new AIError.OAuthError("xAI token exchange response missing expires_in", {
				kind: "validation",
				provider: "xai",
			});
		}

		return {
			access: tokenData.access_token,
			refresh: tokenData.refresh_token,
			expires: Date.now() + tokenData.expires_in * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
		};
	}
}

/**
 * Login with xAI Grok OAuth (SuperGrok Subscription).
 */
export async function loginXAIOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	return new XAIOAuthFlow(ctrl).login();
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 *
 * Hermes `refresh_xai_oauth_pure` L3087-3160. Re-runs OIDC discovery and
 * re-validates the cached `token_endpoint` on the refresh hot path so a
 * cached-but-poisoned endpoint cannot silently leak a refresh_token.
 */
export async function refreshXAIOAuthToken(refreshToken: string, fetchOverride?: FetchImpl): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	if (typeof refreshToken !== "string" || !refreshToken.trim()) {
		throw new AIError.OAuthError("missing refresh_token", { kind: "validation", provider: "xai" });
	}

	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS, fetchImpl);
	const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});

	const response = await fetchImpl(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures; the status code is the diagnostic.
		}
		throw new AIError.OAuthError(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: "xai",
			status: response.status,
		});
	}

	let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	try {
		data = (await response.json()) as typeof data;
	} catch (error) {
		throw new AIError.OAuthError(
			`xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "xai", cause: error },
		);
	}

	if (typeof data.access_token !== "string" || !data.access_token) {
		throw new AIError.OAuthError("xAI token refresh response missing access_token", {
			kind: "validation",
			provider: "xai",
		});
	}
	if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) {
		throw new AIError.OAuthError("xAI token refresh response missing expires_in", {
			kind: "validation",
			provider: "xai",
		});
	}

	const newRefresh = typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : refreshToken;

	return {
		access: data.access_token,
		refresh: newRefresh,
		expires: Date.now() + data.expires_in * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}
