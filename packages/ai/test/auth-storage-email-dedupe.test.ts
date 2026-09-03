import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type FetchImpl, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/registry/oauth";

const LEGACY_TIMESTAMP = 1_700_000_000;

function createCredential(args: { suffix: string; accountId: string; email: string }): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${args.suffix}`,
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 60_000,
		accountId: args.accountId,
		email: args.email,
	};
}

function createCodexToken(args: { accountId: string; email: string }): string {
	const payload = {
		"https://api.openai.com/auth": { chatgpt_account_id: args.accountId },
		"https://api.openai.com/profile": { email: args.email },
	};
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

function createJwtOnlyCredential(args: { suffix: string; accountId: string; email: string }): OAuthCredential {
	return {
		type: "oauth",
		access: createCodexToken({ accountId: args.accountId, email: args.email }),
		refresh: `refresh-${args.suffix}`,
		expires: Date.now() + 60_000,
		accountId: args.accountId,
	};
}

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

function readDisabledCauses(dbPath: string, provider: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.prepare(
				"SELECT disabled_cause FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
			)
			.all(provider) as Array<{ disabled_cause?: string | null }>;
		return rows.flatMap(row => (typeof row.disabled_cause === "string" ? [row.disabled_cause] : []));
	} finally {
		db.close();
	}
}

function readStoredIdentityRows(
	dbPath: string,
	provider: string,
): Array<{ identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare("SELECT identity_key, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC")
			.all(provider) as Array<{ identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

function readAuthSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function readTableSql(dbPath: string, tableName: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
			| { sql?: string | null }
			| undefined;
		return row?.sql ?? null;
	} finally {
		db.close();
	}
}

describe("AuthStorage openai-codex email dedupe", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-email-dedupe-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("keeps both openai-codex credentials when accountId matches but emails differ", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createCredential({ suffix: "first", accountId: "shared-team", email: "first.user@example.com" }),
			createCredential({ suffix: "second", accountId: "shared-team", email: "second.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(2);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("dedupes openai-codex credentials when email matches but accountId differs", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
	});

	it("dedupes openai-codex credentials when matching email exists only in JWT profile claim but accountId differs", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
	});

	it("updates in-place when a codex credential with matching email replaces another account", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
		]);
		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		// Same email identity key → existing row is updated, not disabled+reinserted
		expect(countCredentialRows(dbPath, "openai-codex")).toBe(1);
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("updates in-place via AuthStorage.set when email matches across accounts", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		await authStorage.set(
			"openai-codex",
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
		);
		await authStorage.set(
			"openai-codex",
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		);

		// Same email identity key → updated in-place, no disabled rows
		expect(countCredentialRows(dbPath, "openai-codex")).toBe(1);
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("does not disable credentials for different accounts with different emails", async () => {
		if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

		const credA = createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" });
		const credB = createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" });
		const credC = createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" });

		// Simulate login flow: each login merges existing + new
		await authStorage.set("openai-codex", credA);
		await authStorage.set("openai-codex", [credA, credB]);
		await authStorage.set("openai-codex", [credA, credB, credC]);

		// All three accounts should remain active — no credential was replaced
		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("saveOAuth preserves unrelated codex accounts across reauth", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
		);
		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
		);
		store.saveOAuth(
			"openai-codex",
			createCredential({ suffix: "third", accountId: "account-c", email: "user-c@example.com" }),
		);

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(3);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
	});

	it("saveOAuth does not delete accounts missing from stale AuthStorage cache", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		const staleStore = await SqliteAuthCredentialStore.open(dbPath);
		const freshStore = await SqliteAuthCredentialStore.open(dbPath);
		const staleAuthStorage = new AuthStorage(staleStore);
		try {
			staleStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "first", accountId: "account-a", email: "user-a@example.com" }),
			);
			await staleAuthStorage.reload();

			// Another writer adds a second account after staleAuthStorage has already cached provider state.
			freshStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "second", accountId: "account-b", email: "user-b@example.com" }),
			);

			// Reauth from the stale process should update only account A, not disable account B.
			staleStore.saveOAuth(
				"openai-codex",
				createCredential({ suffix: "reauth", accountId: "account-a", email: "user-a@example.com" }),
			);

			expect(staleStore.listAuthCredentials("openai-codex")).toHaveLength(2);
			expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([]);
		} finally {
			staleStore.close();
			freshStore.close();
		}
	});

	it("prunes existing JWT-only codex duplicates on reload when email matches", async () => {
		if (!store) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createJwtOnlyCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createJwtOnlyCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const reloaded = new AuthStorage(store);
		await reloaded.reload();

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
	});

	it("dedupes openai-codex credentials after reload when email matches even if accountId differs", async () => {
		if (!store) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createCredential({ suffix: "first", accountId: "account-a", email: "shared.user@example.com" }),
			createCredential({ suffix: "second", accountId: "account-b", email: "shared.user@example.com" }),
		]);

		const reloaded = new AuthStorage(store);
		await reloaded.reload();

		const credentials = store.listAuthCredentials("openai-codex");
		expect(credentials).toHaveLength(1);
		const [remaining] = credentials;
		expect(remaining?.credential.type).toBe("oauth");
		if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
		expect(remaining.credential.accountId).toBe("account-b");
		expect(remaining.credential.email).toBe("shared.user@example.com");
	});

	describe("AuthStorage anthropic email identity", () => {
		it("keeps both anthropic credentials when accountId matches but emails differ", async () => {
			if (!authStorage || !store || !dbPath) throw new Error("test setup failed");

			await authStorage.set("anthropic", [
				createCredential({ suffix: "first", accountId: "shared-org", email: "first.user@example.com" }),
				createCredential({ suffix: "second", accountId: "shared-org", email: "second.user@example.com" }),
			]);

			const credentials = store.listAuthCredentials("anthropic");
			expect(credentials).toHaveLength(2);
			expect(readDisabledCauses(dbPath, "anthropic")).toEqual([]);
		});

		it("dedupes anthropic credentials when email matches but accountId differs", async () => {
			if (!authStorage || !store) throw new Error("test setup failed");

			await authStorage.set("anthropic", [
				createCredential({ suffix: "first", accountId: "org-a", email: "shared.user@example.com" }),
				createCredential({ suffix: "second", accountId: "org-b", email: "shared.user@example.com" }),
			]);

			const credentials = store.listAuthCredentials("anthropic");
			expect(credentials).toHaveLength(1);
			const [remaining] = credentials;
			expect(remaining?.credential.type).toBe("oauth");
			if (remaining?.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(remaining.credential.accountId).toBe("org-b");
			expect(remaining.credential.email).toBe("shared.user@example.com");
		});

		it("backfills anthropic identity_key from email when migrating v1 auth schema", async () => {
			if (!tempDir) throw new Error("test setup failed");

			const legacyDbPath = path.join(tempDir, "legacy-v1-anthropic-agent.db");
			const legacyDb = new Database(legacyDbPath);
			legacyDb.run(`
				CREATE TABLE auth_schema_version (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					version INTEGER NOT NULL
				);
				INSERT INTO auth_schema_version(id, version) VALUES (1, 1);
				CREATE TABLE auth_credentials (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					provider TEXT NOT NULL,
					credential_type TEXT NOT NULL,
					data TEXT NOT NULL,
					disabled_cause TEXT DEFAULT NULL,
					created_at INTEGER NOT NULL DEFAULT (unixepoch()),
					updated_at INTEGER NOT NULL DEFAULT (unixepoch())
				);
			`);
			legacyDb
				.prepare(
					"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					"anthropic",
					"oauth",
					JSON.stringify(
						createCredential({
							suffix: "legacy-v1-anthropic",
							accountId: "legacy-org",
							email: "legacy-anthropic@example.com",
						}),
					),
					null,
					LEGACY_TIMESTAMP,
					LEGACY_TIMESTAMP,
				);
			legacyDb.close();

			const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
			try {
				expect(readStoredIdentityRows(legacyDbPath, "anthropic")).toEqual([
					{ identity_key: "email:legacy-anthropic@example.com", disabled_cause: null },
				]);
			} finally {
				migratedStore.close();
			}
		});
	});
	it("stores the disable cause when a credential is soft-disabled", async () => {
		if (!store || !dbPath) throw new Error("test setup failed");

		store.replaceAuthCredentialsForProvider("openai-codex", [
			createCredential({ suffix: "only", accountId: "account-a", email: "only@example.com" }),
		]);

		const [credential] = store.listAuthCredentials("openai-codex");
		if (!credential) throw new Error("expected stored credential");

		const disabledCause = "oauth refresh failed: invalid_grant";
		store.deleteAuthCredential(credential.id, disabledCause);

		expect(store.listAuthCredentials("openai-codex")).toHaveLength(0);
		expect(readDisabledCauses(dbPath, "openai-codex")).toEqual([disabledCause]);
	});

	it("creates fresh auth schema without unixepoch defaults", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const freshDbPath = path.join(tempDir, "fresh-schema-agent.db");
		const freshStore = await SqliteAuthCredentialStore.open(freshDbPath);
		try {
			expect(readAuthSchemaVersion(freshDbPath)).toBe(7);
			expect(readTableSql(freshDbPath, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(freshDbPath, "auth_credentials")).toContain("strftime('%s','now')");
		} finally {
			freshStore.close();
		}
	});

	it("preserves newer auth schema versions instead of downgrading them", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const futureDbPath = path.join(tempDir, "future-schema-agent.db");
		const futureDb = new Database(futureDbPath);
		futureDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 8);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		futureDb.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(futureDbPath);
		try {
			expect(readAuthSchemaVersion(futureDbPath)).toBe(8);
		} finally {
			reopenedStore.close();
		}
	});

	it("reopens a current-schema db without issuing write transactions", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const reopenDbPath = path.join(tempDir, "reopen-noop-agent.db");
		const first = await SqliteAuthCredentialStore.open(reopenDbPath);
		// api_key rows never derive an identity_key, so this leaves a NULL row
		// the boot-time backfill scan must skip without a no-op UPDATE.
		first.saveApiKey("openai", "sk-reopen-noop");
		first.close();

		// PRAGMA data_version, read from a second connection, increments whenever
		// another connection commits a write; reopening a current-schema store
		// (already-WAL pragmas, IF NOT EXISTS DDL, current version row, and an
		// underivable NULL identity_key row) must not move it.
		const observer = new Database(reopenDbPath, { readonly: true });
		try {
			const before = (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
			const reopened = await SqliteAuthCredentialStore.open(reopenDbPath);
			try {
				expect(reopened.listAuthCredentials("openai")).toHaveLength(1);
				expect(readAuthSchemaVersion(reopenDbPath)).toBe(7);
			} finally {
				reopened.close();
			}
			const after = (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
			expect(after).toBe(before);
		} finally {
			observer.close();
		}
	});

	it("migrates v3 auth schema away from unixepoch defaults", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-v3-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 3);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v3",
						accountId: "legacy-v3-account",
						email: "legacy-v3@example.com",
					}),
				),
				null,
				"email:legacy-v3@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(readAuthSchemaVersion(legacyDbPath)).toBe(7);
			expect(readTableSql(legacyDbPath, "auth_credentials")).not.toContain("unixepoch(");
			expect(readTableSql(legacyDbPath, "auth_credentials")).toContain("strftime('%s','now')");
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy-v3@example.com", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills identity_key when migrating v1 auth schema", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-v1-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 1);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({
						suffix: "legacy-v1",
						accountId: "legacy-v1-account",
						email: "legacy-v1@example.com",
					}),
				),
				null,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy-v1@example.com", disabled_cause: null },
			]);
		} finally {
			migratedStore.close();
		}
	});

	it("backfills disabled cause and identity_key when migrating legacy disabled rows", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const legacyDbPath = path.join(tempDir, "legacy-agent.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.run(`
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				"openai-codex",
				"oauth",
				JSON.stringify(
					createCredential({ suffix: "legacy", accountId: "legacy-account", email: "legacy@example.com" }),
				),
				1,
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(legacyDbPath);
		try {
			expect(migratedStore.listAuthCredentials("openai-codex")).toHaveLength(0);
			expect(readStoredIdentityRows(legacyDbPath, "openai-codex")).toEqual([
				{ identity_key: "email:legacy@example.com", disabled_cause: "disabled" },
			]);
		} finally {
			migratedStore.close();
		}
	});
});

