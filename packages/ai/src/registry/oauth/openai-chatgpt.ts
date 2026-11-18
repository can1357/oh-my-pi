/**
 * OpenAI "Sign in with ChatGPT" token sharing, behind `login "custom"
 * hook="openai-chatgpt"` / `refresh hook="openai-chatgpt-refresh"`
 * (`rules/auth/openai.kdl`).
 *
 * Unlike the Codex login (`openai-codex.ts`, a fixed first-party client for the
 * ChatGPT backend), this flow registers omp as an agent: the first sign-in
 * names the app (`agent_name_hint`) and a per-install host id, and OpenAI
 * issues a user-owned OAuth client whose id comes back on the redirect. That
 * client id is bound to the grant and replayed on every refresh. The resulting
 * bearer calls the regular OpenAI API (`https://api.openai.com/v1`) and bills
 * the ChatGPT subscription instead of an API key.
 */
import type { webcrypto } from "node:crypto";
import { getInstallId, isRecord, USER_AGENT } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { CHATGPT_TOKEN_SHARING_SCOPE } from "../../providers/openai-chatgpt-sharing";
import type { FetchImpl } from "../../types";
import { throwIfCancelled } from "../engine/common";
import type { LoginHook, RefreshHook } from "../hooks/types";
import { type CallbackResult, OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const PROVIDER = "openai";
/** Client id that asks the authorization server to register a new agent client for this sign-in. */
const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
/** Name OpenAI shows on the consent screen and in the account's connected agents. */
const AGENT_NAME = "Oh My Pi";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
/** Audience of the issued token: the OpenAI API the bearer is valid for. */
const RESOURCE = "https://api.openai.com/v1";
const SCOPE_NAMES = ["openid", "profile", "email", "offline_access", "resource.invoke"];
const CALLBACK_PATH = "/auth/callback";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const RSA_VERIFY = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	id_token?: unknown;
	expires_in?: unknown;
	scope?: unknown;
};

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Authorization URL; exported for regression tests. Every sign-in registers a new agent client (`agent_name_hint`). */
export function createOpenAIChatGPTAuthorizationUrl(args: {
	redirectUri: string;
	state: string;
	nonce: string;
	challenge: string;
	hostId: string;
}): string {
	return `${AUTHORIZE_URL}?${new URLSearchParams({
		client_id: REGISTRATION_CLIENT_ID,
		agent_name_hint: AGENT_NAME,
		ext_agent_host_id: args.hostId,
		response_type: "code",
		redirect_uri: args.redirectUri,
		// Joined at call time, not module load: the hook table imports this module while the sharing module may still be
		// evaluating (sharing -> registry engine -> hooks -> here), so its scope constant is not readable yet.
		scope: [...SCOPE_NAMES, CHATGPT_TOKEN_SHARING_SCOPE].join(" "),
		resource: RESOURCE,
		state: args.state,
		nonce: args.nonce,
		code_challenge_method: "S256",
		code_challenge: args.challenge,
	}).toString()}`;
}

