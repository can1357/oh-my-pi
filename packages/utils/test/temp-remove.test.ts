import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, removeWithRetries } from "@oh-my-pi/pi-utils/temp";

// Retries are Windows-only by design (`shouldRetryRemove` gates on
// `process.platform === "win32"`), so the locked-removal path only exists there.
describe.skipIf(process.platform !== "win32")("locked temp directory removal", () => {
	// bun on Windows keeps a closed SQLite database's file handles open until
	// every statement prepared on it is finalized, and a leaked statement is only
	// finalized by GC. Nothing collects during a blocking retry loop, so without a
	// forced collection the directory stays locked past the whole retry window
	// and removeSyncWithRetries throws EBUSY.
	it("removeSyncWithRetries deletes a closed SQLite database whose statement was never finalized", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-remove-"));
		openAndCloseLeakingStatement(path.join(dir, "store.db"));
		try {
			removeSyncWithRetries(dir);
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			Bun.gc(true);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The async loop yields to the event loop, where bun eventually collects on
	// its own, so the same leak only costs a ~1 s stall there instead of a
	// failure. Assert the forced collection directly.
	it("removeWithRetries forces a major GC before the first retry", async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-remove-"));
		let attempts = 0;
		const rm = spyOn(fsPromises, "rm").mockImplementation(async () => {
			attempts++;
			if (attempts === 1) {
				const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
		});
		const gc = spyOn(Bun, "gc");

		try {
			await removeWithRetries(target);
			expect(attempts).toBe(2);
			expect(gc).toHaveBeenCalledTimes(1);
		} finally {
			rm.mockRestore();
			gc.mockRestore();
			fs.rmSync(target, { recursive: true, force: true });
		}
	});
});

function openAndCloseLeakingStatement(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
	db.run("INSERT INTO kv VALUES ('a', '1')");
	db.prepare("SELECT value FROM kv WHERE key = ?").get("a");
	db.close();
}
