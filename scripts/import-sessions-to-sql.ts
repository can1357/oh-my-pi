#!/usr/bin/env bun
/**
 * Import every local session JSONL into the SQL session storage.
 *
 * Usage:
 *   bun scripts/import-sessions-to-sql.ts [--dry-run] [--limit N] [--db URL] [--help]
 *
 * Walks the sessions root at any depth under each project dir
 * (`~/.omp/agent/sessions/<project-dir>/…`): besides each bucket's session
 * files, a session's artifact tree holds sub-session and advisor transcripts
 * under the storage's absolute-path keys too. Upserts one row per file into
 * the table `SqlSessionStorage` owns (`omp_session_files`, overridable via
 * SESSIONS_DB_TABLE), keyed by the file's absolute path — or aliased path
 * when OMP_SESSION_PATH_PREFIX_ALIAS is set — the exact key format
 * `SessionManager` passes to the storage backend, so imported rows are
 * indistinguishable from rows a live `SESSIONS_DB_URL` run would write.
 *
 * Columns per row: `path` (absolute storage key), `content` (full JSONL body),
 * `mtime_ms` (the file's stat mtime); the title columns stay NULL so the
 * content's title slot line remains the single source of truth, exactly as a
 * freshly `SqlSessionStorage.create()`d table sees it.
 *
 * The connection URL comes from `--db` or `SESSIONS_DB_URL` (never printed).
 * PostgreSQL only — MySQL/SQLite tables are managed by `SqlSessionStorage`
 * itself at runtime. Idempotent: `ON CONFLICT (path) DO UPDATE`, guarded by
 * `excluded.mtime_ms > table.mtime_ms` and preserving non-null titles via
 * `COALESCE`, so re-runs never overwrite newer SQL rows with stale local JSONL.
 * `--dry-run` walks and reports without connecting; `--limit N` imports only
 * the first N files (walk order is bucket name, then file name).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionPathPrefixAlias } from "@oh-my-pi/pi-coding-agent/session/session-path-alias";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { hasFsCode } from "@oh-my-pi/pi-utils/fs-error";
import { SQL } from "bun";

/** True for a file that vanished under the walk: skip it, never abort the import. */
function isVanishedFileError(err: unknown): boolean {
	return hasFsCode(err, "ENOENT") || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EBUSY");
}

interface CliOptions {
	dryRun: boolean;
	limit: number | undefined;
	dbUrl: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { dryRun: false, limit: undefined, dbUrl: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (flag: string): string => {
			const inline = `=${flag}`;
			if (arg.startsWith(inline)) return arg.slice(inline.length);
			const next = argv[++i];
			if (next === undefined) throw new Error(`${flag} requires a value`);
			return next;
		};
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--limit") options.limit = Number.parseInt(value("--limit"), 10);
		else if (arg.startsWith("--limit=")) options.limit = Number.parseInt(arg.slice("--limit=".length), 10);
		else if (arg === "--db") options.dbUrl = value("--db");
		else if (arg.startsWith("--db=")) options.dbUrl = arg.slice("--db=".length);
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: bun scripts/import-sessions-to-sql.ts [--dry-run] [--limit N] [--db URL]");
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.limit !== undefined && !(options.limit > 0)) throw new Error("--limit must be a positive number");
	return options;
}

const formatBytes = (bytes: number): string => {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
};

const count = (n: number): string => n.toLocaleString("en-US");

