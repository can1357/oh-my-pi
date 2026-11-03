/**
 * The one-time row-key migration and its rollback (`migrateSessionRowKeys`,
 * `rollbackSessionRowKeys`, `omp session migrate-keys` / `rollback-keys`).
 * Each accepted case seeds keys the way an older Oh My Pi wrote them (the
 * absolute local path), migrates, reads every session's exact bytes through
 * the current store by its canonical local path, rolls back, and reads them
 * again by the row keyed with the canonical local path, as the store before
 * root-relative keys did. Each refused case leaves both tables byte for byte
 * as they were. These run against SQLite always, and against PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runSessionKeysChange, runSessionKeysCommand } from "@oh-my-pi/pi-coding-agent/cli/session-keys-cli";
import Session from "@oh-my-pi/pi-coding-agent/commands/session";
import {
	applySessionKeyMoves,
	migrateSessionRowKeys,
	rollbackSessionRowKeys,
	type SessionKeyRefusal,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-key-migration";
import {
	runSqlTransaction,
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { ESCAPABLE_PASSWORDS, expectNoSpelling, redactorFor } from "../helpers/connection-redaction";

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

const ROOT = "/review/root";
const RESTORE = "/restored/root/";
const TIMEOUT_MS = 120_000;
const TEST_CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() };

/** Code-unit order, whatever the database's collation. */
function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

type Row = Record<string, unknown>;
let tableSeq = 0;

