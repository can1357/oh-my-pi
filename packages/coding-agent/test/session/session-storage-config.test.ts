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
	openSessionSqlStorage,
	resolveSessionStorage,
	type SessionSqlConnection,
	SessionStorageConfigError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SQL } from "bun";
import { ESCAPABLE_PASSWORDS, expectNoSpelling, redactorFor } from "../helpers/connection-redaction";
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
		const open = async (contents: string) =>
			openSessionSqlClient({
				settings: Settings.isolated(),
				env: { OMP_SESSION_SQL_DSN_FILE: await writeDsnFile(`${contents}\n`) },
			});
		const full = await open(dsn);
		const dotted = await open("postgres://app:x.y@db.example/sessions");
		const two = await open("mysql://bob:pw@db.example/sessions");
		try {
			expect(full.redact(`could not reach ${dsn}.`)).toBe("could not reach <redacted>.");
			expect(full.redact("password p%40ss%3Aw0rd and p@ss:w0rd")).toBe("password <redacted> and <redacted>");
			expect(full.redact("login app-user:p@ss:w0rd@db.example")).toBe("login <redacted>@db.example");
			expect(full.redact("login app%2Duser:p%40ss%3Aw0rd@db")).toBe("login <redacted>@db");
			expect(full.redact("ssl key k3y%2Bpass, k3y+pass")).toBe("ssl key <redacted>, <redacted>");
			// A password of 4 or more characters goes wherever it occurs, a row key included.
			expect(full.redact('row "sessions/p@ss:w0rd.jsonl"')).toBe('row "sessions/<redacted>.jsonl"');
			// The user and the host alone are not secrets.
			expect(full.redact("role app-user on db.example")).toBe("role app-user on db.example");
			// Redacting twice changes nothing more.
			expect(full.redact(full.redact(`at ${dsn}`))).toBe("at <redacted>");

			// A shorter password goes where it stands as a token: no letter, digit or `_` beside it.
			for (const [text, redacted] of [
				["password x.y", "password <redacted>"],
				["the password is x.y.", "the password is <redacted>."],
				["'x.y' (x.y) «x.y» =x.y,", "'<redacted>' (<redacted>) «<redacted>» =<redacted>,"],
				["sessions/x.y/a.jsonl", "sessions/<redacted>/a.jsonl"],
				["app:x.y@db.example", "<redacted>@db.example"],
				// Inside a longer word it is ordinary text, and reveals nothing there.
				["ax.y x.yz x.y_1 éx.y", "ax.y x.yz x.y_1 éx.y"],
			] as const) {
				expect({ text, redacted: dotted.redact(text) }).toEqual({ text, redacted });
			}
			expect(two.redact("bob:pw@db.example rejected pwd, pw: pw")).toBe(
				"<redacted>@db.example rejected pwd, <redacted>: <redacted>",
			);
			expect(two.redact("mysql://bob:pw@db.example/sessions")).toBe("<redacted>");
		} finally {
			for (const connection of [full, dotted, two]) await connection.client.end();
		}
	});
});

type Dialect = "sqlite" | "postgres" | "mysql";

