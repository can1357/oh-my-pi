import { Database } from "bun:sqlite";
import { describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointWal, isSqliteCorruptionError, openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
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

function dbThrowing(code: string, message = code): Database {
	return {
		run() {
			throw Object.assign(new Error(message), { code });
		},
	} as unknown as Database;
}

describe("checkpointWal", () => {
	it("ignores already-closed database handles", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_MISUSE", "Database has closed"))).not.toThrow();
	});

	it("ignores SQLITE_IOERR_VNODE unlink races during shutdown", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_VNODE"))).not.toThrow();
	});

	it("surfaces real SQLITE_IOERR write and fsync failures", () => {
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_WRITE"))).toThrow(/SQLITE_IOERR_WRITE/);
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR_FSYNC"))).toThrow(/SQLITE_IOERR_FSYNC/);
		expect(() => checkpointWal(dbThrowing("SQLITE_IOERR"))).toThrow(/SQLITE_IOERR/);
	});
});
