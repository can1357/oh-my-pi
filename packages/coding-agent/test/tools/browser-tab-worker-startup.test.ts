import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";

// Browser globals read inside page.evaluate callbacks; absent from bun-types.
declare const devicePixelRatio: number;
declare const window: { open(url: string, target: string, features: string): unknown };

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	freezeTabsForOwner,
	getTab,
	initializeTabWorkerForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { CDPSession } from "puppeteer-core";
import { chromiumAvailable, visibleBrowserAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// Headful launches additionally need a display; `CHROMIUM_AVAILABLE` only
// checks headless CDP on Linux, which does not require an X server.
// Never open a desktop window during ordinary test runs; exercise this manual
// viewport smoke test only with OMP_TEST_VISIBLE_BROWSER=1.
const VISIBLE_BROWSER_AVAILABLE = process.env.OMP_TEST_VISIBLE_BROWSER === "1" && (await visibleBrowserAvailable());

// One headless Chromium for the file, held for its whole run: every test opens and closes its own tabs, and none
// changes the browser in a way another test reads.
let sharedHeadless: PuppeteerBrowserHandle | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
	holdBrowser(launched);
	sharedHeadless = launched;
});

afterAll(async () => {
	if (sharedHeadless) await releaseBrowser(sharedHeadless, { kill: true });
});

