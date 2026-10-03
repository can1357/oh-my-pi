import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

describe("AuthStorage bulk credential removal", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;
	let triggerDb: Database | undefined;

	afterEach(async () => {
		triggerDb?.close();
		triggerDb = undefined;
		authStorage?.close();
		authStorage = undefined;
		store = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function openAuthStorage(): Promise<{
		dbPath: string;
		storage: AuthStorage;
		store: SqliteAuthCredentialStore;
	}> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-bulk-removal-"));
		const dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		return { dbPath, storage: authStorage, store };
	}

	function oauthCredential(suffix: string) {
		return {
			type: "oauth" as const,
			access: `access-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + 60 * 60_000,
			accountId: `account-${suffix}`,
			email: `${suffix}@example.com`,
		};
	}

	it("rejects failed SQLite removal, keeps credentials visible, then retries without touching another provider", async () => {
		const { dbPath, storage, store: credentialStore } = await openAuthStorage();
		await storage.credentials.set("provider-a", [oauthCredential("a-one"), oauthCredential("a-two")]);
		await storage.credentials.set("provider-b", [oauthCredential("b-one"), oauthCredential("b-two")]);
		const providerAIds = storage.credentials.list("provider-a").map(entry => entry.id);
		const providerBIds = storage.credentials.list("provider-b").map(entry => entry.id);
		const accountA = storage.oauth.accounts("provider-a", "session-a")[1];
		const accountB = storage.oauth.accounts("provider-b", "session-b")[1];
		if (!accountA || !accountB) throw new Error("expected two OAuth account fixtures per provider");
		expect(storage.sessions.pin("provider-a", "session-a", accountA.credentialId)).toBe(true);
		expect(storage.sessions.pin("provider-b", "session-b", accountB.credentialId)).toBe(true);
		const providerAStickyKey = "session:sticky:provider-a:session-a";
		const providerBStickyKey = "session:sticky:provider-b:session-b";
		expect(credentialStore.getCache(providerAStickyKey)).not.toBeNull();
		expect(credentialStore.getCache(providerBStickyKey)).not.toBeNull();

		triggerDb = new Database(dbPath);
		triggerDb.run(`
			CREATE TRIGGER reject_user_bulk_disable
			BEFORE UPDATE OF disabled_cause ON auth_credentials
			WHEN NEW.disabled_cause = 'deleted by user'
			BEGIN
				SELECT RAISE(ABORT, 'simulated credential-store write failure');
			END;
		`);

		await expect(storage.credentials.remove("provider-a")).rejects.toThrow(
			"simulated credential-store write failure",
		);
		expect(storage.credentials.list("provider-a").map(entry => entry.id)).toEqual(providerAIds);
		expect(credentialStore.listAuthCredentials("provider-a").map(entry => entry.id)).toEqual(providerAIds);
		expect(storage.credentials.list("provider-b").map(entry => entry.id)).toEqual(providerBIds);
		expect(storage.oauth.identity("provider-a", "session-a")?.email).toBe("a-two@example.com");
		expect(credentialStore.getCache(providerAStickyKey)).not.toBeNull();
		expect(storage.oauth.identity("provider-b", "session-b")?.email).toBe("b-two@example.com");

		triggerDb.run("DROP TRIGGER reject_user_bulk_disable");
		await storage.credentials.remove("provider-a");
		expect(storage.credentials.list("provider-a")).toEqual([]);
		expect(credentialStore.listAuthCredentials("provider-a")).toEqual([]);
		expect(storage.credentials.list("provider-b").map(entry => entry.id)).toEqual(providerBIds);
		expect(credentialStore.getCache(providerAStickyKey)).toBeNull();
		expect(credentialStore.getCache(providerBStickyKey)).not.toBeNull();
		expect(storage.oauth.identity("provider-b", "session-b")?.email).toBe("b-two@example.com");
	});

	it("clears only the removed provider's session pins", async () => {
		const { storage, store: credentialStore } = await openAuthStorage();
		await storage.credentials.set("provider-a", [oauthCredential("a-one"), oauthCredential("a-two")]);
		await storage.credentials.set("provider-b", [oauthCredential("b-one"), oauthCredential("b-two")]);
		const accountA = storage.oauth.accounts("provider-a", "session-a")[1];
		const accountB = storage.oauth.accounts("provider-b", "session-b")[1];
		if (!accountA || !accountB) throw new Error("expected two OAuth accounts per provider");

		expect(storage.sessions.pin("provider-a", "session-a", accountA.credentialId)).toBe(true);
		expect(storage.sessions.pin("provider-b", "session-b", accountB.credentialId)).toBe(true);
		expect(storage.oauth.identity("provider-a", "session-a")?.email).toBe("a-two@example.com");
		expect(storage.oauth.identity("provider-b", "session-b")?.email).toBe("b-two@example.com");
		expect(credentialStore.getCache("session:sticky:provider-a:session-a")).not.toBeNull();
		expect(credentialStore.getCache("session:sticky:provider-b:session-b")).not.toBeNull();

		await storage.credentials.remove("provider-a");

		expect(storage.oauth.identity("provider-a", "session-a")).toBeUndefined();
		expect(storage.oauth.identity("provider-b", "session-b")?.email).toBe("b-two@example.com");
		expect(credentialStore.getCache("session:sticky:provider-a:session-a")).toBeNull();
		expect(credentialStore.getCache("session:sticky:provider-b:session-b")).not.toBeNull();
	});
});