describe("AuthStorage OAuth login upgrade and multi-account coexistence", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-login-test-"));
	});

	afterEach(async () => {
		unregisterOAuthProviders("auth-storage-login-upgrade-test");
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	it("allows multiple OAuth accounts to coexist and replaces legacy api_key rows on OAuth login", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const dbPath = path.join(tempDir, "login-upgrade.db");
		const authStorage = await AuthStorage.create(dbPath);

		try {
			// 1. Setup a legacy api_key credential
			await authStorage.set("unit-login-upgrade", { type: "api_key", key: "sk-legacy-key" });
			expect(await authStorage.getApiKey("unit-login-upgrade")).toBe("sk-legacy-key");

			// 2. Register custom oauth provider
			let loginReturns: (Omit<OAuthCredential, "type"> & { type?: string }) | null = null;
			registerOAuthProvider({
				id: "unit-login-upgrade",
				name: "Unit Login Upgrade",
				sourceId: "auth-storage-login-upgrade-test",
				login: async () => {
					if (!loginReturns) throw new Error("no credentials");
					const { type: _type, ...rest } = loginReturns;
					return rest;
				},
				refreshToken: async () => {
					if (!loginReturns) throw new Error("no credentials");
					const { type: _type, ...rest } = loginReturns;
					return rest;
				},
			});

			// 3. Login first OAuth account
			loginReturns = {
				refresh: "refresh-token-1",
				access: "access-token-1",
				expires: Date.now() + 60_000,
				projectId: "project-1",
				email: "user-1@example.com",
			};
			await authStorage.login("unit-login-upgrade", {
				onAuth: () => {},
				onPrompt: async () => "",
			});

			// Legacy api_key should be gone/replaced, and first oauth account is active.
			// getApiKey should now return the first OAuth access token (since the api_key is gone).
			expect(await authStorage.getApiKey("unit-login-upgrade")).toBe("access-token-1");
			const firstRows = readStoredIdentityRows(dbPath, "unit-login-upgrade");
			expect(firstRows).toEqual([
				{ identity_key: null, disabled_cause: "replaced by oauth login" },
				{ identity_key: "email:user-1@example.com", disabled_cause: null },
			]);

			// 4. Login second OAuth account
			loginReturns = {
				refresh: "refresh-token-2",
				access: "access-token-2",
				expires: Date.now() + 60_000,
				projectId: "project-2",
				email: "user-2@example.com",
			};
			await authStorage.login("unit-login-upgrade", {
				onAuth: () => {},
				onPrompt: async () => "",
			});

			// Both OAuth accounts should coexist! No accounts should be disabled
			const secondRows = readStoredIdentityRows(dbPath, "unit-login-upgrade");
			expect(secondRows).toEqual([
				{ identity_key: null, disabled_cause: "replaced by oauth login" },
				{ identity_key: "email:user-1@example.com", disabled_cause: null },
				{ identity_key: "email:user-2@example.com", disabled_cause: null },
			]);
		} finally {
			authStorage.close();
		}
	});

	it("keeps existing NVIDIA API keys active when login adds another key", async () => {
		if (!tempDir) throw new Error("test setup failed");

		const dbPath = path.join(tempDir, "api-key-rotation.db");
		const authStorage = await AuthStorage.create(dbPath);
		const prompts = ["nvapi-first", "nvapi-second"];
		const fetchMock: FetchImpl = async () =>
			new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

		try {
			await authStorage.login("nvidia", {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
				fetch: fetchMock,
			});
			await authStorage.login("nvidia", {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
				fetch: fetchMock,
			});

			expect(authStorage.listStoredCredentials("nvidia").map(entry => entry.credential)).toEqual([
				{ type: "api_key", key: "nvapi-first", source: "login" },
				{ type: "api_key", key: "nvapi-second", source: "login" },
			]);

			const selectedKeys = new Set<string>();
			for (let index = 0; index < 64; index += 1) {
				const key = await authStorage.getApiKey("nvidia", `session-${index}`);
				if (key) selectedKeys.add(key);
			}
			expect(selectedKeys).toEqual(new Set(["nvapi-first", "nvapi-second"]));
		} finally {
			authStorage.close();
		}
	});
});

