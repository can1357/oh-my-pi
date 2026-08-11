import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import { fetchExaTools } from "@pk-nerdsaver-ai/pi-coding-agent/exa/mcp-client";
import { MCPOAuthFlow, refreshMCPOAuthToken } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/oauth-flow";

const TEST_ISSUER = "https://issuer.example/";

afterEach(() => {
	vi.restoreAllMocks();
});

function mockProviderTokenEndpoint(onBody: (body: string) => void): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		if (url === "https://provider.example/token") {
			onBody(String(init?.body ?? ""));
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	};
}

function mockFigmaRegistration(onRegistration: (payload: Record<string, unknown>) => void): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
			return new Response(JSON.stringify({ registration_endpoint: "https://www.figma.com/oauth/register" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://www.figma.com/oauth/register") {
			onRegistration(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				JSON.stringify({ client_id: "registered-client-id", client_secret: "registered-client-secret" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	};
}

async function completeLocalOAuthCallback(url: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const response = await fetch(url);
			await response.text();
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(5);
		}
	}
	throw lastError;
}

describe("mcp oauth flow", () => {
	it("uses Codex client name for dynamic client registration", async () => {
		let registrationPayload: Record<string, unknown> | null = null;

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				issuer: "https://www.figma.com/",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
				fetch: mockFigmaRegistration(payload => {
					registrationPayload = payload;
				}),
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53172/callback");
		const authUrl = new URL(url);

		expect(registrationPayload).not.toBeNull();
		expect((registrationPayload as { client_name?: string } | null)?.client_name).toBe("Codex");
		expect(authUrl.searchParams.get("client_id")).toBe("registered-client-id");
		expect(authUrl.searchParams.get("state")).toBe("test-state");
	});

	it("uses a validated configured Client ID Metadata Document when the issuer advertises support", async () => {
		const metadataUrl = "https://client.example/ompk/client-metadata.json";
		let registrationRequested = false;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: metadataUrl,
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					if (String(input) === metadataUrl) {
						return new Response(
							JSON.stringify({
								client_id: metadataUrl,
								client_name: "OMP",
								redirect_uris: ["http://127.0.0.1:53176/callback"],
								token_endpoint_auth_method: "none",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					registrationRequested = true;
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53176/callback");

		expect(new URL(url).searchParams.get("client_id")).toBe(metadataUrl);
		expect(flow.resolvedClientId).toBe(metadataUrl);
		expect(registrationRequested).toBe(false);
	});
	it("accepts a Client ID Metadata Document with omitted token_endpoint_auth_method", async () => {
		const metadataUrl = "https://client.example/ompk/client-metadata-omitted.json";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: metadataUrl,
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					if (String(input) === metadataUrl) {
						return new Response(
							JSON.stringify({
								client_id: metadataUrl,
								client_name: "OMP",
								redirect_uris: ["http://127.0.0.1:53190/callback"],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53190/callback");
		expect(new URL(url).searchParams.get("client_id")).toBe(metadataUrl);
	});

	it("rejects a Client ID Metadata Document specifying unsupported private_key_jwt before authorization", async () => {
		const metadataUrl = "https://client.example/ompk/client-metadata-jwt.json";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: metadataUrl,
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					if (String(input) === metadataUrl) {
						return new Response(
							JSON.stringify({
								client_id: metadataUrl,
								client_name: "OMP",
								redirect_uris: ["http://127.0.0.1:53191/callback"],
								token_endpoint_auth_method: "private_key_jwt",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		await expect(flow.generateAuthUrl("test-state", "http://127.0.0.1:53191/callback")).rejects.toThrow(
			"unsupported token_endpoint_auth_method: private_key_jwt",
		);
	});

	it("rejects a Client ID Metadata Document specifying unsupported client_secret_basic before authorization", async () => {
		const metadataUrl = "https://client.example/ompk/client-metadata-secret.json";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: metadataUrl,
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					if (String(input) === metadataUrl) {
						return new Response(
							JSON.stringify({
								client_id: metadataUrl,
								client_name: "OMP",
								redirect_uris: ["http://127.0.0.1:53192/callback"],
								token_endpoint_auth_method: "client_secret_basic",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		await expect(flow.generateAuthUrl("test-state", "http://127.0.0.1:53192/callback")).rejects.toThrow(
			"unsupported token_endpoint_auth_method: client_secret_basic",
		);
	});

	it("keeps an explicit pre-registered client ID ahead of Client ID Metadata Documents", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientId: "pre-registered-client",
				clientMetadataUrl: "https://client.example/ompk/client-metadata.json",
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53177/callback");

		expect(new URL(url).searchParams.get("client_id")).toBe("pre-registered-client");
	});

	it("fails closed when selected Client ID Metadata Document misses OMP's exact redirect URI", async () => {
		const metadataUrl = "https://client.example/ompk/client-metadata.json";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: metadataUrl,
				clientIdMetadataDocumentSupported: true,
				fetch: async () =>
					new Response(
						JSON.stringify({
							client_id: metadataUrl,
							client_name: "OMP",
							redirect_uris: ["http://127.0.0.1:9999/callback"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			},
			{},
		);

		await expect(flow.generateAuthUrl("test-state", "http://127.0.0.1:53178/callback")).rejects.toThrow(
			"must register the exact redirect URI",
		);
	});

	it("rejects percent-encoded dot segments in selected Client ID Metadata Document URLs", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://issuer.example/authorize",
				issuer: "https://issuer.example/",
				tokenUrl: "https://issuer.example/token",
				clientMetadataUrl: "https://client.example/ompk/%2e%2e/client-metadata.json",
				clientIdMetadataDocumentSupported: true,
				fetch: async input => {
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		await expect(flow.generateAuthUrl("test-state", "http://127.0.0.1:53179/callback")).rejects.toThrow(
			"dot-segment-free path",
		);
	});

	it("discovers dynamic registration from the issuer rather than the authorization endpoint", async () => {
		const calls: string[] = [];
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://login.example.com/authorize",
				issuer: "https://issuer.example.com/tenant",
				tokenUrl: "https://tokens.example.com/token",
				fetch: async (input, init) => {
					const url = String(input);
					calls.push(url);
					if (url === "https://issuer.example.com/tenant/.well-known/oauth-authorization-server") {
						return new Response(
							JSON.stringify({
								issuer: "https://issuer.example.com/tenant",
								registration_endpoint: "https://issuer.example.com/register",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url === "https://issuer.example.com/register" && init?.method === "POST") {
						return new Response(JSON.stringify({ client_id: "issuer-bound-client" }), {
							status: 201,
							headers: { "Content-Type": "application/json" },
						});
					}
					return new Response("not found", { status: 404 });
				},
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53175/callback");

		expect(new URL(url).searchParams.get("client_id")).toBe("issuer-bound-client");
		expect(calls).toContain("https://issuer.example.com/tenant/.well-known/oauth-authorization-server");
		expect(calls.some(call => call.startsWith("https://login.example.com/.well-known/"))).toBe(false);
	});

	it("defaults prompt=consent so reauth can switch accounts despite an active browser session", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53180/callback");

		expect(new URL(url).searchParams.get("prompt")).toBe("consent");
	});

	it("passes an explicit prompt value through to the authorization request", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				prompt: "select_account",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("s", "http://127.0.0.1:53181/callback");

		expect(new URL(url).searchParams.get("prompt")).toBe("select_account");
	});

	it("omits the prompt parameter entirely when configured as the empty string", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				prompt: "",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("s", "http://127.0.0.1:53182/callback");

		expect(new URL(url).searchParams.has("prompt")).toBe(false);
	});

	it("keeps a prompt value already embedded in the authorization URL", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize?prompt=none",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53183/callback");

		expect(new URL(url).searchParams.get("prompt")).toBe("none");
	});

	it("uses configured callbackPath and accepts loopback callbacks without an issuer", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14567,
				callbackPath: "slack/oauth_redirect",
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(`${observedRedirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const redirectUrl = new URL(observedRedirectUri);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(redirectUrl.pathname).toBe("/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe(observedRedirectUri);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});
	it("sends MCP resource indicator in authorization and token requests", async () => {
		let authResource = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				resource: "https://mcp.example.com/mcp",
				callbackPort: 14572,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					authResource = authUrl.searchParams.get("resource") ?? "";
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(`${redirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(authResource).toBe("https://mcp.example.com/mcp");
		expect(tokenParams.get("resource")).toBe("https://mcp.example.com/mcp");
	});
	it("uses an authorization URL resource for the matching token request", async () => {
		let authResource = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl:
					"https://provider.example/authorize?resource=https%3A%2F%2Fauth-url-resource.example%2Fmcp",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				resource: "https://config-resource.example/mcp",
				callbackPort: 14573,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					authResource = authUrl.searchParams.get("resource") ?? "";
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(`${redirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(authResource).toBe("https://auth-url-resource.example/mcp");
		expect(tokenParams.get("resource")).toBe("https://auth-url-resource.example/mcp");
	});

	it("uses exact redirectUri and clientSecret for provider requests", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort: 14568,
				callbackPath: "slack/oauth_redirect",
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(
							`http://localhost:14568/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("client_secret")).toBe("client-secret");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("preserves root redirectUri values without adding a trailing slash", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				redirectUri: "https://public.example",
				callbackPort: 14571,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(`http://localhost:14571/?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("supports https loopback redirectUri values behind a separate local callback port", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://localhost:3443/slack/oauth_redirect",
				callbackPort: 14570,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(
							`http://localhost:14570/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("rejects https loopback redirectUri values without a separate callback port", () => {
		expect(
			() =>
				new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						issuer: TEST_ISSUER,
						tokenUrl: "https://provider.example/token",
						redirectUri: "https://localhost:3000/slack/oauth_redirect",
					},
					{},
				),
		).toThrow("HTTPS loopback redirect URIs require oauth.callbackPort");
	});

	it("listens on the implied port for exact HTTP loopback redirectUri values", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			expect(options.port).toBe(80);
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 80 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
	});

	it("listens on the explicit port for exact HTTP loopback redirectUri values", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			expect(options.port).toBe(3000);
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost:3000/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 3000 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
	});

	it("fails instead of falling back to a random port when redirectUri is exact", async () => {
		vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort: 14569,
				callbackPath: "/slack/oauth_redirect",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow("cannot fall back to a random port when oauth.redirectUri is set");
	});

	it("exposes the dynamically registered client_id and client_secret after generateAuthUrl", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				issuer: "https://www.figma.com/",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
				fetch: mockFigmaRegistration(() => {}),
			},
			{},
		);

		expect(flow.resolvedClientId).toBeUndefined();
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53173/callback");

		expect(flow.resolvedClientId).toBe("registered-client-id");
		expect(flow.registeredClientSecret).toBe("registered-client-secret");
	});

	it("returns the configured client_id from resolvedClientId without triggering registration", async () => {
		let registrationCalled = false;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "configured-client-id",
				fetch: async input => {
					registrationCalled = true;
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53174/callback");

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();
		expect(registrationCalled).toBe(false);
	});

	it("accepts pasted redirect URLs without an authorization-response issuer", async () => {
		let tokenRequestBody = "";
		let manualAuthUrl = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14570,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					manualAuthUrl = info.url;
				},
				onManualCodeInput: async () => {
					const authUrl = new URL(manualAuthUrl);

					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					return `${redirectUri}?code=manual-code&state=${encodeURIComponent(state)}`;
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(credentials.access).toBe("access-token");
		expect(tokenParams.get("code")).toBe("manual-code");
	});

	it("accepts a matching authorization-response issuer from the loopback callback", async () => {
		let tokenCalls = 0;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14590,
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(
							`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(TEST_ISSUER)}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await expect(flow.login()).resolves.toMatchObject({ access: "access-token" });
		expect(tokenCalls).toBe(1);
	});

	it("rejects a mismatching loopback issuer before making a token request", async () => {
		let tokenCalls = 0;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14591,
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void completeLocalOAuthCallback(
							`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}&iss=https%3A%2F%2Fattacker.example%2F`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await expect(flow.login()).rejects.toThrow("Authorization response issuer mismatch");
		expect(tokenCalls).toBe(0);
	});

	it("rejects an absent issuer before token exchange when AS metadata requires it", async () => {
		let tokenCalls = 0;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				authorizationResponseIssuerRequired: true,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{},
		);

		await expect(flow.exchangeToken("code", "state", "http://localhost/callback")).rejects.toThrow(
			"missing required issuer",
		);
		expect(tokenCalls).toBe(0);
	});

	it("preserves the issuer source string for exact authorization-response comparison", async () => {
		let tokenCalls = 0;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: "https://issuer.example",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{},
		);

		await expect(
			flow.exchangeToken("code", "state", "http://localhost/callback", "https://issuer.example/"),
		).rejects.toThrow("Authorization response issuer mismatch");
		expect(tokenCalls).toBe(0);
	});

	it("accepts a matching authorization-response issuer from pasted input", async () => {
		let tokenCalls = 0;
		let manualAuthUrl = "";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14592,
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{
				onAuth: info => {
					manualAuthUrl = info.url;
				},
				onManualCodeInput: async () => {
					const authUrl = new URL(manualAuthUrl);
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					return `${redirectUri}?code=manual-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(TEST_ISSUER)}`;
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await expect(flow.login()).resolves.toMatchObject({ access: "access-token" });
		expect(tokenCalls).toBe(1);
	});

	it("rejects a mismatching pasted issuer before making a token request", async () => {
		let tokenCalls = 0;
		let manualAuthUrl = "";
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14593,
				fetch: mockProviderTokenEndpoint(() => {
					tokenCalls++;
				}),
			},
			{
				onAuth: info => {
					manualAuthUrl = info.url;
				},
				onManualCodeInput: async () => {
					const authUrl = new URL(manualAuthUrl);
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					return `${redirectUri}?code=manual-code&state=${encodeURIComponent(state)}&iss=https%3A%2F%2Fattacker.example%2F`;
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await expect(flow.login()).rejects.toThrow("Authorization response issuer mismatch");
		expect(tokenCalls).toBe(0);
	});

	it("sends MCP resource indicator when refreshing tokens", async () => {
		let tokenRequestBody = "";

		const credentials = await refreshMCPOAuthToken(
			"https://provider.example/token",
			"refresh-token",
			"client-id",
			"client-secret",
			"https://mcp.example.com/mcp",
			{
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
		);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(credentials.access).toBe("access-token");
		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("resource")).toBe("https://mcp.example.com/mcp");
	});
	it("keeps the legacy refresh options position when no resource is provided", async () => {
		let tokenRequestBody = "";

		await refreshMCPOAuthToken("https://provider.example/token", "refresh-token", undefined, undefined, {
			fetch: mockProviderTokenEndpoint(body => {
				tokenRequestBody = body;
			}),
		});
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("resource")).toBeNull();
	});
	describe("RFC 8707 resource indicator", () => {
		// Provider-advertised resource indicators are authoritative, including
		// origin-only values. Plane's fallback-resource case opts into
		// same-origin stripping separately.

		const REDIRECT_URI = "http://127.0.0.1:14580/callback";

		async function buildFlow(config: {
			authorizationUrl: string;
			resource?: string;
			onTokenBody?: (body: string) => void;
			stripSameOriginResource?: boolean;
		}): Promise<MCPOAuthFlow> {
			return new MCPOAuthFlow(
				{
					authorizationUrl: config.authorizationUrl,
					issuer: `${new URL(config.authorizationUrl).origin}/`,
					tokenUrl: "https://provider.example/token",
					clientId: "client-id",
					resource: config.resource,
					stripSameOriginResource: config.stripSameOriginResource,
					callbackPort: 14580,
					fetch: mockProviderTokenEndpoint(body => config.onTokenBody?.(body)),
				},
				{},
			);
		}

		it("keeps advertised resource from generateAuthUrl when it equals the authorization-server origin", async () => {
			const flow = await buildFlow({
				authorizationUrl: "https://gateway.example.com/authorize",
				resource: "https://gateway.example.com",
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);

			expect(new URL(url).searchParams.get("resource")).toBe("https://gateway.example.com");
			expect(flow.resource).toBe("https://gateway.example.com");
		});
		it("keeps advertised resource from generateAuthUrl when it equals the auth-server origin with trailing slash", async () => {
			const flow = await buildFlow({
				authorizationUrl: "https://gateway.example.com/authorize",
				resource: "https://gateway.example.com/",
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);

			expect(new URL(url).searchParams.get("resource")).toBe("https://gateway.example.com/");
			expect(flow.resource).toBe("https://gateway.example.com/");
		});

		it("keeps an origin-only resource that was pre-populated on the authorization URL", async () => {
			const flow = await buildFlow({
				authorizationUrl: "https://gateway.example.com/authorize?resource=https%3A%2F%2Fgateway.example.com",
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);

			expect(new URL(url).searchParams.get("resource")).toBe("https://gateway.example.com");
			expect(flow.resource).toBe("https://gateway.example.com");
		});

		it("omits resource from the matching token-exchange request when fallback origin is stripped from authorize", async () => {
			// RFC 8707 §2.2 requires the token request's resource indicator to
			// match the authorize request — so stripping in one mandates the
			// other.
			let tokenRequestBody = "";
			const flow = await buildFlow({
				authorizationUrl: "https://mcp.plane.so/authorize",
				resource: "https://mcp.plane.so",
				stripSameOriginResource: true,
				onTokenBody: body => {
					tokenRequestBody = body;
				},
			});

			await flow.generateAuthUrl("state-x", REDIRECT_URI);
			await flow.exchangeToken("test-code", "state-x", REDIRECT_URI);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBeNull();
		});

		it("keeps a discovered path-scoped resource under the auth-server origin", async () => {
			let tokenRequestBody = "";
			const flow = await buildFlow({
				authorizationUrl: "https://gateway.example.com/authorize",
				resource: "https://gateway.example.com/my-service/mcp",
				onTokenBody: body => {
					tokenRequestBody = body;
				},
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);
			await flow.exchangeToken("test-code", "state-x", REDIRECT_URI);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(new URL(url).searchParams.get("resource")).toBe("https://gateway.example.com/my-service/mcp");
			expect(flow.resource).toBe("https://gateway.example.com/my-service/mcp");
			expect(tokenParams.get("resource")).toBe("https://gateway.example.com/my-service/mcp");
		});

		it("keeps a path-scoped resource embedded in the authorization URL even when the caller resource is fallback", async () => {
			let tokenRequestBody = "";
			const flow = await buildFlow({
				authorizationUrl:
					"https://gateway.example.com/authorize?resource=https%3A%2F%2Fgateway.example.com%2Fsvc%2Fmcp",
				resource: "https://gateway.example.com",
				stripSameOriginResource: true,
				onTokenBody: body => {
					tokenRequestBody = body;
				},
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);
			await flow.exchangeToken("test-code", "state-x", REDIRECT_URI);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(new URL(url).searchParams.get("resource")).toBe("https://gateway.example.com/svc/mcp");
			expect(flow.resource).toBe("https://gateway.example.com/svc/mcp");
			expect(tokenParams.get("resource")).toBe("https://gateway.example.com/svc/mcp");
		});

		it("strips a fallback server URL resource when it points at a path under the auth-server origin", async () => {
			let tokenRequestBody = "";
			const flow = await buildFlow({
				authorizationUrl: "https://mcp.plane.so/authorize",
				resource: "https://mcp.plane.so/http/mcp",
				stripSameOriginResource: true,
				onTokenBody: body => {
					tokenRequestBody = body;
				},
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);
			await flow.exchangeToken("test-code", "state-x", REDIRECT_URI);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(new URL(url).searchParams.get("resource")).toBeNull();
			expect(flow.resource).toBeUndefined();
			expect(tokenParams.get("resource")).toBeNull();
		});

		it("keeps the resource when it points at a different host than the auth server", async () => {
			const flow = await buildFlow({
				authorizationUrl: "https://auth.example.com/authorize",
				resource: "https://api.example.com",
			});

			const { url } = await flow.generateAuthUrl("state-x", REDIRECT_URI);

			expect(new URL(url).searchParams.get("resource")).toBe("https://api.example.com");
			expect(flow.resource).toBe("https://api.example.com");
		});
	});

	describe("RFC 8707 resource indicator (refresh)", () => {
		// Regression for the review on PR #3503: fallback resources derived from
		// `config.url` may be redundant for Plane and should be stripped, but
		// provider-advertised origin-only/path-scoped resources are
		// authoritative. Refresh must mirror the same provenance policy while
		// filtering against the original authorization-server origin (falling
		// back to `tokenUrl` for legacy credentials).

		function mockArbitraryTokenEndpoint(targetUrl: string, onBody: (body: string) => void): FetchImpl {
			return async (input, init) => {
				const url = String(input);
				if (url === targetUrl) {
					onBody(String(init?.body ?? ""));
					return new Response(
						JSON.stringify({
							access_token: "access-token",
							refresh_token: "refresh-token",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected fetch: ${url}`);
			};
		}

		it("keeps an advertised refresh resource that equals the token-server origin", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://gateway.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://gateway.example.com",
				{
					fetch: mockArbitraryTokenEndpoint("https://gateway.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBe("https://gateway.example.com");
		});

		it("keeps an advertised refresh resource that equals the token-server origin with trailing slash", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://gateway.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://gateway.example.com/",
				{
					fetch: mockArbitraryTokenEndpoint("https://gateway.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBe("https://gateway.example.com/");
		});

		it("keeps an advertised refresh resource that points at a path under the token-server origin", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://gateway.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://gateway.example.com/my-service/mcp",
				{
					fetch: mockArbitraryTokenEndpoint("https://gateway.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBe("https://gateway.example.com/my-service/mcp");
		});

		it("strips a fallback refresh resource that equals the token-server origin", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://mcp.plane.so/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://mcp.plane.so",
				{
					stripSameOriginResource: true,
					fetch: mockArbitraryTokenEndpoint("https://mcp.plane.so/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBeNull();
		});

		it("strips a fallback refresh resource that points at a path under the token-server origin", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://mcp.plane.so/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://mcp.plane.so/http/mcp",
				{
					stripSameOriginResource: true,
					fetch: mockArbitraryTokenEndpoint("https://mcp.plane.so/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBeNull();
		});
		it("strips a fallback refresh resource that equals the authorization-server origin even when token endpoint lives on a different origin", async () => {
			// Cross-origin case: RFC 8414 permits authorize and token endpoints
			// on separate origins. Fallback resources filter against
			// `authorizationUrl`, so `tokenUrl`'s origin cannot stand in for the
			// auth-server origin. (Issue #3502 review #2.)
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://token.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://auth.example.com",
				{
					authorizationUrl: "https://auth.example.com/authorize",
					stripSameOriginResource: true,
					fetch: mockArbitraryTokenEndpoint("https://token.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBeNull();
		});

		it("keeps a refresh resource that points at a third origin when authorizationUrl is supplied", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://token.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://api.example.com",
				{
					authorizationUrl: "https://auth.example.com/authorize",
					fetch: mockArbitraryTokenEndpoint("https://token.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBe("https://api.example.com");
		});

		it("preserves tokenUrl-origin resources for legacy direct refresh calls without fallback provenance", async () => {
			let tokenRequestBody = "";

			await refreshMCPOAuthToken(
				"https://token.example.com/token",
				"refresh-token",
				"client-id",
				undefined,
				"https://token.example.com",
				{
					fetch: mockArbitraryTokenEndpoint("https://token.example.com/token", body => {
						tokenRequestBody = body;
					}),
				},
			);
			const tokenParams = new URLSearchParams(tokenRequestBody);

			expect(tokenParams.get("resource")).toBe("https://token.example.com");
		});
	});

	it("exposes authorizationUrl via a getter so callers can persist it on the credential", () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://auth.example.com/authorize",
				issuer: TEST_ISSUER,
				tokenUrl: "https://token.example.com/token",
				clientId: "client-id",
			},
			{},
		);

		expect(flow.authorizationUrl).toBe("https://auth.example.com/authorize");
	});
});
describe("Exa/Websets direct modern requests", () => {
	it("sends 2026-07-28 protocol version in _meta and HTTP headers for direct requests", async () => {
		const globalFetch = globalThis.fetch;
		const capturedRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("mcp.exa.ai") || url.includes("websetsmcp.exa.ai")) {
				const headers = new Headers(init?.headers);
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				capturedRequests.push({ url, headers, body });
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							tools: [{ name: "web_search", description: "Search the web" }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return globalFetch(input, init);
		}) as typeof fetch;

		try {
			const tools = await fetchExaTools("test-api-key", ["web_search"]);
			expect(tools).toHaveLength(1);
			expect(capturedRequests).toHaveLength(1);

			const request = capturedRequests[0];
			expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
			expect(request.headers.get("mcp-method")).toBe("tools/list");
			expect(request.body.method).toBe("tools/list");

			const params = request.body.params as { _meta?: Record<string, unknown> };
			expect(params._meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			});
		} finally {
			globalThis.fetch = globalFetch;
		}
	});
});
