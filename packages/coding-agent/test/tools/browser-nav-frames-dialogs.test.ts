import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { navigateMainFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { PrintHold } from "@oh-my-pi/pi-coding-agent/tools/browser/print-hold";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { type AttachPage, printHoldScope } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer, { type CDPSession, type Dialog, type Page, type WaitForOptions } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// The page in the omp-launched print test waits on `/print-gate` to print, then reports through `/printed`: the test
// opens the gate between two calls and waits for the report.
const printGate = Promise.withResolvers<void>();
const pagePrinted = Promise.withResolvers<void>();
const server = Bun.serve({
	port: 0,
	// `/never-ends` must outlive the run budget instead of Bun's 10s idle cut.
	idleTimeout: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/print-gate") return printGate.promise.then(() => new Response("open"));
		if (pathname === "/printed") {
			pagePrinted.resolve();
			return new Response("ok");
		}
		if (pathname === "/never-ends") {
			// A frame document whose body never closes, like an ad or chat widget that keeps streaming.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("<p>partial</p>"));
					},
				}),
				{ headers: { "content-type": "text/html" } },
			);
		}
		if (pathname === "/stuck-frame") {
			return new Response(`<!doctype html><title>stuck</title><iframe src="/never-ends"></iframe>`, {
				headers: { "content-type": "text/html" },
			});
		}
		if (pathname === "/late-frame") {
			return new Response(
				`<!doctype html><title>late</title><script>addEventListener("load", () => { const frame = document.createElement("iframe"); frame.src = "/never-ends"; document.body.append(frame); });</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		const iframe = `<iframe id="f" name="payment" srcdoc="<!doctype html><input id='in'><div id='out'>ready</div><script>document.querySelector('#in').addEventListener('input',e=>document.querySelector('#out').textContent=e.target.value)</script>"></iframe>`;
		const headers = { "content-type": "text/html" };
		if (pathname === "/card") return new Response(`<input aria-label="Card"><button>Pay</button>`, { headers });
		// Answers its load, then never returns from script again.
		if (pathname === "/stuck") {
			return new Response(
				`<button>Stuck</button><script>onload = () => setTimeout(() => { for (;;) {} })</script>`,
				{
					headers,
				},
			);
		}
		if (pathname === "/observe-frames") {
			// localhost and 127.0.0.1 are different sites, so the frame runs out of process.
			const card = `http://localhost:${new URL(request.url).port}/card`;
			return new Response(
				`<section id="checkout" aria-label="Checkout"><button>Main</button><iframe id="pay" src="${card}"></iframe></section><iframe srcdoc="<button>Outside</button>"></iframe>`,
				{ headers },
			);
		}
		if (pathname === "/observe-shadow-frame") {
			const card = `http://localhost:${new URL(request.url).port}/card`;
			return new Response(
				`<section id="checkout"><button>Main</button><pay-widget></pay-widget></section><script>
					customElements.define("pay-widget", class extends HTMLElement {
						constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<iframe src="${card}"></iframe>'; }
					});
				</script>`,
				{ headers },
			);
		}
		if (pathname === "/observe-stuck-frame") {
			const stuck = `http://localhost:${new URL(request.url).port}/stuck`;
			return new Response(`<button>Main</button><iframe id="stuck" src="${stuck}"></iframe>`, { headers });
		}
		if (pathname === "/print" || pathname === "/print-on-load") {
			// `log` records what the page saw: Chrome fires afterprint only once a print finished, and headless Chrome
			// returns from an unheld print() without printing anything.
			return new Response(
				`<button id="print">Print</button><button id="confirm-print">Print after asking</button><button id="popup-print">Print a receipt</button><button id="popup-url-print">Open a receipt</button><a id="link-print" href="/receipt-alone" target="_blank">Receipt</a><button id="noopener-print">Open a receipt alone</button><script>
					globalThis.log = [];
					addEventListener("afterprint", () => log.push("afterprint"));
					addEventListener("pageshow", event => { if (event.persisted) log.push("restored"); });
					document.querySelector("#print").addEventListener("click", () => { print(); log.push("print returned"); });
					document.querySelector("#confirm-print").addEventListener("click", () => { if (confirm("Print?")) print(); log.push("asked print returned"); });
					document.querySelector("#popup-print").addEventListener("click", () => {
						const receipt = open("");
						receipt.document.write("<p>receipt</p>");
						receipt.addEventListener("afterprint", () => log.push("receipt afterprint"));
						receipt.print();
						log.push("receipt print returned");
						receipt.close();
					});
					document.querySelector("#popup-url-print").addEventListener("click", () => void open("/receipt"));
					document.querySelector("#noopener-print").addEventListener("click", () => void open("/receipt-alone", "_blank", "noopener"));
					if (location.pathname === "/print-on-load") addEventListener("load", () => { print(); log.push("load print returned"); });
					// Restored from the back/forward cache, a handler keeps the page busy past the 1.5 s tail, then prints.
					if (location.search === "?slow-restore") addEventListener("pageshow", event => {
						if (!event.persisted) return;
						const until = Date.now() + 2_000;
						while (Date.now() < until);
						print();
						log.push("restore print returned");
					});
				</script>`,
				{ headers },
			);
		}
		if (pathname === "/receipt-alone" || pathname === "/receipt-slow") {
			// A receipt window with no way back to the page that opened it, printing as it loads; the slow one first keeps
			// its renderer busy 2 s, longer than the release tail, so nothing omp sends reaches it before it prints.
			const busy =
				pathname === "/receipt-slow" ? "const until = Date.now() + 2_000; while (Date.now() < until);" : "";
			return new Response(
				`<p>receipt</p><script>
					globalThis.log = [];
					addEventListener("afterprint", () => log.push("afterprint"));
					${busy}
					print();
					log.push("print returned");
				</script>`,
				{ headers },
			);
		}
		if (pathname === "/receipt") {
			// A receipt window that prints as it loads, reporting to the page that opened it.
			return new Response(
				`<p>receipt</p><script>
					addEventListener("afterprint", () => opener.log.push("receipt afterprint"));
					print();
					opener.log.push("receipt print returned");
				</script>`,
				{ headers },
			);
		}
		return new Response(
			`<!doctype html><title>${pathname}</title><body data-path="${pathname}">${iframe}<script>
				sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1));
				globalThis.confirmResult = null;
				globalThis.promptResult = null;
			</script></body>`,
			{ headers: { "content-type": "text/html" } },
		);
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
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-nav-frames-dialogs-test", signal });
}

