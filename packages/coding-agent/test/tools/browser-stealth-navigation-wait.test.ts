import { expect, test } from "bun:test";
import { launchHeadlessBrowser, removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { chromiumAvailable } from "./chromium-probe";
declare const location: { hostname: string };

const CHROMIUM_AVAILABLE = await chromiumAvailable();

test.skipIf(!CHROMIUM_AVAILABLE)(
	"raw predicate wait survives cross-origin document navigation without accepting false predicates",
	async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname, port } = new URL(request.url);
				return new Response(
					pathname === "/start"
						? `<button id="unlock" onclick="location.href='http://localhost:${port}/done'">Unlock</button>`
						: "<h1>destination</h1>",
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		let userDataDir: string | undefined;
		try {
			const launched = await launchHeadlessBrowser({ headless: true });
			userDataDir = launched.userDataDir;
			const { browser } = launched;
			try {
				const context = await browser.createBrowserContext();
				try {
					const checkout = await context.newPage();
					await checkout.goto(`http://127.0.0.1:${server.port}/start`);
					const destination = checkout.waitForFunction(() => location.hostname === "localhost", { timeout: 3000 });
					void destination.catch(() => undefined);
					await checkout.click("#unlock");
					await (await destination).dispose();
					expect(await checkout.evaluate(() => location.hostname)).toBe("localhost");
					await expect(
						checkout.waitForFunction(() => location.hostname === "not-this-host", { timeout: 150 }),
					).rejects.toThrow("exceeded");
				} finally {
					await context.close();
				}
			} finally {
				await browser.close();
			}
		} finally {
			if (userDataDir) await removeUserDataDir(userDataDir);
			server.stop(true);
		}
	},
	20_000,
);
