import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	isSqliteCorruptionError,
	openSqliteDatabase,
	openSqliteDatabaseSync,
	readSalvageableRows,
} from "../src/sqlite";
import { TempDir } from "../src/temp";

async function corruptSchemaPages(dbPath: string): Promise<Buffer<ArrayBuffer>> {
	const db = new Database(dbPath);
	db.run("CREATE TABLE entries (value TEXT)");
	db.run("INSERT INTO entries VALUES ('evidence')");
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();

	const damaged = await fs.promises.readFile(dbPath);
	damaged.fill(0xff, 100);
	await fs.promises.writeFile(dbPath, damaged);
	return damaged;
}

async function backupNames(dirPath: string, dbName = "store.db"): Promise<string[]> {
	return (await fs.promises.readdir(dirPath)).filter(name => name.startsWith(`${dbName}.corrupt-`));
}

test("failed asynchronous initialization releases and rolls back its write transaction", async () => {
	await using dir = await TempDir.create("@omp-sqlite-init-");
	const dbPath = dir.join("store.db");
	await expect(
		openSqliteDatabase(dbPath, async db => {
			db.run("CREATE TABLE entries (value TEXT)");
			db.run("BEGIN IMMEDIATE");
			db.run("INSERT INTO entries VALUES ('uncommitted')");
			await Promise.resolve();
			db.run("INSERT INTO missing_table VALUES (1)");
		}),
	).rejects.toThrow(dbPath);

	const rows = await openSqliteDatabase(dbPath, db => {
		try {
			db.run("INSERT INTO entries VALUES ('reopened')");
			return db.query<{ value: string }, []>("SELECT value FROM entries").all();
		} finally {
			db.close();
		}
	});
	expect(rows).toEqual([{ value: "reopened" }]);
});

test("corruption recovery is opt-in and the default preserves the active evidence", async () => {
	await using dir = await TempDir.create("@omp-sqlite-default-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = Buffer.from("not a sqlite database".repeat(64));
	await fs.promises.writeFile(dbPath, damaged);

	let failure: unknown;
	try {
		await openSqliteDatabase(dbPath, db => db.query("SELECT name FROM sqlite_master").all());
	} catch (error) {
		failure = error;
	}

	expect(isSqliteCorruptionError(failure)).toBe(true);
	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error)) throw new Error("Expected SQLite initialization to fail");
	expect(failure.message).toContain(dbPath);
	expect(await fs.promises.readFile(dbPath)).toEqual(damaged);
	expect(await backupNames(dir.path())).toEqual([]);
});

