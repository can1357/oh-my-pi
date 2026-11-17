import { describe, expect, it, spyOn } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { chromiumAvailable } from "./chromium-probe";
import { rejectionOf } from "../helpers/rejection";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/** The page's own global the predicates below read. */
declare const value: number;

describe.skipIf(!CHROMIUM_AVAILABLE)("cmux waitForFunction", () => {
	it("runs a function predicate against the page's globals without eval", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		// cmux evaluates its scripts in the page; Chromium stands in for the surface.
		const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (_method: string, params?: Record<string, unknown>) => ({
				value: await page.evaluate(String(params?.script)),
			}),
		);
		try {
			const tab = new CmuxTab({
				client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-wait-function.sock" }),
				surfaceId: "wait-function",
			});
			// The page's `eval` refuses, as under a CSP without 'unsafe-eval'.
			await page.evaluate(`globalThis.value = 42;
				globalThis.eval = () => { throw new EvalError("Refused to evaluate a string as JavaScript"); };`);
			// `value` is the page's global, not a name of the script that polls the predicate.
			expect(await tab.waitForFunction(() => value, { timeout: 5_000 })).toBe(42);
			// A string still goes through eval, which this page refuses.
			expect(String(await rejectionOf(tab.waitForFunction("() => value", { timeout: 5_000 })))).toContain(
				"Refused to evaluate",
			);
		} finally {
			request.mockRestore();
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);
});
