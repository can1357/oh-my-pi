/**
 * Generic OAuth flow for MCP servers.
 *
 * Allows users to authenticate with any OAuth-compatible MCP server
 * by providing authorization URL, token URL, and client credentials.
 */

import type { OAuthCallbackFlowOptions } from "@oh-my-pi/pi-ai/oauth/callback-server";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import type { OAuthCredential } from "../session/auth-storage";
import { buildWellKnownUrls } from "./oauth-discovery";

/** Credential-id prefix for OMP-managed MCP OAuth credentials keyed by profile and server URL. */
const MCP_OAUTH_URL_CREDENTIAL_PREFIX = "mcp_oauth:";

/** Credential-id prefix for profile-scoped MCP OAuth credentials (`mcp_oauth:profile:<profile>:<serverUrl>`). */
const MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX = `${MCP_OAUTH_URL_CREDENTIAL_PREFIX}profile:`;

/**
 * Deterministic credential id for an MCP server URL scoped to an OMP profile.
 *
 * Local profile stores are already separate, but auth-broker storage shares one
 * provider namespace across profiles. Including the profile in the provider key
 * keeps a shared project `mcp.json` definition from making profile B overwrite
 * or read profile A's OAuth row for the same server URL. The URL is used
 * verbatim (query string included) because it can carry tenant selectors such
 * as `?project_ref=`.
 */
export function mcpOAuthCredentialId(serverUrl: string, profile: string | undefined = getActiveProfile()): string {
	return `${MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX}${profile ?? "default"}:${serverUrl}`;
}

/** Whether a credential id was minted by OMP's MCP OAuth flows (either era). */
export function isManagedMCPOAuthCredentialId(credentialId: string | undefined): credentialId is string {
	return (
		!!credentialId &&
		(credentialId.startsWith("mcp_oauth_") || credentialId.startsWith(MCP_OAUTH_URL_CREDENTIAL_PREFIX))
	);
}

/**
 * Profile segment of a profile-scoped `mcp_oauth:profile:<profile>:<serverUrl>`
 * credential id, or `undefined` for legacy non-profile-scoped managed ids
 * (`mcp_oauth:<url>`, `mcp_oauth_<rand>`). The server URL itself contains `:`
 * and `/`, so only the segment between the prefix and the FIRST subsequent `:`
 * is the profile; everything after it is the URL.
 */
export function mcpOAuthCredentialProfile(credentialId: string): string | undefined {
	if (!credentialId.startsWith(MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX)) return undefined;
	const separator = credentialId.indexOf(":", MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX.length);
	return separator === -1 ? undefined : credentialId.slice(MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX.length, separator);
}

/**
 * Server URL embedded in a managed MCP OAuth credential id, or `undefined`
 * for legacy random ids (`mcp_oauth_<rand>`) minted before URL-keyed ids.
 *
 * Inverse of {@link mcpOAuthCredentialId}. Mirrors {@link mcpOAuthCredentialProfile}:
 * the URL contains `:` and `/`, so for profile-scoped ids the URL is everything
 * after the profile segment; for legacy url-keyed ids (`mcp_oauth:<url>`) it is
 * everything after the prefix. Lets the auth-broker — which never sees the MCP
 * config — recover the server URL for the RFC 8707 fallback resource on refresh.
 */
export function mcpOAuthServerUrlFromCredentialId(credentialId: string): string | undefined {
	if (credentialId.startsWith(MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX)) {
		const separator = credentialId.indexOf(":", MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX.length);
		return separator === -1 ? undefined : credentialId.slice(separator + 1) || undefined;
	}
	if (credentialId.startsWith(MCP_OAUTH_URL_CREDENTIAL_PREFIX)) {
		return credentialId.slice(MCP_OAUTH_URL_CREDENTIAL_PREFIX.length) || undefined;
	}
	return undefined;
}

/**
 * Stored MCP OAuth credential. Refresh material is embedded so token refresh
 * works without any `auth` block persisted in (possibly shared) config files.
 */
