import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	extractMcpAuthServerUrl,
	extractOAuthChallengeScopes,
	fetchResourceMetadataScopes,
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

	it("discovers oauth endpoints from auth server metadata", async () => {
		const calls: string[] = [];
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
			calls.push(url);

			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://www.figma.com/oauth",
						token_endpoint: "https://api.figma.com/v1/oauth/token",
						client_id: "figma-client-id",
						scopes_supported: ["file_read", "file_write"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
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
			scopes: "file_read file_write",
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

	it("does not classify a JWT bearer 401 as an API key", () => {
		const error = new Error('HTTP 401: {"errors":[{"message":"JWT Token is required"}]}');
		expect(analyzeAuthError(error).authType).toBe("oauth");
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

	it("accepts metadata without an issuer field (legacy / nonstandard servers)", async () => {
		// Some servers omit `issuer` from their well-known document. Keep today's
		// permissive behavior so this fix never regresses an already-working flow.
		const fetchImpl = mockFetch((input: FetchInput) => {
			const url = String(input);
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
