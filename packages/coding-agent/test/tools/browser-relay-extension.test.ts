import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const assets = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");

describe.skipIf(!CHROMIUM_AVAILABLE)("relay extension lifecycle", () => {
	it("closes the physical owned Chrome tab after debugger detach retracts its Puppeteer target", async () => {
		const port = await findFreeCdpPort();
		const detached = Promise.withResolvers<void>();
		let ownedTabId = 0;
		const server = startRelayServer({
			port,
			group: false,
			log(message, data) {
				if (
					message === "tab detached" &&
					typeof data?.tabKey === "string" &&
					data.tabKey.endsWith(`:${ownedTabId}`)
				) {
					detached.resolve();
				}
			},
		});
		const extension = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-detach-"));
		const fixture = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("<title>Owned detach sentinel</title>", { headers: { "Content-Type": "text/html" } }),
		});
		const name = `relay-detached-${process.pid}`;
		let chrome: Browser | undefined;
		let relay: BrowserHandle | undefined;
		try {
			for (const file of ["manifest.json", "options.html", "options.js"]) {
				await fs.copyFile(path.join(assets, `${file}.txt`), path.join(extension, file));
			}
			const background = await fs.readFile(path.join(assets, "background.js.txt"), "utf8");
			// Configure the disposable extension before its code can connect to a user's default relay.
			await fs.writeFile(
				path.join(extension, "background.js"),
				`
				const registerDetach = chrome.debugger.onDetach.addListener.bind(chrome.debugger.onDetach);
				chrome.debugger.onDetach.addListener = listener => {
					globalThis.testDebuggerDetach = listener;
					registerDetach(listener);
				};
				chrome.storage.local.set({ port: ${port} }).then(() => {
					${background}
				});
			`,
			);
			chrome = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				pipe: true,
				enableExtensions: [extension],
				args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
			});
			const extensionTarget = await chrome.waitForTarget(target => target.type() === "service_worker", {
				timeout: 15_000,
			});
			const worker = await extensionTarget.worker();
			if (!worker) throw new Error("Missing relay extension service worker");
			relay = await acquireBrowser({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` }, { cwd: process.cwd() });
			if (!("browser" in relay)) throw new Error("Expected relay browser");
			const { tab } = await acquireTab(name, relay, { url: `http://127.0.0.1:${fixture.port}/`, timeoutMs: 20_000 });
			const chromeTabId = Number(tab.targetId.slice(tab.targetId.lastIndexOf(".") + 1));
			if (!Number.isInteger(chromeTabId)) throw new Error("Missing relay Chrome tab ID");
			ownedTabId = chromeTabId;
			expect(server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeTrue();
			// Programmatic detach omits onDetach; replay the infobar-dismissal event through the real extension listener.
			await worker.evaluate(`chrome.debugger.detach({ tabId: ${chromeTabId} }).then(() => {
				globalThis.testDebuggerDetach({ tabId: ${chromeTabId} }, "canceled_by_user");
			})`);
			await detached.promise;
			expect(server.bridge.listTargets().some(target => target.id === tab.targetId)).toBeFalse();
			expect(
				await worker.evaluate(`chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === ${chromeTabId}))`),
			).toBeTrue();
			await releaseTab(name);
			expect(
				await worker.evaluate(`chrome.tabs.query({}).then(tabs => tabs.some(tab => tab.id === ${chromeTabId}))`),
			).toBeFalse();
		} finally {
			await releaseTab(name).catch(() => undefined);
			if (relay) await releaseBrowser(relay, { kill: false });
			await chrome?.close();
			server.stop();
			fixture.stop(true);
			await fs.rm(extension, { recursive: true, force: true });
		}
	}, 60_000);
});
