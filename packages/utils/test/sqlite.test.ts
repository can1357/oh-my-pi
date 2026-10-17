import { Database } from "bun:sqlite";
import { expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { tryAcquireFileLock } from "../src/file-lock";
import { normalizePathForComparison } from "../src/dirs";
import {
	isSqliteCorruptionError,
	onSqliteStoreQuarantine,
	openSqliteDatabase,
	openSqliteDatabaseSync,
	readDamagedSqliteRows,
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

/**
 * Corrupts the leaf page whose exact seek for `smallestId` fails while
 * `largestId` still reads — the leftmost leaf of `table` — without dbstat.
 */
async function corruptLeafHolding(
	dbPath: string,
	table: string,
	pristine: Buffer,
	pageSize: number,
	pageCount: number,
	smallestId: number,
	largestId: number,
): Promise<void> {
	for (let pageno = 2; pageno <= pageCount; pageno++) {
		await fs.promises.writeFile(dbPath, pristine);
		const fd = fs.openSync(dbPath, "r+");
		fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (pageno - 1) * pageSize);
		fs.closeSync(fd);
		const probe = new Database(dbPath, { readonly: true });
		let smallestDead = false;
		let largestLive = false;
		try {
			try {
				probe.query(`SELECT 1 FROM ${table} WHERE rowid = ?`).get(smallestId);
			} catch {
				smallestDead = true;
			}
			largestLive = probe.query(`SELECT 1 FROM ${table} WHERE rowid = ?`).get(largestId) !== null;
		} catch {
			largestLive = false;
		} finally {
			probe.close();
		}
		if (smallestDead && largestLive) return;
	}
	throw new Error(`no leaf page holds rowid ${smallestId}`);
}

async function waitForFile(filePath: string): Promise<void> {
	if (fs.existsSync(filePath)) return;
	const watcher = fs.watch(path.dirname(filePath));
	try {
		const { promise: appeared, resolve } = Promise.withResolvers<void>();
		const check = () => {
			if (fs.existsSync(filePath)) resolve();
		};
		watcher.on("change", check);
		watcher.on("rename", check);
		check();
		await appeared;
	} finally {
		watcher.close();
	}
}

// This exercises a real OS lock across processes; fake timers cannot control
// the child process while it synchronously waits inside the lease.
test("store leases serialize independent processes and close handles before release", async () => {
	await using dir = await TempDir.create("@omp-sqlite-lease-");
	const dbPath = dir.join("store.db");
	const readyPath = dir.join("ready");
	const releasePath = dir.join("release");
	const blockedPath = dir.join("blocked");
	const resultPath = dir.join("result");
	const sqliteModule = pathToFileURL(path.join(import.meta.dir, "../src/sqlite.ts")).href;
	const lockModule = pathToFileURL(path.join(import.meta.dir, "../src/file-lock.ts")).href;
	const firstPath = dir.join("first.ts");
	const secondPath = dir.join("second.ts");
	await Bun.write(
		firstPath,
		`import * as fs from "node:fs";\n` +
			`import { Database } from "bun:sqlite";\n` +
			`import { withSqliteStoreLease } from ${JSON.stringify(sqliteModule)};\n` +
			`withSqliteStoreLease(${JSON.stringify(dbPath)}, () => {\n` +
			`\tconst db = new Database(${JSON.stringify(dbPath)});\n` +
			`\ttry { db.run("CREATE TABLE entries (value TEXT)"); withSqliteStoreLease(${JSON.stringify(dbPath)}, () => db.run("INSERT INTO entries VALUES ('first')")); withSqliteStoreLease(${JSON.stringify(dbPath)}, () => { if (db.query("SELECT count(*) AS count FROM entries").get().count !== 1) throw new Error("nested write missing"); }); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); while (!fs.existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(5); }\n` +
			`\tfinally { db.close(); }\n` +
			`});\n`,
	);
	await Bun.write(
		secondPath,
		`import * as fs from "node:fs";\n` +
			`import { Database } from "bun:sqlite";\n` +
			`import { tryAcquireFileLock } from ${JSON.stringify(lockModule)};\n` +
			`import { withSqliteStoreLease } from ${JSON.stringify(sqliteModule)};\n` +
			`if (tryAcquireFileLock(${JSON.stringify(`${dbPath}.recovery`)})) throw new Error("lease was not held");\n` +
			`fs.writeFileSync(${JSON.stringify(blockedPath)}, "ready");\n` +
			`withSqliteStoreLease(${JSON.stringify(dbPath)}, () => {\n` +
			`\tconst db = new Database(${JSON.stringify(dbPath)});\n` +
			`\ttry { if (db.query("SELECT value FROM entries").get()?.value !== "first") throw new Error("first write missing"); fs.writeFileSync(${JSON.stringify(resultPath)}, "ready"); }\n` +
			`\tfinally { db.close(); }\n` +
			`});\n`,
	);

	const first = Bun.spawn([process.execPath, firstPath], { stdout: "ignore", stderr: "pipe" });
	let second: Bun.Subprocess | undefined;
	try {
		await waitForFile(readyPath);
		second = Bun.spawn([process.execPath, secondPath], { stdout: "ignore", stderr: "pipe" });
		await waitForFile(blockedPath);
		expect(fs.existsSync(resultPath)).toBe(false);
		await Bun.write(releasePath, "release");
		expect(await first.exited).toBe(0);
		expect(await second.exited).toBe(0);
		expect(await Bun.file(resultPath).text()).toBe("ready");
	} finally {
		first.kill();
		second?.kill();
		await first.exited;
		if (second) await second.exited;
	}
});

test.each(["file", "directory", "dangling"])(
	"aliases share the recovery lease through a missing target: %s",
	async kind => {
		await using dir = await TempDir.create("@omp-sqlite-alias-");
		const targetDir = dir.join("target");
		fs.mkdirSync(targetDir);
		const dbPath = path.join(targetDir, "store.db");
		const alias = kind === "directory" ? dir.join("linked", "store.db") : dir.join("alias.db");
		if (kind === "directory") fs.symlinkSync(targetDir, dir.join("linked"), "junction");
		else fs.symlinkSync(dbPath, alias);
		if (kind !== "dangling") new Database(dbPath).close();
		const readyPath = dir.join("ready");
		const releasePath = dir.join("release");
		const scriptPath = dir.join("holder.ts");
		const sqliteModule = pathToFileURL(path.join(import.meta.dir, "../src/sqlite.ts")).href;
		await Bun.write(
			scriptPath,
			`import * as fs from "node:fs";
import { withSqliteStoreLease } from ${JSON.stringify(sqliteModule)};
withSqliteStoreLease(${JSON.stringify(alias)}, () => {
	fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
	while (!fs.existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(5);
});
`,
		);
		const child = Bun.spawn([process.execPath, scriptPath], { stdout: "ignore", stderr: "pipe" });
		try {
			await waitForFile(readyPath);
			const lock = tryAcquireFileLock(`${normalizePathForComparison(dbPath, { allowMissing: true })}.recovery`);
			try {
				expect(lock).toBeNull();
			} finally {
				lock?.release();
			}
			await Bun.write(releasePath, "release");
			expect(await child.exited).toBe(0);
		} finally {
			child.kill();
			await child.exited;
		}
	},
);

test("quarantining through a file alias replaces the target without destroying the alias", async () => {
	await using dir = await TempDir.create("@omp-sqlite-alias-quarantine-");
	const dbPath = dir.join("store.db");
	const alias = dir.join("alias.db");
	const evidence = await corruptSchemaPages(dbPath);
	fs.symlinkSync(dbPath, alias);
	const db = openSqliteDatabaseSync(
		alias,
		store => {
			store.run("CREATE TABLE entries (value TEXT)");
			store.run("INSERT INTO entries VALUES ('replacement')");
			return store;
		},
		{ recoverCorruption: true },
	);
	db.close();
	expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
	const check = new Database(dbPath);
	try {
		expect(check.query("SELECT value FROM entries").all()).toEqual([{ value: "replacement" }]);
	} finally {
		check.close();
	}
	const preserved = fs.readdirSync(dir.path()).find(name => name.startsWith("store.db.corrupt-"));
	expect(preserved).toBeDefined();
	expect(await fs.promises.readFile(dir.join(preserved!))).toEqual(evidence);
});

test("a failed evidence flush aborts quarantine before the original is removed", async () => {
	await using dir = await TempDir.create("@omp-sqlite-evidence-flush-");
	const dbPath = dir.join("store.db");
	const evidence = await corruptSchemaPages(dbPath);
	const flush = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
		throw new Error("backup flush failed");
	});
	try {
		expect(() =>
			openSqliteDatabaseSync(dbPath, db => db.query("SELECT * FROM entries").all(), {
				recoverCorruption: true,
			}),
		).toThrow("backup flush failed");
	} finally {
		flush.mockRestore();
	}
	expect(await fs.promises.readFile(dbPath)).toEqual(evidence);
});

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

