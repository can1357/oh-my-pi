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
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CREDENTIAL_ID = "mcp_oauth_test_1908";
const TOKEN_URL = "https://example.com/oauth/token";
const STALE_ACCESS = "stale-access-token";
const STALE_REFRESH = "stale-refresh-token";

const SHARED_CREDENTIAL_ID = "mcp_oauth_test_5081";
const SHARED_STALE_ACCESS = "access-0";
const SHARED_STALE_REFRESH = "refresh-0";
const SHARED_FRESH_ACCESS = "access-1";
const SHARED_FRESH_REFRESH = "refresh-1";

/** Build a `Headers` snapshot from a prepared MCP config. */
function getAuthorizationHeader(config: MCPServerConfig): string | undefined {
	if (config.type !== "http" && config.type !== "sse") return undefined;
	return config.headers?.Authorization;
}

type ControlledSleep = {
	ms: number;
	resolved: boolean;
	resolve: () => void;
};

function installControlledBunSleep(): ControlledSleep[] {
	const calls: ControlledSleep[] = [];
	vi.spyOn(Bun, "sleep").mockImplementation((ms: number | Date) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const delayMs = typeof ms === "number" ? ms : Math.max(0, ms.getTime() - Date.now());
		const call = {
			ms: delayMs,
			resolved: false,
			resolve: () => {
				if (call.resolved) return;
				call.resolved = true;
				resolve();
			},
		};
		calls.push(call);
		return promise;
	});
	return calls;
}

async function drainMicrotasks(count = 10): Promise<void> {
	for (let attempt = 0; attempt < count; attempt++) {
		await Promise.resolve();
	}
}

async function waitForControlledSleep(calls: ControlledSleep[], ms: number): Promise<ControlledSleep> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const call = calls.find(candidate => !candidate.resolved && candidate.ms === ms);
		if (call) return call;
		await Promise.resolve();
	}
	throw new Error(`Timed out waiting for Bun.sleep(${ms})`);
}

function resolvePendingControlledSleeps(calls: ControlledSleep[]): void {
	for (const call of calls) {
		if (!call.resolved) call.resolve();
	}
}

async function withSharedSQLiteAuth<T>(
	fn: (context: {
		authA: AuthStorage;
		authB: AuthStorage;
		storeA: SqliteAuthCredentialStore;
		storeB: SqliteAuthCredentialStore;
	}) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-oauth-shared-refresh-"));
	let authA: AuthStorage | undefined;
	let authB: AuthStorage | undefined;
	try {
		const dbPath = path.join(tempDir, "agent.db");
		const storeA = await SqliteAuthCredentialStore.open(dbPath);
		const storeB = await SqliteAuthCredentialStore.open(dbPath);
		authA = new AuthStorage(storeA);
		authB = new AuthStorage(storeB);
		await authA.reload();
		await authB.reload();
		return await fn({ authA, authB, storeA, storeB });
	} finally {
		authA?.close();
		authB?.close();
		await removeWithRetries(tempDir);
	}
}

