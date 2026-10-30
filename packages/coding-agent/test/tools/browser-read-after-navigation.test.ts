import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";
const CHROMIUM_AVAILABLE = await chromiumAvailable();

const PAGES: Record<string, string> = {
	"/form": `<title>Form</title><main><h1>Old page</h1><form action="/next"><button>Continue</button></form></main>`,
	"/next": `<title>Next</title><main><h1>New page</h1></main>`,
	"/unload": `<title>Unload</title><h1>Unload page</h1><a href="/next">Leave</a>
		<script>addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; });</script>`,
};

const server = Bun.serve({
	port: 0,
	fetch(request) {
		const page = PAGES[new URL(request.url).pathname];
		if (page === undefined) return new Response("not found", { status: 404 });
		return new Response(page, { headers: { "content-type": "text/html" } });
	},
});
const origin = `http://127.0.0.1:${server.port}`;
const acquireHeadless = () => acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
/** The file's hold on one Chromium; each tab takes a hold of its own and gives it back when released. */
let browserHold: BrowserHandle | undefined;

beforeAll(async () => {
	if (CHROMIUM_AVAILABLE) browserHold = await acquireHeadless();
});

afterAll(async () => {
	if (browserHold) await releaseBrowser(browserHold, { kill: true });
	server.stop(true);
});

async function runOnPage(code: string): Promise<unknown> {
	const browser = await acquireHeadless();
	if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
	const name = `read-after-navigation-${process.pid}`;
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
	try {
		await acquireTab(name, browser, { url: `${origin}/form`, timeoutMs: 30_000 });
		const result = await runInTab(name, { code, timeoutMs: 30_000, session });
		return result.returnValue;
	} finally {
		await releaseTab(name, { kill: true });
	}
}

describe("browser calls after a click that navigates", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"read at once after a leave the beforeunload prompt cancelled",
		async () => {
			const heading = await runOnPage(`
				await tab.goto("${origin}/unload");
				await tab.setDialogs("dismiss");
				await tab.click("text/Leave");
				return await tab.text("h1");
			`);
			expect(heading).toBe("Unload page");
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"run our own read again when its document is gone, but never user code",
		async () => {
			const result = await runOnPage(`
				const client = page.mainFrame().client;
				const send = client.send;
				let sent = 0;
				// Chromium refuses the next evaluation as it does once the document it targeted is gone: it is sent to an
				// execution context that no longer exists.
				const refuseNext = () => {
					sent = 0;
					client.send = function (method, params, ...rest) {
						if (method !== "Runtime.callFunctionOn" || sent++ > 0) return send.call(this, method, params, ...rest);
						return send.call(this, method, { ...params, executionContextId: 2147483647 }, ...rest);
					};
				};
				try {
					refuseNext();
					const snapshot = await tab.ariaSnapshot();
					refuseNext();
					await tab.waitForText("Old page");
					refuseNext();
					const refused = await tab.evaluate(() => (globalThis.runs = (globalThis.runs ?? 0) + 1)).then(
						() => "ran again",
						error => error.message,
					);
					const refusedSends = sent;
					client.send = send;
					// Page code throwing the same words is the page's own error, not a lost document.
					const thrown = await tab
						.evaluate(() => {
							globalThis.runs = (globalThis.runs ?? 0) + 1;
							throw new Error("Cannot find context with specified id");
						})
						.then(() => "no error", error => error.message);
					const runs = await tab.evaluate(() => globalThis.runs);
					return { heading: snapshot.includes("Old page"), refused, refusedSends, thrown, runs };
				} finally {
					client.send = send;
				}
			`);
			expect(result).toMatchObject({ heading: true, refusedSends: 1, runs: 1 });
			const { refused, thrown } = result as { refused: string; thrown: string };
			expect(refused).toContain("Execution context was destroyed");
			expect(thrown).toContain("Cannot find context with specified id");
		},
		45_000,
	);
});
