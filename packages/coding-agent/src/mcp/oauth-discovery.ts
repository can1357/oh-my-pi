/**
 * MCP OAuth Auto-Discovery
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 */
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { withTimeoutSignal } from "../utils/fetch-timeout";

/** Per-request abort deadline for each OAuth discovery metadata fetch. */
const DISCOVERY_FETCH_TIMEOUT_MS = 10_000;

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	/** Authorization-server issuer URL used for metadata discovery. */
	issuerUrl?: string;
	clientId?: string;
	/** Dynamic client registration endpoint advertised by the authorization server. */
	registrationUrl?: string;
	scopes?: string;
	resource?: string;
}

function readRegistrationUrl(metadata: Record<string, unknown>): string | undefined {
	const value =
		metadata.registration_endpoint ??
		metadata.registrationEndpoint ??
		metadata.registration_url ??
		metadata.registrationUrl ??
		metadata.registration_uri ??
		metadata.registrationUri;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readIssuerUrl(metadata: Record<string, unknown>): string | undefined {
	const value = metadata.issuer ?? metadata.issuer_url ?? metadata.issuerUrl;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	/**
	 * OAuth scopes advertised by the challenge (RFC 6750 `scope=` on
	 * `WWW-Authenticate`) or by protected-resource metadata. Passed through
	 * `discoverOAuthEndpoints` as `protectedScopes` so the eventual
	 * authorization request carries them even when the auth-server metadata
	 * document itself omits `scopes_supported`.
	 */
	scopes?: string;
	message?: string;
}

export function extractMcpAuthServerUrl(error: Error, serverUrl?: string): string | undefined {
	const match = error.message.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	if (!match?.[1]) return undefined;

	try {
		return new URL(match[1], serverUrl).toString();
	} catch {
		return undefined;
	}
}

/**
 * Pull the `scope`/`scopes` parameter out of a `WWW-Authenticate` challenge
 * embedded in the error message. RFC 6750 lets servers advertise the missing
 * scopes when they reject a bearer token with `insufficient_scope`, and RFC
 * 8414-adjacent MCP gateways sometimes list the required scopes there rather
 * than in `scopes_supported`. Returns the raw space-separated value, or
 * `undefined` when the challenge does not carry one.
 */
export function extractOAuthChallengeScopes(error: Error): string | undefined {
	const entries = error.message.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g);
	for (const [, rawKey, value] of entries) {
		const key = rawKey.toLowerCase();
		if ((key === "scope" || key === "scopes") && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
}

/**
 * Extract OAuth endpoints from error response.
 * Looks for WWW-Authenticate header format or JSON error bodies.
 */
export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const scopeFromArray = Array.isArray(obj.scopes_supported)
			? (obj.scopes_supported as unknown[]).filter(v => typeof v === "string").join(" ")
			: undefined;
		const scopes = (obj.scopes as string | undefined) || (obj.scope as string | undefined) || scopeFromArray;
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		const resource =
			(obj.resource as string | undefined) ||
			(obj.resource_uri as string | undefined) ||
			(obj.resourceUri as string | undefined);

		return {
			authorizationUrl,
			tokenUrl,
			issuerUrl: readIssuerUrl(obj),
			registrationUrl: readRegistrationUrl(obj),
			clientId,
			scopes,
			resource,
		};
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			return undefined;
		}
	};

	const scopeFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
		} catch {
			return undefined;
		}
	};

	try {
		// Try to parse as JSON error response
		// Many MCP servers return JSON with OAuth endpoints in error body
		const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

			// Check for OAuth endpoints in error body
			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes: endpoints.scopes || scopeFromAuthUrl(endpoints.authorizationUrl),
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
					scopes: topLevelEndpoints.scopes || scopeFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {
		// Not JSON, continue with other detection methods
	}

	const challengeEntries = Array.from(errorMsg.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
	if (challengeEntries.length > 0) {
		const challengeValues = new Map<string, string>();
		for (const [, rawKey, value] of challengeEntries) {
			challengeValues.set(rawKey.toLowerCase(), value);
		}

		const authorizationUrl =
			challengeValues.get("authorization_uri") ||
			challengeValues.get("authorization_url") ||
			challengeValues.get("authorization_endpoint") ||
			challengeValues.get("authorize_url") ||
			challengeValues.get("realm");
		const tokenUrl =
			challengeValues.get("token_url") || challengeValues.get("token_uri") || challengeValues.get("token_endpoint");
		const resource = challengeValues.get("resource") || challengeValues.get("resource_uri");

		if (authorizationUrl && tokenUrl) {
			return {
				authorizationUrl,
				tokenUrl,
				issuerUrl: challengeValues.get("issuer") || challengeValues.get("issuer_url"),
				registrationUrl:
					challengeValues.get("registration_endpoint") ||
					challengeValues.get("registration_url") ||
					challengeValues.get("registration_uri"),
				clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
				scopes: challengeValues.get("scope") || challengeValues.get("scopes") || scopeFromAuthUrl(authorizationUrl),
				resource,
			};
		}
	}

	// Try to extract from WWW-Authenticate header format
	// Example: Bearer realm="https://auth.example.com/oauth/authorize" token_url="https://auth.example.com/oauth/token"
	const wwwAuthMatch = errorMsg.match(/realm="([^"]+)".*token_url="([^"]+)"/);
	if (wwwAuthMatch) {
		return {
			authorizationUrl: wwwAuthMatch[1],
			tokenUrl: wwwAuthMatch[2],
			clientId: clientIdFromAuthUrl(wwwAuthMatch[1]),
			scopes: scopeFromAuthUrl(wwwAuthMatch[1]),
		};
	}

	return null;
}

/**
 * Analyze an error to determine authentication requirements.
 * Returns structured info about what auth is needed.
 */
export function analyzeAuthError(error: Error, serverUrl?: string): AuthDetectionResult {
	// No auth required unless the error carries an HTTP auth status / auth-failure phrasing.
	if (!AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error, serverUrl);
	// Extract resource_metadata URL from challenge entries in error message
	const resourceMetaMatch = error.message.match(/resource_metadata\s*=\s*"([^"]+)"/i);
	// RFC 9728 / MCP: when WWW-Authenticate omits resource_metadata, still probe
	// the path-inserted protected-resource URL. Origin-root authorization-server
	// documents on shared gateways often name a different issuer.
	const resourceMetadataUrl = resourceMetaMatch?.[1] ?? rfc9728ProtectedResourceMetadataUrl(serverUrl);

	// Try to extract OAuth endpoints
	const oauth = extractOAuthEndpoints(error);
	const challengeScopes = extractOAuthChallengeScopes(error);

	if (oauth) {
		const mergedScopes = oauth.scopes ?? challengeScopes;
		// Callers on the JSON-error-body path use `authResult.oauth` directly and
		// skip `discoverOAuthEndpoints`; without merging the challenge scope back
		// into the returned endpoints, `/mcp reauth` and `/mcp add` still mint a
		// scope-less grant when the challenge advertised `scope="…"`.
		const mergedOAuth: OAuthEndpoints = mergedScopes === oauth.scopes ? oauth : { ...oauth, scopes: mergedScopes };
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth: mergedOAuth,
			authServerUrl,
			resourceMetadataUrl,
			scopes: mergedScopes,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	// Check if it might be API key based
	const errorMsg = error.message.toLowerCase();
	// A JSON 401 that mentions JWT is a bearer/OAuth challenge, not a static
	// API key. The generic "token"/"bearer" heuristic below would otherwise
	// classify it as apikey and skip protected-resource discovery.
	if (/\bjwt\b/.test(errorMsg) && errorMsg.includes("token")) {
		return {
			requiresAuth: true,
			authType: "oauth",
			authServerUrl,
			resourceMetadataUrl,
			scopes: challengeScopes,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			resourceMetadataUrl,
			scopes: challengeScopes,
			message: "Server requires API key authentication.",
		};
	}

	// Unknown auth type
	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		resourceMetadataUrl,
		scopes: challengeScopes,
		message: "Server requires authentication but type could not be determined.",
	};
}

