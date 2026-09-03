/**
 * Regression test for issue #7058: on Windows, puppeteer-core deletes its temp
 * Chrome profile with an unretried `rm()` from an eager process-exit hook, so an
 * EBUSY on the still-locked profile surfaces as an unhandled rejection that
 * crashes OMP. OMP now owns the profile directory and removes it itself with a
 * lock-tolerant, warn-and-leave cleanup.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

describe("headless Chromium profile cleanup (issue #7058)", () => {
	afterEach(() => {
		spyOn(piUtils, "removeWithRetries").mockRestore();
		spyOn(piUtils.logger, "warn").mockRestore();
	});

	it("removes an owned profile directory", async () => {
		const dir = await makeProfileDir();
		await removeUserDataDir(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("warns and leaves the directory instead of throwing when it stays locked (EBUSY)", async () => {
		const dir = await makeProfileDir();
		const ebusy = Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: "EBUSY" });
		const removeSpy = spyOn(piUtils, "removeWithRetries").mockRejectedValue(ebusy);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			// Must resolve — a cleanup failure never propagates as a crash.
			await expect(removeUserDataDir(dir)).resolves.toBeUndefined();
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			removeSpy.mockRestore();
			// Real removal so the fixture does not leak.
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes the handle's profile directory when the headless browser is disposed", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			browser: {
				connected: true,
				process: () => ({ pid: 4242 }),
				close: () => Promise.resolve(),
			},
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;

		await releaseBrowser(handle, { kill: false });

		expect(fs.existsSync(dir)).toBe(false);
	});
});
