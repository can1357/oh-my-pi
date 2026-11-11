import { describe, expect, it } from "bun:test";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe.skipIf(!CHROMIUM_AVAILABLE)("main-world Puppeteer navigation waits", () => {
	it("rearms a wait started after an earlier main-world wait when the document changes", async () => {
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			for (const polling of ["raf", "mutation", 10] as const) {
				await page.goto("data:text/html,<body>Before</body>");
				const earlier = await page.waitForFunction(() => {
					//!world=main
					return true;
				});
				await earlier.dispose();
				// Same-turn navigation races the cached utility handle's reuse.
				const pending = page
					.waitForFunction(
						() => {
							//!world=main
							return document.body?.dataset.ready;
						},
						{ polling, timeout: 3_000 },
					)
					.then(
						async handle => {
							try {
								return await handle.jsonValue();
							} finally {
								await handle.dispose();
							}
						},
						error => error,
					);
				await page.goto("data:text/html,<body data-ready='after'>After</body>");
				expect(await pending).toBe("after");
			}
			await expect(
				page.waitForFunction(
					() => {
						//!world=main
						throw new Error("predicate failed");
					},
					{ timeout: 3_000 },
				),
			).rejects.toThrow("Waiting failed");
		} finally {
			await browser.close();
		}
	});
});