/** One test's tables on one database; dropped, and the SQLite file removed, when done. */
class Db implements AsyncDisposable {
	readonly client: SQL;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
		readonly table: string,
		readonly dir: TempDir | undefined,
	) {
		this.client = new SQL(url);
	}

	static async connect(
		adapter: SqlSessionStorageAdapter,
		serverUrl: string,
		table = `omp_keys_${process.pid}_${tableSeq++}`,
	): Promise<Db> {
		const dir = adapter === "sqlite" ? TempDir.createSync("@omp-key-migration-") : undefined;
		const db = new Db(adapter, dir ? `sqlite:${dir.join("sessions.db")}` : serverUrl, table, dir);
		// This version's schema, empty: the store refuses to start once legacy keys are in.
		await (await db.open(ROOT)).drain();
		return db;
	}

	open(sessionsRoot: string): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client: this.client, table: this.table, sessionsRoot });
	}

	/** Fixture SQL written with `?` placeholders, on any dialect; the rows as plain objects. */
	async sql(query: string, values: unknown[] = [], client: SQL = this.client): Promise<Row[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		return ((await client.unsafe(text, values)) as Row[]).map(row => ({ ...row }));
	}

	/** A session row whose bytes are its `content`, as an Oh My Pi before parts wrote it. */
	async insertRow(key: string, content: string): Promise<void> {
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, 1, ?)`, [
			key,
			content,
			Buffer.byteLength(content),
		]);
	}

	/** A session row whose bytes are `parts`, as this version and the one before root-relative keys write them. */
	async insertSession(key: string, parts: readonly string[]): Promise<void> {
		const size = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, '', 1, ?)`, [key, size]);
		await this.insertParts(key, parts);
	}

	/** Parts of `key` at consecutive offsets, with no session row added. */
	async insertParts(key: string, parts: readonly string[]): Promise<void> {
		let offset = 0;
		for (const part of parts) {
			await this.sql(`INSERT INTO ${this.table}_parts (path, start_offset, content) VALUES (?, ?, ?)`, [
				key,
				offset,
				part,
			]);
			offset += Buffer.byteLength(part);
		}
	}

	/** The distinct keys of `table`, in code-unit order. */
	async keys(table = this.table): Promise<string[]> {
		return [...new Set((await this.sql(`SELECT path FROM ${table}`)).map(row => String(row.path)))].sort(byCodeUnit);
	}

	/** Both tables, every column, in code-unit order of key (then offset). */
	async snapshot(): Promise<{ files: Row[]; parts: Row[] }> {
		const files = await this.sql(
			`SELECT path, content, mtime_ms, byte_len, title, title_source, title_updated_at FROM ${this.table}`,
		);
		const parts = await this.sql(`SELECT path, start_offset, content FROM ${this.table}_parts`);
		files.sort((a, b) => byCodeUnit(String(a.path), String(b.path)));
		parts.sort(
			(a, b) => byCodeUnit(String(a.path), String(b.path)) || Number(a.start_offset) - Number(b.start_offset),
		);
		return { files, parts };
	}

	/**
	 * The session the row keyed `key` holds, read the way the store before
	 * root-relative keys read a local path: that path is the key, and the
	 * bytes are `content` followed by the parts in offset order.
	 */
	async readByKey(key: string): Promise<string | null> {
		const [row] = await this.sql(`SELECT content FROM ${this.table} WHERE path = ?`, [key]);
		if (!row) return null;
		const parts = await this.sql(`SELECT start_offset, content FROM ${this.table}_parts WHERE path = ?`, [key]);
		parts.sort((a, b) => Number(a.start_offset) - Number(b.start_offset));
		return String(row.content) + parts.map(part => String(part.content)).join("");
	}

	migrate(roots: readonly string[], client: SQL = this.client) {
		return migrateSessionRowKeys({ client, table: this.table, roots, dryRun: false });
	}

	rollback(restoreRoot: string, client: SQL = this.client) {
		return rollbackSessionRowKeys({ client, table: this.table, restoreRoot, dryRun: false });
	}

	/** A one-connection client of this database, with `sql_mode` set when given (MySQL). */
	async connection(sqlMode?: string): Promise<SQL> {
		const client = new SQL(this.url, { max: 1 });
		if (sqlMode !== undefined) await client.unsafe(`SET SESSION sql_mode = '${sqlMode}'`);
		return client;
	}

	/**
	 * Make every UPDATE of `table` fail with `message`, as a lock wait timeout
	 * or a full disk would, or as a database error that quotes any text does.
	 */
	async refuseUpdates(table: string, message = "refused"): Promise<void> {
		const trigger = `${table}_refuse`;
		const literal = `'${message.replaceAll("'", "''")}'`;
		if (this.adapter === "sqlite") {
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, ${literal}); END`,
			);
		} else if (this.adapter === "mysql") {
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}`,
			);
		} else {
			// `USING MESSAGE`: a `%` in the message is not a format placeholder there.
			await this.sql(
				`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
			);
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
			);
		}
	}

	/** After each UPDATE of a session row, add a parts row under a key no plan names. */
	async addStrayPartOnUpdate(): Promise<void> {
		const trigger = `${this.table}_stray`;
		const parts = `${this.table}_parts`;
		if (this.adapter === "sqlite") {
			await this.sql(
				`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${this.table} BEGIN ` +
					`INSERT OR IGNORE INTO ${parts} (path, start_offset, content) VALUES ('stray', 0, 'stray'); END`,
			);
		} else if (this.adapter === "mysql") {
			await this.sql(
				`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${this.table} FOR EACH ROW ` +
					`INSERT IGNORE INTO ${parts} (path, start_offset, content) VALUES ('stray', 0, 'stray')`,
			);
		} else {
			await this.sql(
				`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
					`INSERT INTO ${parts} (path, start_offset, content) VALUES ('stray', 0, 'stray') ON CONFLICT DO NOTHING; ` +
					"RETURN NULL; END $$",
			);
			await this.sql(
				`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${this.table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
			);
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		if (this.adapter === "postgres") {
			for (const name of [`${this.table}_refuse`, `${this.table}_parts_refuse`, `${this.table}_stray`]) {
				await this.client.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
			}
		}
		await this.client.end();
		this.dir?.removeSync();
	}
}

/** Bytes of a session named `name`: two parts, with multi-byte characters. */
function sessionParts(name: string): string[] {
	return [`${JSON.stringify({ type: "session", name })} é 😀\n`, "second record 界\n"];
}

/** The local path the store under `root` reads the row keyed `key` by. */
function localPath(key: string, root: string): string {
	return key.startsWith("sessions/")
		? path.posix.join(path.posix.resolve(root), key.slice("sessions/".length))
		: key.slice("abs:".length);
}

/** Each accepted case: legacy keys (or keys already current) and the key each must take. */
const ACCEPTED: ReadonlyArray<{
	name: string;
	roots?: readonly string[];
	restore?: string;
	keys: ReadonlyArray<readonly [before: string, migrated: string]>;
}> = [
	{
		name: "a root given with a trailing slash",
		roots: [`${ROOT}/`],
		keys: [[`${ROOT}/session.jsonl`, "sessions/session.jsonl"]],
	},
	{
		name: "a root given without a trailing slash",
		roots: [ROOT],
		keys: [[`${ROOT}/session.jsonl`, "sessions/session.jsonl"]],
	},
	...["//", "/./", "/x/../"].map(suffix => ({
		name: `the non-canonical root ${ROOT}${suffix}, for migration and restore`,
		roots: [`${ROOT}${suffix}`],
		restore: `${ROOT}${suffix}`,
		keys: [[`${ROOT}/session.jsonl`, "sessions/session.jsonl"] as const],
	})),
	{ name: "a key climbing above the root", keys: [[`${ROOT}/../../../../outside.jsonl`, "abs:/outside.jsonl"]] },
	{
		name: "a sibling directory that shares the root's prefix",
		keys: [[`${ROOT}suffix/session.jsonl`, `abs:${ROOT}suffix/session.jsonl`]],
	},
	{ name: "Unicode segments", keys: [[`${ROOT}/项目/é-😀.jsonl`, "sessions/项目/é-😀.jsonl"]] },
	{
		name: "dot segments and repeated slashes",
		keys: [[`${ROOT}/dir/.././sub//session.jsonl`, "sessions/sub/session.jsonl"]],
	},
	{ name: "a segment of one space", keys: [[`${ROOT}/ /session.jsonl`, "sessions/ /session.jsonl"]] },
	{ name: "a segment of a dot and a space", keys: [[`${ROOT}/. /session.jsonl`, "sessions/. /session.jsonl"]] },
	{
		name: "the filesystem root as the sessions root",
		roots: ["/"],
		restore: "/",
		keys: [["/rooted/session.jsonl", "sessions/rooted/session.jsonl"]],
	},
	{ name: "a key naming the root directory itself", keys: [[`${ROOT}/`, `abs:${ROOT}`]] },
	{
		name: "several roots, with LIKE wildcards and a quote in them",
		roots: ["/home/a_%/.omp/agent/sessions/", "/home/o'b/.omp/agent/sessions"],
		restore: "/home/c/.omp/agent/sessions",
		keys: [
			["/home/a_%/.omp/agent/sessions/-p/a.jsonl", "sessions/-p/a.jsonl"],
			["/home/o'b/.omp/agent/sessions/-q/b.jsonl", "sessions/-q/b.jsonl"],
			["/home/aZZ/.omp/agent/sessions/-p/lookalike.jsonl", "abs:/home/aZZ/.omp/agent/sessions/-p/lookalike.jsonl"],
		],
	},
	{
		name: "keys already current beside legacy keys",
		keys: [
			["sessions/-p/current.jsonl", "sessions/-p/current.jsonl"],
			["abs:/srv/current.jsonl", "abs:/srv/current.jsonl"],
			[`${ROOT}/-p/legacy.jsonl`, "sessions/-p/legacy.jsonl"],
		],
	},
];

