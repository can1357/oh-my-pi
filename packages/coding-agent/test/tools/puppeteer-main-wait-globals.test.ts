import { describe, expect, it } from "bun:test";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe.skipIf(!CHROMIUM_AVAILABLE)("main-world Puppeteer waits", () => {
	it("keeps internal ARIA bindings out of the page without breaking selectors", async () => {
		const { browser, userDataDir } = await launchHeadlessBrowser({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto("data:text/html,<button>Continue</button>");
			const handle = await page.waitForFunction(() => {
				//!world=main
				return true;
			});
			await handle.dispose();
			const globals = await page.evaluate(() => {
				//!world=main
				return Object.getOwnPropertyNames(globalThis).filter(name => name.includes("ariaQuerySelector"));
			});
			expect(globals).toEqual([]);
			// ARIA selectors still use bindings in the isolated query world.
			const match = await page.waitForSelector("aria/Continue");
			expect(await match?.evaluate(element => element.tagName)).toBe("BUTTON");
			await match?.dispose();
		} finally {
			await closeLaunchedBrowser(browser);
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	});
});
