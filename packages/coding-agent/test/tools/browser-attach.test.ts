import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	findFreeCdpPort,
	pickElectronTarget,
	probeCdpStatus,
	shouldPreserveConnectedBrowserFocus,
} from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
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
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

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
					{ kind: "spawned", path: existing.path },
					{
						cwd: process.cwd(),
						appArgs: [`--user-data-dir=${profile}`],
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
			{ kind: "spawned", path: existing.path },
			{
				cwd: process.cwd(),
				appArgs: ["--eval", childScript, `--user-data-dir=${path.join(path.dirname(existing.path), "profile")}`],
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

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"navigates a fresh attached tab and releases its handle without closing the target",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const endpoint = new URL(launched.browser.wsEndpoint());
			const tool = new BrowserTool(makeSession());
			let opened = false;
			const tabName = `attach-navigation-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const requested = "data:text/html,<title>attached-navigation-target</title>";
			const targetPage = (await launched.browser.pages())[0];
			if (!targetPage) throw new Error("Expected the launched browser to expose a page target");

			try {
				await tool.execute("open", {
					action: "open",
					name: tabName,
					url: requested,
					app: { cdp_url: `http://${endpoint.host}` },
				});
				opened = true;

				const closeResult = await tool.execute("close", { action: "close", name: tabName });
				opened = false;
				expect(closeResult.content).toEqual([{ type: "text", text: `Released managed tab "${tabName}"` }]);
				expect(targetPage.isClosed()).toBe(false);
				expect(targetPage.url()).toBe(requested);
			} finally {
				if (opened) await tool.execute("close", { action: "close", name: tabName });
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

			let requestCount = 0;
			const onRequest = (request: HTTPRequest) => {
				requestCount++;
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