describe("AuthStorage persistent session stickiness", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-test-"));
		dbPath = path.join(tempDir, "auth.db");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("persists session-sticky credentials across AuthStorage restarts", async () => {
		// 1. Initialize AuthStorage and log in two accounts
		let authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));

		try {
			const credential1: OAuthCredential = {
				type: "oauth",
				refresh: "refresh-token-1",
				access: "access-token-1",
				expires: Date.now() + 3600_000,
				projectId: "project-1",
				email: "user-1@example.com",
			};
			const credential2: OAuthCredential = {
				type: "oauth",
				refresh: "refresh-token-2",
				access: "access-token-2",
				expires: Date.now() + 3600_000,
				projectId: "project-2",
				email: "user-2@example.com",
			};
			await authStorage.set("unit-session-stickiness", [credential1, credential2]);

			// 2. Resolve initial key for session-1
			const key1 = await authStorage.getApiKey("unit-session-stickiness", "session-1");
			expect(key1).toBe("access-token-2");

			// 3. Rotate session-1's sticky credential to the sibling
			await authStorage.rotateSessionCredential("unit-session-stickiness", "session-1");
			const key2 = await authStorage.getApiKey("unit-session-stickiness", "session-1");
			expect(key2).toBe("access-token-1");

			// 4. Close AuthStorage to simulate process restart
			authStorage.close();

			// 5. Re-instantiate AuthStorage using the same DB
			authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
			await authStorage.reload();

			// 6. Retrieve the sticky key again for session-1 (should still be access-token-1)
			const key3 = await authStorage.getApiKey("unit-session-stickiness", "session-1");
			expect(key3).toBe("access-token-1");

			authStorage.close();
		} finally {
			// No-op
		}
	});

	it("drops persisted session stickiness after a lower-index credential is removed", async () => {
		const provider = "unit-sticky-invalidation";
		const mk = (suffix: string): OAuthCredential => ({
			type: "oauth",
			refresh: `refresh-${suffix}`,
			access: `access-${suffix}`,
			expires: Date.now() + 3600_000,
			projectId: `project-${suffix}`,
			email: `user-${suffix}@example.com`,
		});
		const initialCredentials = [mk("a"), mk("b"), mk("c"), mk("d")];
		const remainingCredentials = initialCredentials.slice(1);

		let authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
		await authStorage.set(provider, initialCredentials);
		let rows = authStorage.listStoredCredentials(provider);

		const control = new AuthStorage(
			new SqliteAuthCredentialStore(new Database(path.join(tempDir, "sticky-control.db"))),
		);
		await control.set(provider, remainingCredentials);
		let session: string | undefined;
		let stuckId = -1;
		let stuckIndex = -1;
		let stuckToken: string | undefined;
		let freshToken: string | undefined;
		try {
			for (let i = 0; i < 256 && session === undefined; i++) {
				const candidate = `sticky-probe-${i}`;
				const token = await authStorage.getApiKey(provider, candidate);
				const expectedFreshToken = await control.getApiKey(provider, candidate);
				const index = rows.findIndex(row => (row.credential as OAuthCredential).access === token);
				if (index >= 1 && index <= rows.length - 2 && token !== expectedFreshToken) {
					session = candidate;
					stuckIndex = index;
					stuckId = rows[index].id;
					stuckToken = token;
					freshToken = expectedFreshToken;
				}
			}
		} finally {
			control.close();
		}
		expect(session).toBeDefined();
		expect(freshToken).toBeDefined();

		expect(await authStorage.removeCredential(provider, rows[0].id)).toBe(true);
		authStorage.close();

		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(dbPath)));
		await authStorage.reload();
		rows = authStorage.listStoredCredentials(provider);
		expect(rows.findIndex(row => row.id === stuckId)).toBe(stuckIndex - 1);

		const resolved = await authStorage.getApiKey(provider, session);
		authStorage.close();
		expect(resolved).toBe(freshToken);
		expect(resolved).not.toBe(stuckToken);
	});
});