/** Each refused migration: what to seed, the roots, and the refusals it must report. */
const REFUSED: ReadonlyArray<{
	name: string;
	roots?: readonly string[];
	seed(db: Db): Promise<void>;
	refusals: SessionKeyRefusal["kind"][];
	/** Keys the refusal of the first kind must list, exactly. */
	listed?: string[];
}> = [
	{
		name: "a legacy key would take the key of a row already migrated",
		async seed(db) {
			await db.insertSession(`${ROOT}/-p/a.jsonl`, ["old\n"]);
			await db.insertSession("sessions/-p/a.jsonl", ["new\n"]);
		},
		refusals: ["collision"],
		listed: [`${ROOT}/-p/a.jsonl`, "sessions/-p/a.jsonl"],
	},
	{
		name: "two spellings of one path collide only after canonicalization",
		async seed(db) {
			await db.insertSession(`${ROOT}/a.jsonl`, ["canonical\n"]);
			await db.insertSession(`${ROOT}/p/../a.jsonl`, ["dotted\n"]);
			await db.insertSession(`${ROOT}//a.jsonl`, ["doubled\n"]);
		},
		refusals: ["collision"],
		listed: [`${ROOT}//a.jsonl`, `${ROOT}/a.jsonl`, `${ROOT}/p/../a.jsonl`],
	},
	{
		name: "keys under two roots would take one key",
		roots: ["/home/a/.omp/agent/sessions/", "/home/b/.omp/agent/sessions/"],
		async seed(db) {
			await db.insertSession("/home/a/.omp/agent/sessions/-p/b.jsonl", ["from a\n"]);
			await db.insertSession("/home/b/.omp/agent/sessions/-p/x/../b.jsonl", ["from b\n"]);
		},
		refusals: ["collision"],
	},
	{
		name: "parts without a session row would join another session",
		async seed(db) {
			await db.insertParts(`${ROOT}/-p/c.jsonl`, ["orphan\n"]);
			await db.insertSession("sessions/-p/c.jsonl", ["new\n"]);
		},
		refusals: ["collision"],
	},
	{
		name: "one root lies under another",
		roots: [ROOT, `${ROOT}/-p`],
		async seed(db) {
			await db.insertSession(`${ROOT}/-p/d.jsonl`, ["nested\n"]);
		},
		refusals: ["root"],
		listed: [ROOT, `${ROOT}/-p`],
	},
	{
		name: "two roots name one directory",
		roots: [ROOT, `${ROOT}/`, `${ROOT}/x/..`],
		async seed() {},
		refusals: ["root"],
		listed: [ROOT, `${ROOT}/`, `${ROOT}/x/..`],
	},
	{ name: "a root is empty", roots: [""], async seed() {}, refusals: ["root"], listed: [""] },
	{ name: "a root is relative", roots: ["relative/"], async seed() {}, refusals: ["root"], listed: ["relative/"] },
	{ name: "no root is given", roots: [], async seed() {}, refusals: ["root"] },
	{
		name: "legacy keys are relative paths",
		async seed(db) {
			await db.insertSession("relative.jsonl", ["relative\n"]);
			await db.insertSession("relative/c.jsonl", ["relative\n"]);
			await db.insertParts("./parts.jsonl", ["relative\n"]);
		},
		refusals: ["relative-key"],
		listed: ["./parts.jsonl", "relative.jsonl", "relative/c.jsonl"],
	},
	{
		name: "current keys would not be read back",
		async seed(db) {
			for (const key of [
				"sessions/a/.",
				"sessions/a/..",
				"sessions/-p//x.jsonl",
				"sessions/",
				"abs:relative.jsonl",
				"abs:/outside//s.jsonl",
				"abs:/outside/a/../s.jsonl",
				`abs:${ROOT}/under-root.jsonl`,
			]) {
				await db.insertSession(key, ["unreadable\n"]);
			}
		},
		refusals: ["unreadable-key"],
		listed: [
			"abs:/outside//s.jsonl",
			"abs:/outside/a/../s.jsonl",
			`abs:${ROOT}/under-root.jsonl`,
			"abs:relative.jsonl",
			"sessions/",
			"sessions/-p//x.jsonl",
			"sessions/a/.",
			"sessions/a/..",
		],
	},
	{
		name: "a key starts with the temporary-key prefix",
		async seed(db) {
			await db.insertSession("omp-key-migration:0", ["reserved\n"]);
		},
		refusals: ["reserved-key"],
		listed: ["omp-key-migration:0"],
	},
];

