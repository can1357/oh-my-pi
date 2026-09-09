import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createBackup, emergencyRestore, restoreBackup, verifyIntegrity } from "@oh-my-pi/pi-mnemopi/dr/recovery";

const tempDirs: string[] = [];
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-recovery-"));
	tempDirs.push(dir);
	return dir;
}

function createSqliteDb(path: string): void {
	const db = new Database(path, { create: true, readwrite: true, strict: true });
	try {
		db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
		db.run("INSERT INTO memories (content) VALUES (?)", ["backup me"]);
	} finally {
		db.close();
	}
}

function readMemory(path: string): string {
	const db = new Database(path, { create: false, readwrite: false, strict: true });
	try {
		const row = db.query("SELECT content FROM memories WHERE id = 1").get() as {
			content: string;
		} | null;
		expect(row).not.toBeNull();
		if (row === null) throw new Error("Expected memory row to exist");
		return row.content;
	} finally {
		db.close();
	}
}

function writeCorruptSqliteBackup(path: string): void {
	writeFileSync(path, gzipSync(Buffer.concat([SQLITE_HEADER, Buffer.from("corrupt backup payload")])));
}

function withFrozenNow<T>(iso: string, fn: () => T): T {
	const realDate = Date;
	const fixedMs = realDate.parse(iso);
	class FrozenDate extends realDate {
		constructor(value?: string | number | Date) {
			if (value === undefined) super(fixedMs);
			else super(value);
		}

		static override now(): number {
			return fixedMs;
		}
	}
	globalThis.Date = FrozenDate as DateConstructor;
	try {
		return fn();
	} finally {
		globalThis.Date = realDate;
	}
}

afterEach(() => {
	for (;;) {
		const dir = tempDirs.pop();
		if (dir === undefined) break;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SQLite recovery helpers", () => {
	it("creates a compressed backup with metadata", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);

		const backup = createBackup(dbPath, backupDir);

		expect(backup.backup_path.startsWith(backupDir)).toBe(true);
		expect(backup.backup_path.endsWith(".db.gz")).toBe(true);
		expect(existsSync(backup.backup_path)).toBe(true);
		expect(existsSync(backup.metadata_path)).toBe(true);
		expect(backup.original_size).toBe(statSync(dbPath).size);
		expect(backup.backup_size).toBe(statSync(backup.backup_path).size);
		expect(backup.compressed).toBe(true);
		expect(
			Buffer.from(gunzipSync(readFileSync(backup.backup_path)))
				.subarray(0, 16)
				.toString("binary"),
		).toBe("SQLite format 3\0");
	});

	it("creates distinct backup files when called twice in the same second", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);

		const [first, second] = withFrozenNow("2026-05-30T12:00:00.000Z", () => [
			createBackup(dbPath, backupDir),
			createBackup(dbPath, backupDir),
		]);

		expect(first.backup_path).not.toBe(second.backup_path);
		expect(first.metadata_path).not.toBe(second.metadata_path);
		expect(existsSync(first.backup_path)).toBe(true);
		expect(existsSync(second.backup_path)).toBe(true);
		expect(existsSync(first.metadata_path)).toBe(true);
		expect(existsSync(second.metadata_path)).toBe(true);
	});

	it("returns true for a valid SQLite database integrity check", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		createSqliteDb(dbPath);

		expect(verifyIntegrity(dbPath)).toBe(true);
	});

	it("restores a backup to a new path", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const restoredPath = join(dir, "restored.db");
		createSqliteDb(dbPath);
		const backup = createBackup(dbPath, join(dir, "backups"));

		const restored = restoreBackup(backup.backup_path, restoredPath);

		expect(restored).toEqual({
			restored: true,
			backup_used: backup.backup_path,
			database_path: restoredPath,
			integrity_check: true,
		});
		expect(verifyIntegrity(restoredPath)).toBe(true);
		expect(readMemory(restoredPath)).toBe("backup me");
	});

	it("keeps the current WAL database untouched when a staged restore fails integrity", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		mkdirSync(backupDir, { recursive: true });
		const badBackup = join(backupDir, "mnemopi_backup_20260530_120000.db.gz");
		writeCorruptSqliteBackup(badBackup);
		const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)");
			db.run("INSERT INTO memories (content) VALUES (?)", ["wal protected"]);
			expect(existsSync(`${dbPath}-wal`)).toBe(true);

			expect(() => restoreBackup(badBackup, dbPath)).toThrow(/integrity/);

			expect(existsSync(`${dbPath}-wal`)).toBe(true);
			const row = db.query("SELECT content FROM memories WHERE id = 1").get() as { content: string } | null;
			expect(row?.content).toBe("wal protected");
		} finally {
			db.close();
		}
	});

	it("leaves the original database intact when emergency restore exhausts corrupt backups", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "mnemopi.db");
		const backupDir = join(dir, "backups");
		createSqliteDb(dbPath);
		mkdirSync(backupDir, { recursive: true });
		writeCorruptSqliteBackup(join(backupDir, "mnemopi_backup_20260530_120000.db.gz"));

		expect(() => emergencyRestore(backupDir, dbPath)).toThrow("All backups failed integrity check");
		expect(verifyIntegrity(dbPath)).toBe(true);
		expect(readMemory(dbPath)).toBe("backup me");
	});
});