/**
 * Normalize an OAuth issuer URL for RFC 8414 §3.3 comparison: lowercase
 * scheme/host (URL parser already does this), drop fragment/query, strip a
 * trailing slash on the path. The path is otherwise case-sensitive.
 */
function normalizeIssuerUrl(value: string): string | undefined {
	try {
		const u = new URL(value);
		const path = u.pathname.replace(/\/+$/, "");
		return `${u.protocol}//${u.host}${path}`;
	} catch {
		return undefined;
	}
}

/**
 * RFC 8414 §3.3: an authorization-server metadata document's `issuer` MUST
 * equal the URL the client used to construct the metadata URL. When a server
 * hosts metadata for several issuers under one origin (Plane serves a root
 * issuer `https://mcp.plane.so/` at `/.well-known/oauth-authorization-server`
 * *and* a path-scoped issuer `https://mcp.plane.so/http` at the path-prefixed
 * well-known URL), accepting the first hit silently routes the grant to the
 * wrong `/authorize` endpoint and produces opaque `server_error` redirects.
 *
 * Returns true when the metadata is safe to use:
 *   - the document has no `issuer` field (nonstandard / legacy servers — keep
 *     today's permissive behavior), or
 *   - the issuer matches `baseUrl` after trailing-slash normalization.
 */