const REFUSED_ROLLBACKS: ReadonlyArray<{
	name: string;
	restore?: string;
	seed(db: Db): Promise<void>;
	refusals: SessionKeyRefusal["kind"][];
	listed?: string[];
}> = [
	{
		name: "keys with an empty, . or .. segment, the last one included, and non-canonical abs: keys",
		async seed(db) {
			for (const key of [
				"sessions/a/.",
				"sessions/a/..",
				"sessions/./a",
				"sessions/a//b",
				"sessions/",
				"abs:/outside/a/../s.jsonl",
				"abs:/outside//s.jsonl",
				"abs:/outside/",
				"abs:relative.jsonl",
			]) {
				await db.insertSession(key, [`${key}\n`]);
			}
		},
		refusals: ["unreadable-key"],
		listed: [
			"abs:/outside/",
			"abs:/outside//s.jsonl",
			"abs:/outside/a/../s.jsonl",
			"abs:relative.jsonl",
			"sessions/",
			"sessions/./a",
			"sessions/a/.",
			"sessions/a/..",
			"sessions/a//b",
		],
	},
	{
		name: "a key and its terminal-dot spelling",
		async seed(db) {
			await db.insertSession("sessions/a", ["canonical\n"]);
			await db.insertSession("sessions/a/.", ["dotted\n"]);
		},
		refusals: ["unreadable-key"],
		listed: ["sessions/a/."],
	},
	{
		name: "a root-relative key would take an abs: key's path",
		async seed(db) {
			await db.insertSession("sessions/-p/collision.jsonl", ["root\n"]);
			await db.insertSession("abs:/restored/root/-p/collision.jsonl", ["abs\n"]);
		},
		refusals: ["collision"],
		listed: ["abs:/restored/root/-p/collision.jsonl", "sessions/-p/collision.jsonl"],
	},
	{
		name: "a legacy key is still there",
		async seed(db) {
			await db.insertSession(`${ROOT}/a.jsonl`, ["legacy\n"]);
			await db.insertSession("sessions/b.jsonl", ["current\n"]);
		},
		refusals: ["legacy-key"],
		listed: [`${ROOT}/a.jsonl`],
	},
	{
		name: "the restore root is relative",
		restore: "relative/",
		async seed(db) {
			await db.insertSession("sessions/b.jsonl", ["current\n"]);
		},
		refusals: ["root"],
		listed: ["relative/"],
	},
	{
		name: "the restore root is empty",
		restore: "",
		async seed(db) {
			await db.insertSession("sessions/b.jsonl", ["current\n"]);
		},
		refusals: ["root"],
		listed: [""],
	},
];

const originalEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_SESSION_SQL_DSN_FILE: process.env.OMP_SESSION_SQL_DSN_FILE,
	OMP_SESSION_STORAGE: process.env.OMP_SESSION_STORAGE,
};
const originalAgentDir = getAgentDir();
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
	previousExitCode = process.exitCode;
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode ?? 0;
	setAgentDir(originalAgentDir);
	for (const [name, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`session row key migration (${adapter})`, () => {
		const connect = (table?: string): Promise<Db> => Db.connect(adapter, url ?? "", table);

		for (const accepted of ACCEPTED) {
			it(
				`migrates and rolls back ${accepted.name}`,
				async () => {
					await using db = await connect();
					const roots = accepted.roots ?? [`${ROOT}/`];
					const restore = accepted.restore ?? RESTORE;
					const bytes = new Map<string, string>();
					for (const [index, [before]] of accepted.keys.entries()) {
						const parts = sessionParts(`${accepted.name} ${index}`);
						await db.insertSession(before, parts);
						bytes.set(before, parts.join(""));
					}

					const migration = await db.migrate(roots);

					expect(migration.plan.refusals).toEqual([]);
					expect(migration.applied).toBe(accepted.keys.some(([before, migrated]) => before !== migrated));
					const migrated = accepted.keys.map(([, key]) => key).sort(byCodeUnit);
					expect(await db.keys()).toEqual(migrated);
					expect(await db.keys(`${db.table}_parts`)).toEqual(migrated);
					const current = await db.open(roots[0] ?? ROOT);
					for (const [before, key] of accepted.keys) {
						expect({ key, text: await current.readText(localPath(key, roots[0] ?? ROOT)) }).toEqual({
							key,
							// Every key was seeded above; an empty expectation can only fail.
							text: bytes.get(before) ?? "",
						});
					}

					const rollback = await db.rollback(restore);

					expect(rollback.plan.refusals).toEqual([]);
					const restored = accepted.keys.map(([, key]) => localPath(key, restore));
					expect(await db.keys()).toEqual([...restored].sort(byCodeUnit));
					for (const [index, [before]] of accepted.keys.entries()) {
						const file = restored[index] ?? "";
						expect({ file, text: await db.readByKey(file) }).toEqual({ file, text: bytes.get(before) ?? null });
					}
				},
				TIMEOUT_MS,
			);
		}

		it(
			"moves hundreds of keys of both layouts, parts-only keys included, in one transaction",
			async () => {
				await using db = await connect();
				const expected = new Map<string, string>();
				for (let index = 0; index < 450; index++) {
					const inside = index % 3 !== 0;
					const legacy = inside ? `${ROOT}/-p${index % 7}/s${index}.jsonl` : `/srv/outside/s${index}.jsonl`;
					const key = inside ? `sessions/-p${index % 7}/s${index}.jsonl` : `abs:/srv/outside/s${index}.jsonl`;
					const text = `session ${index} ✓\n`;
					if (index % 2 === 0) await db.insertRow(legacy, text);
					else await db.insertSession(legacy, [text, "tail\n"]);
					expected.set(key, index % 2 === 0 ? text : `${text}tail\n`);
				}
				await db.insertParts(`${ROOT}/-gone/orphan.jsonl`, ["orphan\n"]);

				const result = await db.migrate([`${ROOT}/`]);

				expect(result.plan.refusals).toEqual([]);
				expect(result.plan.counts).toEqual({ unchanged: 0, rootRelative: 301, absolute: 150, respelled: 0 });
				expect(result.plan.keys).toEqual({ files: 450, parts: 226, distinct: 451 });
				expect(await db.keys()).toEqual([...expected.keys()].sort(byCodeUnit));
				expect(await db.keys(`${db.table}_parts`)).toContain("sessions/-gone/orphan.jsonl");
				const current = await db.open(ROOT);
				for (const [key, text] of expected) expect(await current.readText(localPath(key, ROOT))).toBe(text);

				expect((await db.rollback(RESTORE)).plan.refusals).toEqual([]);
				for (const [key, text] of expected) expect(await db.readByKey(localPath(key, RESTORE))).toBe(text);
				expect(await db.keys(`${db.table}_parts`)).toContain("/restored/root/-gone/orphan.jsonl");
			},
			TIMEOUT_MS,
		);

		it(
			"follows a chain, a swap and a three-key cycle without a primary-key conflict",
			async () => {
				await using db = await connect();
				const keys = ["a", "b", "c", "x", "y", "p", "q", "r"].map(name => `sessions/${name}`);
				for (const key of keys) await db.insertSession(key, [`${key} head\n`, `${key} tail\n`]);
				const moves = new Map([
					// A chain: c leaves, b takes c's key, a takes b's.
					["sessions/c", "sessions/d"],
					["sessions/b", "sessions/c"],
					["sessions/a", "sessions/b"],
					// A swap.
					["sessions/x", "sessions/y"],
					["sessions/y", "sessions/x"],
					// A cycle.
					["sessions/p", "sessions/q"],
					["sessions/q", "sessions/r"],
					["sessions/r", "sessions/p"],
				]);

				await runSqlTransaction(db.client, adapter, transaction =>
					applySessionKeyMoves(transaction, { adapter, table: db.table, moves }),
				);

				expect(await db.keys()).toEqual(["b", "c", "d", "p", "q", "r", "x", "y"].map(name => `sessions/${name}`));
				for (const [from, to] of moves) expect(await db.readByKey(to)).toBe(`${from} head\n${from} tail\n`);
			},
			TIMEOUT_MS,
		);

		for (const refused of REFUSED) {
			it(
				`changes neither table when ${refused.name}`,
				async () => {
					await using db = await connect();
					await refused.seed(db);
					// A key the migration would move were it not refused: no partial migration.
					await db.insertSession(`${ROOT}/-p/movable.jsonl`, ["movable\n"]);
					const before = await db.snapshot();

					const result = await db.migrate(refused.roots ?? [`${ROOT}/`]);

					expect(result.applied).toBe(false);
					expect(result.plan.refusals.map(refusal => refusal.kind)).toEqual(refused.refusals);
					if (refused.listed) expect(result.plan.refusals[0]?.keys.sort(byCodeUnit)).toEqual(refused.listed);
					expect(await db.snapshot()).toEqual(before);
				},
				TIMEOUT_MS,
			);
		}

		for (const refused of REFUSED_ROLLBACKS) {
			it(
				`rolls back nothing when ${refused.name}`,
				async () => {
					await using db = await connect();
					await refused.seed(db);
					await db.insertSession("sessions/-p/movable.jsonl", ["movable\n"]);
					const before = await db.snapshot();

					const result = await db.rollback(refused.restore ?? RESTORE);

					expect(result.applied).toBe(false);
					expect(result.plan.refusals.map(refusal => refusal.kind)).toEqual(refused.refusals);
					if (refused.listed) expect(result.plan.refusals[0]?.keys.sort(byCodeUnit)).toEqual(refused.listed);
					expect(await db.snapshot()).toEqual(before);
				},
				TIMEOUT_MS,
			);
		}

		it(
			"plans without changing anything on a dry run",
			async () => {
				await using db = await connect();
				await db.insertSession(`${ROOT}/-p/a.jsonl`, ["a\n"]);
				await db.insertSession(`${ROOT}/-p/./b.jsonl`, ["b\n"]);
				await db.insertSession("/srv/c.jsonl", ["c\n"]);
				const before = await db.snapshot();

				const result = await migrateSessionRowKeys({
					client: db.client,
					table: db.table,
					roots: [ROOT],
					dryRun: true,
				});

				expect(result.applied).toBe(false);
				expect(result.plan.counts).toEqual({ unchanged: 0, rootRelative: 2, absolute: 1, respelled: 1 });
				expect([...result.plan.moves]).toEqual([
					["/review/root/-p/./b.jsonl", "sessions/-p/b.jsonl"],
					["/review/root/-p/a.jsonl", "sessions/-p/a.jsonl"],
					["/srv/c.jsonl", "abs:/srv/c.jsonl"],
				]);
				expect(await db.snapshot()).toEqual(before);
			},
			TIMEOUT_MS,
		);

		it(
			"migrates a session table whose parts table does not exist yet, and refuses a missing session table",
			async () => {
				await using db = await connect();
				await db.insertRow(`${ROOT}/-p/a.jsonl`, "a\n");
				// An Oh My Pi from before parts never created the parts table.
				await db.sql(`DROP TABLE ${db.table}_parts`);

				const result = await db.migrate([ROOT]);

				expect(result.plan.refusals).toEqual([]);
				expect(result.plan.keys).toEqual({ files: 1, parts: 0, distinct: 1 });
				expect(await db.keys()).toEqual(["sessions/-p/a.jsonl"]);
				expect(await (await db.open(ROOT)).readText(`${ROOT}/-p/a.jsonl`)).toBe("a\n");
				const missing = `${db.table}_none`;
				await expect(
					migrateSessionRowKeys({ client: db.client, table: missing, roots: [ROOT], dryRun: true }),
				).rejects.toThrow(`the database has no session table ${missing} with a path column`);
			},
			TIMEOUT_MS,
		);

		for (const table of ["session", "parts"] as const) {
			it(
				`rolls back the whole transaction when an UPDATE of the ${table} table fails`,
				async () => {
					await using db = await connect();
					await db.insertSession(`${ROOT}/-p/a.jsonl`, ["a\n"]);
					await db.insertSession("/srv/b.jsonl", ["b\n"]);
					await db.refuseUpdates(table === "session" ? db.table : `${db.table}_parts`);
					const before = await db.snapshot();

					await expect(db.migrate([ROOT])).rejects.toThrow("refused");

					expect(await db.snapshot()).toEqual(before);
				},
				TIMEOUT_MS,
			);
		}

		it(
			"rolls back when the tables do not hold exactly the planned keys afterwards",
			async () => {
				await using db = await connect();
				await db.insertSession(`${ROOT}/-p/a.jsonl`, ["a\n"]);
				await db.addStrayPartOnUpdate();
				const before = await db.snapshot();

				await expect(db.migrate([ROOT])).rejects.toThrow("does not hold the planned keys");

				expect(await db.snapshot()).toEqual(before);
			},
			TIMEOUT_MS,
		);

		it(
			"keeps two keys apart that differ only in trailing spaces, refusing them on MySQL",
			async () => {
				await using db = await connect();
				await db.insertSession(`${ROOT}/a /`, ["spaced\n"]);
				await db.insertSession(`${ROOT}/a`, ["plain\n"]);
				const before = await db.snapshot();

				const result = await db.migrate([ROOT]);

				if (adapter === "mysql") {
					expect(result.plan.refusals.map(refusal => refusal.kind)).toEqual(["trailing-space"]);
					expect(result.plan.refusals[0]?.keys.sort(byCodeUnit)).toEqual([`${ROOT}/a`, `${ROOT}/a /`]);
					expect(await db.snapshot()).toEqual(before);
					return;
				}
				expect(result.plan.refusals).toEqual([]);
				const current = await db.open(ROOT);
				expect(await current.readText(`${ROOT}/a `)).toBe("spaced\n");
				expect(await current.readText(`${ROOT}/a`)).toBe("plain\n");
			},
			TIMEOUT_MS,
		);

		// MySQL's `path` is VARCHAR(512): `abs:` and a 512-character path do not fit.
		for (const sqlMode of adapter === "mysql" ? ["", undefined] : [undefined]) {
			const mode = sqlMode === undefined ? "the default SQL mode" : `sql_mode='${sqlMode}'`;
			for (const partsOnly of [false, true]) {
				it(
					`handles a 512-character legacy key${partsOnly ? " held only by parts" : ""} under ${mode}`,
					async () => {
						await using db = await connect();
						const long = `/outside/${"a".repeat(512 - "/outside/".length)}`;
						const fits = `/outside/${"f".repeat(508 - "/outside/".length)}`;
						if (partsOnly) await db.insertParts(long, ["long bytes\n"]);
						else await db.insertSession(long, ["long bytes\n"]);
						await db.insertSession(fits, ["fits\n"]);
						await db.insertSession(`${ROOT}/normal.jsonl`, ["normal bytes\n"]);
						const before = await db.snapshot();
						const session = await db.connection(sqlMode);
						try {
							const result = await db.migrate([ROOT], session);
							if (adapter === "mysql") {
								expect(result.plan.refusals.map(refusal => [refusal.kind, refusal.keys])).toEqual([
									["too-long", [long]],
								]);
								expect(await db.snapshot()).toEqual(before);
								// Without the overlong key, one that ends at exactly the column's length moves.
								await db.sql(`DELETE FROM ${db.table} WHERE path = ?`, [long]);
								await db.sql(`DELETE FROM ${db.table}_parts WHERE path = ?`, [long]);
								expect((await db.migrate([ROOT], session)).plan.refusals).toEqual([]);
								expect(await db.keys()).toContain(`abs:${fits}`);
							} else {
								expect(result.plan.refusals).toEqual([]);
								expect(await db.keys(`${db.table}_parts`)).toContain(`abs:${long}`);
								if (!partsOnly) expect(await (await db.open(ROOT)).readText(long)).toBe("long bytes\n");
							}
							const current = await db.open(ROOT);
							expect(await current.readText(fits)).toBe("fits\n");
							expect(await current.readText(`${ROOT}/normal.jsonl`)).toBe("normal bytes\n");
						} finally {
							await session.end();
						}
					},
					TIMEOUT_MS,
				);
			}

			it(
				`refuses a rollback to a path longer than the column under ${mode}`,
				async () => {
					await using db = await connect();
					const key = `sessions/${"b".repeat(512 - "sessions/".length)}`;
					await db.insertSession(key, ["boundary bytes\n"]);
					const before = await db.snapshot();
					const session = await db.connection(sqlMode);
					try {
						const result = await db.rollback(RESTORE, session);
						if (adapter === "mysql") {
							expect(result.plan.refusals.map(refusal => [refusal.kind, refusal.keys])).toEqual([
								["too-long", [key]],
							]);
							expect(await db.snapshot()).toEqual(before);
						} else {
							expect(result.plan.refusals).toEqual([]);
							expect(await db.readByKey(localPath(key, RESTORE))).toBe("boundary bytes\n");
						}
					} finally {
						await session.end();
					}
				},
				TIMEOUT_MS,
			);
		}

		if (adapter === "mysql") {
			for (const sqlMode of ["", undefined]) {
				it(
					`rolls back a move MySQL ${sqlMode === undefined ? "refuses as too long" : "truncates under sql_mode=''"}`,
					async () => {
						await using db = await connect();
						const long = `/outside/${"a".repeat(512 - "/outside/".length)}`;
						await db.insertSession(long, ["long bytes\n"]);
						await db.insertSession("sessions/kept.jsonl", ["kept\n"]);
						const before = await db.snapshot();
						const session = await db.connection(sqlMode);
						try {
							// Past the plan's length check: the database's own behaviour on an overlong key.
							await expect(
								runSqlTransaction(session, "mysql", transaction =>
									applySessionKeyMoves(transaction, {
										adapter,
										table: db.table,
										moves: new Map([[long, `abs:${long}`]]),
									}),
								),
							).rejects.toThrow(sqlMode === undefined ? /too long|truncat/i : "does not hold the planned keys");
						} finally {
							await session.end();
						}
						expect(await db.snapshot()).toEqual(before);
					},
					TIMEOUT_MS,
				);
			}
		}
	});

	describe.skipIf(!url)(`omp session migrate-keys and rollback-keys (${adapter})`, () => {
		/**
		 * The command migrates the configured storage's default table. A SQLite
		 * test has a database of its own, so it runs the command as a user does;
		 * on a shared server database it runs the command's runner on a table of
		 * its own.
		 */
		const connectCommandDb = (): Promise<Db> =>
			Db.connect(adapter, url ?? "", adapter === "sqlite" ? "omp_session_files" : undefined);

		/** Point the command at `db` the way a user does, with settings isolated from this machine's. */
		async function configure(db: Db): Promise<TempDir> {
			const dir = TempDir.createSync("@omp-key-migration-cli-");
			setAgentDir(dir.join("agent"));
			process.env.PI_CODING_AGENT_DIR = dir.join("agent");
			delete process.env.OMP_SESSION_STORAGE;
			const dsnFile = dir.join("dsn");
			await Bun.write(dsnFile, `${db.url}\n`);
			process.env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
			return dir;
		}

		/** Run `omp session <action>` against `db`; its exit code and what it printed. */
		async function run(
			db: Db,
			action: "migrate-keys" | "rollback-keys",
			roots: readonly string[],
			dryRun = false,
		): Promise<{ exitCode: number; stdout: string; stderr: string }> {
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const text = (spy: typeof stdout) => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
			try {
				let exitCode: number;
				if (adapter === "sqlite") {
					process.exitCode = 0;
					const argv = [action, ...roots.flatMap(root => ["--root", root]), ...(dryRun ? ["--dry-run"] : [])];
					await new Session(argv, TEST_CONFIG).run();
					exitCode = Number(process.exitCode ?? 0);
				} else {
					exitCode = await runSessionKeysCommand({
						direction: action === "migrate-keys" ? "migrate" : "rollback",
						roots,
						dryRun,
						cwd: process.cwd(),
						env: process.env,
						table: db.table,
					});
				}
				return { exitCode, stdout: text(stdout), stderr: text(stderr) };
			} finally {
				stdout.mockRestore();
				stderr.mockRestore();
			}
		}

		it(
			"previews, migrates and rolls back the configured database",
			async () => {
				await using db = await connectCommandDb();
				const dir = await configure(db);
				try {
					await db.insertSession(`${ROOT}/-p/a.jsonl`, ["a head\n", "a tail\n"]);
					await db.insertRow(`${ROOT}//-p/./b.jsonl`, "b\n");
					await db.insertSession("/srv/c.jsonl", ["c\n"]);
					const before = await db.snapshot();

					const preview = await run(db, "migrate-keys", [`${ROOT}/`], true);
					expect(preview.exitCode).toBe(0);
					expect(preview.stdout).toContain(`Keys: 3 in ${db.table}, 2 in ${db.table}_parts, 3 distinct`);
					expect(preview.stdout).toContain("2 legacy keys under a sessions root to sessions/…");
					expect(preview.stdout).toContain("1 of the legacy keys resolved from a non-canonical spelling");
					expect(preview.stdout).toContain("1 legacy keys outside every sessions root to abs:…");
					expect(preview.stdout).toContain("Dry run: 3 keys would move; nothing changed.");
					expect(await db.snapshot()).toEqual(before);

					const migration = await run(db, "migrate-keys", [`${ROOT}/`]);
					expect(migration.exitCode).toBe(0);
					expect(migration.stdout).toContain("Moved 3 keys in one transaction");
					expect(migration.stdout + migration.stderr).not.toContain(db.url);
					expect(await db.keys()).toEqual(["abs:/srv/c.jsonl", "sessions/-p/a.jsonl", "sessions/-p/b.jsonl"]);
					const current = await db.open(ROOT);
					expect(await current.readText(`${ROOT}/-p/a.jsonl`)).toBe("a head\na tail\n");
					expect(await current.readText(`${ROOT}/-p/b.jsonl`)).toBe("b\n");
					expect(await current.readText("/srv/c.jsonl")).toBe("c\n");

					const rollback = await run(db, "rollback-keys", [RESTORE]);
					expect(rollback.exitCode).toBe(0);
					expect(rollback.stdout).toContain("2 sessions/… keys to paths under /restored/root/");
					expect(await db.keys()).toEqual([
						"/restored/root/-p/a.jsonl",
						"/restored/root/-p/b.jsonl",
						"/srv/c.jsonl",
					]);
					expect(await db.readByKey("/restored/root/-p/a.jsonl")).toBe("a head\na tail\n");
				} finally {
					dir.removeSync();
				}
			},
			TIMEOUT_MS,
		);

		it(
			"exits 1 and lists every offending key when it refuses, changing nothing",
			async () => {
				await using db = await connectCommandDb();
				const dir = await configure(db);
				try {
					await db.insertSession("relative.jsonl", ["r\n"]);
					await db.insertSession(`${ROOT}/x/../a.jsonl`, ["dotted\n"]);
					await db.insertSession(`${ROOT}/a.jsonl`, ["canonical\n"]);
					const before = await db.snapshot();

					const result = await run(db, "migrate-keys", [ROOT]);

					expect(result.exitCode).toBe(1);
					expect(result.stdout).toContain("Refused; nothing changed:");
					for (const key of ["relative.jsonl", `${ROOT}/x/../a.jsonl`, `${ROOT}/a.jsonl`]) {
						expect(result.stdout).toContain(`    ${JSON.stringify(key)}\n`);
					}
					expect(result.stderr).toContain("the key change was refused; nothing changed");
					expect(await db.snapshot()).toEqual(before);
				} finally {
					dir.removeSync();
				}
			},
			TIMEOUT_MS,
		);

		it(
			"prints a failed change's database error without the connection string or its password, changing nothing",
			async () => {
				await using db = await connectCommandDb();
				const dir = await configure(db);
				try {
					const password = new URL(db.url).password;
					// The database's own error quotes the connection string and the password.
					const leak = `connect to ${db.url}${password ? ` as ${password}` : ""}`;
					await db.insertSession(`${ROOT}/a.jsonl`, ["a\n"]);
					await db.refuseUpdates(db.table, leak);
					const before = await db.snapshot();

					const result = await run(db, "migrate-keys", [ROOT]);

					expect(result.exitCode).toBe(1);
					const printed = result.stdout + result.stderr;
					expect(printed).toContain("the key change failed and was rolled back: connect to <redacted>");
					expect(printed).not.toContain(db.url);
					if (password) expect(printed).not.toContain(password);
					expect(await db.snapshot()).toEqual(before);
				} finally {
					dir.removeSync();
				}
			},
			TIMEOUT_MS,
		);

		it(
			"prints row keys that quote the connection string or its password redacted, changing nothing",
			async () => {
				await using db = await connectCommandDb();
				const dir = await configure(db);
				try {
					const password = new URL(db.url).password;
					const keys = [`sessions/../${db.url}`, ...(password ? [`relative/${password}.jsonl`] : [])];
					for (const key of keys) await db.insertSession(key, ["safe\n"]);
					const before = await db.snapshot();

					for (const [action, dryRun] of [
						["migrate-keys", false],
						["rollback-keys", true],
					] as const) {
						const result = await run(db, action, [ROOT], dryRun);

						expect({ action, exitCode: result.exitCode }).toEqual({ action, exitCode: 1 });
						expect(result.stdout).toContain('    "sessions/../<redacted>"\n');
						if (action === "migrate-keys" && password) {
							expect(result.stdout).toContain('    "relative/<redacted>.jsonl"\n');
						}
						const printed = result.stdout + result.stderr;
						expect({ action, leaksUrl: printed.includes(db.url) }).toEqual({ action, leaksUrl: false });
						if (password)
							expect({ action, leaksPassword: printed.includes(password) }).toEqual({
								action,
								leaksPassword: false,
							});
					}
					expect(await db.snapshot()).toEqual(before);
				} finally {
					dir.removeSync();
				}
			},
			TIMEOUT_MS,
		);

		for (const password of ESCAPABLE_PASSWORDS) {
			it(
				`redacts the password ${JSON.stringify(password)} in roots and row keys before quoting them`,
				async () => {
					await using db = await connectCommandDb();
					// The redactor of a connection string with this password, over this test's database.
					const secret = await redactorFor(password);
					const client = new SQL(db.url, { max: 1 });
					const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
					const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
					try {
						for (const key of [`sessions/../${password}`, `relative/${password}.jsonl`]) {
							await db.insertSession(key, ["safe\n"]);
						}
						const before = await db.snapshot();
						const connection = { ...secret, client };
						const base = { dryRun: false, cwd: process.cwd(), env: process.env, table: db.table };

						const migrate = await runSessionKeysChange(connection, {
							...base,
							direction: "migrate",
							roots: [ROOT, `/srv/${password}`],
						});
						const rollback = await runSessionKeysChange(connection, {
							...base,
							direction: "rollback",
							roots: [`/srv/${password}`],
							dryRun: true,
						});

						expect([migrate, rollback]).toEqual([1, 1]);
						const printed = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk)).join("");
						expect(printed).toContain(`sessions roots: ${ROOT}, /srv/<redacted>\n`);
						expect(printed).toContain("restore root: /srv/<redacted>\n");
						expect(printed).toContain('    "sessions/../<redacted>"\n');
						expect(printed).toContain('    "relative/<redacted>.jsonl"\n');
						expectNoSpelling("command output", printed, password);
						expect(await db.snapshot()).toEqual(before);
					} finally {
						stdout.mockRestore();
						stderr.mockRestore();
						await client.end();
						await secret.client.end();
					}
				},
				TIMEOUT_MS,
			);
		}
	});
}

