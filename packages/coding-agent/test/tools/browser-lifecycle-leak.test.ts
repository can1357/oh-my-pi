/**
 * Regression tests for issue #3963: the browser tool leaks Chromium/Puppeteer
 * resources at two termination boundaries.
 *
 * 1. An aborted `open` observes abort only in its `untilAborted` wrapper — the
 *    inner launch resolves in the background and `acquireBrowser` publishes
 *    the handle unconditionally, leaving a live browser at refCount:0 with no
 *    tab holding it. `releaseAllTabs` walks tabs, not browsers, so nothing
 *    ever reaps it.
 * 2. Browser + tab state lives in module-global maps. `AgentSession.dispose()`
 *    walks jobs, eval kernels, provider sessions, and MCP, but has no browser
 *    teardown hook, so any tabs the session opened outlive the session.
 *
 * The tests below cover both by driving `acquireBrowser` / `acquireTab` /
 * `releaseTabsForOwner` directly, with `CmuxSocketClient` prototype methods
 * spied so no real cmux socket / puppeteer process is needed.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser, getBrowsersMapForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

async function drainAllTabs(): Promise<void> {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser lifecycle — aborted open must not leak a browser handle", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a cmux browser whose launch resolved after the caller aborted", async () => {
		const gate = Promise.withResolvers<void>();
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		try {
			const kind = makeKind("abort-orphan");
			const controller = new AbortController();
			const pending = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
			// The reporter's scenario: abort fires while the launch is in flight.
			controller.abort();
			// The launch resolves *after* the abort has been observed by the caller.
			gate.resolve();

			await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The freshly-launched browser MUST be torn down before publication so it
			// does not sit at refCount:0 in the global map, leaking a live cmux socket
			// (or, for headless, a live Chromium process) that no `releaseAllTabs`
			// / `dropHeadlessTabs` walk would ever reap.
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("does not launch at all when the signal was already aborted", async () => {
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		try {
			const kind = makeKind("preaborted");
			const controller = new AbortController();
			controller.abort();
			await expect(acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			// Not called: pre-abort short-circuit fires before openBrowserHandle.
			expect(connectSpy).not.toHaveBeenCalled();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — session-scoped teardown reaps owned tabs", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("acquireTab records ownerSessionId and releaseTabsForOwner tears down only that session's tabs", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openCount++;
					return { surface_id: `surface-${openCount}`, url: "about:blank" };
				}
				if (method === "browser.wait") return {};
				if (method === "surface.close") return {};
				if (method === "browser.snapshot" || method === "browser.geometry") return {};
				if (method === "browser.eval") return {};
				return {};
			},
		);

		const kindA = makeKind("owner-a");
		const kindB = makeKind("owner-b");
		const browserA = await acquireBrowser(kindA, { cwd: "/tmp" });
		const browserB = await acquireBrowser(kindB, { cwd: "/tmp" });

		const tabA = await acquireTab("tab-a", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const tabB = await acquireTab("tab-b", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(tabA.tab.ownerSessionId).toBe("session-A");
		expect(tabB.tab.ownerSessionId).toBe("session-B");
		expect(getTabsMapForTest().size).toBe(2);

		// Dispose only session A. Session B's tab (and its browser) must survive
		// because a shared long-lived process may still be running under B.
		const released = await releaseTabsForOwner("session-A", { kill: false });
		expect(released).toBe(1);
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().has("tab-b")).toBe(true);

		await releaseTabsForOwner("session-B", { kill: false });
		expect(getTabsMapForTest().size).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("acquireTab reusing an existing tab preserves the original owner", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-reuse", url: "about:blank" };
				return {};
			},
		);

		const kind = makeKind("reuse");
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });

		const first = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const second = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(first.tab).toBe(second.tab);
		expect(second.created).toBe(false);
		// Reuse must NOT reassign ownership — a subagent re-driving an existing
		// tab shouldn't yank teardown responsibility from the session that opened it.
		expect(second.tab.ownerSessionId).toBe("session-A");

		// releaseTabsForOwner("session-B") is a no-op here — the tab belongs to A.
		const releasedB = await releaseTabsForOwner("session-B", { kill: false });
		expect(releasedB).toBe(0);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(true);

		const releasedA = await releaseTabsForOwner("session-A", { kill: false });
		expect(releasedA).toBe(1);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(false);
	});
});

describe("browser lifecycle — close deadlines", () => {
	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await drainAllTabs();
	});

	it("rejects a stuck close with the backend, tab, and pending resource", async () => {
		vi.useFakeTimers();
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const stuck = Promise.withResolvers<Record<string, unknown>>();
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async method => {
			if (method === "browser.open_split") return { surface_id: "probe-surface", url: "about:blank" };
			if (method === "surface.close") return await stuck.promise;
			return {};
		});

		const kind: CmuxKind = { kind: "cmux", socketPath: "/tmp/omp-close-deadline.sock" };
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });
		await acquireTab("probe", browser, { timeoutMs: 1_000 });

		const close = releaseTab("probe", { timeoutMs: 100 });
		vi.advanceTimersByTime(100);

		await expect(close).rejects.toThrow(
			'Timed out after 100ms closing cmux browser tab "probe"; pending resource: cmux surface "probe-surface" (surface.close)',
		);
		expect(getTabsMapForTest().has("probe")).toBe(false);
		expect(getBrowsersMapForTest().size).toBe(0);
	});
});
