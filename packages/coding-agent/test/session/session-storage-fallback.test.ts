/**
 * The rule that makes `session.storage: sql` safe to switch on for a box that
 * may not hold a connection file yet: a session falls back to the file store
 * only before its first SQL write, loudly and with a ledger line; after that
 * write it halts rather than forking its transcript across two stores.
 *
 * Also guards the two default-path behaviours a switched-off `session.storage`
 * must keep: a hidden copy of a transcript is not a session, and a dotted
 * agent id resolves to its canonical nested transcript.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir, sessionFilesFromDisk } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { FileSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	resolveSessionStorage,
	SessionStorageConfigError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import {
	fallbackEvent,
	ledgerLine,
	noteSqlWriteCommitted,
	resetSqlWriteLatchForTest,
	sqlStoreHasWritten,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-fallback";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

/** A `sql` environment whose connection file does not exist, plus the ledger it would append to. */
function brokenSqlEnv(): { env: NodeJS.ProcessEnv; dsnFile: string; ledger: string } {
	const root = makeTempDir("@pi-session-fallback-");
	const dsnFile = path.join(root, "missing", "dsn");
	const ledger = path.join(root, "ledger", "fallbacks.jsonl");
	return {
		env: {
			OMP_SESSION_STORAGE: "sql",
			OMP_SESSION_SQL_DSN_FILE: dsnFile,
			OMP_SESSION_SQL_FALLBACK_LEDGER: ledger,
		},
		dsnFile,
		ledger,
	};
}

function ledgerLines(file: string): Record<string, unknown>[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
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

// Another session test in this process may have written through a SQL store,
// which latches the run; the rule under test is about this launch.
beforeEach(() => {
	resetSqlWriteLatchForTest();
});

afterEach(async () => {
	resetSqlWriteLatchForTest();
	setDefaultSessionStorage(new FileSessionStorage());
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("sql → file fallback", () => {
	it("a resume whose transcript is a file continues on the file store and records one ledger line", async () => {
		const { env, dsnFile, ledger } = brokenSqlEnv();
		const storage = await resolveSessionStorage({
			settings: Settings.isolated(),
			env,
			resumableFileSession: async () => "01a1a000-0000-7000-8000-000000000001",
		});

		expect(storage).toBeInstanceOf(FileSessionStorage);
		const lines = ledgerLines(ledger);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			session_id: "01a1a000-0000-7000-8000-000000000001",
			reason: "dsn-missing",
			dsn_path: dsnFile,
		});
		expect(typeof lines[0]?.ts).toBe("string");
		expect(typeof lines[0]?.host).toBe("string");
	});

	it("a new session refuses to start and writes no ledger line", async () => {
		const { env, dsnFile, ledger } = brokenSqlEnv();
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env,
				// A launch that resumes nothing on disk: there is no transcript to go on with.
				resumableFileSession: async () => null,
			}),
		);

		expect(error.message).toContain(dsnFile);
		expect(ledgerLines(ledger)).toHaveLength(0);
	});

	it("a launch that cannot fall back at all still refuses, naming the connection file", async () => {
		const { env, dsnFile } = brokenSqlEnv();
		const error = await rejection(resolveSessionStorage({ settings: Settings.isolated(), env }));
		expect(error.message).toContain(dsnFile);
	});

	it("once this run has written to the database, a resumable file session no longer falls back", async () => {
		const { env, ledger } = brokenSqlEnv();
		noteSqlWriteCommitted();
		expect(sqlStoreHasWritten()).toBe(true);

		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env,
				resumableFileSession: async () => "01a1a000-0000-7000-8000-000000000002",
			}),
		);

		expect(error).toBeInstanceOf(SessionStorageConfigError);
		expect(ledgerLines(ledger)).toHaveLength(0);
	});

	it("an append the database accepted latches the run, and a later failed write leaves no file transcript", async () => {
		const root = makeTempDir("@pi-session-fallback-write-");
		const dbFile = path.join(root, "sessions.db");
		const sessionFile = path.join(root, "sessions", "project", "session.jsonl");
		const storage = await SqlSessionStorage.create({ client: new SQL(`sqlite://${dbFile}`) });

		expect(sqlStoreHasWritten()).toBe(false);
		await storage.writeText(sessionFile, '{"type":"session"}\n');
		expect(sqlStoreHasWritten()).toBe(true);

		// The database goes away mid-session. The next write must fail, and no
		// part of the transcript may appear as a file: a torn history split over
		// two stores is the damage the latch exists to prevent.
		fs.rmSync(dbFile);
		fs.mkdirSync(dbFile); // a directory where the database file was: every further statement fails
		let failed = false;
		try {
			await storage.writeText(sessionFile, '{"type":"session"}\n{"type":"message"}\n');
		} catch {
			failed = true;
		}

		expect(failed).toBe(true);
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(fs.existsSync(path.dirname(sessionFile))).toBe(false);
	});

	it("a ledger line stays inside one page even when the connection path is enormous", () => {
		const line = ledgerLine(fallbackEvent("s".repeat(64), "db-unreachable", "/".repeat(9000)));
		expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096);
		expect(line.endsWith("\n")).toBe(true);
		expect(line.indexOf("\n")).toBe(line.length - 1);
		expect(JSON.parse(line.trim())).toMatchObject({ reason: "db-unreachable" });
	});
});

describe("default file storage keeps main's listing behaviour", () => {
	it("a hidden copy of a transcript is not listed as a session", () => {
		const dir = makeTempDir("@pi-session-hidden-");
		fs.writeFileSync(path.join(dir, "2026-11-04T00-00-00-000Z_abc.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, ".2026-11-04T01-00-00-000Z_abc.jsonl"), "{}\n");

		const listed = new FileSessionStorage().listFilesSync(dir, "*.jsonl").map(file => path.basename(file));
		expect(listed).toEqual(["2026-11-04T00-00-00-000Z_abc.jsonl"]);
	});

	it("a dotted agent id resolves to its canonical nested transcript, not a copy beside it", async () => {
		const dir = makeTempDir("@pi-session-nested-");
		fs.mkdirSync(path.join(dir, "A"));
		const nested = path.join(dir, "A", "A.B.jsonl");
		fs.writeFileSync(nested, "{}\n");
		fs.writeFileSync(path.join(dir, "A.B.jsonl"), "{}\n");

		const unregister = registerArtifactsDir(dir);
		try {
			expect((await sessionFilesFromDisk()).get("A.B")).toBe(nested);
			// `onlyPreferred` keeps its own rule: a direct transcript wins there.
			expect((await sessionFilesFromDisk(dir, { onlyPreferred: true })).get("A.B")).toBe(
				path.join(dir, "A.B.jsonl"),
			);
		} finally {
			unregister();
		}
	});
});