function headless(): PuppeteerBrowserHandle {
	if (!sharedHeadless?.browser.connected) throw new Error("Expected the shared headless browser");
	return sharedHeadless;
}

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	readonly sent: WorkerInbound[] = [];
	readonly mode = "worker" as const;

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	onExit(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {}

	emitReady(info: ReadyInfo): void {
		for (const handler of this.#messageHandlers) handler({ type: "ready", info });
	}
	emitSetup(): void {
		for (const handler of this.#messageHandlers) handler({ type: "setup" });
	}

	emitInitFailed(error: { name: string; message: string; isToolError: boolean; isAbort: boolean }): void {
		for (const handler of this.#messageHandlers) handler({ type: "init-failed", error });
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/omp-puppeteer",
	uploadDir: "/tmp/omp-uploads-test",
};

describe("browser tab worker startup", () => {
	it("surfaces worker startup errors instead of waiting for the generic init timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("Cannot find tab-worker-entry.ts"));

		await expect(pending).rejects.toThrow("Tab worker failed during startup: Cannot find tab-worker-entry.ts");
		expect(worker.sent).toEqual([{ type: "init", payload: initPayload }]);
	});

	it("resolves with ready info when the worker sends setup before ready", async () => {
		const worker = new FakeStartupWorker();
		const info: ReadyInfo = {
			url: "about:blank",
			title: "Test",
			viewport: { width: 1280, height: 720 },
			targetId: "target-1",
		};
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitSetup();
		// The inline transport delivers messages on microtasks, so `ready` can
		// land in the same tick as `setup`; the single listener spanning both
		// phases must resolve it instead of dropping it.
		worker.emitReady(info);

		await expect(pending).resolves.toEqual(info);
	});

	it("surfaces a reported init failure that arrives after setup", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 3_000);

		worker.emitSetup();
		// A fast `init-failed` that lands right behind `setup` — a `page.goto`
		// rejection without a macrotask boundary — must surface the real
		// failure instead of the generic init timeout.
		worker.emitInitFailed({ name: "Error", message: "connect failed", isToolError: false, isAbort: false });

		await expect(pending).rejects.toThrow("connect failed");
	});
});

describe("OMP-owned browser evaluation", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"adopts isolated element arguments into the main world without consuming caller handles",
		async () => {
			const browser = headless();
			const name = `handle-evaluate-${process.pid}`;
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
			} as unknown as ToolSession;
			try {
				await acquireTab(name, browser, {
					url: `data:text/html,${encodeURIComponent('<button id="first">First</button><button id="second">Second</button>')}`,
					timeoutMs: 30_000,
				});
				const result = await runInTab(name, {
					code: `
						await tab.evaluate("globalThis.__ompPageMarker = 'main-world'");
						const first = await tab.waitForSelector("#first");
						const second = await tab.waitForSelector("#second");
						if (!first || !second) throw new Error("Expected both buttons");

						const mainElement = await page.evaluateHandle(() => {
							//!world=main
							return document.querySelector("#first");
						});
						const mainObject = await page.evaluateHandle(() => {
							//!world=main
							return { value: 9 };
						});
						const plain = { asElement: "ordinary-data", nested: { value: 4 } };

						const evaluated = await tab.evaluate(
							(firstElement, secondElement, existingMainElement, existingMainObject, data) => ({
								marker: globalThis.__ompPageMarker,
								texts: [firstElement.textContent, secondElement.textContent],
								mainText: existingMainElement.textContent,
								mainValue: existingMainObject.value,
								plain: data,
							}),
							first,
							second,
							mainElement,
							mainObject,
							plain,
						);

						let callbackFailure = "";
						try {
							await tab.evaluate(() => {
								throw new Error("expected callback failure");
							}, first, second);
						} catch (error) {
							callbackFailure = error instanceof Error ? error.message : String(error);
						}

						const stringMarker = await tab.evaluate("globalThis.__ompPageMarker", first, second);
						const handlesAfterward = [
							await first.evaluate(element => element.textContent),
							await second.evaluate(element => element.textContent),
							await mainElement.evaluate(element => element.textContent),
							await mainObject.evaluate(object => object.value),
						];
						await Promise.all([first.dispose(), second.dispose(), mainElement.dispose(), mainObject.dispose()]);
						return { evaluated, callbackFailure, stringMarker, handlesAfterward };
					`,
					timeoutMs: 15_000,
					session,
				});
				expect(result.returnValue).toEqual({
					evaluated: {
						marker: "main-world",
						texts: ["First", "Second"],
						mainText: "First",
						mainValue: 9,
						plain: { asElement: "ordinary-data", nested: { value: 4 } },
					},
					callbackFailure: expect.stringContaining("expected callback failure"),
					stringMarker: "main-world",
					handlesAfterward: ["First", "Second", "First", 9],
				});
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"tells a caller running calls on one tab together to await each one or use one run",
		async () => {
			const browser = headless();
			const name = `parallel-calls-${process.pid}`;
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
			} as unknown as ToolSession;
			try {
				await acquireTab(name, browser, { url: `data:text/html,<title>${name}</title>`, timeoutMs: 30_000 });
				const results = await Promise.allSettled([
					runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session }),
					runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session }),
				]);
				expect(results[0]?.status).toBe("fulfilled");
				const refused = String(results[1]?.status === "rejected" ? results[1].reason : "");
				expect(refused).toContain("is busy");
				expect(refused).toContain("Await each call before starting the next");
				expect(refused).toContain("tab.run(");
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
});

