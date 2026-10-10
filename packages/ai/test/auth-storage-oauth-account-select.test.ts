import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-select";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("oauth.accounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.oauth.accounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("sessions.pin selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.oauth.accounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage.oauth
				.accounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.oauth.accounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("inherited session affinity keeps usage rotation on the selected account", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected second OAuth account");
		expect(storage.sessions.pin(PROVIDER, "parent-session", accountB.credentialId)).toBe(true);

		expect(storage.sessions.inherit("parent-session", "child-session")).toBe(1);
		expect(storage.oauth.accounts(PROVIDER, "child-session").find(account => account.active)?.email).toBe(
			"b@example.com",
		);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("b@example.com");

		const outcome = await storage.limits.markReached(PROVIDER, "child-session", { retryAfterMs: 60_000 });
		expect(outcome.switched).toBe(true);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("a@example.com");
	});
	test("strict pins survive inheritance and stop instead of rotating at the usage limit", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected second OAuth account");
		expect(storage.sessions.pin(PROVIDER, "strict-parent", accountB.credentialId, { strict: true })).toBe(true);
		expect(storage.sessions.inherit("strict-parent", "strict-child")).toBe(1);
		expect(storage.sessions.mode(PROVIDER, "strict-child")).toBe("strict");
		expect(await storage.keys.get(PROVIDER, "strict-child")).toBe("access-b");
		expect(await storage.keys.get(PROVIDER, "strict-child", { modelId: "second-model" })).toBe("access-b");
		expect(await storage.keys.get(PROVIDER, "strict-child", { accountIds: ["acc-a"] })).toBeUndefined();
		expect(storage.sessions.mode(PROVIDER, "strict-child")).toBe("strict");

		const outcome = await storage.limits.markReached(PROVIDER, "strict-child", { retryAfterMs: 60_000 });
		expect(outcome.switched).toBe(false);
		expect(await storage.keys.get(PROVIDER, "strict-child")).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER, "strict-child")?.email).toBe("b@example.com");
	});

	test("persists strict upgrades and downgrades on the same explicit row immediately", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		await storage.credentials.set(PROVIDER, [oauthCredential("a")]);
		const target = storage.oauth.accounts(PROVIDER)[0];
		if (!target) throw new Error("expected OAuth account");
		const sessionId = "strict-persistence";
		expect(storage.sessions.pin(PROVIDER, sessionId, target.credentialId)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, sessionId, target.credentialId, { strict: true })).toBe(true);

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.sessions.mode(PROVIDER, sessionId)).toBe("strict");
		expect(restored.sessions.pin(PROVIDER, sessionId, target.credentialId)).toBe(true);

		const downgraded = new AuthStorage(credentialStore);
		await downgraded.credentials.reload();
		expect(downgraded.sessions.mode(PROVIDER, sessionId)).toBe("pinned");
	});

	test.each(["external", "restricted", "disable", "removeById", "logout"] as const)(
		"keeps a missing strict row locked after %s removal without sibling or static fallback",
		async removal => {
			const storage = authStorage;
			const credentialStore = store;
			if (!storage || !credentialStore) throw new Error("test setup failed");
			const getApiKey = vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
				const credential = credentials[provider];
				return credential ? { newCredentials: credential, apiKey: credential.access } : null;
			});
			await storage.credentials.set(PROVIDER, [
				oauthCredential("a"),
				oauthCredential("b"),
				{ type: "api_key", key: "login-key", source: "login" },
				{ type: "api_key", key: "static-key" },
			]);
			const target = storage.oauth.accounts(PROVIDER)[0];
			if (!target) throw new Error("expected OAuth account");
			const sessionId = `missing-strict-${removal}`;
			expect(storage.sessions.pin(PROVIDER, sessionId, target.credentialId, { strict: true })).toBe(true);
			if (removal === "restricted") {
				storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-a", "account:acc-b"]);
				storage.sessions.restrict(PROVIDER, `${sessionId}-child`, ["account:acc-a", "account:acc-b"]);
			}
			if (removal === "external" || removal === "restricted") {
				await credentialStore.deleteAuthCredential(target.credentialId, "removed by peer");
				await storage.credentials.reload();
			} else if (removal === "disable") {
				expect(await storage.credentials.disable(target.credentialId, "revoked grant")).toBe(true);
			} else if (removal === "removeById") {
				expect(await storage.credentials.removeById(PROVIDER, target.credentialId)).toBe(true);
			} else {
				await storage.credentials.remove(PROVIDER);
			}
			expect(storage.sessions.inherit(sessionId, `${sessionId}-child`)).toBe(1);

			for (const current of [storage, new AuthStorage(credentialStore)]) {
				await current.credentials.reload();
				expect(current.sessions.mode(PROVIDER, sessionId)).toBe("strict");
				expect(await current.keys.get(PROVIDER, sessionId)).toBeUndefined();
				expect(await current.oauth.access(PROVIDER, sessionId)).toBeUndefined();
				expect(current.oauth.identity(PROVIDER, sessionId)).toBeUndefined();
				expect(current.sessions.mode(PROVIDER, `${sessionId}-child`)).toBe("strict");
				expect(await current.keys.get(PROVIDER, `${sessionId}-child`)).toBeUndefined();
			}
			expect(getApiKey).not.toHaveBeenCalled();
		},
	);

	test("strict preflight revocation preserves the lock instead of trying sibling or static credentials", async () => {
		const credentialStore = store;
		if (!credentialStore) throw new Error("test setup failed");
		const refreshedIds: number[] = [];
		const storage = new AuthStorage(credentialStore, {
			refreshOAuthCredential: async (_provider, credentialId) => {
				refreshedIds.push(credentialId);
				throw new Error("invalid_grant: refresh token revoked");
			},
		});
		await storage.credentials.set(PROVIDER, [
			{ ...oauthCredential("a"), expires: 0 },
			oauthCredential("b"),
			{ type: "api_key", key: "static-key" },
		]);
		const target = storage.oauth.accounts(PROVIDER)[0];
		if (!target) throw new Error("expected OAuth account");
		const sessionId = "revoked-strict-preflight";
		expect(storage.sessions.pin(PROVIDER, sessionId, target.credentialId, { strict: true })).toBe(true);

		expect(await storage.keys.get(PROVIDER, sessionId)).toBeUndefined();
		expect(refreshedIds).toEqual([target.credentialId]);
		expect(storage.sessions.mode(PROVIDER, sessionId)).toBe("strict");
		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.sessions.mode(PROVIDER, sessionId)).toBe("strict");
		expect(await restored.keys.get(PROVIDER, sessionId)).toBeUndefined();
	});

	test("strict key resolution surfaces retryable refresh failure without static-key fallback", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				throw new Error("fetch failed: ECONNREFUSED");
			},
		});
		await storage.credentials.set(PROVIDER, [
			{ ...oauthCredential("a"), expires: 0 },
			{ type: "api_key", key: "static-key" },
		]);
		const target = storage.oauth.accounts(PROVIDER)[0];
		if (!target) throw new Error("expected OAuth account");
		expect(storage.sessions.pin(PROVIDER, "transient-strict", target.credentialId, { strict: true })).toBe(true);

		await expect(storage.keys.getWithCredential(PROVIDER, "transient-strict")).rejects.toThrow("ECONNREFUSED");
		expect(storage.sessions.mode(PROVIDER, "transient-strict")).toBe("strict");
		expect(await storage.keys.get(PROVIDER, "transient-strict")).toBeUndefined();
	});

	test("strict selection follows its durable row through a preflight pool reorder", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");
		const sessionId = "strict-reordered-pool";
		expect(storage.sessions.pin(PROVIDER, sessionId, target.credentialId, { strict: true })).toBe(true);
		const list = credentialStore.listAuthCredentials.bind(credentialStore);
		vi.spyOn(credentialStore, "listAuthCredentials").mockImplementation(provider => list(provider).reverse());

		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("access-b");
		expect(storage.sessions.mode(PROVIDER, sessionId)).toBe("strict");
		expect(storage.oauth.accounts(PROVIDER, sessionId).find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("filtered automatic inheritance does not erase the child's own strict account pin", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("a")]);
		const target = storage.oauth.accounts(PROVIDER)[0];
		if (!target) throw new Error("expected OAuth account");
		expect(storage.sessions.automatic(PROVIDER, "automatic-parent")).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "pinned-child", target.credentialId, { strict: true })).toBe(true);
		const include = vi.fn((_provider: string, explicit: boolean) => explicit);

		expect(storage.sessions.inherit("automatic-parent", "pinned-child", include)).toBe(0);
		expect(include).toHaveBeenCalledWith(PROVIDER, false);
		expect(storage.sessions.mode(PROVIDER, "pinned-child")).toBe("strict");
	});

	test("credential mutation resets ordinary pins while retaining unread persisted strict locks", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const target = storage.oauth.accounts(PROVIDER)[0];
		if (!target) throw new Error("expected OAuth account");
		expect(storage.sessions.pin(PROVIDER, "ordinary", target.credentialId)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "strict-unread", target.credentialId, { strict: true })).toBe(true);
		const fresh = new AuthStorage(credentialStore);
		await fresh.credentials.reload();
		expect(await fresh.credentials.removeById(PROVIDER, target.credentialId)).toBe(true);

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.sessions.mode(PROVIDER, "ordinary")).toBe("affinity");
		expect(restored.sessions.mode(PROVIDER, "strict-unread")).toBe("strict");
		expect(await restored.keys.get(PROVIDER, "strict-unread")).toBeUndefined();
		expect(restored.sessions.automatic(PROVIDER, "strict-unread")).toBe(true);
		expect(restored.sessions.mode(PROVIDER, "strict-unread")).toBe("automatic");
	});

	test("resolves the account at the requested position by ID and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const account = storage.oauth.accounts(PROVIDER)[position];
			if (!account) throw new Error("expected OAuth account at position");
			const result = await storage.oauth.accessById(PROVIDER, account.credentialId);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("oauth.accessById force-refreshes only the durable requested row", async () => {
		if (!store) throw new Error("test setup failed");
		const refreshedIds: number[] = [];
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshedIds.push(credentialId);
				return {
					access: `${credential.access}-reminted`,
					refresh: credential.refresh,
					expires: Date.now() + 60 * 60_000,
					accountId: credential.accountId,
					email: credential.email,
				};
			},
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
		expect(refreshedIds).toEqual([target.credentialId]);
		expect(
			store.listAuthCredentials(PROVIDER).map(row => (row.credential.type === "oauth" ? row.credential.access : "")),
		).toEqual(["access-a", "access-b-reminted", "access-c"]);

		// Without forceRefresh the still-fresh row is served as stored.
		const again = await storage.oauth.accessById(PROVIDER, target.credentialId);
		expect(again).toMatchObject({ ok: true, accessToken: "access-b-reminted" });
		expect(refreshedIds).toEqual([target.credentialId]);
	});

	test("oauth.accessById force refresh keeps the requested account when a lower row is removed meanwhile", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => ({
				...credential,
				access: `${credential.access}-reminted`,
				expires: Date.now() + 60 * 60_000,
			}),
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [lower, target] = storage.oauth.accounts(PROVIDER);
		if (!lower || !target) throw new Error("expected three OAuth accounts");

		// Another process holds the target's refresh lease and disables the lower row before releasing it,
		// so the forced refresh re-lists the provider's rows without that row.
		expect(store.tryAcquireCredentialRefreshLease(target.credentialId, "peer", Date.now() + 60_000)).toBe(true);
		const pending = storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });
		await store.deleteAuthCredential(lower.credentialId, "oauth refresh failed: invalid_grant");
		store.releaseCredentialRefreshLease(target.credentialId, "peer");

		expect(await pending).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
	});

	test("oauth.accessById auth-recovery force reuses this process's recent mint", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		let mints = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			mints += 1;
			return { ...credential, access: `access-b-mint-${mints}`, expires: Date.now() + 60 * 60_000 };
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");
		const recovery = { forceRefresh: true, refreshReason: "auth-recovery" as const };

		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(mints).toBe(1);
		// A generic forced refresh still mints.
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true })).toMatchObject({
			accessToken: "access-b-mint-2",
		});
	});

	test("resolving the selected account by ID fails without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const account = storage.oauth.accounts(PROVIDER)[1];
		if (!account) throw new Error("expected second OAuth account");
		const result = await storage.oauth.accessById(PROVIDER, account.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});
});
