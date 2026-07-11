import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import * as oauthUtils from "@pk-nerdsaver-ai/pi-ai/registry/oauth";

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

	test("listOAuthAccounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.listOAuthAccounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("getOAuthAccessAt resolves the credential at the requested position and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const result = await storage.getOAuthAccessAt(PROVIDER, position);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("getOAuthAccessAt returns undefined for an out-of-range position", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		expect(await storage.getOAuthAccessAt(PROVIDER, 2)).toBeUndefined();
		expect(await storage.getOAuthAccessAt(PROVIDER, -1)).toBeUndefined();
	});

	test("getOAuthAccessAt fails the requested account without touching siblings", async () => {
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
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const result = await storage.getOAuthAccessAt(PROVIDER, 1);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});
});
