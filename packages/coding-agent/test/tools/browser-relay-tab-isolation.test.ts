import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { unpackedExtensionId } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

interface TestWorker {
	outcome: Promise<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>;
	close(): Promise<void>;
}

function startWorker(payload: WorkerInitPayload): TestWorker {
	const outcome = Promise.withResolvers<Extract<WorkerOutbound, { type: "ready" | "init-failed" }>>();
	const closed = Promise.withResolvers<void>();
	let receive!: (message: WorkerInbound | WorkerOutbound) => void;
	new WorkerCore(
		{
			send(message) {
				if (message.type === "ready" || message.type === "init-failed") outcome.resolve(message);
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {
				closed.resolve();
			},
		},
		false,
	);
	receive({ type: "init", payload });
	return {
		outcome: outcome.promise,
		async close() {
			receive({ type: "close" });
			await closed.promise;
		},
	};
}

interface RelayBrowser {
	browser: Browser;
	/** Evaluates `expression` on an extension page, where Chrome's tab and runtime APIs are in scope. */
	inExtension(expression: string): Promise<unknown>;
}

interface RelayFixture extends RelayBrowser {
	server: RelayServer;
	cdpUrl: string;
	origin: string;
	/** Another Chromium with its own profile and the same extension, as a second browser on the relay. */
	launchBrowser(): Promise<RelayBrowser>;
	close(): Promise<void>;
}

/**
 * Headless Chromium running the real relay extension against a relay on a free port, plus a loopback
 * site. A test-only message listener controls its service worker: a programmatic debugger detach does
 * not fire `onDetach`, and `testRefuseRemoves` makes that many `chrome.tabs.remove` calls reject first.
 */
async function launchRelayFixture(
	log?: (message: string, data?: Record<string, unknown>) => void,
): Promise<RelayFixture> {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false, log });
	const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	const pages = Bun.serve({
		port: 0,
		fetch(request) {
			const route = new URL(request.url).pathname;
			const html =
				route === "/first"
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	const browsers: Browser[] = [];
	async function close() {
		try {
			await Promise.all(browsers.map(browser => browser.close()));
		} finally {
			server.stop();
			pages.stop(true);
			await fs.rm(extensionDir, { recursive: true, force: true });
		}
	}
	async function launchBrowser(): Promise<RelayBrowser> {
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extensionDir],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		browsers.push(browser);
		const extensionId = await unpackedExtensionId(extensionDir);
		if (!extensionId) throw new Error("Missing relay extension directory");
		// A service worker is transient: it may start and stop before Puppeteer observes its target.
		// An extension page can wake it via runtime messaging and remains available for tab queries.
		const page = await browser.newPage();
		await page.goto(`chrome-extension://${extensionId}/options.html`);
		// Puppeteer's `page.evaluate` lands in a context without the extension APIs; the page's
		// default context, which `Runtime.evaluate` targets, has them.
		const cdp = await page.createCDPSession();
		async function inExtension(expression: string): Promise<unknown> {
			const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			});
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		}
		return { browser, inExtension };
	}
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
		}
		const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
		const defaultPort = "var DEFAULT_PORT = 9224;";
		if (!background.includes(defaultPort)) throw new Error("Relay extension default port not found");
		// Point the disposable extension at this relay without deferring listener registration.
		await fs.writeFile(
			path.join(extensionDir, "background.js"),
			`const testRegisterDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.testDebuggerDetach = listener;
	testRegisterDetach(listener);
};
const testRemoveTab = chrome.tabs.remove.bind(chrome.tabs);
chrome.tabs.remove = tabId => {
	if (globalThis.testRefuseRemoves > 0) {
		globalThis.testRefuseRemoves--;
		return Promise.reject(new Error("Tabs cannot be edited right now (user may be dragging a tab)."));
	}
	return testRemoveTab(tabId);
};
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message.op === "refuseRemoves") {
		globalThis.testRefuseRemoves = message.count;
		respond({});
	} else if (message.op === "dismissDebugger") {
		chrome.debugger.detach({ tabId: message.tabId }).then(() => {
			globalThis.testDebuggerDetach({ tabId: message.tabId }, "canceled_by_user");
			respond({});
		}, error => respond({ error: String(error) }));
		return true;
	}
});
${background.replace(defaultPort, `var DEFAULT_PORT = ${port};`)}`,
		);
		const { browser, inExtension } = await launchBrowser();
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Finish the extension hello before the native CDP client attaches to the sentinel.
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return {
			browser,
			inExtension,
			server,
			cdpUrl,
			origin: `http://127.0.0.1:${pages.port}`,
			launchBrowser,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

function chromeTabId(targetId: string): number {
	return Number(targetId.slice(targetId.lastIndexOf(".") + 1));
}

/** Chrome's own view of a tab (`{ active }`), or null once it is closed. */
async function chromeTab(fixture: RelayFixture, tabId: number): Promise<unknown> {
	return await fixture.inExtension(
		`chrome.tabs.query({}).then(tabs => { const tab = tabs.find(tab => tab.id === ${tabId}); return tab ? { active: tab.active } : null; })`,
	);
}

async function activeChromeTabUrl(fixture: RelayFixture): Promise<unknown> {
	return await fixture.inExtension(
		"chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0]?.url)",
	);
}

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab ownership", () => {
	it("opens default relay tabs in the background and closes them, leaving borrowed pages open", async () => {
		const fixture = await launchRelayFixture();
		const human = await fixture.browser.newPage();
		const humanUrl = `${fixture.origin}/human`;
		await human.goto(humanUrl);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-first-${process.pid}`, `relay-second-${process.pid}`, `relay-borrowed-${process.pid}`];
		try {
			const first = await acquireTab(names[0]!, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// An open that adopted the selected tab would have navigated it to the `url`.
			expect(human.url()).toBe(humanUrl);
			const second = await acquireTab(names[1]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(first.tab.targetId).not.toBe(second.tab.targetId);
			expect(human.url()).toBe(humanUrl);
			expect(await human.title()).toBe("Human sentinel");
			// The user's tab stays selected; the owned tabs were created unselected.
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			const clicked = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 10_000,
				session,
			});
			expect(clicked.returnValue).toBe("clicked");
			// Hover waits for a rendered frame, which a hidden tab never produces: this passes only while the
			// unselected tab is focus-emulated.
			const hovered = await runInTab(names[0]!, {
				code: "await tab.hover('#hover'); return await tab.text('#hover');",
				timeoutMs: 10_000,
				session,
			});
			expect(hovered.returnValue).toBe("hovered");
			// A screenshot of the unselected tab is captured in place: it never selects the tab.
			const shot = await runInTab(names[0]!, {
				code: "return typeof (await tab.screenshot());",
				timeoutMs: 10_000,
				session,
			});
			expect(shot.returnValue).toBe("string");
			expect(await activeChromeTabUrl(fixture)).toBe(humanUrl);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toEqual({ active: false });

			await releaseTab(names[0]!);
			expect(await chromeTab(fixture, chromeTabId(first.tab.targetId))).toBeNull();
			expect(await human.title()).toBe("Human sentinel");
			const surviving = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 10_000, session });
			expect(surviving.returnValue).toBe("Second");

			// `app.target` borrows the user's page; closing releases it without closing it.
			const borrowed = await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			expect(borrowed.tab.targetId).not.toBe(first.tab.targetId);
			await releaseTab(names[2]!);
			expect(human.isClosed()).toBeFalse();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("opens a default tab in the browser of the tab omp used last, not the first selected one", async () => {
		const secondHello = Promise.withResolvers<void>();
		let hellos = 0;
		const fixture = await launchRelayFixture(message => {
			if (message === "extension connected" && ++hellos === 2) secondHello.resolve();
		});
		// The first browser shows the first selected tab, which a new tab would otherwise follow.
		const human = await fixture.browser.newPage();
		await human.goto(`${fixture.origin}/human`);
		await human.bringToFront();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const names = [
			`relay-near-human-${process.pid}`,
			`relay-near-other-${process.pid}`,
			`relay-near-own-${process.pid}`,
		];
		/** The browser a relay target id belongs to (`PAGE<browser>.<tab>`). */
		const browserOf = (targetId: string) => targetId.slice(4, targetId.lastIndexOf("."));
		try {
			// Borrowing waits until the relay lists the tab, so the first browser's selected tab is listed first.
			const inFirst = await acquireTab(names[0]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			const other = await fixture.launchBrowser();
			// The relay announces a browser's tabs to connected clients only as they change after its hello.
			await secondHello.promise;
			await (await other.browser.newPage()).goto(`${fixture.origin}/first`);
			const inSecond = await acquireTab(names[1]!, relay, { target: "First", timeoutMs: 15_000 });
			expect(browserOf(inSecond.tab.targetId)).not.toBe(browserOf(inFirst.tab.targetId));
			const owned = await acquireTab(names[2]!, relay, { url: `${fixture.origin}/second`, timeoutMs: 15_000 });
			expect(browserOf(owned.tab.targetId)).toBe(browserOf(inSecond.tab.targetId));
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned tab Chrome refuses to close at first", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-refused-close-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 15_000 });
			// A release sends two closes (the worker's, then the supervisor's by id); Chrome refuses the first two tries.
			await fixture.inExtension('chrome.runtime.sendMessage({ op: "refuseRemoves", count: 2 })');
			await releaseTab(name);
			// The close returned with the tab gone.
			expect(await chromeTab(fixture, chromeTabId(tab.targetId))).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("closes an owned relay tab whose debugger the user dismissed", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const fixture = await launchRelayFixture((message, data) => {
			if (message === "tab detached" && typeof data?.tabKey === "string" && data.tabKey.endsWith(`:${ownedTabId}`))
				detached.resolve();
		});
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-detached-${process.pid}`;
		const otherName = `relay-detached-other-${process.pid}`;
		try {
			const human = await fixture.browser.newPage();
			await human.goto(`${fixture.origin}/human`);
			const { tab: other } = await acquireTab(otherName, relay, {
				url: `${fixture.origin}/second`,
				timeoutMs: 20_000,
			});
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			ownedTabId = chromeTabId(tab.targetId);
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Replay the infobar dismissal through the extension's real listener.
			const result = await fixture.inExtension(
				`chrome.runtime.sendMessage({ op: "dismissDebugger", tabId: ${ownedTabId} })`,
			);
			expect(result).toEqual({});
			await detached.promise;
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect(await chromeTab(fixture, ownedTabId)).not.toBeNull();
			await releaseTab(name);
			expect(await chromeTab(fixture, ownedTabId)).toBeNull();
			expect(await chromeTab(fixture, chromeTabId(other.targetId))).not.toBeNull();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseTab(otherName).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("owned tab recovery", () => {
	it("keeps an owned target alive after a failed recovery init so a retry can adopt it", async () => {
		const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in launched)) throw new Error("Expected Chromium");
		const page = await launched.browser.newPage();
		await page.goto("data:text/html,<title>Recovery sentinel</title>");
		const target = page.target();
		if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Missing target ID");
		const payload: WorkerInitPayload = {
			mode: "attach",
			browserWSEndpoint: launched.browser.wsEndpoint(),
			safeDir: getPuppeteerDir(),
			uploadDir: "/tmp/omp-uploads-test",
			page: { kind: "owned", targetId: target._targetId },
			recover: true,
		};
		const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-download-"));
		const blockedDownloadPath = path.join(downloadDir, "not-a-directory");
		await fs.writeFile(blockedDownloadPath, "existing file");
		const failed = startWorker({ ...payload, downloadsPath: blockedDownloadPath });
		let retried: TestWorker | undefined;
		try {
			expect((await failed.outcome).type).toBe("init-failed");
			expect(page.isClosed()).toBeFalse();
			retried = startWorker(payload);
			const ready = await retried.outcome;
			if (ready.type !== "ready") throw new Error("Expected the retry to adopt the owned target");
			expect(ready.info.targetId).toBe(target._targetId);
			await retried.close();
			retried = undefined;
			// Closing the worker that owns the page closes it. Ask Chrome: this connection's `page`
			// learns of the close only once its own target event arrives.
			const { targetInfos } = await launched.browser
				.target()
				.createCDPSession()
				.then(async session => {
					const targets = await session.send("Target.getTargets");
					await session.detach();
					return targets;
				});
			expect(targetInfos.map(info => info.targetId)).not.toContain(target._targetId);
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);
});