export interface MCPStoredOAuthCredential extends OAuthCredential {
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
	/**
	 * Authorization-server URL (the issuer the grant was minted against). Used
	 * to filter same-origin resource indicators on refresh: RFC 8414 lets the
	 * authorize and token endpoints sit on different origins, so refresh
	 * cannot infer the original auth-server origin from `tokenUrl` alone.
	 * Unset on legacy credentials minted before issue #3502's fix.
	 */
	authorizationUrl?: string;
}

const DEFAULT_PORT = 3000;
const CALLBACK_PATH = "/callback";

function hasOAuthScope(scopes: string | null | undefined, scope: string): boolean {
	return !!scopes && scopes.split(/\s+/).includes(scope);
}

/**
 * Trim a DCR failure body / thrown error message to a single, short line the
 * caller can splice into an error string. `undefined` when nothing salvageable
 * remains after stripping whitespace.
 */
function truncateDetail(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return undefined;
	return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * Read the response body of a rejected DCR request as a short diagnostic
 * string. Never throws — the caller is already building an error and cannot
 * afford to trade the actual failure for a "read body" one.
 */
async function readRegistrationFailureDetail(response: Response): Promise<string | undefined> {
	try {
		return truncateDetail(await response.text());
	} catch {
		return undefined;
	}
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

function resolveRedirectUri(redirectUri: string | undefined): string | undefined {
	const configured = redirectUri;
	const trimmed = configured?.trim();
	if (!trimmed) return undefined;
	if (trimmed !== configured) {
		throw new Error("OAuth redirect URI must not include surrounding whitespace");
	}

	const parsed = new URL(configured);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OAuth redirect URI must use http or https");
	}
	return configured;
}

function parseRedirectUri(redirectUri: string | undefined): URL | undefined {
	return redirectUri ? new URL(redirectUri) : undefined;
}

function getUriPort(uri: URL): number {
	if (uri.port !== "") return Number(uri.port);
	return uri.protocol === "https:" ? 443 : 80;
}

function validateRedirectConfig(config: MCPOAuthConfig, redirectUri: string | undefined): void {
	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "https:" || !isLoopbackHostname(parsed.hostname)) {
		return;
	}

	if (config.callbackPort === undefined) {
		throw new Error(
			"HTTPS loopback redirect URIs require oauth.callbackPort to point at the local HTTP callback listener behind your TLS terminator",
		);
	}

	if (config.callbackPort === getUriPort(parsed)) {
		throw new Error(
			"HTTPS loopback redirect URIs cannot reuse the same local port; terminate TLS separately and forward to oauth.callbackPort",
		);
	}
}

function resolveCallbackPort(callbackPort: number | undefined, redirectUri: string | undefined): number {
	if (callbackPort !== undefined) return callbackPort;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
		return DEFAULT_PORT;
	}

	const port = getUriPort(parsed);
	return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

function resolveCallbackPath(callbackPath: string | undefined, redirectUri: string | undefined): string {
	const trimmed = callbackPath?.trim();
	if (trimmed) return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;

	const parsed = parseRedirectUri(redirectUri);
	if (parsed?.pathname) return parsed.pathname;
	return CALLBACK_PATH;
}

function resolveCallbackHostname(redirectUri: string | undefined): string | undefined {
	const parsed = parseRedirectUri(redirectUri);
	if (!parsed || !isLoopbackHostname(parsed.hostname)) return undefined;
	return parsed.hostname;
}

/**
 * Resolve the client_id MCPOAuthFlow would use without doing any I/O —
 * either the explicitly configured value or one embedded as a query parameter
 * in the authorization URL. Returns `undefined` when no client_id is known
 * statically, which is the trigger for dynamic client registration in
 * {@link MCPOAuthFlow.#tryRegisterClient}.
 */