test("preservation callback runs under the recovery lease before unlinking originals", async () => {
	await using dir = await TempDir.create("@omp-sqlite-preservation-callback-");
	const dbPath = dir.join("store.db");
	await corruptSchemaPages(dbPath);

	expect(() =>
		openSqliteDatabaseSync(dbPath, db => db.run("CREATE TABLE recovered (value TEXT)"), {
			recoverCorruption: true,
			onCorruptionPreserved(backupPath) {
				expect(fs.existsSync(dbPath)).toBe(true);
				expect(fs.existsSync(backupPath)).toBe(true);
				throw new Error("marker persistence failed");
			},
		}),
	).toThrow("marker persistence failed");
	expect(fs.existsSync(dbPath)).toBe(true);
	expect((await backupNames(dir.path())).filter(name => !/-wal$|-shm$|-journal$/.test(name))).toHaveLength(1);
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
	let attempts = 0;
	await expect(
		openSqliteDatabase(
			dbPath,
			db => {
				if (attempts++ === 0) return db.run("CREATE TABLE recovered (value TEXT)");
				db.close();
				fs.writeFileSync(dbPath, damaged);
				const corruptReplacement = new Database(dbPath);
				try {
					corruptReplacement.run("CREATE TABLE recovered (value TEXT)");
				} finally {
					corruptReplacement.close();
				}
			},
			{ recoverCorruption: true },
		),
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

test("a long-lived connection's quarantine hook runs after the evidence is copied and before the store is removed", async () => {
	await using dir = await TempDir.create("@omp-sqlite-quarantine-hook-");
	const dbPath = dir.join("store.db");
	const damaged = await corruptSchemaPages(dbPath);
	const observed: Array<{ storePresent: boolean; evidence: string[] }> = [];
	const unregister = onSqliteStoreQuarantine(dbPath, () => {
		observed.push({ storePresent: fs.existsSync(dbPath), evidence: fs.readdirSync(dir.path()) });
	});
	try {
		openSqliteDatabaseSync(
			dbPath,
			db => {
				db.query("SELECT count(*) FROM sqlite_master").get();
				db.close();
			},
			{ recoverCorruption: true },
		);
	} finally {
		unregister();
	}

	expect(observed).toHaveLength(1);
	expect(observed[0]!.storePresent).toBe(true);
	const backup = observed[0]!.evidence.find(name => /^store\.db\.corrupt-[^-]+-[0-9a-f-]+$/.test(name));
	expect(backup).toBeDefined();
	expect(await fs.promises.readFile(path.join(dir.path(), backup!))).toEqual(damaged);
});

test("damaged-row salvage terminates on a huge sparse AUTOINCREMENT high-water mark", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-sparse-");
	const db = new Database(dir.join("store.db"));
	try {
		db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)");
		db.run("INSERT INTO entries (id, value) VALUES (1, 'first'), (1099511627776, 'far')");
		db.run("UPDATE sqlite_sequence SET seq = 4503599627370495 WHERE name = 'entries'");

		expect(readDamagedSqliteRows(db, "entries", "id, value")).toEqual({
			rows: [
				{ id: 1, value: "first" },
				{ id: 1099511627776, value: "far" },
			],
			damagedRegions: 0,
		});
	} finally {
		db.close();
	}
});

test("damaged-row salvage includes both signed rowid endpoints without duplicates", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`
			CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT);
			INSERT INTO entries VALUES (-9223372036854775808, 'minimum');
		`);
		expect(readDamagedSqliteRows(db, "entries", "CAST(id AS TEXT) AS id, value").rows).toEqual([
			{ id: "-9223372036854775808", value: "minimum" },
		]);
		db.exec(`
			INSERT INTO entries VALUES (0, 'zero'), (9007199254740993, 'wide'), (9223372036854775807, 'maximum');
		`);
		expect(readDamagedSqliteRows(db, "entries", "CAST(id AS TEXT) AS id, value")).toEqual({
			rows: [
				{ id: "-9223372036854775808", value: "minimum" },
				{ id: "0", value: "zero" },
				{ id: "9007199254740993", value: "wide" },
				{ id: "9223372036854775807", value: "maximum" },
			],
			damagedRegions: 0,
		});
	} finally {
		db.close();
	}
});

