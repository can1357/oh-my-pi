import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const OBJECT_FORM_ERROR =
	'tab.scroll() takes finite pixel deltas (dx, dy, { selector? }) but was called as tab.scroll({"direction":"down","amount":600}). Did you mean tab.scroll(0, 600)?';

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

describe("tab.scroll argument guard", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"rejects an options object before CDP and scrolls by the suggested call through WorkerCore",
		async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			const name = `scroll-guard-${process.pid}-${crypto.randomUUID()}`;
			const html = '<div id="list" style="height:100px;overflow:auto"><div style="height:5000px"></div></div>';
			try {
				await acquireTab(name, browser, {
					url: `data:text/html,${encodeURIComponent(html)}`,
					timeoutMs: 30_000,
				});
				const result = await runInTab(name, {
					code: `
						let rejected;
						try {
							await tab.scroll({ direction: "down", amount: 600, selector: "#list" });
						} catch (error) {
							rejected = { name: error.name, message: error.message };
						}
						const scrollTop = () => tab.evaluate(() => document.querySelector("#list").scrollTop);
						const before = await scrollTop();
						await tab.scroll(0, 600, { selector: "#list" });
						return { rejected, before, after: await scrollTop() };
					`,
					timeoutMs: 15_000,
					session: makeSession(),
				});
				expect(result.returnValue).toEqual({
					rejected: {
						name: "ToolError",
						message:
							'tab.scroll() takes finite pixel deltas (dx, dy, { selector? }) but was called as tab.scroll({"direction":"down","amount":600,"selector":"#list"}). Did you mean tab.scroll(0, 600, { selector: "#list" })?',
					},
					before: 0,
					after: 600,
				});
			} finally {
				await releaseTab(name, { kill: true });
				if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
			}
		},
		45_000,
	);

	it("rejects non-finite deltas in cmux without sending a scroll request", async () => {
		const calls: unknown[][] = [];
		const tab = new CmuxTab({
			client: { request: async (...args: unknown[]) => (calls.push(args), {}) } as never,
			surfaceId: "scroll-guard",
		});

		await expect(tab.scroll(0, Number.NaN, { selector: "#list" })).rejects.toThrow(
			'tab.scroll() takes finite pixel deltas (dx, dy, { selector? }) but was called as tab.scroll(0, NaN, {"selector":"#list"}).',
		);
		expect(calls).toEqual([]);

		await tab.scroll(0, 600);
		expect(calls).toEqual([
			["browser.scroll", { surface_id: "scroll-guard", dx: 0, dy: 600 }, { timeoutMs: undefined }],
		]);
	});

	it("rejects the options-object form in Tern before contacting the daemon", async () => {
		const tab = new TernTab({
			client: new TernSocketClient({ socketPath: "/nonexistent" }),
			block: 7,
			name: "main",
			viewport: { width: 800, height: 600 },
		});

		await expect(tab.scroll({ direction: "down", amount: 600 } as never, undefined as never)).rejects.toThrow(
			OBJECT_FORM_ERROR,
		);
	});
});
