/**
 * `JudgmentCache.close()` must release the database. Its prepared statements were never finalized,
 * so the connection stayed open after close() and SQLite closed it at process exit instead, taking
 * the shared store's WAL write lock for a checkpoint while other omp processes were using it.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { JudgmentCache } from "@oh-my-pi/pi-coding-agent/judgment";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assertNotHeldOpen } from "@oh-my-pi/pi-utils/held-file";

describe("JudgmentCache.close", () => {
	it("releases the database and its WAL index", () => {
		using dir = TempDir.createSync("@omp-judgment-cache-close-");
		const dbPath = path.join(dir.path(), "judgment-cache.db");
		const cache = JudgmentCache.open(dbPath);
		expect(() => assertNotHeldOpen(dbPath)).toThrow("EBUSY");

		cache.close();
		expect(() => assertNotHeldOpen(dbPath)).not.toThrow();
		expect(() => assertNotHeldOpen(`${dbPath}-shm`)).not.toThrow();
	});
});
