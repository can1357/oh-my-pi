/**
 * Tests for relay-safe target adoption in `pickElectronTarget`
 * (discarded-tab hangs, "Requesting main frame too early!" race):
 * - relay /json metadata selects the tab before any CDP attach,
 * - discarded matches fail with actionable guidance,
 * - per-target attach deadlines never hang,
 * - mainFrame readiness is polled past the frameTree race.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	attachPageWithTimeout,
	findFreeCdpPort,
	findReusableCdp,
	pickElectronTarget,
	probeCdpStatus,
	resolveSpawnArgs,
	shouldPreserveConnectedBrowserFocus,
	waitForCdp,
	waitForMainFrame,
} from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	normalizeConnectedCdpUrl,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Browser, HTTPRequest, Page, Target } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
let sharedHeadless: BrowserHandle | undefined;

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
		}),
	};
}

function makePage(urlCalls: Array<() => void>, finalUrl = "https://example.com/") {
	let calls = 0;
	const page = {
		url: () => {
			urlCalls[Math.min(calls, urlCalls.length - 1)]?.();
			calls += 1;
			if (calls < urlCalls.length) {
				throw new Error("Requesting main frame too early!");
			}
			return finalUrl;
		},
		title: async () => "Example",
	} as unknown as Page;
	return { page, calls: () => calls };
}

function makeTarget(id: string, page: Page | null = null, pageDelayMs = 0) {
	const pageSpy = vi.fn(async (): Promise<Page | null> => {
		if (pageDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pageDelayMs));
		return page;
	});
	const target = {
		_targetId: id,
		type: () => "page",
		page: pageSpy,
	} as unknown as Target & { _targetId: string };
	return { target, pageSpy };
}

function makeBrowser(targets: Array<Target & { _targetId: string }>) {
	return {
		targets: () => targets,
		pages: vi.fn(async () => targets.map(t => t.page())),
	} as unknown as Browser;
}

const RELAY_ENTRIES = [
	{ id: "PAGE10", type: "page", title: "Docs", url: "https://docs.example.com", active: "false", discarded: "false" },
	{
		id: "PAGE11",
		type: "page",
		title: "Whole Foods Market Shopping Cart",
		url: "https://www.amazon.com/cart/localmarket?almBrandId=x",
		active: "true",
		discarded: "false",
	},
	{
		id: "PAGE12",
		type: "page",
		title: "Old cart",
		url: "https://www.amazon.com/cart",
		active: "false",
		discarded: "true",
	},
];

interface FakePageOptions {
	url: string;
	title: string;
	visible?: boolean;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
		evaluate: async () => options.visible === true,
	} as unknown as Page;
}

function fakeTarget(type: string, page: Page | null): Target {
	return {
		type: () => type,
		page: async () => page,
	} as unknown as Target;
}

interface DisposableExecutable {
	path: string;
	pid: number;
	close(): Promise<void>;
}

async function spawnDisposableExecutable(args: string[] = []): Promise<DisposableExecutable> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-app-path-"));
	const executablePath = path.join(tempDir, path.basename(process.execPath));
	await Bun.write(executablePath, Bun.file(process.execPath));
	if (process.platform !== "win32") await fs.chmod(executablePath, 0o755);
	const executable = await fs.realpath(executablePath);
	const child = Bun.spawn(
		[executable, "--eval", 'process.stdout.write("ready\\n"); await Bun.stdin.text()', ...args],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const readiness = child.stdout.getReader();
	await readiness.read();
	readiness.releaseLock();
	return {
		path: executable,
		pid: child.pid,
		async close() {
			child.kill();
			await child.exited;
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

describe("pickElectronTarget", () => {
	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		sharedHeadless = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	});

	afterAll(async () => {
		if (sharedHeadless) await releaseBrowser(sharedHeadless, { kill: true });
	});

	test("uses discovered CDP page targets when browser.pages is empty", async () => {
		const page = fakePage({ url: "https://www.google.com/", title: "Google" });
		let pagesCalled = false;
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("page", page)],
			pages: async () => {
				pagesCalled = true;
				return [];
			},
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "google" })).resolves.toBe(page);
		expect(pagesCalled).toBe(false);
	});

	test("falls back to browser.pages when discovered targets have no usable page", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("service_worker", null)],
			pages: async () => [page],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser)).resolves.toBe(page);
	});

	test("reports available pages when the matcher misses", async () => {
		const page = fakePage({ url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("page", page)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "missing" })).rejects.toThrow(
			'No page target matched "missing". Available pages:\n- Example  https://example.com/',
		);
	});

	test("prefers the foreground tab when asked to, without disturbing default order", async () => {
		const background = fakePage({ url: "https://example.com/", title: "Example" });
		const foreground = fakePage({ url: "https://example.org/", title: "Example Org", visible: true });
		const browser = {
			targets: () => [fakeTarget("page", background), fakeTarget("page", foreground)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(foreground);
		await expect(pickElectronTarget(browser)).resolves.toBe(background);
	});

	test("falls back to the first usable tab when no tab reports itself visible", async () => {
		const first = fakePage({ url: "https://example.com/", title: "Example" });
		const second = fakePage({ url: "https://example.org/", title: "Example Org" });
		const browser = {
			targets: () => [fakeTarget("page", first), fakeTarget("page", second)],
			pages: async () => [],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { preferVisible: true })).resolves.toBe(first);
	});

	test("preserves connected-browser focus only for automatic target selection", () => {
		expect(shouldPreserveConnectedBrowserFocus()).toBe(true);
		expect(shouldPreserveConnectedBrowserFocus("example.com")).toBe(false);
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint",
		);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
	});

	test("refuses to replace a running same-executable process", async () => {
		const existing = await spawnDisposableExecutable();
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: existing.path },
					{ cwd: process.cwd(), signal: AbortSignal.timeout(2_000) },
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("rejects a user-data-dir already used by the running executable", async () => {
		const profile = path.join(os.tmpdir(), `omp-browser-profile-${process.pid}-${Date.now()}`);
		const existing = await spawnDisposableExecutable([`--user-data-dir=${profile}`]);
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: existing.path, args: [`--user-data-dir=${profile}`] },
					{
						cwd: process.cwd(),
						signal: AbortSignal.timeout(2_000),
					},
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("launches an isolated user-data-dir beside a running executable", async () => {
		const existing = await spawnDisposableExecutable();
		const { promise: launched, resolve: markLaunched } = Promise.withResolvers<void>();
		const marker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				markLaunched();
				return new Response("ok");
			},
		});
		const controller = new AbortController();
		const childScript = `await fetch(${JSON.stringify(marker.url.href)}); Bun.serve({ port: 0, fetch: () => new Response("ok") });`;
		const openError = acquireBrowser(
			{
				kind: "spawned",
				path: existing.path,
				args: ["--eval", childScript, `--user-data-dir=${path.join(path.dirname(existing.path), "profile")}`],
			},
			{
				cwd: process.cwd(),
				signal: controller.signal,
			},
		).then(
			() => new Error("Expected isolated app acquisition to remain pending"),
			error => (error instanceof Error ? error : new Error(String(error))),
		);

		try {
			await Promise.race([
				launched,
				openError.then(error => {
					throw error;
				}),
			]);
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
			controller.abort();
			expect((await openError).name).toBe("ToolAbortError");
		} finally {
			controller.abort();
			await openError;
			await marker.stop(true);
			await existing.close();
		}
	}, 10_000);

	test("does not reuse a live CDP endpoint belonging to a different profile", async () => {
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		const profile = path.join(os.tmpdir(), `omp-cdp-profile-${crypto.randomUUID()}`);
		const existing = await spawnDisposableExecutable([
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${cdp.port}`,
		]);
		try {
			expect(await findReusableCdp(existing.path, { appArgs: [`--user-data-dir=${profile}-other`] })).toBeNull();
			expect(await findReusableCdp(existing.path, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: existing.pid,
			});
		} finally {
			await existing.close();
			cdp.stop(true);
		}
	});

	test.skipIf(process.platform !== "linux")("reuses Chromium launched through a distro wrapper", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-wrapper-"));
		const wrapper = path.join(root, "google-chrome");
		const target = path.join(root, "chrome");
		const profile = path.join(root, "profile");
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		await Bun.write(target, Bun.file(process.execPath));
		await fs.chmod(target, 0o755);
		await Bun.write(wrapper, '#!/bin/bash\nHERE="$(dirname "$0")"\nexec -a "$0" "$HERE/chrome" "$@"\n');
		await fs.chmod(wrapper, 0o755);
		const child = Bun.spawn(
			[
				wrapper,
				"--eval",
				'process.stdout.write("ready\\n"); await Bun.stdin.text()',
				`--user-data-dir=${profile}`,
				`--remote-debugging-port=${cdp.port}`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);
		const readiness = child.stdout.getReader();
		await readiness.read();
		readiness.releaseLock();
		try {
			expect(await findReusableCdp(wrapper, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: child.pid,
			});
		} finally {
			child.kill();
			await child.exited;
			cdp.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps profile tabs isolated and never kills a borrowed Chrome on close",
		async () => {
			const exe = await ensureChromiumExecutable();
			if (!exe) throw new Error("Expected a Chromium executable");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-isolation-"));
			const borrowedProfile = path.join(root, "borrowed");
			const port = await findFreeCdpPort();
			// Explicit profiles keep the real OS keystore, so bypass it here or macOS
			// blocks each spawn on a keychain-access dialog.
			const flags = [
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--password-store=basic",
			];
			const child = Bun.spawn(
				[exe, ...flags, `--user-data-dir=${borrowedProfile}`, `--remote-debugging-port=${port}`],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: unknown) =>
				prelude.invoke(parameters, { session, toolCallId: "profile-isolation" });
			const borrowedName = `borrowed-${crypto.randomUUID()}`;
			const ownedName = `owned-${crypto.randomUUID()}`;
			try {
				await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
				await invoke({
					action: "open",
					name: borrowedName,
					url: "data:text/html,<title>Borrowed</title>",
					app: { path: exe, args: [...flags, "--user-data-dir", borrowedProfile] },
				});
				await invoke({
					action: "open",
					name: ownedName,
					url: "data:text/html,<title>Owned</title>",
					app: { path: exe, args: [...flags, "--user-data-dir", path.join(root, "owned")] },
				});
				const title = await invoke({ action: "run", name: borrowedName, code: "return await tab.title();" });
				expect(title.details).toMatchObject({ value: "Borrowed" });
				await invoke({ action: "close", name: borrowedName, kill: true });
				expect(await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500 })).toBe(200);
			} finally {
				await invoke({ action: "close", name: ownedName, kill: true }).catch(() => {});
				await invoke({ action: "close", name: borrowedName, kill: true }).catch(() => {});
				child.kill();
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"navigates a fresh attached tab and releases its handle without closing the target",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const endpoint = new URL(launched.browser.wsEndpoint());
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invokeBrowser = (parameters: unknown) =>
				prelude.invoke(parameters, { session, toolCallId: "browser-attach-navigation" });
			let opened = false;
			const tabName = `attach-navigation-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const requested = "data:text/html,<title>attached-navigation-target</title>";
			const targetPage = (await launched.browser.pages())[0];
			if (!targetPage) throw new Error("Expected the launched browser to expose a page target");

			try {
				await invokeBrowser({
					action: "open",
					name: tabName,
					url: requested,
					app: { cdp_url: `http://${endpoint.host}` },
				});
				opened = true;

				const closeResult = await invokeBrowser({ action: "close", name: tabName });
				opened = false;
				expect(closeResult.content).toEqual([{ type: "text", text: `Released managed tab "${tabName}"` }]);
				expect(targetPage.isClosed()).toBe(false);
				expect(targetPage.url()).toBe(requested);
			} finally {
				if (opened) await invokeBrowser({ action: "close", name: tabName });
			}
		},
		30_000,
	);

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"does not retry an attached navigation failure as worker startup",
		async () => {
			// An earlier form raced a real navigation timeout against a hanging
			// local server, but Puppeteer installs its timeout watcher before
			// Page.navigate: under load the timeout could win before Chrome
			// dispatched any HTTP request, and the request-count assertion read 0.
			// Abort the navigation via request interception on the exact page
			// attach adopts instead — the navigation fails deterministically on
			// its first request, and a wrongly retried worker startup would
			// navigate again and read 2.
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const endpoint = new URL(launched.browser.wsEndpoint());
			const targetPage = (await launched.browser.pages())[0];
			if (!targetPage) throw new Error("Expected the launched browser to expose a page target");

			// Count navigations only: after the abort Chrome renders its error page,
			// whose inline data: icons also surface as intercepted requests.
			let requestCount = 0;
			const onRequest = (request: HTTPRequest) => {
				if (request.isNavigationRequest()) requestCount++;
				void request.abort("failed");
			};
			await targetPage.setRequestInterception(true);
			targetPage.on("request", onRequest);
			let attached: BrowserHandle | undefined;

			let attempted = false;
			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: `http://${endpoint.host}` },
					{ cwd: process.cwd() },
				);
				attempted = true;
				await expect(
					acquireTab(`attach-failure-${process.pid}-${Math.random().toString(36).slice(2)}`, attached, {
						// Loopback keeps a hypothetical interception miss local and
						// loud (instant connection refusal, count 0) instead of
						// wandering into DNS or a proxy.
						url: "http://127.0.0.1:9/aborted-by-interception",
						waitUntil: "domcontentloaded",
						timeoutMs: 15_000,
					}),
				).rejects.toThrow(/net::ERR_FAILED/);
				expect(requestCount).toBe(1);
			} finally {
				targetPage.off("request", onRequest);
				await targetPage.setRequestInterception(false);
				if (attached && !attempted) await releaseBrowser(attached, { kill: false });
			}
		},
		30_000,
	);
});

describe("resolveSpawnArgs", () => {
	test("normalizes separated and relative Chromium profiles into an absolute switch value", () => {
		const args = resolveSpawnArgs(
			"/usr/bin/google-chrome-stable",
			["--user-data-dir", "profile", "--incognito"],
			"/tmp",
		);
		expect(args).toEqual(["--incognito", `--user-data-dir=${path.resolve("/tmp", "profile")}`]);
	});

	test("isolates a Flatpak Chromium launcher without treating unrelated apps as browsers", () => {
		const args = resolveSpawnArgs("/var/lib/flatpak/exports/bin/com.google.Chrome", []);
		expect(args.some(arg => arg.startsWith("--user-data-dir="))).toBe(true);
		expect(resolveSpawnArgs("/Applications/Slack.app/Contents/MacOS/Slack", ["--foo"])).toEqual(["--foo"]);
	});

	test("bypasses the OS keystore only for omp-owned Chromium profiles", () => {
		const owned = resolveSpawnArgs("/usr/bin/google-chrome-stable", ["--password-store=gnome"]);
		expect(owned).toContain("--use-mock-keychain");
		expect(owned).toContain("--password-store=gnome");
		expect(owned).not.toContain("--password-store=basic");

		const borrowed = resolveSpawnArgs("/usr/bin/google-chrome-stable", ["--user-data-dir=/home/me/.config/chrome"]);
		expect(borrowed).toEqual(["--user-data-dir=/home/me/.config/chrome"]);
	});
});
describe("pickElectronTarget relay path", () => {
	let relay: Bun.Server<undefined>;
	let relayJson: string;
	let available = true;
	let relayEntries = RELAY_ENTRIES;
	beforeEach(() => {
		available = true;
		relayEntries = RELAY_ENTRIES;
		relay = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname !== "/json") return new Response("Not found", { status: 404 });
				return available ? Response.json(relayEntries) : new Response("unavailable", { status: 503 });
			},
		});
		relayJson = `http://127.0.0.1:${relay.port}`;
	});
	afterEach(async () => {
		await relay.stop(true);
		vi.restoreAllMocks();
	});

	it("adopts the active tab from /json metadata without attaching any other target", async () => {
		const pages = new Map<string, { page: Page; calls: () => number }>();
		const targets: Array<Target & { _targetId: string }> = [];
		for (const entry of RELAY_ENTRIES) {
			const made = makePage([() => {}]);
			pages.set(entry.id, made);
			const { target, pageSpy } = makeTarget(entry.id, made.page);
			Object.assign(target, { page: pageSpy });
			targets.push(target as Target & { _targetId: string });
		}
		const browser = makeBrowser(targets);

		const picked = await pickElectronTarget(browser, { relayJson });

		expect(picked).toBe(pages.get("PAGE11")!.page);
		const attachCalls = targets.map(
			t => (t as unknown as { page: { mock: { calls: unknown[] } } }).page.mock.calls.length,
		);
		expect(attachCalls).toEqual([0, 1, 0]);
	});

	it("matcher skips a discarded matching tab", async () => {
		const made = makePage([() => {}]);
		const { target } = makeTarget("PAGE11", made.page);
		const made12 = makePage([() => {}]);
		const { target: target12 } = makeTarget("PAGE12", made12.page);
		const browser = makeBrowser([target, target12]);

		const picked = await pickElectronTarget(browser, {
			relayJson,
			matcher: "cart",
		});

		expect(picked).toBe(made.page);
		expect((target12 as unknown as { page: { mock: { calls: unknown[] } } }).page.mock.calls.length).toBe(0);
	});

	it("chooses the first of two live matching tabs", async () => {
		relayEntries = [
			{
				id: "PAGE_A",
				type: "page",
				title: "Cart A",
				url: "https://example.com/cart/a",
				active: "false",
				discarded: "false",
			},
			{
				id: "PAGE_B",
				type: "page",
				title: "Cart B",
				url: "https://example.com/cart/b",
				active: "false",
				discarded: "false",
			},
		];
		const firstPage = makePage([() => {}], relayEntries[0]!.url).page;
		const secondPage = makePage([() => {}], relayEntries[1]!.url).page;
		const first = makeTarget("PAGE_A", firstPage);
		const second = makeTarget("PAGE_B", secondPage);
		const picked = await pickElectronTarget(makeBrowser([first.target, second.target]), {
			relayJson,
			matcher: "cart",
		});
		expect(picked).toBe(firstPage);
		expect(second.pageSpy).not.toHaveBeenCalled();
	});

	it("skips an active service worker page unless explicitly targeted", async () => {
		relayEntries = [
			{
				id: "PAGE_A",
				type: "page",
				title: "Service Worker",
				url: "https://example.com/a",
				active: "true",
				discarded: "false",
			},
			{
				id: "PAGE_B",
				type: "page",
				title: "Home",
				url: "https://example.com/b",
				active: "false",
				discarded: "false",
			},
		];
		const skippedPage = makePage([() => {}], relayEntries[0]!.url).page;
		const homePage = makePage([() => {}], relayEntries[1]!.url).page;
		const skipped = makeTarget("PAGE_A", skippedPage);
		const home = makeTarget("PAGE_B", homePage);
		const browser = makeBrowser([skipped.target, home.target]);
		expect(await pickElectronTarget(browser, { relayJson, preferVisible: true })).toBe(homePage);
		expect(skipped.pageSpy).not.toHaveBeenCalled();
		expect(await pickElectronTarget(browser, { relayJson, matcher: "Service Worker" })).toBe(skippedPage);
	});

	it("prefers the visible tab among active tabs in different windows", async () => {
		relayEntries = [
			{
				id: "PAGE_A",
				type: "page",
				title: "Window A",
				url: "https://example.com/a",
				active: "true",
				discarded: "false",
			},
			{
				id: "PAGE_B",
				type: "page",
				title: "Window B",
				url: "https://example.com/b",
				active: "true",
				discarded: "false",
			},
		];
		const firstPage = {
			url: () => relayEntries[0]!.url,
			title: async () => "Window A",
			evaluate: async () => false,
		} as unknown as Page;
		const visiblePage = {
			url: () => relayEntries[1]!.url,
			title: async () => "Window B",
			evaluate: async () => true,
		} as unknown as Page;
		const first = makeTarget("PAGE_A", firstPage);
		const second = makeTarget("PAGE_B", visiblePage);
		const picked = await pickElectronTarget(makeBrowser([first.target, second.target]), {
			relayJson,
			preferVisible: true,
		});
		expect(picked).toBe(visiblePage);
	});

	it("fails with guidance when the only match is a discarded tab", async () => {
		const made = makePage([() => {}]);
		const { target } = makeTarget("PAGE12", made.page);
		const browser = makeBrowser([target]);

		const picking = pickElectronTarget(browser, {
			relayJson,
			matcher: "old cart",
		});

		await expect(picking).rejects.toThrow(/discarded .* Chrome/i);
	});

	it("falls back to target enumeration when /json is unavailable", async () => {
		available = false;
		const made = makePage([() => {}]);
		const { target } = makeTarget("PAGE11", made.page);
		const browser = makeBrowser([target]);

		const picked = await pickElectronTarget(browser, { relayJson });

		expect(picked).toBe(made.page);
	});
});

it("uses relay metadata through a proxy without corrupting UTF-8 titles", async () => {
	const entries = [
		{ id: "PAGE_A", type: "page", title: "Other", url: "https://example.com/a", active: "false", discarded: "false" },
		{ id: "PAGE_B", type: "page", title: "Café", url: "https://example.com/b", active: "true", discarded: "false" },
	];
	let relayHits = 0;
	let proxyHits = 0;
	const relay = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			relayHits++;
			return Response.json(entries);
		},
	});
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			proxyHits++;
			return new Response("Bad Gateway", { status: 502 });
		},
	});
	const saved = {
		HTTP_PROXY: process.env.HTTP_PROXY,
		http_proxy: process.env.http_proxy,
		NO_PROXY: process.env.NO_PROXY,
		no_proxy: process.env.no_proxy,
	};
	process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
	process.env.http_proxy = process.env.HTTP_PROXY;
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	try {
		const firstPage = { url: () => entries[0]!.url, title: async () => "Other" } as unknown as Page;
		const chosenPage = { url: () => entries[1]!.url, title: async () => "Café" } as unknown as Page;
		const first = makeTarget(entries[0]!.id, firstPage);
		const chosen = makeTarget(entries[1]!.id, chosenPage);
		const picked = await pickElectronTarget(makeBrowser([first.target, chosen.target]), {
			relayJson: `http://127.0.0.1:${relay.port}`,
			matcher: "Café",
		});
		expect(picked).toBe(chosenPage);
		expect(first.pageSpy).not.toHaveBeenCalled();
		expect(relayHits).toBe(1);
		expect(proxyHits).toBe(0);
	} finally {
		for (const key of ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const) {
			process.env[key] = saved[key] ?? "";
			if (saved[key] === undefined) delete process.env[key];
		}
		await proxy.stop(true);
		await relay.stop(true);
	}
});

describe("attach hardening", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("attachPageWithTimeout resolves null when the target never becomes a page", async () => {
		const { target } = makeTarget("PAGE1", null, 10_000);
		expect(await attachPageWithTimeout(target, 30)).toBeNull();
	});

	it("waitForMainFrame tolerates the frameTree race until the frame serves", async () => {
		const { page } = makePage([() => {}, () => {}]);
		expect(await waitForMainFrame(page, 2_000)).toBe(true);
	});

	it("waitForMainFrame gives up on non-race errors and on the deadline", async () => {
		const bad = {
			url: () => {
				throw new Error("boom");
			},
		} as unknown as Page;
		expect(await waitForMainFrame(bad, 100)).toBe(false);

		let n = 0;
		const racy = {
			url: () => {
				n += 1;
				throw new Error("Requesting main frame too early!");
			},
		} as unknown as Page;
		expect(await waitForMainFrame(racy, 150)).toBe(false);
		expect(n).toBeGreaterThan(1);
	});
});

describe("probeCdpStatus", () => {
	// Regression for #8567: a local proxy (Clash, corporate) 502s internal
	// loopback addresses, so a bare fetch()/node:http probe misreports a healthy
	// CDP daemon as dead. The raw-TCP probe must ignore HTTP_PROXY entirely.
	test("returns the loopback status even when HTTP_PROXY 502s the request", async () => {
		const cdp = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		const proxy = Bun.serve({ port: 0, fetch: () => new Response("Bad Gateway", { status: 502 }) });
		const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
		process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${cdp.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(200);
		} finally {
			// Bun's fetch never unlearns a deleted proxy var: `delete process.env.X`
			// (or assigning undefined) leaves the proxy active process-wide, silently
			// routing every later fetch in the suite to the stopped proxy port. Only
			// assignment flushes it, so write "" first, then restore the JS view.
			process.env.HTTP_PROXY = saved.HTTP_PROXY ?? "";
			process.env.http_proxy = saved.http_proxy ?? "";
			if (saved.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
			if (saved.http_proxy === undefined) delete process.env.http_proxy;
			await cdp.stop(true);
			await proxy.stop(true);
		}
	});

	test("surfaces a non-2xx status from a live endpoint", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(503);
		} finally {
			await server.stop(true);
		}
	});

	test("returns null when the endpoint is unreachable", async () => {
		const port = await findFreeCdpPort();
		const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 500 });
		expect(status).toBeNull();
	});

	test("returns null when the request is already aborted", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, {
				timeoutMs: 1500,
				signal: AbortSignal.abort(),
			});
			expect(status).toBeNull();
		} finally {
			await server.stop(true);
		}
	});
});
