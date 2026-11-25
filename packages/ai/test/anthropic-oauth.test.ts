import { afterEach, describe, expect, it, vi } from "bun:test";
import { mergeRefreshedCredential } from "@oh-my-pi/pi-ai/auth/refresh";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth/types";
import { isDefinitiveOAuthFailure } from "@oh-my-pi/pi-ai/error";
import { claudeCodeAxiosVersion, getClaudeCodeVersion } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	buildAnthropicAuthConfig,
	buildAnthropicSearchHeaders,
	buildAnthropicUrl,
} from "@oh-my-pi/pi-ai/utils/anthropic-auth";
import { withEnv } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

async function loginAnthropic(fetchImpl: FetchImpl, manualCode = "code-123") {
	let authUrl = "";
	const callbacks: OAuthController = {
		onAuth: info => {
			authUrl = info.url;
		},
		onManualCodeInput: async () => {
			const state = new URL(authUrl).searchParams.get("state");
			return `${manualCode}#${state}`;
		},
		fetch: fetchImpl,
	};
	const result = await getProviderDefinition("anthropic")?.login?.(callbacks);
	if (!result || typeof result === "string") throw new Error("expected structured credentials");
	return { result, authUrl };
}

async function refreshAnthropic(credentials: OAuthCredentials) {
	const refresh = getProviderDefinition("anthropic")?.refreshToken;
	if (!refresh) throw new Error("anthropic refresh is unavailable");
	return refresh(credentials);
}

describe("anthropic oauth alignment", () => {
	it("generates the expected authorize URL and exchanges through api.anthropic.com", async () => {
		const fetchMock: FetchImpl = vi.fn(async input => {
			expect(String(input)).toBe("https://api.anthropic.com/v1/oauth/token");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					refresh_token_expires_in: 2_592_000,
					account: { uuid: "account-id", email_address: "user@example.com" },
					organization: { uuid: "org-id", name: "Team Workspace" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const before = Date.now();
		const { result, authUrl } = await loginAnthropic(fetchMock);
		expect(result.refreshExpires).toBeGreaterThanOrEqual(before + 2_592_000_000);
		const authorize = new URL(authUrl);

		expect(authorize.origin + authorize.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(authorize.searchParams.get("scope")).toBe(
			"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(result).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
			accountId: "account-id",
			email: "user@example.com",
			orgId: "org-id",
			orgName: "Team Workspace",
		});
	});

	it("refreshes like Claude Code, keeps the server's expiry, and omits response organization drift", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
					const headers = new Headers(init?.headers);
					expect(headers.get("anthropic-beta")).toBeNull();
					expect(headers.get("Accept")).toBe("application/json, text/plain, */*");
					expect(headers.get("User-Agent")).toBe(`axios/${claudeCodeAxiosVersion}`);
					expect(init?.body).toBe(
						JSON.stringify({
							grant_type: "refresh_token",
							refresh_token: "refresh-123",
							client_id: atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"),
							scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
						}),
					);
					return new Response(
						JSON.stringify({
							access_token: "new-access-token",
							refresh_token: "new-refresh-token",
							expires_in: 7200,
							account: { uuid: "new-account", email_address: "refreshed@example.com" },
							organization: { uuid: "drifted-org", name: "Drifted Org" },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		const before = Date.now();
		const result = await refreshAnthropic({
			access: "old-access",
			refresh: "refresh-123",
			expires: 0,
			orgId: "stored-org",
			orgName: "Stored Org",
		});

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		// Stored as reported; the 5-minute renewal window applies when it is read.
		expect(result.expires).toBeGreaterThanOrEqual(before + 7_200_000);
		expect(result.accountId).toBe("new-account");
		expect(result.email).toBe("refreshed@example.com");
		expect(result.orgId).toBeUndefined();
		expect(result.orgName).toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps the login-stated grant end unless a refresh reports an earlier one", () => {
		const stored: OAuthCredential = { type: "oauth", access: "a", refresh: "r", expires: 0 };
		const refreshed = (refreshExpires?: number) => ({ access: "a2", refresh: "r2", expires: 1, refreshExpires });
		// No end stated at login: a refresh's per-rotation lifetime does not become one.
		expect(mergeRefreshedCredential(stored, refreshed(500)).refreshExpires).toBeUndefined();
		expect(mergeRefreshedCredential({ ...stored, refreshExpires: 1_000 }, refreshed(2_000)).refreshExpires).toBe(
			1_000,
		);
		expect(mergeRefreshedCredential({ ...stored, refreshExpires: 1_000 }, refreshed(500)).refreshExpires).toBe(500);
		expect(mergeRefreshedCredential({ ...stored, refreshExpires: 1_000 }, refreshed()).refreshExpires).toBe(1_000);
	});

	it("retries a scope-refused refresh without asking for scopes", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)));
					if (bodies.length === 1)
						return new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 });
					return new Response(
						JSON.stringify({
							access_token: "scoped-down-access",
							refresh_token: "next-refresh",
							expires_in: 3600,
							account: { uuid: "account-id", email_address: "user@example.com" },
						}),
						{ status: 200 },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const result = await refreshAnthropic({ access: "old-access", refresh: "old-refresh", expires: 0 });
		expect(result.access).toBe("scoped-down-access");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toHaveProperty("scope");
		expect(bodies[1]).not.toHaveProperty("scope");
	});

	it("judges only a refused grant that is not an account hold as dead", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const cases = [
			{ status: 400, body: { error: "invalid_grant", error_description: "Refresh token expired" }, dead: true },
			{ status: 400, body: { error: "invalid_grant", error_description: "account_on_hold" }, dead: false },
			// A bare-401 message would read as dead to the text heuristics.
			{ status: 401, body: { error: "invalid_client" }, dead: false },
		];
		for (const { status, body, dead } of cases) {
			fetchSpy.mockImplementation(
				Object.assign(async () => new Response(JSON.stringify(body), { status }), { preconnect: fetch.preconnect }),
			);
			const error = await refreshAnthropic({ access: "a", refresh: "r", expires: 0 }).catch((err: unknown) => err);
			expect({ status, body, dead: isDefinitiveOAuthFailure(error) }).toEqual({ status, body, dead });
		}
	});

	it("fetches bootstrap identity when the token response omits identity", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "https://api.anthropic.com/v1/oauth/token") {
				return new Response(
					JSON.stringify({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			expect(url).toBe("https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8");
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer access-token");
			expect(headers.get("User-Agent")).toBe(`claude-code/${getClaudeCodeVersion()}`);
			return new Response(
				JSON.stringify({
					oauth_account: {
						account_uuid: "bootstrap-account",
						account_email: "bootstrap@example.com",
						organization_uuid: "bootstrap-org",
						organization_name: "Bootstrap Org",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const { result } = await loginAnthropic(fetchMock);
		expect(result).toMatchObject({
			accountId: "bootstrap-account",
			email: "bootstrap@example.com",
			orgId: "bootstrap-org",
			orgName: "Bootstrap Org",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("classifies sk-ant-oat tokens as OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-foobar");
		expect(config.isOAuth).toBe(true);
		expect(config.apiKey).toBe("sk-ant-oat-foobar");
	});

	it("treats sk-ant-api tokens as non-OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api-foobar");
		expect(config.isOAuth).toBe(false);
	});

	it("normalizes the explicit baseUrl override (trailing slash, env precedence)", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const explicit = buildAnthropicAuthConfig("sk-ant-api-key", "https://override.example.com/");
				expect(explicit.baseUrl).toBe("https://override.example.com");
				expect(buildAnthropicUrl(explicit)).toBe("https://override.example.com/v1/messages?beta=true");
			},
		);
	});

	it("falls back to FOUNDRY_BASE_URL when Foundry mode is enabled and no explicit override is given", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://foundry.example.com/anthropic");
			},
		);
	});

	it("falls back to ANTHROPIC_BASE_URL when Foundry mode is disabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://anthropic.example.com/",
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://anthropic.example.com");
			},
		);
	});

	it("uses the default Anthropic base URL when no env or override is set", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});
});

