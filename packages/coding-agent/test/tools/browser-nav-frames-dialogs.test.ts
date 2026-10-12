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
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer, { type Page, type WaitForOptions } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const server = Bun.serve({
	port: 0,
	// `/never-ends` must outlive the run budget instead of Bun's 10s idle cut.
	idleTimeout: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
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
				`<button id="print">Print</button><script>
					globalThis.log = [];
					addEventListener("afterprint", () => log.push("afterprint"));
					addEventListener("pageshow", event => { if (event.persisted) log.push("restored"); });
					document.querySelector("#print").addEventListener("click", () => { print(); log.push("print returned"); });
					if (location.pathname === "/print-on-load") addEventListener("load", () => { print(); log.push("load print returned"); });
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

// Chromium takes about 10 s to shut down while the stuck-frame test's renderer is still spinning.
afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
}, 30_000);

function fakePage(frame: { _lifecycleEvents: Set<string>; detached?: boolean }, closed = () => false): Page {
	return {
		mainFrame: () => frame,
		isClosed: closed,
		browser: () => ({ connected: true }),
	} as unknown as Page;
}

test("fails a navigation whose main document reaches its event only after the timeout", async () => {
	const events = new Set<string>();
	const page = fakePage({ _lifecycleEvents: events });
	// Real time on purpose: the wait polls the frame on a timer and must stop reading at its deadline.
	const late = setTimeout(() => events.add("load"), 90);
	try {
		const error = await navigateMainFrame(page, "load", 60, undefined, async () => null).catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("TimeoutError");
		expect(error.message).toBe("Navigation timeout of 60 ms exceeded");
	} finally {
		clearTimeout(late);
	}
});

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
				const started = Date.now();
				let message = "";
				try {
					await tab.goto(${JSON.stringify(`${baseUrl}/two`)}, { waitUntil: "networkidle" });
				} catch (error) {
					message = String(error?.message ?? error);
				}
				const elapsed = Date.now() - started;
				await tab.goto(${JSON.stringify(`${baseUrl}/three`)}, { waitUntil: ["load", "domcontentloaded"] });
				return [message, elapsed < 5000, tab.url()];
			`,
		});
		const [message, fast, url] = valueOf(result) as [string, boolean, string];
		expect(message).toContain("Unknown value for options.waitUntil: networkidle");
		expect(fast).toBe(true);
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

		// A page that prints a moment after the call returns: nobody but omp drives this browser, so it stays held.
		// The print has to land between two calls, which only the real clock in the page can arrange.
		await invoke({
			action: "run",
			name: "print",
			code: 'await tab.evaluate(() => { setTimeout(() => document.querySelector("#print").click(), 100); });',
		});
		await Bun.sleep(500);
		const later = await invoke({
			action: "run",
			name: "print",
			code: "return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(later)).toEqual(["afterprint", "print returned", "afterprint", "print returned"]);
		expect(textOf(later)).toContain("The page called window.print()");
	}, 30_000);

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
	}, 30_000);

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

				// The hold ends 1.5 s after the call on the tab worker's real clock; then the user's own click prints.
				await Bun.sleep(2_000);
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print-on-load"));
					if (!page) throw new Error("Expected the print page in the user's browser");
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
				// Past the release on the tab worker's real clock, the user leaves the page; it is cached released.
				await Bun.sleep(2_000);
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print"));
					if (!page) throw new Error("Expected the print page in the user's browser");
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
				// The restored page holds for 1.5 s on its own real clock, which nothing outside the page can advance.
				await Bun.sleep(2_000);
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
					// A second attachment arrives released; it must not release the first one's call.
					const second = await PrintHold.install(page, "calls");
					try {
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
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read, timeout: 5 }))).toBe("Main");
				// Past the 1.5 s release on the tab worker's real clock, the next call arms the hold again.
				await Bun.sleep(2_000);
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read, timeout: 5 }))).toBe("Main");
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

	test("skips a cross-site frame stuck in script until it navigates", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-stuck-frame", url: `${baseUrl}/observe-stuck-frame` });
		// The first observation waits out the frame, then still lists the page.
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main"]);
		const started = performance.now();
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main"]);
		expect(performance.now() - started).toBeLessThan(2_500);
		// Navigating the frame clears the memo; the evaluation settles once the new document has loaded.
		await invoke({
			action: "call",
			name: "observe-stuck-frame",
			chain: [
				{
					method: "evaluate",
					args: [
						`(async () => { const { promise, resolve } = Promise.withResolvers(); const frame = document.querySelector("#stuck"); frame.onload = () => resolve(true); frame.srcdoc = "<button>Fresh</button>"; await promise; })()`,
					],
				},
			],
		});
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main", "button:Fresh"]);
	}, 60_000);

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

	test("leaves the page's in-flight fetches alone when a run that is not navigating is cancelled", async () => {
		const pending = Promise.withResolvers<AbortSignal>();
		const waiting = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/pending") pending.resolve(request.signal);
				else waiting.resolve();
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-wait", url: `${baseUrl}/one` });
			await invoke({
				action: "run",
				name: "cancelled-wait",
				code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/pending");`,
			});
			const request = await pending.promise;
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-wait",
					code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/waiting");
						await wait(60_000);`,
				},
				cancel.signal,
			);
			await waiting.promise;
			cancel.abort();
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("dropped");
				request.addEventListener("abort", () => resolve("dropped"));
			});
			// Proving the fetch survives needs real time: nothing signals "Chrome did not cancel it".
			expect(await Promise.race([dropped, Bun.sleep(1_000).then(() => "pending")])).toBe("pending");
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
