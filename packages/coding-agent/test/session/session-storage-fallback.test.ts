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

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { SQL } from "bun";
import * as fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
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
	commitSessionStorageFallback,
	commitSessionStorageFallbackSync,
	fallbackEvent,
	ledgerLine,
	noteSqlWriteCommitted,
	pendingSessionStorageFallback,
	resetSqlWriteLatchForTest,
	sqlStoreHasWritten,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-fallback";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionPaths from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SESSION_TRANSFER_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
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
			resumableFileSession: async () => true,
		});

		expect(storage).toBeInstanceOf(FileSessionStorage);
		// The real line is on disk already: writing it is what proves the ledger
		// can take one, and the count exists even if the launch never gets
		// further. The session is a placeholder until it does.
		const reserved = ledgerLines(ledger);
		expect(reserved).toHaveLength(1);
		expect(String(reserved[0]?.session_id)).toContain("(unresolved)");
		expect(reserved[0]).toMatchObject({ reason: "dsn-missing", dsn_path: dsnFile });
		expect(typeof reserved[0]?.ts).toBe("string");
		expect(typeof reserved[0]?.host).toBe("string");
		expect(pendingSessionStorageFallback()).toMatchObject({ reason: "dsn-missing", dsnPath: dsnFile });

		// The launch names the session it opened, in place: still one line.
		await commitSessionStorageFallback("01a1a000-0000-7000-8000-0000000000ff");
		const lines = ledgerLines(ledger);
		expect(lines).toHaveLength(1);
		expect(String(lines[0]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-0000000000ff");
		expect(lines[0]).toMatchObject({ reason: "dsn-missing", dsn_path: dsnFile });

		// Once, never twice.
		await commitSessionStorageFallback("01a1a000-0000-7000-8000-0000000000ee");
		const after = ledgerLines(ledger);
		expect(after).toHaveLength(1);
		expect(String(after[0]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-0000000000ff");
	});

	it("a new session refuses to start and writes no ledger line", async () => {
		const { env, dsnFile, ledger } = brokenSqlEnv();
		const error = await rejection(
			resolveSessionStorage({
				settings: Settings.isolated(),
				env,
				// A launch that resumes nothing on disk: there is no transcript to go on with.
				resumableFileSession: async () => false,
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
				resumableFileSession: async () => true,
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

	it("a write committed while the ledger line is being appended also stops the fallback", async () => {
		const { env, ledger } = brokenSqlEnv();
		// The latch flips while the ledger line is being written: `mkdir` is the
		// reserve's first await, so a write landing there is inside exactly the
		// window the post-reserve latch read exists for.
		const realMkdir = fsp.mkdir;
		const spy = vi.spyOn(fsp, "mkdir").mockImplementation((async (...args: Parameters<typeof fsp.mkdir>) => {
			noteSqlWriteCommitted();
			return await realMkdir(...args);
		}) as typeof fsp.mkdir);
		try {
			const error = await rejection(
				resolveSessionStorage({
					settings: Settings.isolated(),
					env,
					resumableFileSession: async () => true,
				}),
			);
			expect(error.message).toContain("halts instead");
		} finally {
			spy.mockRestore();
		}
		// The line was already on disk when the write landed, and it keeps its
		// placeholder: a refused launch names no session.
		const lines = ledgerLines(ledger);
		expect(lines).toHaveLength(1);
		expect(String(lines[0]?.session_id)).toContain("(unresolved)");
	});

	it("two launches that would write the same line still each name their own", async () => {
		// Same millisecond, same host, same connection file: before the
		// placeholder carried a nonce these two lines were byte-identical, and
		// each refinement found whichever the scan hit first.
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const first = ledgerLines(ledger)[0];

		// A second launch in this ledger, as another process would write it.
		resetSqlWriteLatchForTest();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const both = ledgerLines(ledger);
		expect(both).toHaveLength(2);
		expect(String(both[0]?.session_id)).not.toBe(String(both[1]?.session_id));
		expect(String(both[0]?.session_id)).toContain("(unresolved)");
		expect(String(both[1]?.session_id)).toContain("(unresolved)");

		// Only the second launch's own line takes its session.
		await commitSessionStorageFallback("01a1a000-0000-7000-8000-00000000bbbb");
		const after = ledgerLines(ledger);
		expect(after).toHaveLength(2);
		expect(String(after[0]?.session_id)).toBe(String(first?.session_id));
		expect(String(after[1]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-00000000bbbb");
	});

	it("a ledger truncated in place while the refinement is between its read and its write", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		expect(fs.readFileSync(ledger, "utf8").length).toBeGreaterThan(0);

		// The window that matters: the scan has already read the file, so its
		// snapshot still holds the line, and the truncation lands before the
		// write. Without a check on the bytes at the offset the write goes past
		// a shortened end and fills the gap with NULs.
		const realReadSync = fsSync.readSync;
		const spy = vi.spyOn(fsSync, "readSync").mockImplementation(((...args: Parameters<typeof fsSync.readSync>) => {
			const read = realReadSync(...args);
			fs.truncateSync(ledger, 0);
			return read;
		}) as typeof fsSync.readSync);
		try {
			commitSessionStorageFallbackSync("01a1a000-0000-7000-8000-00000000dddd");
		} finally {
			spy.mockRestore();
		}

		const after = fs.readFileSync(ledger);
		expect(after.includes(0)).toBe(false);
		expect(after.toString("utf8")).toBe("");
	});

	it("a ledger replaced while the refinement is between its read and its write", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const replacement = `${JSON.stringify({ ts: "x", session_id: "keep-me", reason: "dsn-missing", dsn_path: "/p", host: "h" })}\n`;

		// Same window as the truncation above and the same guard answers it: the
		// scan's snapshot still holds the line, so an offset into it means
		// nothing for whatever now carries the name.
		const realReadSync = fsSync.readSync;
		const spy = vi.spyOn(fsSync, "readSync").mockImplementation(((...args: Parameters<typeof fsSync.readSync>) => {
			const read = realReadSync(...args);
			fs.truncateSync(ledger, 0);
			fs.writeFileSync(ledger, replacement);
			return read;
		}) as typeof fsSync.readSync);
		try {
			commitSessionStorageFallbackSync("01a1a000-0000-7000-8000-00000000cccc");
		} finally {
			spy.mockRestore();
		}

		// Byte-for-byte what was put there: no id written into another record.
		expect(fs.readFileSync(ledger, "utf8")).toBe(replacement);
	});

	it("two launches that would write the same line still each name their own", async () => {
		// Same millisecond, same host, same connection file: before the
		// placeholder carried a nonce these two lines were byte-identical, and
		// each refinement found whichever the scan hit first.
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const first = ledgerLines(ledger)[0];

		// A second launch in this ledger, as another process would write it.
		resetSqlWriteLatchForTest();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const both = ledgerLines(ledger);
		expect(both).toHaveLength(2);
		expect(String(both[0]?.session_id)).not.toBe(String(both[1]?.session_id));
		expect(String(both[0]?.session_id)).toContain("(unresolved)");
		expect(String(both[1]?.session_id)).toContain("(unresolved)");

		// Only the second launch's own line takes its session.
		await commitSessionStorageFallback("01a1a000-0000-7000-8000-00000000bbbb");
		const after = ledgerLines(ledger);
		expect(after).toHaveLength(2);
		expect(String(after[0]?.session_id)).toBe(String(first?.session_id));
		expect(String(after[1]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-00000000bbbb");
	});

	it("a ledger truncated in place while the refinement is between its read and its write", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		expect(fs.readFileSync(ledger, "utf8").length).toBeGreaterThan(0);

		// The window that matters: the scan has already read the file, so its
		// snapshot still holds the line, and the truncation lands before the
		// write. Without a check on the bytes at the offset the write goes past
		// a shortened end and fills the gap with NULs.
		const realReadSync = fsSync.readSync;
		const spy = vi.spyOn(fsSync, "readSync").mockImplementation(((...args: Parameters<typeof fsSync.readSync>) => {
			const read = realReadSync(...args);
			fs.truncateSync(ledger, 0);
			return read;
		}) as typeof fsSync.readSync);
		try {
			commitSessionStorageFallbackSync("01a1a000-0000-7000-8000-00000000dddd");
		} finally {
			spy.mockRestore();
		}

		const after = fs.readFileSync(ledger);
		expect(after.includes(0)).toBe(false);
		expect(after.toString("utf8")).toBe("");
	});

	it("a ledger rotated while the refinement is between its read and its write", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const replacement = `${JSON.stringify({ ts: "x", session_id: "keep-me", reason: "dsn-missing", dsn_path: "/p", host: "h" })}\n`;

		// The rename lands after the scan has read the file, so the scan's
		// snapshot still holds the line and an offset into it means nothing for
		// whatever now carries the name.
		const realReadSync = fsSync.readSync;
		const spy = vi.spyOn(fsSync, "readSync").mockImplementation(((...args: Parameters<typeof fsSync.readSync>) => {
			const read = realReadSync(...args);
			fs.renameSync(ledger, `${ledger}.1`);
			fs.writeFileSync(ledger, replacement);
			return read;
		}) as typeof fsSync.readSync);
		try {
			commitSessionStorageFallbackSync("01a1a000-0000-7000-8000-00000000cccc");
		} finally {
			spy.mockRestore();
		}

		// The file now at the name is byte-for-byte what was put there.
		expect(fs.readFileSync(ledger, "utf8")).toBe(replacement);
	});

	it("two launches that would write the same line still each name their own", async () => {
		// Same millisecond, same host, same connection file: before the
		// placeholder carried a nonce these two lines were byte-identical, and
		// each refinement found whichever the scan hit first.
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const first = ledgerLines(ledger)[0];

		// A second launch in this ledger, as another process would write it.
		resetSqlWriteLatchForTest();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const both = ledgerLines(ledger);
		expect(both).toHaveLength(2);
		expect(String(both[0]?.session_id)).not.toBe(String(both[1]?.session_id));
		expect(String(both[0]?.session_id)).toContain("(unresolved)");
		expect(String(both[1]?.session_id)).toContain("(unresolved)");

		// Only the second launch's own line takes its session.
		await commitSessionStorageFallback("01a1a000-0000-7000-8000-00000000bbbb");
		const after = ledgerLines(ledger);
		expect(after).toHaveLength(2);
		expect(String(after[0]?.session_id)).toBe(String(first?.session_id));
		expect(String(after[1]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-00000000bbbb");
	});

	it("a ledger truncated in place while the refinement is between its read and its write", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		expect(fs.readFileSync(ledger, "utf8").length).toBeGreaterThan(0);

		// The window that matters: the scan has already read the file, so its
		// snapshot still holds the line, and the truncation lands before the
		// write. Without a check on the bytes at the offset the write goes past
		// a shortened end and fills the gap with NULs.
		const realReadSync = fsSync.readSync;
		const spy = vi.spyOn(fsSync, "readSync").mockImplementation(((...args: Parameters<typeof fsSync.readSync>) => {
			const read = realReadSync(...args);
			fs.truncateSync(ledger, 0);
			return read;
		}) as typeof fsSync.readSync);
		try {
			commitSessionStorageFallbackSync("01a1a000-0000-7000-8000-00000000dddd");
		} finally {
			spy.mockRestore();
		}

		const after = fs.readFileSync(ledger);
		expect(after.includes(0)).toBe(false);
		expect(after.toString("utf8")).toBe("");
	});

	it("a ledger rotated after the fallback was decided leaves the new file untouched", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });

		// The one maintenance action an append-only log invites, between the
		// decision and the refinement.
		fs.renameSync(ledger, `${ledger}.1`);
		const replacement = `${JSON.stringify({ ts: "x", session_id: "keep-me", reason: "dsn-missing", dsn_path: "/p", host: "h" })}\n`;
		fs.writeFileSync(ledger, replacement);

		await commitSessionStorageFallback("01a1a000-0000-7000-8000-00000000cccc");

		// The replacement is byte-for-byte what it was: the refinement wrote
		// into the file it had scanned, which rotation moved aside.
		expect(fs.readFileSync(ledger, "utf8")).toBe(replacement);
		const rotated = fs.readFileSync(`${ledger}.1`, "utf8");
		expect(JSON.parse(rotated.trim())).toBeTruthy();
	});

	it("a line another process appended between the decision and the refinement is left alone", async () => {
		const { env, ledger } = brokenSqlEnv();
		await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
		const ours = ledgerLines(ledger)[0];
		expect(String(ours?.session_id)).toContain("(unresolved)");

		// Another process appends while this launch is still starting. Nothing
		// may record a byte offset before this: `O_APPEND` chose where our own
		// line went, and this one moves the end again.
		const foreign = ledgerLine(fallbackEvent("ffffffff-0000-7000-8000-00000000ffff", "db-unreachable", "/other"));
		fs.appendFileSync(ledger, foreign, "utf8");

		await commitSessionStorageFallback("01a1a000-0000-7000-8000-00000000aaaa");

		const lines = ledgerLines(ledger);
		expect(lines).toHaveLength(2);
		expect(String(lines[0]?.session_id).trim()).toBe("01a1a000-0000-7000-8000-00000000aaaa");
		expect(lines[0]).toMatchObject({ dsn_path: ours?.dsn_path });
		// The other process's line keeps its own id and its own path.
		expect(String(lines[1]?.session_id).trim()).toBe("ffffffff-0000-7000-8000-00000000ffff");
		expect(lines[1]).toMatchObject({ dsn_path: "/other", reason: "db-unreachable" });
	});

	it("an id with a quote, a newline or a multibyte character cannot break the line", async () => {
		for (const id of ['a"b', "a\nb", "héllo-ünïcøde", "x".repeat(200)]) {
			resetSqlWriteLatchForTest();
			const { env, ledger } = brokenSqlEnv();
			await resolveSessionStorage({ settings: Settings.isolated(), env, resumableFileSession: async () => true });
			await commitSessionStorageFallback(id);

			const raw = fs.readFileSync(ledger, "utf8");
			// One physical line, still parseable, and the field is exactly as wide
			// as it was: the refinement writes bytes in place.
			expect(raw.split("\n").filter(part => part.length > 0)).toHaveLength(1);
			const parsed = JSON.parse(raw.trim()) as Record<string, string>;
			expect(Buffer.byteLength(JSON.stringify(parsed.session_id).slice(1, -1), "utf8")).toBe(36);
			// Either the id round-trips, or the placeholder stayed; never a
			// half-written value.
			const recorded = String(parsed.session_id).trimEnd();
			expect(recorded === id || recorded.startsWith("(unresolved)")).toBe(true);
		}
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
			// Fixed-width, so the in-place refinement never changes the length.
			expect(String(JSON.parse(line.trim()).session_id)).toHaveLength(36);
		}
	});

	it("a ledger that cannot take the real line refuses the fallback, not an empty probe write", async () => {
		const { env, ledger } = brokenSqlEnv();
		fs.mkdirSync(path.dirname(ledger), { recursive: true });
		// A ledger whose directory is read-only: the file cannot be created, so
		// the real write fails where opening a path might not have.
		fs.writeFileSync(ledger, "");
		fs.chmodSync(ledger, 0o400);
		try {
			const error = await rejection(
				resolveSessionStorage({
					settings: Settings.isolated(),
					env,
					resumableFileSession: async () => true,
				}),
			);
			expect(error.message).toContain(ledger);
			expect(ledgerLines(ledger)).toHaveLength(0);
		} finally {
			fs.chmodSync(ledger, 0o600);
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
				resumableFileSession: async () => true,
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
					return true;
				},
			}),
		);

		expect(error).toBeInstanceOf(SessionStorageConfigError);
		expect(ledgerLines(ledger)).toHaveLength(0);
	});
});

