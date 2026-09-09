import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasPendingMigration, migrate } from "@oh-my-pi/pi-mnemopi/core/migrations/e6-triplestore-split";
import { initTriples, TripleStore } from "@oh-my-pi/pi-mnemopi/core/triples";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const roots: string[] = [];

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-ts-e6-"));
	roots.push(root);
	return join(root, "triples.db");
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seedRows(dbPath: string, rows: readonly (readonly [string, string, string, string, number])[]): void {
	const store = new TripleStore(dbPath);
	try {
		for (const [subject, predicate, object, source, confidence] of rows) {
			store.conn.run(
				"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
				[subject, predicate, object, "2026-05-10", source, confidence],
			);
		}
	} finally {
		store.close();
	}
}

function annotationRows(dbPath: string): {
	memory_id: string;
	kind: string;
	value: string;
	source: string | null;
	confidence: number | null;
}[] {
	const db = openDatabase(dbPath);
	try {
		if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'annotations'").get() === null)
			return [];
		return db.query("SELECT memory_id, kind, value, source, confidence FROM annotations ORDER BY id").all() as {
			memory_id: string;
			kind: string;
			value: string;
			source: string | null;
			confidence: number | null;
		}[];
	} finally {
		closeQuietly(db);
	}
}

function tripleCount(dbPath: string): number {
	const db = openDatabase(dbPath);
	try {
		const row = db.query("SELECT COUNT(*) AS count FROM triples").get() as { count: number };
		return row.count;
	} finally {
		closeQuietly(db);
	}
}

describe("E6 triplestore split migration", () => {
	it("migrates annotation-flavored rows and preserves temporal triples", () => {
		const dbPath = tempDb();
		seedRows(dbPath, [
			["mem-1", "mentions", "Alice", "extraction", 0.9],
			["mem-1", "mentions", "Bob", "extraction", 0.9],
			["mem-1", "fact", "The user enjoys coffee", "test", 0.7],
			["mem-2", "occurred_on", "2026-01-15", "ingest", 1.0],
			["mem-3", "has_source", "tool:cron", "ingest", 1.0],
			["user", "prefers", "concise responses", "stated", 1.0],
		]);
		const logs: string[] = [];

		const written = migrate({ dbPath, backup: false, logFn: line => logs.push(line) });

		expect(written).toBe(5);
		expect(tripleCount(dbPath)).toBe(6);
		const rows = annotationRows(dbPath);
		expect(rows).toHaveLength(5);
		expect(
			rows
				.filter(row => row.kind === "mentions")
				.map(row => row.value)
				.sort(),
		).toEqual(["Alice", "Bob"]);
		expect(rows.find(row => row.kind === "fact")).toMatchObject({
			source: "test",
			confidence: 0.7,
		});
		expect(logs.some(line => line.includes("rows-to-migrate") && line.includes("5"))).toBe(true);
	});

	it("is idempotent and picks up only new legacy annotation rows on rerun", () => {
		const dbPath = tempDb();
		seedRows(dbPath, [["mem-1", "mentions", "Alice", "extraction", 0.9]]);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(0);
		expect(annotationRows(dbPath)).toHaveLength(1);

		const db = openDatabase(dbPath);
		try {
			db.run(
				"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
				["mem-1", "mentions", "Bob", "2026-05-11", "extraction", 0.9],
			);
		} finally {
			closeQuietly(db);
		}

		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);
		expect(
			annotationRows(dbPath)
				.map(row => row.value)
				.sort(),
		).toEqual(["Alice", "Bob"]);
	});

	it("ignores duplicate annotation rows instead of aborting on the unique index", () => {
		const dbPath = tempDb();
		seedRows(dbPath, [
			["mem-1", "mentions", "Alice", "extraction", 0.9],
			["mem-1", "mentions", "Alice", "extraction", 0.9],
		]);

		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(0);
		expect(annotationRows(dbPath)).toEqual([
			{ memory_id: "mem-1", kind: "mentions", value: "Alice", source: "extraction", confidence: 0.9 },
		]);
	});

	it("reports dry-run counts without writes and writes backup only when requested", () => {
		const dbPath = tempDb();
		seedRows(dbPath, [
			["mem-1", "mentions", "Alice", "extraction", 0.9],
			["mem-1", "fact", "Some fact long enough", "test", 0.7],
		]);
		expect(migrate({ dbPath, dryRun: true, backup: false, logFn: () => undefined })).toBe(2);
		expect(annotationRows(dbPath)).toHaveLength(0);
		expect(existsSync(`${dbPath}.pre_e6_backup`)).toBe(false);

		expect(migrate({ dbPath, backup: true, logFn: () => undefined })).toBe(2);
		expect(existsSync(`${dbPath}.pre_e6_backup`)).toBe(true);
		writeFileSync(`${dbPath}.pre_e6_backup`, "sentinel");
		seedRows(dbPath, [["mem-2", "mentions", "Carol", "extraction", 0.8]]);
		expect(migrate({ dbPath, backup: true, logFn: () => undefined })).toBe(1);
		expect(readFileSync(`${dbPath}.pre_e6_backup`, "utf8")).toBe("sentinel");
	});

	it("is a no-op for empty databases and non-annotation triples", () => {
		const empty = tempDb();
		closeQuietly(new Database(empty, { create: true }));
		expect(migrate(empty, false, false, () => undefined)).toBe(0);

		const dbPath = tempDb();
		seedRows(dbPath, [["user", "prefers", "concise", "stated", 1.0]]);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(0);
		expect(annotationRows(dbPath)).toHaveLength(0);
	});

	it("detects pending migration cheaply", () => {
		const dbPath = tempDb();
		closeQuietly(new Database(dbPath, { create: true }));
		let db = openDatabase(dbPath);
		try {
			expect(hasPendingMigration(db)).toBe(false);
		} finally {
			closeQuietly(db);
		}

		initTriples(dbPath);
		db = openDatabase(dbPath);
		try {
			db.run(
				"INSERT INTO triples (subject, predicate, object, valid_from) VALUES ('user', 'prefers', 'concise', '2026-01-01')",
			);
			expect(hasPendingMigration(db)).toBe(false);
			db.run(
				"INSERT INTO triples (subject, predicate, object, valid_from) VALUES ('mem-1', 'mentions', 'Alice', '2026-01-01')",
			);
			expect(hasPendingMigration(db)).toBe(true);
		} finally {
			closeQuietly(db);
		}

		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);
		db = openDatabase(dbPath);
		try {
			expect(hasPendingMigration(db)).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});
});
