import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

describe("tab.press argument order", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reads press(selector, key) as press(key, {selector}) through WorkerCore",
		async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			const name = `press-guard-${process.pid}-${crypto.randomUUID()}`;
			const html =
				'<button id="initial">Initial</button><button id="target">Target</button>' +
				'<script>document.querySelector("#initial").focus();globalThis.__events=[];' +
				'addEventListener("keydown",event=>globalThis.__events.push({key:event.key,isTrusted:event.isTrusted}));</script>';
			try {
				await acquireTab(name, browser, {
					url: `data:text/html,${encodeURIComponent(html)}`,
					timeoutMs: 30_000,
				});
				const result = await runInTab(name, {
					code: `
						await tab.press("#target", "Escape");
						return await tab.evaluate(() => ({
							active: document.activeElement?.id || "",
							events: globalThis.__events,
						}));
					`,
					timeoutMs: 15_000,
					session: makeSession(),
				});
				expect(result.returnValue).toEqual({
					active: "target",
					events: [{ key: "Escape", isTrusted: true }],
				});
			} finally {
				await releaseTab(name, { kill: true });
				if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
			}
		},
		45_000,
	);

	it("reads press(selector, key) and preserves focus-before-key order in cmux", async () => {
		const calls: unknown[][] = [];
		const tab = new CmuxTab({
			client: { request: async (...args: unknown[]) => (calls.push(args), {}) } as never,
			surfaceId: "press-guard",
		});

		await tab.press("body", "Escape");
		expect(calls).toEqual([
			["browser.focus", { surface_id: "press-guard", selector: "body" }, { timeoutMs: undefined }],
			["browser.press", { surface_id: "press-guard", key: "Escape" }, { timeoutMs: undefined }],
		]);
	});
});