/** Session files per project bucket, in walk order (bucket name, then file name). */
async function collectSessionFiles(
	sessionsRoot: string,
	limit: number | undefined,
): Promise<Array<{ dir: string; files: string[] }>> {
	let entries;
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
	} catch (err) {
		throw new Error(`Cannot read sessions root ${sessionsRoot}: ${err instanceof Error ? err.message : err}`);
	}
	const buckets: Array<{ dir: string; files: string[] }> = [];
	let total = 0;
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		// A bucket symlink is skipped, never followed (matches scanBucketFiles).
		if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
		const dir = path.join(sessionsRoot, entry.name);
		// Recursive: besides each bucket's session files, a session's artifact tree
		// (`<session-file-minus-ext>/…`, swept by deleteSessionWithArtifacts) holds
		// sub-session and advisor transcripts. They share the storage's absolute-path
		// key domain, so they import like any other session file.
		const names = [
			...(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: dir, followSymlinks: true }))),
		].sort();
		if (names.length === 0) continue;
		total += names.length;
		buckets.push({ dir, files: names.map(name => path.join(dir, name)) });
		if (limit !== undefined && total >= limit) break;
	}
	if (limit === undefined) return buckets;
	// Trim the walk to exactly `limit` files, keeping whole buckets where possible.
	let remaining = limit;
	for (const bucket of buckets) {
		const keep = Math.min(bucket.files.length, remaining);
		remaining -= keep;
		bucket.files = bucket.files.slice(0, keep);
	}
	return buckets.filter(bucket => bucket.files.length > 0);
}

/** Multi-row form of the backend's own postgres `upsertReplace` clause. */
function buildUpsert(table: string, rowCount: number): string {
	const tuples = Array.from(
		{ length: rowCount },
		(_, row) =>
			`($${row * 6 + 1}, $${row * 6 + 2}, $${row * 6 + 3}, $${row * 6 + 4}, $${row * 6 + 5}, $${row * 6 + 6})`,
	).join(", ");
	return (
		`INSERT INTO ${table} (path, content, mtime_ms, title, title_source, title_updated_at) VALUES ${tuples} ` +
		`ON CONFLICT (path) DO UPDATE SET ` +
		`content = excluded.content, ` +
		`mtime_ms = excluded.mtime_ms, ` +
		`title = COALESCE(excluded.title, ${table}.title), ` +
		`title_source = COALESCE(excluded.title_source, ${table}.title_source), ` +
		`title_updated_at = COALESCE(excluded.title_updated_at, ${table}.title_updated_at) ` +
		`WHERE excluded.mtime_ms > ${table}.mtime_ms`
	);
}

