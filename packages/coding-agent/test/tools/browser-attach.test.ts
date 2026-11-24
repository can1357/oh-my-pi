/**
 * Tests for relay-safe target adoption in `pickElectronTarget`
 * (discarded-tab hangs, "Requesting main frame too early!" race):
 * - relay /json metadata chooses a page before probing its frame,
 * - discarded matches fail with actionable guidance,
 * - per-target attach deadlines never hang,
 * - mainFrame readiness is polled past the frameTree race.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, test, vi } from "bun:test";
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
	gracefulKillTreeOnce,
	pickElectronTarget,
	pickRelayTargetId,
	probeCdpStatus,
	resolveSpawnArgs,
	waitForCdp,
	waitForMainFrame,
} from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	ensureChromiumExecutable,
	privateTargetId,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	normalizeConnectedCdpUrl,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, getTab, listTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { type Browser, type HTTPRequest, type Page, type Target } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
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
			// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
			"browser.webkit": false,
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
	if (page) Object.assign(page, { target: () => target });
	return { target, pageSpy };
}

function makeBrowser(targets: Array<Target & { _targetId: string }>) {
	return {
		targets: () => targets,
		pages: vi.fn(async (): Promise<Page[]> =>
			(await Promise.all(targets.map(t => t.page()))).filter((page): page is Page => page !== null),
		),
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
	id?: string;
	visible?: boolean;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
		target: () => ({ _targetId: options.id ?? "" }),
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

interface CdpMessage {
	id?: number;
	method?: string;
	sessionId?: string;
	params?: {
		targetId?: string;
		sessionId?: string;
		waitingForDebugger?: boolean;
		targetInfo?: { targetId: string; type: string };
	};
	result?: { targetId?: string; targetInfos?: Array<{ targetId: string; type: string }> };
}

/** A rejection no run owns, as a Puppeteer event handler's would be: run as a tab's code, it ends the tab's worker. */
const END_WORKER = `
	const err = new Error("library-internal");
	err.stack = "Error: library-internal\\n    at #onFileChooser (puppeteer/Page.js:1:1)";
	Promise.reject(err);
	await Promise.withResolvers().promise;
`;

/**
 * A CDP endpoint in front of real Chromium. `scoped`: it behaves like Lightpanda, so each connection sees only the
 * pages it created, and its pages close when it disconnects. `failTargetQueries`: `Target.getTargets` and a
 * `Target.getTargetInfo` for a page fail, as on an endpoint that does not implement them.
 */
