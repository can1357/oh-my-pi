import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage, SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readTableSql } from "./helpers/sqlite-inspect";

const LEGACY_TIMESTAMP = 1_700_000_000;

function readSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function readSettingsRows(dbPath: string): Array<{ key: string; value: string; updated_at: number }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key ASC").all() as Array<{
			key: string;
			value: string;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

describe("AgentStorage SQLite compatibility", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.close();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	it("creates fresh storage without unixepoch defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-fresh-");
		const dbPath = path.join(tempDir.path(), "agent.db");

		const storage = await AgentStorage.open(dbPath);
		storage.recordModelUsage("openai/gpt-5");

		expect(storage.getModelUsageOrder()).toEqual(["openai/gpt-5"]);
		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(readTableSql(dbPath, "settings")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "settings")).toContain("strftime('%s','now')");
		expect(readTableSql(dbPath, "model_usage")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "model_usage")).toContain("strftime('%s','now')");
	});

	it("migrates legacy settings and model usage schemas away from unixepoch defaults", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-legacy-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
			INSERT INTO schema_version(version) VALUES (4);
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
			CREATE TABLE model_usage (
				model_key TEXT PRIMARY KEY,
				last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		legacyDb
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("theme", '"dark"', LEGACY_TIMESTAMP);
		legacyDb
			.prepare("INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)")
			.run("anthropic/claude-sonnet-4-5", LEGACY_TIMESTAMP);
		legacyDb.close();

		const storage = await AgentStorage.open(dbPath);

		expect(readSchemaVersion(dbPath)).toBe(SCHEMA_VERSION);
		expect(readTableSql(dbPath, "settings")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "settings")).toContain("strftime('%s','now')");
		expect(readTableSql(dbPath, "model_usage")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "model_usage")).toContain("strftime('%s','now')");
		expect(storage.getSettings()).toEqual({ theme: "dark" });
		expect(storage.getModelUsageOrder()).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(readSettingsRows(dbPath)).toEqual([{ key: "theme", value: '"dark"', updated_at: LEGACY_TIMESTAMP }]);
	});
});
