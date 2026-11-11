import { describe, expect, it, spyOn } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";
import { rejectionOf } from "../helpers/rejection";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

async function withCmuxPage(run: (tab: CmuxTab, page: Page) => Promise<void>): Promise<void> {
	const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
	const page = await browserHandle.browser.newPage();
	// cmux evaluates its scripts in the page; Chromium stands in for the surface.
	const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (method: string, params?: Record<string, unknown>) => {
			if (method === "browser.snapshot") return { refs: { "@e1": { role: "button", name: "Remove" } } };
			if (method === "browser.is.visible") {
				if (params?.selector !== "@e1") throw new Error("Unexpected observation ref");
				return {
					value: await page.$eval("#observed", element => {
						const style = getComputedStyle(element);
						const rect = element.getBoundingClientRect();
						return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
					}),
				};
			}
			if (method === "browser.get.count") {
				if (params?.selector !== "@e1") throw new Error("Unexpected observation ref");
				return { count: await page.evaluate(() => document.querySelectorAll("#observed").length) };
			}
			if (method !== "browser.eval") throw new Error(`Unexpected cmux request: ${method}`);
			return { value: await page.evaluate(String(params?.script)) };
		},
	);
	try {
		await run(
			new CmuxTab({
				client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-page-text.sock" }),
				surfaceId: "page-text",
			}),
			page,
		);
	} finally {
		request.mockRestore();
		await page.close().catch(() => undefined);
		if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("cmux page reads", () => {
	it("read the page body without a selector, and keep empty rendered text empty", async () => {
		await withCmuxPage(async (tab, page) => {
			await page.setContent("<p>Hello <b>page</b></p>");
			expect(await tab.text()).toBe("Hello page");
			expect(await tab.html()).toBe("<p>Hello <b>page</b></p>");
			// Only script and hidden text: the rendered text is empty, and so is the read.
			await page.setContent('<script>var source = "inline";</script><div hidden>secret</div>');
			expect(await tab.text()).toBe("");
		});
	}, 30_000);

	it("honors selector wait states and validates their options", async () => {
		await withCmuxPage(async (tab, page) => {
			expect(await tab.waitForSelector("#gone", { state: "hidden" })).toBeNull();
			expect(await tab.waitForSelector("#gone", { state: "detached" })).toBeNull();
			await page.setContent('<div id="hidden" style="display:none">secret</div><div id="shown">shown</div>');
			expect(await tab.waitForSelector("#hidden", { state: "hidden" })).toBeNull();
			expect(await rejectionOf(tab.waitForSelector("#hidden", { state: "detached", timeout: 1 }))).toMatchObject({
				message: expect.stringContaining("timed out"),
			});
			expect(await tab.waitForSelector("#shown", { state: "visible", timeout: Infinity })).not.toBeNull();
			expect(await rejectionOf(tab.waitForSelector("#shown", JSON.parse('{"state":"gone"}')))).toMatchObject({
				message: expect.stringContaining("waitForSelector() accepts"),
			});
		});
	}, 30_000);

	it("waits for live observed-ref state without refreshing the observation", async () => {
		await withCmuxPage(async (tab, page) => {
			await page.setContent('<button id="observed">Remove</button>');
			expect((await tab.observe()).elements).toMatchObject([{ id: 1, role: "button", name: "Remove" }]);
			expect(await tab.elementExists("e1")).toBe(true);
			expect(await tab.waitForSelector("e1", { state: "visible" })).not.toBeNull();
			expect(await rejectionOf(tab.waitForSelector("e1", { state: "hidden", timeout: 1 }))).toMatchObject({
				message: expect.stringContaining("timed out"),
			});
			await page.$eval("#observed", element => element.setAttribute("style", "display:none"));
			expect(await tab.elementExists("e1")).toBe(true);
			expect(await tab.waitForSelector("e1", { state: "hidden" })).toBeNull();
			expect(await rejectionOf(tab.waitForSelector("e1", { state: "visible", timeout: 1 }))).toMatchObject({
				message: expect.stringContaining("timed out"),
			});
			expect(await rejectionOf(tab.waitForSelector("e1", { state: "detached", timeout: 1 }))).toMatchObject({
				message: expect.stringContaining("timed out"),
			});
			await page.$eval("#observed", element => element.remove());
			expect(await tab.elementExists("e1")).toBe(false);
			expect(await tab.waitForSelector("e1", { state: "detached" })).toBeNull();
		});
	}, 30_000);
});