test("synchronous recovery preserves malformed schema pages and yields a persistent database", async () => {
	await using dir = await TempDir.create("@omp-sqlite-sync-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);

	openSqliteDatabaseSync(
		dbPath,
		db => {
			db.run("CREATE TABLE recovered (value TEXT)");
			db.run("INSERT INTO recovered VALUES ('usable')");
			db.close();
		},
		{ recoverCorruption: true },
	);

	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	const backupPath = path.join(dir.path(), backups[0]!);
	expect(await fs.promises.readFile(backupPath)).toEqual(damaged);
	if (process.platform !== "win32") {
		expect((await fs.promises.stat(backupPath)).mode & 0o777).toBe(0o600);
	}

	const rows = openSqliteDatabaseSync(dbPath, db => {
		try {
			return db.query<{ value: string }, []>("SELECT value FROM recovered").all();
		} finally {
			db.close();
		}
	});
	expect(rows).toEqual([{ value: "usable" }]);
});

test("recovery preserves sidecars present at corruption detection under one private backup name", async () => {
	await using dir = await TempDir.create("@omp-sqlite-sidecars-");
	const dbPath = dir.join("store.db");
	const contents = new Map<string, Buffer<ArrayBuffer>>([
		["", Buffer.from("not a database")],
		["-wal", Buffer.from("damaged wal evidence")],
		["-shm", Buffer.from("damaged shm evidence")],
		["-journal", Buffer.from("damaged journal evidence")],
	]);
	for (const [suffix, bytes] of contents) await fs.promises.writeFile(`${dbPath}${suffix}`, bytes);

	await openSqliteDatabase(
		dbPath,
		async db => {
			try {
				db.run("CREATE TABLE recovered (value TEXT)");
			} catch (error) {
				// SQLite rebuilds its disposable shared-memory index while opening.
				contents.set("-shm", await fs.promises.readFile(`${dbPath}-shm`));
				// SQLite removes invalid rollback journals before reporting corruption.
				await fs.promises.writeFile(`${dbPath}-journal`, contents.get("-journal")!);
				throw error;
			}
			db.close();
		},
		{ recoverCorruption: true },
	);

	const mainBackups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(mainBackups).toHaveLength(1);
	const backupPath = path.join(dir.path(), mainBackups[0]!);
	for (const [suffix, bytes] of contents) {
		expect(await fs.promises.readFile(`${backupPath}${suffix}`)).toEqual(bytes);
		if (process.platform !== "win32") {
			expect((await fs.promises.stat(`${backupPath}${suffix}`)).mode & 0o777).toBe(0o600);
		}
	}
});

test("concurrent failed openers adopt one replacement without discarding each other's writes", async () => {
	await using dir = await TempDir.create("@omp-sqlite-concurrent-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const ready = Promise.withResolvers<void>();
	let opened = 0;
	const initialize = async (db: Database): Promise<Database> => {
		if (++opened === 2) ready.resolve();
		await ready.promise;
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE IF NOT EXISTS recovered (value TEXT)");
		return db;
	};

	const handles = await Promise.all([
		openSqliteDatabase(dbPath, initialize, { recoverCorruption: true }),
		openSqliteDatabase(dbPath, initialize, { recoverCorruption: true }),
	]);
	try {
		handles[0].run("INSERT INTO recovered VALUES ('first')");
		handles[1].run("INSERT INTO recovered VALUES ('second')");
		expect(handles[0].query<{ value: string }, []>("SELECT value FROM recovered ORDER BY value").all()).toEqual([
			{ value: "first" },
			{ value: "second" },
		]);
	} finally {
		for (const db of handles) db.close();
	}
	const backups = await backupNames(dir.path());
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a second corruption failure surfaces without rotating the first backup again", async () => {
	await using dir = await TempDir.create("@omp-sqlite-repeat-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	await expect(
		openSqliteDatabase(dbPath, db => db.run("CREATE TABLE recovered (value TEXT)"), {
			recoverCorruption: true,
			onCorruptionPreserved: backupPath => fs.copyFileSync(backupPath, dbPath),
		}),
	).rejects.toMatchObject({ code: "SQLITE_CORRUPT", message: expect.stringContaining(dbPath) });
	const backups = await backupNames(dir.path());
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("opt-in recovery never rotates a non-corruption SQLite failure", async () => {
	await using dir = await TempDir.create("@omp-sqlite-error-");
	const dbPath = dir.join("store.db");

	let failure: unknown;
	try {
		openSqliteDatabaseSync(dbPath, db => db.run("INSERT INTO missing_table VALUES (1)"), { recoverCorruption: true });
	} catch (error) {
		failure = error;
	}

	expect(isSqliteCorruptionError(failure)).toBe(false);
	expect(failure).toBeInstanceOf(Error);
	if (!(failure instanceof Error)) throw new Error("Expected SQLite initialization to fail");
	expect(failure.message).toContain(dbPath);
	expect(await backupNames(dir.path())).toEqual([]);
});

/** Point the freelist trunk at a page past EOF: reads still work, but the next page allocation fails. */
async function corruptFreelist(dbPath: string) {
	const seed = new Database(dbPath);
	seed.run("CREATE TABLE existing (value TEXT)");
	seed.close();
	const damaged = await fs.promises.readFile(dbPath);
	damaged.writeUInt32BE(0x0d000000, 32);
	damaged.writeUInt32BE(1, 36);
	await fs.promises.writeFile(dbPath, damaged);
	return damaged;
}

test("recovery still fires when a multi-statement script hides the corruption behind a later error", async () => {
	await using dir = await TempDir.create("@omp-sqlite-hidden-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptFreelist(dbPath);

	const initialize = (db: Database) => {
		// Bun reports only the final statement's step error, so the failed CREATE is dropped here...
		db.run("CREATE TABLE IF NOT EXISTS added (value TEXT); CREATE TABLE IF NOT EXISTS existing (value TEXT);");
		// ...and resurfaces as SQLITE_ERROR, which on its own would not trigger recovery.
		db.prepare("SELECT value FROM added").finalize();
		return db;
	};

	const db = await openSqliteDatabase(dbPath, initialize, { recoverCorruption: true });
	try {
		expect(db.query("SELECT value FROM added").all()).toEqual([]);
	} finally {
		db.close();
	}
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

test("a non-corruption init failure on a store that fails quick_check is preserved as corruption", async () => {
	await using dir = await TempDir.create("@omp-sqlite-init-fails-on-corrupt-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptFreelist(dbPath);
	const initFailure = new Error("init failed");
	let attempts = 0;
	let preserved: unknown;

	const db = await openSqliteDatabase(
		dbPath,
		handle => {
			if (attempts++ === 0) throw initFailure;
			return handle;
		},
		{ recoverCorruption: true, onCorruptionPreserved: (_backupPath, error) => (preserved = error) },
	);
	db.close();

	expect(attempts).toBe(2);
	expect(isSqliteCorruptionError(preserved)).toBe(true);
	expect((preserved as Error | undefined)?.cause).toBe(initFailure);
	const backups = (await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name));
	expect(backups).toHaveLength(1);
	expect(await fs.promises.readFile(path.join(dir.path(), backups[0]!))).toEqual(damaged);
});

/** Decodes the rowids a table leaf page holds, in rowid order. Page indices are 0-based file pages. */
function leafPageIds(bytes: Buffer, page: number, pageSize: number): number[] {
	const start = page * pageSize;
	if (page === 0 || bytes[start] !== 0x0d) return [];
	const header = start;
	const cells = bytes.readUInt16BE(header + 3);
	const ids: number[] = [];
	for (let index = 0; index < cells; index++) {
		const cell = start + bytes.readUInt16BE(header + 8 + index * 2);
		if (cell < header + 8 + cells * 2 || cell + 5 > start + pageSize) continue;
		// Table leaf cell: payload-size varint, then the rowid varint.
		let offset = cell;
		for (let consumed = 0; offset < start + pageSize; consumed++, offset++) {
			const byte = bytes[offset]!;
			if (consumed === 8 || byte < 0x80) {
				offset++;
				break;
			}
		}
		let key = 0n;
		for (let byteIndex = 0; offset < start + pageSize; byteIndex++, offset++) {
			const byte = bytes[offset]!;
			key = (key << BigInt(byteIndex === 8 ? 8 : 7)) | BigInt(byteIndex === 8 ? byte : byte & 0x7f);
			if (byteIndex === 8 || byte < 0x80) break;
		}
		const rowid = Number(BigInt.asIntN(64, key));
		if (Number.isSafeInteger(rowid)) ids.push(rowid);
	}
	return ids.sort((a, b) => a - b);
}

/** Seeds rows spread over several leaf pages and returns each leaf's row ids in rowid order. */
function seedLeaves(dbPath: string, count = 200): { pageSize: number; leaves: Array<{ page: number; ids: number[] }> } {
	const db = new Database(dbPath);
	// Zero freed space so each row's bytes appear only on the leaf that holds it.
	db.run("PRAGMA secure_delete = ON");
	db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	db.transaction(() => {
		for (let id = 1; id <= count; id++) insert.run(id, `row-${String(id).padStart(4, "0")}-${"x".repeat(180)}`);
	})();
	insert.finalize();
	const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	db.close();
	const bytes = fs.readFileSync(dbPath);
	const leaves: Array<{ page: number; ids: number[] }> = [];
	for (let page = 1; page < bytes.length / pageSize; page++) {
		const ids = leafPageIds(bytes, page, pageSize);
		if (ids.length > 0) leaves.push({ page, ids });
	}
	leaves.sort((a, b) => a.ids[0]! - b.ids[0]!);
	return { pageSize, leaves };
}

test.each([
	["first", 0],
	["middle", 3],
	["second-to-last", -2],
])("salvage keeps every readable row on both sides of a damaged %s leaf", async (_label, position) => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-");
	const dbPath = dir.join("store.db");
	const { pageSize, leaves } = seedLeaves(dbPath);
	expect(leaves.length).toBeGreaterThan(5);
	const damaged = leaves.at(position)!;
	const fd = fs.openSync(dbPath, "r+");
	fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, damaged.page * pageSize);
	fs.closeSync(fd);

	const db = new Database(dbPath, { readonly: true });
	try {
		expect(() => db.query("SELECT count(*) FROM entries").get()).toThrow();
		const rows = readSalvageableRows<{ id: number }>(db, "entries", "id");
		const expected = leaves.filter(leaf => leaf !== damaged).flatMap(leaf => leaf.ids);
		expect(rows.map(row => row.id)).toEqual(expected);
	} finally {
		db.close();
	}
});

test("salvage keeps readable rows between separate damaged regions", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-island-");
	const dbPath = dir.join("store.db");
	const { pageSize, leaves } = seedLeaves(dbPath);
	const damaged = [leaves[0]!, leaves[2]!, leaves[3]!];
	const fd = fs.openSync(dbPath, "r+");
	try {
		for (const leaf of damaged) {
			fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, leaf.page * pageSize);
		}
	} finally {
		fs.closeSync(fd);
	}

	const db = new Database(dbPath, { readonly: true });
	try {
		const middleId = leaves[1]!.ids[0]!;
		expect(db.query("SELECT id FROM entries WHERE id = ?").get(middleId)).toEqual({ id: middleId });
		const rows = readSalvageableRows<{ id: number }>(db, "entries", "id");
		const expected = leaves.filter(leaf => !damaged.includes(leaf)).flatMap(leaf => leaf.ids);
		expect(rows.map(row => row.id)).toEqual(expected);
	} finally {
		db.close();
	}
});

/** Breaks the overflow chain of the oversized row: the first overflow page's next-pointer points at page 0x7fffffff. */
function breakFirstOverflowChain(dbPath: string, pageSize: number): void {
	const bytes = fs.readFileSync(dbPath);
	// The oversized row's payload spills into dedicated overflow pages. The
	// first of them is the lowest page that carries a long `y` run but is not
	// a table leaf (the leaf may also hold a local prefix of the run).
	const needle = Buffer.from("y".repeat(256));
	for (let page = 1; page < bytes.length / pageSize; page++) {
		const start = page * pageSize;
		if (bytes[start] === 0x0d || bytes[start] === 0x05) continue;
		if (bytes.indexOf(needle, start) < start + pageSize) {
			const corrupted = Buffer.from(bytes);
			corrupted.writeUInt32BE(0x7fffffff, start);
			fs.writeFileSync(dbPath, corrupted);
			return;
		}
	}
	throw new Error("no overflow page found for the oversized row");
}

test("salvage keeps rows around one row with a broken overflow chain", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-overflow-");
	const dbPath = dir.join("store.db");
	const db = new Database(dbPath);
	db.run("PRAGMA secure_delete = ON");
	db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	db.transaction(() => {
		for (let id = 1; id <= 40; id++) {
			insert.run(id, id === 20 ? "y".repeat(9000) : `row-${String(id).padStart(4, "0")}-${"x".repeat(180)}`);
		}
	})();
	insert.finalize();
	const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	db.close();
	breakFirstOverflowChain(dbPath, pageSize);

	const reopened = new Database(dbPath, { readonly: true });
	try {
		// Only row 20 is undecodable; every other row, before and after it,
		// must survive even though they share leaf pages with the damage.
		// The salvage selects the payload column so reading row 20 itself
		// follows the broken overflow chain, as callers reading prompts do.
		expect(() => reopened.query("SELECT id, value FROM entries WHERE id = 20").get()).toThrow();
		const rows = readSalvageableRows<{ id: number; value: string }>(reopened, "entries", "id, value");
		const expected = Array.from({ length: 40 }, (_, index) => index + 1).filter(id => id !== 20);
		expect(rows.map(row => row.id)).toEqual(expected);
	} finally {
		reopened.close();
	}
});

test("salvage keeps rows after a broken overflow chain in a single-leaf root", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-single-leaf-");
	const dbPath = dir.join("store.db");
	const db = new Database(dbPath);
	db.run("PRAGMA secure_delete = ON");
	db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	const insert = db.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	db.transaction(() => {
		for (let id = 1; id <= 8; id++) {
			insert.run(id, id === 3 ? "y".repeat(9000) : `row-${String(id).padStart(4, "0")}-${"x".repeat(180)}`);
		}
	})();
	insert.finalize();
	const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	db.close();
	breakFirstOverflowChain(dbPath, pageSize);

	const reopened = new Database(dbPath, { readonly: true });
	try {
		// The root is a single leaf, so there are no interior subtree keys and
		// the recovery must still cost only the damaged row itself.
		expect(() => reopened.query("SELECT id, value FROM entries WHERE id = 3").get()).toThrow();
		const rows = readSalvageableRows<{ id: number; value: string }>(reopened, "entries", "id, value");
		const expected = Array.from({ length: 8 }, (_, index) => index + 1).filter(id => id !== 3);
		expect(rows.map(row => row.id)).toEqual(expected);
	} finally {
		reopened.close();
	}
});

test("salvage falls back when interior separator keys are damaged", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-interior-");
	const dbPath = dir.join("store.db");
	const { pageSize, leaves } = seedLeaves(dbPath);
	expect(leaves.length).toBeGreaterThan(5);
	// Corrupt the first interior separator key so it no longer sorts below the
	// second key: the page's boundaries are damaged data and must not be used
	// as skip points. The key stays a small single-byte varint, so only seeks
	// up to the corrupted key are mis-routed into the damaged first leaf.
	const bytes = fs.readFileSync(dbPath);
	const rootPage = bytes.findIndex(
		(byte, offset) => byte === 0x05 && offset % pageSize === (Math.floor(offset / pageSize) === 0 ? 100 : 0),
	);
	expect(rootPage).toBeGreaterThan(0);
	const page = Math.floor(rootPage / pageSize);
	const firstCell = page * pageSize + bytes.readUInt16BE(rootPage + 12);
	const secondCell = page * pageSize + bytes.readUInt16BE(rootPage + 14);
	const secondKey = bytes[secondCell + 4]!;
	expect(secondKey).toBeLessThan(100);
	const corrupted = Buffer.from(bytes);
	corrupted[firstCell + 4] = secondKey + 10;
	// Damage the first leaf, which the corrupted separator now also routes the
	// following rowids into.
	corrupted.fill(0xff, leaves[0]!.page * pageSize, (leaves[0]!.page + 1) * pageSize);
	fs.writeFileSync(dbPath, corrupted);

	const db = new Database(dbPath, { readonly: true });
	try {
		const ids = readSalvageableRows<{ id: number }>(db, "entries", "id").map(row => row.id);
		// The unsorted separator makes SQLite's own seek routing inside the
		// first two subtrees unreliable, so only assert what must hold: the
		// bogus boundary is not used as a skip point, every leaf past the
		// corrupted key's subtree is fully recovered, and no row of the
		// damaged leaf is fabricated or returned.
		expect(ids).toEqual(expect.arrayContaining(leaves.slice(3).flatMap(leaf => leaf.ids)));
		expect(ids.filter(id => leaves[0]!.ids.includes(id))).toEqual([]);
		expect(new Set(ids).size).toBe(ids.length);
	} finally {
		db.close();
	}
});

test("salvage charges a run of adjacent damaged leaves as one damaged region", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-run-");
	const dbPath = dir.join("store.db");
	// Enough leaves that a contiguous damaged run longer than the
	// damaged-region cap can be survived when it counts as one region.
	const { pageSize, leaves } = seedLeaves(dbPath, 24000);
	expect(leaves.length).toBeGreaterThan(1100);
	const runStart = 100;
	const runLength = 1050;
	const fd = fs.openSync(dbPath, "r+");
	try {
		const blank = Buffer.alloc(pageSize, 0xff);
		for (let index = runStart; index < runStart + runLength; index++) {
			fs.writeSync(fd, blank, 0, pageSize, leaves[index]!.page * pageSize);
		}
	} finally {
		fs.closeSync(fd);
	}

	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = readSalvageableRows<{ id: number }>(db, "entries", "id");
		const expected = leaves
			.filter((leaf, index) => index < runStart || index >= runStart + runLength)
			.flatMap(leaf => leaf.ids);
		expect(rows.map(row => row.id)).toEqual(expected);
	} finally {
		db.close();
	}
});
