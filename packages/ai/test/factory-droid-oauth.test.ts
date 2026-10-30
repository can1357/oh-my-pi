import { describe, expect, it, vi } from "bun:test";
import { mergeRefreshedCredential } from "../src/auth/refresh";
import { mergeRefreshedUsageCredential } from "../src/auth/usage";
import { buildUsageCredential } from "../src/auth/usage-cache";
import { getProviderDefinition } from "../src/registry/registry";
import type { OAuthController, OAuthCredentials } from "../src/registry/oauth/types";
import { attachFactoryDroidRegion } from "../src/registry/oauth/factory-droid";
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

describe("Factory Droid stored region", () => {
	const stored = {
		type: "oauth" as const,
		access: "old",
		refresh: "old-refresh",
		expires: 1,
		orgId: "factory-org",
		orgName: "Factory Org",
		activeOrganizationId: "workos-org",
		region: "eu",
		inferenceRegion: "us" as const,
	};
	const tokens = { access: "new", refresh: "new-refresh", expires: 2 };
	type Scope = Pick<OAuthCredentials, "orgId" | "orgName" | "activeOrganizationId" | "region" | "inferenceRegion">;
	const scopeOf = ({ orgId, orgName, activeOrganizationId, region, inferenceRegion }: Scope): Scope => ({
		orgId,
		orgName,
		activeOrganizationId,
		region,
		inferenceRegion,
	});
	it.each<{ name: string; refreshed: OAuthCredentials; expected: Scope }>([
		{
			name: "keeps stored scope when the refresh carries no identity (failed whoami)",
			refreshed: tokens,
			expected: {
				orgId: "factory-org",
				orgName: "Factory Org",
				activeOrganizationId: "workos-org",
				region: "eu",
				inferenceRegion: "us",
			},
		},
		{
			name: "lets refreshed residency win within the same organization",
			refreshed: { ...tokens, orgId: "factory-org", region: "global" },
			expected: {
				orgId: "factory-org",
				orgName: "Factory Org",
				activeOrganizationId: "workos-org",
				region: "global",
				inferenceRegion: "us",
			},
		},
		{
			name: "clears stored scope when the WorkOS organization changes",
			refreshed: { ...tokens, activeOrganizationId: "workos-new" },
			expected: {
				orgId: undefined,
				orgName: undefined,
				activeOrganizationId: "workos-new",
				region: undefined,
				inferenceRegion: undefined,
			},
		},
		{
			name: "clears stored scope but keeps the WorkOS selection when the Factory org changes",
			refreshed: { ...tokens, orgId: "factory-new" },
			expected: {
				orgId: "factory-new",
				orgName: undefined,
				activeOrganizationId: "workos-org",
				region: undefined,
				inferenceRegion: undefined,
			},
		},
	])("$name on stored and usage-path refresh", ({ refreshed, expected }) => {
		const merged = mergeRefreshedCredential(stored, refreshed);
		expect(merged).toMatchObject({ access: "new", refresh: "new-refresh", expires: 2 });
		expect(scopeOf(merged)).toEqual(expected);
		const usage = mergeRefreshedUsageCredential(buildUsageCredential(stored), refreshed);
		expect(usage).toMatchObject({ accessToken: "new", refreshToken: "new-refresh", expiresAt: 2 });
		expect(scopeOf(usage)).toEqual(expected);
	});

	it("resolves canonical whoami identity independently of WorkOS organization and residency", async () => {
		const credentials = await attachFactoryDroidRegion(
			{ access: "new", refresh: "refresh", expires: 1, orgId: "jwt-org" },
			{
				provider: "factory-droid",
				phase: "login",
				raw: { refresh_token: "refresh", organization_id: "workos-org" },
				fetch: async () => jsonResponse(200, { orgId: "canonical-org", region: "global", inferenceRegion: "us" }),
			},
		);
		expect(credentials).toMatchObject({
			orgId: "canonical-org",
			activeOrganizationId: "workos-org",
			region: "global",
			inferenceRegion: "us",
		});
	});

	it("does not carry stored scope into a newly selected organization when whoami fails", async () => {
		const refreshed = await attachFactoryDroidRegion(
			{ access: "new", refresh: "new", expires: 1 },
			{
				provider: "factory-droid",
				phase: "refresh",
				stored: {
					access: "old",
					refresh: "old",
					expires: 0,
					orgId: "factory-old",
					activeOrganizationId: "workos-old",
					region: "eu",
					inferenceRegion: "us",
				},
				raw: { refresh_token: "new", organization_id: "workos-new" },
				fetch: async url => {
					expect(String(url)).toBe("https://api.factory.ai/api/cli/whoami");
					return jsonResponse(503, {});
				},
			},
		);
		expect(refreshed).toMatchObject({ activeOrganizationId: "workos-new" });
		expect(refreshed.orgId).toBeUndefined();
		expect(refreshed.region).toBeUndefined();
		expect(refreshed.inferenceRegion).toBeUndefined();
	});

	it("uses stored residency for same-org reconciliation and retains inference scope on transient failure", async () => {
		const stored = {
			access: "old",
			refresh: "old",
			expires: 0,
			orgId: "factory-org",
			activeOrganizationId: "workos-org",
			region: "eu",
			inferenceRegion: "us" as const,
		};
		const refreshed = await attachFactoryDroidRegion(
			{ access: "new", refresh: "new", expires: 1 },
			{
				provider: "factory-droid",
				phase: "refresh",
				stored,
				raw: { refresh_token: "new", organization_id: "workos-org" },
				fetch: async (url, init) => {
					expect(String(url)).toBe("https://api.eu.factory.ai/api/cli/whoami");
					expect(new Headers(init?.headers).get("x-factory-org-id")).toBe("factory-org");
					return jsonResponse(503, {});
				},
			},
		);
		expect(refreshed).toMatchObject({ orgId: "factory-org", region: "eu", inferenceRegion: "us" });
	});

	it("binds a changed Factory org claim to the refreshed bearer within the same WorkOS org", async () => {
		const refreshed = await attachFactoryDroidRegion(
			{ access: "new", refresh: "new", expires: 1, orgId: "factory-new" },
			{
				provider: "factory-droid",
				phase: "refresh",
				stored: {
					access: "old",
					refresh: "old",
					expires: 0,
					orgId: "factory-org",
					activeOrganizationId: "workos-org",
					region: "eu",
					inferenceRegion: "us",
				},
				raw: { refresh_token: "new", organization_id: "workos-org" },
				fetch: async (url, init) => {
					expect(String(url)).toBe("https://api.factory.ai/api/cli/whoami");
					expect(new Headers(init?.headers).get("x-factory-org-id")).toBe("factory-new");
					return jsonResponse(503, {});
				},
			},
		);
		expect(refreshed).toMatchObject({ orgId: "factory-new", activeOrganizationId: "workos-org" });
		expect(refreshed.region).toBeUndefined();
		expect(refreshed.inferenceRegion).toBeUndefined();
	});
});