describe("which launches may fall back", () => {
	// The probe reads the terminal breadcrumb, which is this test process's own
	// real one: ambient, shared, and nothing here owns it. Each case states the
	// breadcrumb it means to test.
	beforeEach(() => {
		vi.spyOn(sessionPaths, "readTerminalBreadcrumbEntry").mockResolvedValue(null);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A session file written exactly as `SessionManager.createEmptySessionFile` writes one. */
	let seq = 0;
	function writeTranscript(dir: string, cwd: string): string {
		fs.mkdirSync(dir, { recursive: true });
		const id = crypto.randomUUID();
		const timestamp = new Date(Date.UTC(2026, 10, 4) + seq++ * 1000).toISOString();
		const file = path.join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: path.resolve(cwd) };
		// A turn, not just a header: `continueRecent` skips header-only empties,
		// so a transcript without one is not continuable and the probe must say so.
		const turn = {
			type: "message",
			id: `m-${id}`,
			parentId: null,
			timestamp,
			message: { role: "user", content: "first prompt", timestamp: Date.parse(timestamp) },
		};
		new FileSessionStorage().writeTextSync(
			file,
			`${serializeTitleSlot({ title: `probe-${id.slice(0, 8)}`, source: "user", updatedAt: timestamp })}${JSON.stringify(header)}\n${JSON.stringify(turn)}\n`,
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
		expect(await resumableFileSessionId(args, ["--continue", unknown], dir)).toBe(false);
	});

	it("`--continue <id>` that resolves answers that session, not the newest one", async () => {
		const dir = makeTempDir("@pi-session-continue-known-");
		const sessions = path.join(dir, "sessions");
		const wanted = writeTranscript(sessions, dir);
		const newer = writeTranscript(sessions, dir);
		expect(newer).not.toBe(wanted);

		const args: Args = { ...base, continue: true, sessionDir: sessions, messages: [wanted] };
		expect(await resumableFileSessionId(args, ["--continue", wanted], dir)).toBe(true);
	});

	it("`--fork` creates a new session, so it may not fall back", async () => {
		const dir = makeTempDir("@pi-session-fork-");
		const sessions = path.join(dir, "sessions");
		writeTranscript(sessions, dir);
		const args: Args = { ...base, continue: true, fork: "", sessionDir: sessions };
		expect(await resumableFileSessionId(args, ["--continue", "--fork"], dir)).toBe(false);
		// The same launch without --fork does resolve, so the refusal is the flag.
		expect(await resumableFileSessionId({ ...args, fork: undefined }, ["--continue"], dir)).toBe(true);
	});

	it("a session marked as moved away may not fall back: resuming it opens a fork", async () => {
		const dir = makeTempDir("@pi-session-departed-");
		const sessions = path.join(dir, "sessions");
		const id = writeTranscript(sessions, dir);
		const [file] = new FileSessionStorage().listFilesSync(sessions, "*.jsonl");
		fs.appendFileSync(
			file!,
			`${JSON.stringify({
				type: "custom_message",
				customType: SESSION_TRANSFER_MESSAGE_TYPE,
				details: { kind: "departed", to: "other-box" },
			})}\n`,
		);

		const args: Args = { ...base, continue: true, sessionDir: sessions };
		expect(await resumableFileSessionId(args, ["--continue"], dir)).toBe(false);
		// By id, the route a `--continue <id>` or `--resume <id>` launch takes.
		expect(await resumableFileSessionId({ ...base, resume: id, sessionDir: sessions }, [], dir)).toBe(false);
	});

	it("the picker may not fall back: its session is not chosen yet", async () => {
		const dir = makeTempDir("@pi-session-picker-");
		const sessions = path.join(dir, "sessions");
		writeTranscript(sessions, dir);
		const args: Args = { ...base, resume: true, sessionDir: sessions };
		expect(await resumableFileSessionId(args, ["--resume"], dir)).toBe(false);
	});

	it("a launch with no session may not fall back", async () => {
		const dir = makeTempDir("@pi-session-nosession-");
		const sessions = path.join(dir, "sessions");
		writeTranscript(sessions, dir);
		const args: Args = { ...base, continue: true, noSession: true, sessionDir: sessions };
		expect(await resumableFileSessionId(args, ["--continue"], dir)).toBe(false);
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

	it("a transcript name that is not a regular file is not a transcript", async () => {
		const dir = makeTempDir("@pi-session-kinds-");
		fs.writeFileSync(path.join(dir, "Real.jsonl"), "{}\n");
		fs.symlinkSync(path.join(dir, "Real.jsonl"), path.join(dir, "SymFile.jsonl"));
		fs.symlinkSync(path.join(dir, "gone.jsonl"), path.join(dir, "Broken.jsonl"));
		// A FIFO is the one that matters: reading it blocks until an EOF that
		// never comes, so a walk must never hand its path to the reader.
		execFileSync("mkfifo", [path.join(dir, "Fifo.jsonl")]);

		const unregister = registerArtifactsDir(dir);
		try {
			const found = await sessionFilesFromDisk();
			expect([...found.keys()].sort()).toEqual(["Real"]);
		} finally {
			unregister();
		}
	});

	it("the transcript tree walk takes regular files only, dot-named ones included", async () => {
		// Through `listTranscriptTree`, the call the report bundle and the tree
		// copy make — not through the primitive it happens to use, which would
		// assert the rule against itself.
		const dir = makeTempDir("@pi-session-roster-");
		const children = path.join(dir, "main");
		fs.mkdirSync(children);
		fs.writeFileSync(path.join(children, "Plain.jsonl"), "{}\n");
		fs.writeFileSync(path.join(children, ".Hidden.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, "away.jsonl"), "{}\n");
		fs.symlinkSync(path.join(dir, "away.jsonl"), path.join(children, "Linked.jsonl"));

		const walked = listTranscriptTree(new FileSessionStorage(), children)
			.map(file => path.basename(file))
			.sort();
		expect(walked).toEqual([".Hidden.jsonl", "Plain.jsonl"]);
	});

	it("a transcript name that is not a regular file is not a transcript", async () => {
		const dir = makeTempDir("@pi-session-kinds-");
		fs.writeFileSync(path.join(dir, "Real.jsonl"), "{}\n");
		fs.symlinkSync(path.join(dir, "Real.jsonl"), path.join(dir, "SymFile.jsonl"));
		fs.symlinkSync(path.join(dir, "gone.jsonl"), path.join(dir, "Broken.jsonl"));
		// A FIFO is the one that matters: reading it blocks until an EOF that
		// never comes, so a walk must never hand its path to the reader.
		execFileSync("mkfifo", [path.join(dir, "Fifo.jsonl")]);

		const unregister = registerArtifactsDir(dir);
		try {
			const found = await sessionFilesFromDisk();
			expect([...found.keys()].sort()).toEqual(["Real"]);
		} finally {
			unregister();
		}
	});

	it("every enumerator of one session's subagent tree applies the same rule", async () => {
		// `sessionFilesFromDisk`, `collectSubSessions` and the persisted roster
		// each walk the same directory; on upstream main all three took regular
		// files and showed dot-named ones. One of them reading through a glob
		// instead would hide the dot-named one and follow the symlink.
		const dir = makeTempDir("@pi-session-roster-");
		const root = path.join(dir, "main.jsonl");
		const children = path.join(dir, "main");
		fs.mkdirSync(children);
		fs.writeFileSync(root, "{}\n");
		fs.writeFileSync(path.join(children, "Plain.jsonl"), "{}\n");
		fs.writeFileSync(path.join(children, ".Hidden.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, "away.jsonl"), "{}\n");
		fs.symlinkSync(path.join(dir, "away.jsonl"), path.join(children, "Linked.jsonl"));

		const storage = new FileSessionStorage();
		const roster = storage
			.listEntriesSync(children)
			.filter(entry => entry.isFile && entry.name.endsWith(".jsonl"))
			.map(entry => entry.name)
			.sort();
		expect(roster).toEqual([".Hidden.jsonl", "Plain.jsonl"]);
	});

	it("the full transcript walk follows the directory's own order, as a readdir walk did", async () => {
		const dir = makeTempDir("@pi-session-nested-");
		fs.mkdirSync(path.join(dir, "Z"));
		fs.writeFileSync(path.join(dir, "Z", "Worker.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, "Worker.jsonl"), "{}\n");
		fs.writeFileSync(path.join(dir, ".Hidden.jsonl"), "{}\n");

		// What a plain readdir walk — the one this replaced — would have chosen:
		// the directory's own entries in their own order, descending into each
		// as it is met. Read through `fs` directly, not through the storage, so
		// the assertion cannot agree with the walk by construction.
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		expect(entries.map(entry => entry.name).sort()).toEqual([".Hidden.jsonl", "Worker.jsonl", "Z"]);
		let expected: string | undefined;
		for (const entry of entries) {
			if (entry.isDirectory()) expected ??= path.join(dir, entry.name, "Worker.jsonl");
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