function valueOf(result: { details?: unknown }): unknown {
	const { details } = result;
	if (!details || typeof details !== "object" || !("value" in details)) return undefined;
	return details.value;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap(part => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

/** Runs `use` against a headless Chromium omp did not launch, standing in for the user's own browser. */
async function withUserBrowser(use: (cdpUrl: string) => Promise<void>): Promise<void> {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-connected-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-sandbox",
			"--no-first-run",
			"--use-mock-keychain",
			// Linux Chrome otherwise waits about 25 s on the desktop keyring before its first navigation.
			"--password-store=basic",
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	try {
		const cdpUrl = `http://127.0.0.1:${port}`;
		await waitForCdp(cdpUrl, 15_000);
		await use(cdpUrl);
	} finally {
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function observe(invoke: (parameters: unknown) => Promise<{ details?: unknown }>, name: string, options: object) {
	const { elements } = valueOf(
		await invoke({ action: "call", name, chain: [{ method: "observe", args: [options] }] }),
	) as { elements: Array<{ id: number; role: string; name: string }> };
	return { elements, names: elements.map(entry => `${entry.role}:${entry.name}`) };
}

/** The clock the print hold reads in a page, which the page's own scripts never touch. */
const PRINT_HOLD_CLOCK = 'globalThis[Symbol.for("omp.printHold.clock")]';

/** Sets the print hold's clock in the page `ms` ahead of the page's real one, as if that much time had passed. */
async function advancePrintClock(page: Page, ms: number): Promise<void> {
	await page
		.mainFrame()
		.mainRealm()
		.evaluate(`{ const real = Date.now; ${PRINT_HOLD_CLOCK} = () => real() + ${ms}; }`);
}

/** Waits until the end of omp's call reached the page: every print hold in it ends within the 1.5 s release. */
async function untilCallEnded(page: Page): Promise<void> {
	await page
		.mainFrame()
		.mainRealm()
		.waitForFunction(
			`Object.getOwnPropertySymbols(globalThis)
				.filter(key => key.description?.endsWith(".until"))
				.every(key => globalThis[key] - ${PRINT_HOLD_CLOCK}() <= 1_500)`,
			{ timeout: 0, polling: 50 },
		);
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
});

/** `page` with its browser's `target()` replaced, for the hold to attach the page's windows through. */
function withBrowserTarget(page: Page, target: () => unknown): Page {
	const bound = (object: object, key: string | symbol): unknown => {
		const value: unknown = Reflect.get(object, key);
		return typeof value === "function" ? value.bind(object) : value;
	};
	const browser = new Proxy(page.browser(), {
		get: (object, key) => (key === "target" ? target : bound(object, key)),
	});
	return new Proxy(page, { get: (object, key) => (key === "browser" ? () => browser : bound(object, key)) });
}

/** `page` as the relay hands it over: its browser has no target omp could attach the page's windows through. */
function withoutBrowserTarget(page: Page): Page {
	return withBrowserTarget(page, () => {
		throw new Error("Browser target is not found");
	});
}

function fakePage(frame: { _lifecycleEvents: Set<string>; detached?: boolean }, closed = () => false): Page {
	return {
		mainFrame: () => frame,
		isClosed: closed,
		browser: () => ({ connected: true }),
	} as unknown as Page;
}

// Both detach tests flip state on the wait's second read: one poll still sees a live frame,
// then the frame goes away mid-wait. A wait that ignores it would run out the 10s budget.
test("stops waiting as soon as the navigating main frame detaches", async () => {
	let reads = 0;
	const frame = {
		_lifecycleEvents: new Set<string>(),
		get detached() {
			reads += 1;
			return reads > 1;
		},
	};
	await expect(navigateMainFrame(fakePage(frame), "load", 10_000, undefined, async () => null)).rejects.toThrow(
		"Navigating frame was detached",
	);
	expect(reads).toBe(2);
});

test("stops waiting as soon as the page closes", async () => {
	let checks = 0;
	const closed = () => ++checks > 1;
	await expect(
		navigateMainFrame(
			fakePage({ _lifecycleEvents: new Set() }, closed),
			"domcontentloaded",
			10_000,
			undefined,
			async () => null,
		),
	).rejects.toThrow("Navigating frame was detached");
	expect(checks).toBe(2);
});

test("holds print() for a tab's life only on a page omp created in a browser it launched", () => {
	const attach = (page: AttachPage, userDriven?: boolean) =>
		printHoldScope({ mode: "attach", browserWSEndpoint: "", safeDir: "", uploadDir: "", page, userDriven });
	expect(printHoldScope({ mode: "headless", browserWSEndpoint: "", safeDir: "", uploadDir: "" })).toBe("tab");
	expect(attach({ kind: "create" })).toBe("tab");
	expect(attach({ kind: "owned", targetId: "T" })).toBe("tab");
	// A page a spawned app keeps after omp lets go (`app.target`), and the user's own browser.
	expect(attach({ kind: "borrowed", targetId: "T" })).toBe("calls");
	expect(attach({ kind: "create" }, true)).toBe("calls");
});

test("hands any waitUntil other than load/domcontentloaded to Puppeteer unchanged", async () => {
	const seen: unknown[] = [];
	const page = fakePage({ _lifecycleEvents: new Set() });
	const values: NonNullable<WaitForOptions["waitUntil"]>[] = ["networkidle0", ["load", "networkidle2"]];
	for (const waitUntil of values) {
		await navigateMainFrame(page, waitUntil, 1_000, undefined, async options => seen.push(options.waitUntil));
	}
	expect(seen).toEqual(["networkidle0", ["load", "networkidle2"]]);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser navigation, frames, dialogs, and tab listing", () => {
	test("drives history and SPA navigation without reloading", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "nav", url: `${baseUrl}/one` });
		await invoke({ action: "call", name: "nav", chain: [{ method: "goto", args: [`${baseUrl}/two`] }] });

		await invoke({ action: "call", name: "nav", chain: [{ method: "back", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/one`,
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "forward", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);

		const beforeReload = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "reload", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(Number(beforeReload) + 1);

		const beforePush = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		expect(
			valueOf(
				await invoke({ action: "call", name: "nav", chain: [{ method: "pushState", args: [`${baseUrl}/spa`] }] }),
			),
		).toBe(`${baseUrl}/spa`);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(beforePush);
	}, 30_000);

	test("navigates pages whose child frame never finishes loading", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "stuck", url: `${baseUrl}/one` });
		const result = await invoke({
			action: "run",
			name: "stuck",
			timeout: 10,
			code: `
				// The main document's load fires before its never-ending frame is added.
				await tab.goto(${JSON.stringify(`${baseUrl}/late-frame`)});
				// The main document is parsed; its frame never finishes.
				await tab.goto(${JSON.stringify(`${baseUrl}/stuck-frame`)}, { waitUntil: "domcontentloaded" });
				await tab.back();
				await tab.forward({ waitUntil: "domcontentloaded" });
				await tab.reload({ waitUntil: "domcontentloaded" });
				return [tab.url(), await tab.evaluate(() => document.readyState)];
			`,
		});
		expect(valueOf(result)).toEqual([`${baseUrl}/stuck-frame`, "interactive"]);
	}, 60_000);

	test("validates Playwright-style and array waitUntil values through Puppeteer", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "wait-values", url: `${baseUrl}/one` });
		const result = await invoke({
			action: "run",
			name: "wait-values",
			timeout: 20,
			code: `
				let message = "";
				try {
					await tab.goto(${JSON.stringify(`${baseUrl}/two`)}, { waitUntil: "networkidle" });
				} catch (error) {
					message = String(error?.message ?? error);
				}
				await tab.goto(${JSON.stringify(`${baseUrl}/three`)}, { waitUntil: ["load", "domcontentloaded"] });
				return [message, tab.url()];
			`,
		});
		const [message, url] = valueOf(result) as [string, string];
		expect(message).toContain("Unknown value for options.waitUntil: networkidle");
		expect(url).toBe(`${baseUrl}/three`);
	}, 60_000);

	test("auto-accepts alerts and explicitly settles confirm and prompt dialogs", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "dialogs", url: `${baseUrl}/dialogs` });
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => { alert("notice"); return "continued"; });',
				}),
			),
		).toBe("continued");

		const confirmDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.confirmResult = confirm("continue?"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(confirmDialog).toEqual({
			open: true,
			type: "confirm",
			message: "continue?",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.confirmResult);",
				}),
			),
		).toBe(true);

		const promptDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.promptResult = prompt("name?", "initial"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(promptDialog).toEqual({
			open: true,
			type: "prompt",
			message: "name?",
			defaultValue: "initial",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true, text: "Ada" }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.promptResult);",
				}),
			),
		).toBe("Ada");

		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: ["dismiss"] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => confirm("auto-dismissed"));',
				}),
			),
		).toBe(false);
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: [null] }],
		});
	}, 30_000);

	test("holds print() in a tab omp launched, during its calls and between them, and says so", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "print", url: `${baseUrl}/print` });
		const clicked = await invoke({
			action: "run",
			name: "print",
			code: 'await tab.click("#print"); return await tab.evaluate(() => globalThis.log);',
		});
		expect(valueOf(clicked)).toEqual(["afterprint", "print returned"]);
		expect(textOf(clicked)).toContain("The page called window.print()");
		expect(textOf(clicked)).toContain("tab.pdf()");

		// A page that prints after the call returned: nobody but omp drives this browser, so it stays held. The page
		// waits on the test's gate, opened only once the call has returned.
		await invoke({
			action: "run",
			name: "print",
			code: 'await tab.evaluate(() => { void fetch("/print-gate").then(() => { document.querySelector("#print").click(); return fetch("/printed"); }); });',
		});
		printGate.resolve();
		await pagePrinted.promise;
		const later = await invoke({
			action: "run",
			name: "print",
			code: "return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(later)).toEqual(["afterprint", "print returned", "afterprint", "print returned"]);
		expect(textOf(later)).toContain("The page called window.print()");
	});

	test("reports a print the page makes while the open navigates to it", async () => {
		const invoke = createHost();
		const opened = await invoke({ action: "open", name: "print-open", url: `${baseUrl}/print-on-load` });
		expect(textOf(opened)).toContain("The page called window.print()");
		const log = await invoke({
			action: "run",
			name: "print-open",
			code: "return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(log)).toEqual(["afterprint", "load print returned"]);
	});

	test("holds print() in the user's own browser only around omp's calls", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-print", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				// A document the call navigates to starts held, so a page printing as it loads is caught too.
				const loaded = await invoke({
					action: "run",
					name: "user-print",
					code: `await tab.goto(${JSON.stringify(`${baseUrl}/print-on-load`)}); return await tab.evaluate(() => globalThis.log);`,
				});
				expect(valueOf(loaded)).toEqual(["afterprint", "load print returned"]);
				expect(textOf(loaded)).toContain("The page called window.print()");

				// The hold ends 1.5 s after the call on the page's clock; past it, the user's own click prints.
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print-on-load"));
					if (!page) throw new Error("Expected the print page in the user's browser");
					await untilCallEnded(page);
					await advancePrintClock(page, 1_500);
					await page.evaluate('document.querySelector("#print").click()');
				} finally {
					await user.disconnect();
				}
				const after = await invoke({
					action: "run",
					name: "user-print",
					code: "return await tab.evaluate(() => globalThis.log);",
				});
				expect(valueOf(after)).toEqual(["afterprint", "load print returned", "print returned"]);
				expect(textOf(after)).not.toContain("window.print()");
			} finally {
				await invoke({ action: "close", name: "user-print" }).catch(() => {});
			}
		});
	}, 30_000);

	test("holds print() in a page the call brings back from the back/forward cache", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-bfcache", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				// Past the release on the page's clock, the user leaves the page; it is cached released.
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print"));
					if (!page) throw new Error("Expected the print page in the user's browser");
					await untilCallEnded(page);
					await advancePrintClock(page, 1_500);
					await page.goto(`${baseUrl}/print-on-load`);
				} finally {
					await user.disconnect();
				}
				const restored = await invoke({
					action: "run",
					name: "user-bfcache",
					code: `await tab.back();
return await tab.evaluate(() => {
	document.querySelector("#print").click();
	return globalThis.log;
});`,
				});
				expect(valueOf(restored)).toEqual(["restored", "afterprint", "print returned"]);
			} finally {
				await invoke({ action: "close", name: "user-bfcache" }).catch(() => {});
			}
		});
	}, 30_000);

	test("lets go of a page cached during a call once it is restored after omp has gone", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			await invoke({ action: "open", name: "user-gone", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
			// The page leaves the cache held for the 30 s call budget; then omp lets go of the tab.
			await invoke({
				action: "run",
				name: "user-gone",
				code: `await tab.goto(${JSON.stringify(`${baseUrl}/print-on-load`)});`,
				timeout: 30,
			});
			await invoke({ action: "close", name: "user-gone" });
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print-on-load"));
				if (!page) throw new Error("Expected the print page in the user's browser");
				await page.goBack();
				// The restored page holds for 1.5 s on its own clock, not for the rest of the call it was cached in.
				await advancePrintClock(page, 1_500);
				const clicked = await page
					.mainFrame()
					.mainRealm()
					.evaluate('document.querySelector("#print").click(); globalThis.log');
				expect(clicked).toEqual(["restored", "print returned"]);
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in the user's browser while the page fakes its clock", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-clock", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				const clicked = await invoke({
					action: "run",
					name: "user-clock",
					code: `return await tab.evaluate(() => {
	Date.now = () => 8.64e15;
	document.querySelector("#print").click();
	return globalThis.log;
});`,
				});
				expect(valueOf(clicked)).toEqual(["afterprint", "print returned"]);
			} finally {
				await invoke({ action: "close", name: "user-clock" }).catch(() => {});
			}
		});
	}, 30_000);

	test("keeps one attachment's print hold when another attaches to the same page", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const first = await PrintHold.install(page, "calls");
				try {
					await page.goto(`${baseUrl}/print`);
					await first.beginCall(30_000);
					// A second attachment that finishes its setup and lets go must not release the first one's call.
					const second = await PrintHold.install(page, "calls");
					try {
						await second.endCall();
						// Past the second one's 1.5 s release on the page's clock; the first one's call holds for 30 s.
						await advancePrintClock(page, 1_500);
						const clicked = await page
							.mainFrame()
							.mainRealm()
							.evaluate('document.querySelector("#print").click(); globalThis.log');
						expect(clicked).toEqual(["afterprint", "print returned"]);
					} finally {
						await second.dispose();
					}
				} finally {
					await first.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("moves and releases the print hold without waiting on a page stopped in a dialog", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				const confirmOpened = async (message: string): Promise<Dialog> => {
					const { promise, resolve } = Promise.withResolvers<Dialog>();
					page.once("dialog", resolve);
					await page.evaluate(text => void setTimeout(() => confirm(text)), message);
					return await promise;
				};
				const stay = await confirmOpened("Stay?");
				// A call's start used to wait on the stopped page until someone answered the dialog.
				await hold.beginCall(30_000);
				await stay.dismiss();
				// Once the dialog closes, the page gets the call's hold: a Print click comes back held.
				await page
					.mainFrame()
					.mainRealm()
					.waitForFunction(
						'log.length = 0, document.querySelector("#print").click(), log.includes("afterprint")',
						{ timeout: 0, polling: 50 },
					);
				const close = await confirmOpened("Close?");
				// Closing the tab used to wait here until the tab worker was killed.
				await hold.dispose();
				await close.dismiss();
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds the print a confirm opened during a call leads to, though the hold ran out while it waited", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				// The confirm answers after 60 s on the page's clock, well past the call's hold.
				await page.evaluateOnNewDocument(
					`{ const real = Date.now; let waited = 0; ${PRINT_HOLD_CLOCK} = () => real() + waited; const ask = confirm; confirm = (...args) => { const answer = ask(...args); waited += 60_000; return answer; }; }`,
				);
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					const { promise, resolve } = Promise.withResolvers<Dialog>();
					page.once("dialog", resolve);
					await page
						.mainFrame()
						.mainRealm()
						.evaluate('void setTimeout(() => document.querySelector("#confirm-print").click())');
					const asked = await promise;
					await hold.endCall();
					// The page went on to print() before omp could hold it again, and the print preview opened.
					await asked.accept();
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"afterprint",
						"asked print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test.each([
		["a connected browser", (page: Page) => page],
		["the relay, which reaches no window", withoutBrowserTarget],
	])(
		"holds print() in a window the page opens to print from, in %s",
		async (_where, handOver) => {
			await withUserBrowser(async cdpUrl => {
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = await user.newPage();
					await page.goto(`${baseUrl}/print`);
					const hold = await PrintHold.install(handOver(page), "calls");
					try {
						await hold.beginCall(30_000);
						// The receipt window's own print() was never held, so its preview blocked this page too.
						expect(
							await page
								.mainFrame()
								.mainRealm()
								.evaluate('document.querySelector("#popup-print").click(); globalThis.log'),
						).toEqual(["receipt afterprint", "receipt print returned"]);
						// The tab's printout would not be the window's: the notice says a window printed, without `tab.pdf()`.
						const notice = hold.takeNotice();
						expect(notice).toContain("A window the page opened called window.print()");
						expect(notice).not.toContain("tab.pdf()");
					} finally {
						await hold.dispose();
					}
				} finally {
					await user.disconnect();
				}
			});
		},
		30_000,
	);

	test.each(["calls", "tab"] as const)(
		"moves and releases a window's %s print hold with the tab's calls, after the page that opened it leaves",
		async scope => {
			await withUserBrowser(async cdpUrl => {
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = await user.newPage();
					await page.goto(`${baseUrl}/print`);
					const hold = await PrintHold.install(page, scope);
					let disposed = false;
					try {
						await hold.beginCall(30_000);
						const popupTarget = user.waitForTarget(target => target.opener() === page.target());
						await page.mainFrame().mainRealm().evaluate('open("")');
						const popup = await (await popupTarget).page();
						if (!popup) throw new Error("Expected the receipt popup");
						try {
							await popup
								.mainFrame()
								.mainRealm()
								.evaluate('globalThis.log = []; addEventListener("afterprint", () => log.push("afterprint"));');
							const print = 'log.length = 0; print(); log.push("print returned"); log';
							const held = ["afterprint", "print returned"];
							// The window reports through the page that opened it, while it can reach that page.
							expect(await popup.mainFrame().mainRealm().evaluate(print)).toEqual(held);
							const notice = hold.takeNotice();
							expect(notice).toContain("A window the page opened called window.print()");
							expect(notice).not.toContain("tab.pdf()");
							// The window's own hold does not depend on the page that opened it.
							await page.goto(baseUrl.replace("127.0.0.1", "localhost"));
							expect(await popup.mainFrame().mainRealm().evaluate(print)).toEqual(held);
							await hold.endCall();
							await advancePrintClock(popup, 1_500);
							expect(await popup.mainFrame().mainRealm().evaluate(print)).toEqual(
								scope === "calls" ? ["print returned"] : ["afterprint", "print returned"],
							);
							await hold.dispose();
							disposed = true;
							expect(await popup.mainFrame().mainRealm().evaluate(print)).toEqual(["print returned"]);
						} finally {
							await popup.close();
						}
					} finally {
						if (!disposed) await hold.dispose();
					}
				} finally {
					await user.disconnect();
				}
			});
		},
		30_000,
	);

	test.each([
		["a link with a target", "#link-print"],
		["open() with noopener", "#noopener-print"],
	])(
		"holds print() in the first document of a window the page opens through %s",
		async (_how, control) => {
			await withUserBrowser(async cdpUrl => {
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = await user.newPage();
					await page.goto(`${baseUrl}/print`);
					const hold = await PrintHold.install(page, "calls");
					try {
						await hold.beginCall(30_000);
						// No window comes back to the page, and the receipt prints before omp could reach it through puppeteer.
						const popupTarget = user.waitForTarget(target => target.opener() === page.target());
						await page
							.mainFrame()
							.mainRealm()
							.evaluate(`document.querySelector(${JSON.stringify(control)}).click()`);
						const popup = await (await popupTarget).page();
						if (!popup) throw new Error("Expected the receipt popup");
						try {
							await popup
								.mainFrame()
								.mainRealm()
								.waitForFunction('globalThis.log?.includes("print returned")', { timeout: 0, polling: 50 });
							expect(await popup.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
								"afterprint",
								"print returned",
							]);
						} finally {
							await popup.close();
						}
					} finally {
						await hold.dispose();
					}
				} finally {
					await user.disconnect();
				}
			});
		},
		30_000,
	);

	test("holds print() in a window's documents for the whole call, not only the release tail", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					const popupTarget = user.waitForTarget(target => target.opener() === page.target());
					await page.mainFrame().mainRealm().evaluate('document.querySelector("#popup-url-print").click()');
					const popup = await (await popupTarget).page();
					if (!popup) throw new Error("Expected the receipt popup");
					try {
						// The first receipt reports to this page; the second keeps its renderer busy past the 1.5 s release
						// tail, then prints, all within the call.
						await page
							.mainFrame()
							.mainRealm()
							.waitForFunction('log.includes("receipt print returned")', { timeout: 0, polling: 50 });
						expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
							"receipt afterprint",
							"receipt print returned",
						]);
						await popup.goto(`${baseUrl}/receipt-slow`);
						expect(await popup.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
							"afterprint",
							"print returned",
						]);
					} finally {
						await popup.close();
					}
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("moves and releases popup print holds without waiting on the popup's dialog", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				await hold.beginCall(30_000);
				const popupTarget = user.waitForTarget(target => target.opener() === page.target());
				await page.mainFrame().mainRealm().evaluate('open("")');
				const popup = await (await popupTarget).page();
				if (!popup) throw new Error("Expected the receipt popup");
				await page.goto(baseUrl.replace("127.0.0.1", "localhost"));
				const { promise, resolve } = Promise.withResolvers<Dialog>();
				popup.once("dialog", resolve);
				const confirmation = popup.mainFrame().mainRealm().evaluate('confirm("Stay?")');
				const dialog = await promise;
				try {
					await hold.endCall();
					await hold.beginCall(30_000);
					await hold.dispose();
				} finally {
					await dialog.dismiss();
				}
				await confirmation;
				expect(
					await popup
						.mainFrame()
						.mainRealm()
						.evaluate(
							'globalThis.log = []; addEventListener("afterprint", () => log.push("afterprint")); print(); log.push("print returned"); log',
						),
				).toEqual(["print returned"]);
				await popup.close();
			} finally {
				await user.disconnect();
			}
		});
	});

	test("holds print() in a window its tab opens while another tab's hold lets that window go", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				// The other tab's hold attaches every new window first and lets go of this tab's at once.
				const other = await user.newPage();
				const otherHold = await PrintHold.install(other, "calls");
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					const popupTarget = user.waitForTarget(target => target.opener() === page.target());
					await page.mainFrame().mainRealm().evaluate('document.querySelector("#noopener-print").click()');
					const popup = await (await popupTarget).page();
					if (!popup) throw new Error("Expected the receipt popup");
					try {
						await popup
							.mainFrame()
							.mainRealm()
							.waitForFunction('globalThis.log?.includes("print returned")', { timeout: 0, polling: 50 });
						expect(await popup.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
							"afterprint",
							"print returned",
						]);
					} finally {
						await popup.close();
					}
				} finally {
					await hold.dispose();
					await otherHold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("arms the loaded page before the hold's own setup round trips", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				// The hold's setup stays in flight until the page shows a held print.
				const setup = Promise.withResolvers<void>();
				const bound = (object: object, key: string | symbol): unknown => {
					const value: unknown = Reflect.get(object, key);
					return typeof value === "function" ? value.bind(object) : value;
				};
				const slowed = new Proxy(page, {
					get: (target, key) =>
						key === "createCDPSession"
							? async () => {
									const session = await target.createCDPSession();
									const send = session.send.bind(session);
									return new Proxy(session, {
										get: (object, name) =>
											name === "send"
												? async (...args: Parameters<typeof send>) => {
														if (args[0] === "Page.enable") await setup.promise;
														return await send(...args);
													}
												: bound(object, name),
									});
								}
							: bound(target, key),
				});
				const installing = PrintHold.install(slowed, "calls");
				await page
					.mainFrame()
					.mainRealm()
					.waitForFunction(
						'log.length = 0, document.querySelector("#print").click(), log.includes("afterprint")',
						{ timeout: 10_000, polling: 50 },
					);
				setup.resolve();
				await (await installing).dispose();
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("arms the loaded page before attaching the windows it may open", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				// Attaching windows stays in flight until the page shows a held print.
				const attaching = Promise.withResolvers<never>();
				const installing = PrintHold.install(
					withBrowserTarget(page, () => ({ createCDPSession: () => attaching.promise })),
					"calls",
				);
				await page
					.mainFrame()
					.mainRealm()
					.waitForFunction(
						'log.length = 0, document.querySelector("#print").click(), log.includes("afterprint")',
						{ timeout: 0, polling: 50 },
					);
				attaching.reject(new Error("Browser target is not found"));
				await (await installing).dispose();
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("leaves alone a window another tab in the browser opens", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "tab");
				try {
					// The user's own tab in the same browser opens a receipt that prints as it loads.
					const other = await user.newPage();
					await other.goto(`${baseUrl}/print`);
					const popupTarget = user.waitForTarget(target => target.opener() === other.target());
					await other.mainFrame().mainRealm().evaluate('document.querySelector("#link-print").click()');
					const popup = await (await popupTarget).page();
					if (!popup) throw new Error("Expected the receipt popup");
					try {
						await popup
							.mainFrame()
							.mainRealm()
							.waitForFunction('globalThis.log?.includes("print returned")', { timeout: 0, polling: 50 });
						expect(await popup.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual(["print returned"]);
					} finally {
						await popup.close();
					}
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() an init script the tab adds after the hold kept for later", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const hold = await PrintHold.install(page, "calls");
				try {
					// Added the way the tab worker adds its init scripts, after the hold; each call moves the deadline.
					await page.evaluateOnNewDocument(
						'const keptPrint = print; addEventListener("load", () => { keptPrint(); log.push("load print returned"); });',
					);
					await hold.beginCall(30_000);
					await page.goto(`${baseUrl}/print`);
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"afterprint",
						"load print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() an init script makes after outlasting the release tail during a call", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const hold = await PrintHold.install(page, "calls");
				try {
					// Runs after the hold's first script and before the one carrying the call's deadline, busy past 1.5 s.
					await page.evaluateOnNewDocument(
						'{ let printed = false; addEventListener("afterprint", () => { printed = true; }, { once: true }); const until = Date.now() + 2_000; while (Date.now() < until); print(); globalThis.initPrintHeld = printed; }',
					);
					await hold.beginCall(30_000);
					await page.goto(`${baseUrl}/print`);
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.initPrintHeld")).toBe(true);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("keeps the call's hold through a restored page's own pageshow handler", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					// Loaded under the hold, so its restore listener runs ahead of the page's own.
					await page.goto(`${baseUrl}/print?slow-restore`);
					await page.goto(`${baseUrl}/one`);
					await page.goBack();
					await page
						.mainFrame()
						.mainRealm()
						.waitForFunction('log.includes("restore print returned")', { timeout: 0, polling: 50 });
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"restored",
						"afterprint",
						"restore print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test.each([
		// Another script on the session keeps Chrome's numbering past the lost one: removing it answers `Script not found`.
		["the next one gets a new number", true],
		// Nothing else on the session: Chrome gives the next script the lost one's number.
		["the next one gets its number", false],
	])(
		"keeps holding print() in a call when Chrome has lost the hold's script and %s",
		async (_case, another) => {
			await withUserBrowser(async cdpUrl => {
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = await user.newPage();
					// The hold's own session, and the scripts Chrome registered on it.
					const scripts: string[] = [];
					let holdSession: CDPSession | undefined;
					const watched = new Proxy(page, {
						get: (target, key) =>
							key === "createCDPSession"
								? async () => {
										const session = await target.createCDPSession();
										holdSession = session;
										const send = session.send.bind(session);
										return new Proxy(session, {
											get: (object, name) => {
												if (name !== "send") {
													const value: unknown = Reflect.get(object, name);
													return typeof value === "function" ? value.bind(object) : value;
												}
												return async (...args: Parameters<typeof send>) => {
													const result = await send(...args);
													if (
														args[0] === "Page.addScriptToEvaluateOnNewDocument" &&
														typeof result === "object" &&
														"identifier" in result
													) {
														scripts.push(String(result.identifier));
													}
													return result;
												};
											},
										});
									}
								: (() => {
										const value: unknown = Reflect.get(target, key);
										return typeof value === "function" ? value.bind(target) : value;
									})(),
					});
					const hold = await PrintHold.install(watched, "calls");
					try {
						// Chrome loses the hold's current script, as it had in a relay tab between two calls of a run.
						const current = scripts.at(-1);
						if (!holdSession || !current) throw new Error("Expected the hold's script");
						if (another) await holdSession.send("Page.addScriptToEvaluateOnNewDocument", { source: ";" });
						await holdSession.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: current });
						// This used to fail the call with `Script not found`, or remove the script it had just added.
						await hold.beginCall(30_000);
						// Past the 1.5 s the first script holds a new document for, only the call's deadline holds.
						await page.goto(`${baseUrl}/print`);
						await advancePrintClock(page, 1_500);
						expect(
							await page
								.mainFrame()
								.mainRealm()
								.evaluate('document.querySelector("#print").click(); globalThis.log'),
						).toEqual(["afterprint", "print returned"]);
					} finally {
						await hold.dispose();
					}
				} finally {
					await user.disconnect();
				}
			});
		},
		30_000,
	);

	test.each([
		["Date.now", "Date.now = () => 1_000"],
		// A harness that also virtualizes the performance timeline leaves only an event's own time stamp real.
		["Date.now and the performance clock", "Date.now = () => 1_000; Performance.prototype.now = () => 0"],
	])(
		"lets go of print() after a call in a page whose own fake clock replaced %s before omp came",
		async (_what, fake) => {
			await withUserBrowser(async cdpUrl => {
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = await user.newPage();
					await page.goto(`${baseUrl}/print`);
					// Fake timers that never advance, installed by the page before omp attached.
					await page.mainFrame().mainRealm().evaluate(fake);
					const hold = await PrintHold.install(page, "calls");
					try {
						await hold.endCall();
						// The 1.5 s release runs out on real time; on the fake clock it never would.
						await page
							.mainFrame()
							.mainRealm()
							.waitForFunction(
								'log.length = 0, document.querySelector("#print").click(), log.join() === "print returned"',
								{ timeout: 10_000, polling: 100 },
							);
					} finally {
						await hold.dispose();
					}
				} finally {
					await user.disconnect();
				}
			});
		},
		30_000,
	);

	test("lets go of a restored page whose paused fake timers replaced setTimeout before omp came, once omp has gone", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				// Paused fake timers: nothing scheduled through them ever runs.
				await page.mainFrame().mainRealm().evaluate("setTimeout = () => 0");
				const hold = await PrintHold.install(page, "calls");
				await hold.endCall();
				await hold.dispose();
				// The user leaves and comes back; the restore holds 1.5 s on real time, then the page prints again.
				await page.goto(`${baseUrl}/one`);
				await page.goBack();
				expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual(["restored"]);
				await page
					.mainFrame()
					.mainRealm()
					.waitForFunction(
						'log.length = 0, document.querySelector("#print").click(), log.join() === "print returned"',
						{ timeout: 10_000, polling: 100 },
					);
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("says a frame printed, without pointing at tab.pdf(), which prints the page", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/one`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					const frame = page.frames().find(candidate => candidate.name() === "payment");
					if (!frame) throw new Error("Expected the payment frame");
					await frame.mainRealm().evaluate("print()");
					const notice = hold.takeNotice();
					expect(notice).toContain("A frame in the page called window.print()");
					expect(notice).not.toContain("Use tab.pdf()");
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in the user's browser while omp sets up the tab, until setup ends", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					const click = 'log.length = 0; document.querySelector("#print").click(); globalThis.log';
					expect(await page.mainFrame().mainRealm().evaluate(click)).toEqual(["afterprint", "print returned"]);
					await hold.endCall();
					// Past the 1.5 s release on the page's clock.
					await advancePrintClock(page, 1_500);
					expect(await page.mainFrame().mainRealm().evaluate(click)).toEqual(["print returned"]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("re-arms the print hold in the user's browser without waiting on a stuck cross-site frame", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({
					action: "open",
					name: "user-stuck",
					url: `${baseUrl}/observe-stuck-frame`,
					app: { cdp_url: cdpUrl },
				});
				const read = 'return await tab.text("button");';
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read }))).toBe("Main");
				// The next call arms the hold again.
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read }))).toBe("Main");
			} finally {
				await invoke({ action: "close", name: "user-stuck" }).catch(() => {});
			}
		});
	}, 30_000);

	test("scopes helpers to iframe documents in run and direct call paths", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "frames", url: `${baseUrl}/frames` });
		const frameTree = valueOf(
			await invoke({ action: "call", name: "frames", chain: [{ method: "frames", args: [] }] }),
		) as Array<{ id: string; name: string; parentId: string | null; selector?: string }>;
		expect(frameTree.find(frame => frame.name === "payment")).toMatchObject({
			parentId: expect.any(String),
			selector: 'iframe[id="f"]',
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "frames",
					code: 'const f = await tab.frame("#f"); await f.fill("#in", "run"); return await f.text("#out");',
				}),
			),
		).toBe("run");
		expect(
			valueOf(await invoke({ action: "run", name: "frames", code: 'return await (await tab.frame("#f")).text();' })),
		).toContain("run");
		// Only an omitted selector means the body; `null` is still rejected, as on the tab.
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "frames",
					code: 'const f = await tab.frame("#f"); try { await f.text(null); return "read"; } catch (e) { return String(e.message); }',
				}),
			),
		).toContain("selector must be a string");
		await invoke({
			action: "call",
			name: "frames",
			chain: [
				{ method: "frame", args: ["#f"] },
				{ method: "fill", args: ["#in", "direct"] },
			],
		});
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "frames",
					chain: [
						{ method: "frame", args: ["#f"] },
						{ method: "text", args: ["#out"] },
					],
				}),
			),
		).toBe("direct");
	}, 30_000);

	test("observes controls inside iframes and acts on them by id", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-frames", url: `${baseUrl}/observe-frames` });
		// A selector reads only the iframes inside it.
		expect((await observe(invoke, "observe-frames", { selector: "#checkout" })).names).toEqual([
			"button:Main",
			"textbox:Card",
			"button:Pay",
		]);
		const observed = await observe(invoke, "observe-frames", {});
		expect(observed.names).toEqual(["button:Main", "textbox:Card", "button:Pay", "button:Outside"]);
		const card = observed.elements.find(entry => entry.name === "Card")!;
		await invoke({
			action: "call",
			name: "observe-frames",
			chain: [
				{ method: "id", args: [card.id] },
				{ method: "fill", args: ["4242"] },
			],
		});
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "observe-frames",
					chain: [
						{ method: "frame", args: ["#pay"] },
						{ method: "value", args: ["input"] },
					],
				}),
			),
		).toBe("4242");
	}, 30_000);

	test("scoped observe reads an iframe inside a web component's shadow root under the selector", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-shadow-frame", url: `${baseUrl}/observe-shadow-frame` });
		expect((await observe(invoke, "observe-shadow-frame", { selector: "#checkout" })).names).toEqual([
			"button:Main",
			"textbox:Card",
			"button:Pay",
		]);
	}, 30_000);

	test("lists managed tabs with live metadata", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "listed-one", url: `${baseUrl}/one`, persist: true });
		await invoke({ action: "open", name: "listed-two", url: `${baseUrl}/two` });
		const listed = valueOf(await invoke({ action: "tabs" })) as Array<{
			name: string;
			url: string;
			persist: boolean;
		}>;
		expect(listed.find(tab => tab.name === "listed-one")).toMatchObject({
			url: `${baseUrl}/one`,
			title: "/one",
			targetId: expect.any(String),
			kind: "headless",
			persist: true,
		});
		expect(listed.find(tab => tab.name === "listed-two")).toMatchObject({
			url: `${baseUrl}/two`,
			persist: false,
		});
	}, 30_000);

	test("stops the page load when a run is cancelled mid-goto", async () => {
		const requested = Promise.withResolvers<AbortSignal>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				requested.resolve(request.signal);
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{ action: "run", name: "cancelled", code: `await tab.goto("http://127.0.0.1:${slow.port}/slow");` },
				cancel.signal,
			);
			const request = await requested.promise;
			cancel.abort();
			// The cancel itself, not a cleanup failure from a page still loading.
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			// Chrome drops the request once the load is stopped; a load left running keeps waiting.
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("stopped");
				request.addEventListener("abort", () => resolve("stopped"));
			});
			expect(await Promise.race([dropped, Bun.sleep(5_000).then(() => "still loading")])).toBe("stopped");
		} finally {
			slow.stop(true);
		}
	}, 30_000);

	test("does not call a cancelled run's page listeners for the requests the cancel stops", async () => {
		const requested = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch() {
				requested.resolve();
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-listener", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-listener",
					code: `page.on("requestfailed", () => {
							globalThis.failedCalls = (globalThis.failedCalls ?? 0) + 1;
							page.url();
						});
						await tab.goto("http://127.0.0.1:${slow.port}/slow");`,
				},
				cancel.signal,
			);
			await requested.promise;
			cancel.abort();
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			const after = await invoke({
				action: "run",
				name: "cancelled-listener",
				code: "return { url: page.url(), failedCalls: globalThis.failedCalls ?? 0 };",
			});
			expect(valueOf(after)).toEqual({ url: `${baseUrl}/one`, failedCalls: 0 });
		} finally {
			slow.stop(true);
		}
	}, 30_000);
});