function startCdpProxy(
	upstream: string,
	{ scoped, failTargetQueries = false }: { scoped: boolean; failTargetQueries?: boolean },
): { url: string; stop(): void } {
	// Page and tab target id → the connection that created it. Chromium announces a created page's tab and page
	// targets before answering `Target.createTarget`, so a connection waiting on one claims both.
	const owners = new Map<string, number>();
	let nextConnection = 0;
	// Ids of the proxy's own requests upstream, above any a client sends here.
	const PROXY_REQUEST_IDS = 1_000_000_000;
	interface Connection {
		id: number;
		upstream: WebSocket;
		queued: string[] | null;
		pendingCreates: number;
		hiddenSessions: Set<string>;
		ownedRequests: Map<number, string>;
		nextRequestId: number;
	}
	const visible = (conn: Connection, targetId: string, type: string): boolean => {
		if (!scoped || (type !== "page" && type !== "tab")) return true;
		const owner = owners.get(targetId);
		if (owner === undefined && conn.pendingCreates > 0) owners.set(targetId, conn.id);
		return owners.get(targetId) === conn.id;
	};
	const server = Bun.serve<Connection>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/json/version") {
				return Response.json({ Browser: "Chrome", webSocketDebuggerUrl: `ws://${url.host}/devtools/browser` });
			}
			const id = nextConnection++;
			const data: Connection = {
				id,
				upstream: new WebSocket(upstream),
				queued: [],
				pendingCreates: 0,
				hiddenSessions: new Set(),
				ownedRequests: new Map(),
				nextRequestId: PROXY_REQUEST_IDS,
			};
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				const conn = ws.data;
				conn.upstream.onopen = () => {
					for (const message of conn.queued ?? []) conn.upstream.send(message);
					conn.queued = null;
				};
				conn.upstream.onclose = () => ws.close();
				conn.upstream.onmessage = event => {
					const message = JSON.parse(String(event.data)) as CdpMessage;
					// Answers to the proxy's own requests below.
					if (message.id !== undefined && message.id >= PROXY_REQUEST_IDS) return;
					if (message.sessionId && conn.hiddenSessions.has(message.sessionId)) return;
					if (scoped && message.id !== undefined && conn.ownedRequests.get(message.id) === "Target.createTarget") {
						conn.pendingCreates--;
						if (message.result?.targetId) owners.set(message.result.targetId, conn.id);
					}
					if (message.id !== undefined) conn.ownedRequests.delete(message.id);
					if (message.result?.targetInfos) {
						message.result.targetInfos = message.result.targetInfos.filter(info =>
							visible(conn, info.targetId, info.type),
						);
					}
					const info = message.params?.targetInfo;
					if (info && !visible(conn, info.targetId, info.type)) {
						const sessionId = message.params?.sessionId;
						if (message.method === "Target.attachedToTarget" && sessionId) {
							conn.hiddenSessions.add(sessionId);
							// Chromium paused the target for this connection's auto-attach, which never learns of it: resume
							// and let it go, or the other connection's page never navigates.
							if (message.params?.waitingForDebugger) {
								conn.upstream.send(
									JSON.stringify({
										id: conn.nextRequestId++,
										method: "Runtime.runIfWaitingForDebugger",
										sessionId,
									}),
								);
							}
							conn.upstream.send(
								JSON.stringify({
									id: conn.nextRequestId++,
									method: "Target.detachFromTarget",
									params: { sessionId },
								}),
							);
						}
						return;
					}
					const targetId = message.params?.targetId;
					if (targetId && owners.has(targetId) && owners.get(targetId) !== conn.id) return;
					ws.send(JSON.stringify(message));
				};
			},
			message(ws, raw) {
				const conn = ws.data;
				const message = JSON.parse(String(raw)) as CdpMessage;
				const targetId = message.params?.targetId;
				if (
					failTargetQueries &&
					(message.method === "Target.getTargets" || (message.method === "Target.getTargetInfo" && targetId))
				) {
					ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Internal error" } }));
					return;
				}
				if (scoped && targetId && message.method?.startsWith("Target.") && owners.get(targetId) !== conn.id) {
					ws.send(
						JSON.stringify({ id: message.id, error: { code: -32602, message: "No target with given id found" } }),
					);
					return;
				}
				if (message.id !== undefined && message.method) conn.ownedRequests.set(message.id, message.method);
				if (message.method === "Target.createTarget") conn.pendingCreates++;
				if (conn.queued) conn.queued.push(String(raw));
				else conn.upstream.send(String(raw));
			},
			close(ws) {
				const conn = ws.data;
				// The connection's pages go with it, as Lightpanda's do.
				for (const [targetId, owner] of owners) {
					if (owner !== conn.id) continue;
					if (conn.upstream.readyState === WebSocket.OPEN) {
						conn.upstream.send(
							JSON.stringify({ id: conn.nextRequestId++, method: "Target.closeTarget", params: { targetId } }),
						);
					}
					owners.delete(targetId);
				}
				conn.upstream.close();
			},
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"opens its own page on an attached Chromium that has none, and closes it with the tab",
		async () => {
			const exe = await ensureChromiumExecutable();
			if (!exe) throw new Error("Expected a Chromium executable");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-page-readiness-"));
			const port = await findFreeCdpPort();
			const child = Bun.spawn(
				[
					exe,
					"--headless=new",
					"--no-sandbox",
					"--no-startup-window",
					"--no-first-run",
					"--no-default-browser-check",
					"--use-mock-keychain",
					"--password-store=basic",
					...RENDERER_PRIORITY_ARGS,
					`--user-data-dir=${root}`,
					`--remote-debugging-port=${port}`,
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "attach-page-readiness" };
			const name = `page-readiness-${crypto.randomUUID()}`;
			const controller = new AbortController();
			let attached: BrowserHandle | undefined;
			try {
				const cdpUrl = `http://127.0.0.1:${port}`;
				await waitForCdp(cdpUrl, 15_000);
				attached = await acquireBrowser({ kind: "connected", cdpUrl }, { cwd: process.cwd() });
				if (!("browser" in attached)) throw new Error("Expected a Puppeteer browser");
				const browser = attached.browser;
				expect(await browser.pages()).toHaveLength(0);
				// An endpoint with no page yet: the open makes its own instead of waiting for one.
				await prelude.invoke(
					{
						action: "open",
						name,
						url: "data:text/html,<title>First attached page</title>",
						timeout: 15,
						app: cdpUrl,
					},
					{ ...context, signal: controller.signal },
				);
				const title = await prelude.invoke({ action: "run", name, code: "return await tab.title();" }, context);
				expect(title.details).toMatchObject({ value: "First attached page" });
				await prelude.invoke({ action: "close", name, kill: true }, context);
				expect(await browser.pages()).toHaveLength(0);
				expect(await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: 1500 })).toBe(200);
			} finally {
				controller.abort();
				await prelude.invoke({ action: "close", name }, context).catch(() => {});
				if (attached) await releaseBrowser(attached, { kill: false });
				await gracefulKillTreeOnce(child.pid);
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test("adopts a fresh blank CDP page by its exact id when URLs and titles repeat", async () => {
		const first = fakePage({ id: "PAGE_FIRST", url: "about:blank", title: "" });
		const fresh = fakePage({ id: "PAGE_FRESH", url: "about:blank", title: "" });
		const browser = {
			targets: () => [fakeTarget("page", first), fakeTarget("page", fresh)],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "PAGE_FRESH" })).resolves.toBe(fresh);
	});

	test("prioritizes an exact CDP id over a URL substring on another page", async () => {
		const first = fakePage({ id: "PAGE_FIRST", url: "https://example.com/PAGE_SECOND", title: "First" });
		const second = fakePage({ id: "PAGE_SECOND", url: "about:blank", title: "" });
		const browser = {
			targets: () => [fakeTarget("page", first), fakeTarget("page", second)],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "PAGE_SECOND" })).resolves.toBe(second);
	});

	test("reports page ids with their URLs when a target id is missing", async () => {
		const page = fakePage({ id: "PAGE_AVAILABLE", url: "https://example.com/", title: "Example" });
		const browser = {
			targets: () => [fakeTarget("page", page)],
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, { matcher: "PAGE_MISSING" })).rejects.toThrow(
			'No page target matched "PAGE_MISSING". Available pages:\n- PAGE_AVAILABLE  Example  https://example.com/',
		);
	});

	test("rejects websocket cdp_url values with an actionable diagnostic", () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app CDP URL must be the HTTP CDP discovery endpoint",
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

	test.skipIf(process.platform === "win32")(
		"reuses Chromium started by a compiled launcher through its profile lock",
		async () => {
			// Arch's /usr/bin/chromium is an ELF that execs /usr/lib/chromium/chromium.
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-launcher-"));
			const launcher = path.join(root, "chromium");
			const browser = path.join(root, "lib", "chromium");
			const profile = path.join(root, "profile");
			const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
			await Bun.write(launcher, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
			await Bun.write(browser, Bun.file(process.execPath));
			await fs.chmod(launcher, 0o755);
			await fs.chmod(browser, 0o755);
			await fs.mkdir(profile);
			const staleProfile = path.join(root, "stale");
			await fs.mkdir(staleProfile);
			const child = Bun.spawn(
				[
					browser,
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
				await fs.symlink(`${os.hostname()}-${child.pid}`, path.join(profile, "SingletonLock"));
				expect(await findReusableCdp(launcher, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
					cdpUrl: `http://127.0.0.1:${cdp.port}`,
					pid: child.pid,
				});
				// Another Chromium-family browser holding the profile is refused, not adopted.
				await expect(
					findReusableCdp(path.join(root, "chrome"), { appArgs: [`--user-data-dir=${profile}`] }),
				).rejects.toThrow(`held by another browser, ${browser} (pid ${child.pid})`);
				// A stale lock whose pid now belongs to a browser on another profile.
				await fs.symlink(`${os.hostname()}-${child.pid}`, path.join(staleProfile, "SingletonLock"));
				expect(await findReusableCdp(launcher, { appArgs: [`--user-data-dir=${staleProfile}`] })).toBeNull();
			} finally {
				child.kill();
				await child.exited;
				cdp.stop(true);
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

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
				// `open` always adds this to a spawned app; without it the open keys a second browser.
				"--allow-file-access-from-files",
				...RENDERER_PRIORITY_ARGS,
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
				const existing = await acquireBrowser(
					{ kind: "spawned", path: exe, args: [...flags, `--user-data-dir=${borrowedProfile}`] },
					{ cwd: session.cwd },
				);
				if (!("browser" in existing)) throw new Error("Expected Chromium browser");
				const original = await existing.browser.newPage();
				await original.goto("data:text/html,<title>Original user tab</title>");
				await invoke({
					action: "open",
					name: borrowedName,
					url: "data:text/html,<title>Borrowed</title>",
					app: exe,
					argv: [...flags, "--user-data-dir", borrowedProfile],
				});
				await invoke({
					action: "open",
					name: ownedName,
					url: "data:text/html,<title>Owned</title>",
					app: exe,
					argv: [...flags, "--user-data-dir", path.join(root, "owned")],
				});
				const borrowedTab = getTab(borrowedName);
				const ownedTab = getTab(ownedName);
				if (borrowedTab?.backend !== "worker" || ownedTab?.backend !== "worker")
					throw new Error("Expected Chromium worker tabs");
				expect(borrowedTab.browser).not.toBe(ownedTab.browser);
				expect(borrowedTab.targetId).not.toBe(ownedTab.targetId);
				expect(borrowedTab.browser.subprocess).toBeUndefined();
				expect(ownedTab.browser.subprocess).toBeDefined();
				const ownedTitle = await invoke({ action: "run", name: ownedName, code: "return await tab.title();" });
				expect(ownedTitle.details).toMatchObject({ value: "Owned" });
				expect(await original.title()).toBe("Original user tab");
				const title = await invoke({ action: "run", name: borrowedName, code: "return await tab.title();" });
				expect(title.details).toMatchObject({ value: "Borrowed" });
				await invoke({ action: "close", name: borrowedName, kill: true });
				expect(await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500 })).toBe(200);
			} finally {
				await invoke({ action: "close", name: ownedName, kill: true }).catch(() => {});
				await invoke({ action: "close", name: borrowedName, kill: true }).catch(() => {});
				await gracefulKillTreeOnce(child.pid);
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"opens and owns a page in an empty custom Chrome profile",
		async () => {
			const exe = await ensureChromiumExecutable();
			if (!exe) throw new Error("Expected a Chromium executable");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-empty-profile-"));
			const profile = path.join(root, "fresh");
			const flags = [
				"--headless=new",
				"--no-sandbox",
				"--no-startup-window",
				"--no-first-run",
				"--use-mock-keychain",
				"--password-store=basic",
				// `open` always adds this to a spawned app; without it the open keys a second browser.
				"--allow-file-access-from-files",
				...RENDERER_PRIORITY_ARGS,
				`--user-data-dir=${profile}`,
			];
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "empty-profile" });
			const name = `empty-profile-${crypto.randomUUID()}`;
			try {
				const handle = await acquireBrowser({ kind: "spawned", path: exe, args: flags }, { cwd: session.cwd });
				if (!("browser" in handle)) throw new Error("Expected Chromium browser");
				for (const page of await handle.browser.pages()) await page.close();
				expect(handle.browser.targets().filter(target => String(target.type()) === "page")).toEqual([]);
				await invoke({
					action: "open",
					name,
					app: exe,
					argv: flags,
					url: "data:text/html,<title>Fresh profile</title>",
				});
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("Expected Chromium worker tab");
				expect(tab.ownsPage).toBe(true);
				expect(tab.browser).toBe(handle);
				expect((await invoke({ action: "run", name, code: "return await tab.title();" })).details).toMatchObject({
					value: "Fresh profile",
				});
			} finally {
				await invoke({ action: "close", name, kill: true }).catch(() => {});
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"reports a connected browser's own viewport on open and observe, and applies one an open asks for",
		async () => {
			const exe = await ensureChromiumExecutable();
			if (!exe) throw new Error("Expected a Chromium executable");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-connected-viewport-"));
			const port = await findFreeCdpPort();
			const child = Bun.spawn(
				[
					exe,
					"--headless=new",
					"--no-sandbox",
					"--no-first-run",
					"--use-mock-keychain",
					"--window-size=900,700",
					"--force-device-scale-factor=2",
					...RENDERER_PRIORITY_ARGS,
					`--user-data-dir=${root}`,
					`--remote-debugging-port=${port}`,
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: unknown) =>
				prelude.invoke(parameters, { session, toolCallId: "connected-viewport" });
			const name = `connected-viewport-${crypto.randomUUID()}`;
			try {
				await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
				const app = `http://127.0.0.1:${port}`;
				// No `scale`: the window keeps its own device scale (2 here).
				const viewport = { width: 390, height: 844 };
				// An open that fails after adopting the page (a file where the downloads folder goes) leaves no size
				// behind. No `url` after it: Chrome drops a leftover size when the page navigates.
				const notAFolder = path.join(root, "not-a-folder");
				await Bun.write(notAFolder, "");
				expect(
					await rejectionOf(invoke({ action: "open", name, app, viewport, downloads: notAFolder })),
				).toBeInstanceOf(Error);
				const opened = await invoke({ action: "open", name, app });
				const result = await invoke({
					action: "run",
					name,
					code: `return {
	observed: (await tab.observe()).viewport,
	window: await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })),
};`,
				});
				const details = result.details;
				if (!details || typeof details !== "object" || !("value" in details))
					throw new Error("run returned no value");
				// `run` details carry the cell's return value untyped.
				const { observed, window } = details.value as { observed: unknown; window: unknown };
				// The window's chrome eats into --window-size differently per OS, so pin only the forced
				// pixel ratio; it differs from DEFAULT_VIEWPORT's 1.25, which main reported here.
				expect(window).toMatchObject({ deviceScaleFactor: 2 });
				expect(window).not.toMatchObject({ width: viewport.width, height: viewport.height });
				expect(observed).toEqual(window);
				expect(opened.details).toMatchObject({ viewport: window });
				await invoke({ action: "close", name });
				const pageSize = {
					action: "run",
					name,
					code: "return await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));",
				};
				const sized = await invoke({ action: "open", name, app, viewport });
				const asked = { width: 390, height: 844, deviceScaleFactor: 2 };
				expect(sized.details).toMatchObject({ viewport: asked });
				expect((await invoke(pageSize)).details).toMatchObject({ value: asked });
				// Reopening the live tab resizes it the same way.
				await invoke({ action: "open", name, app, viewport: { width: 400, height: 800 } });
				expect((await invoke(pageSize)).details).toMatchObject({
					value: { width: 400, height: 800, deviceScaleFactor: 2 },
				});
			} finally {
				await invoke({ action: "close", name }).catch(() => {});
				await gracefulKillTreeOnce(child.pid);
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"opens its own page on a CDP endpoint, and borrows one only through target",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const endpoint = new URL(launched.wsEndpoint);
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
				// Without a target the open makes its own page, leaving the endpoint's page alone, and closing closes it.
				await invokeBrowser({ action: "open", name: tabName, url: requested, app: `http://${endpoint.host}` });
				opened = true;
				expect(targetPage.url()).not.toBe(requested);
				const owned = getTab(tabName)?.targetId;
				await invokeBrowser({ action: "close", name: tabName });
				opened = false;
				expect(launched.browser.targets().some(target => privateTargetId(target) === owned)).toBe(false);

				// `target` borrows the endpoint's page: navigated, then released without closing it.
				const targetId = privateTargetId(targetPage.target());
				if (!targetId) throw new Error("Expected the launched page's target id");
				await invokeBrowser({
					action: "open",
					name: tabName,
					url: requested,
					app: `http://${endpoint.host}`,
					target: targetId,
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

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a tab on a connection-scoped CDP endpoint through tab listing and a worker exit",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const proxy = startCdpProxy(launched.wsEndpoint, { scoped: true });
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "browser-attach-connection-scoped" };
			const name = `attach-connection-scoped-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const url = "data:text/html,<title>connection-scoped-page</title>";

			try {
				await prelude.invoke(
					{ action: "open", name, url, app: proxy.url, init_scripts: ["window.fromInit = 'yes';"] },
					context,
				);
				await prelude.invoke(
					{ action: "run", name, code: "await tab.evaluate(() => { window.marker = 1; });" },
					context,
				);
				// The supervisor's own connection cannot see the page, which is not a page that closed.
				expect(listTabs().map(tab => tab.name)).toContain(name);

				const exit = await rejectionOf(prelude.invoke({ action: "run", name, code: END_WORKER }, context));
				expect(exit instanceof Error ? exit.message : String(exit)).toContain(
					"the tab's page closed with it, so omp is opening a new page for the tab on a new worker",
				);
				const after = await prelude.invoke(
					{
						action: "run",
						name,
						code: "return { title: await tab.title(), marker: await tab.evaluate(() => window.marker ?? null), fromInit: await tab.evaluate(() => window.fromInit ?? null) };",
					},
					context,
				);
				// A new page on the new worker's connection, back on the old page's URL, without its state, and with the
				// document-start script the tab was opened with.
				expect(after.details).toMatchObject({
					value: { title: "connection-scoped-page", marker: null, fromInit: "yes" },
				});
			} finally {
				await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
				proxy.stop();
			}
		},
		30_000,
	);

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"releases a connection-scoped tab whose page closed outside omp instead of re-creating it",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const proxy = startCdpProxy(launched.wsEndpoint, { scoped: true });
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "browser-attach-connection-scoped-closed" };
			const name = `attach-connection-scoped-closed-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const url = "data:text/html,<title>connection-scoped-closed</title>";

			try {
				await prelude.invoke({ action: "open", name, url, app: proxy.url }, context);
				// Another client closes the page: a connection that sees every target, as omp's never does here.
				const page = (await launched.browser.pages()).find(candidate => candidate.url() === url);
				if (!page) throw new Error("Expected the tab's page in the browser");
				await page.close();

				const error = await rejectionOf(
					prelude.invoke({ action: "run", name, code: "return await tab.evaluate(() => 1);" }, context),
				);
				expect(error instanceof Error ? error.message : String(error)).toContain("page closed outside omp");
				expect(listTabs().map(tab => tab.name)).not.toContain(name);
				expect((await launched.browser.pages()).some(candidate => candidate.url() === url)).toBe(false);
			} finally {
				await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
				proxy.stop();
			}
		},
		30_000,
	);

	// Launches real headless Chromium; skipped where Chrome's system libraries are absent.
	test.skipIf(!CHROMIUM_AVAILABLE)(
		"re-adopts a tab's page when the endpoint cannot list its targets",
		async () => {
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const proxy = startCdpProxy(launched.wsEndpoint, { scoped: false, failTargetQueries: true });
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const context = { session, toolCallId: "browser-attach-unlisted-targets" };
			const name = `attach-unlisted-targets-${process.pid}-${Math.random().toString(36).slice(2)}`;

			try {
				await prelude.invoke(
					{ action: "open", name, url: "data:text/html,<title>unlisted-targets</title>", app: proxy.url },
					context,
				);
				await prelude.invoke(
					{ action: "run", name, code: "await tab.evaluate(() => { window.marker = 1; });" },
					context,
				);
				await rejectionOf(prelude.invoke({ action: "run", name, code: END_WORKER }, context));
				const after = await prelude.invoke(
					{ action: "run", name, code: "return await tab.evaluate(() => window.marker ?? null);" },
					context,
				);
				// A probe that failed proves nothing about scoping: the new worker adopted the same page, state intact.
				expect(after.details).toMatchObject({ value: 1 });
			} finally {
				await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
				proxy.stop();
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
			// the attach borrows instead — the navigation fails deterministically on
			// its first request, and a wrongly retried worker startup would
			// navigate again and read 2.
			const launched = sharedHeadless;
			if (!launched || !("browser" in launched)) throw new Error("Expected a shared Puppeteer browser");
			const endpoint = new URL(launched.wsEndpoint);
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
			const tabName = `attach-failure-${process.pid}-${Math.random().toString(36).slice(2)}`;
			try {
				attached = await acquireBrowser(
					{ kind: "connected", cdpUrl: `http://${endpoint.host}` },
					{ cwd: process.cwd() },
				);
				attempted = true;
				// Plain await, not `.rejects`: on Windows, once an earlier test has
				// spawned a piped child, Bun's `.rejects` loop spin stops servicing
				// this thread's CDP socket, so the paused request never reaches
				// `onRequest` and worker init times out instead.
				const error = await rejectionOf(
					acquireTab(tabName, attached, {
						// The page the interception is on: an open without a target would make its own.
						target: privateTargetId(targetPage.target()),
						// Loopback keeps a hypothetical interception miss local and
						// loud (instant connection refusal, count 0) instead of
						// wandering into DNS or a proxy.
						url: "http://127.0.0.1:9/aborted-by-interception",
						waitUntil: "domcontentloaded",
						timeoutMs: 15_000,
					}),
				);
				expect(error).toBeInstanceOf(Error);
				expect(error).toMatchObject({ message: expect.stringMatching(/net::ERR_FAILED/) });
				expect(requestCount).toBe(1);
				// The failed open rolls back its tab, and with it the tab's hold on the attached browser.
				expect(getTab(tabName)).toBeUndefined();
				expect(attached.refCount).toBe(0);
			} finally {
				targetPage.off("request", onRequest);
				await targetPage.setRequestInterception(false);
				if (attached && !attempted) await releaseBrowser(attached, { kill: false });
			}
		},
		30_000,
	);

	test("names the refused CDP websocket instead of reporting [object ErrorEvent]", async () => {
		// `/json/version` answers, but its debugger websocket refuses the upgrade.
		const cdp = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, server) =>
				new URL(request.url).pathname === "/json/version"
					? Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/gone` })
					: new Response("gone", { status: 404 }),
		});
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		try {
			const error = await rejectionOf(
				prelude.invoke(
					{
						action: "open",
						name: `refused-${crypto.randomUUID()}`,
						app: `http://127.0.0.1:${cdp.port}`,
					},
					{ session, toolCallId: "refused-websocket" },
				),
			);
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({
				message: expect.stringContaining(
					`WebSocket connection to 'ws://127.0.0.1:${cdp.port}/devtools/browser/gone'`,
				),
			});
		} finally {
			cdp.stop(true);
		}
	});
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
		expect(borrowed).toEqual([`--user-data-dir=${path.resolve("/home/me/.config/chrome")}`]);
	});
});
describe("pickElectronTarget", () => {
	it("does not satisfy a connected-browser matcher from another page when one is unreadable", async () => {
		const unreadable = makeTarget("PAGE_A", {
			url: () => {
				throw new Error("Page frame unavailable");
			},
			title: async () => "Cart",
		} as unknown as Page);
		const otherMatch = makeTarget("PAGE_B", fakePage({ url: "https://example.com/cart", title: "Cart" }));

		await expect(
			pickElectronTarget(makeBrowser([unreadable.target, otherMatch.target]), { matcher: "cart" }),
		).rejects.toThrow(/tab.*not ready/i);
	});

	it("aborts target discovery when the caller cancels", async () => {
		const controller = new AbortController();
		const page = Promise.withResolvers<Page | null>();
		const { target } = makeTarget("PAGE_CANCEL");
		Object.assign(target, { page: () => page.promise });
		const selection = pickElectronTarget(makeBrowser([target]), { signal: controller.signal });

		controller.abort(new Error("user cancelled"));
		page.resolve(null);
		await expect(selection).rejects.toThrow("Operation aborted");
	});

	it("aborts frame-readiness polling when the caller cancels", async () => {
		const controller = new AbortController();
		const page = {
			url: () => {
				throw new Error("Requesting main frame too early!");
			},
		} as unknown as Page;
		const readiness = waitForMainFrame(page, 100, controller.signal);

		controller.abort();
		await expect(readiness).rejects.toThrow("Operation aborted");
	});
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

describe("pickRelayTargetId", () => {
	async function serveRelay(entries: unknown[]): Promise<{ url: string; stop: () => Promise<void> }> {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname.endsWith("/json")
					? Response.json(entries)
					: new Response("not found", { status: 404 });
			},
		});
		return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
	}

	test("returns the matching page id without a browser or an attachment", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_A.1", type: "page", url: "https://example.com/other", title: "Other", active: "false" },
			{ id: "PAGE_A.2", type: "page", url: "https://example.com/report", title: "Quarterly report", active: "true" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "quarterly" })).resolves.toBe("PAGE_A.2");
		} finally {
			await relay.stop();
		}
	});

	test("prefers an exact target id over a URL substring on another page", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_A.1", type: "page", url: "https://example.com/PAGE_A.2", title: "First" },
			{ id: "PAGE_A.2", type: "page", url: "about:blank", title: "" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "PAGE_A.2" })).resolves.toBe("PAGE_A.2");
		} finally {
			await relay.stop();
		}
	});

	test("refuses a discarded match and names the recovery", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_A.1", type: "page", url: "https://example.com/report", title: "Report", discarded: "true" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "report" })).rejects.toThrow(
				'The tab matching "report" was discarded by Chrome. Click it to reload, then retry.',
			);
		} finally {
			await relay.stop();
		}
	});

	test("explains when the relay lists no page to adopt", async () => {
		const relay = await serveRelay([]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "report" })).rejects.toThrow("lists no page to adopt");
		} finally {
			await relay.stop();
		}
	});

	test("reports a failed page listing as a relay problem, not as a missing page", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) });
		try {
			const error = await rejectionOf(pickRelayTargetId(`http://127.0.0.1:${server.port}`, { matcher: "report" }));
			expect((error as Error).message).toContain("did not list its pages (GET /json failed)");
			expect((error as Error).message).not.toContain("no page to adopt");
		} finally {
			await server.stop(true);
		}
	});

	test("adopts the active tab when no target is named", async () => {
		const relay = await serveRelay(RELAY_ENTRIES);
		try {
			await expect(pickRelayTargetId(relay.url)).resolves.toBe("PAGE11");
		} finally {
			await relay.stop();
		}
	});

	test("skips a discarded match for a live one", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_OLD", type: "page", title: "Old cart", url: "https://example.com/cart/old", discarded: "true" },
			{ id: "PAGE_LIVE", type: "page", title: "Cart", url: "https://example.com/cart", discarded: "false" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "cart" })).resolves.toBe("PAGE_LIVE");
		} finally {
			await relay.stop();
		}
	});

	test("chooses the first of two live matching tabs", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_A", type: "page", title: "Cart A", url: "https://example.com/cart/a", discarded: "false" },
			{ id: "PAGE_B", type: "page", title: "Cart B", url: "https://example.com/cart/b", discarded: "false" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "cart" })).resolves.toBe("PAGE_A");
		} finally {
			await relay.stop();
		}
	});

	test("refuses another tab when an exact id names a discarded one", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_FIRST", type: "page", title: "First", url: "https://example.com/PAGE_GONE", discarded: "false" },
			{ id: "PAGE_GONE", type: "page", title: "Second", url: "about:blank", discarded: "true" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url, { matcher: "PAGE_GONE" })).rejects.toThrow(
				"was discarded by Chrome",
			);
		} finally {
			await relay.stop();
		}
	});

	test("skips an active service worker page unless it is named", async () => {
		const relay = await serveRelay([
			{ id: "PAGE_SW", type: "page", title: "Service Worker", url: "https://example.com/a", active: "true" },
			{ id: "PAGE_HOME", type: "page", title: "Home", url: "https://example.com/b", active: "false" },
		]);
		try {
			await expect(pickRelayTargetId(relay.url)).resolves.toBe("PAGE_HOME");
			await expect(pickRelayTargetId(relay.url, { matcher: "Service Worker" })).resolves.toBe("PAGE_SW");
		} finally {
			await relay.stop();
		}
	});

	test("waits for a just-opened tab to reach /json before failing the matcher", async () => {
		const opened = { id: "PAGE_NEW", type: "page", title: "", url: "https://example.com/?omp-probe=new" };
		let served = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json(++served === 1 ? RELAY_ENTRIES : [...RELAY_ENTRIES, opened]),
		});
		try {
			await expect(pickRelayTargetId(`http://127.0.0.1:${server.port}`, { matcher: "omp-probe=new" })).resolves.toBe(
				"PAGE_NEW",
			);
			expect(served).toBe(2);
		} finally {
			await server.stop(true);
		}
	});

	test("lists relay page ids with their URLs when a target id is missing", async () => {
		const relay = await serveRelay(RELAY_ENTRIES);
		try {
			const message = ((await rejectionOf(pickRelayTargetId(relay.url, { matcher: "PAGE_MISSING" }))) as Error)
				.message;
			expect(message).toContain('No page target matched "PAGE_MISSING"');
			expect(message).toContain("PAGE10  Docs  https://docs.example.com");
			expect(message).toContain("PAGE11  Whole Foods Market Shopping Cart  https://www.amazon.com/cart/localmarket");
		} finally {
			await relay.stop();
		}
	});

	test("reads relay metadata past an HTTP proxy without corrupting UTF-8 titles", async () => {
		const entries = [
			{ id: "PAGE_A", type: "page", title: "Other", url: "https://example.com/a", active: "false" },
			{ id: "PAGE_B", type: "page", title: "Café", url: "https://example.com/b", active: "true" },
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
			await expect(pickRelayTargetId(`http://127.0.0.1:${relay.port}`, { matcher: "Café" })).resolves.toBe("PAGE_B");
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
});
