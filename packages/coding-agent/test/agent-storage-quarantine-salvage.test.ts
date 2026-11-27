/**
 * AgentStorage opens the same agent.db as the auth store and must salvage too.
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
import { CredentialCipher } from "@oh-my-pi/pi-ai/auth/credential-cipher";
import { SqliteAuthCredentialStore, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../src/session/agent-storage";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-auth-salvage-"));
	dbPath = path.join(dir, "agent.db");
});

afterEach(() => {
	AgentStorage.close();
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

const KEYS: Record<string, string> = {
	deepseek: "sk-deepseek-fixture",
	cerebras: "csk-cerebras-fixture",
	inception: "sk-inception-fixture",
};

async function seedStore(cipher?: CredentialCipher): Promise<void> {
	const store = new SqliteAuthCredentialStore(new Database(dbPath), { cipher, encrypt: cipher !== undefined });
	for (const [provider, key] of Object.entries(KEYS)) {
		await store.replaceAuthCredentials(provider, [{ type: "api_key", key }]);
	}
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

/** Damages auth initialization without touching either credentials or metadata. */
async function damageAuthSchemaVersion(): Promise<void> {
	const db = new Database(dbPath, { readonly: true });
	let offset: number;
	try {
		using version = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'auth_schema_version'");
		using page = db.prepare("PRAGMA page_size");
		const { rootpage } = version.get() as { rootpage: number };
		const { page_size } = page.get() as { page_size: number };
		offset = (rootpage - 1) * page_size;
	} finally {
		db.close();
	}
	const bytes = await Bun.file(dbPath).bytes();
	bytes[offset] = 0xff;
	await Bun.write(dbPath, bytes);
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

function storedKeys(rows: StoredAuthCredential[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows) {
		if (row.credential.type === "api_key") out[row.provider] = row.credential.key;
	}
	return out;
}

describe("AgentStorage quarantine salvage", () => {
	test("credentials survive a store whose header page count is torn", async () => {
		await seedStore();
		tearHeader(dbPath);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const [storage, concurrent] = await Promise.all([AgentStorage.open(dbPath), AgentStorage.open(dbPath)]);
		expect(concurrent).toBe(storage);
		expect(storedKeys(await storage.listAuthCredentials())).toEqual(KEYS);
	});

	test("lazy auth recovery salvages credentials and rebinds the live metadata handle", async () => {
		await seedStore();
		await damageAuthSchemaVersion();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("openai/old-store");
		expect(storage.getModelUsageOrder()).toEqual(["openai/old-store"]);

		expect(storedKeys(await storage.listAuthCredentials())).toEqual(KEYS);
		expect(await AgentStorage.open(dbPath)).toBe(storage);
		expect(storage.getModelUsageOrder()).toEqual([]);
		storage.recordModelUsage("openai/recovered");
		AgentStorage.close();

		expect((await AgentStorage.open(dbPath)).getModelUsageOrder()).toEqual(["openai/recovered"]);
	});

	test("independent auth recovery releases an active local metadata connection", async () => {
		await seedStore();
		await damageAuthSchemaVersion();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("openai/old-store");
		expect(storage.getModelUsageOrder()).toEqual(["openai/old-store"]);

		const auth = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(storedKeys(auth.listAuthCredentials())).toEqual(KEYS);
			expect(storage.getModelUsageOrder()).toEqual([]);
			storage.recordModelUsage("openai/recovered");
			expect((await AgentStorage.open(dbPath)).getModelUsageOrder()).toEqual(["openai/recovered"]);
		} finally {
			auth.close();
		}
	});

	test("copies sealed credentials without opening the credential vault", async () => {
		const cipher = new CredentialCipher(new Uint8Array(32).fill(7));
		await seedStore(cipher);
		tearHeader(dbPath);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const unlock = vi
			.spyOn(SqliteAuthCredentialStore.prototype, "unlock")
			.mockRejectedValue(new Error("Vault accessed"));
		const storage = await AgentStorage.open(dbPath);
		expect(storage.getSettings()).toBeNull();
		expect(unlock).not.toHaveBeenCalled();
		AgentStorage.close();

		const db = new Database(dbPath);
		const store = new SqliteAuthCredentialStore(db, { cipher });
		try {
			using sealed = db.prepare("SELECT provider FROM auth_credentials WHERE salt IS NOT NULL ORDER BY provider");
			expect(sealed.all()).toEqual(
				Object.keys(KEYS)
					.sort()
					.map(provider => ({ provider })),
			);
			expect(storedKeys(store.listAuthCredentials())).toEqual(KEYS);
		} finally {
			store.close();
		}
	});

	test("retries a credential open after unlock rejects", async () => {
		await seedStore();
		const unlock = vi
			.spyOn(SqliteAuthCredentialStore.prototype, "unlock")
			.mockRejectedValueOnce(new Error("Vault unavailable"));
		const storage = await AgentStorage.open(dbPath);

		await expect(storage.listAuthCredentials()).rejects.toThrow("Vault unavailable");
		const [first, second] = await Promise.all([storage.listAuthCredentials(), storage.listAuthCredentials()]);
		expect(storedKeys(first)).toEqual(KEYS);
		expect(storedKeys(second)).toEqual(KEYS);
		expect(unlock).toHaveBeenCalledTimes(2);
	});

	test("a pending credential unlock cannot outlive storage close", async () => {
		const started = Promise.withResolvers<void>();
		const unlocked = Promise.withResolvers<void>();
		vi.spyOn(SqliteAuthCredentialStore.prototype, "unlock").mockImplementationOnce(() => {
			started.resolve();
			return unlocked.promise;
		});
		const storage = await AgentStorage.open(dbPath);
		const pending = storage.listAuthCredentials();
		await started.promise;
		AgentStorage.close();
		unlocked.resolve();
		await expect(pending).rejects.toThrow("AgentStorage is closed");
	});

	test("healthy metadata and cache access do not unlock a store with sealed credentials", async () => {
		await seedStore(new CredentialCipher(new Uint8Array(32).fill(7)));
		const unlock = vi
			.spyOn(SqliteAuthCredentialStore.prototype, "unlock")
			.mockRejectedValue(new Error("Vault accessed"));
		const storage = await AgentStorage.open(dbPath);

		expect(storage.getSettings()).toBeNull();
		storage.setCache("test", "cached", Math.floor(Date.now() / 1000) + 60);
		expect(storage.getCache("test")).toBe("cached");
		expect(await AgentStorage.open(dbPath)).toBe(storage);
		expect(unlock).not.toHaveBeenCalled();
	});
});