describe("buildAnthropicSearchHeaders", () => {
	it("forwards ANTHROPIC_CUSTOM_HEADERS when the base URL is an enterprise gateway", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://gateway.example.com",
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret, X-Route: search",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(auth.baseUrl).toBe("https://gateway.example.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["X-Gateway-Key"]).toBe("secret");
				expect(headers["X-Route"]).toBe("search");
				// Non-Anthropic base URL uses Bearer auth, not X-Api-Key.
				expect(headers.Authorization).toBe("Bearer sk-ant-api-key");
				expect(headers["X-Api-Key"]).toBeUndefined();
			},
		);
	});

	it("omits ANTHROPIC_CUSTOM_HEADERS when targeting api.anthropic.com without Foundry", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "X-Gateway-Key: secret",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(auth.baseUrl).toBe("https://api.anthropic.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["X-Gateway-Key"]).toBeUndefined();
				expect(headers["X-Api-Key"]).toBe("sk-ant-api-key");
			},
		);
	});

	it("forwards ANTHROPIC_CUSTOM_HEADERS in Foundry mode even on an Anthropic-shaped base URL", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
				ANTHROPIC_CUSTOM_HEADERS: "user-id: alice",
			},
			() => {
				const auth = buildAnthropicAuthConfig("sk-ant-api-key", "https://api.anthropic.com");
				const headers = buildAnthropicSearchHeaders(auth);
				expect(headers["user-id"]).toBe("alice");
			},
		);
	});

	it("includes the web-search beta in Anthropic-Beta", () => {
		const auth = buildAnthropicAuthConfig("sk-ant-api-key");
		const headers = buildAnthropicSearchHeaders(auth);
		expect(headers["anthropic-beta"]).toContain("web-search-2025-03-05");
	});
});