function staticClientIdFromConfig(config: MCPOAuthConfig): string | undefined {
	const fromConfig = config.clientId?.trim();
	if (fromConfig) return fromConfig;
	try {
		return new URL(config.authorizationUrl).searchParams.get("client_id")?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function resolveCallbackOptions(config: MCPOAuthConfig): OAuthCallbackFlowOptions {
	const redirectUri = resolveRedirectUri(config.redirectUri);
	validateRedirectConfig(config, redirectUri);
	// When a client_id is already pinned (config-supplied or embedded in the
	// authorization URL), it was registered against a specific redirect URI.
	// Silently advertising a different port at the authorize endpoint would
	// be rejected by providers like Atlassian (HTTP 500 in the browser, local
	// flow hangs until the 5-minute timeout), so fail fast instead.
	//
	// When no client_id is pinned, MCPOAuthFlow will attempt dynamic client
	// registration on demand with whichever loopback URI we actually bound —
	// the provider issues a client_id tied to *that* URI, so the random-port
	// fallback remains safe for first-install DCR flows whose preferred port
	// happens to be occupied.
	const allowPortFallback = staticClientIdFromConfig(config) === undefined;
	return {
		preferredPort: resolveCallbackPort(config.callbackPort, redirectUri),
		callbackPath: resolveCallbackPath(config.callbackPath, redirectUri),
		callbackHostname: resolveCallbackHostname(redirectUri),
		redirectUri,
		allowPortFallback,
	};
}

function resolveResourceUri(resource: string | undefined): string | undefined {
	const trimmed = resource?.trim();
	if (!trimmed) return undefined;
	if (trimmed !== resource) {
		throw new Error("OAuth resource URI must not include surrounding whitespace");
	}

	const parsed = new URL(trimmed);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OAuth resource URI must use http or https");
	}
	if (parsed.hash) {
		throw new Error("OAuth resource URI must not include a fragment");
	}
	return trimmed;
}

interface ResourceIndicatorFilterOptions {
	/** Strip any resource URL on the same origin as the authorization server. */
	stripSameOriginResource?: boolean;
}

/**
 * Drop a redundant fallback resource indicator relative to {@link serverUrl}.
 *
 * Provider-advertised resource indicators are authoritative even when they are
 * origin-only (`https://gateway.example.com`) or path-scoped same-origin
 * (`https://gateway.example.com/my-service/mcp`): servers can use either form
 * as the audience they require for the grant.
 *
 * Plane is stricter for OMP-synthesized fallback resources (e.g. using the
 * configured server URL `https://mcp.plane.so/http/mcp` as `resource`), so
 * fallback callers opt into `stripSameOriginResource`. Provider-advertised
 * `oauth.resource` values and authorization-URL `?resource=` values keep the
 * preserving default.
 */
function filterResourceIndicator(
	resource: string | undefined,
	serverUrl: string,
	options: ResourceIndicatorFilterOptions = {},
): string | undefined {
	if (!resource) return undefined;
	try {
		const origin = new URL(serverUrl).origin;
		const parsedResource = new URL(resource);
		if (parsedResource.origin !== origin) return resource;
		if (options.stripSameOriginResource) return undefined;
	} catch {
		// Malformed serverUrl will fail elsewhere; fall through.
	}
	return resource;
}

export interface MCPOAuthConfig {
	/** Authorization endpoint URL */
	authorizationUrl: string;
	/** Token endpoint URL */
	tokenUrl: string;
	/** Authorization-server issuer URL used for metadata discovery. */
	issuerUrl?: string;
	/** Dynamic client registration endpoint advertised by the authorization server. */
	registrationUrl?: string;
	/** Client ID (optional when already embedded in authorization URL) */
	clientId?: string;
	/** Client secret (optional for PKCE flows) */
	clientSecret?: string;
	/** OAuth scopes (space-separated) */
	scopes?: string;
	/**
	 * `prompt` parameter for the authorization request. By default the parameter
	 * is omitted, matching the reference MCP SDK, except for `offline_access`
	 * requests where OIDC Core requires `prompt=consent` to issue refresh-token
	 * access. Set to `""` to omit the parameter entirely.
	 */
	prompt?: string;
	/** Exact redirect URI to advertise to the provider */
	redirectUri?: string;
	/** Custom callback port (default: 3000) */
	callbackPort?: number;
	/** Custom callback path (default: /callback or redirectUri pathname) */
	callbackPath?: string;
	/** MCP resource URI for RFC 8707 resource indicators */
	resource?: string;
	/**
	 * True when `resource` was synthesized from the server URL fallback rather
	 * than advertised by OAuth/protected-resource metadata. Fallback resources
	 * are stripped when same-origin with the authorization server; advertised
	 * path-scoped resources are preserved.
	 */
	stripSameOriginResource?: boolean;
	/** Fetch implementation for token exchange and discovery requests. */
	fetch?: FetchImpl;
}

/**
 * Generic OAuth flow for MCP servers.
 * Supports standard OAuth 2.0 authorization code flow with PKCE.
 */
export class MCPOAuthFlow extends OAuthCallbackFlow {
	#resolvedClientId?: string;
	#registeredClientSecret?: string;
	#codeVerifier?: string;
	#fetch: FetchImpl;
	#resource?: string;
	/**
	 * Details of a rejected dynamic client-registration attempt. Populated by
	 * {@link #tryRegisterClient} when the provider advertises a registration
	 * endpoint but returns a non-2xx / throws (e.g. Figma's DCR endpoint 403s
	 * every request because only catalog-approved clients may connect). Reused
	 * by {@link #missingClientIdError} to explain why the fallback probe now
	 * requires a manually configured `oauth.clientId`, replacing the opaque
	 * "OAuth provider requires client_id" message.
	 */
	#registrationFailure?: {
		endpoint: string;
		/** HTTP status returned by the endpoint; `0` when the request threw. */
		status: number;
		/** First line of the response body (or thrown error message), trimmed. */
		detail?: string;
	};

	constructor(
		private config: MCPOAuthConfig,
		ctrl: OAuthController,
	) {
		super(ctrl, resolveCallbackOptions(config));
		this.#resolvedClientId = this.#resolveClientId(config);
		this.#fetch = config.fetch ?? ctrl.fetch ?? fetch;
		this.#resource = this.#filterResourceIndicator(
			resolveResourceUri(config.resource ?? this.#resourceFromAuthorizationUrl(config.authorizationUrl)),
		);
	}

	/**
	 * Client id used during the authorization request. Returns the value supplied
	 * via {@link MCPOAuthConfig.clientId} or, when the server required dynamic
	 * client registration, the id issued during registration. `undefined` until
	 * {@link generateAuthUrl} (or {@link login}) has run for a server that needs
	 * a client id.
	 */
	get resolvedClientId(): string | undefined {
		return this.#resolvedClientId;
	}

	/**
	 * Client secret issued by dynamic client registration, if any. Always
	 * `undefined` for PKCE-only/public clients and when the caller supplies the
	 * client id via config.
	 */
	get registeredClientSecret(): string | undefined {
		return this.#registeredClientSecret;
	}
	get resource(): string | undefined {
		return this.#resource;
	}
	/**
	 * Authorization-server URL the flow used. Persist alongside the credential
	 * so refresh can filter same-origin resource indicators against the issuer's
	 * origin even when `tokenUrl` lives on a different origin (RFC 8414 permits
	 * the split).
	 */
	get authorizationUrl(): string {
		return this.config.authorizationUrl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		if (!this.#resolvedClientId) {
			await this.#tryRegisterClient(redirectUri);
			// `unapproved_client` explicitly establishes that registration cannot
			// produce the required client id. Other DCR failures stay on the
			// clientless probe path because they may be transient or caused by
			// unrelated registration metadata.
			if (!this.#resolvedClientId && this.#isDefinitiveRegistrationRejection()) {
				throw this.#missingClientIdError();
			}
		}

		const authUrl = new URL(this.config.authorizationUrl);
		const params = authUrl.searchParams;

		if (!params.get("response_type")) {
			params.set("response_type", "code");
		}
		const existingClientId = params.get("client_id")?.trim();
		if (this.#resolvedClientId) {
			params.set("client_id", this.#resolvedClientId);
		} else if (existingClientId) {
			params.set("client_id", existingClientId);
		} else {
			params.delete("client_id");
		}
		if (this.config.scopes && !params.get("scope")) {
			params.set("scope", this.config.scopes);
		}
		const prompt = this.config.prompt ?? (hasOAuthScope(params.get("scope"), "offline_access") ? "consent" : "");
		if (prompt && !params.get("prompt")) {
			params.set("prompt", prompt);
		}
		const existingResource = params.get("resource")?.trim();
		if (existingResource) {
			// A resource already embedded in the provider's authorization URL is
			// provider-authored, not OMP's server-URL fallback. Preserve same-host
			// values here even when the caller marked its separate
			// `config.resource` as fallback; gateway-hosted MCP servers can use
			// origin-only or path-scoped values as the token audience.
			const filtered = filterResourceIndicator(resolveResourceUri(existingResource), this.config.authorizationUrl);
			if (filtered) {
				this.#resource = filtered;
			} else {
				// Defensive path for future policy additions: when filtering says
				// "omit", drop it from both authorize and token requests.
				params.delete("resource");
				this.#resource = undefined;
			}
		} else if (this.#resource) {
			params.set("resource", this.#resource);
		}
		params.set("redirect_uri", redirectUri);
		params.set("state", state);

		// Add PKCE challenge (some providers require it)
		const codeVerifier = this.#generateCodeVerifier();
		const codeChallenge = await this.#generateCodeChallenge(codeVerifier);
		params.set("code_challenge", codeChallenge);
		params.set("code_challenge_method", "S256");

		// Store code verifier for token exchange
		this.#codeVerifier = codeVerifier;

		if (!params.get("client_id")) {
			await this.#assertClientIdNotRequired(authUrl.toString());
		}

		return { url: authUrl.toString() };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		});
		if (this.#resolvedClientId) {
			params.set("client_id", this.#resolvedClientId);
		}

		// Add code verifier for PKCE
		if (this.#codeVerifier) {
			params.set("code_verifier", this.#codeVerifier);
		}
		this.#codeVerifier = undefined;

		// Add client secret if provided
		if (this.#resource) {
			params.set("resource", this.#resource);
		}
		const clientSecret = this.config.clientSecret ?? this.#registeredClientSecret;
		if (clientSecret) {
			params.set("client_secret", clientSecret);
		}

		const response = await this.#fetch(this.config.tokenUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
			signal: this.ctrl.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			token_type?: string;
			error?: string;
			error_description?: string;
		};

		// Some providers (e.g. the Slack Web API) signal failure with HTTP 200 and
		// an `{ ok: false, error }` body. Accepting such a response would store an
		// empty access token and only surface `invalid_token` on a later request.
		if (typeof data.access_token !== "string" || data.access_token.length === 0) {
			const providerError = data.error_description ?? data.error;
			throw new Error(`Token exchange returned no access token${providerError ? `: ${providerError}` : ""}`);
		}

		// Calculate expiry timestamp
		const expiresIn = data.expires_in ?? 3600; // Default to 1 hour
		const expires = Date.now() + expiresIn * 1000;

		return {
			access: data.access_token,
			refresh: data.refresh_token ?? "",
			expires,
		};
	}

	/**
	 * Generate PKCE code verifier (random string).
	 */
	#generateCodeVerifier(): string {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return this.#base64UrlEncode(bytes);
	}

	/**
	 * Generate PKCE code challenge from verifier.
	 */
	async #generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return this.#base64UrlEncode(new Uint8Array(hash));
	}

	/**
	 * Base64 URL encode (without padding).
	 */
	#base64UrlEncode(bytes: Uint8Array): string {
		const base64 = btoa(String.fromCharCode(...bytes));
		return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	}

	#resolveClientId(config: MCPOAuthConfig): string | undefined {
		return staticClientIdFromConfig(config);
	}
	#resourceFromAuthorizationUrl(authorizationUrl: string): string | undefined {
		try {
			return new URL(authorizationUrl).searchParams.get("resource") ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Drop redundant resource indicators for this authorization server.
	 * Provider-advertised path-scoped values are preserved; fallback server-URL
	 * values opt into same-origin stripping via `stripSameOriginResource`.
	 */
	#filterResourceIndicator(resource: string | undefined): string | undefined {
		return filterResourceIndicator(resource, this.config.authorizationUrl, {
			stripSameOriginResource: this.config.stripSameOriginResource,
		});
	}

	/**
	 * Try OAuth dynamic client registration when provider requires a client_id.
	 *
	 * Records rejection details on {@link #registrationFailure} so that when
	 * DCR is intentionally closed (Figma's `mcp:connect` endpoint returns 403 to
	 * every unlisted client — see https://developers.figma.com/docs/figma-mcp-server/,
	 * "Only clients listed in the Figma MCP Catalog can connect"), the fallback
	 * probe surfaces a message that names the endpoint and status instead of
	 * the historical opaque "OAuth provider requires client_id".
	 *
	 * Includes {@link MCPOAuthConfig.scopes} as RFC 7591 `scope` when set so
	 * providers that bind DCR clients to registered scopes only (e.g. Clerk)
	 * accept the later authorize request for the same scope set.
	 */
	async #tryRegisterClient(redirectUri: string): Promise<void> {
		const registrationEndpoint = this.config.registrationUrl ?? (await this.#resolveRegistrationEndpoint());
		if (!registrationEndpoint) return;

		try {
			const registrationBody: Record<string, unknown> = {
				client_name: "oh-my-pi",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				application_type: "native",
			};
			const scope = this.config.scopes?.trim();
			if (scope) {
				registrationBody.scope = scope;
			}
			const response = await this.#fetch(registrationEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				signal: this.ctrl.signal,
				body: JSON.stringify(registrationBody),
			});

			if (!response.ok) {
				this.#registrationFailure = {
					endpoint: registrationEndpoint,
					status: response.status,
					detail: await readRegistrationFailureDetail(response),
				};
				return;
			}

			const data = (await response.json()) as {
				client_id?: string;
				client_secret?: string;
			};

			const clientId = data.client_id?.trim();
			if (clientId) {
				this.#resolvedClientId = clientId;
			}
			if (data.client_secret && data.client_secret.trim() !== "") {
				this.#registeredClientSecret = data.client_secret;
			}
		} catch (error) {
			// Distinguish real transport/parse failures from a benign no-DCR
			// response so #missingClientIdError can surface what went wrong.
			this.#registrationFailure = {
				endpoint: registrationEndpoint,
				status: 0,
				detail: error instanceof Error ? truncateDetail(error.message) : undefined,
			};
		}
	}

	async #resolveRegistrationEndpoint(): Promise<string | null> {
		const candidates = buildWellKnownUrls(
			"/.well-known/oauth-authorization-server",
			this.config.issuerUrl ?? this.config.authorizationUrl,
			this.config.issuerUrl !== undefined,
		);
		for (const url of candidates) {
			const endpoint = await this.#tryWellKnownForRegistration(url.toString());
			if (endpoint) return endpoint;
		}
		return null;
	}

	async #tryWellKnownForRegistration(wellKnownUrl: string): Promise<string | null> {
		try {
			const response = await this.#fetch(wellKnownUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: this.ctrl.signal,
			});
			if (!response.ok) return null;
			const metadata = (await response.json()) as { registration_endpoint?: string };
			if (metadata.registration_endpoint && metadata.registration_endpoint.trim() !== "") {
				return metadata.registration_endpoint;
			}
		} catch {
			// Ignore fetch/parse failures.
		}
		return null;
	}

	async #assertClientIdNotRequired(authorizationUrl: string): Promise<void> {
		try {
			const response = await this.#fetch(authorizationUrl, {
				method: "GET",
				redirect: "manual",
				headers: { Accept: "text/plain,text/html,application/json" },
				signal: this.ctrl.signal,
			});
			if (response.status < 400) return;
			const body = await response.text();
			if (/client[_-]?id/i.test(body) && /(required|missing|invalid)/i.test(body)) {
				throw this.#missingClientIdError();
			}
		} catch (error) {
			if (error instanceof Error && /client[_-]?id/i.test(error.message)) {
				throw error;
			}
			// Ignore network/probe failures to avoid blocking flows that still work.
		}
	}

	/**
	 * Whether the provider explicitly rejected this client as unapproved.
	 *
	 * HTTP status alone is insufficient: payload errors such as
	 * `invalid_client_metadata` and `invalid_redirect_uri` do not establish that
	 * the authorization endpoint requires a client id. Keep those on the
	 * clientless probe path.
	 */
	#isDefinitiveRegistrationRejection(): boolean {
		const failure = this.#registrationFailure;
		return failure?.status === 403 && /\bunapproved_client\b/i.test(failure.detail ?? "");
	}

	/**
	 * Build the error thrown when the authorize probe confirms the provider
	 * demands a `client_id`. When dynamic client registration was attempted and
	 * rejected (e.g. Figma's 403 for unlisted clients), fold the endpoint + HTTP
	 * status into the message and point the user at the manual `oauth.clientId`
	 * workaround. Refs issue #4307.
	 */
	#missingClientIdError(): Error {
		const failure = this.#registrationFailure;
		const manualHint =
			"Configure `oauth.clientId` (and `oauth.clientSecret` if the flow needs one) on the MCP server entry in mcp.json.";
		if (!failure) {
			return new Error(
				`OAuth provider requires client_id, and no dynamic-client-registration endpoint was advertised. ${manualHint}`,
			);
		}
		const outcome =
			failure.status > 0
				? `HTTP ${failure.status}${failure.detail ? ` — ${failure.detail}` : ""}`
				: failure.detail
					? `network error — ${failure.detail}`
					: "network error";
		return new Error(
			`OAuth provider requires client_id, and dynamic client registration was rejected ` +
				`(POST ${failure.endpoint} → ${outcome}). The server likely restricts registration to pre-approved clients. ${manualHint}`,
		);
	}
}

