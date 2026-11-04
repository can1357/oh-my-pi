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
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resumableFileSessionId } from "@oh-my-pi/pi-coding-agent/main";
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
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

	it("a ledger line stays inside one page however large its caller-sized fields are", () => {
		for (const [session, dsn] of [
			["s".repeat(64), "/".repeat(9000)],
			["s".repeat(9000), "/tmp/dsn"],
			["s".repeat(9000), "/".repeat(9000)],
		]) {
			const line = ledgerLine(fallbackEvent(session!, "db-unreachable", dsn!));
			expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096);
			expect(line.indexOf("\n")).toBe(line.length - 1);
			expect(JSON.parse(line.trim())).toMatchObject({ reason: "db-unreachable" });
		}
	});

	it("a fallback whose ledger cannot be written is not taken", async () => {
		const { env, ledger } = brokenSqlEnv();
		// A directory where the ledger file goes: the append can never succeed.
		fs.mkdirSync(ledger, { recursive: true });

		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env,
				resumableFileSession: async () => "01a1a000-0000-7000-8000-000000000003",
			}),
		);

		expect(error.message).toContain(ledger);
		expect(fs.statSync(ledger).isDirectory()).toBe(true);
	});

	it("a write committed while the resume probe is awaited stops the fallback", async () => {
		const { env, ledger } = brokenSqlEnv();
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env,
				resumableFileSession: async () => {
					// The latch is read before and after this await; a write landing
					// here must still halt the launch.
					await Bun.sleep(1);
					noteSqlWriteCommitted();
					return "01a1a000-0000-7000-8000-000000000004";
				},
			}),
		);

		expect(error).toBeInstanceOf(SessionStorageConfigError);
		expect(ledgerLines(ledger)).toHaveLength(0);
	});
});

describe("which launches may fall back", () => {
	/** A session file written exactly as `SessionManager.createEmptySessionFile` writes one. */
	let seq = 0;
	function writeTranscript(dir: string, cwd: string): string {
		fs.mkdirSync(dir, { recursive: true });
		const id = crypto.randomUUID();
		const timestamp = new Date(Date.UTC(2026, 10, 4) + seq++ * 1000).toISOString();
		const file = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: path.resolve(cwd) };
		new FileSessionStorage().writeTextSync(
			file,
			`${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`,
		);
		return id;
	}

	const base = {
		messages: [] as string[],
		fileArgs: [] as string[],
		unrecognizedFlags: [] as string[],
	} as unknown as Args;

	it("`--continue <id>` that resolves to nothing may not fall back", async () => {
		const dir = makeTempDir("@pi-session-continue-");
		writeTranscript(path.join(dir, "sessions"), dir);
		const unknown = "00000000-0000-7000-8000-000000000000";

		const args: Args = { ...base, continue: true, sessionDir: path.join(dir, "sessions"), messages: [unknown] };
		expect(await resumableFileSessionId(args, ["--continue", unknown], dir)).toBeNull();
	});

	it("`--continue <id>` that resolves answers that session, not the newest one", async () => {
		const dir = makeTempDir("@pi-session-continue-known-");
		const sessions = path.join(dir, "sessions");
		const wanted = writeTranscript(sessions, dir);
		const newer = writeTranscript(sessions, dir);
		expect(newer).not.toBe(wanted);

		const args: Args = { ...base, continue: true, sessionDir: sessions, messages: [wanted] };
		expect(await resumableFileSessionId(args, ["--continue", wanted], dir)).toBe(wanted);
	});

	it("a launch with no session may not fall back", async () => {
		const dir = makeTempDir("@pi-session-nosession-");
		const sessions = path.join(dir, "sessions");
		writeTranscript(sessions, dir);
		const args: Args = { ...base, continue: true, noSession: true, sessionDir: sessions };
		expect(await resumableFileSessionId(args, ["--continue"], dir)).toBeNull();
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

	it("the full transcript walk follows the directory's own order, as a readdir walk did", async () => {
		const dir = makeTempDir("@pi-session-nested-");
		fs.mkdirSync(path.join(dir, "Z"));
		fs.writeFileSync(path.join(dir, "Z", "Worker.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, "Worker.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, ".Hidden.jsonl"), "{}\n");

		// What a plain readdir walk — the one this replaced — would have chosen:
		// entries in the directory's order, descending into each as it is met.
		const storage = new FileSessionStorage();
		const entries = storage.listEntriesSync(dir);
		expect(entries.map(entry => entry.name).sort()).toEqual([".Hidden.jsonl", "Worker.jsonl", "Z"]);
		let expected: string | undefined;
		for (const entry of entries) {
			if (entry.isDirectory) expected ??= path.join(dir, entry.name, "Worker.jsonl");
			else if (entry.name === "Worker.jsonl") expected ??= path.join(dir, entry.name);
		}

		const unregister = registerArtifactsDir(dir);
		try {
			const found = await sessionFilesFromDisk();
			expect(found.get("Worker")).toBe(expected);
			// A dot-named transcript is still a transcript to this walk, as it was
			// to readdir; only the session listings hide hidden names.
			expect(found.get(".Hidden")).toBe(path.join(dir, ".Hidden.jsonl"));
			// `onlyPreferred` keeps its own rule: a direct transcript wins there.
			expect((await sessionFilesFromDisk(dir, { onlyPreferred: true })).get("Worker")).toBe(
				path.join(dir, "Worker.jsonl"),
			);
		} finally {
			unregister();
		}
	});
});
