/**
 * Regression coverage for issue #2421.
 *
 * Concurrent omp startups can race against WAL recovery so the auth-store init
 * sees `SQLITE_BUSY` / `SQLITE_BUSY_RECOVERY` before its multi-statement run
 * installs the busy handler. The fix hoists `PRAGMA busy_timeout` to a separate
 * statement that runs first and wraps `open()` in a bounded retry loop on the
 * BUSY family.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isSqliteBusyError, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

interface SqliteBusyShape extends Error {
	code: string;
	errno: number;
}

function makeBusyError(code: string, errno: number): SqliteBusyShape {
	const err = new Error("database is locked") as SqliteBusyShape;
	err.code = code;
	err.errno = errno;
	return err;
}

describe("isSqliteBusyError", () => {
	test("recognizes every documented BUSY family code", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY", 5))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
		expect(isSqliteBusyError(makeBusyError("SQLITE_BUSY_TIMEOUT", 773))).toBe(true);
	});

	test("rejects non-BUSY codes and non-error values", () => {
		expect(isSqliteBusyError(makeBusyError("SQLITE_LOCKED", 6))).toBe(false);
		expect(isSqliteBusyError(makeBusyError("SQLITE_CORRUPT", 11))).toBe(false);
		expect(isSqliteBusyError(new Error("plain"))).toBe(false);
		expect(isSqliteBusyError(null)).toBe(false);
		expect(isSqliteBusyError(undefined)).toBe(false);
		expect(isSqliteBusyError("SQLITE_BUSY")).toBe(false);
	});
});

describe("SqliteAuthCredentialStore.open SQLITE_BUSY handling", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-sqlite-busy-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("open() waits out a writer through the busy handler installed before the leases DDL (#7298)", async () => {
		const dbPath = path.join(tempDir, "ordering.db");
		const sentinel = path.join(tempDir, "locked.sentinel");
		// The child creates the (empty) database and holds an EXCLUSIVE lock for
		// 750ms, shorter than the headless 1000ms busy_timeout. The empty file
		// forces open()'s leases DDL to take the write lock, so only a busy
		// handler installed BEFORE that DDL lets the first attempt wait out the
		// writer; the pre-fix code (busy_timeout=0 during the DDL) failed every
		// attempt. Readiness is signaled via a sentinel
		// file written after BEGIN EXCLUSIVE — not stdout — so the handshake
		// cannot be affected by how the runner wires child stdio.
		const locker = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const db = new Database(process.argv[1]);
db.run("BEGIN EXCLUSIVE");
writeFileSync(process.argv[2], "locked");
await Bun.sleep(750);
db.run("COMMIT");
db.close();`,
				dbPath,
				sentinel,
			],
			{ env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stdout: "ignore", stderr: "pipe" },
		);
		// Real-time waits are unavoidable here: the lock lives in a separate
		// process, so fake timers cannot advance the child's sleep or the
		// filesystem sentinel it writes.
		const deadline = Date.now() + 5000;
		let locked = false;
		while (Date.now() < deadline) {
			locked = await fs.access(sentinel).then(
				() => true,
				() => false,
			);
			if (locked || locker.exitCode !== null) break;
			await Bun.sleep(10);
		}
		if (!locked) {
			throw new Error(`locker never signaled readiness: ${await new Response(locker.stderr).text()}`);
		}

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			// The store is fully usable after contention: the leases DDL ran.
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
		const [exitCode, stderr] = await Promise.all([locker.exited, new Response(locker.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	});

	test("retries through a transient SQLITE_BUSY_RECOVERY and eventually succeeds", async () => {
		const dbPath = path.join(tempDir, "retry.db");
		let throws = 2;
		// Synthesize the WAL-recovery race: the first two `db.run` calls in
		// `#initializeSchema` (the first being `PRAGMA busy_timeout = 5000`)
		// throw `SQLITE_BUSY_RECOVERY`, then the third attempt sees the spy
		// drained and falls through to the real implementation.
		const realRun = Database.prototype.run;
		const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			if (throws > 0) {
				throws--;
				throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
			}
			return realRun.apply(this, args);
		});

		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(throws).toBe(0);
			expect(spy).toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	test("non-BUSY errors short-circuit retries", async () => {
		const dbPath = path.join(tempDir, "fatal.db");
		const realRun = Database.prototype.run;
		let runCalls = 0;
		// SQLITE_IOERR is neither BUSY (retried) nor CORRUPT (quarantined and
		// recreated by `open()`), so it must surface on the first attempt.
		vi.spyOn(Database.prototype, "run").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof realRun>
		) {
			runCalls++;
			if (runCalls === 1) {
				const err = new Error("disk I/O error") as SqliteBusyShape;
				err.code = "SQLITE_IOERR";
				err.errno = 10;
				throw err;
			}
			return realRun.apply(this, args);
		});

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow("disk I/O error");
		// Single attempt: the retry loop must NOT keep banging on a fatal error.
		expect(runCalls).toBe(1);
	});

	test("exhausts the retry budget and surfaces an error that includes the DB path and the wait", async () => {
		const dbPath = path.join(tempDir, "stuck.db");
		vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database) {
			// Always-busy: every attempt fails until the retry budget runs out.
			throw makeBusyError("SQLITE_BUSY_RECOVERY", 261);
		});
		// The budget is wall-clock. Skipped sleeps advance a fake clock instead, so the
		// test spends no real time and the loop still meets its deadline.
		let now = performance.now();
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const delays: number[] = [];
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			const delay = typeof ms === "number" ? ms : 0;
			delays.push(delay);
			now += delay;
		});

		const error = await SqliteAuthCredentialStore.open(dbPath).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(String(error)).toContain(dbPath);
		expect(String(error)).toMatch(/still locked after \d+ s and \d+ attempts/);
		expect(error).toMatchObject({ code: "SQLITE_BUSY_RECOVERY" });
		// Doubling, jittered delays capped at 2 s, stopping within the 60 s budget.
		expect(delays.length).toBeGreaterThan(4);
		expect(Math.max(...delays)).toBeLessThanOrEqual(2_000);
		expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(60_000);
	});
});
