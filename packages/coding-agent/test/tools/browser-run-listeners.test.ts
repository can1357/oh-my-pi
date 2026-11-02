import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// A shared promise, not a per-request resolver: releasing before Chrome's request reaches /slow still lets it finish.
const slowRelease = Promise.withResolvers<void>();
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/slow") {
			await slowRelease.promise;
			return new Response("slow", { headers: { "content-type": "text/plain" } });
		}
		return new Response("<!doctype html><title>listeners fixture</title>", {
			headers: { "content-type": "text/html" },
		});
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "browser-run-listeners-test" });
}

function valueOf(result: { details?: unknown }): unknown {
	return (result.details as { value?: unknown } | undefined)?.value;
}

afterAll(async () => {
	slowRelease.resolve();
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser run page listeners", () => {
	test("removes run-owned listeners and keeps worker listeners across runs", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "listeners", url: `${baseUrl}/` });
		const baseline = valueOf(
			await invoke({ action: "run", name: "listeners", code: `return page.listenerCount("console");` }),
		);
		expect(baseline).toBeGreaterThan(0);

		const during = valueOf(
			await invoke({
				action: "run",
				name: "listeners",
				code: `page.on("console", () => {}).once("console", () => {});
const added = page.listenerCount("console");
page.removeAllListeners();
return { added, cleared: page.listenerCount("console") };`,
			}),
		);
		expect(during).toEqual({ added: (baseline as number) + 2, cleared: baseline });

		await invoke({ action: "run", name: "listeners", code: `page.on("console", () => {}); return null;` });
		const after = valueOf(
			await invoke({ action: "run", name: "listeners", code: `return page.listenerCount("console");` }),
		);
		expect(after).toBe(baseline);
	}, 30_000);

	test("an escaped page reference removes only the run's listeners", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "escaped", url: `${baseUrl}/` });
		const counts = `return ["console", "request", "dialog"].map(type => page.listenerCount(type));`;
		const baseline = valueOf(await invoke({ action: "run", name: "escaped", code: counts })) as number[];
		const during = valueOf(
			await invoke({
				action: "run",
				name: "escaped",
				code: `const real = page.mainFrame().page();
real.on("console", () => {}).once("console", () => {});
const added = real.listenerCount("console");
real.removeAllListeners();
return added;`,
			}),
		);
		expect(during).toBe(baseline[0] + 2);
		const after = valueOf(await invoke({ action: "run", name: "escaped", code: counts }));
		expect(after).toEqual(baseline);
	}, 30_000);

	test("removes listeners a run-owned handler adds while handling an event", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "nested", url: `${baseUrl}/` });
		// Page `console` events never fire here (puppeteer does not enable Runtime); `request` does.
		const baseline = valueOf(
			await invoke({ action: "run", name: "nested", code: `return page.listenerCount("request");` }),
		);
		await invoke({
			action: "run",
			name: "nested",
			code: `const real = page.mainFrame().page();
const fired = Promise.withResolvers();
real.once("request", () => { real.on("request", () => {}); fired.resolve(); });
await page.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${baseUrl}/`)});
await fired.promise;
return null;`,
		});
		const after = valueOf(
			await invoke({ action: "run", name: "nested", code: `return page.listenerCount("request");` }),
		);
		expect(after).toBe(baseline);
	}, 30_000);

	test("removes page listeners a browser event callback adds during the run", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "callback", url: `${baseUrl}/` });
		const baseline = valueOf(
			await invoke({ action: "run", name: "callback", code: `return page.listenerCount("console");` }),
		);
		// Browser events arrive from the CDP socket, not from inside the run's code.
		await invoke({
			action: "run",
			name: "callback",
			code: `const fired = Promise.withResolvers();
browser.once("targetcreated", () => { page.on("console", () => {}).once("console", () => {}); fired.resolve(); });
const extra = await browser.newPage();
await fired.promise;
await extra.close();
return null;`,
		});
		const after = valueOf(
			await invoke({ action: "run", name: "callback", code: `return page.listenerCount("console");` }),
		);
		expect(after).toBe(baseline);
	}, 30_000);

	test("removes page listeners a browser event callback adds through raw page references", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "raw-callback", url: `${baseUrl}/` });
		const count = `return page.listenerCount("console");`;
		const baseline = valueOf(await invoke({ action: "run", name: "raw-callback", code: count }));
		// A captured `tab.page` and `mainFrame().page()` reach the page without the run facade.
		const register = `const captured = tab.page;
