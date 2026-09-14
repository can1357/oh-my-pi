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
	});
});
