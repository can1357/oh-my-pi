/**
 * Regression tests for the cross-session browser-tab name collision.
 *
 * The tab registry (`tabs` in tab-supervisor) is a module-global map keyed by
 * tab name alone, shared by every agent session in the process. Two concurrent
 * sessions calling `browser.open({ name })` with the same generic name
 * ("pages", "tab", …) would silently RE-DRIVE each other's live tab — the
 * second caller gets the first session's page, URL and state — or, via the
 * recycle branches (dialogs/allowedDomains/cmux mismatch), destroy it.
 * Ownership (`ownerSessionId`) was recorded at creation but never consulted on
 * the reuse path.
 *
 * The contract under test:
 *  - an alive tab owned by session A cannot be acquired by session B opening
 *    the same name: the open fails with an actionable ToolError pointing at
 *    `browser.tab()` (the deliberate-share path, which never acquires);
 *  - same-owner reuse is unchanged (returns the existing tab, created:false);
 *  - unowned tabs (SDK callers without a session id) stay reusable by anyone;
 *  - an owned tab stays reusable by an UNOWNED caller (back-compat).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

function fakeBrowser(): BrowserHandle {
	return {
		kind: { kind: "headless", headless: true, ignoreHttpsErrors: false, allowFileAccess: false },
		key: "headless:1::",
		refCount: 1,
	} as unknown as BrowserHandle;
}

function seedTab(name: string, browser: BrowserHandle, ownerSessionId: string | undefined): WorkerTabSession {
	const tab = {
		backend: "worker",
		name,
		browser,
		targetId: `target-${name}`,
		state: "alive",
		info: {},
		pending: new Map(),
		kindTag: "headless",
		ownerSessionId,
		lastActivityAt: Date.now(),
		frozen: false,
		worker: {},
		activateForScreenshot: false,
	} as unknown as WorkerTabSession;
	getTabsMapForTest().set(name, tab);
	return tab;
}

afterEach(() => {
	getTabsMapForTest().clear();
});

describe("browser tab cross-session collision guard", () => {
	it("rejects an open when the live tab is owned by another session", async () => {
		const browser = fakeBrowser();
		seedTab("pages", browser, "session-a");

		await expect(
			acquireTab("pages", browser, { ownerSessionId: "session-b", timeoutMs: 1000 }),
		).rejects.toThrow(/already open and owned by another session/);

		await expect(
			acquireTab("pages", browser, { ownerSessionId: "session-b", timeoutMs: 1000 }),
		).rejects.toThrow(/browser\.tab/);
	});

	it("reuses the tab for the SAME owner (unchanged behavior)", async () => {
		const browser = fakeBrowser();
		seedTab("pages", browser, "session-a");

		const result = await acquireTab("pages", browser, { ownerSessionId: "session-a", timeoutMs: 1000 });
		expect(result.created).toBe(false);
		expect(result.tab.name).toBe("pages");
	});

	it("reuses an UNOWNED tab for any owner (back-compat)", async () => {
		const browser = fakeBrowser();
		seedTab("pages", browser, undefined);

		const result = await acquireTab("pages", browser, { ownerSessionId: "session-b", timeoutMs: 1000 });
		expect(result.created).toBe(false);
	});

	it("reuses an owned tab for an UNOWNED caller (back-compat)", async () => {
		const browser = fakeBrowser();
		seedTab("pages", browser, "session-a");

		const result = await acquireTab("pages", browser, { timeoutMs: 1000 });
		expect(result.created).toBe(false);
	});

	it("does not clobber the existing tab's ownership on a rejected open", async () => {
		const browser = fakeBrowser();
		seedTab("pages", browser, "session-a");

		await expect(
			acquireTab("pages", browser, { ownerSessionId: "session-b", timeoutMs: 1000 }),
		).rejects.toThrow(/already open and owned by another session/);

		const tab = getTabsMapForTest().get("pages");
		expect(tab?.ownerSessionId).toBe("session-a");
		expect(tab?.state).toBe("alive");
	});
});
