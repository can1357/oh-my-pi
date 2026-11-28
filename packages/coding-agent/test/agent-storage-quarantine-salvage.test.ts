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
import * as vault from "@oh-my-pi/pi-ai/auth/credential-cipher";
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

async function seedStore(cipher?: vault.CredentialCipher): Promise<void> {
	const store = new SqliteAuthCredentialStore(new Database(dbPath), { cipher, encrypt: cipher !== undefined });
	for (const provider in KEYS) {
		await store.saveApiKey(provider, KEYS[provider]!);
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

function damageAuthSchemaVersion(): void {
	const db = new Database(dbPath, { readonly: true });
	let offset: number;
	try {
		using root = db.prepare<{ rootpage: number }, []>(
			"SELECT rootpage FROM sqlite_schema WHERE name = 'auth_schema_version'",
		);
		using size = db.prepare<{ page_size: number }, []>("PRAGMA page_size");
		offset = (root.get()!.rootpage - 1) * size.get()!.page_size;
	} finally {
		db.close();
	}
	const file = fs.openSync(dbPath, "r+");
	try {
		// Invalid b-tree page type; all non-auth pages remain readable.
		fs.writeSync(file, Buffer.from([0xff]), 0, 1, offset);
	} finally {
		fs.closeSync(file);
	}
}

function storedKeys(rows: StoredAuthCredential[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows) {
		if (row.credential.type === "api_key") out[row.provider] = row.credential.key;
	}
	return out;
}

test("metadata and cache never unlock auth; first concurrent credential reads unlock sealed rows once", async () => {
	const cipher = new vault.CredentialCipher(new Uint8Array(32).fill(7));
	await seedStore(cipher);
	const load = vi.spyOn(vault, "loadCredentialCipher").mockResolvedValue(cipher);
	const unlock = vi.spyOn(SqliteAuthCredentialStore.prototype, "unlock");
	const storage = await AgentStorage.open(dbPath);
	expect(storage.getSettings()).toBeNull();
	storage.setCache("cached", "value", Math.floor(Date.now() / 1000) + 60);
	expect(storage.getCache("cached")).toBe("value");
	expect(unlock).not.toHaveBeenCalled();
	expect(load).not.toHaveBeenCalled();

	const reads = await Promise.all([storage.listAuthCredentials(), storage.listAuthCredentials("deepseek")]);
	expect(storedKeys(reads[0])).toEqual(KEYS);
	expect(storedKeys(reads[1])).toEqual({ deepseek: KEYS.deepseek });
	expect(unlock).toHaveBeenCalledTimes(1);
	expect(load).toHaveBeenCalledTimes(1);
	expect(storage.getCache("cached")).toBe("value");
});

test("failed credential unlock leaves the borrowed metadata connection usable and can retry", async () => {
	await seedStore();
	const unlock = vi
		.spyOn(SqliteAuthCredentialStore.prototype, "unlock")
		.mockRejectedValueOnce(new Error("Vault unavailable"));
	const storage = await AgentStorage.open(dbPath);

	await expect(storage.listAuthCredentials()).rejects.toThrow("Vault unavailable");
	storage.setCache("cached", "value", Math.floor(Date.now() / 1000) + 60);
	expect(storage.getCache("cached")).toBe("value");
	expect(storedKeys(await storage.listAuthCredentials())).toEqual(KEYS);
	expect(unlock).toHaveBeenCalledTimes(2);
});

test("closing AgentStorage during unlock prevents the old credential read from succeeding", async () => {
	await seedStore();
	const started = Promise.withResolvers<void>();
	const unlocked = Promise.withResolvers<void>();
	vi.spyOn(SqliteAuthCredentialStore.prototype, "unlock").mockImplementationOnce(() => {
		started.resolve();
		return unlocked.promise;
	});
	const storage = await AgentStorage.open(dbPath);
	const read = storage.listAuthCredentials();
	await started.promise;
	AgentStorage.close();
	unlocked.resolve();

	await expect(read).rejects.toThrow("AgentStorage is closed");
	expect(storedKeys(await (await AgentStorage.open(dbPath)).listAuthCredentials())).toEqual(KEYS);
});

test("fresh metadata access does not create credential tables", async () => {
	const storage = await AgentStorage.open(dbPath);
	storage.recordModelUsage("test/model");
	const db = new Database(dbPath, { readonly: true });
	try {
		using authTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'auth_credentials'");
		expect(authTable.get()).toBeNull();
	} finally {
		db.close();
	}
	expect(storage.getModelUsageOrder()).toEqual(["test/model"]);
});

describe("AgentStorage quarantine salvage", () => {
	test("credentials survive a store whose header page count is torn", async () => {
		await seedStore();
		tearHeader(dbPath);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const [storage, concurrent] = await Promise.all([AgentStorage.open(dbPath), AgentStorage.open(dbPath)]);
		expect(concurrent).toBe(storage);
		expect(storedKeys(await storage.listAuthCredentials())).toEqual(KEYS);
	});

	test("lazy reads leave a live database in place; the auth opener can still recover it", async () => {
		const cipher = new vault.CredentialCipher(new Uint8Array(32).fill(7));
		await seedStore(cipher);
		damageAuthSchemaVersion();
		vi.spyOn(vault, "loadCredentialCipher").mockResolvedValue(cipher);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("old/model");
		expect(storage.getModelUsageOrder()).toEqual(["old/model"]);

		await expect(storage.listAuthCredentials()).rejects.toThrow(/corrupt|malformed/i);
		expect(storage.getModelUsageOrder()).toEqual(["old/model"]);
		expect(fs.readdirSync(dir).filter(name => name.includes(".corrupt-"))).toEqual([]);

		const owner = await SqliteAuthCredentialStore.open(dbPath, { encrypt: false });
		try {
			expect(storedKeys(owner.listAuthCredentials())).toEqual(KEYS);
			storage.recordModelUsage("recovered/model");
			expect(storage.getModelUsageOrder()).toEqual(["recovered/model"]);
		} finally {
			owner.close();
		}
	});
});
