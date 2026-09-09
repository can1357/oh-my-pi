/**
 * Regression coverage: `SqliteAuthCredentialStore.close()` must finalize every
 * cached prepared statement before `#db.close()`.
 *
 * An unfinalized statement makes `sqlite3_close()` return SQLITE_BUSY, which
 * bun:sqlite swallows — the connection (and its `-wal`/`-shm` handles) stays
 * open. On Windows that leaves the files locked and breaks temp-dir teardown;
 * on POSIX it is silent but still leaks descriptors.
 *
 * Observable contract: after `close()`, a fresh connection can take exclusive
 * access to the file (`PRAGMA journal_mode=DELETE` needs it). With a leaked
 * statement this throws "database is locked".
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

let tempDir = "";

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-close-handles-"));
});

afterEach(async () => {
	if (tempDir) {
		await removeWithRetries(tempDir);
		tempDir = "";
	}
});

function expectExclusiveAccess(dbPath: string): void {
	const observer = new Database(dbPath);
	try {
		// Leaving WAL requires an exclusive lock; a still-open connection from
		// the closed store makes this throw SQLITE_BUSY.
		observer.run("PRAGMA journal_mode=DELETE");
	} finally {
		observer.close();
	}
}

test("close() releases the connection so the DB file can be locked exclusively", async () => {
	const dbPath = path.join(tempDir, "agent.db");
	const store = await SqliteAuthCredentialStore.open(dbPath);
	store.close();

	expect(() => expectExclusiveAccess(dbPath)).not.toThrow();
});

test("close() releases the connection after the lease/cache statements have run", async () => {
	const dbPath = path.join(tempDir, "used.db");
	const store = await SqliteAuthCredentialStore.open(dbPath);
	// Exercise statements that close() previously forgot to finalize.
	store.deleteCachePrefix("sticky:");
	store.releaseCredentialRefreshLease(1, "owner");
	store.close();

	expect(() => expectExclusiveAccess(dbPath)).not.toThrow();
});
