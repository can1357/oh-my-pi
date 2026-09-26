import { describe, expect, it, vi } from "bun:test";
import { SqliteAuthCredentialStore } from "../src/auth-storage";
import { mergeRefreshedCredential } from "../src/auth/refresh";
import { buildRefreshableOauthCredential, mergeRefreshedUsageCredential } from "../src/auth/usage";
import { buildUsageCredential } from "../src/auth/usage-cache";
import { getProviderDefinition } from "../src/registry/registry";
import type { OAuthController, OAuthCredentials } from "../src/registry/oauth/types";
import type { FetchImpl } from "../src/types";

async function loginViaRegistry(ctrl: OAuthController): Promise<OAuthCredentials> {
	const result = await getProviderDefinition("factory-droid")?.login?.(ctrl);
	if (!result || typeof result === "string") throw new Error("Factory Droid login is unavailable");
	return result;
}

async function refreshViaRegistry(refreshToken: string, fetchImpl: FetchImpl): Promise<OAuthCredentials> {
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign((input: string | URL | Request, init?: RequestInit) => fetchImpl(input, init), {
			preconnect: fetch.preconnect,
		}),
	);
	try {
		const refresh = getProviderDefinition("factory-droid")?.refreshToken;
		if (!refresh) throw new Error("Factory Droid refresh is unavailable");
		return await refresh({ access: "previous", refresh: refreshToken, expires: 0 });
	} finally {
		fetchSpy.mockRestore();
	}
}

function makeJwt(claims: Record<string, unknown>): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DEVICE_AUTH = {
	device_code: "device-1",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.factory.ai/device",
	verification_uri_complete: "https://auth.factory.ai/device?user_code=ABCD-EFGH",
	expires_in: 300,
	interval: 0.05,
};

describe("Factory Droid organization identity", () => {
	it("keeps two organizations of one account and refreshes only the matching organization", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const credential = (orgId: string, access: string) => ({
			type: "oauth" as const,
			access,
			refresh: `refresh-${access}`,
			expires: Date.now() + 3600000,
			accountId: "workos-user",
			email: "shared@example.test",
			orgId,
		});
		try {
			await store.upsertAuthCredential("factory-droid", credential("org-a", "a1"));
			await store.upsertAuthCredential("factory-droid", credential("org-b", "b1"));
			const rows = await store.upsertAuthCredential("factory-droid", credential("org-a", "a2"));
			expect(
				rows.map(row => (row.credential.type === "oauth" ? [row.credential.orgId, row.credential.access] : null)),
			).toEqual([
				["org-a", "a2"],
				["org-b", "b1"],
			]);
		} finally {
			store.close();
		}
	});
});

describe("Factory Droid stored region", () => {
	it("retains residency across a failed whoami on refresh, including usage-path refresh", () => {
		const original = {
			type: "oauth" as const,
			access: "old",
			refresh: "old-refresh",
			expires: 1,
			region: "eu",
		};
		const refreshed = { access: "new", refresh: "new-refresh", expires: 2 };
		expect(mergeRefreshedCredential(original, refreshed)).toMatchObject({ region: "eu", access: "new" });
		const usage = buildUsageCredential(original);
		expect(buildRefreshableOauthCredential(usage)?.region).toBe("eu");
		expect(mergeRefreshedUsageCredential(usage, refreshed)).toMatchObject({ region: "eu", accessToken: "new" });
		expect(mergeRefreshedCredential(original, { ...refreshed, region: "global" }).region).toBe("global");
	});
});

