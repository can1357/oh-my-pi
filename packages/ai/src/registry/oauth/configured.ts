import * as oauth from "oauth4webapi";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { decodeJwtPayload, NEVER_EXPIRES } from "../engine/common";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

/** How the client authenticates at the token endpoint (RFC 6749 §2.3, OIDC Core §9). */
export type ConfiguredOAuthTokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

/** Client credentials and extra form values, resolved when a login or refresh starts. */
export interface ConfiguredOAuthClient {
	clientId: string;
	clientSecret?: string;
	authorizationParams?: Record<string, string>;
	tokenParams?: Record<string, string>;
}

export interface ConfiguredOAuthProvider {
	name: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes: string[];
	/**
	 * Resolve client credentials for one login or refresh. Deferred so that
	 * command-backed secrets run at the request boundary and can be cancelled.
	 */
	resolveClient: (signal?: AbortSignal) => Promise<ConfiguredOAuthClient>;
	/** Defaults to `client_secret_post` with a client secret and `none` without one. */
	tokenEndpointAuthMethod?: ConfiguredOAuthTokenEndpointAuthMethod;
	/** OIDC issuer. Defaults to the authorization URL origin when omitted. */
	issuer?: string;
	redirectUri?: string;
	callbackPort?: number;
	callbackPath?: string;
	useIdToken?: boolean;
	pkce?: boolean;
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

function clientAuth(config: ConfiguredOAuthProvider, client: ConfiguredOAuthClient): oauth.ClientAuth {
	if (!client.clientSecret) return oauth.None();
	return config.tokenEndpointAuthMethod === "client_secret_basic"
		? oauth.ClientSecretBasic(client.clientSecret)
		: oauth.ClientSecretPost(client.clientSecret);
}

/** Resolve client values and reject unusable ones before any browser or network step. */
async function resolveClient(
	providerId: string,
	config: ConfiguredOAuthProvider,
	signal?: AbortSignal,
): Promise<ConfiguredOAuthClient> {
	const client = await config.resolveClient(signal);
	let missing: string | undefined;
	if (!client.clientId) missing = "oauth.clientId could not be resolved";
	else if ((config.tokenEndpointAuthMethod ?? "none") !== "none" && !client.clientSecret) {
		missing = `oauth.clientSecret could not be resolved for ${config.tokenEndpointAuthMethod}`;
	}
	if (missing) {
		throw new AIError.OAuthError(`OAuth provider ${providerId}: ${missing}`, {
			kind: "configuration",
			provider: providerId,
		});
	}
	// An explicit `none` never sends a secret, even when one is configured.
	return config.tokenEndpointAuthMethod === "none" ? { ...client, clientSecret: undefined } : client;
}

function requestOptions(fetchImpl: FetchImpl, signal?: AbortSignal) {
	const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
	return {
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		[oauth.customFetch]: fetchImpl,
	};
}

/**
 * Prefer the selected bearer token's JWT `exp` when it is an ID token.
 * Access-token `expires_in` is the fallback for opaque tokens or when no JWT exp exists.
 */
function tokenExpiry(token: string, expiresIn: number | undefined, preferJwtExp: boolean): number {
	const exp = decodeJwtPayload(token)?.exp;
	const jwtExpiry = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
	if (preferJwtExp && jwtExpiry !== undefined) return jwtExpiry;
	if (expiresIn !== undefined) return Date.now() + expiresIn * 1000;
	return jwtExpiry ?? NEVER_EXPIRES;
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
	#client: ConfiguredOAuthClient | undefined;
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
		const client = await resolveClient(this.#providerId, this.#config, this.ctrl.signal);
		this.#client = client;
		const params = new URLSearchParams(client.authorizationParams);
		params.set("client_id", client.clientId);
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
		const client = this.#client ?? (await resolveClient(this.#providerId, this.#config, this.ctrl.signal));
		const server = authorizationServer(this.#config);
		const oauthClient: oauth.Client = { client_id: client.clientId };
		const auth = clientAuth(this.#config, client);
		try {
			const callbackParams = oauth.validateAuthResponse(
				server,
				oauthClient,
				new URLSearchParams({ code, state }),
				state,
			);
			const response = await oauth.authorizationCodeGrantRequest(
				server,
				oauthClient,
				auth,
				callbackParams,
				redirectUri,
				this.#verifier,
				{
					...requestOptions(this.#fetch, this.ctrl.signal),
					additionalParameters: client.tokenParams,
				},
			);
			const tokens = await oauth.processAuthorizationCodeResponse(server, oauthClient, response, {
				requireIdToken: this.#config.useIdToken,
			});
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
			const client = await resolveClient(providerId, config, signal);
			const server = authorizationServer(config);
			const oauthClient: oauth.Client = { client_id: client.clientId };
			const auth = clientAuth(config, client);
			try {
				const response = await oauth.refreshTokenGrantRequest(server, oauthClient, auth, credentials.refresh, {
					...requestOptions(config.fetch ?? fetch, signal),
					additionalParameters: client.tokenParams,
				});
				const tokens = await oauth.processRefreshTokenResponse(server, oauthClient, response);
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
