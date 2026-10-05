import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BUTTONS = 200;

function buttons(count: number, label: string): string {
	return Array.from(
		{ length: count },
		(_, i) => `<button onclick="document.title = '${label} ${i}'">Item ${i}</button>`,
	).join("");
}

const PAGE = `data:text/html,${encodeURIComponent(buttons(BUTTONS, "clicked"))}`;

/**
 * Pages served on 127.0.0.1 link to localhost, a different site, so following the link moves the tab
 * to a new renderer that numbers its nodes from scratch. The page navigated to has at least as many
 * nodes as the one observed, so every id the observed page handed out names a node there too.
 */
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname, port } = new URL(request.url);
		const link = (target: string) => `<a href="http://localhost:${port}/${target}">Next</a>`;
		const pages: Record<string, string> = {
			"/first": link("second") + buttons(BUTTONS, "first"),
			"/second": buttons(BUTTONS * 2, "second"),
			"/cached": link("left") + buttons(BUTTONS * 2, "cached"),
			"/left": buttons(BUTTONS, "left"),
		};
		const body = pages[pathname];
		if (body === undefined) return new Response("not found", { status: 404 });
		const restored = `<script>addEventListener("pageshow", e => { if (e.persisted) document.title = "restored"; })</script>`;
		return new Response(restored + body, { headers: { "content-type": "text/html" } });
	},
});

afterAll(() => {
	server.stop(true);
});

async function runOnPage(url: string, code: string, timeoutMs = 20_000): Promise<unknown> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
	const name = `observe-${process.pid}`;
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	try {
		await acquireTab(name, browser, { url, timeoutMs: 30_000 });
		const result = await runInTab(name, { code, timeoutMs, session });
		return result.returnValue;
	} finally {
		await releaseTab(name, { kill: true });
		if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
	}
}

