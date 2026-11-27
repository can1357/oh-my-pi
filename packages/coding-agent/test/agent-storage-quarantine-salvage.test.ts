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
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { AgentStorage } from "../src/session/agent-storage";
import { logger } from "@oh-my-pi/pi-utils";

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

describe("AgentStorage quarantine salvage", () => {
	test("credentials survive a store whose header page count is torn", async () => {
		await seedStore();
		tearHeader(dbPath);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = await AgentStorage.open(dbPath);
		try {
			expect(storedKeys(storage.authStore as SqliteAuthCredentialStore)).toEqual(KEYS);
		} finally {
			AgentStorage.close();
		}
	});
});
