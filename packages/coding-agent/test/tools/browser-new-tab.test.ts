import { describe, expect, it } from "bun:test";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const page = (label: string) => `data:text/html,<title>${label}</title><main>${label}</main>`;

function unique(prefix: string): string {
	return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Attaching to a browser we did not launch is the relay's shape: `kind:
 * "connected"` takes the same user-driven branch of the init payload that a
 * relay browser does, so a locally launched Chromium reached over CDP
 * exercises adoption and `newTab` without needing the extension.
 */
async function connectToOwnBrowser(owned: BrowserHandle): Promise<BrowserHandle> {
	if (!("browser" in owned)) throw new Error("Expected a Puppeteer browser");
	const wsEndpoint = owned.browser.wsEndpoint();
	const port = new URL(wsEndpoint).port;
	return await acquireBrowser({ kind: "connected", cdpUrl: `http://127.0.0.1:${port}` }, { cwd: process.cwd() });
}

async function connectAsRelay(owned: BrowserHandle): Promise<BrowserHandle> {
	if (!("browser" in owned)) throw new Error("Expected a Puppeteer browser");
	const wsEndpoint = owned.browser.wsEndpoint();
	const port = new URL(wsEndpoint).port;
	const connected = await acquireBrowser(
		{ kind: "connected", cdpUrl: `http://127.0.0.1:${port}` },
		{ cwd: process.cwd() },
	);
	return Object.assign(connected, {
		kind: { kind: "relay" as const, cdpUrl: `http://127.0.0.1:${port}` },
	});
}

