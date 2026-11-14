/**
 * Regression test for issue #7900: `web_search` grows the Chromium process
 * tree by one full browser per call.
 *
 * `releaseBrowser` evicted the handle from the module-global `browsers` map on
 * every transition to refCount 0. For the shared-daemon headless kind,
 * `disposeBrowserHandle` deliberately only drops this process's CDP link (the
 * broker owns the Chromium), so eviction threw away a live, reusable
 * attachment: the next `acquireBrowser` found an empty pool and re-attached,
 * while the renderer tree behind the previous attachment was never reclaimed.
 *
 * The pool must retain a *live* broker-owned attachment at refCount 0, and
 * must still tear down when the caller asks to kill, when the attachment is
 * already disconnected, or for any non-broker browser kind.
 *
 * Handles are hand-built and seeded directly into the registry map (same
 * approach as browser-dispose-timeout.test.ts) so no real broker, socket, or
 * Chromium is needed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	type BrowserHandle,
	getBrowsersMapForTest,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

interface Probe {
	handle: BrowserHandle;
	disconnectCalls: () => number;
	closeCalls: () => number;
}

/** Headless handle attached to the project-shared broker Chromium. */
function makeSharedHeadlessHandle(opts?: { connected?: boolean }): Probe {
	let disconnectCalls = 0;
	let closeCalls = 0;
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 1,
		sharedDaemon: { name: "omp.browser.headless", projectDir: "/tmp/omp-7900" },
		browser: {
			connected: opts?.connected ?? true,
			process: () => null,
			disconnect: () => {
				disconnectCalls++;
			},
			close: async () => {
				closeCalls++;
			},
		},
		stealth: { browserSession: null, override: null },
	} as unknown as BrowserHandle;
	return { handle, disconnectCalls: () => disconnectCalls, closeCalls: () => closeCalls };
}

/** Process-local headless launch (no broker) — OMP owns this Chromium. */
function makeProcessLocalHeadlessHandle(): Probe {
	let disconnectCalls = 0;
	let closeCalls = 0;
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 1,
		browser: {
			connected: true,
			process: () => null,
			disconnect: () => {
				disconnectCalls++;
			},
			close: async () => {
				closeCalls++;
			},
		},
		stealth: { browserSession: null, override: null },
	} as unknown as BrowserHandle;
	return { handle, disconnectCalls: () => disconnectCalls, closeCalls: () => closeCalls };
}

function registry(): Map<string, BrowserHandle> {
	return getBrowsersMapForTest() as Map<string, BrowserHandle>;
}

function publish(handle: BrowserHandle): void {
	registry().set(handle.key, handle);
}

describe("browser registry — broker-owned headless attachments stay pooled (issue #7900)", () => {
	afterEach(() => {
		registry().clear();
	});

	it("retains a live shared-daemon handle in the pool at refCount 0", async () => {
		const { handle, disconnectCalls, closeCalls } = makeSharedHeadlessHandle();
		publish(handle);

		await releaseBrowser(handle, { kill: false });

		expect(handle.refCount).toBe(0);
		// The whole point: the next acquireBrowser("headless:1") must find this
		// attachment and reuse the broker's Chromium instead of re-attaching.
		expect(registry().get("headless:1")).toBe(handle);
		// Dropping the CDP link is what stranded the previous renderer tree.
		expect(disconnectCalls()).toBe(0);
		expect(closeCalls()).toBe(0);
	});

	it("reuses the pooled attachment across repeated acquire/release cycles", async () => {
		const { handle, disconnectCalls } = makeSharedHeadlessHandle();
		publish(handle);

		// Ten `web_search` calls in a row: hold + release against the same handle.
		for (let i = 0; i < 10; i++) {
			handle.refCount++;
			await releaseBrowser(handle, { kill: false });
		}

		expect(registry().size).toBe(1);
		expect(registry().get("headless:1")).toBe(handle);
		expect(disconnectCalls()).toBe(0);
	});

	it("disposes a shared-daemon handle whose attachment is already dead", async () => {
		const { handle } = makeSharedHeadlessHandle({ connected: false });
		publish(handle);

		await releaseBrowser(handle, { kill: false });

		// A dead attachment is worthless to the next acquisition; it must not
		// be handed out, so it is evicted as before.
		expect(registry().has("headless:1")).toBe(false);
	});

	it("still tears down a shared-daemon handle on an explicit kill", async () => {
		const { handle, disconnectCalls } = makeSharedHeadlessHandle();
		publish(handle);

		await releaseBrowser(handle, { kill: true });

		expect(registry().has("headless:1")).toBe(false);
		expect(disconnectCalls()).toBe(1);
	});

	it("leaves process-local headless teardown unchanged (guards issue #5260)", async () => {
		const { handle, closeCalls } = makeProcessLocalHeadlessHandle();
		publish(handle);

		await releaseBrowser(handle, { kill: false });

		// No broker owns this Chromium — OMP must still close it and evict.
		expect(registry().has("headless:1")).toBe(false);
		expect(closeCalls()).toBe(1);
	});
});