describe("Factory Droid OAuth", () => {
	it("runs the device flow: authorize/device, user code surfacing, poll, credential mapping", async () => {
		const access = makeJwt({
			sub: "user_123",
			email: "dev@example.com",
			external_org_id: "org-ext-1",
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const calls: Array<{ url: string; body: string }> = [];
		const fetchImpl: FetchImpl = async (url, init) => {
			calls.push({ url: String(url), body: String(init?.body ?? "") });
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, { region: "eu" });
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};
		const auths: Array<{ url: string; instructions?: string }> = [];
		const ctrl: OAuthController = {
			fetch: fetchImpl,
			onAuth: info => auths.push({ url: info.url, instructions: info.instructions }),
		};

		const credentials = await loginViaRegistry(ctrl);

		expect(calls[0].url).toBe("https://api.workos.com/user_management/authorize/device");
		expect(calls[0].body).toContain("client_id=client_01HNM792M5G5G1A2THWPXKFMXB");
		expect(auths).toEqual([
			{ url: "https://auth.factory.ai/device?user_code=ABCD-EFGH", instructions: "Enter code: ABCD-EFGH" },
		]);
		const pollBody = calls[1].body;
		expect(pollBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
		expect(pollBody).toContain("device_code=device-1");
		expect(credentials.refresh).toBe("refresh-1");
		expect(credentials.access).toBe(access);
		expect(credentials.email).toBe("dev@example.com");
		expect(credentials.accountId).toBe("user_123");
		expect(credentials.orgId).toBe("org-ext-1");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		// whoami runs against the default host with the fresh access token and
		// captures the account residency region.
		expect(calls[2].url).toBe("https://api.factory.ai/api/cli/whoami");
		expect(credentials.region).toBe("eu");
	});

	it("rejects a device token response without a refresh grant", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		let whoamiCalled = false;
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) {
				whoamiCalled = true;
				return jsonResponse(200, { region: "eu" });
			}
			return jsonResponse(200, { access_token: access });
		};
		await expect(loginViaRegistry({ fetch: fetchImpl })).rejects.toThrow(/missing refresh token/);
		expect(whoamiCalled).toBe(false);
	});

	it("keeps polling through authorization_pending and slow_down", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		let polls = 0;
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, {});
			polls += 1;
			if (polls === 1) return jsonResponse(400, { error: "authorization_pending" });
			if (polls === 2) return jsonResponse(400, { error: "slow_down" });
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-2" });
		};

		const credentials = await loginViaRegistry({ fetch: fetchImpl });
		expect(polls).toBe(3);
		expect(credentials.refresh).toBe("refresh-2");
		// The shared poller enforces a 1s floor and +5s after slow_down.
	}, 10_000);

	it("fails cleanly when the user denies the device code", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			return jsonResponse(400, { error: "access_denied" });
		};
		await expect(loginViaRegistry({ fetch: fetchImpl })).rejects.toThrow(/denied/);
	});

	it("fails with the expiry message when the device code expires mid-poll", async () => {
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			return jsonResponse(400, { error: "expired_token" });
		};
		await expect(loginViaRegistry({ fetch: fetchImpl })).rejects.toThrow("device code expired");
	});

	it("cancels an in-flight device token request instead of waiting for the provider", async () => {
		const abort = new AbortController();
		const polling = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async (url, init) => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			polling.resolve();
			const pending = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), { once: true });
			return pending.promise;
		};
		const login = loginViaRegistry({ fetch: fetchImpl, signal: abort.signal });
		await polling.promise;
		abort.abort();
		await expect(login).rejects.toThrow("Login cancelled");
	});

	it("expires an in-flight poll when the device code deadline passes even with a live caller signal", async () => {
		const caller = new AbortController();
		let pollSignal: AbortSignal | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			if (String(url).endsWith("/authorize/device")) {
				return jsonResponse(200, { ...DEVICE_AUTH, expires_in: 0.05 });
			}
			pollSignal = init?.signal ?? undefined;
			const pending = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), { once: true });
			return pending.promise;
		};
		await expect(loginViaRegistry({ fetch: fetchImpl, signal: caller.signal })).rejects.toThrow(
			"Device flow timed out",
		);
		expect(pollSignal?.aborted).toBe(true);
		expect(caller.signal.aborted).toBe(false);
	});

	it("refreshes via the WorkOS refresh_token grant and maps the user payload", async () => {
		const access = makeJwt({
			sub: "user_9",
			external_org_id: "factory-org-9",
			exp: Math.floor(Date.now() / 1000) + 7200,
		});
		const calls: Array<{ url: string; body: string; authorization?: string }> = [];
		const fetchImpl: FetchImpl = async (url, init) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(url),
				body: String(init?.body ?? ""),
				authorization: headers.get("authorization") ?? undefined,
			});
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, { region: "eu" });
			return jsonResponse(200, {
				access_token: access,
				refresh_token: "refresh-rotated",
				user: { id: "user_9", email: "rotated@example.com" },
				organization_id: "org-9",
			});
		};

		const credentials = await refreshViaRegistry("refresh-old", fetchImpl);
		expect(calls[0].url).toBe("https://api.workos.com/user_management/authenticate");
		expect(calls[0].body).toContain("grant_type=refresh_token");
		expect(calls[0].body).toContain("refresh_token=refresh-old");
		expect(credentials.refresh).toBe("refresh-rotated");
		expect(credentials.email).toBe("rotated@example.com");
		expect(credentials.orgId).toBe("factory-org-9");
		// Refresh re-reads whoami with the rotated access token (mirrors the CLI).
		expect(calls[1].url).toBe("https://api.factory.ai/api/cli/whoami");
		expect(calls[1].authorization).toBe(`Bearer ${access}`);
		expect(credentials.region).toBe("eu");
	});

	it("uses JWT identity only when the WorkOS user is absent and falls back to one-day expiry", async () => {
		const access = makeJwt({ sub: "jwt-user", email: "jwt@example.test", external_org_id: "factory-org" });
		const fetchImpl: FetchImpl = async url =>
			String(url).endsWith("/api/cli/whoami")
				? jsonResponse(200, {})
				: jsonResponse(200, { access_token: access, refresh_token: "rotated" });
		const beforeRefresh = Date.now();
		const credentials = await refreshViaRegistry("old", fetchImpl);
		expect(credentials).toMatchObject({
			accountId: "jwt-user",
			email: "jwt@example.test",
			orgId: "factory-org",
		});
		expect(credentials.expires).toBeGreaterThanOrEqual(beforeRefresh + 86_400_000);
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 86_400_000);
	});

	it("never treats WorkOS organization_id as a Factory external org", async () => {
		const access = makeJwt({ sub: "user_9", exp: Math.floor(Date.now() / 1000) + 7200 });
		const fetchImpl: FetchImpl = async url =>
			String(url).endsWith("/api/cli/whoami")
				? jsonResponse(200, {})
				: jsonResponse(200, { access_token: access, refresh_token: "new", organization_id: "org_internal" });
		const credentials = await refreshViaRegistry("old", fetchImpl);
		expect(credentials.orgId).toBeUndefined();
	});

	it("treats a whoami failure as region unknown, not a login failure", async () => {
		const access = makeJwt({ sub: "user_2", exp: Math.floor(Date.now() / 1000) + 3600 });
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(500, {});
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-3" });
		};

		const credentials = await loginViaRegistry({ fetch: fetchImpl });
		expect(credentials.refresh).toBe("refresh-3");
		expect(credentials.region).toBeUndefined();
	});

	it("surfaces refresh failures with the provider error", async () => {
		const fetchImpl: FetchImpl = async () => jsonResponse(401, { error: "invalid_grant" });
		await expect(refreshViaRegistry("dead", fetchImpl)).rejects.toThrow(/invalid_grant/);
	});
});