async function requestTokens(
	params: Record<string, string>,
	kind: "token-exchange" | "token-refresh",
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<TokenResponse> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
			body: new URLSearchParams(params).toString(),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (cause) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
		}
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new AIError.OAuthError(
			timeout.aborted ? `Timed out waiting for ${TOKEN_URL}` : `ChatGPT request to ${TOKEN_URL} failed: ${message}`,
			{ kind: timeout.aborted ? "timeout" : kind, provider: PROVIDER, cause },
		);
	}
	const text = await response.text();
	if (!response.ok) {
		throw new AIError.OAuthError(
			`ChatGPT ${kind === "token-refresh" ? "token refresh" : "token exchange"} failed: ${response.status} ${text.slice(0, 500)}`,
			{ kind, provider: PROVIDER, status: response.status },
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (!isRecord(body)) {
		throw new AIError.OAuthError("ChatGPT token response was not a JSON object", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return body;
}

function decodeSegment(segment: string): unknown {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Verifies the ID token the way a relying party must: RS256 signature against
 * the issuer's JWKS, issuer, audience (this client), expiry, and the nonce of
 * this sign-in attempt. Returns the verified claims.
 */
export async function verifyOpenAIChatGPTIdToken(
	token: string,
	clientId: string,
	nonce: string,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
	jwksUrl: string = JWKS_URL,
): Promise<Record<string, unknown>> {
	const invalid = (reason: string, cause?: unknown) =>
		new AIError.OAuthError(`ChatGPT sign-in returned an invalid ID token: ${reason}`, {
			kind: "validation",
			provider: PROVIDER,
			cause,
		});
	const parts = token.split(".");
	if (parts.length !== 3) throw invalid("not a JWT");
	const [headerSegment, payloadSegment, signatureSegment] = parts;
	let header: unknown;
	let payload: unknown;
	try {
		header = decodeSegment(headerSegment);
		payload = decodeSegment(payloadSegment);
	} catch (cause) {
		throw invalid("malformed segment", cause);
	}
	if (!isRecord(header) || !isRecord(payload)) throw invalid("malformed segment");
	if (header.alg !== "RS256") throw invalid("unsupported signing algorithm");

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let jwks: unknown;
	try {
		const response = await fetchImpl(jwksUrl, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		if (!response.ok) throw new Error(`JWKS request failed: ${response.status}`);
		jwks = await response.json();
	} catch (cause) {
		throw invalid("signing keys are unavailable", cause);
	}
	const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys : [];
	const jwk = keys.find(key => isRecord(key) && key.kty === "RSA" && key.kid === header.kid);
	if (!jwk) throw invalid("signing key not found");
	let verified: boolean;
	try {
		const key = await crypto.subtle.importKey("jwk", jwk as webcrypto.JsonWebKey, RSA_VERIFY, false, ["verify"]);
		verified = await crypto.subtle.verify(
			RSA_VERIFY,
			key,
			Buffer.from(signatureSegment, "base64url"),
			Buffer.from(`${headerSegment}.${payloadSegment}`),
		);
	} catch (cause) {
		throw invalid("signature check failed", cause);
	}
	if (!verified) throw invalid("signature mismatch");

	if (payload.iss !== ISSUER) throw invalid("unexpected issuer");
	const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!audience.includes(clientId)) throw invalid("unexpected audience");
	if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) throw invalid("expired");
	if (!stringField(payload.sub)) throw invalid("subject is missing");
	if (payload.nonce !== nonce) throw invalid("nonce does not match this sign-in attempt");
	return payload;
}

class OpenAIChatGPTFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;
	#verifier = "";
	#nonce = "";

	constructor(ctrl: OAuthController) {
		// The agent client is registered per sign-in, so any loopback port is a valid redirect.
		super(ctrl, { preferredPort: 0, callbackPath: CALLBACK_PATH, callbackHostname: "127.0.0.1" });
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		return {
			url: createOpenAIChatGPTAuthorizationUrl({
				redirectUri,
				state,
				nonce: this.#nonce,
				challenge: pkce.challenge,
				// One host id per omp install, so repeated sign-ins resolve to the same registered host.
				hostId: `urn:uuid:${getInstallId()}`,
			}),
			instructions:
				"Complete login in your browser and allow token sharing. If the browser cannot reach this machine, paste the final redirect URL when prompted.",
		};
	}

	async exchangeToken(
		code: string,
		_state: string,
		redirectUri: string,
		callback?: CallbackResult,
	): Promise<OAuthCredentials> {
		const signal = this.ctrl.signal;
		const clientId = callback?.clientId;
		if (!clientId) {
			throw new AIError.OAuthError(
				"ChatGPT sign-in did not return a client ID. Paste the full redirect URL, or log in again.",
				{ kind: "validation", provider: PROVIDER },
			);
		}
		throwIfCancelled(signal);
		const tokens = await requestTokens(
			{
				grant_type: "authorization_code",
				client_id: clientId,
				code,
				code_verifier: this.#verifier,
				redirect_uri: redirectUri,
				resource: RESOURCE,
			},
			"token-exchange",
			this.#fetch,
			signal,
		);
		const access = stringField(tokens.access_token);
		const refresh = stringField(tokens.refresh_token);
		if (!access || !refresh) {
			throw new AIError.OAuthError("ChatGPT token response missing required fields", {
				kind: "validation",
				provider: PROVIDER,
			});
		}
		const scopes = typeof tokens.scope === "string" ? tokens.scope.split(" ") : [];
		if (!scopes.includes(CHATGPT_TOKEN_SHARING_SCOPE)) {
			throw new AIError.OAuthError(
				"ChatGPT sign-in finished without token sharing. Log in again and allow token sharing, or use an OpenAI API key.",
				{ kind: "entitlement", provider: PROVIDER },
			);
		}
		const idToken = stringField(tokens.id_token);
		if (!idToken) {
			throw new AIError.OAuthError("ChatGPT sign-in did not return an ID token", {
				kind: "validation",
				provider: PROVIDER,
			});
		}
		const claims = await verifyOpenAIChatGPTIdToken(idToken, clientId, this.#nonce, this.#fetch, signal);
		throwIfCancelled(signal);
		// Identity comes from the verified ID-token claims only: the access token's payload is not signature-checked.
		const authClaim = claims["https://api.openai.com/auth"];
		const workspaceId = isRecord(authClaim) ? stringField(authClaim.chatgpt_account_id) : undefined;
		const profileClaim = claims["https://api.openai.com/profile"];
		// `sub` is verified non-empty, so every login has a stable identity even without a workspace claim.
		const accountId = workspaceId ?? stringField(claims.sub);
		const email = (
			stringField(claims.email) ?? (isRecord(profileClaim) ? stringField(profileClaim.email) : undefined)
		)
			?.trim()
			.toLowerCase();
		return {
			access,
			refresh,
			expires:
				Date.now() + (typeof tokens.expires_in === "number" ? tokens.expires_in : DEFAULT_TOKEN_LIFETIME_S) * 1000,
			oauthClientId: clientId,
			accountId,
			...(email ? { email } : {}),
		};
	}
}

/** `login "custom" hook="openai-chatgpt"`. */
export const loginOpenAIChatGPTHook: LoginHook = ctrl => new OpenAIChatGPTFlow(ctrl).login();

/** `refresh hook="openai-chatgpt-refresh"`: replays the client id registered at login. */
export const refreshOpenAIChatGPTHook: RefreshHook = async (credentials, signal) => {
	const clientId = credentials.oauthClientId;
	if (!clientId) {
		throw new AIError.OAuthError("This ChatGPT sign-in has no registered client ID. Log in again.", {
			kind: "token-refresh",
			provider: PROVIDER,
			definitive: true,
		});
	}
	const tokens = await requestTokens(
		{ grant_type: "refresh_token", client_id: clientId, refresh_token: credentials.refresh, resource: RESOURCE },
		"token-refresh",
		fetch,
		signal,
	);
	const access = stringField(tokens.access_token);
	if (!access) {
		throw new AIError.OAuthError("ChatGPT token response missing access_token", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		...credentials,
		access,
		// Unrotated refresh tokens stay valid.
		refresh: stringField(tokens.refresh_token) ?? credentials.refresh,
		expires:
			Date.now() + (typeof tokens.expires_in === "number" ? tokens.expires_in : DEFAULT_TOKEN_LIFETIME_S) * 1000,
	};
};
