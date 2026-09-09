import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-exclusive";

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

describe("AuthStorage exclusive session pins", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-exclusive-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
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

	function storage(): AuthStorage {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage;
	}

	async function seedAccounts(...suffixes: string[]): Promise<Map<string, number>> {
		await storage().set(PROVIDER, suffixes.map(oauthCredential));
		return new Map(
			storage()
				.listOAuthAccounts(PROVIDER)
				.map(account => [account.email ?? "", account.credentialId]),
		);
	}

	function serveEmail(reader: AuthStorage, sessionId: string): Promise<string> {
		return withOAuthAccess(reader, PROVIDER, access => Promise.resolve(access.email ?? ""), { sessionId });
	}

	test("an exclusive pin hides the account from other sessions and keeps it for the owner", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-b")).toBe(false);

		expect(await serveEmail(storage(), "session-a")).toBe("b@example.com");
		expect(await serveEmail(storage(), "session-b")).not.toBe("b@example.com");

		const forOther = storage()
			.listOAuthAccounts(PROVIDER, "session-b")
			.find(account => account.credentialId === targetId);
		expect(forOther?.exclusive).toBe(true);
		expect(forOther?.active).toBe(false);
		const forOwner = storage()
			.listOAuthAccounts(PROVIDER, "session-a")
			.find(account => account.credentialId === targetId);
		expect(forOwner?.exclusive).toBe(true);
		expect(forOwner?.active).toBe(true);
	});

	test("an exclusive pin is refused while another session holds it", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-b", targetId, { exclusive: true })).toBe(false);

		// A plain sticky pin is still allowed, but selection keeps the account
		// invisible to the non-owning session.
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-b", targetId)).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-b")).toBe(false);
		expect(await serveEmail(storage(), "session-b")).not.toBe("b@example.com");
	});

	test("unpin returns the account to the shared pool", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);
		expect(storage().unpinSessionOAuthAccount(PROVIDER, "session-a")).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(false);
		expect(
			storage()
				.listOAuthAccounts(PROVIDER, "session-b")
				.find(account => account.credentialId === targetId)?.exclusive,
		).toBeFalsy();
		expect(storage().unpinSessionOAuthAccount(PROVIDER, "session-a")).toBe(false);

		// With both siblings blocked, another session now resolves the released account.
		await storage().markUsageLimitReached(PROVIDER, undefined, { credentialId: ids.get("a@example.com") });
		await storage().markUsageLimitReached(PROVIDER, undefined, { credentialId: ids.get("c@example.com") });
		expect(await serveEmail(storage(), "session-b")).toBe("b@example.com");
	});

	test("usage limit on an exclusively pinned account reports no switch and keeps the pin", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);

		const limited = await storage().markUsageLimitReached(PROVIDER, "session-a", {});
		expect(limited.switched).toBe(false);
		expect(storage().getOAuthAccountIdentity(PROVIDER, "session-a")?.email).toBe("b@example.com");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);

		// Control: a plain sticky session still reports an available sibling.
		const plainId = ids.get("c@example.com");
		if (plainId === undefined) throw new Error("expected account c");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-c", plainId)).toBe(true);
		const control = await storage().markUsageLimitReached(PROVIDER, "session-c", {});
		expect(control.switched).toBe(true);
	});

	test("the owning session stays on its blocked exclusive account instead of migrating", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);

		await storage().markUsageLimitReached(PROVIDER, "session-a", {});

		// Siblings are free but invisible: the last-resort pass retries the
		// pinned (blocked) account itself rather than silently switching.
		expect(await serveEmail(storage(), "session-a")).toBe("b@example.com");
	});

	test("hard-auth rotation refuses to migrate an exclusively pinned session", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);

		const rotated = await storage().rotateSessionCredential(PROVIDER, "session-a", {
			error: new Error("401 Unauthorized"),
		});
		expect(rotated).toBe(false);
		expect(storage().getOAuthAccountIdentity(PROVIDER, "session-a")?.email).toBe("b@example.com");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);

		// Control: a plain sticky session rotates away from the same error.
		const plainId = ids.get("c@example.com");
		if (plainId === undefined) throw new Error("expected account c");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-c", plainId)).toBe(true);
		const control = await storage().rotateSessionCredential(PROVIDER, "session-c", {
			error: new Error("401 Unauthorized"),
		});
		expect(control).toBe(true);
	});

	test("a session with every account exclusively held elsewhere gets an explicit error", async () => {
		const ids = await seedAccounts("a");
		const targetId = ids.get("a@example.com");
		if (targetId === undefined) throw new Error("expected account a");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);

		await expect(serveEmail(storage(), "session-b")).rejects.toThrow(/No OAuth credential available/);
	});

	test("re-pinning moves the session's exclusive hold to the new account", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const bId = ids.get("b@example.com");
		const cId = ids.get("c@example.com");
		if (bId === undefined || cId === undefined) throw new Error("expected accounts b and c");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", bId, { exclusive: true })).toBe(true);
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", cId, { exclusive: true })).toBe(true);

		// The hold moved: b is back in the shared pool, c is reserved.
		const listing = storage().listOAuthAccounts(PROVIDER, "session-b");
		expect(listing.find(account => account.credentialId === bId)?.exclusive).toBeFalsy();
		expect(listing.find(account => account.credentialId === cId)?.exclusive).toBe(true);
		expect(storage().getOAuthAccountIdentity(PROVIDER, "session-a")?.email).toBe("c@example.com");
	});

	test("a non-exclusive pin after an exclusive pin clears the hold and resolves the new account", async () => {
		const ids = await seedAccounts("a", "b");
		const aId = ids.get("a@example.com");
		const bId = ids.get("b@example.com");
		if (aId === undefined || bId === undefined) throw new Error("expected accounts a and b");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", aId, { exclusive: true })).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);
		expect(await serveEmail(storage(), "session-b")).not.toBe("a@example.com");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", bId)).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(false);
		expect(storage().getOAuthAccountIdentity(PROVIDER, "session-a")?.email).toBe("b@example.com");
		expect(
			storage()
				.listOAuthAccounts(PROVIDER, "session-b")
				.find(account => account.credentialId === aId)?.exclusive,
		).toBeFalsy();

		// With b blocked, session-b resolves the formerly exclusive account back in the shared pool.
		await storage().markUsageLimitReached(PROVIDER, undefined, { credentialId: bId });
		// session-b may already be sticky on b from the pre-switch probe; a fresh session proves a rejoined the pool.
		expect(await serveEmail(storage(), "session-c")).toBe("a@example.com");
	});

	test("a non-exclusive sticky pin keeps the account visible to every session", async () => {
		const ids = await seedAccounts("a", "b", "c");
		const cId = ids.get("c@example.com");
		if (cId === undefined) throw new Error("expected account c");

		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-c", cId)).toBe(true);
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-c")).toBe(false);
		expect(
			storage()
				.listOAuthAccounts(PROVIDER, "session-x")
				.find(account => account.credentialId === cId)?.exclusive,
		).toBeFalsy();

		// With both siblings blocked, another session resolves the plain-pinned account.
		await storage().markUsageLimitReached(PROVIDER, undefined, { credentialId: ids.get("a@example.com") });
		await storage().markUsageLimitReached(PROVIDER, undefined, { credentialId: ids.get("b@example.com") });
		expect(await serveEmail(storage(), "session-x")).toBe("c@example.com");
	});

	test("exclusive holds survive a process restart", async () => {
		const credentialStore = store;
		if (!credentialStore) throw new Error("test setup failed");
		const ids = await seedAccounts("a", "b", "c");
		const targetId = ids.get("b@example.com");
		if (targetId === undefined) throw new Error("expected account b");
		expect(storage().pinSessionOAuthAccount(PROVIDER, "session-a", targetId, { exclusive: true })).toBe(true);

		const restored = new AuthStorage(credentialStore);
		await restored.reload();

		expect(restored.hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);
		expect(
			restored.listOAuthAccounts(PROVIDER, "session-x").find(account => account.credentialId === targetId)
				?.exclusive,
		).toBe(true);
		expect(await serveEmail(restored, "session-x")).not.toBe("b@example.com");
	});
});