describe("browser tabs in a browser we did not launch", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"opens its own tab for new_tab and leaves the user's tab alone, but adopts one otherwise",
		async () => {
			const userUrl = page("user-tab");
			const agentUrl = page("agent-tab");
			const adoptedUrl = page("adopted-tab");
			const newTabName = unique("own-tab");
			const adoptName = unique("adopted-tab");
			let owned: BrowserHandle | undefined;
			let connected: BrowserHandle | undefined;
			const openedTabs: string[] = [];
			try {
				owned = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
				holdBrowser(owned);
				connected = await connectAsRelay(owned);
				holdBrowser(connected);
				if (!("browser" in connected)) throw new Error("Expected a Puppeteer browser");
				const remote = connected.browser;

				// Stand in for the tab the user is working in.
				const userPages = await remote.pages();
				const userPage = userPages[0];
				if (!userPage) throw new Error("Expected the launch's initial page");
				await userPage.goto(userUrl, { waitUntil: "load" });
				expect((await remote.pages()).length).toBe(1);

				// `new_tab`: a tab of our own, and the user's is untouched.
				const created = await acquireTab(newTabName, connected, {
					url: agentUrl,
					newTab: true,
					timeoutMs: 30_000,
				});
				openedTabs.push(newTabName);
				if (created.tab.backend !== "worker") throw new Error("Expected a worker-backed tab");
				const afterCreate = await remote.pages();
				expect(afterCreate.map(p => p.url()).sort()).toEqual([agentUrl, userUrl].sort());
				expect(userPage.url()).toBe(userUrl);
				expect(created.tab.ownsPage).toBe(true);

				// Releasing an owned tab closes it; the user's tab survives.
				await releaseTab(newTabName, { kill: false });
				openedTabs.pop();
				expect((await remote.pages()).map(p => p.url())).toEqual([userUrl]);

				// Without `new_tab` the tab the user is in is adopted and navigated:
				// the behavior `new_tab` exists to avoid.
				const adopted = await acquireTab(adoptName, connected, { url: adoptedUrl, timeoutMs: 30_000 });
				openedTabs.push(adoptName);
				if (adopted.tab.backend !== "worker") throw new Error("Expected a worker-backed tab");
				expect(adopted.tab.ownsPage).toBe(false);
				expect((await remote.pages()).map(p => p.url())).toEqual([adoptedUrl]);

				// An adopted tab is the user's: releasing must not close it.
				await releaseTab(adoptName, { kill: false });
				openedTabs.pop();
				expect((await remote.pages()).map(p => p.url())).toEqual([adoptedUrl]);
			} finally {
				for (const name of openedTabs.reverse()) await releaseTab(name, { kill: false }).catch(() => undefined);
				if (connected) await releaseBrowser(connected, { kill: false }).catch(() => undefined);
				if (owned) await releaseBrowser(owned, { kill: true }).catch(() => undefined);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reopening an adopted session with new_tab: true produces an owned tab and does not navigate the adopted one",
		async () => {
			const userUrl = page("user-tab");
			const agentUrl = page("agent-tab");
			const sessionName = unique("adopted-then-owned");
			let owned: BrowserHandle | undefined;
			let relay: BrowserHandle | undefined;
			const openedTabs: string[] = [];
			try {
				owned = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
				holdBrowser(owned);
				relay = await connectAsRelay(owned);
				holdBrowser(relay);
				if (!("browser" in relay)) throw new Error("Expected a Puppeteer browser");
				const remote = relay.browser;

				const userPages = await remote.pages();
				const userPage = userPages[0];
				if (!userPage) throw new Error("Expected initial page");
				await userPage.goto(userUrl, { waitUntil: "load" });

				// 1. Adopt the user's tab without new_tab
				const adopted = await acquireTab(sessionName, relay, { timeoutMs: 30_000 });
				openedTabs.push(sessionName);
				if (adopted.tab.backend !== "worker") throw new Error("Expected a worker-backed tab");
				expect(adopted.tab.ownsPage).toBe(false);
				expect(userPage.url()).toBe(userUrl);

				// 2. Reopen the same session name with new_tab: true and a new URL
				const reopened = await acquireTab(sessionName, relay, {
					url: agentUrl,
					newTab: true,
					timeoutMs: 30_000,
				});
				if (reopened.tab.backend !== "worker") throw new Error("Expected a worker-backed tab");
				expect(reopened.tab.ownsPage).toBe(true);
				// User's tab was NOT navigated!
				expect(userPage.url()).toBe(userUrl);
				const pages = await remote.pages();
				expect(pages.map(p => p.url()).sort()).toEqual([agentUrl, userUrl].sort());

				// 3. Releasing the owned session closes the owned tab; user's tab survives
				await releaseTab(sessionName, { kill: false });
				openedTabs.pop();
				expect((await remote.pages()).map(p => p.url())).toEqual([userUrl]);
			} finally {
				for (const name of openedTabs.reverse()) await releaseTab(name, { kill: false }).catch(() => undefined);
				if (relay) await releaseBrowser(relay, { kill: false }).catch(() => undefined);
				if (owned) await releaseBrowser(owned, { kill: true }).catch(() => undefined);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"cleans up supervisor-created target when worker initialization or navigation fails",
		async () => {
			const userUrl = page("user-tab");
			const failName = unique("failing-tab");
			let owned: BrowserHandle | undefined;
			let relay: BrowserHandle | undefined;
			try {
				owned = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
				holdBrowser(owned);
				relay = await connectAsRelay(owned);
				holdBrowser(relay);
				if (!("browser" in relay)) throw new Error("Expected a Puppeteer browser");
				const remote = relay.browser;

				const userPages = await remote.pages();
				const userPage = userPages[0];
				if (!userPage) throw new Error("Expected initial page");
				await userPage.goto(userUrl, { waitUntil: "load" });
				expect((await remote.pages()).length).toBe(1);

				// Force navigation failure during new_tab initialization
				await expect(
					acquireTab(failName, relay, {
						url: "http://127.0.0.1:1/nonexistent",
						newTab: true,
						timeoutMs: 2_000,
					}),
				).rejects.toThrow();

				// The supervisor-created target MUST be closed, leaving only the original tab
				const afterPages = await remote.pages();
				expect(afterPages.length).toBe(1);
				expect(afterPages[0]?.url()).toBe(userUrl);
			} finally {
				await releaseTab(failName, { kill: false }).catch(() => undefined);
				if (relay) await releaseBrowser(relay, { kill: false }).catch(() => undefined);
				if (owned) await releaseBrowser(owned, { kill: true }).catch(() => undefined);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"rejects new_tab on direct CDP connected sessions",
		async () => {
			let owned: BrowserHandle | undefined;
			let connected: BrowserHandle | undefined;
			try {
				owned = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
				holdBrowser(owned);
				connected = await connectToOwnBrowser(owned);
				holdBrowser(connected);

				await expect(
					acquireTab(unique("cdp-tab"), connected, {
						url: page("agent-tab"),
						newTab: true,
						timeoutMs: 5_000,
					}),
				).rejects.toThrow("new_tab: true is only supported for browser relay sessions (app.relay: true)");
			} finally {
				if (connected) await releaseBrowser(connected, { kill: false }).catch(() => undefined);
				if (owned) await releaseBrowser(owned, { kill: true }).catch(() => undefined);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"surfaces page close error when tab release fails",
		async () => {
			const sessionName = unique("failing-close");
			let owned: BrowserHandle | undefined;
			let relay: BrowserHandle | undefined;
			try {
				owned = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
				holdBrowser(owned);
				relay = await connectAsRelay(owned);
				holdBrowser(relay);
				if (!relay || !("browser" in relay)) throw new Error("Expected a Puppeteer browser");

				const created = await acquireTab(sessionName, relay, {
					url: page("close-fail"),
					newTab: true,
					timeoutMs: 30_000,
				});
				if (created.tab.backend !== "worker") throw new Error("Expected a worker-backed tab");
				expect(created.tab.ownsPage).toBe(true);

				// Override page.close on the worker's page to simulate a close failure
				await runInTab(sessionName, {
					code: "page.close = async () => { throw new Error('simulated close failure'); };",
					timeoutMs: 5_000,
					session: {
						cwd: process.cwd(),
						hasUI: false,
						settings: { get: () => undefined },
					} as unknown as ToolSession,
				});

				// Break CDP closeTarget on the browser handle so supervisor fallback also fails:
				const remote = relay.browser;
				const originalTarget = remote.target.bind(remote);
				remote.target = () => {
					throw new Error("simulated CDP target session failure");
				};
				try {
					await expect(releaseTab(sessionName, { kill: false })).rejects.toThrow();
				} finally {
					remote.target = originalTarget;
				}
			} finally {
				await releaseTab(sessionName, { kill: false }).catch(() => undefined);
				if (relay) await releaseBrowser(relay, { kill: false }).catch(() => undefined);
				if (owned) await releaseBrowser(owned, { kill: true }).catch(() => undefined);
			}
		},
		60_000,
	);
});
