/**
 * Regression test for issue #5260: the browser tool can hang indefinitely at
 * the "Closing tab" phase.
 *
 * `releaseTab` bounds the worker-close handshake, but the subsequent
 * `releaseBrowser` -> `disposeBrowserHandle` awaited Puppeteer's
 * `browser.close()` for the headless kind with no timeout. `browser.close()`
 * resolves only once the Chromium process fully exits; a wedged Chromium (a
 * known Windows failure mode) left that await pending forever, freezing
 * cleanup. The dispose must now cap the wait and force-kill the process tree
 * on timeout so cleanup always completes.
 */

import { describe, expect, it, spyOn, vi } from "bun:test";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

/** Build a headless handle whose `browser.close()` never resolves. */
function makeHangingHeadlessHandle(pid: number | undefined): {
	handle: BrowserHandle;
	closeCalls: () => number;
} {
	let closeCalls = 0;
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 1,
		browser: {
			connected: true,
			process: () => (pid === undefined ? null : { pid }),
			close: () => {
				closeCalls++;
				return new Promise<void>(() => {}); // never resolves
			},
		},
		stealth: { browserSession: null, override: null },
	} as unknown as BrowserHandle;
	return { handle, closeCalls: () => closeCalls };
}

describe("browser dispose — headless close must not hang forever (issue #5260)", () => {
	it("bounds a wedged browser.close() and force-kills the process tree", async () => {
		vi.useFakeTimers();
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		try {
			const { handle, closeCalls } = makeHangingHeadlessHandle(4242);
			const released = releaseBrowser(handle, { kill: false });

			expect(closeCalls()).toBe(1);
			vi.advanceTimersByTime(4_999);
			await Promise.resolve();
			expect(killSpy).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			await released;
			expect(killSpy).toHaveBeenCalledTimes(1);
			expect(killSpy.mock.calls[0]?.[0]).toBe(4242);
		} finally {
			killSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("does not attempt a force-kill when no process handle is available", async () => {
		vi.useFakeTimers();
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		try {
			const { handle } = makeHangingHeadlessHandle(undefined);
			const released = releaseBrowser(handle, { kill: false });
			vi.advanceTimersByTime(5_000);
			await released;
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
