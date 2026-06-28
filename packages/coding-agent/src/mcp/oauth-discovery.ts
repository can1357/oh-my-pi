/**
 * MCP OAuth Auto-Discovery
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 */
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	scopes?: string;
	resource?: string;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
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

		return { authorizationUrl, tokenUrl, clientId, scopes, resource };
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
	const resourceMetadataUrl = resourceMetaMatch?.[1];

	// Try to extract OAuth endpoints
	const oauth = extractOAuthEndpoints(error);

	if (oauth) {
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth,
			authServerUrl,
			resourceMetadataUrl,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	// Check if it might be API key based
	const errorMsg = error.message.toLowerCase();
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
			message: "Server requires API key authentication.",
		};
	}

	// Unknown auth type
	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		resourceMetadataUrl,
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
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * This is a fallback when error responses don't include OAuth metadata.
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	resourceMetadataUrl?: string,
	opts?: { fetch?: FetchImpl; protectedResource?: string },
): Promise<OAuthEndpoints | null> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize", // Some MCP servers expose OAuth config here
	];
	const urlsToQuery: Array<{ url: string; issuerCandidate: boolean }> = [];
	const visitedAuthServers = new Set<string>();

	let protectedResource = opts?.protectedResource;
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
			});
			if (metaResp.ok) {
				const meta = (await metaResp.json()) as Record<string, unknown>;
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
			const scopesSupported = Array.isArray(metadata.scopes_supported)
				? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string").join(" ")
				: undefined;
			const resource = typeof metadata.resource === "string" ? metadata.resource : protectedResource;

			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
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
				scopes:
					scopesSupported ||
					(typeof metadata.scopes === "string"
						? metadata.scopes
						: typeof metadata.scope === "string"
							? metadata.scope
							: undefined),
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
					scopes:
						typeof oauthData.scopes === "string"
							? oauthData.scopes
							: typeof oauthData.scope === "string"
								? oauthData.scope
								: undefined,
					resource,
				};
			}
		}

		return null;
	};

	for (const base of urlsToQuery) {
		for (const path of wellKnownPaths) {
			// Try each well-known path at both the absolute origin and relative
			const urlsToTry = buildWellKnownUrls(path, base.url);
			for (const url of urlsToTry) {
				try {
					const response = await fetchImpl(url.toString(), {
						method: "GET",
						headers: { Accept: "application/json" },
						redirect: "follow",
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

function buildWellKnownUrls(wellKnownPath: string, baseUrl: string): URL[] {
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

	const candidates: URL[] = [absUrl];
	const seen = new Set<string>([absUrl.href]);
	const push = (u: URL): void => {
		if (!seen.has(u.href)) {
			candidates.push(u);
			seen.add(u.href);
		}
	};
	push(relUrl);

	// RFC 8414 §3.1 path-ful issuer form: /.well-known/<suffix>/<issuer-path>.
	// Only meaningful for well-known metadata documents.
	if (wellKnownPath.startsWith("/.well-known/")) {
		const pathfulUrl = new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin);
		push(pathfulUrl);
	}

	return candidates;
}