const FLUSH_ROW_LIMIT = 100;
const FLUSH_BYTES_LIMIT = 16 * 1024 * 1024;

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const sessionsRoot = getSessionsDir();
	const url = options.dbUrl ?? process.env.SESSIONS_DB_URL?.trim();
	if (!options.dryRun && !url) {
		throw new Error("No database URL: set SESSIONS_DB_URL or pass --db <postgres-url>");
	}

	const tableOverride = process.env.SESSIONS_DB_TABLE?.trim() || undefined;
	const pathAlias = parseSessionPathPrefixAlias(process.env.OMP_SESSION_PATH_PREFIX_ALIAS);
	const targetTable = tableOverride ?? "omp_session_files";

	const buckets = await collectSessionFiles(sessionsRoot, options.limit);
	const allFiles = buckets.flatMap(bucket => bucket.files);
	console.log(`[import] sessions root: ${sessionsRoot}`);

	if (options.dryRun) {
		let totalBytes = 0;
		for (const bucket of buckets) {
			const stats = await Promise.all(
				bucket.files.map(file =>
					fs.stat(file).then(
						s => s.size,
						() => 0,
					),
				),
			);
			const bytes = stats.reduce((sum, size) => sum + size, 0);
			totalBytes += bytes;
			console.log(
				`[dry-run] ${path.basename(bucket.dir)}: ${count(bucket.files.length)} files (${formatBytes(bytes)})`,
			);
		}
		console.log(
			`[dry-run] would upsert ${count(allFiles.length)} rows (${formatBytes(totalBytes)}) into the ` +
				`SqlSessionStorage table ${targetTable}${tableOverride ? " (from SESSIONS_DB_TABLE)" : ""}`,
		);
		console.log(`[dry-run] statement shape: ${buildUpsert(targetTable, 1).slice(0, 120)}…`);
		if (allFiles.length > 0) {
			const exampleKey = pathAlias ? pathAlias.storageKey(allFiles[0]) : allFiles[0];
			console.log(`[dry-run] example key: ${exampleKey}`);
		}
		return;
	}

	const client = new SQL(url);
	const storage = await SqlSessionStorage.create({ client, table: tableOverride, pathAlias });
	if (storage.adapter !== "postgres") {
		await client.end();
		throw new Error(`This importer targets PostgreSQL; the URL resolved to adapter "${storage.adapter}".`);
	}
	const table = storage.table;
	console.log(`[import] target table: ${table} (${storage.adapter})`);

	const startedAt = Date.now();
	let imported = 0;
	let skipped = 0;
	let statements = 0;
	let pendingBytes = 0;
	const importedRows: Array<{ path: string; localPath: string }> = [];
	const pending: Array<{ path: string; localPath: string; content: string; mtimeMs: bigint }> = [];

	const flush = async (): Promise<void> => {
		if (pending.length === 0) return;
		const values: unknown[] = [];
		for (const row of pending) values.push(row.path, row.content, row.mtimeMs, null, null, null);
		await client.unsafe(buildUpsert(table, pending.length), values);
		importedRows.push(...pending.map(row => ({ path: row.path, localPath: row.localPath })));
		imported += pending.length;
		statements++;
		pendingBytes = 0;
		pending.length = 0;
	};

	for (const bucket of buckets) {
		let bucketBytes = 0;
		let bucketCount = 0;
		for (const file of bucket.files) {
			// A transient session (live /tmp mirrors churn constantly) may vanish
			// between the walk and the read; it was never history to import.
			let content: string;
			let mtimeMs: bigint;
			try {
				content = await Bun.file(file).text();
				mtimeMs = BigInt(Math.round((await fs.stat(file)).mtimeMs));
			} catch (err) {
				if (isVanishedFileError(err)) {
					skipped++;
					continue;
				}
				throw err;
			}
			const bytes = Buffer.byteLength(content, "utf-8");
			bucketBytes += bytes;
			bucketCount++;
			if (pending.length > 0 && (pending.length >= FLUSH_ROW_LIMIT || pendingBytes + bytes > FLUSH_BYTES_LIMIT)) {
				await flush();
			}
			const storageKey = pathAlias ? pathAlias.storageKey(file) : file;
			pending.push({ path: storageKey, localPath: file, content, mtimeMs });
			pendingBytes += bytes;
		}
		await flush();
		console.log(`[import] ${path.basename(bucket.dir)}: ${count(bucketCount)} files (${formatBytes(bucketBytes)})`);
	}

	// Re-warm the storage's index from the now-populated table so the read-back
	// below sees the rows a freshly started process would.
	await storage.refresh();

	// Parity: every imported path must exist as a row, and content read back
	// through the storage must match the file byte-for-byte.
	let present = 0;
	for (let i = 0; i < importedRows.length; i += 1000) {
		const chunk = importedRows.slice(i, i + 1000).map(r => r.path);
		const rows = (await client.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE path = ANY($1)`, [
			chunk,
		])) as Array<{ n: number }>;
		present += rows[0]?.n ?? 0;
	}
	const totalRows = (await client.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as Array<{ n: number }>;
	let verifiedSamples = 0;
	const sampleIdx = [...new Set([0, Math.floor(importedRows.length / 2), importedRows.length - 1])].filter(
		i => i >= 0 && i < importedRows.length,
	);
	for (const i of sampleIdx) {
		const { localPath } = importedRows[i];
		if ((await storage.readText(localPath)) !== (await Bun.file(localPath).text())) {
			throw new Error(`Read-back mismatch for imported row: ${localPath}`);
		}
		verifiedSamples++;
	}

	console.log(
		`[import] found ${count(allFiles.length)} session files: imported ${count(imported)}, ` +
			`skipped ${count(skipped)} (vanished mid-walk), in ${statements} statements ` +
			`(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
	);
	console.log(`[import] parity: ${count(present)}/${count(importedRows.length)} imported paths present in ${table}`);
	console.log(`[import] table rows: ${count(totalRows[0]?.n ?? 0)}`);
	console.log(`[import] read-back verified samples: ${verifiedSamples}/${sampleIdx.length}`);
	if (present !== importedRows.length) {
		throw new Error(
			`Parity failed: ${count(importedRows.length - present)} imported paths are missing from ${table}`,
		);
	}
	await client.end();
}

main().catch(err => {
	console.error(`[import] failed: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