const fired = Promise.withResolvers();
browser.once("targetcreated", () => {
	captured.on("console", () => {});
	page.mainFrame().page().on("console", () => {}).once("console", () => {});
	fired.resolve();
});
const extra = await browser.newPage();
await fired.promise;
await extra.close();
return null;`;
		const counts: unknown[] = [];
		for (let run = 0; run < 3; run++) {
			await invoke({ action: "run", name: "raw-callback", code: register });
			counts.push(valueOf(await invoke({ action: "run", name: "raw-callback", code: count })));
		}
		expect(counts).toEqual([baseline, baseline, baseline]);
	}, 30_000);

	test("wildcard listeners receive the event type and payload", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "wildcard", url: `${baseUrl}/` });
		const url = `${baseUrl}/`;
		const seen = valueOf(
			await invoke({
				action: "run",
				name: "wildcard",
				code: `const seen = Promise.withResolvers();
page.on("*", (type, payload) => { if (type === "request") seen.resolve(payload?.url()); });
await page.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(url)});
return await seen.promise;`,
			}),
		);
		expect(seen).toBe(url);
	}, 30_000);

	test("run listeners keep puppeteer's ordering, once cancellation, payloads and requests", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "contract", url: `${baseUrl}/` });
		const result = valueOf(
			await invoke({
				action: "run",
				name: "contract",
				code: `const order = [];
const h = () => order.push("h");
const other = () => order.push("other");
page.on("contract", h).on("contract", other).on("contract", h).off("contract", h);
page.emit("contract", null);
let onceCalls = 0;
const counted = () => onceCalls++;
page.once("contract-once", counted).off("contract-once", counted);
page.emit("contract-once", null);
let reads = 0;
page.on("contract-payload", () => {});
page.emit("contract-payload", { get enqueueInterceptAction() { reads++; return undefined; } });
const seen = Promise.withResolvers();
page.once("request", request => seen.resolve(request));
await page.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${baseUrl}/`)});
const requestPatched = Object.hasOwn(await seen.promise, "enqueueInterceptAction");
return { order, onceCalls, reads, requestPatched };`,
			}),
		);
		// Puppeteer removes the first duplicate; a cancelled once still fires, as on a plain page;
		// requests, which the tab's request log keeps, are left as puppeteer made them.
		expect(result).toEqual({ order: ["other", "h"], onceCalls: 1, reads: 0, requestPatched: false });
	}, 30_000);

	test("puppeteer's own request subscriptions unsubscribe during a run", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "unsubscribe", url: `${baseUrl}/` });
		const counts = valueOf(
			await invoke({
				action: "run",
				name: "unsubscribe",
				code: `const count = () => ["requestfinished", "requestfailed", "response"].map(type => page.listenerCount(type));
const before = count();
await tab.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${baseUrl}/`)});
await page.waitForNetworkIdle({ idleTime: 200, timeout: 3000 });
return [before, count()];`,
			}),
		) as number[][];
		expect(counts[1]).toEqual(counts[0]);
	}, 30_000);

	test("a request finishing after its run does not stall network idle in the next run", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "idle", url: `${baseUrl}/` });
		await invoke({
			action: "run",
			name: "idle",
			code: `const seen = page.waitForRequest(request => request.url().endsWith("/slow"));
await tab.evaluate(url => { void fetch(url); }, ${JSON.stringify(`${baseUrl}/slow`)});
await seen;
return null;`,
		});
		slowRelease.resolve();
		const idle = valueOf(
			await invoke({
				action: "run",
				name: "idle",
				code: `await page.waitForNetworkIdle({ idleTime: 200, timeout: 3000 });
return "idle";`,
			}),
		);
		expect(idle).toBe("idle");
	}, 30_000);

	test("a run's async request handler resolves cooperative interception after it awaits", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "cooperative", url: `${baseUrl}/` });
		const body = valueOf(
			await invoke({
				action: "run",
				name: "cooperative",
				code: `await page.setRequestInterception(true);
// A socket round trip: puppeteer has left its synchronous dispatch before the handler resolves.
page.on("request", async request => {
	await (await fetch(${JSON.stringify(`${baseUrl}/`)})).text();
	await request.continue({}, 0);
});
return await tab.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${baseUrl}/`)});`,
				timeout: 5,
			}),
		);
		expect(body).toContain("listeners fixture");
	}, 30_000);
});
