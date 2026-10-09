import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type Target, type WebWorker } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
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

interface RelayFixture {
	browser: Browser;
	/** The relay extension's service worker, for reading Chrome's own tab state. */
	extension: WebWorker;
	server: RelayServer;
	cdpUrl: string;
	origin: string;
	close(): Promise<void>;
}

/**
 * Headless Chromium running the real relay extension against a relay on a free port, plus a loopback
 * site. The extension's `chrome.debugger.onDetach` listener is exposed as `testDebuggerDetach`, since a
 * programmatic detach does not fire it.
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
					? `<title>First</title><button onclick="this.textContent='clicked'">First</button>`
					: route === "/second"
						? "<title>Second</title><button>Second</button>"
						: "<title>Human sentinel</title><h1>Keep me</h1>";
			return new Response(html, { headers: { "Content-Type": "text/html" } });
		},
	});
	let browser: Browser | undefined;
	async function close() {
		try {
			await browser?.close();
		} finally {
			server.stop();
			pages.stop(true);
			await fs.rm(extensionDir, { recursive: true, force: true });
		}
	}
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
		}
		const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
		// Point the disposable extension at this relay before its code can dial a user's default relay.
		await fs.writeFile(
			path.join(extensionDir, "background.js"),
			`const registerDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
chrome.debugger.onDetach.addListener = listener => {
	globalThis.testDebuggerDetach = listener;
	registerDetach(listener);
};
chrome.storage.local.set({ port: ${port} }).then(() => {
${background}
});`,
		);
		browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extensionDir],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		const extension = await (
			await browser.waitForTarget(target => target.type() === "service_worker", { timeout: 15_000 })
		).worker();
		if (!extension) throw new Error("Missing relay extension worker");
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Finish the extension hello before the native CDP client attaches to the sentinel.
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return { browser, extension, server, cdpUrl, origin: `http://127.0.0.1:${pages.port}`, close };
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
	return await fixture.extension.evaluate(
		`chrome.tabs.query({}).then(tabs => { const tab = tabs.find(tab => tab.id === ${tabId}); return tab ? { active: tab.active } : null; })`,
	);
}

async function activeChromeTabUrl(fixture: RelayFixture): Promise<unknown> {
	return await fixture.extension.evaluate(
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

	it("closes an owned relay tab whose debugger the user dismissed", async () => {
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const fixture = await launchRelayFixture((message, data) => {
			if (message === "tab detached" && typeof data?.tabKey === "string" && data.tabKey.endsWith(`:${ownedTabId}`))
				detached.resolve();
		});
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		const name = `relay-detached-${process.pid}`;
		try {
			const { tab } = await acquireTab(name, relay, { url: `${fixture.origin}/first`, timeoutMs: 20_000 });
			ownedTabId = chromeTabId(tab.targetId);
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Replay the infobar dismissal through the extension's real listener.
			await fixture.extension.evaluate(`chrome.debugger.detach({ tabId: ${ownedTabId} }).then(() => {
				globalThis.testDebuggerDetach({ tabId: ${ownedTabId} }, "canceled_by_user");
			})`);
			await detached.promise;
			expect(fixture.server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect(await chromeTab(fixture, ownedTabId)).not.toBeNull();
			await releaseTab(name);
			expect(await chromeTab(fixture, ownedTabId)).toBeNull();
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 60_000);

	it("drops a closed owned tab's handle and browser hold when timeout recovery loses its connection", async () => {
		const fixture = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: fixture.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium connection");
		const name = `relay-closed-recovery-${process.pid}`;
		const referencesBefore = relay.refCount;
		const { tab } = await acquireTab(name, relay, { timeoutMs: 15_000 });
		const gone = Promise.withResolvers<void>();
		const onGone = (target: Target) => {
			if ("_targetId" in target && target._targetId === tab.targetId) gone.resolve();
		};
		relay.browser.on("targetdestroyed", onGone);
		try {
			const run = runInTab(name, { code: "await page.close(); await wait(60_000);", timeoutMs: 5_000, session });
			await gone.promise;
			relay.browser.disconnect();
			expect(await rejectionOf(run)).toBeInstanceOf(Error);
			expect(getTabsMapForTest().has(name)).toBeFalse();
			expect(relay.refCount).toBe(referencesBefore);
		} finally {
			relay.browser.off("targetdestroyed", onGone);
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await fixture.close();
		}
	}, 30_000);
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
			// Closing the worker that owns the page closes it.
			expect(page.isClosed()).toBeTrue();
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await fs.rm(downloadDir, { recursive: true, force: true });
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);
});
