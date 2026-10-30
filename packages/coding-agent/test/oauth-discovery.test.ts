import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	extractMcpAuthServerUrl,
	extractOAuthChallengeScopes,
	fetchResourceMetadataScopes,
	OAuthIssuerMismatchError,
	rfc9728ProtectedResourceMetadataUrl,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { type FetchInput, mockFetch } from "./helpers/fetch-mock";

describe("mcp oauth discovery", () => {
	it("extracts Mcp-Auth-Server from transport error headers", () => {
		const error = new Error(
			'HTTP 401: unauthorized [WWW-Authenticate: Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource"; Mcp-Auth-Server: https://www.figma.com]',
		);

		expect(extractMcpAuthServerUrl(error)).toBe("https://www.figma.com/");
		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.authServerUrl).toBe("https://www.figma.com/");
	});

	it.each(["standard", "nested"])(
		"retains scopes from protected-resource metadata with %s inline endpoints",
		async format => {
			const fetchImpl = mockFetch((input: FetchInput) => {
				if (String(input) !== "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
					return new Response("not found", { status: 404 });
				}
				const endpoints =
					format === "standard"
						? {
								authorization_endpoint: "https://auth.example.com/authorize",
								token_endpoint: "https://auth.example.com/token",
							}
						: {
								oauth: {
									authorization_url: "https://auth.example.com/authorize",
									token_url: "https://auth.example.com/token",
								},
							};
				return Response.json({
					resource: "https://mcp.example.com/mcp",
					scopes_supported: ["mcp.read"],
					...endpoints,
				});
			});

			const oauth = await discoverOAuthEndpoints("https://mcp.example.com/mcp", undefined, undefined, {
				fetch: fetchImpl,
			});

			expect(oauth?.scopes).toBe("mcp.read");
		},
	);

	it.each([
		["/oauth/metadata", "standard"],
		["/oauth/metadata", "oauth"],
		["/oauth/metadata", "authorization"],
		["/oauth/metadata", "auth"],
		["/.mcp/auth", "standard"],
		["/.mcp/auth", "oauth"],
		["/.mcp/auth", "authorization"],
		["/.mcp/auth", "auth"],
	] as const)("keeps resource scopes but not issuer catalogues at %s (%s)", async (metadataPath, format) => {
		const authorizationUrl = "https://issuer.example.com/authorize";
		const tokenUrl = "https://issuer.example.com/token";
		const fetchImpl = mockFetch((input: FetchInput) => {
			if (String(input) !== `https://legacy.example.com${metadataPath}`) {
				return new Response("not found", { status: 404 });
			}
			return Response.json(
				format === "standard"
					? {
							authorization_endpoint: authorizationUrl,
							token_endpoint: tokenUrl,
							scopes_supported: ["mcp.read"],
						}
					: {
							[format]: {
								authorization_url: authorizationUrl,
								token_url: tokenUrl,
								scopes_supported: ["mcp.read"],
							},
						},
			);
		});

		const resource = await discoverOAuthEndpoints("https://legacy.example.com/mcp", undefined, undefined, {
			fetch: fetchImpl,
		});
		expect(resource?.scopes).toBe("mcp.read");

		const issuer = await discoverOAuthEndpoints(
			"https://other-resource.example.com/mcp",
			"https://legacy.example.com",
			undefined,
			{ fetch: fetchImpl },
		);
		expect(issuer).toMatchObject({ authorizationUrl, tokenUrl, scopes: undefined });
	});

	it.each(["standard", "nested"])("does not request the %s authorization server's scope catalogue", async format => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				const metadata =
					format === "standard"
						? {
								authorization_endpoint: "https://www.figma.com/oauth",
								token_endpoint: "https://api.figma.com/v1/oauth/token",
								client_id: "figma-client-id",
								scopes_supported: ["file_read", "file_write"],
							}
						: {
								oauth: {
									authorization_url: "https://www.figma.com/oauth",
									token_url: "https://api.figma.com/v1/oauth/token",
									client_id: "figma-client-id",
									scopes_supported: ["file_read", "file_write"],
								},
							};
				return Response.json(metadata);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.figma.com/mcp", "https://www.figma.com", undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://www.figma.com/oauth",
			tokenUrl: "https://api.figma.com/v1/oauth/token",
			clientId: "figma-client-id",
			scopes: undefined,
		});
		expect(calls[0]).toBe("https://www.figma.com/.well-known/oauth-authorization-server");
	});
});

