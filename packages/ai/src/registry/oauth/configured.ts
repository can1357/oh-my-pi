import * as oauth from "oauth4webapi";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const NEVER_EXPIRES = 8.64e15;

export interface ConfiguredOAuthProvider {
	name: string;
	clientId: string;
	clientSecret?: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes: string[];
	/** OIDC issuer. Defaults to the authorization URL origin when omitted. */
	issuer?: string;
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
	useIdToken?: boolean;
	pkce?: boolean;
	authorizationParams?: Record<string, string>;
	tokenParams?: Record<string, string>;
	fetch?: FetchImpl;
}

function callbackOptions(config: ConfiguredOAuthProvider) {
	if (config.redirectUri) {
		const redirectUri = new URL(config.redirectUri);
		return {
			preferredPort: Number(redirectUri.port),
			callbackHostname: redirectUri.hostname,
			callbackPath: redirectUri.pathname,
			redirectUri: config.redirectUri,
			allowPortFallback: false,
		};
	}
	return {
		preferredPort: config.callbackPort ?? 0,
		callbackHostname: "127.0.0.1",
		callbackPath: config.callbackPath,
		allowPortFallback: (config.callbackPort ?? 0) === 0,
	};
}

function authorizationServer(config: ConfiguredOAuthProvider): oauth.AuthorizationServer {
	return {
		issuer: config.issuer ?? new URL(config.authorizationUrl).origin,
		authorization_endpoint: config.authorizationUrl,
		token_endpoint: config.tokenUrl,
	};
}

function client(config: ConfiguredOAuthProvider): oauth.Client {
	return { client_id: config.clientId };
}

function clientAuth(config: ConfiguredOAuthProvider): oauth.ClientAuth {
	return config.clientSecret ? oauth.ClientSecretPost(config.clientSecret) : oauth.None();
}

function requestOptions(fetchImpl: FetchImpl, signal?: AbortSignal) {
	const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
	return {
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		[oauth.customFetch]: fetchImpl,
	};
}

function jwtExpiryMs(token: string): number | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) return claims.exp * 1000;
	} catch {
		// Opaque bearer tokens may remain valid until revoked.
	}
	return undefined;
}

/**
 * Prefer the selected bearer token's JWT `exp` when present.
 * Access-token `expires_in` is the fallback for opaque tokens or when no JWT exp exists.
 */
function tokenExpiry(token: string, expiresIn: number | undefined, preferJwtExp: boolean): number {
	const jwtExpiry = jwtExpiryMs(token);
	if (preferJwtExp && jwtExpiry !== undefined) return jwtExpiry;
	if (expiresIn !== undefined) return Date.now() + expiresIn * 1000;
	if (jwtExpiry !== undefined) return jwtExpiry;
	return NEVER_EXPIRES;
}

function credentialsFromTokens(
	providerId: string,
	config: ConfiguredOAuthProvider,
	tokens: oauth.TokenEndpointResponse,
	previousRefresh?: string,
): OAuthCredentials {
	const access = config.useIdToken ? tokens.id_token : tokens.access_token;
	if (!access) {
		throw new AIError.OAuthError(`OAuth token response missing ${config.useIdToken ? "id_token" : "access_token"}`, {
			kind: "validation",
			provider: providerId,
		});
	}
	return {
		access,
		refresh: tokens.refresh_token ?? previousRefresh ?? "",
		expires: tokenExpiry(access, tokens.expires_in, Boolean(config.useIdToken)),
	};
}

class ConfiguredOAuthFlow extends OAuthCallbackFlow {
	#verifier: string | typeof oauth.nopkce = oauth.nopkce;
	readonly #providerId: string;
	readonly #config: ConfiguredOAuthProvider;
	readonly #fetch: FetchImpl;

	constructor(providerId: string, config: ConfiguredOAuthProvider, callbacks: OAuthLoginCallbacks) {
		super(callbacks, callbackOptions(config));
		this.#providerId = providerId;
		this.#config = config;
		this.#fetch = callbacks.fetch ?? config.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const params = new URLSearchParams(this.#config.authorizationParams);
		params.set("client_id", this.#config.clientId);
		params.set("redirect_uri", redirectUri);
		params.set("response_type", "code");
		params.set("scope", this.#config.scopes.join(" "));
		params.set("state", state);
		if (this.#config.pkce !== false) {
			this.#verifier = oauth.generateRandomCodeVerifier();
			params.set("code_challenge", await oauth.calculatePKCECodeChallenge(this.#verifier));
			params.set("code_challenge_method", "S256");
		}
		const url = new URL(this.#config.authorizationUrl);
		for (const [key, value] of params) url.searchParams.set(key, value);
		return { url: url.toString(), instructions: `Complete ${this.#config.name} sign-in in your browser.` };
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		try {
			const callbackParams = oauth.validateAuthResponse(
				authorizationServer(this.#config),
				client(this.#config),
				new URLSearchParams({ code, state }),
				state,
			);
			const response = await oauth.authorizationCodeGrantRequest(
				authorizationServer(this.#config),
				client(this.#config),
				clientAuth(this.#config),
				callbackParams,
				redirectUri,
				this.#verifier,
				{
					...requestOptions(this.#fetch, this.ctrl.signal),
					additionalParameters: this.#config.tokenParams,
				},
			);
			const tokens = await oauth.processAuthorizationCodeResponse(
				authorizationServer(this.#config),
				client(this.#config),
				response,
				{ requireIdToken: this.#config.useIdToken },
			);
			return credentialsFromTokens(this.#providerId, this.#config, tokens);
		} catch (cause) {
			if (this.ctrl.signal?.aborted) throw new AIError.LoginCancelledError(String(this.ctrl.signal.reason));
			throw new AIError.OAuthError(`OAuth token exchange failed for ${this.#providerId}`, {
				kind: "token-exchange",
				provider: this.#providerId,
				cause,
			});
		}
	}
}

export function createConfiguredOAuthProvider(
	providerId: string,
	config: ConfiguredOAuthProvider,
): {
	name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
} {
	return {
		name: config.name,
		login: callbacks => new ConfiguredOAuthFlow(providerId, config, callbacks).login(),
		async refreshToken(credentials, signal) {
			if (!credentials.refresh) {
				throw new AIError.OAuthError(`OAuth credential for ${providerId} has no refresh token`, {
					kind: "validation",
					provider: providerId,
				});
			}
			try {
				const response = await oauth.refreshTokenGrantRequest(
					authorizationServer(config),
					client(config),
					clientAuth(config),
					credentials.refresh,
					{
						...requestOptions(config.fetch ?? fetch, signal),
						additionalParameters: config.tokenParams,
					},
				);
				const tokens = await oauth.processRefreshTokenResponse(
					authorizationServer(config),
					client(config),
					response,
				);
				return credentialsFromTokens(providerId, config, tokens, credentials.refresh);
			} catch (cause) {
				if (signal?.aborted) {
					throw new AIError.AbortError("OAuth token refresh aborted by caller");
				}
				throw new AIError.OAuthError(`OAuth token refresh failed for ${providerId}`, {
					kind: "token-refresh",
					provider: providerId,
					cause,
				});
			}
		},
		getApiKey: credentials => credentials.access,
	};
}