describe("omp session migrate-keys and rollback-keys arguments", () => {
	for (const [argv, message] of [
		[["migrate-keys"], "Missing --root <dir>"],
		[
			["rollback-keys", "--root", "/a", "--root", "/b"],
			"rollback-keys restores every sessions/ key beneath one --root",
		],
		[["migrate-keys", "--root", "/a", "extra"], 'Unexpected argument "extra"'],
		[["migrate-keys", "--root", "/a", "--json"], "--cwd, --to and --json do not apply to migrate-keys"],
		[["pack", "--root", "/a"], "--root and --dry-run only apply to migrate-keys and rollback-keys"],
		[["lease", "--dry-run", "--", "id"], "--root and --dry-run only apply to migrate-keys and rollback-keys"],
	] as const) {
		it(`refuses ${argv.join(" ")}`, async () => {
			await expect(new Session([...argv], TEST_CONFIG).run()).rejects.toThrow(message);
		});
	}

	it("names the connection-string file but never the connection string when the database is unreachable", async () => {
		const dir = TempDir.createSync("@omp-key-migration-cli-");
		try {
			setAgentDir(dir.join("agent"));
			process.env.PI_CODING_AGENT_DIR = dir.join("agent");
			const dsnFile = dir.join("dsn");
			await Bun.write(dsnFile, "postgres://user:hunter2@127.0.0.1:1/sessions\n");
			process.env.OMP_SESSION_SQL_DSN_FILE = dsnFile;
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			await new Session(["migrate-keys", "--root", ROOT], TEST_CONFIG).run();

			const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
			expect(process.exitCode).toBe(1);
			expect(written).toContain(
				`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened`,
			);
			expect(written).not.toContain("hunter2");
		} finally {
			dir.removeSync();
		}
	});
});