describe("OMP-owned browser input", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"clicks background tabs through selector, observed handle, and raw Puppeteer actions",
		async () => {
			const browser = headless();
			const name = `background-input-${process.pid}`;
			const session = {
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
			} as unknown as ToolSession;
			try {
				await acquireTab(name, browser, {
					url: `data:text/html,${encodeURIComponent("<button onclick=\"document.querySelector('output').textContent++\">Increment</button><output>0</output>")}`,
					timeoutMs: 30_000,
				});
				const foreground = await browser.browser.newPage();
				try {
					await foreground.bringToFront();
					const result = await runInTab(name, {
						code: `
							await tab.click("button");
							const observation = await tab.observe();
							await (await tab.id(observation.elements[0].id)).click();
							await page.click("button");
							return await page.$eval("output", element => element.textContent);
						`,
						timeoutMs: 15_000,
						session,
					});
					expect(result.returnValue).toBe("3");
				} finally {
					await foreground.close();
				}
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
});

describe("visible OMP-owned browser tabs", () => {
	it.skipIf(!VISIBLE_BROWSER_AVAILABLE)(
		"creates independent pages without pinning the resizable window viewport",
		async () => {
			let browser: BrowserHandle | undefined;
			const names: string[] = [];
			try {
				browser = await acquireBrowser({ kind: "headless", headless: false }, { cwd: process.cwd() });
				if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");

				const firstName = `visible-owned-a-${process.pid}-${Math.random().toString(36).slice(2)}`;
				const firstUrl = `data:text/html,<title>${firstName}</title><main>first</main>`;
				const first = await acquireTab(firstName, browser, { url: firstUrl, timeoutMs: 30_000 });
				names.push(firstName);

				// Shared broker launches use --no-startup-window. Mirror that
				// OMP-owned-only target set, but only after the owned page exists:
				// a headful Chromium quits when its last window closes, so closing
				// every page first would kill the browser this test still needs.
				for (const page of await browser.browser.pages()) {
					if (page.url() !== firstUrl) await page.close();
				}
				const remaining = await browser.browser.pages();
				expect(remaining.map(page => page.url())).toEqual([firstUrl]);
				const firstPage = remaining[0];
				if (!firstPage) throw new Error("Expected the first managed page");

				const before = await firstPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
				const client = await firstPage.createCDPSession();
				const { windowId } = await client.send("Browser.getWindowForTarget");
				await client.send("Browser.setWindowBounds", { windowId, bounds: { width: 1700, height: 1000 } });
				const after = await firstPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
				expect(after.width).toBeGreaterThan(before.width + 100);
				expect(after.height).toBeGreaterThan(before.height + 100);

				const secondName = `visible-owned-b-${process.pid}-${Math.random().toString(36).slice(2)}`;
				const secondUrl = `data:text/html,<title>${secondName}</title><main>second</main>`;
				const second = await acquireTab(secondName, browser, { url: secondUrl, timeoutMs: 30_000 });
				names.push(secondName);
				expect(second.tab.targetId).not.toBe(first.tab.targetId);
				expect(firstPage.url()).toBe(firstUrl);
			} finally {
				for (const name of names.reverse()) await releaseTab(name, { kill: true });
				if (browser && "browser" in browser && browser.browser.connected) {
					await releaseBrowser(browser, { kill: true });
				}
			}
		},
		45_000,
	);
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps deterministic viewport emulation for hidden launches",
		async () => {
			const browser = headless();
			const name = `hidden-viewport-${process.pid}-${Math.random().toString(36).slice(2)}`;
			try {
				const url = `data:text/html,<title>${name}</title><main>hidden</main>`;
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const page = (await browser.browser.pages()).find(candidate => candidate.url() === url);
				if (!page) throw new Error("Expected the managed hidden page");
				expect(
					await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
				).toEqual({ width: 1365, height: 768, dpr: 1.25 });
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
});

describe("browser tabs whose renderer crashed", () => {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;

	/** Watch the page at `url` over a CDP session of the test's own; `crashed` resolves once Chromium reports its renderer died. */
	async function watchRenderer(
		browser: PuppeteerBrowserHandle,
		url: string,
	): Promise<{ client: CDPSession; crashed: Promise<void> }> {
		const target = await browser.browser.waitForTarget(candidate => candidate.url() === url, { timeout: 5_000 });
		const client = await target.createCDPSession();
		const crashed = Promise.withResolvers<void>();
		client.once("Inspector.targetCrashed", () => crashed.resolve());
		await client.send("Inspector.enable");
		return { client, crashed: crashed.promise };
	}

	/** Kill the page's renderer; resolves once Chromium reports the crash. */
	async function crashRenderer(browser: PuppeteerBrowserHandle, url: string): Promise<void> {
		const { client, crashed } = await watchRenderer(browser, url);
		// Page.crash never answers: the renderer it would answer from is gone.
		void client.send("Page.crash").catch(() => undefined);
		await crashed;
	}

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails a call on a tab whose renderer crashed while idle at once, with the page reloaded for the next",
		async () => {
			const browser = headless();
			const name = `crashed-idle-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				await crashRenderer(browser, url);
				const failure = await runInTab(name, {
					code: "return await page.title();",
					timeoutMs: 10_000,
					session,
				}).catch((error: unknown) => error);
				expect(String(failure)).toContain("Browser tab's renderer");
				expect(String(failure)).toContain("its page reloaded");
				const next = await runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session });
				expect(next.returnValue).toBe(name);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails the call in flight when the renderer crashes under it",
		async () => {
			const browser = headless();
			const name = `crashed-in-flight-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const stalled = runInTab(name, {
					code: "return await page.evaluate(() => new Promise(() => {}));",
					timeoutMs: 10_000,
					session,
				}).catch((error: unknown) => error);
				await crashRenderer(browser, url);
				const failure = String(await stalled);
				expect(failure).toContain("Browser tab's renderer crashed during this run");
				expect(failure).toContain("its page reloaded");
				const next = await runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session });
				expect(next.returnValue).toBe(name);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a crashed tab busy while the failing call reloads it",
		async () => {
			const browser = headless();
			const name = `crashed-busy-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				await crashRenderer(browser, url);
				const crashedWorker = tab.worker;
				const terminate = crashedWorker.terminate.bind(crashedWorker);
				const recycling = Promise.withResolvers<void>();
				const resume = Promise.withResolvers<void>();
				// The recycle terminates the crashed page's worker before starting a new one: hold it there.
				const terminateSpy = spyOn(crashedWorker, "terminate").mockImplementation(async () => {
					await terminate();
					recycling.resolve();
					await resume.promise;
				});
				try {
					const failure = runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
						(error: unknown) => error,
					);
					await recycling.promise;
					const sibling = await runInTab(name, { code: "return 2;", timeoutMs: 10_000, session }).catch(
						(error: unknown) => error,
					);
					expect(String(sibling)).toContain("is busy");
					resume.resolve();
					expect(String(await failure)).toContain("its page reloaded");
				} finally {
					resume.resolve();
					terminateSpy.mockRestore();
				}
				const next = await runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session });
				expect(next.returnValue).toBe(name);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"closes a tab whose page crashes again as it reloads",
		async () => {
			const browser = headless();
			const name = `crashed-on-load-${process.pid}`;
			try {
				const url = `data:text/html,<title>${name}</title>`;
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const { client } = await watchRenderer(browser, url);
				// chrome://crash kills the renderer on every load, so reattaching cannot bring the page back. The call
				// fails the same way whether the crash lands under it or just before it.
				const failure = runInTab(name, { code: "await wait(5_000);", timeoutMs: 10_000, session }).catch(
					(error: unknown) => error,
				);
				void client.send("Page.navigate", { url: "chrome://crash" }).catch(() => undefined);
				expect(String(await failure)).toContain("the tab could not be reattached and was closed");
				expect(getTab(name)).toBeUndefined();
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"answers a run whose page crashes as its result is put together",
		async () => {
			const browser = headless();
			const name = `crashed-late-${process.pid}`;
			try {
				await acquireTab(name, browser, { url: `data:text/html,<title>${name}</title>`, timeoutMs: 30_000 });
				// The run returns while its navigation is still under way; the crash lands while the worker reads the
				// page's title for the result, or after the result went out, when the next call meets it.
				const first = await runInTab(name, {
					code: 'void page.goto("chrome://crash").catch(() => undefined);',
					timeoutMs: 10_000,
					session,
				}).catch((error: unknown) => error);
				const outcome = getTab(name)
					? await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
							(error: unknown) => error,
						)
					: first;
				expect(String(outcome)).toContain("the tab could not be reattached and was closed");
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"brings back a settle-frozen tab whose renderer crashed",
		async () => {
			const browser = headless();
			const name = `crashed-frozen-${process.pid}`;
			const owner = `crashed-frozen-owner-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000, ownerSessionId: owner });
				expect(await freezeTabsForOwner(owner)).toBe(1);
				await crashRenderer(browser, url);
				const failure = await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
					(error: unknown) => error,
				);
				expect(String(failure)).toContain("its page reloaded");
				const result = await runInTab(name, {
					code: "await page.evaluate(() => new Promise(requestAnimationFrame)); return await page.title();",
					timeoutMs: 10_000,
					session,
				});
				expect(result.returnValue).toBe(name);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reports the reload when an open navigates a tab whose renderer crashed",
		async () => {
			const browser = headless();
			const name = `crashed-reopen-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				await crashRenderer(browser, url);
				const reopened = await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				expect(reopened.created).toBe(false);
				expect(reopened.note).toContain("This tab's renderer had crashed");
				expect(reopened.tab.info.title).toBe(name);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"leaves a tab closed while its crashed page is being reattached closed",
		async () => {
			const launched = headless();
			const name = `crashed-closed-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			const userPage = await launched.browser.newPage();
			try {
				await userPage.goto(url);
				// A connected tab: closing it leaves the page there for a reattach to find.
				const connected = await acquireBrowser(
					{ kind: "connected", cdpUrl: `http://${new URL(launched.browser.wsEndpoint()).host}` },
					{ cwd: process.cwd() },
				);
				await acquireTab(name, connected, { target: url, timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				await crashRenderer(launched, url);
				const crashedWorker = tab.worker;
				const terminate = crashedWorker.terminate.bind(crashedWorker);
				let released: Promise<boolean> | undefined;
				// The reattach terminates the crashed page's worker before starting a new one: close the tab right then.
				const terminateSpy = spyOn(crashedWorker, "terminate").mockImplementation(async () => {
					await terminate();
					released ??= releaseTab(name, { kill: false });
				});
				try {
					const outcome = await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
						(error: unknown) => error,
					);
					await released;
					expect(String(outcome)).toContain("was closed");
					expect(tab.state).toBe("dead");
					expect(tab.worker).toBe(crashedWorker);
				} finally {
					terminateSpy.mockRestore();
				}
			} finally {
				await releaseTab(name, { kill: false });
				await userPage.close().catch(() => undefined);
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"leaves a tab reopened under the same name alone when the closed one's reattach fails",
		async () => {
			const browser = headless();
			const name = `crashed-reopened-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				await crashRenderer(browser, url);
				const crashedWorker = tab.worker;
				const terminate = crashedWorker.terminate.bind(crashedWorker);
				let reopening = false;
				// The reattach terminates the crashed page's worker first: close the tab (its page goes with it) and open
				// a new one under the same name right then, so the reattach finds no page. The close terminates it again.
				const terminateSpy = spyOn(crashedWorker, "terminate").mockImplementation(async () => {
					await terminate();
					if (reopening) return;
					reopening = true;
					await releaseTab(name, { kill: true });
					await acquireTab(name, browser, { url: `data:text/html,<title>${name}-new</title>`, timeoutMs: 30_000 });
				});
				try {
					const outcome = await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
						(error: unknown) => error,
					);
					expect(String(outcome)).toContain("was closed");
				} finally {
					terminateSpy.mockRestore();
				}
				const replacement = getTab(name);
				expect(replacement).not.toBe(tab);
				expect(replacement?.state).toBe("alive");
				const next = await runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session });
				expect(next.returnValue).toBe(`${name}-new`);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reattaches to a page Puppeteer has not listed yet because its URL is still empty",
		async () => {
			const loadGate = Promise.withResolvers<void>();
			const server = Bun.serve({
				port: 0,
				fetch: async () => {
					await loadGate.promise;
					return new Response("<title>late-commit</title>", { headers: { "content-type": "text/html" } });
				},
			});
			const browser = headless();
			const name = `crashed-unlisted-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			const opener = await browser.browser.newPage();
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				// A crashed page revived by the reattach reports an empty URL for a moment, and Puppeteer lists no
				// page until its URL is set. A popup whose first load has not committed stays in that state on demand,
				// so the reattach here is pointed at one.
				const watcher = await browser.browser.target().createCDPSession();
				await watcher.send("Target.setDiscoverTargets", { discover: true });
				const popupCreated = Promise.withResolvers<string>();
				watcher.on("Target.targetCreated", event => {
					if (event.targetInfo.type === "page" && event.targetInfo.url === "")
						popupCreated.resolve(event.targetInfo.targetId);
				});
				await opener.evaluate(
					popupUrl => void window.open(popupUrl, "_blank", "noopener"),
					`http://127.0.0.1:${server.port}/popup`,
				);
				const popupId = await popupCreated.promise;
				await watcher.detach();
				await crashRenderer(browser, url);
				tab.targetId = popupId;
				// Commit the popup's load only after the new worker has looked the target up. The worker lists
				// Puppeteer's targets in the same turn it reports `setup`, so that report releases the load.
				const RealWorker = globalThis.Worker;
				globalThis.Worker = class SetupReportingWorker extends RealWorker {
					constructor(...args: ConstructorParameters<typeof Worker>) {
						super(...args);
						this.addEventListener("message", event => {
							if ((event.data as WorkerOutbound).type === "setup") loadGate.resolve();
						});
					}
				};
				let failure: unknown;
				try {
					failure = await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
						(error: unknown) => error,
					);
				} finally {
					globalThis.Worker = RealWorker;
				}
				expect(String(failure)).toContain("its page reloaded");
				// The worker that looked the page up adopted it; an inline fallback would retry after the load committed.
				expect(getTab(name)).toMatchObject({ worker: { mode: "worker" } });
				const next = await runInTab(name, { code: "return await page.title();", timeoutMs: 10_000, session });
				expect(next.returnValue).toBe("late-commit");
			} finally {
				await releaseTab(name, { kill: true });
				await opener.close().catch(() => undefined);
				server.stop(true);
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"closes a reattached headless tab's page when the tab is released",
		async () => {
			const browser = headless();
			const name = `crashed-released-${process.pid}`;
			const url = `data:text/html,<title>${name}</title>`;
			try {
				await acquireTab(name, browser, { url, timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				const targetId = tab.targetId;
				await crashRenderer(browser, url);
				const failure = await runInTab(name, { code: "return 1;", timeoutMs: 10_000, session }).catch(
					(error: unknown) => error,
				);
				expect(String(failure)).toContain("its page reloaded");
				await releaseTab(name, { kill: false });
				const watcher = await browser.browser.target().createCDPSession();
				const { targetInfos } = await watcher.send("Target.getTargets");
				await watcher.detach();
				expect(targetInfos.map(info => info.targetId)).not.toContain(targetId);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
});

describe("closing an OMP-owned page", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"closes the page by id when its worker reports closed without closing it",
		async () => {
			const browser = headless();
			const name = `unconfirmed-close-${process.pid}`;
			try {
				await acquireTab(name, browser, { timeoutMs: 30_000 });
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				const targetId = tab.targetId;
				// A worker whose page close failed (its CDP socket broke) still answers `closed`.
				const handlers = new Set<(msg: WorkerOutbound) => void>();
				const subscribe = tab.worker.onMessage.bind(tab.worker);
				spyOn(tab.worker, "onMessage").mockImplementation(handler => {
					handlers.add(handler);
					const unsubscribe = subscribe(handler);
					return () => {
						handlers.delete(handler);
						unsubscribe();
					};
				});
				const send = tab.worker.send.bind(tab.worker);
				spyOn(tab.worker, "send").mockImplementation((msg, transfer) => {
					if (msg.type !== "close") return send(msg, transfer);
					queueMicrotask(() => {
						for (const handler of handlers) handler({ type: "closed" });
					});
				});
				await releaseTab(name, { kill: false });
				const watcher = await browser.browser.target().createCDPSession();
				const { targetInfos } = await watcher.send("Target.getTargets");
				await watcher.detach();
				expect(targetInfos.map(info => info.targetId)).not.toContain(targetId);
			} finally {
				await releaseTab(name, { kill: true });
			}
		},
		45_000,
	);
});
