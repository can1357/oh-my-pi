import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.resolve(import.meta.dir, "fixtures", "legacy-pi-extension-cache-probe.ts");
const healthProbePath = path.resolve(import.meta.dir, "fixtures", "legacy-pi-extension-cache-health-probe.ts");
const tempDirs: TempDir[] = [];

async function runProbe(cacheRoot: string, script: string = probePath, args: string[] = []): Promise<string> {
	const env: Record<string, string | undefined> = { ...process.env, XDG_CACHE_HOME: cacheRoot };
	for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
		delete env[key];
	}
	const proc = Bun.spawn([process.execPath, script, ...args], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

test("warm extension analysis preserves import rewriting without reparsing", async () => {
	const tempDir = TempDir.createSync("@legacy-pi-extension-cache-");
	tempDirs.push(tempDir);
	const cacheRoot = tempDir.path();
	await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });

	expect(await runProbe(cacheRoot)).toBe('import value from "./dependency.js?mtime=7";\n');

	expect(await runProbe(cacheRoot, probePath, ["--expect-cache-hit"])).toBe(
		'import value from "./dependency.js?mtime=7";\n',
	);
});

test("legacy extension parse cache drops obsolete CommonJS export-analysis columns", async () => {
	const tempDir = TempDir.createSync("@legacy-pi-extension-cache-schema-");
	tempDirs.push(tempDir);
	const cacheRoot = tempDir.path();
	const cachePath = path.join(cacheRoot, "omp", "cache", "legacy-pi-extension-cache.db");
	await fs.mkdir(path.dirname(cachePath), { recursive: true });

	const seed = new Database(cachePath, { create: true });
	seed.run(
		"CREATE TABLE extension_parse_cache (cache_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, [references] TEXT NOT NULL, commonjs_named_exports TEXT NOT NULL, commonjs_reexport_specifiers TEXT NOT NULL)",
	);
	seed.run("PRAGMA user_version = 1");
	seed.close();

	expect((await runProbe(cacheRoot, healthProbePath)).trim()).toBe("AVAILABLE");

	const migrated = new Database(cachePath);
	try {
		const columns = migrated
			.query<{ name: string }, []>("PRAGMA table_info(extension_parse_cache)")
			.all()
			.map(column => column.name);
		const schemaVersion = migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
		expect(columns).toEqual(["cache_key", "source_type", "references"]);
		expect(schemaVersion).toBe(2);
	} finally {
		migrated.close();
	}
});

test("legacy extension parse cache opens in WAL mode (#9549)", async () => {
	const tempDir = TempDir.createSync("@legacy-pi-extension-cache-wal-");
	tempDirs.push(tempDir);
	const cacheRoot = tempDir.path();
	await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });

	await runProbe(cacheRoot);

	// WAL is persisted in the db header, so a fresh connection reports it. The
	// default delete-journal mode serialized cache writes behind per-entry
	// journal create/delete + fsync and blocked startup for ~20s under
	// concurrent omp processes.
	const cachePath = path.join(cacheRoot, "omp", "cache", "legacy-pi-extension-cache.db");
	const db = new Database(cachePath);
	try {
		const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
		expect(mode).toBe("wal");
	} finally {
		db.close();
	}
});

test("oversized-cache eviction keeps the parse cache usable when a concurrent process holds the WAL (#9549)", async () => {
	const tempDir = TempDir.createSync("@legacy-pi-extension-cache-evict-");
	tempDirs.push(tempDir);
	const cacheRoot = tempDir.path();
	const cachePath = path.join(cacheRoot, "omp", "cache", "legacy-pi-extension-cache.db");
	await fs.mkdir(path.dirname(cachePath), { recursive: true });

	// Seed a cache whose main db file exceeds the 8 MiB eviction cap.
	const seed = new Database(cachePath, { create: true });
	seed.run(
		"CREATE TABLE extension_parse_cache (cache_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, [references] TEXT NOT NULL)",
	);
	seed.run("PRAGMA user_version = 2");
	seed.run("INSERT INTO extension_parse_cache VALUES ('big', 'module', ?)", ["x".repeat(9 * 1024 * 1024)]);
	seed.close();

	// A concurrent omp process holds the cache open in WAL mode with
	// uncheckpointed frames in its `-wal` (as a concurrently-starting omp does
	// while writing its own parse-cache entries).
	const concurrent = new Database(cachePath, { create: true });
	try {
		concurrent.run("PRAGMA busy_timeout = 5000");
		concurrent.run("PRAGMA journal_mode=WAL");
		const insert = concurrent.prepare("INSERT OR REPLACE INTO extension_parse_cache VALUES (?, 'module', ?)");
		for (let i = 0; i < 500; i++) insert.run(`live-${i}`, "y".repeat(4096));

		// The probe opens the cache, sees the oversized main file, and evicts.
		// Removing only the main db would leave the held `-wal`/`-shm`, and the
		// fresh connection's `journal_mode=WAL` would fail with SQLITE_IOERR —
		// disabling the parse cache. The full WAL-set eviction keeps it usable.
		expect((await runProbe(cacheRoot, healthProbePath)).trim()).toBe("AVAILABLE");
	} finally {
		concurrent.close();
	}
});
