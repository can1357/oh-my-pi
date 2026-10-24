import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const PAGES: Record<string, string> = {
	"/form": `<title>Form</title><main><h1>Old page</h1><form action="/next"><button>Continue</button></form></main>`,
	"/next": `<title>Next</title><main><h1>New page</h1></main>`,
	"/step1": `<title>Step 1</title><h1>Step 1</h1><form action="/step2"><input name="response"><button>Continue</button></form>`,
	"/step2": `<title>Step 2</title><h1>Step 2</h1><form action="/step3"><input name="response"><button>Continue</button></form>`,
	"/slow-step1": `<title>Step 1</title><h1>Step 1</h1><form action="/slow-step2"><input name="response"><button>Continue</button></form>`,
	"/slow-step2": `<title>Step 2</title><h1>Step 2</h1><form action="/step3"><input name="response"><button>Continue</button></form>`,
	"/to-green": `<title>Form</title><form action="/green"><button>Continue</button></form>`,
	"/green": `<title>Green</title><body style="margin:0;background:rgb(0,160,0)"></body>`,
	"/unload": `<title>Unload</title><h1>Unload page</h1><a href="/next">Leave</a>
		<script>addEventListener("beforeunload", event => { event.preventDefault(); event.returnValue = ""; });</script>`,
};

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname, searchParams } = new URL(request.url);
		const headers = { "content-type": "text/html" };
		if (pathname === "/step3") {
			return new Response(`<title>Step 3</title><h1>Step 3: ${searchParams.get("response")}</h1>`, { headers });
		}
		const page = PAGES[pathname];
		if (page === undefined) return new Response("not found", { status: 404 });
		// Pages a form leads to take a moment, as a server-rendered step of a form flow does; the second step long
		// enough for a fill to finish on the step being left.
		if (pathname === "/next" || pathname === "/green") await Bun.sleep(100);
		if (pathname === "/step2") await Bun.sleep(500);
		// Slower than the 4 s an action waits for a requested navigation.
		if (pathname === "/slow-step2") await Bun.sleep(6_000);
		return new Response(page, { headers });
	},
});
const origin = `http://127.0.0.1:${server.port}`;

afterAll(() => {
	server.stop(true);
});

async function runOnPage(code: string): Promise<unknown> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
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
		if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
	}
}

describe("browser calls after a click that navigates", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"read the page the click loads, not the one it left",
		async () => {
			const result = await runOnPage(`
				const reads = {
					text: () => tab.text("h1"),
					ariaSnapshot: async () => (await tab.ariaSnapshot("main")).includes("New page") ? "New page" : "Old page",
					observe: async () => (await tab.observe()).title,
					evaluate: () => tab.evaluate(() => document.querySelector("h1").textContent),
					waitForText: async () => (await tab.waitForText("New page"), "New page"),
				};
				const seen = {};
				for (const [read, run] of Object.entries(reads)) {
					await tab.goto("${origin}/form");
					await tab.click("text/Continue");
					seen[read] = await run();
				}
				await tab.goto("${origin}/green");
				await tab.screenshot({ ifChanged: true, silent: true });
				await tab.goto("${origin}/to-green");
				await tab.click("text/Continue");
				seen.screenshot = (await tab.screenshot({ ifChanged: true, silent: true })).changed ? "Form" : "Green";
				return seen;
			`);
			expect(result).toEqual({
				text: "New page",
				ariaSnapshot: "New page",
				observe: "Next",
				evaluate: "New page",
				waitForText: "New page",
				screenshot: "Green",
			});
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"answer the step the click loads when both steps have the same field",
		async () => {
			const result = await runOnPage(`
				const actions = {
					fill: () => tab.fill('input[name="response"]', "41"),
					type: () => tab.type('input[name="response"]', "42"),
				};
				const headings = {};
				for (const [action, run] of Object.entries(actions)) {
					await tab.goto("${origin}/step1");
					await tab.click("text/Continue");
					await run();
					await tab.click("text/Continue");
					headings[action] = await tab.text("h1");
				}
				return headings;
			`);
			expect(result).toEqual({ fill: "Step 3: 41", type: "Step 3: 42" });
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"answer the step a slow server is still sending",
		async () => {
			// Past the wait, Chromium holds evaluations on the step being left until the next one commits.
			const result = await runOnPage(`
				await tab.goto("${origin}/slow-step1");
				await tab.click("text/Continue");
				await tab.fill('input[name="response"]', "42");
				await tab.click("text/Continue");
				return await tab.text("h1");
			`);
			expect(result).toBe("Step 3: 42");
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"wait for content on the page the click loads when the page being left has it too",
		async () => {
			const result = await runOnPage(`
				const waits = {
					waitForText: () => tab.waitForText("Continue", { selector: "button" }),
					waitForSelector: () => tab.waitForSelector('input[name="response"]'),
					waitFor: () => tab.waitFor('input[name="response"]'),
				};
				const pages = {};
				for (const [wait, run] of Object.entries(waits)) {
					await tab.goto("${origin}/step1");
					await tab.click("text/Continue");
					await run();
					pages[wait] = new URL(page.url()).pathname;
				}
				return pages;
			`);
			expect(result).toEqual({ waitForText: "/step2", waitForSelector: "/step2", waitFor: "/step2" });
		},
		45_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"read at once after a leave the beforeunload prompt cancelled",
		async () => {
			const result = (await runOnPage(`
				await tab.goto("${origin}/unload");
				await tab.setDialogs("dismiss");
				await tab.click("text/Leave");
				const started = performance.now();
				const heading = await tab.text("h1");
				return { heading, ms: performance.now() - started };
			`)) as { heading: string; ms: number };
			expect(result.heading).toBe("Unload page");
			expect(result.ms).toBeLessThan(1_000);
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
