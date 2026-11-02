import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-oauth-identity";

describe("AuthStorage.oauth.identity", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-identity-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("returns undefined without OAuth credentials", () => {
		if (!authStorage) throw new Error("test setup failed");
		expect(authStorage.oauth.identity(PROVIDER)).toBeUndefined();
	});

	test("carries accountId, email, and projectId from the active credential", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
				projectId: "gcp-project-a",
			},
		]);
		expect(authStorage.oauth.identity(PROVIDER)).toEqual({
			accountId: "acc-a",
			email: "a@example.com",
			projectId: "gcp-project-a",
		});
	});

	test("drops empty-string fields and returns undefined when no field survives", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "",
				email: "",
			},
		]);
		expect(authStorage.oauth.identity(PROVIDER)).toBeUndefined();
	});

	test("follows the session-sticky credential across rotation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const sessionId = "session-identity-test";
		await storage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-b",
				email: "b@example.com",
			},
		]);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});

		const firstKey = await storage.keys.get(PROVIDER, sessionId);
		const firstIdentity = storage.oauth.identity(PROVIDER, sessionId);
		expect(firstIdentity?.accountId).toBeDefined();
		// Identity must describe the credential the session is actually using.
		expect(firstIdentity?.accountId).toBe(firstKey === "access-a" ? "acc-a" : "acc-b");

		const invalidated = await storage.limits.invalidateMatching(PROVIDER, firstKey ?? "", { sessionId });
		expect(invalidated).toBe(true);
		const retryKey = await storage.keys.get(PROVIDER, sessionId);
		expect(retryKey).not.toBe(firstKey);
		const rotatedIdentity = storage.oauth.identity(PROVIDER, sessionId);
		expect(rotatedIdentity?.accountId).toBe(retryKey === "access-a" ? "acc-a" : "acc-b");
	});

	test("config override suppresses OAuth identity attribution", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
		]);
		expect(authStorage.oauth.identity(PROVIDER)?.accountId).toBe("acc-a");

		authStorage.keys.setConfig(PROVIDER, "gateway-bearer");
		// With an explicit bearer in play the session is not using OAuth, so no
		// account may be reported as "in use".
		expect(authStorage.oauth.identity(PROVIDER)).toBeUndefined();
	});

	test("removes one stored OAuth credential without clearing sibling accounts", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60 * 60_000,
				accountId: "acc-b",
				email: "b@example.com",
			},
		]);
		const before = authStorage.credentials.list(PROVIDER);
		const target = before.find(row => row.credential.type === "oauth" && row.credential.accountId === "acc-a");
		if (!target) throw new Error("missing target credential");

		const removed = await authStorage.credentials.removeById(PROVIDER, target.id);

		expect(removed).toBe(true);
		const after = authStorage.credentials.list(PROVIDER);
		expect(after.map(row => (row.credential.type === "oauth" ? row.credential.accountId : ""))).toEqual(["acc-b"]);
		expect(await authStorage.credentials.removeById(PROVIDER, target.id)).toBe(false);
	});
});
