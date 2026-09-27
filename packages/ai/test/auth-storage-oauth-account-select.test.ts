import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
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
	let store: AuthCredentialStore | null = null;
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

	test("oauth.accessById refreshes only the durable requested row", async () => {
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
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result?.ok).toBe(true);
		if (!result?.ok) throw new Error("expected ok resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(result.accessToken).toBe("access-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("oauth.accessById does not substitute a sibling on failure", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(seen).toEqual(["access-b"]);
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
