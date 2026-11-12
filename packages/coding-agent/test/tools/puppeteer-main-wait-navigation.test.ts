import { describe, expect, it } from "bun:test";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe.skipIf(!CHROMIUM_AVAILABLE)("main-world Puppeteer navigation waits", () => {
	it("rearms a wait started after an earlier main-world wait when the document changes", async () => {
		const { browser, userDataDir } = await launchHeadlessBrowser({ headless: true });
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
							const { document } = globalThis as unknown as {
								document: { body: { dataset: { ready?: string } } | null };
							};
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
			const stale = await page.evaluateHandle(() => {
				//!world=main
				const { document } = globalThis as unknown as {
					document: { body: { isConnected: boolean } };
				};
				return document.body;
			});
			try {
				await page.goto("data:text/html,<body>Replaced</body>");
				const error = await rejectionOf(
					page.waitForFunction(
						element => {
							//!world=main
							return element.isConnected;
						},
						{ timeout: 1_000 },
						stale,
					),
				);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).name).toBe("Error");
				expect(String((error as Error).cause)).toContain("Argument should belong to the same JavaScript world");
			} finally {
				await stale.dispose();
			}
		} finally {
			await closeLaunchedBrowser(browser);
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	});
});
