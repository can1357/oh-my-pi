import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type {
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { Target } from "puppeteer-core";

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

const CHROMIUM_AVAILABLE = await chromiumAvailable();

async function launchRelayFixture() {
	const port = await findFreeCdpPort();
	const server = startRelayServer({ port, group: false });
	const extension = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-isolation-"));
	const assets = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");
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
			await fs.rm(extension, { recursive: true, force: true });
		}
	}
	try {
		for (const file of ["manifest.json", "options.html", "options.js"]) {
			await fs.copyFile(path.join(assets, `${file}.txt`), path.join(extension, file));
		}
		const background = await fs.readFile(path.join(assets, "background.js.txt"), "utf8");
		await fs.writeFile(
			path.join(extension, "background.js"),
			`chrome.storage.local.set({ port: ${port} }).then(() => {\n${background}\n});`,
		);
		browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extension],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		const worker = await (
			await browser.waitForTarget(target => target.type() === "service_worker", { timeout: 15_000 })
		).worker();
		if (!worker) throw new Error("Missing relay extension worker");
		const cdpUrl = `http://127.0.0.1:${port}`;
		// Finish the extension hello before the native CDP client attaches to the sentinel.
		const outcome = await waitForRelayExtension(cdpUrl);
		if (outcome !== "ready") throw new Error(`Relay fixture handshake failed: ${outcome}`);
		return { browser, worker, cdpUrl, origin: `http://127.0.0.1:${pages.port}`, close };
	} catch (error) {
		await close();
		throw error;
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("relay tab ownership", () => {
	it("isolates default opens and preserves explicitly borrowed pages on close", async () => {
		const launched = await launchRelayFixture();
		const human = await launched.browser.newPage();
		const humanUrl = `${launched.origin}/human`;
		await human.goto(humanUrl);
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: launched.cdpUrl }, { cwd: process.cwd() });
		const names = [`relay-first-${process.pid}`, `relay-second-${process.pid}`, `relay-borrowed-${process.pid}`];
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession;
		try {
			const first = await acquireTab(names[0]!, relay, {
				url: `${launched.origin}/first`,
				timeoutMs: 15_000,
			});
			const second = await acquireTab(names[1]!, relay, {
				url: `${launched.origin}/second`,
				timeoutMs: 15_000,
			});
			expect(first.tab.targetId).not.toBe(second.tab.targetId);
			expect(await human.title()).toBe("Human sentinel");
			expect(human.url()).toBe(humanUrl);
			const result = await runInTab(names[0]!, {
				code: "await tab.click('button'); return await tab.text('button');",
				timeoutMs: 10_000,
				session,
			});
			expect(result.returnValue).toBe("clicked");
			const firstChromeTabId = Number(first.tab.targetId.slice(first.tab.targetId.lastIndexOf(".") + 1));
			expect(
				await launched.worker.evaluate(
					`chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === ${firstChromeTabId}))`,
				),
			).toBeTrue();
			await releaseTab(names[0]!);
			expect(
				await launched.worker.evaluate(
					`chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === ${firstChromeTabId}))`,
				),
			).toBeFalse();
			expect(await human.title()).toBe("Human sentinel");
			const surviving = await runInTab(names[1]!, { code: "return await tab.title();", timeoutMs: 10_000, session });
			expect(surviving.returnValue).toBe("Second");
			await acquireTab(names[2]!, relay, { target: "Human sentinel", timeoutMs: 15_000 });
			await releaseTab(names[2]!);
			expect(human.isClosed()).toBeFalse();
			expect(await human.title()).toBe("Human sentinel");
		} finally {
			for (const name of names) await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await human.close().catch(() => undefined);
			await launched.close();
		}
	}, 60_000);

	it("keeps an owned recovery target alive after failed init so a retry can adopt it", async () => {
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
			targetId: target._targetId,
			ownsPage: true,
			recover: true,
			emulateFocus: true,
			timeoutMs: 5_000,
		};
		const failed = startWorker({ ...payload, url: "omp-invalid-scheme://recovery" });
		let retried: TestWorker | undefined;
		try {
			const failure = await failed.outcome;
			expect(failure.type).toBe("init-failed");
			expect(page.isClosed()).toBeFalse();
			retried = startWorker(payload);
			const ready = await retried.outcome;
			expect(ready.type).toBe("ready");
			if (ready.type === "ready") expect(ready.info.targetId).toBe(target._targetId);
			await retried.close();
			retried = undefined;
			expect(page.isClosed()).toBeTrue();
		} finally {
			await retried?.close();
			await failed.close();
			await page.close().catch(() => undefined);
			await releaseBrowser(launched, { kill: true });
		}
	}, 30_000);

	it("drops a closed target's handle and browser hold when timeout recovery loses its CDP connection", async () => {
		const launched = await launchRelayFixture();
		const relay = await acquireBrowser({ kind: "relay", cdpUrl: launched.cdpUrl }, { cwd: process.cwd() });
		if (!("browser" in relay)) throw new Error("Expected relay Chromium connection");
		const name = `relay-closed-recovery-${process.pid}`;
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession;
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
			await expect(run).rejects.toThrow();
			expect(getTabsMapForTest().has(name)).toBeFalse();
			expect(relay.refCount).toBe(referencesBefore);
		} finally {
			relay.browser.off("targetdestroyed", onGone);
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(relay, { kill: false });
			await launched.close();
		}
	}, 30_000);
});