function issuerMatchesBase(metadataIssuer: unknown, baseUrl: string): boolean {
	if (typeof metadataIssuer !== "string" || !metadataIssuer.trim()) {
		return true;
	}
	const normalizedIssuer = normalizeIssuerUrl(metadataIssuer);
	const normalizedBase = normalizeIssuerUrl(baseUrl);
	if (!normalizedIssuer || !normalizedBase) return true;
	return normalizedIssuer === normalizedBase;
}

/**
 * RFC 9728: insert `/.well-known/oauth-protected-resource` between the origin
 * and the resource path. Origin-root protected-resource metadata on API
 * gateways often names a shared login hub, not the issuer that minted the
 * client's `client_id`.
 */
export function rfc9728ProtectedResourceMetadataUrl(serverUrl: string | undefined): string | undefined {
	if (!serverUrl) return undefined;
	try {
		const parsed = new URL(serverUrl);
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.origin}/.well-known/oauth-protected-resource${path}`;
	} catch {
		return undefined;
	}
}

/**
 * Read space-separated OAuth scopes off a metadata document. Accepts either
 * an array (RFC 8414 `scopes_supported`) or a space-separated string
 * (`scopes` / `scope`), matching what MCP gateways emit under
 * `/.well-known/oauth-*`.
 */
function readMetadataScopes(metadata: Record<string, unknown>): string | undefined {
	if (Array.isArray(metadata.scopes_supported)) {
		const joined = metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ");
		if (joined) return joined;
	}
	if (typeof metadata.scopes === "string" && metadata.scopes.trim() !== "") return metadata.scopes;
	if (typeof metadata.scope === "string" && metadata.scope.trim() !== "") return metadata.scope;
	return undefined;
}

/**
 * Fetch the RFC 9728 protected-resource metadata document at
 * {@link resourceMetadataUrl} and return any scopes it advertises. Used by
 * `/mcp add` / `/mcp reauth` on the JSON-error-body path, where the caller
 * already holds usable OAuth endpoints but the required scopes live only in
 * the advertised protected-resource metadata — a case `discoverOAuthEndpoints`
 * normally handles but that path is skipped when the body carried endpoints.
 * Returns `undefined` on any error or when no scopes are advertised.
 */
export async function fetchResourceMetadataScopes(
	resourceMetadataUrl: string,
	opts?: { fetch?: FetchImpl; signal?: AbortSignal },
): Promise<string | undefined> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	try {
		const resp = await fetchImpl(resourceMetadataUrl, {
			method: "GET",
			headers: { Accept: "application/json" },
			redirect: "follow",
			signal: withTimeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS, opts?.signal),
		});
		if (!resp.ok) return undefined;
		const meta = (await resp.json()) as Record<string, unknown>;
		return readMetadataScopes(meta);
	} catch {
		return undefined;
	}
}

/**
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * This is a fallback when error responses don't include OAuth metadata.
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	resourceMetadataUrl?: string,
	opts?: { fetch?: FetchImpl; protectedResource?: string; protectedScopes?: string; signal?: AbortSignal },
): Promise<OAuthEndpoints | null> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	const issuerWellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize",
	];
	// Resource-server fallback: probe protected-resource metadata before
	// origin-root authorization-server / OpenID documents. Gateways that front
	// many tenants commonly publish a generic AS at the origin that is not the
	// authorization server for this MCP URL.
	const resourceWellKnownPaths = [
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize",
	];
	const urlsToQuery: Array<{ url: string; issuerCandidate: boolean }> = [];
	const visitedAuthServers = new Set<string>();

	let protectedResource = opts?.protectedResource;
	let protectedScopes = opts?.protectedScopes;
	const addDiscoveryBase = (url: string | undefined, issuerCandidate: boolean): void => {
		if (!url || visitedAuthServers.has(url)) return;
		urlsToQuery.push({ url, issuerCandidate });
		visitedAuthServers.add(url);
	};

	// Step 1: If a resource_metadata URL was provided, fetch it to discover auth servers.
	// This follows the RFC 9728 chain: resource_metadata → authorization_servers.
	if (resourceMetadataUrl && !visitedAuthServers.has(resourceMetadataUrl)) {
		visitedAuthServers.add(resourceMetadataUrl);
		try {
			const metaResp = await fetchImpl(resourceMetadataUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				redirect: "follow",
				signal: withTimeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS, opts?.signal),
			});
			if (metaResp.ok) {
				const meta = (await metaResp.json()) as Record<string, unknown>;
				protectedScopes = readMetadataScopes(meta) ?? protectedScopes;
				if (typeof meta.resource === "string" && meta.resource.trim() !== "") {
					protectedResource = meta.resource;
				}
				const authServers = Array.isArray(meta.authorization_servers)
					? meta.authorization_servers.filter((entry): entry is string => typeof entry === "string")
					: [];
				for (const s of authServers) {
					addDiscoveryBase(s, true);
				}
			}
		} catch {
			// Ignore errors, continue to try explicit URLs
		}
	}

	// Step 2: Add explicit authServerUrl as an issuer candidate, then the resource server fallback.
	addDiscoveryBase(authServerUrl, true);
	addDiscoveryBase(serverUrl, false);

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const resource = typeof metadata.resource === "string" ? metadata.resource : protectedResource;

			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				issuerUrl: readIssuerUrl(metadata),
				registrationUrl: readRegistrationUrl(metadata),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				scopes: protectedScopes ?? readMetadataScopes(metadata),
				resource,
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				const resource = typeof oauthData.resource === "string" ? oauthData.resource : protectedResource;

				return {
					authorizationUrl: oauthData.authorization_url || String(oauthData.authorizationUrl),
					tokenUrl: oauthData.token_url || String(oauthData.tokenUrl),
					issuerUrl: readIssuerUrl(oauthData) ?? readIssuerUrl(metadata),
					registrationUrl: readRegistrationUrl(oauthData),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					scopes: protectedScopes ?? readMetadataScopes(oauthData),
					resource,
				};
			}
		}

		return null;
	};

	for (const base of urlsToQuery) {
		const wellKnownPaths = base.issuerCandidate ? issuerWellKnownPaths : resourceWellKnownPaths;
		for (const path of wellKnownPaths) {
			// Try each well-known path at both the absolute origin and relative
			const urlsToTry = buildWellKnownUrls(path, base.url, base.issuerCandidate);
			for (const url of urlsToTry) {
				try {
					const response = await fetchImpl(url.toString(), {
						method: "GET",
						headers: { Accept: "application/json" },
						redirect: "follow",
						signal: withTimeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS, opts?.signal),
					});

					if (response.ok) {
						const metadata = (await response.json()) as Record<string, unknown>;
						// Authorization-server / OpenID Connect metadata documents carry an
						// `issuer` field that MUST equal the queried base URL only when that
						// URL came from an auth-server source (RFC 8414 §3.3, OIDC Discovery
						// §4.3). Resource-server fallback probes can legitimately return
						// cross-host issuer metadata.
						const requireIssuerMatch =
							base.issuerCandidate &&
							(path === "/.well-known/oauth-authorization-server" ||
								path === "/.well-known/openid-configuration");
						const issuerOk = requireIssuerMatch ? issuerMatchesBase(metadata.issuer, base.url) : true;
						const endpoints = issuerOk ? findEndpoints(metadata) : null;
						if (endpoints) return endpoints;

						if (path === "/.well-known/oauth-protected-resource") {
							const authServers = Array.isArray(metadata.authorization_servers)
								? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
								: [];

							const discoveredProtectedResource =
								typeof metadata.resource === "string" && metadata.resource.trim() !== ""
									? metadata.resource
									: protectedResource;

							for (const discoveredAuthServer of authServers) {
								if (visitedAuthServers.has(discoveredAuthServer)) {
									continue;
								}
								const discovered = await discoverOAuthEndpoints(serverUrl, discoveredAuthServer, undefined, {
									fetch: fetchImpl,
									protectedResource: discoveredProtectedResource,
									protectedScopes: readMetadataScopes(metadata) ?? protectedScopes,
									signal: opts?.signal,
								});
								if (discovered) return discovered;
							}
						}
					}
				} catch {
					// Ignore errors, try next path
				}
			}
		}
	}

	return null;
}

/** Build ordered metadata URL candidates for OAuth and OIDC discovery. */
export function buildWellKnownUrls(wellKnownPath: string, baseUrl: string, issuerCandidate: boolean): URL[] {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return [];
	}

	const absUrl = new URL(wellKnownPath, parsed);
	if (!wellKnownPath.startsWith("/")) return [absUrl];

	const normalizedPath = parsed.pathname.replace(/\/$/, "");
	const lastSlash = normalizedPath.lastIndexOf("/");
	// Bare origin (no path beyond "/") — only the origin-root candidate applies.
	if (lastSlash < 0) return [absUrl];

	// Path-prefixed well-known (common for gateways with sub-path routing).
	// Multi-segment paths drop the trailing segment (typically the MCP endpoint);
	// single-segment paths (lastSlash === 0) are themselves the gateway prefix.
	const prefixPath = lastSlash === 0 ? normalizedPath : normalizedPath.slice(0, lastSlash);
	const relUrl = new URL(wellKnownPath.slice(1), `${parsed.origin}${prefixPath}/`);

	const candidates: URL[] = [];
	const seen = new Set<string>();
	const push = (u: URL): void => {
		if (!seen.has(u.href)) {
			candidates.push(u);
			seen.add(u.href);
		}
	};

	if (!issuerCandidate) {
		// RFC 9728: probe path-inserted metadata first — origin-root documents on
		// shared gateways often describe a different issuer than the path-scoped
		// resource — then the parent-relative gateway fallback.
		if (wellKnownPath.startsWith("/.well-known/")) {
			push(new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin));
		}
		push(relUrl);
	} else if (wellKnownPath === "/.well-known/openid-configuration") {
		// OIDC Discovery §4 standard form is <issuer>/.well-known/openid-configuration;
		// try it before the parent-relative and RFC 8414 compatibility fallbacks.
		push(new URL(`${normalizedPath}${wellKnownPath}`, parsed.origin));
		push(relUrl);
		push(new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin));
	} else if (wellKnownPath.startsWith("/.well-known/")) {
		// RFC 8414 §3.1 standard form is /.well-known/<suffix>/<issuer-path>;
		// try it before the parent-relative and path-appended compatibility fallbacks.
		push(new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin));
		push(relUrl);
		push(new URL(`${normalizedPath}${wellKnownPath}`, parsed.origin));
	} else {
		// Non-metadata paths only have the parent-relative gateway fallback.
		push(relUrl);
	}
	push(relUrl);
	push(absUrl);

	return candidates;
}
