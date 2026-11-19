import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeQuietly, openDatabase } from "../src/db";

const roots: string[] = [];

function tempDb(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopi-page-size-"));
	roots.push(root);
	return path.join(root, "test.db");
}

interface PageSizeRow {
	page_size: number;
}

function pageSize(db: Database): number {
	const row = db.query("PRAGMA page_size").get() as PageSizeRow;
	return row.page_size;
}

afterEach(() => {
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("db page size", () => {
	it("uses an explicitly requested page size for a new file-backed database", () => {
		const db = openDatabase(tempDb(), { pageSize: 16384 });
		try {
			expect(pageSize(db)).toBe(16384);
		} finally {
			closeQuietly(db);
		}
	});

	it("ignores invalid explicit page sizes", () => {
		const db = openDatabase(tempDb(), { pageSize: 12345 });
		try {
			expect(pageSize(db)).toBe(4096);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the existing page size when reopening a database with another request", () => {
		const dbPath = tempDb();
		const initial = openDatabase(dbPath, { pageSize: 4096 });
		try {
			initial.run("CREATE TABLE existing_data (value TEXT NOT NULL)");
		} finally {
			closeQuietly(initial);
		}

		const reopened = openDatabase(dbPath, { pageSize: 16384 });
		try {
			expect(pageSize(reopened)).toBe(4096);
		} finally {
			closeQuietly(reopened);
		}
	});

	it("does not set page size on in-memory databases", () => {
		const db = openDatabase(":memory:", { pageSize: 16384 });
		try {
			expect(pageSize(db)).toBe(4096);
		} finally {
			closeQuietly(db);
		}
	});
});