test.each([
	{ region: "a middle leaf", page: (pages: number) => Math.floor(pages / 2), lastSurvives: true },
	{ region: "the rightmost leaf", page: (pages: number) => pages, lastSurvives: false },
])("damaged-row salvage reads past damage in $region", async ({ page, lastSurvives }) => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-damaged-");
	const dbPath = dir.join("store.db");
	const total = 40;
	const seed = new Database(dbPath);
	// No AUTOINCREMENT: a damaged rightmost page leaves no readable max rowid to bound the scan.
	seed.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
	const insert = seed.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	// ~1.5 KB rows: at most two per leaf, and appends allocate leaves in rowid order.
	for (let id = 1; id <= total; id++) insert.run(id, `${id}:${"x".repeat(1500)}`);
	const pageSize = seed.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const pageCount = seed.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
	seed.close();
	const fd = fs.openSync(dbPath, "r+");
	fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (page(pageCount) - 1) * pageSize);
	fs.closeSync(fd);

	const db = new Database(dbPath, { readonly: true });
	try {
		const { rows, damagedRegions } = readDamagedSqliteRows<{ id: number }>(db, "entries", "id");
		const ids = rows.map(row => row.id);
		expect(damagedRegions).toBeGreaterThanOrEqual(1);
		expect(ids[0]).toBe(1);
		expect(ids.length).toBeGreaterThanOrEqual(total - 2);
		expect(ids.includes(total)).toBe(lastSurvives);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
	} finally {
		db.close();
	}
});