describe("path-prefixed auth servers", () => {
	it("discovers endpoints via relative well-known path when server URL has a sub-path", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			// Absolute well-known fails (at origin root)
			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			// Relative well-known succeeds (under /my-service/)
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth/authorize",
						token_endpoint: "https://gateway.example.com/my-service/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service/mcp", undefined, undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth/authorize",
			tokenUrl: "https://gateway.example.com/my-service/oauth/token",
		});
		// Resource-server fallback probes RFC 9728 path-inserted PR metadata first.
		expect(calls[0]).toBe("https://gateway.example.com/.well-known/oauth-protected-resource/my-service/mcp");
		expect(calls).toContain("https://gateway.example.com/my-service/.well-known/oauth-authorization-server");
	});

	it("discovers endpoints via single-segment path prefix (no trailing endpoint segment)", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth/authorize",
						token_endpoint: "https://gateway.example.com/my-service/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service", undefined, undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth/authorize",
			tokenUrl: "https://gateway.example.com/my-service/oauth/token",
		});
		expect(calls[0]).toBe("https://gateway.example.com/.well-known/oauth-protected-resource/my-service");
		expect(calls).toContain("https://gateway.example.com/my-service/.well-known/oauth-authorization-server");
	});

	it("discovers OIDC metadata appended to a multi-segment issuer path", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://auth.example.com/auth/realms/myrealm/.well-known/openid-configuration") {
				return new Response(
					JSON.stringify({
						issuer: "https://auth.example.com/auth/realms/myrealm",
						authorization_endpoint: "https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/auth",
						token_endpoint: "https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://mcp.example.com/mcp",
			"https://auth.example.com/auth/realms/myrealm",
			undefined,
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/auth",
			issuerUrl: "https://auth.example.com/auth/realms/myrealm",
			tokenUrl: "https://auth.example.com/auth/realms/myrealm/protocol/openid-connect/token",
		});
		expect(calls).toContain("https://auth.example.com/auth/realms/myrealm/.well-known/openid-configuration");
		expect(calls).not.toContain("https://auth.example.com/.well-known/openid-configuration/auth/realms/myrealm");
		// The standard issuer form is tried before the parent-relative fallback, so the
		// slow/absent parent-relative URL is never probed once the issuer form succeeds.
		expect(calls).not.toContain("https://auth.example.com/auth/realms/.well-known/openid-configuration");
	});

	it("tries RFC 8414 path-ful metadata before the path-appended compatibility form", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://auth.example.com/.well-known/oauth-authorization-server/tenants/acme") {
				return new Response(
					JSON.stringify({
						issuer: "https://auth.example.com/tenants/acme",
						authorization_endpoint: "https://auth.example.com/tenants/acme/oauth",
						token_endpoint: "https://auth.example.com/tenants/acme/token",
						registration_endpoint: "https://auth.example.com/tenants/acme/register",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://mcp.example.com/mcp",
			"https://auth.example.com/tenants/acme",
			undefined,
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/tenants/acme/oauth",
			issuerUrl: "https://auth.example.com/tenants/acme",
			tokenUrl: "https://auth.example.com/tenants/acme/token",
			registrationUrl: "https://auth.example.com/tenants/acme/register",
		});
		expect(calls).toContain("https://auth.example.com/.well-known/oauth-authorization-server/tenants/acme");
		expect(calls).not.toContain("https://auth.example.com/tenants/acme/.well-known/oauth-authorization-server");
	});

	it("prefers absolute well-known when it succeeds (origin-root servers still work)", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.example.com/oauth",
						token_endpoint: "https://auth.example.com/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.example.com", "https://auth.example.com", undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/oauth",
			tokenUrl: "https://auth.example.com/token",
		});
		// Only the absolute path was needed
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
	});
});

