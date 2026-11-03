/**
 * `resolveSessionStorage` — the `session.storage` / `session.sql.dsnFile`
 * contract (`OMP_SESSION_STORAGE` / `OMP_SESSION_SQL_DSN_FILE` win over the
 * settings), and the process-wide default it is installed into: once a SQL
 * storage is the default, `SessionManager.create` / `open` / `list` called
 * without a storage argument read and write the same table.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { listAllSessions, listSessions, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	SessionWriteConflictError,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	openSessionSqlClient,
	resolveSessionStorage,
	SessionStorageConfigError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SQL } from "bun";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

async function writeDsnFile(contents: string): Promise<string> {
	const file = path.join(makeTempDir("@pi-session-storage-config-"), "dsn");
	await Bun.write(file, contents);
	return file;
}

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

async function rejection(promise: Promise<unknown>): Promise<SessionStorageConfigError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof SessionStorageConfigError) return err;
		throw err;
	}
	throw new Error("expected resolveSessionStorage to reject");
}

afterEach(async () => {
	setDefaultSessionStorage(new FileSessionStorage());
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("resolveSessionStorage", () => {
	it("defaults to file storage when nothing selects sql", async () => {
		const storage = await resolveSessionStorage({ settings: Settings.isolated(), env: {} });
		expect(storage).toBeInstanceOf(FileSessionStorage);
	});

	it("session.storage: sql opens the database the setting's file names and round-trips a session through the default seam", async () => {
		const dsnFile = await writeDsnFile("sqlite::memory:\n");
		const settings = Settings.isolated({ "session.storage": "sql", "session.sql.dsnFile": dsnFile });
		const storage = await resolveSessionStorage({ settings, env: {} });
		expect(storage).toBeInstanceOf(SqlSessionStorage);
		expect((storage as SqlSessionStorage).adapter).toBe("sqlite");

		// Installed as the default, the factories reach the same table without a storage argument.
		setDefaultSessionStorage(storage);
		const sessionDir = "/sessions/proj";
		const manager = SessionManager.create("/cwd", sessionDir);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "remembered" }],
			usage: fakeUsage(3, 2),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session path");
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const leaf = reopened.getLeafEntry();
		expect(leaf?.type).toBe("message");
		if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("expected the assistant leaf");
		expect(leaf.message.content[0]).toEqual({ type: "text", text: "remembered" });
		await reopened.close();

		const listed = await SessionManager.list("/cwd", sessionDir);
		expect(listed.map(session => session.path)).toEqual([sessionFile]);
		// The file tree never saw this session.
		expect(new FileSessionStorage().existsSync(sessionFile)).toBe(false);
	});

	it("--resume <id> finds a session the default SQL storage holds", async () => {
		const dsnFile = await writeDsnFile("sqlite::memory:\n");
		const settings = Settings.isolated({ "session.storage": "sql", "session.sql.dsnFile": dsnFile });
		const storage = await resolveSessionStorage({ settings, env: {} });
		setDefaultSessionStorage(storage);
		const sessionDir = "/sessions/proj";
		const manager = SessionManager.create("/cwd", sessionDir);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "resume me" }],
			usage: fakeUsage(3, 2),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = manager.getSessionFile();
		const sessionId = manager.getSessionId();
		await manager.flush();
		await storage.drain();
		await manager.close();

		// `omp --resume <id>` and `/resume <id>` resolve through resolveResumeTarget.
		const target = await resolveResumeTarget(sessionId.slice(0, 8), "/cwd", sessionDir);
		expect(target?.session.path).toBe(sessionFile);
		expect(target?.continuation).toBeUndefined();
	});

	it("OMP_SESSION_STORAGE and OMP_SESSION_SQL_DSN_FILE override the settings", async () => {
		const dsnFile = await writeDsnFile("sqlite::memory:");
		const settings = Settings.isolated({
			"session.storage": "file",
			"session.sql.dsnFile": path.join(makeTempDir("@pi-session-storage-unused-"), "never-read"),
		});
		const storage = await resolveSessionStorage({
			settings,
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
		});
		expect(storage).toBeInstanceOf(SqlSessionStorage);
	});

	it("refuses sql with no connection-string file named anywhere, naming both sources", async () => {
		const error = await rejection(
			resolveSessionStorage({ settings: Settings.isolated({ "session.storage": "sql" }), env: {} }),
		);
		expect(error.message).toContain("OMP_SESSION_SQL_DSN_FILE");
		expect(error.message).toContain("session.sql.dsnFile");
	});

	it("refuses a missing file, naming the variable that supplied the path and the path", async () => {
		const missing = path.join(makeTempDir("@pi-session-storage-missing-"), "does-not-exist");
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: missing },
			}),
		);
		expect(error.message).toContain(`OMP_SESSION_SQL_DSN_FILE names ${missing}, which could not be read: `);
	});

	it("refuses a blank file, naming the setting that supplied the path and the path", async () => {
		const blank = await writeDsnFile("  \n\n");
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated({ "session.storage": "sql", "session.sql.dsnFile": blank }),
				env: {},
			}),
		);
		expect(error.message).toBe(`session.sql.dsnFile names ${blank}, which is empty`);
	});

	it("refuses a storage kind other than file or sql, naming the value and its source", async () => {
		const fromEnv = await rejection(
			resolveSessionStorage({ settings: Settings.isolated(), env: { OMP_SESSION_STORAGE: "redis" } }),
		);
		expect(fromEnv.message).toBe('OMP_SESSION_STORAGE is "redis"; expected "file" or "sql"');
	});

	it("refuses contents the driver cannot parse as a URL without echoing them, even through Bun.inspect", async () => {
		// libpq keyword form: Bun.SQL rejects it in the constructor with a TypeError that embeds
		// the whole string. cli.ts's fatal handler prints Bun.inspect(error), so that is the
		// surface that must not carry the password.
		const dsnFile = await writeDsnFile("host=db user=app password=hunter2\n");
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			}),
		);
		expect(error.message).toBe(
			`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but its contents are not a connection URL the database driver accepts`,
		);
		expect(Bun.inspect(error)).not.toContain("hunter2");
	});

	it("refuses an unreachable database with the driver's error, naming the path but never the connection string", async () => {
		const dsnFile = await writeDsnFile("postgres://user:hunter2@127.0.0.1:1/sessions");
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			}),
		);
		expect(error.message).toStartWith(
			`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened: `,
		);
		// The driver names the failure (`ERR_POSTGRES_CONNECTION_REFUSED` on Bun 1.4,
		// `…_CLOSED` on 1.3); the contract is that its error reaches the user, not
		// which code the connect attempt happened to fail with.
		expect(error.message).toMatch(/ERR_POSTGRES_CONNECTION_\w+/);
		expect(error.message).not.toContain("hunter2");
		expect(Bun.inspect(error)).not.toContain("hunter2");
	});

	it("redacts every spelling of the connection string's secrets from a database error's text", async () => {
		const dsn = "postgres://app%2Duser:p%40ss%3Aw0rd@db.example:5432/sessions?sslpassword=k3y%2Bpass";
		const short = "mysql://bob:pw@db.example/sessions";
		const open = async (contents: string) =>
			openSessionSqlClient({
				settings: Settings.isolated(),
				env: { OMP_SESSION_SQL_DSN_FILE: await writeDsnFile(`${contents}\n`) },
			});
		const full = await open(dsn);
		const weak = await open(short);
		try {
			expect(full.redact(`could not reach ${dsn}.`)).toBe("could not reach <redacted>.");
			expect(full.redact("password p%40ss%3Aw0rd and p@ss:w0rd")).toBe("password <redacted> and <redacted>");
			expect(full.redact("login app-user:p@ss:w0rd@db.example")).toBe("login <redacted>@db.example");
			expect(full.redact("login app%2Duser:p%40ss%3Aw0rd@db")).toBe("login <redacted>@db");
			expect(full.redact("ssl key k3y%2Bpass, k3y+pass")).toBe("ssl key <redacted>, <redacted>");
			// The user and the host alone are not secrets.
			expect(full.redact("role app-user on db.example")).toBe("role app-user on db.example");
			// A two-character password would match ordinary text; only `user:password` goes.
			expect(weak.redact("bob:pw@db.example rejected pwd")).toBe("<redacted>@db.example rejected pwd");
			expect(weak.redact(short)).toBe("<redacted>");
		} finally {
			await full.client.end();
			await weak.client.end();
		}
	});
});

/**
 * Each database, with a session table whose start-up backfill fails with an
 * error that quotes the connection string and its password. A server test
 * isolates the default table `resolveSessionStorage` opens, since the shared
 * test database holds one this test does not own: PostgreSQL in a schema of
 * its own, selected by the connection string's `search_path` (a transaction
 * pooler routes only the databases it is configured with), MySQL in a
 * database of its own.
 */
