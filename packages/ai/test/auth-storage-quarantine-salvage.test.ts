/**
 * A corrupt agent.db is quarantined and replaced by an empty store. The provider
 * credentials in it must come back, because workers otherwise fail with
 * "No API key for provider" until each provider is logged into again.
 *
 * The fixture reproduces the 2026-10-26 incident image: the main file holds
 * intact table pages, but page 1 declares one page more than the file contains, so
 * SQLite rejects every statement (SQLITE_CORRUPT) even though the rows are fine.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { isSqliteCorruptionError, logger } from "@oh-my-pi/pi-utils";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-auth-salvage-"));
	dbPath = path.join(dir, "agent.db");
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

const KEYS: Record<string, string> = {
	deepseek: "sk-deepseek-fixture",
	cerebras: "csk-cerebras-fixture",
	inception: "sk-inception-fixture",
};

async function seedStore(): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	for (const [provider, key] of Object.entries(KEYS)) {
		await store.replaceAuthCredentials(provider, [{ type: "api_key", key }]);
	}
	await store.replaceAuthCredentials("disabled", [{ type: "api_key", key: "sk-disabled" }]);
	await store.deleteAuthCredentials("disabled", "user-disabled");
	const db = new Database(dbPath);
	// Grow the file so tail pages exist, then fold the WAL into the main file.
	db.run("BEGIN");
	for (let i = 0; i < 600; i++) {
		db.run(
			"INSERT INTO usage_history (recorded_at, provider, account_key, limit_id, label) VALUES (?, 'p', 'a', ?, 'l')",
			[i, `limit-${i}-${"x".repeat(200)}`],
		);
	}
	db.run("COMMIT");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
	store.close();
}

/** Makes page 1 declare one more page than the file holds. */
function tearHeader(file: string): void {
	const fd = fs.openSync(file, "r+");
	try {
		const header = Buffer.alloc(100);
		fs.readSync(fd, header, 0, 100, 0);
		const pageSize = header.readUInt16BE(16);
		const pages = fs.statSync(file).size / pageSize;
		header.writeUInt32BE(pages + 1, 28);
		fs.writeSync(fd, header, 28, 4, 28);
	} finally {
		fs.closeSync(fd);
	}
}

function storedKeys(store: SqliteAuthCredentialStore): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of store.listAuthCredentials()) {
		if (row.credential.type === "api_key") out[row.provider] = row.credential.key;
	}
	return out;
}

describe("quarantine salvages stored credentials", () => {
	test("credentials survive a store whose header page count is torn", async () => {
		await seedStore();
		tearHeader(dbPath);
		const probe = new Database(dbPath);
		try {
			let thrown: unknown;
			try {
				probe.query("SELECT count(*) FROM auth_credentials").get();
			} catch (error) {
				thrown = error;
			}
			expect(isSqliteCorruptionError(thrown)).toBe(true);
		} finally {
			probe.close();
		}
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(storedKeys(store)).toEqual(KEYS);
			expect((await store.listDisabledCredentials()).map(row => row.cause)).toEqual(["user-disabled"]);
			expect(fs.readdirSync(dir).some(name => name.startsWith("agent.db.corrupt-"))).toBe(true);
			expect(warn.mock.calls.some(call => String(call[0]).includes("Restored credentials"))).toBe(true);
		} finally {
			store.close();
		}
	});

	test("legacy disabled credentials stay disabled after torn-header recovery", async () => {
		const db = new Database(dbPath);
		try {
			db.run(
				"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled INTEGER)",
			);
			for (const [id, provider, disabled] of [
				[1, "active", 0],
				[2, "disabled", 1],
			] as const) {
				db.run("INSERT INTO auth_credentials VALUES (?, ?, 'api_key', ?, ?)", [
					id,
					provider,
					JSON.stringify({ key: `sk-${provider}` }),
					disabled,
				]);
			}
		} finally {
			db.close();
		}
		tearHeader(dbPath);
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(storedKeys(store)).toEqual({ active: "sk-active" });
			expect(
				(await store.listDisabledCredentials()).map(row => ({ provider: row.provider, cause: row.cause })),
			).toEqual([{ provider: "disabled", cause: "disabled" }]);
		} finally {
			store.close();
		}
	});

	test("local-provider markers and retired provider ids survive the recovery", async () => {
		await seedStore();
		const seeded = new Database(dbPath);
		try {
			seeded.run("INSERT INTO auth_broker_local_providers (provider, created_at) VALUES ('deepseek', 1)");
			// A login stored by a build from before the provider split.
			seeded.run(
				"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES ('singularityapi', 'api_key', ?, 'legacy')",
				[JSON.stringify({ type: "api_key", key: "sk-sapi-fixture" })],
			);
			seeded.run("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			seeded.close();
		}
		tearHeader(dbPath);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(store.listBrokerLocalProviders()).toEqual(["deepseek"]);
			expect(storedKeys(store)["singularityapi-dev"]).toBe("sk-sapi-fixture");
			expect(storedKeys(store).singularityapi).toBeUndefined();
		} finally {
			store.close();
		}
	});

	test("a failed salvage is a loud error naming the quarantined path, never a throw", async () => {
		fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x41));
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(store.listAuthCredentials()).toEqual([]);
			const quarantined = fs.readdirSync(dir).find(name => /^agent\.db\.corrupt-\d+-[0-9a-f-]{36}$/.test(name));
			expect(quarantined).toBeDefined();
			const call = error.mock.calls.find(c => String(c[0]).includes("Could not restore credentials"));
			expect(call).toBeDefined();
			expect((call?.[1] as { quarantinedPath: string } | undefined)?.quarantinedPath).toBe(
				path.join(dir, quarantined as string),
			);
		} finally {
			store.close();
		}
	});
});