describe("MCPManager OAuth refresh failure", () => {
	let manager: MCPManager;
	let authStorage: AuthStorage;
	let store: SqliteAuthCredentialStore;
	let serverConfig: MCPServerConfig;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
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
		vi.useRealTimers();
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
			{ authorizationUrl: undefined, stripSameOriginResource: true, signal: expect.any(AbortSignal) },
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

	test("aborts a timed-out token fetch and waits for it before releasing refresh ownership", async () => {
		vi.useFakeTimers();
		const fetchCalled = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const allowFetchReject = Promise.withResolvers<void>();
		let capturedSignal: AbortSignal | undefined;
		let preparedSettled = false;
		const releaseSpy = vi.spyOn(store, "releaseCredentialRefreshLease");
		const fetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				capturedSignal = init?.signal ?? undefined;
				if (!capturedSignal) throw new Error("token refresh fetch did not receive an AbortSignal");
				fetchCalled.resolve();
				capturedSignal.addEventListener(
					"abort",
					() => {
						abortObserved.resolve();
					},
					{ once: true },
				);
				await allowFetchReject.promise;
				throw capturedSignal.reason ?? new Error("fetch aborted");
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

		const prepared = manager.prepareConfig(serverConfig).finally(() => {
			preparedSettled = true;
		});
		await fetchCalled.promise;
		expect(capturedSignal).toBeDefined();

		vi.advanceTimersByTime(9_999);
		await drainMicrotasks();
		expect(capturedSignal!.aborted).toBe(false);
		expect(preparedSettled).toBe(false);
		expect(releaseSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await abortObserved.promise;
		expect(capturedSignal!.aborted).toBe(true);
		await drainMicrotasks();
		expect(preparedSettled).toBe(false);
		expect(releaseSpy).not.toHaveBeenCalled();

		allowFetchReject.resolve();
		const preparedConfig = await prepared;

		expect(preparedSettled).toBe(true);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(getAuthorizationHeader(preparedConfig)).toBe(`Bearer ${STALE_ACCESS}`);
	});
});

describe("MCPManager shared SQLite OAuth refresh", () => {
	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
	});

	test("renews refresh ownership while the token endpoint is blocked", async () => {
		await withSharedSQLiteAuth(async ({ authA, authB, storeA }) => {
			const startMs = Date.parse("2026-07-10T12:00:00.000Z");
			setSystemTime(new Date(startMs));
			const sleeps = installControlledBunSleep();
			const renewSpy = vi.spyOn(storeA, "renewCredentialRefreshLease");

			await authA.set(SHARED_CREDENTIAL_ID, {
				type: "oauth",
				access: SHARED_STALE_ACCESS,
				refresh: SHARED_STALE_REFRESH,
				expires: startMs - 60_000,
			});
			await authB.reload();

			const refreshStarted = Promise.withResolvers<void>();
			const allowRefreshResponse = Promise.withResolvers<void>();
			const refreshTokens: string[] = [];
			let refreshRequests = 0;
			const tokenServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					if (req.method !== "POST" || new URL(req.url).pathname !== "/token") {
						return new Response("not found", { status: 404 });
					}
					refreshRequests += 1;
					const body = new URLSearchParams(await req.text());
					refreshTokens.push(body.get("refresh_token") ?? "");
					if (refreshRequests === 1) {
						refreshStarted.resolve();
						await allowRefreshResponse.promise;
						return Response.json({
							access_token: SHARED_FRESH_ACCESS,
							refresh_token: SHARED_FRESH_REFRESH,
							expires_in: 3600,
						});
					}
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				},
			});
			try {
				const managerA = new MCPManager(process.cwd());
				managerA.setAuthStorage(authA);
				const managerB = new MCPManager(process.cwd());
				managerB.setAuthStorage(authB);
				const config: MCPServerConfig = {
					type: "http",
					url: "https://logfire.example.com/mcp",
					auth: {
						type: "oauth",
						credentialId: SHARED_CREDENTIAL_ID,
						tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
					},
				};

				const preparedA = managerA.prepareConfig(config);
				await refreshStarted.promise;
				const renewalSleep = await waitForControlledSleep(sleeps, 5_000);

				setSystemTime(new Date(startMs + 5_000));
				renewalSleep.resolve();
				await drainMicrotasks();
				expect(renewSpy).toHaveBeenCalledTimes(1);

				setSystemTime(new Date(startMs + 16_000));
				const preparedB = managerB.prepareConfig(config);
				const peerLeaseWait = await waitForControlledSleep(sleeps, 250);

				expect(refreshRequests).toBe(1);
				expect(refreshTokens).toEqual([SHARED_STALE_REFRESH]);

				allowRefreshResponse.resolve();
				const resolvedA = await preparedA;
				peerLeaseWait.resolve();
				const resolvedB = await preparedB;

				expect(getAuthorizationHeader(resolvedA)).toBe(`Bearer ${SHARED_FRESH_ACCESS}`);
				expect(getAuthorizationHeader(resolvedB)).toBe(`Bearer ${SHARED_FRESH_ACCESS}`);
				expect(refreshRequests).toBe(1);
				expect(refreshTokens).toEqual([SHARED_STALE_REFRESH]);
			} finally {
				resolvePendingControlledSleeps(sleeps);
				tokenServer.stop(true);
			}
		});
	});
	test("shares refresh ownership so peer managers do not replay a rotating refresh token", async () => {
		await withSharedSQLiteAuth(async ({ authA, authB }) => {
			await authA.set(SHARED_CREDENTIAL_ID, {
				type: "oauth",
				access: SHARED_STALE_ACCESS,
				refresh: SHARED_STALE_REFRESH,
				expires: Date.now() - 60_000,
			});
			await authB.reload();

			const refreshStarted = Promise.withResolvers<void>();
			const allowRefreshResponse = Promise.withResolvers<void>();
			const refreshTokens: string[] = [];
			let refreshRequests = 0;
			const tokenServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					if (req.method !== "POST" || new URL(req.url).pathname !== "/token") {
						return new Response("not found", { status: 404 });
					}
					refreshRequests += 1;
					const body = new URLSearchParams(await req.text());
					refreshTokens.push(body.get("refresh_token") ?? "");
					if (refreshRequests === 1) {
						refreshStarted.resolve();
						await allowRefreshResponse.promise;
						return Response.json({
							access_token: SHARED_FRESH_ACCESS,
							refresh_token: SHARED_FRESH_REFRESH,
							expires_in: 3600,
						});
					}
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				},
			});
			try {
				const managerA = new MCPManager(process.cwd());
				managerA.setAuthStorage(authA);
				const managerB = new MCPManager(process.cwd());
				managerB.setAuthStorage(authB);
				const config: MCPServerConfig = {
					type: "http",
					url: "https://logfire.example.com/mcp",
					auth: {
						type: "oauth",
						credentialId: SHARED_CREDENTIAL_ID,
						tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
					},
				};

				const preparedA = managerA.prepareConfig(config);
				await refreshStarted.promise;
				const preparedB = managerB.prepareConfig(config);
				allowRefreshResponse.resolve();

				const [resolvedA, resolvedB] = await Promise.all([preparedA, preparedB]);

				expect(refreshRequests).toBe(1);
				expect(refreshTokens).toEqual([SHARED_STALE_REFRESH]);
				expect(getAuthorizationHeader(resolvedA)).toBe(`Bearer ${SHARED_FRESH_ACCESS}`);
				expect(getAuthorizationHeader(resolvedB)).toBe(`Bearer ${SHARED_FRESH_ACCESS}`);

				await authA.reload();
				const canonical = authA.get(SHARED_CREDENTIAL_ID);
				expect(canonical).toMatchObject({
					type: "oauth",
					access: SHARED_FRESH_ACCESS,
					refresh: SHARED_FRESH_REFRESH,
				});
			} finally {
				tokenServer.stop(true);
			}
		});
	});

	test("keeps the peer-rotated credential when a stale refresh attempt returns invalid_grant", async () => {
		await withSharedSQLiteAuth(async ({ authA, authB, storeB }) => {
			await authA.set(SHARED_CREDENTIAL_ID, {
				type: "oauth",
				access: SHARED_STALE_ACCESS,
				refresh: SHARED_STALE_REFRESH,
				expires: Date.now() - 60_000,
			});
			await authB.reload();
			const storedBefore = storeB.listAuthCredentials(SHARED_CREDENTIAL_ID);
			expect(storedBefore).toHaveLength(1);
			const rowId = storedBefore[0]!.id;

			const refreshStarted = Promise.withResolvers<void>();
			const allowInvalidGrant = Promise.withResolvers<void>();
			const refreshTokens: string[] = [];
			let refreshRequests = 0;
			const tokenServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					if (req.method !== "POST" || new URL(req.url).pathname !== "/token") {
						return new Response("not found", { status: 404 });
					}
					refreshRequests += 1;
					const body = new URLSearchParams(await req.text());
					refreshTokens.push(body.get("refresh_token") ?? "");
					refreshStarted.resolve();
					await allowInvalidGrant.promise;
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				},
			});
			try {
				const managerA = new MCPManager(process.cwd());
				managerA.setAuthStorage(authA);
				const config: MCPServerConfig = {
					type: "http",
					url: "https://logfire.example.com/mcp",
					auth: {
						type: "oauth",
						credentialId: SHARED_CREDENTIAL_ID,
						tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
					},
				};

				const prepared = managerA.prepareConfig(config);
				await refreshStarted.promise;
				storeB.updateAuthCredential(rowId, {
					type: "oauth",
					access: SHARED_FRESH_ACCESS,
					refresh: SHARED_FRESH_REFRESH,
					expires: Date.now() + 60 * 60_000,
				});
				allowInvalidGrant.resolve();

				const resolved = await prepared;

				expect(refreshRequests).toBe(1);
				expect(refreshTokens).toEqual([SHARED_STALE_REFRESH]);
				expect(getAuthorizationHeader(resolved)).toBe(`Bearer ${SHARED_FRESH_ACCESS}`);

				await authA.reload();
				const canonical = authA.get(SHARED_CREDENTIAL_ID);
				expect(canonical).toMatchObject({
					type: "oauth",
					access: SHARED_FRESH_ACCESS,
					refresh: SHARED_FRESH_REFRESH,
				});
				expect(storeB.listAuthCredentials(SHARED_CREDENTIAL_ID)).toHaveLength(1);
			} finally {
				tokenServer.stop(true);
			}
		});
	});
});
