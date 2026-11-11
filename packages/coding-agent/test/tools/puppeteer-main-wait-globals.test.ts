import { describe, expect, it } from "bun:test";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe.skipIf(!CHROMIUM_AVAILABLE)("main-world Puppeteer waits", () => {
	it("leaves page scripts without internal ARIA bindings after success, timeout and abort", async () => {
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			await page.goto("data:text/html,<button>Continue</button>");
			for (const polling of ["raf", "mutation", 10] as const) {
				const handle = await page.waitForFunction(
					() => {
						//!world=main
						return true;
					},
					{ polling },
				);
				await handle.dispose();
			}
			await expect(
				page.waitForFunction(
					() => {
						//!world=main
						return false;
					},
					{ timeout: 50 },
				),
			).rejects.toThrow("exceeded");
			const controller = new AbortController();
			const aborted = page
				.waitForFunction(
					() => {
						//!world=main
						return false;
					},
					{ signal: controller.signal },
				)
				.catch(error => error);
			// The evaluation follows the wait's setup on the same protocol session.
			await page.evaluate(() => {
				//!world=main
				return true;
			});
			controller.abort(new Error("stopped"));
			expect((await aborted).message).toBe("stopped");
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
			await browser.close();
		}
	});
});