/**
 * Options for {@link refreshMCPOAuthToken}. Carried via the trailing object
 * so positional callers keep working.
 */
export interface RefreshMCPOAuthTokenOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/**
	 * Authorization-server URL the original grant was minted against. Used to
	 * filter same-origin resource indicators on refresh. Defaults to `tokenUrl`'s
	 * origin when omitted for legacy credentials.
	 */
	authorizationUrl?: string;
	/**
	 * True when the refresh `resource` was synthesized from the server URL
	 * fallback because the credential/auth material carried no resource.
	 * Preserved advertised resources leave this false/undefined.
	 */
	stripSameOriginResource?: boolean;
}

/**
 * Refresh an MCP OAuth token using the standard refresh_token grant.
 * Returns updated credentials; preserves the old refresh token if the server doesn't rotate it.
 */
export async function refreshMCPOAuthToken(
	tokenUrl: string,
	refreshToken: string,
	clientId?: string,
	clientSecret?: string,
	resourceOrOpts?: string | RefreshMCPOAuthTokenOptions,
	opts?: RefreshMCPOAuthTokenOptions,
): Promise<OAuthCredentials> {
	const optsFromTrailing = typeof resourceOrOpts === "string" ? opts : resourceOrOpts;
	const fetchImpl: FetchImpl = optsFromTrailing?.fetch ?? fetch;
	const resource = typeof resourceOrOpts === "string" ? resourceOrOpts : undefined;
	// Filter against the authorization-server origin when known (RFC 8414
	// permits authorize/token endpoints on separate origins). Fall back to
	// `tokenUrl` for legacy credentials minted before the issuer was persisted
	// — same-origin servers (the common case) still match correctly.
	const filterAnchor = optsFromTrailing?.authorizationUrl ?? tokenUrl;
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
	const normalizedClientId = clientId?.trim();
	if (normalizedClientId) params.set("client_id", normalizedClientId);
	// Drop redundant indicators so refresh stays consistent with the initial
	// grant; see {@link filterResourceIndicator} for context.
	const resolvedResource = filterResourceIndicator(resolveResourceUri(resource), filterAnchor, {
		stripSameOriginResource: optsFromTrailing?.stripSameOriginResource,
	});
	if (resolvedResource) params.set("resource", resolvedResource);
	if (clientSecret) params.set("client_secret", clientSecret);

	const response = await fetchImpl(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		signal: optsFromTrailing?.signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`MCP OAuth refresh failed: ${response.status} ${text}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	const expiresIn = data.expires_in ?? 3600;
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}