/** SQLite always; PostgreSQL and MySQL when their throwaway test database is named. */
const STORE_BACKENDS: ReadonlyArray<{ adapter: Dialect; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let tableSeq = 0;

/**
 * One test's session table and its fixture client, opened the way the
 * configured storage opens the database: a server test shares the test
 * database, so it uses a table of its own there, with no connection-string
 * option (a startup `search_path` would stay on a transaction pooler's
 * server connection after the test); SQLite uses a file of its own. Each
 * fixture object is dropped, in reverse order, when the test ends.
 */
class OwnTable implements AsyncDisposable {
	readonly table = `omp_cfg_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly dsn: string;
	readonly client: SQL;
	readonly #drops: string[] = [];

	constructor(
		readonly adapter: Dialect,
		url: string,
	) {
		this.dsn =
			adapter === "sqlite" ? `sqlite:${path.join(makeTempDir("@pi-session-storage-own-"), "sessions.db")}` : url;
		this.client = new SQL(this.dsn, { max: 1 });
		this.dropAtEnd(`DROP TABLE IF EXISTS ${this.table}_parts`, `DROP TABLE IF EXISTS ${this.table}`);
	}

	/** The password of the connection string, when it has one. */
	get password(): string {
		return new URL(this.dsn).password;
	}

	/** The connection string and its password: what no printed text may contain. */
	get secrets(): string[] {
		return this.password ? [this.dsn, this.password] : [this.dsn];
	}

	/** The configured storage's client of this database, from a connection-string file. */
	async connect(): Promise<SessionSqlConnection> {
		return openSessionSqlClient({
			settings: Settings.isolated(),
			env: { OMP_SESSION_SQL_DSN_FILE: await writeDsnFile(`${this.dsn}\n`) },
		});
	}

	/** Fixture SQL written with `?` placeholders. */
	sql(query: string, values: unknown[] = []): Promise<unknown> {
		let n = 0;
		return this.client.unsafe(this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query, values);
	}

	/** Run `statements`, then drop what they made with `drops` when the test ends. */
	async run(statements: readonly string[], ...drops: string[]): Promise<void> {
		for (const statement of statements) await this.sql(statement);
		this.dropAtEnd(...drops);
	}

	/** Drop objects when the test ends; give the drops in creation order, as they run last first. */
	dropAtEnd(...drops: string[]): void {
		this.#drops.push(...drops);
	}

	/** Make every INSERT and UPDATE of the session table fail with `message`. */
	refuseWrites(message: string): Promise<void> {
		const literal = `'${message.replaceAll("'", "''")}'`;
		const name = `${this.table}_refuse`;
		if (this.adapter === "postgres") {
			return this.run(
				[
					`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS ` +
						`$$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
					`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${this.table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
				],
				`DROP FUNCTION IF EXISTS ${name}() CASCADE`,
			);
		}
		return this.run(
			["INSERT", "UPDATE"].map(event =>
				this.adapter === "sqlite"
					? `CREATE TRIGGER ${name}_${event} BEFORE ${event} ON ${this.table} BEGIN SELECT RAISE(ABORT, ${literal}); END`
					: `CREATE TRIGGER ${name}_${event} BEFORE ${event} ON ${this.table} FOR EACH ROW ` +
						`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}`,
			),
		);
	}

	/** Put a view in the session table's place whose rows fail to read with an error quoting `message`. */
	failReads(message: string): Promise<void> {
		const real = `${this.table}_real`;
		const fail = `${this.table}_fail`;
		const view = (expression: string): string =>
			`CREATE VIEW ${this.table} AS SELECT path, mtime_ms, ${expression} AS byte_len, title, title_source, ` +
			`title_updated_at, content FROM ${real}`;
		if (this.adapter === "sqlite") {
			// A view over a table dropped since fails to read, naming that table.
			const named = `"${message.replaceAll('"', '""')}"`;
			return this.run(
				[
					`ALTER TABLE ${this.table} RENAME TO ${real}`,
					`CREATE TABLE ${named} (path TEXT, mtime_ms INTEGER, byte_len INTEGER, title TEXT, ` +
						"title_source TEXT, title_updated_at TEXT, content TEXT)",
					`CREATE VIEW ${this.table} AS SELECT * FROM ${named}`,
					`DROP TABLE ${named}`,
				],
				`DROP TABLE IF EXISTS ${real}`,
				`DROP VIEW IF EXISTS ${this.table}`,
			);
		}
		const literal = `'${message.replaceAll("'", "''")}'`;
		if (this.adapter === "mysql") {
			return this.run(
				[
					`RENAME TABLE ${this.table} TO ${real}`,
					`CREATE FUNCTION ${fail}(v BIGINT) RETURNS BIGINT DETERMINISTIC BEGIN ` +
						`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${literal}; RETURN v; END`,
					view(`${fail}(byte_len)`),
				],
				`DROP TABLE IF EXISTS ${real}`,
				`DROP FUNCTION IF EXISTS ${fail}`,
				`DROP VIEW IF EXISTS ${this.table}`,
			);
		}
		return this.run(
			[
				`ALTER TABLE ${this.table} RENAME TO ${real}`,
				`CREATE FUNCTION ${fail}(v bigint) RETURNS bigint LANGUAGE plpgsql AS ` +
					`$$ BEGIN RAISE EXCEPTION USING MESSAGE = ${literal}; END $$`,
				view(`${fail}(byte_len)`),
			],
			`DROP TABLE IF EXISTS ${real}`,
			`DROP FUNCTION IF EXISTS ${fail}(bigint)`,
			`DROP VIEW IF EXISTS ${this.table}`,
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		for (const drop of this.#drops.reverse()) await this.client.unsafe(drop);
		await this.client.end();
	}
}

/** The rejection of `promise`, which must reject. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to fail");
}

/** `printed`, which must hold none of `secrets`, as a value whose mismatch names `label`. */
function expectNoSecret(label: string, printed: string, secrets: readonly string[]): void {
	for (const secret of secrets) expect({ label, leaks: printed.includes(secret) }).toEqual({ label, leaks: false });
}

const DRIVER_CODES: Record<Dialect, RegExp> = {
	sqlite: /^SQLITE_/,
	postgres: /^ERR_POSTGRES_/,
	mysql: /^ERR_MYSQL_/,
};

for (const { adapter, url } of STORE_BACKENDS) {
	describe.skipIf(!url)(`the configured SQL storage's diagnostics (${adapter})`, () => {
		it("refuses a failed start-up statement without the connection string or its password", async () => {
			await using own = new OwnTable(adapter, url ?? "");
			const setup = await own.connect();
			try {
				await (await SqlSessionStorage.create({ client: setup.client, table: own.table })).drain();
			} finally {
				await setup.client.end();
			}
			// A row from before `byte_len`: start-up backfills it, and the backfill fails.
			await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms) VALUES ('sessions/-p/a.jsonl', 'a', 1)`);
			await own.refuseWrites(`connect to ${own.dsn}${own.password ? ` as ${own.password}` : ""}`);
			const connection = await own.connect();

			const error = await failure(openSessionSqlStorage(connection, { table: own.table }));

			expect(error).toBeInstanceOf(SessionStorageConfigError);
			expect(String((error as Error).message)).toStartWith(
				`OMP_SESSION_SQL_DSN_FILE names ${connection.dsnFile}, but the session database could not be opened: connect to <redacted>`,
			);
			// The fatal handler prints the error with its causes.
			expectNoSecret("start-up refusal", Bun.inspect(error), own.secrets);
		});

		it("raises database errors without the connection string or its password, and its own errors unchanged", async () => {
			const settingsState = beginSettingsTest();
			await using own = new OwnTable(adapter, url ?? "");
			const connection = await own.connect();
			try {
				setAgentDir(makeTempDir("@pi-session-storage-agent-"));
				const storage = await openSessionSqlStorage(connection, { table: own.table });
				const dir = "/review/root/-p";
				for (const file of ["kept", "other", "conflict"])
					await storage.writeText(`${dir}/${file}.jsonl`, `${file}\n`);
				await storage.drain();
				const leak = `connect to ${own.dsn}${own.password ? ` as ${own.password}` : ""}`;
				const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
				const logged = vi.spyOn(logger, "error").mockImplementation(() => {});

				// Errors the store raises on purpose leave as they are: another client changed
				// the row behind this store's view, and another client took the destination key.
				await own.sql(`UPDATE ${own.table} SET byte_len = 999 WHERE path = ?`, [`abs:${dir}/conflict.jsonl`]);
				expect(
					await failure(storage.writeTextAtomic(`${dir}/conflict.jsonl`, "x\n", { expectedSize: 9 })),
				).toBeInstanceOf(SessionWriteConflictError);
				await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms, byte_len) VALUES (?, 'taken', 1, 5)`, [
					`abs:${dir}/taken.jsonl`,
				]);
				expect(await failure(storage.renameNoReplace(`${dir}/kept.jsonl`, `${dir}/taken.jsonl`))).toMatchObject({
					code: "EEXIST",
					path: `${dir}/taken.jsonl`,
				});

				// The database's own errors quote the connection string and the password.
				await own.refuseWrites(leak);
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

				await own.failReads(leak);
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
					expectNoSecret(operation, printed, own.secrets);
				}
				// The persistence notice is logged once; no warning quotes the connection string.
				const logs = JSON.stringify([...warned.mock.calls, ...logged.mock.calls]);
				expect(logs).toContain("connect to <redacted>");
				expectNoSecret("logs", logs, own.secrets);
			} finally {
				restoreSettingsTestState(settingsState);
				await connection.client.end();
			}
		}, 60_000);

		/**
		 * The configured storage over a table that holds `key`, and the
		 * diagnostic `provoke` gets from it, printed as the logs and the fatal
		 * handler print it. The stored key never changes.
		 */
		async function rowDiagnostic(
			key: (own: OwnTable) => string,
			byteLen: number | null,
			provoke: (storage: SqlSessionStorage, connection: SessionSqlConnection, own: OwnTable) => Promise<unknown>,
		): Promise<{ printed: string; secrets: string[] }> {
			await using own = new OwnTable(adapter, url ?? "");
			const connection = await own.connect();
			try {
				const storage = await openSessionSqlStorage(connection, { table: own.table });
				const stored = key(own);
				await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms, byte_len) VALUES (?, 'safe', 1, ?)`, [
					stored,
					byteLen,
				]);
				const printed = await provoke(storage, connection, own);
				const keys = (await own.sql(`SELECT path FROM ${own.table}`)) as Array<{ path: string }>;
				expect(keys.map(row => row.path)).toEqual([stored]);
				return { printed: typeof printed === "string" ? printed : Bun.inspect(printed), secrets: own.secrets };
			} finally {
				vi.restoreAllMocks();
				await connection.client.end();
			}
		}

		it("logs a skipped row key that quotes the connection string redacted", async () => {
			const { printed, secrets } = await rowDiagnostic(
				own => `sessions/../${own.dsn}`,
				4,
				async storage => {
					const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
					await storage.refresh();
					const warning = warned.mock.calls.find(([message]) => String(message).includes("skipped rows"));
					expect(warning?.[1]).toMatchObject({ count: 1, example: "sessions/../<redacted>" });
					return JSON.stringify(warned.mock.calls);
				},
			);
			expectNoSecret("skipped-row warning", printed, secrets);
		});

		it("refuses a row with no byte_len whose key quotes a secret, redacted", async () => {
			const { printed, secrets } = await rowDiagnostic(
				own => (adapter === "sqlite" ? `sessions/${own.dsn}` : `sessions/${own.password}.jsonl`),
				null,
				async storage => {
					const refusal = await failure(storage.refresh());
					expect(String((refusal as Error).message)).toContain('row "sessions/<redacted>');
					return refusal;
				},
			);
			expectNoSecret("unmeasured-row refusal", printed, secrets);
		});

		it("refuses at start-up a legacy row key that quotes the connection string, redacted", async () => {
			const { printed, secrets } = await rowDiagnostic(
				own => own.dsn,
				4,
				async (_storage, connection, own) => {
					const refusal = await failure(
						SqlSessionStorage.create({ client: connection.client, table: own.table, redact: connection.redact }),
					);
					expect(String((refusal as Error).message)).toContain('holds the row key "<redacted>"');
					return refusal;
				},
			);
			expectNoSecret("legacy-key refusal", printed, secrets);
		});

		for (const password of ESCAPABLE_PASSWORDS) {
			it(`redacts a row key holding the password ${JSON.stringify(password)} before quoting it`, async () => {
				await using own = new OwnTable(adapter, url ?? "");
				// The redactor of a connection string with this password; the store's client
				// is the test database's. Logging in with such a password is not the point:
				// the point is the key the store quotes.
				const secret = await redactorFor(password);
				const client = new SQL(own.dsn, { max: 1 });
				try {
					const open = () => SqlSessionStorage.create({ client, table: own.table, redact: secret.redact });
					const storage = await open();
					const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
					await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms, byte_len) VALUES (?, 'safe', 1, 4)`, [
						`sessions/../${password}`,
					]);
					await storage.refresh();
					const warning = warned.mock.calls.find(([message]) => String(message).includes("skipped rows"));
					expect(warning?.[1]).toMatchObject({ example: "sessions/../<redacted>" });
					// The logger writes its fields as JSON.
					expectNoSpelling("skipped-row warning", JSON.stringify(warned.mock.calls), password);

					await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms) VALUES (?, 'safe', 1)`, [
						`sessions/${password}.jsonl`,
					]);
					const unmeasured = await failure(storage.refresh());
					expect(String((unmeasured as Error).message)).toContain(
						'row "sessions/<redacted>.jsonl" has no byte_len',
					);
					expectNoSpelling("unmeasured-row refusal", Bun.inspect(unmeasured), password);

					await own.sql(`INSERT INTO ${own.table} (path, content, mtime_ms, byte_len) VALUES (?, 'safe', 1, 4)`, [
						`/srv/${password}.jsonl`,
					]);
					const legacy = await failure(open());
					expect(String((legacy as Error).message)).toContain('holds the row key "/srv/<redacted>.jsonl"');
					expectNoSpelling("legacy-key refusal", Bun.inspect(legacy), password);
				} finally {
					vi.restoreAllMocks();
					await client.end();
					await secret.client.end();
				}
			});
		}
	});
}