describe("resource_metadata chain", () => {
	it("extracts resourceMetadataUrl from error message", () => {
		const error = new Error(
			'HTTP 401: WWW-Authenticate: Bearer resource_metadata="https://gateway.example.com/my-service/.well-known/oauth-protected-resource"',
		);

		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.resourceMetadataUrl).toBe(
			"https://gateway.example.com/my-service/.well-known/oauth-protected-resource",
		);
	});

	it("extracts scope= from insufficient_scope challenge alongside resource_metadata", () => {
		const error = new Error(
			'HTTP 403: {"error":"insufficient_scope","required":["jit"]} [WWW-Authenticate: Bearer error="insufficient_scope", scope="jit", resource_metadata="https://gateway.example.com/jit/.well-known/oauth-protected-resource"]',
		);

		expect(extractOAuthChallengeScopes(error)).toBe("jit");
		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.scopes).toBe("jit");
		expect(auth.resourceMetadataUrl).toBe("https://gateway.example.com/jit/.well-known/oauth-protected-resource");
	});

	it("merges challenge scopes into oauth endpoints when the JSON body omits them", () => {
		const error = new Error(
			'HTTP 403: {"error":"insufficient_scope","oauth":{"authorization_url":"https://auth.example.com/oauth/auth","token_url":"https://auth.example.com/oauth/token"}} [WWW-Authenticate: Bearer error="insufficient_scope", scope="jit"]',
		);

		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.authType).toBe("oauth");
		expect(auth.scopes).toBe("jit");
		// Callers on the JSON-body path use `authResult.oauth` directly and skip
		// discovery — the merged scope must land on the returned endpoints.
		expect(auth.oauth?.scopes).toBe("jit");
		expect(auth.oauth?.authorizationUrl).toBe("https://auth.example.com/oauth/auth");
		expect(auth.oauth?.tokenUrl).toBe("https://auth.example.com/oauth/token");
	});

	it("fetches scopes from resource_metadata when JSON body endpoints omit them", async () => {
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);

			if (url === "https://gateway.example.com/jit/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://auth.example.com"],
						resource: "https://gateway.example.com",
						scopes_supported: ["jit", "read"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const scopes = await fetchResourceMetadataScopes(
			"https://gateway.example.com/jit/.well-known/oauth-protected-resource",
			{ fetch: fetchImpl },
		);
		expect(scopes).toBe("jit read");
	});

	it("returns undefined when resource_metadata fetch fails or lacks scopes", async () => {
		const notFound = mockFetch(() => new Response("not found", { status: 404 }));
		const emptyMeta = mockFetch(
			() =>
				new Response(JSON.stringify({ authorization_servers: ["https://auth.example.com"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);

		expect(
			await fetchResourceMetadataScopes("https://gateway.example.com/x/.well-known/oauth-protected-resource", {
				fetch: notFound,
			}),
		).toBeUndefined();
		expect(
			await fetchResourceMetadataScopes("https://gateway.example.com/x/.well-known/oauth-protected-resource", {
				fetch: emptyMeta,
			}),
		).toBeUndefined();
	});

	it("carries scopes_supported from resource metadata into discovered auth-server endpoints", async () => {
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);

			if (url === "https://gateway.example.com/my-service/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://sso.example.com"],
						resource: "https://gateway.example.com",
						scopes_supported: ["k8s.logging-mcp-server", "k8s.annotations"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://sso.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: "https://sso.example.com",
						authorization_endpoint: "https://sso.example.com/oauth/auth",
						token_endpoint: "https://sso.example.com/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://gateway.example.com/my-service/mcp",
			undefined,
			"https://gateway.example.com/my-service/.well-known/oauth-protected-resource",
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://sso.example.com/oauth/auth",
			issuerUrl: "https://sso.example.com",
			tokenUrl: "https://sso.example.com/oauth/token",
			scopes: "k8s.logging-mcp-server k8s.annotations",
			resource: "https://gateway.example.com",
		});
	});

	it("prefers RFC 9728 resource scopes over the auth server's broad scopes_supported", async () => {
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);

			if (url === "https://ws.cloud.databricks.com/.well-known/oauth-protected-resource/api/2.0/mcp/genie") {
				return new Response(
					JSON.stringify({
						resource: "https://ws.cloud.databricks.com/api/2.0/mcp/genie",
						scopes_supported: ["genie", "offline_access"],
						authorization_servers: ["https://ws.cloud.databricks.com/oidc"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://ws.cloud.databricks.com/oidc/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: "https://ws.cloud.databricks.com/oidc",
						authorization_endpoint: "https://ws.cloud.databricks.com/oidc/v1/authorize",
						token_endpoint: "https://ws.cloud.databricks.com/oidc/v1/token",
						// Tenant-wide catalogue the pre-registered client is not provisioned for.
						scopes_supported: ["email", "openid", "profile", "workspace"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://ws.cloud.databricks.com/api/2.0/mcp/genie",
			undefined,
			"https://ws.cloud.databricks.com/.well-known/oauth-protected-resource/api/2.0/mcp/genie",
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://ws.cloud.databricks.com/oidc/v1/authorize",
			issuerUrl: "https://ws.cloud.databricks.com/oidc",
			tokenUrl: "https://ws.cloud.databricks.com/oidc/v1/token",
			scopes: "genie offline_access",
			resource: "https://ws.cloud.databricks.com/api/2.0/mcp/genie",
		});
	});

	it("threads challenge-derived scopes into endpoints discovered via resource metadata", async () => {
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);

			if (url === "https://gateway.example.com/jit/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://sso.example.com"],
						resource: "https://gateway.example.com",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://sso.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: "https://sso.example.com",
						authorization_endpoint: "https://sso.example.com/oauth/auth",
						token_endpoint: "https://sso.example.com/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://gateway.example.com/jit/mcp",
			undefined,
			"https://gateway.example.com/jit/.well-known/oauth-protected-resource",
			{ fetch: fetchImpl, protectedScopes: "jit" },
		);

		expect(oauth).toMatchObject({
			authorizationUrl: "https://sso.example.com/oauth/auth",
			tokenUrl: "https://sso.example.com/oauth/token",
			scopes: "jit",
			resource: "https://gateway.example.com",
		});
	});

	it("follows resource_metadata URL to discover authorization servers", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			// resource_metadata URL returns authorization_servers
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://gateway.example.com/my-service"],
						resource: "https://gateway.example.com/my-service/mcp",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			// Well-known at the discovered auth server (absolute fails, relative succeeds)
			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth",
						token_endpoint: "https://gateway.example.com/my-service/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://gateway.example.com/my-service/mcp",
			undefined,
			"https://gateway.example.com/my-service/.well-known/oauth-protected-resource",
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth",
			tokenUrl: "https://gateway.example.com/my-service/token",
			resource: "https://gateway.example.com/my-service/mcp",
		});
		// resource_metadata fetched first
		expect(calls[0]).toBe("https://gateway.example.com/my-service/.well-known/oauth-protected-resource");
	});

	it("carries resource from fallback protected-resource discovery", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://gateway.example.com/.well-known/oauth-protected-resource") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://auth.example.com/my-service"],
						resource: "https://gateway.example.com/my-service/custom-resource",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://auth.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.example.com/my-service/oauth",
						token_endpoint: "https://auth.example.com/my-service/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service/mcp", undefined, undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/my-service/oauth",
			tokenUrl: "https://auth.example.com/my-service/token",
			resource: "https://gateway.example.com/my-service/custom-resource",
		});
		expect(calls).toContain("https://gateway.example.com/my-service/.well-known/oauth-protected-resource");
	});
});

