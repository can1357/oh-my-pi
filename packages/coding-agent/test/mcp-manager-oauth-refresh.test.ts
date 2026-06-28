/**
 * Regression tests for MCP OAuth refresh failure handling (issue #1908).
 *
 * Before the fix, a refresh that came back with `invalid_grant` was logged and
 * the stale access token was re-attached as `Authorization: Bearer …` on every
 * subsequent MCP request — producing a permanent 401 / reauth loop until the
 * user hand-cleared the row in `agent.db`. The fix routes definitive failures
 * (`invalid_grant`, `invalid_token`, `revoked`, plain 401/403 not classified as
 * transient) through `AuthStorage.remove(credentialId)` and suppresses the
 * Bearer injection, so the next request surfaces a clean auth error instead.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai";
import { MCPManager } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@pk-nerdsaver-ai/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";

const CREDENTIAL_ID = "mcp_oauth_test_1908";
const TOKEN_URL = "https://example.com/oauth/token";
const STALE_ACCESS = "stale-access-token";
const STALE_REFRESH = "stale-refresh-token";

/** Build a `Headers` snapshot from a prepared MCP config. */
function getAuthorizationHeader(config: MCPServerConfig): string | undefined {
	if (config.type !== "http" && config.type !== "sse") return undefined;
	return config.headers?.Authorization;
}

describe("MCPManager OAuth refresh failure", () => {
	let manager: MCPManager;
	let authStorage: AuthStorage;
	let serverConfig: MCPServerConfig;

	beforeEach(async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();

		// Seed an expired credential so `#resolveAuthConfig` decides to refresh
		// (a non-expired credential takes the no-refresh branch and never reaches
		// the bug).
		await authStorage.set(CREDENTIAL_ID, {
			type: "oauth",
			access: STALE_ACCESS,
			refresh: STALE_REFRESH,
			expires: Date.now() - 60_000,
		});

		manager = new MCPManager(process.cwd());
		manager.setAuthStorage(authStorage);

		serverConfig = {
			type: "http",
			url: "https://logfire.example.com/mcp",
			auth: {
				type: "oauth",
				credentialId: CREDENTIAL_ID,
				tokenUrl: TOKEN_URL,
			},
		};
	});

	afterEach(() => {
		authStorage.close();
		vi.restoreAllMocks();
	});

	test("clears the credential and skips Bearer injection on invalid_grant", async () => {
		const refreshSpy = vi
			.spyOn(oauthFlow, "refreshMCPOAuthToken")
			.mockRejectedValue(
				new Error(
					'MCP OAuth refresh failed: 400 {"error":"invalid_grant","error_description":"Refresh token has been revoked"}',
				),
			);

		const prepared = await manager.prepareConfig(serverConfig);

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith(
			TOKEN_URL,
			STALE_REFRESH,
			undefined,
			undefined,
			"https://logfire.example.com/mcp",
			{ authorizationUrl: undefined, stripSameOriginResource: true },
		);
		// The poisoned Bearer must not be re-injected — that is the loop the user
		// reported (#1908).
		expect(getAuthorizationHeader(prepared)).toBeUndefined();
		// The credential row is gone so neither this nor a future session keeps
		// shipping the dead refresh token.
		expect(authStorage.get(CREDENTIAL_ID)).toBeUndefined();
	});

	test("clears the credential when the token endpoint replies HTTP 401", async () => {
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error("MCP OAuth refresh failed: 401 Unauthorized"),
		);

		const prepared = await manager.prepareConfig(serverConfig);

		expect(getAuthorizationHeader(prepared)).toBeUndefined();
		expect(authStorage.get(CREDENTIAL_ID)).toBeUndefined();
	});

	test("keeps the credential and falls back to the existing token on transient failure", async () => {
		// Network blip during refresh — the access token may still be live, so
		// we preserve the prior behavior of one best-effort attempt with what we
		// already have rather than tearing down the credential.
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockRejectedValue(
			new Error("MCP OAuth refresh failed: fetch failed ECONNREFUSED 127.0.0.1:443"),
		);

		const prepared = await manager.prepareConfig(serverConfig);

		expect(getAuthorizationHeader(prepared)).toBe(`Bearer ${STALE_ACCESS}`);
		const remaining = authStorage.get(CREDENTIAL_ID);
		expect(remaining?.type).toBe("oauth");
	});

	test("persists rotated credential on successful refresh", async () => {
		// Sanity: the happy path still rotates the row and attaches the fresh
		// Bearer. Guards against accidentally short-circuiting refresh while
		// fixing the failure path.
		vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const prepared = await manager.prepareConfig(serverConfig);

		expect(getAuthorizationHeader(prepared)).toBe("Bearer fresh-access");
		const remaining = authStorage.get(CREDENTIAL_ID);
		expect(remaining).toMatchObject({ type: "oauth", access: "fresh-access", refresh: "fresh-refresh" });
	});
});