test.each([1, -2])("damaged-row salvage recovers past a leftmost leaf starting at %i", async firstId => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-leftmost-");
	const dbPath = dir.join("store.db");
	const total = 60;
	const seed = new Database(dbPath);
	seed.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
	const insert = seed.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	if (firstId < 0) {
		for (let id = firstId; id < 0; id++) insert.run(id, `${id}:${"x".repeat(1500)}`);
	}
	for (let id = 1; id <= total; id++) insert.run(id, `${id}:${"x".repeat(1500)}`);
	const pageSize = seed.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const pageCount = seed.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
	seed.close();
	const pristine = await fs.promises.readFile(dbPath);

	// Corrupt the leftmost leaf: an exact seek for the smallest rowid must fail
	// while the largest still reads.
	await corruptLeafHolding(dbPath, "entries", pristine, pageSize, pageCount, firstId, total);

	const db = new Database(dbPath, { readonly: true });
	try {
		const { rows, damagedRegions } = readDamagedSqliteRows<{ id: number }>(db, "entries", "id");
		const ids = rows.map(row => row.id);
		expect(damagedRegions).toBeGreaterThanOrEqual(1);
		// Only the rows physically on the destroyed leaf are unrecoverable.
		expect(ids.length).toBeGreaterThanOrEqual(total - 3);
		expect(ids[ids.length - 1]).toBe(total);
	} finally {
		db.close();
	}
});

test("damaged-row salvage recovers a negative-only table past a damaged leftmost leaf", async () => {
	await using dir = await TempDir.create("@omp-sqlite-salvage-negative-");
	const dbPath = dir.join("store.db");
	const total = 60;
	const seed = new Database(dbPath);
	seed.run("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
	const insert = seed.prepare("INSERT INTO entries (id, value) VALUES (?, ?)");
	for (let id = -total; id <= -1; id++) insert.run(id, `${id}:${"x".repeat(1500)}`);
	const pageSize = seed.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const pageCount = seed.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
	seed.close();
	const pristine = await fs.promises.readFile(dbPath);
	await corruptLeafHolding(dbPath, "entries", pristine, pageSize, pageCount, -total, -1);

	const db = new Database(dbPath, { readonly: true });
	try {
		const { rows, damagedRegions } = readDamagedSqliteRows<{ id: number }>(db, "entries", "id");
		const ids = rows.map(row => row.id);
		expect(damagedRegions).toBeGreaterThanOrEqual(1);
		// Only the rows physically on the destroyed leaf are unrecoverable.
		expect(ids.length).toBeGreaterThanOrEqual(total - 3);
		expect(ids[ids.length - 1]).toBe(-1);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
	} finally {
		db.close();
	}
});
