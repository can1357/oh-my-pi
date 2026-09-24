import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, removeSyncWithRetries } from "@oh-my-pi/pi-utils/temp";

describe("removeWithRetries", () => {
	// Retries are Windows-only by design (`shouldRetryRemove` gates on
	// `process.platform === "win32"`), so the locked-removal path only exists there.
	it.skipIf(process.platform !== "win32")("forces a major GC before the first retry of a locked removal", async () => {
		// bun on Windows finalizes SQLite db/-wal/-shm file and directory
		// handles on GC, so a closed database can still block deletion for
		// seconds. The first retry must trigger one forced collection instead
		// of burning the retry window.
		const target = path.join(os.tmpdir(), `pi-temp-gc-test-${process.pid}-${Date.now()}`);
		await fs.promises.mkdir(target, { recursive: true });
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
			await fs.promises.rm(target, { recursive: true, force: true });
		}
	});

	it("does not force a GC when removal succeeds on the first attempt", async () => {
		const target = path.join(os.tmpdir(), `pi-temp-gc-test-${process.pid}-${Date.now()}`);
		await fs.promises.mkdir(target, { recursive: true });
		const gc = spyOn(Bun, "gc");

		try {
			await removeWithRetries(target);
			expect(gc).not.toHaveBeenCalled();
		} finally {
			gc.mockRestore();
			await fs.promises.rm(target, { recursive: true, force: true });
		}
	});
});

describe("removeSyncWithRetries", () => {
	it.skipIf(process.platform !== "win32")("forces a major GC before the first retry of a locked removal", () => {
		const target = path.join(os.tmpdir(), `pi-temp-gc-test-${process.pid}-${Date.now()}`);
		fs.mkdirSync(target, { recursive: true });
		let attempts = 0;
		const rm = spyOn(fs, "rmSync").mockImplementation(() => {
			attempts++;
			if (attempts === 1) {
				const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
		});
		const gc = spyOn(Bun, "gc");

		try {
			removeSyncWithRetries(target);
			expect(attempts).toBe(2);
			expect(gc).toHaveBeenCalledTimes(1);
		} finally {
			rm.mockRestore();
			gc.mockRestore();
			fs.rmSync(target, { recursive: true, force: true });
		}
	});
});