describe("browser observe", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"lists elements without resolving each one and resolves an id only when it is used",
		async () => {
			const result = await runOnPage(
				PAGE,
				`
					const client = page.mainFrame().client;
					const send = client.send;
					let resolved = 0;
					client.send = function (method, ...args) {
						if (method === "DOM.resolveNode") resolved++;
						return send.call(this, method, ...args);
					};
					let observation;
					try {
						observation = await tab.observe();
					} finally {
						client.send = send;
					}
					await (await tab.id(observation.elements[7].id)).click();
					const title = await tab.title();
					await tab.evaluate(() => document.querySelectorAll("button")[9].remove());
					let removed = "resolved";
					try {
						await tab.id(observation.elements[9].id);
					} catch (error) {
						removed = error.message;
					}
					return { listed: observation.elements.length, resolved, title, removed };
				`,
			);
			expect(result).toEqual({
				listed: BUTTONS,
				resolved: 0,
				title: "clicked 7",
				removed: "Element id 10 is stale. Run tab.observe() again.",
			});
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reports an unresolved id stale once a link has taken the page to another site",
		async () => {
			const result = (await runOnPage(
				`http://127.0.0.1:${server.port}/first`,
				`
					const observation = await tab.observe();
					const link = observation.elements.find(entry => entry.role === "link");
					const button = observation.elements.find(entry => entry.name === "Item 7");
					await Promise.all([page.waitForNavigation(), (await tab.id(link.id)).click()]);
					// Have the new renderer hand out backend node ids, as accessibility or layout tracking would.
					await page.accessibility.snapshot();
					let outcome;
					try {
						await (await tab.id(button.id)).click();
						outcome = "clicked " + (await tab.title());
					} catch (error) {
						outcome = error.message;
					}
					return { url: page.url(), id: button.id, outcome };
				`,
			)) as { url: string; id: number; outcome: string };
			expect(result.url).toBe(`http://localhost:${server.port}/second`);
			expect(result.outcome).toBe(`Element id ${result.id} is stale. Run tab.observe() again.`);
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"forgets ids observed on a page the back/forward cache has replaced",
		async () => {
			const result = (await runOnPage(
				`http://127.0.0.1:${server.port}/cached`,
				`
					const link = (await tab.observe()).elements.find(entry => entry.role === "link");
					await Promise.all([page.waitForNavigation(), (await tab.id(link.id)).click()]);
					const button = (await tab.observe()).elements.find(entry => entry.name === "Item 7");
					await page.goBack();
					const title = await tab.title();
					await page.accessibility.snapshot();
					let outcome;
					try {
						await (await tab.id(button.id)).click();
						outcome = "clicked " + (await tab.title());
					} catch (error) {
						outcome = error.message;
					}
					return { title, id: button.id, outcome };
				`,
			)) as { title: string; id: number; outcome: string };
			expect(result.title).toBe("restored");
			expect(result.outcome).toBe(`Unknown element id ${result.id}. Run tab.observe() to refresh the element list.`);
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"resolves the document root listed by includeAll without dropping the other ids",
		async () => {
			const result = await runOnPage(
				PAGE,
				`
					const observation = await tab.observe({ includeAll: true });
					const root = observation.elements[0];
					const nodeType = await (await tab.id(root.id)).evaluate(node => node.nodeType);
					const button = observation.elements.find(entry => entry.role === "button" && entry.name === "Item 7");
					await (await tab.id(button.id)).click();
					return { role: root.role, nodeType, title: await tab.title() };
				`,
			);
			expect(result).toEqual({ role: "RootWebArea", nodeType: 9, title: "clicked 7" });
		},
		45_000,
	);
});

/**
 * Save answers at once (delay it with `page.emulateNetworkConditions`); Hang starts a request the
 * server holds until the test ends, like a long poll or a hung API. The page's `startPoll()` opens such a
 * request itself and, on the page's own timer, marks the body `data-late` 2.5 s later: short of the 3 s
 * bound, so a read shows whether it waited for that request.
 */
function saveServer() {
	const held = new Set<() => void>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/saved") return new Response("Saved");
			if (pathname === "/hold") {
				const { promise, resolve } = Promise.withResolvers<void>();
				held.add(resolve);
				await promise;
				return new Response("released");
			}
			return new Response(
				`<button id="save" onclick="fetch('/saved').then(r => r.text()).then(t => document.body.append(Object.assign(document.createElement('button'), { textContent: t })))">Save</button>` +
					`<button id="hang" onclick="fetch('/hold')">Hang</button>` +
					`<script>function startPoll() { fetch('/hold'); setTimeout(() => { document.body.dataset.late = 'late'; }, 2500); }</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/`,
		stop() {
			for (const release of held) release();
			server.stop(true);
		},
	};
}

const NAMES = "(await tab.observe()).elements.map(element => element.name)";

describe("browser observe after an action", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"shows the result of a fetch the click started",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						// Chromium holds the response 400 ms, so it is still on its way when observe() starts.
						await page.emulateNetworkConditions({ download: -1, upload: -1, latency: 400 });
						await tab.click("#save");
						return ${NAMES};
					`,
				);
				expect(result).toEqual(["Save", "Hang", "Saved"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reads the page within a short cell when the click's request never answers",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(pages.url, `await tab.click("#hang"); return ${NAMES};`, 3_000);
				expect(result).toEqual(["Save", "Hang"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"does not wait for a request that was already open before the action",
		async () => {
			const pages = saveServer();
			try {
				const result = await runOnPage(
					pages.url,
					`
						await tab.observe();
						const sent = page.waitForRequest(request => request.url().endsWith("/hold"));
						await tab.evaluate(() => startPoll());
						await sent;
						await tab.click("#save");
						const names = ${NAMES};
						return [names, await page.evaluate(() => document.body.dataset.late ?? "early")];
					`,
				);
				expect(result).toEqual([["Save", "Hang", "Saved"], "early"]);
			} finally {
				pages.stop();
			}
		},
		45_000,
	);
});
