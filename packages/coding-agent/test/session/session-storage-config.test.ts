/**
 * `resolveSessionStorage` — the `session.storage` / `session.sql.dsnFile`
 * contract (`OMP_SESSION_STORAGE` / `OMP_SESSION_SQL_DSN_FILE` win over the
 * settings), and the process-wide default it is installed into: once a SQL
 * storage is the default, `SessionManager.create` / `open` / `list` called
 * without a storage argument read and write the same table.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	resolveSessionStorage,
	SessionStorageConfigError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

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

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

/** A connection URL for a fake server, with a password that no refusal may echo. */
function fakeServerUrl(scheme: string, port: number, query = ""): string {
	const url = new URL(`${scheme}://127.0.0.1:${port}/sessions${query}`);
	url.username = "app";
	url.password = "hunter2";
	return url.href;
}

/**
 * A PostgreSQL server that answers each connection's startup message with one
 * FATAL `ErrorResponse` carrying `sqlState`, as a server that is starting up,
 * has no connection slot left, or refuses a password answers, and closes it.
 * Returns a connection URL for it.
 */
function refusingPostgres(sqlState: string, message: string): string {
	const fields = new TextEncoder().encode(`SFATAL\0VFATAL\0C${sqlState}\0M${message}\0\0`);
	const response = new Uint8Array(5 + fields.length);
	response[0] = 0x45; // 'E': ErrorResponse, then a length that counts itself
	new DataView(response.buffer).setInt32(1, 4 + fields.length);
	response.set(fields, 5);
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket) {
				socket.write(response);
				socket.end();
			},
		},
	});
	servers.push(server);
	return fakeServerUrl("postgres", server.port, "?sslmode=disable");
}

/** One MySQL protocol packet: a three-byte little-endian payload length, the sequence id, the payload. */
function mysqlPacket(sequence: number, payload: Uint8Array): Uint8Array {
	const packet = new Uint8Array(4 + payload.length);
	packet.set([payload.length & 0xff, (payload.length >>> 8) & 0xff, (payload.length >>> 16) & 0xff, sequence]);
	packet.set(payload, 4);
	return packet;
}

/**
 * A MySQL server that sends its handshake and answers the client's reply with
 * one `ERR` packet carrying `errno` and `sqlState`, as a server that refuses a
 * login or has no connection left answers, and closes the connection. Returns
 * a connection URL for it.
 */
function refusingMysql(errno: number, sqlState: string, message: string): string {
	const text = new TextEncoder();
	// CLIENT_PROTOCOL_41 (which puts the SQLSTATE in an ERR packet), SECURE_CONNECTION and PLUGIN_AUTH among them.
	const capabilities = 0x81bff7ff;
	const handshake = Uint8Array.from([
		10, // protocol version
		...text.encode("8.0.36\0"),
		// connection id
		1,
		0,
		0,
		0,
		...text.encode("abcdefgh\0"), // auth data, first 8 bytes, and a filler
		// capabilities, low half
		capabilities & 0xff,
		(capabilities >>> 8) & 0xff,
		0x21, // character set
		// status
		2,
		0,
		// capabilities, high half
		(capabilities >>> 16) & 0xff,
		capabilities >>> 24,
		21, // auth data length
		...new Uint8Array(10),
		...text.encode("ijklmnopqrst\0"), // auth data, the rest
		...text.encode("mysql_native_password\0"),
	]);
	const refusal = Uint8Array.from([0xff, errno & 0xff, errno >>> 8, ...text.encode(`#${sqlState}${message}`)]);
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.write(mysqlPacket(0, handshake));
			},
			data(socket) {
				socket.write(mysqlPacket(2, refusal));
				socket.end();
			},
		},
	});
	servers.push(server);
	return fakeServerUrl("mysql", server.port);
}

afterEach(async () => {
	setDefaultSessionStorage(new FileSessionStorage());
	for (const server of servers.splice(0)) server.stop(true);
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
		// which code the connect attempt happened to fail with. No server answered,
		// so the code stands alone in the parenthesis, with no SQLSTATE beside it.
		expect(error.message).toMatch(/ \(ERR_POSTGRES_CONNECTION_[A-Z_]+\)$/);
		expect(error.message).not.toContain("hunter2");
	});

	it.each([
		["57P03", "the database system is starting up"],
		["53300", "sorry, too many clients already"],
		["28P01", 'password authentication failed for user "app"'],
	])("names the SQLSTATE %s a PostgreSQL server refused with, beside the driver's code", async (sqlState, message) => {
		const dsnFile = await writeDsnFile(refusingPostgres(sqlState, message));
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			}),
		);
		// A connection error has no SQLSTATE (the test above); a server's refusal does, and every one
		// has the same code, so the SQLSTATE is what tells "starting up" from "wrong password".
		expect(error.message).toBe(
			`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened: ${message} (ERR_POSTGRES_SERVER_ERROR ${sqlState})`,
		);
		expect(error.message).not.toContain("hunter2");
	});

	it.each([
		[1045, "28000", "Access denied for user 'app'@'localhost' (using password: YES)"],
		[1040, "08004", "Too many connections"],
	])(
		"names the SQLSTATE of a MySQL server's refusal (error %d) beside the driver's code",
		async (errno, sqlState, message) => {
			const dsnFile = await writeDsnFile(refusingMysql(errno, sqlState, message));
			const error = await rejection(
				resolveSessionStorage({
					settings: Settings.isolated(),
					env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
				}),
			);
			expect(error.message).toBe(
				`OMP_SESSION_SQL_DSN_FILE names ${dsnFile}, but the session database could not be opened: ${message} (ERR_MYSQL_SERVER_ERROR ${sqlState})`,
			);
			expect(error.message).not.toContain("hunter2");
		},
	);
});