describe("relative Mcp-Auth-Server URL", () => {
	it("resolves relative Mcp-Auth-Server against server URL", () => {
		const error = new Error("HTTP 401: WWW-Authenticate: Bearer; Mcp-Auth-Server: /my-service/oauth");

		// Without serverUrl, relative URL returns undefined
		expect(extractMcpAuthServerUrl(error)).toBeUndefined();

		// With serverUrl, relative URL is resolved
		expect(extractMcpAuthServerUrl(error, "https://gateway.example.com/my-service/mcp")).toBe(
			"https://gateway.example.com/my-service/oauth",
		);
	});
});

describe("RFC 9728 path-inserted protected resource", () => {
	const mcpUrl = "https://mcp.gateway.example/platform/v1/d/tenant.example/prod/service";
	const pathfulPr =
		"https://mcp.gateway.example/.well-known/oauth-protected-resource/platform/v1/d/tenant.example/prod/service";
	const originRootPr = "https://mcp.gateway.example/.well-known/oauth-protected-resource";
	const originAs = "https://mcp.gateway.example/.well-known/oauth-authorization-server";
	const tenantOidc = "https://tenant.example/.well-known/openid-configuration";

	it("builds the path-inserted protected-resource URL between origin and MCP path", () => {
		expect(rfc9728ProtectedResourceMetadataUrl(mcpUrl)).toBe(pathfulPr);
		expect(rfc9728ProtectedResourceMetadataUrl("https://mcp.gateway.example")).toBe(originRootPr);
		expect(rfc9728ProtectedResourceMetadataUrl(undefined)).toBeUndefined();
	});

	it("synthesizes resource_metadata for a 401 that omits WWW-Authenticate", () => {
		const error = new Error('HTTP 401: {"errors":[{"message":"JWT Token is required"}]}');
		const auth = analyzeAuthError(error, mcpUrl);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.authType).toBe("oauth");
		expect(auth.resourceMetadataUrl).toBe(pathfulPr);
		expect(analyzeAuthError(error, "https://mcp.gateway.example").resourceMetadataUrl).toBe(originRootPr);
	});

	it("prefers path-inserted PR metadata over origin-root AS for a shared gateway", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === pathfulPr) {
				return new Response(
					JSON.stringify({
						resource: mcpUrl,
						authorization_servers: ["https://tenant.example"],
						scopes_supported: ["mcp_api", "offline_access"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === originAs) {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://login.hub.example/oauth/authorize",
						token_endpoint: "https://login.hub.example/oauth/token",
						scopes_supported: ["api", "profile", "refresh_token"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === tenantOidc) {
				return new Response(
					JSON.stringify({
						issuer: "https://tenant.example",
						authorization_endpoint: "https://tenant.example/oauth/authorize",
						token_endpoint: "https://tenant.example/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(mcpUrl, undefined, undefined, { fetch: fetchImpl });

		expect(oauth).toEqual({
			authorizationUrl: "https://tenant.example/oauth/authorize",
			tokenUrl: "https://tenant.example/oauth/token",
			scopes: "mcp_api offline_access",
			resource: mcpUrl,
			issuerUrl: "https://tenant.example",
			clientId: undefined,
			registrationUrl: undefined,
		});
		expect(calls[0]).toBe(pathfulPr);
		expect(calls).toContain(tenantOidc);
		expect(calls).not.toContain(originAs);
	});

	it("uses an authorization server advertised at the resource's own URL", async () => {
		const serverUrl = "https://host.example";
		const metadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
		const fetchImpl = mockFetch((input: FetchInput) => {
			if (String(input) === metadataUrl) {
				return Response.json({ resource: serverUrl, authorization_servers: [serverUrl] });
			}
			if (String(input) === `${serverUrl}/.well-known/oauth-authorization-server`) {
				return Response.json({
					issuer: serverUrl,
					authorization_endpoint: `${serverUrl}/authorize`,
					token_endpoint: `${serverUrl}/token`,
				});
			}
			return new Response("not found", { status: 404 });
		});

		for (const resourceMetadataUrl of [undefined, metadataUrl]) {
			const oauth = await discoverOAuthEndpoints(serverUrl, undefined, resourceMetadataUrl, { fetch: fetchImpl });
			expect(oauth).toMatchObject({
				authorizationUrl: `${serverUrl}/authorize`,
				tokenUrl: `${serverUrl}/token`,
				issuerUrl: serverUrl,
				resource: serverUrl,
			});
		}
	});

	it("reports the advertised AS issuer mismatch instead of falling back to an unadvertised origin-root AS", async () => {
		// LiteLLM-style gateway: `/slack/mcp` advertises `https://gw.example/slack`,
		// whose AS metadata wrongly claims the origin as issuer. The origin-root
		// protected-resource metadata advertises the gateway's generic AS, which
		// validates but was never listed for this resource.
		const gw = "https://gw.example";
		const slackAs = {
			issuer: gw,
			authorization_endpoint: `${gw}/slack/authorize`,
			token_endpoint: `${gw}/slack/token`,
		};
		const rootAs = {
			issuer: gw,
			authorization_endpoint: `${gw}/v1/mcp/oauth/authorize`,
			token_endpoint: `${gw}/v1/mcp/oauth/token`,
		};
		const routes: Record<string, unknown> = {
			[`${gw}/.well-known/oauth-protected-resource/slack/mcp`]: { authorization_servers: [`${gw}/slack`] },
			[`${gw}/.well-known/oauth-authorization-server/slack`]: slackAs,
			[`${gw}/slack/.well-known/oauth-authorization-server`]: slackAs,
			[`${gw}/.well-known/oauth-protected-resource`]: { resource: gw, authorization_servers: [gw] },
			[`${gw}/.well-known/oauth-authorization-server`]: rootAs,
			[`${gw}/.well-known/openid-configuration`]: rootAs,
		};
		const fetchImpl = mockFetch((input: FetchInput) => {
			const body = routes[String(input)];
			return body
				? new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
				: new Response("not found", { status: 404 });
		});
		const serverUrl = `${gw}/slack/mcp`;

		// Advertised via the 401 resource_metadata hint, and found by resource-server probing.
		for (const resourceMetadataUrl of [rfc9728ProtectedResourceMetadataUrl(serverUrl), undefined]) {
			const discovery = discoverOAuthEndpoints(serverUrl, undefined, resourceMetadataUrl, { fetch: fetchImpl });
			await expect(discovery).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
			await expect(discovery).rejects.toThrow(
				"Could not discover OAuth endpoints: authorization server https://gw.example/slack " +
					"(advertised by https://gw.example/.well-known/oauth-protected-resource/slack/mcp) " +
					"returned metadata with issuer https://gw.example (RFC 8414 §3.3 requires an exact match).",
			);
		}

		// A challenge naming both the resource metadata and an `Mcp-Auth-Server` hint for the
		// valid but unadvertised origin AS: the advertised list wins, so the hint is not a way around it.
		await expect(
			discoverOAuthEndpoints(serverUrl, gw, rfc9728ProtectedResourceMetadataUrl(serverUrl), { fetch: fetchImpl }),
		).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
	});
});

describe("RFC 8414 §3.3 issuer validation", () => {
	it("accepts cross-host issuer metadata on resource-server fallback (Atlassian regression)", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://mcp.atlassian.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: "https://cf.mcp.atlassian.com",
						authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
						token_endpoint: "https://cf.mcp.atlassian.com/v1/token",
						registration_endpoint: "https://cf.mcp.atlassian.com/v1/register",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.atlassian.com/v1/mcp", undefined, undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://mcp.atlassian.com/v1/authorize",
			issuerUrl: "https://cf.mcp.atlassian.com",
			tokenUrl: "https://cf.mcp.atlassian.com/v1/token",
			registrationUrl: "https://cf.mcp.atlassian.com/v1/register",
		});
		expect(calls).toContain("https://mcp.atlassian.com/.well-known/oauth-authorization-server");
	});

	it("rejects origin-root metadata whose issuer mismatches the path-scoped auth server (Plane regression)", async () => {
		// Plane hosts both a root issuer (`https://mcp.plane.so/`) at the
		// origin-root well-known *and* a path-scoped issuer
		// (`https://mcp.plane.so/http`) at the path-prefixed well-known. The
		// `/http/mcp` endpoint advertises only the path-scoped issuer via
		// protected-resource metadata. Origin-root AS metadata must not win:
		// it routes the grant to `https://mcp.plane.so/authorize`, which rejects
		// every grant with `server_error`.
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://mcp.plane.so/.well-known/oauth-protected-resource/http/mcp") {
				return new Response(
					JSON.stringify({
						resource: "https://mcp.plane.so/http/mcp",
						authorization_servers: ["https://mcp.plane.so/http"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://mcp.plane.so/.well-known/oauth-authorization-server") {
				// Root-issuer metadata served at origin root — wrong issuer for the
				// `/http` auth server we asked about.
				return new Response(
					JSON.stringify({
						issuer: "https://mcp.plane.so/",
						authorization_endpoint: "https://mcp.plane.so/authorize",
						token_endpoint: "https://mcp.plane.so/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url === "https://mcp.plane.so/http/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: "https://mcp.plane.so/http",
						authorization_endpoint: "https://mcp.plane.so/http/authorize",
						token_endpoint: "https://mcp.plane.so/http/token",
						registration_endpoint: "https://mcp.plane.so/http/register",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://mcp.plane.so/http/mcp",
			undefined,
			"https://mcp.plane.so/.well-known/oauth-protected-resource/http/mcp",
			{ fetch: fetchImpl },
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://mcp.plane.so/http/authorize",
			issuerUrl: "https://mcp.plane.so/http",
			tokenUrl: "https://mcp.plane.so/http/token",
			registrationUrl: "https://mcp.plane.so/http/register",
			resource: "https://mcp.plane.so/http/mcp",
		});
		// Path-prefixed well-known is tried before origin-root, so the
		// wrong-issuer origin document is never consulted.
		expect(calls).not.toContain("https://mcp.plane.so/.well-known/oauth-authorization-server");
		expect(calls).toContain("https://mcp.plane.so/http/.well-known/oauth-authorization-server");
	});

	it("treats trailing-slash issuer differences as a match", async () => {
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						// Issuer with trailing slash; queried base without.
						issuer: "https://auth.example.com/",
						authorization_endpoint: "https://auth.example.com/oauth/authorize",
						token_endpoint: "https://auth.example.com/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.example.com", "https://auth.example.com", undefined, {
			fetch: fetchImpl,
		});

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/oauth/authorize",
			issuerUrl: "https://auth.example.com/",
			tokenUrl: "https://auth.example.com/oauth/token",
		});
	});
});

describe("bounded discovery fetches", () => {
	// A fetch that never resolves on its own; it settles only when its
	// AbortSignal fires. Pre-fix, discovery passed no signal, so this hung forever.
	const hangingFetch: FetchImpl = (_input, init) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		const signal = init?.signal;
		const abort = () => reject(new DOMException("aborted", "AbortError"));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		return promise;
	};

	it("aborts hanging well-known discovery fetches instead of stalling", async () => {
		const oauth = await discoverOAuthEndpoints("https://mcp.example.test/mcp", undefined, undefined, {
			fetch: hangingFetch,
			signal: AbortSignal.timeout(50),
		});
		expect(oauth).toBeNull();
	});

	it("aborts a hanging resource_metadata fetch and returns undefined", async () => {
		const scopes = await fetchResourceMetadataScopes(
			"https://mcp.example.test/.well-known/oauth-protected-resource",
			{ fetch: hangingFetch, signal: AbortSignal.timeout(50) },
		);
		expect(scopes).toBeUndefined();
	});
});
