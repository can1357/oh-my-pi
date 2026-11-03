import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

test("credential salvage retains mixed API-key and OAuth rows verbatim without reviving disabled rows", async () => {
	await using tempDir = await TempDir.create("@omp-credential-recovery-");
	const backupPath = tempDir.join("preserved.db");
	const backup = await SqliteAuthCredentialStore.open(backupPath);
	await backup.replaceAuthCredentials("openai", [
		{ type: "api_key", key: "preserved-key" },
		{ type: "oauth", access: "preserved-access", refresh: "preserved-refresh", expires: 123456789 },
	]);
	await backup.saveApiKey("disabled-provider", "disabled-key");
	await backup.deleteAuthCredentials("disabled-provider", "disabled by user");
	backup.close();

	// Unknown persisted fields and identity keys must survive salvage, not be reserialized.
	const persisted = new Database(backupPath);
	persisted.run("UPDATE auth_credentials SET data = json_set(data, '$.extension', 'preserve-me')");
	persisted.run("UPDATE auth_credentials SET identity_key = 'preserved-identity' WHERE credential_type = 'oauth'");
	const rows = persisted
		.query(
			"SELECT provider, credential_type, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id",
		)
		.all();
	persisted.run("PRAGMA wal_checkpoint(TRUNCATE)");
	persisted.close();
	const preservedBytes = await Bun.file(backupPath).bytes();

	const livePath = tempDir.join("live.db");
	const live = await SqliteAuthCredentialStore.open(livePath);
	try {
		expect(await live.recoverCredentialsFrom(backupPath)).toBe(2);
		expect(live.listAuthCredentials("openai").map(row => row.credential.type)).toEqual(["api_key", "oauth"]);
		expect(live.listAuthCredentials("disabled-provider")).toEqual([]);
		const restored = new Database(livePath, { readonly: true });
		try {
			expect(
				restored
					.query("SELECT provider, credential_type, data, identity_key FROM auth_credentials ORDER BY id")
					.all(),
			).toEqual(rows);
		} finally {
			restored.close();
		}
		expect(await Bun.file(backupPath).bytes()).toEqual(preservedBytes);
	} finally {
		live.close();
	}
});

test("credential salvage keeps live API keys and same-identity OAuth rows while adding another account", async () => {
	await using tempDir = await TempDir.create("@omp-credential-recovery-");
	const backupPath = tempDir.join("preserved.db");
	const backup = await SqliteAuthCredentialStore.open(backupPath);
	await backup.replaceAuthCredentials("openai", [
		{ type: "api_key", key: "live-key" },
		{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1, accountId: "existing" },
		{ type: "oauth", access: "another-access", refresh: "another-refresh", expires: 2, accountId: "another" },
	]);
	backup.close();

	const live = await SqliteAuthCredentialStore.open(tempDir.join("live.db"));
	try {
		await live.replaceAuthCredentials("openai", [
			{ type: "api_key", key: "live-key" },
			{ type: "oauth", access: "live-access", refresh: "live-refresh", expires: 3, accountId: "existing" },
		]);
		const original = live.listAuthCredentials("openai");
		expect(await live.recoverCredentialsFrom(backupPath)).toBe(1);
		const credentials = live.listAuthCredentials("openai");
		expect(credentials.slice(0, 2)).toEqual(original);
		expect(credentials.map(row => row.credential)).toEqual([
			{ type: "api_key", key: "live-key" },
			{ type: "oauth", access: "live-access", refresh: "live-refresh", expires: 3, accountId: "existing" },
			{ type: "oauth", access: "another-access", refresh: "another-refresh", expires: 2, accountId: "another" },
		]);
		expect(await live.listDisabledCredentials("openai")).toEqual([]);
		expect(await live.recoverCredentialsFrom(backupPath)).toBe(0);
	} finally {
		live.close();
	}
});