describe("Factory Droid OAuth", () => {
	it("maps the device-flow token and whoami residency into credentials", async () => {
		const access = makeJwt({
			sub: "user_123",
			email: "dev@example.com",
			external_org_id: "org-ext-1",
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		const urls: string[] = [];
		const fetchImpl: FetchImpl = async url => {
			urls.push(String(url));
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, { region: "eu" });
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};

		const credentials = await loginViaRegistry({ fetch: fetchImpl });

		expect(credentials.refresh).toBe("refresh-1");
		expect(credentials.access).toBe(access);
		expect(credentials.email).toBe("dev@example.com");
		expect(credentials.accountId).toBe("user_123");
		expect(credentials.orgId).toBe("org-ext-1");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		// whoami runs against the default host and captures the account residency region.
		expect(urls[2]).toBe("https://api.factory.ai/api/cli/whoami");
		expect(credentials.region).toBe("eu");
	});

	it("rejects a fresh org-less login when Factory refuses the bearer", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) {
				return jsonResponse(401, { detail: "User not affiliated with an organization" });
			}
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};

		await expect(loginViaRegistry({ fetch: fetchImpl })).rejects.toThrow(
			/Factory identity check failed \(401\).*User not affiliated with an organization/,
		);
	});

	it("accepts a token without an org claim when Factory resolves its organization", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) {
				return jsonResponse(200, { orgId: "factory-org", region: "eu" });
			}
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};

		const credential = await loginViaRegistry({ fetch: fetchImpl });
		expect(credential).toMatchObject({ orgId: "factory-org", region: "eu" });
	});

	it("rejects a fresh login if neither the token nor whoami resolves an organization", async () => {
		const access = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
		const fetchImpl: FetchImpl = async url => {
			if (String(url).endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (String(url).endsWith("/api/cli/whoami")) return jsonResponse(200, {});
			return jsonResponse(200, { access_token: access, refresh_token: "refresh-1" });
		};

		await expect(loginViaRegistry({ fetch: fetchImpl })).rejects.toThrow(
			"Factory login did not resolve an organization",
		);
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

	it("aborts the in-flight poll at the device-code deadline without cancelling the caller", async () => {
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
});

describe("Factory Droid organization lookup", () => {
	const unscoped = makeJwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 });
	const scoped = makeJwt({ sub: "user_1", external_org_id: "factory-org", exp: Math.floor(Date.now() / 1000) + 3600 });
	// A scoped grant that still comes back without the Factory org claim.
	const scopedNoClaim = makeJwt({ sub: "user_1", org_id: "org_workos", exp: Math.floor(Date.now() / 1000) + 3600 });

	/** WorkOS hands out an org-scoped bearer only when the grant names a WorkOS organization. */
	function factoryBackend(
		workosOrgIds: string[],
		options: {
			scopedAccess?: string;
			scopedGrantStatus?: number;
			unscopedWhoamiOrg?: string;
			rejectScoped?: boolean;
		} = {},
	) {
		const calls: Array<{ url: string; body: string; authorization?: string; factoryOrg?: string }> = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			const body = String(init?.body ?? "");
			calls.push({
				url,
				body,
				authorization: headers.get("authorization") ?? undefined,
				factoryOrg: headers.get("x-factory-org-id") ?? undefined,
			});
			if (url.endsWith("/authorize/device")) return jsonResponse(200, DEVICE_AUTH);
			if (url.endsWith("/api/cli/org")) return jsonResponse(200, { workosOrgIds });
			if (url.endsWith("/api/cli/whoami")) {
				const authorization = headers.get("authorization");
				if (authorization === `Bearer ${scoped}` && !options.rejectScoped) {
					return jsonResponse(200, { orgId: "factory-org", region: "eu" });
				}
				if (authorization === `Bearer ${unscoped}` && options.unscopedWhoamiOrg) {
					return jsonResponse(200, { orgId: options.unscopedWhoamiOrg });
				}
				return jsonResponse(401, { detail: "User not affiliated with an organization" });
			}
			const organization = new URLSearchParams(body).get("organization_id");
			if (!organization) return jsonResponse(200, { access_token: unscoped, refresh_token: "refresh-unscoped" });
			if (options.scopedGrantStatus) return jsonResponse(options.scopedGrantStatus, { error: "invalid_grant" });
			return jsonResponse(200, {
				access_token: options.scopedAccess ?? scoped,
				refresh_token: "refresh-scoped",
				organization_id: organization,
			});
		};
		const count = (predicate: (call: (typeof calls)[number]) => boolean) => calls.filter(predicate).length;
		return {
			calls,
			fetchImpl,
			lookups: () => count(call => call.url.endsWith("/api/cli/org")),
			scopedGrants: () => count(call => new URLSearchParams(call.body).has("organization_id")),
		};
	}

	async function withGlobalFetch<T>(fetchImpl: FetchImpl, run: () => Promise<T>): Promise<T> {
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign((input: string | URL | Request, init?: RequestInit) => fetchImpl(input, init), {
				preconnect: fetch.preconnect,
			}),
		);
		try {
			return await run();
		} finally {
			spy.mockRestore();
		}
	}

	it("scopes an org-less login to the account's WorkOS organization", async () => {
		const { calls, fetchImpl } = factoryBackend(["org_workos"]);
		const credentials = await withGlobalFetch(fetchImpl, () => loginViaRegistry({ fetch: fetchImpl }));

		const lookup = calls.find(call => call.url.endsWith("/api/cli/org"));
		expect(lookup?.authorization).toBe(`Bearer ${unscoped}`);
		const grant = calls.find(call => new URLSearchParams(call.body).get("grant_type") === "refresh_token");
		expect(new URLSearchParams(grant?.body).get("refresh_token")).toBe("refresh-unscoped");
		expect(new URLSearchParams(grant?.body).get("organization_id")).toBe("org_workos");
		expect(credentials).toMatchObject({
			access: scoped,
			refresh: "refresh-scoped",
			orgId: "factory-org",
			activeOrganizationId: "org_workos",
			region: "eu",
		});
		// The WorkOS id scopes the grant only; Factory requests carry the Factory org.
		expect(calls.some(call => call.factoryOrg === "org_workos")).toBe(false);
	});

	it("scopes an org-less refresh and keeps the rotated scoped refresh token", async () => {
		const backend = factoryBackend(["org_workos"]);
		const credentials = await refreshViaRegistry("refresh-old", backend.fetchImpl);

		expect(backend.lookups()).toBe(1);
		expect(backend.scopedGrants()).toBe(1);
		expect(credentials).toMatchObject({
			access: scoped,
			refresh: "refresh-scoped",
			orgId: "factory-org",
			activeOrganizationId: "org_workos",
		});
	});

	it("keeps the organization error when the account has no organization", async () => {
		const backend = factoryBackend([]);
		await expect(
			withGlobalFetch(backend.fetchImpl, () => loginViaRegistry({ fetch: backend.fetchImpl })),
		).rejects.toThrow(/Factory identity check failed \(401\).*User not affiliated with an organization/);
		expect(backend.lookups()).toBe(1);
		expect(backend.scopedGrants()).toBe(0);
	});

	it("reports Factory's refusal when the scoped grant fails", async () => {
		const backend = factoryBackend(["org_workos"], { scopedGrantStatus: 400 });
		await expect(
			withGlobalFetch(backend.fetchImpl, () => loginViaRegistry({ fetch: backend.fetchImpl })),
		).rejects.toThrow(/Factory identity check failed \(401\).*User not affiliated with an organization/);
		expect(backend.scopedGrants()).toBe(1);
	});

	it("looks up and scopes once when the scoped token still has no organization", async () => {
		const backend = factoryBackend(["org_workos"], { scopedAccess: scopedNoClaim });
		await expect(
			withGlobalFetch(backend.fetchImpl, () => loginViaRegistry({ fetch: backend.fetchImpl })),
		).rejects.toThrow(/Factory identity check failed \(401\).*User not affiliated with an organization/);
		expect(backend.lookups()).toBe(1);
		expect(backend.scopedGrants()).toBe(1);
	});

	it("skips the lookup when whoami resolves the org-less token's organization", async () => {
		const backend = factoryBackend(["org_workos"], { unscopedWhoamiOrg: "factory-org" });
		const credentials = await withGlobalFetch(backend.fetchImpl, () =>
			loginViaRegistry({ fetch: backend.fetchImpl }),
		);
		expect(credentials).toMatchObject({ access: unscoped, orgId: "factory-org" });
		expect(backend.lookups()).toBe(0);
		expect(backend.scopedGrants()).toBe(0);
	});

	it("scopes a refresh whose stored credential carries an org the new bearer lacks", async () => {
		const backend = factoryBackend(["org_workos"]);
		const credentials = await withGlobalFetch(backend.fetchImpl, async () => {
			const refresh = getProviderDefinition("factory-droid")?.refreshToken;
			if (!refresh) throw new Error("Factory Droid refresh is unavailable");
			return refresh({ access: "previous", refresh: "refresh-old", expires: 0, orgId: "factory-old" });
		});
		expect(backend.lookups()).toBe(1);
		expect(backend.scopedGrants()).toBe(1);
		expect(credentials).toMatchObject({ access: scoped, orgId: "factory-org", activeOrganizationId: "org_workos" });
	});

	it("gives each Factory request its own 15 s deadline", async () => {
		const backend = factoryBackend(["org_workos"]);
		// Deadlines handed out so far, in order; the test expires them by hand.
		const deadlines: Array<{ controller: AbortController }> = [];
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			deadlines.push({ controller });
			return controller.signal;
		});
		let lookupAbortedByEarlierDeadline: boolean | undefined;
		let lookupAbortedByOwnDeadline: boolean | undefined;
		let deadlinesAtWhoami = 0;
		let deadlinesAtLookup = 0;
		const fetchImpl: FetchImpl = async (input, init) => {
			if (String(input).endsWith("/api/cli/whoami") && !deadlinesAtWhoami) deadlinesAtWhoami = deadlines.length;
			if (String(input).endsWith("/api/cli/org") && lookupAbortedByOwnDeadline === undefined) {
				// whoami already answered; its deadline expiring must not cut the lookup short.
				for (const deadline of deadlines.slice(0, -1)) deadline.controller.abort();
				deadlinesAtLookup = deadlines.length;
				lookupAbortedByEarlierDeadline = init?.signal?.aborted;
				deadlines.at(-1)?.controller.abort();
				lookupAbortedByOwnDeadline = init?.signal?.aborted;
			}
			return backend.fetchImpl(input, init);
		};
		try {
			await withGlobalFetch(fetchImpl, () => loginViaRegistry({ fetch: fetchImpl })).catch(() => {});
		} finally {
			timeoutSpy.mockRestore();
		}
		// The lookup got a deadline of its own after whoami's.
		expect(deadlinesAtLookup).toBeGreaterThan(deadlinesAtWhoami);
		expect(lookupAbortedByEarlierDeadline).toBe(false);
		expect(lookupAbortedByOwnDeadline).toBe(true);
	});

	it("keeps the login email when the scoped refresh omits the user", async () => {
		const backend = factoryBackend(["org_workos"]);
		const fetchImpl: FetchImpl = async (input, init) => {
			const response = await backend.fetchImpl(input, init);
			const body = String(init?.body ?? "");
			if (String(input).endsWith("/authenticate") && !new URLSearchParams(body).has("organization_id")) {
				const tokens = (await response.json()) as Record<string, unknown>;
				return jsonResponse(200, { ...tokens, user: { id: "user_1", email: "dev@example.com" } });
			}
			return response;
		};
		const credentials = await withGlobalFetch(fetchImpl, () => loginViaRegistry({ fetch: fetchImpl }));
		expect(credentials).toMatchObject({ access: scoped, orgId: "factory-org", email: "dev@example.com" });
	});

	it("rejects a login whose scoped bearer Factory still refuses", async () => {
		const backend = factoryBackend(["org_workos"], { rejectScoped: true });
		await expect(
			withGlobalFetch(backend.fetchImpl, () => loginViaRegistry({ fetch: backend.fetchImpl })),
		).rejects.toThrow(/Factory identity check failed \(401\).*User not affiliated with an organization/);
		expect(backend.scopedGrants()).toBe(1);
	});

	it("does not look up the organization when the token already carries one", async () => {
		const backend = factoryBackend(["org_workos"]);
		const credentials = await refreshViaRegistry("refresh-old", async (input, init) =>
			String(input).endsWith("/authenticate")
				? jsonResponse(200, { access_token: scoped, refresh_token: "refresh-scoped" })
				: backend.fetchImpl(input, init),
		);
		expect(credentials.orgId).toBe("factory-org");
		expect(backend.lookups()).toBe(0);
	});
});