const STARTUP_BACKENDS: ReadonlyArray<{ adapter: "sqlite" | "postgres" | "mysql"; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let namespaceSeq = 0;

/**
 * A connection string of a namespace of its own on `adapter`'s server `url`,
 * that namespace's name, and statements that create and drop it there.
 */
function isolatedDatabase(
	adapter: "sqlite" | "postgres" | "mysql",
	url: string,
): { dsn: string; name: string; create?: string; drop?: string } {
	const name = `omp_cfg_${process.pid}_${Date.now().toString(36)}_${namespaceSeq++}`;
	if (adapter === "sqlite") {
		return { dsn: `sqlite:${path.join(makeTempDir("@pi-session-storage-startup-"), "sessions.db")}`, name };
	}
	const parsed = new URL(url);
	if (adapter === "postgres") {
		parsed.searchParams.set("options", `-csearch_path=${name}`);
		return { dsn: parsed.href, name, create: `CREATE SCHEMA ${name}`, drop: `DROP SCHEMA IF EXISTS ${name} CASCADE` };
	}
	parsed.pathname = `/${name}`;
	return { dsn: parsed.href, name, create: `CREATE DATABASE ${name}`, drop: `DROP DATABASE IF EXISTS ${name}` };
}

for (const { adapter, url } of STARTUP_BACKENDS) {
	describe.skipIf(!url)(`resolveSessionStorage start-up refusal (${adapter})`, () => {
		it("prints a failed start-up statement's error without the connection string or its password", async () => {
			const { dsn, name, create, drop } = isolatedDatabase(adapter, url ?? "");
			const admin = create === undefined ? undefined : new SQL(url ?? "", { max: 1 });
			if (create) await admin?.unsafe(create);
			const client = new SQL(dsn, { max: 1 });
			try {
				// Never the shared database's own session table: the connection must be in the namespace.
				if (adapter !== "sqlite") {
					const [row] = (await client.unsafe(
						adapter === "postgres" ? "SELECT current_schema() AS name" : "SELECT DATABASE() AS name",
					)) as Array<{ name: string | null }>;
					expect(row?.name).toBe(name);
				}
				await (await SqlSessionStorage.create({ client })).drain();
				// A row from before `byte_len`: start-up backfills it, and the backfill fails.
				await client.unsafe(
					"INSERT INTO omp_session_files (path, content, mtime_ms) VALUES ('sessions/-p/a.jsonl', 'a', 1)",
				);
				const password = new URL(dsn).password;
				const leak = `connect to ${dsn}${password ? ` as ${password}` : ""}`.replaceAll("'", "''");
				if (adapter === "sqlite") {
					await client.unsafe(
						`CREATE TRIGGER omp_cfg_refuse BEFORE UPDATE ON omp_session_files BEGIN SELECT RAISE(ABORT, '${leak}'); END`,
					);
				} else if (adapter === "mysql") {
					await client.unsafe(
						`CREATE TRIGGER omp_cfg_refuse BEFORE UPDATE ON omp_session_files FOR EACH ROW ` +
							`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${leak}'`,
					);
				} else {
					await client.unsafe(
						"CREATE FUNCTION omp_cfg_refuse() RETURNS trigger LANGUAGE plpgsql AS " +
							`$$ BEGIN RAISE EXCEPTION USING MESSAGE = '${leak}'; END $$`,
					);
					await client.unsafe(
						"CREATE TRIGGER omp_cfg_refuse BEFORE UPDATE ON omp_session_files FOR EACH ROW EXECUTE FUNCTION omp_cfg_refuse()",
					);
				}
				const dsnFile = await writeDsnFile(`${dsn}\n`);

				const error = await rejection(
					resolveSessionStorage({
						settings: Settings.isolated(),
						env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
					}),
				);

				expect(error.message).toStartWith(
					`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened: connect to <redacted>`,
				);
				// The fatal handler prints the error with its causes.
				for (const printed of [error.message, Bun.inspect(error)]) {
					expect(printed).not.toContain(dsn);
					if (password) expect(printed).not.toContain(password);
				}
			} finally {
				await client.end();
				if (admin) {
					if (drop) await admin.unsafe(drop);
					await admin.end();
				}
			}
		});
	});
}

type Dialect = "sqlite" | "postgres" | "mysql";

/** The rejection of `promise`, which must reject. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to fail");
}

/** Statements that make every INSERT and UPDATE of the session table fail with `message`. */
function refuseWritesStatements(adapter: Dialect, message: string): string[] {
	const literal = `'${message.replaceAll("'", "''")}'`;
	if (adapter === "postgres") {
		return [
			"CREATE FUNCTION omp_cfg_refuse_write() RETURNS trigger LANGUAGE plpgsql AS " +
				`$$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
			"CREATE TRIGGER omp_cfg_refuse_write BEFORE INSERT OR UPDATE ON omp_session_files " +
				"FOR EACH ROW EXECUTE FUNCTION omp_cfg_refuse_write()",
		];
	}
	return ["INSERT", "UPDATE"].map(event =>
		adapter === "sqlite"
			? `CREATE TRIGGER omp_cfg_refuse_${event} BEFORE ${event} ON omp_session_files BEGIN SELECT RAISE(ABORT, ${literal}); END`
			: `CREATE TRIGGER omp_cfg_refuse_${event} BEFORE ${event} ON omp_session_files FOR EACH ROW ` +
				`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}`,
	);
}

/** Statements that put a view in the session table's place whose rows fail to read with an error quoting `message`. */
function failReadsStatements(adapter: Dialect, message: string): string[] {
	if (adapter === "sqlite") {
		// A view over a table dropped since fails to read, naming that table.
		const table = `"${message.replaceAll('"', '""')}"`;
		return [
			"ALTER TABLE omp_session_files RENAME TO omp_session_files_real",
			`CREATE TABLE ${table} (path TEXT, mtime_ms INTEGER, byte_len INTEGER, title TEXT, ` +
				"title_source TEXT, title_updated_at TEXT, content TEXT)",
			`CREATE VIEW omp_session_files AS SELECT * FROM ${table}`,
			`DROP TABLE ${table}`,
		];
	}
	const literal = `'${message.replaceAll("'", "''")}'`;
	const view =
		"CREATE VIEW omp_session_files AS SELECT path, mtime_ms, omp_cfg_fail(byte_len) AS byte_len, title, " +
		"title_source, title_updated_at, content FROM omp_session_files_real";
	if (adapter === "mysql") {
		return [
			"RENAME TABLE omp_session_files TO omp_session_files_real",
			"CREATE FUNCTION omp_cfg_fail(v BIGINT) RETURNS BIGINT DETERMINISTIC BEGIN " +
				`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}; RETURN v; END`,
			view,
		];
	}
	return [
		"ALTER TABLE omp_session_files RENAME TO omp_session_files_real",
		"CREATE FUNCTION omp_cfg_fail(v bigint) RETURNS bigint LANGUAGE plpgsql AS " +
			`$$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
		view,
	];
}

const DRIVER_CODES: Record<Dialect, RegExp> = {
	sqlite: /^SQLITE_/,
	postgres: /^ERR_POSTGRES_/,
	mysql: /^ERR_MYSQL_/,
};

for (const { adapter, url } of STARTUP_BACKENDS) {
	describe.skipIf(!url)(`the configured SQL storage after start-up (${adapter})`, () => {
		it("raises database errors without the connection string or its password, and its own errors unchanged", async () => {
			const settingsState = beginSettingsTest();
			const { dsn, name, create, drop } = isolatedDatabase(adapter, url ?? "");
			const admin = create === undefined ? undefined : new SQL(url ?? "", { max: 1 });
			if (create) await admin?.unsafe(create);
			const setup = new SQL(dsn, { max: 1 });
			const bind = (n: number): string => (adapter === "postgres" ? `$${n}` : "?");
			try {
				if (adapter !== "sqlite") {
					const [row] = (await setup.unsafe(
						adapter === "postgres" ? "SELECT current_schema() AS name" : "SELECT DATABASE() AS name",
					)) as Array<{ name: string | null }>;
					expect(row?.name).toBe(name);
				}
				setAgentDir(makeTempDir("@pi-session-storage-agent-"));
				const storage = await resolveSessionStorage({
					settings: Settings.isolated(),
					env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: await writeDsnFile(`${dsn}\n`) },
				});
				if (!(storage instanceof SqlSessionStorage)) throw new Error("expected the SQL storage");
				const dir = "/review/root/-p";
				for (const file of ["kept", "other", "conflict"])
					await storage.writeText(`${dir}/${file}.jsonl`, `${file}\n`);
				await storage.drain();
				const password = new URL(dsn).password;
				const secrets = password ? [dsn, password] : [dsn];
				const leak = `connect to ${dsn}${password ? ` as ${password}` : ""}`;
				const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
				const logged = vi.spyOn(logger, "error").mockImplementation(() => {});

				// Errors the store raises on purpose leave as they are: another client changed
				// the row behind this store's view, and another client took the destination key.
				await setup.unsafe(`UPDATE omp_session_files SET byte_len = 999 WHERE path = ${bind(1)}`, [
					`abs:${dir}/conflict.jsonl`,
				]);
				expect(
					await failure(storage.writeTextAtomic(`${dir}/conflict.jsonl`, "x\n", { expectedSize: 9 })),
				).toBeInstanceOf(SessionWriteConflictError);
				await setup.unsafe(
					`INSERT INTO omp_session_files (path, content, mtime_ms, byte_len) VALUES (${bind(1)}, 'taken', 1, 5)`,
					[`abs:${dir}/taken.jsonl`],
				);
				expect(await failure(storage.renameNoReplace(`${dir}/kept.jsonl`, `${dir}/taken.jsonl`))).toMatchObject({
					code: "EEXIST",
					path: `${dir}/taken.jsonl`,
				});

				// The database's own errors quote the connection string and the password.
				for (const statement of refuseWritesStatements(adapter, leak)) await setup.unsafe(statement);
				const writer = storage.openWriter(`${dir}/kept.jsonl`);
				const errors: Record<string, unknown> = {
					append: await failure(writer.append("appended\n")),
					"full write": await failure(storage.writeText(`${dir}/new.jsonl`, "new\n")),
					rename: await failure(storage.rename(`${dir}/other.jsonl`, `${dir}/renamed.jsonl`)),
				};
				await writer.close().catch(() => undefined);
				const persistence: Error[] = [];
				const manager = SessionManager.create(makeTempDir("@pi-session-storage-cwd-"), "/review/root/-sm", storage);
				manager.onPersistenceError(error => persistence.push(error));
				manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test-model",
					usage: fakeUsage(1, 1),
					stopReason: "stop",
					timestamp: Date.now(),
				});
				await manager.flush().catch(() => undefined);
				await manager.close().catch(() => undefined);
				expect(persistence.length).toBeGreaterThan(0);
				errors["SessionManager persistence"] = persistence[0];

				for (const statement of failReadsStatements(adapter, leak)) await setup.unsafe(statement);
				errors.refresh = await failure(storage.refresh());
				// The picker and the listings refresh first, and list nothing when that fails.
				expect(await listSessions(dir, storage)).toEqual([]);
				expect(await listAllSessions(storage, "/review/root")).toEqual([]);

				for (const operation of ["append", "full write", "rename", "refresh"]) {
					expect({ operation, error: errors[operation] }).toMatchObject({
						operation,
						error: { code: expect.stringMatching(DRIVER_CODES[adapter]) },
					});
				}
				for (const [operation, error] of Object.entries(errors)) {
					// The fatal handler and the logs print an error with its fields and causes.
					const printed = Bun.inspect(error);
					expect({ operation, redacted: printed.includes("connect to <redacted>") }).toEqual({
						operation,
						redacted: true,
					});
					for (const secret of secrets) {
						expect({ operation, leaks: printed.includes(secret) }).toEqual({ operation, leaks: false });
					}
				}
				// The persistence notice is logged once; no warning quotes the connection string.
				const logs = JSON.stringify([...warned.mock.calls, ...logged.mock.calls]);
				expect(logs).toContain("connect to <redacted>");
				for (const secret of secrets) expect(logs.includes(secret)).toBe(false);
			} finally {
				restoreSettingsTestState(settingsState);
				await setup.end();
				if (admin) {
					if (drop) await admin.unsafe(drop);
					await admin.end();
				}
			}
		}, 60_000);
	});
}
