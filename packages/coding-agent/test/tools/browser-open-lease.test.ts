/**
 * Regression tests for issue #6365: the browser prelude host must apply the
 * requested `timeout` to the *entire* open lifecycle (browser acquisition +
 * tab acquisition), and must hold one explicit browser lease across tab
 * acquisition so a refCount:0 browser is never orphaned by an abort/timeout
 * nor disposed out from under a concurrent open of a different tab name.
 *
 * The host resolves the cmux backend (`CMUX_SOCKET_PATH` + settings), so
 * `CmuxSocketClient.prototype` is spied and no real socket / Chromium is used.
 */

import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { getTabsMapForTest, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Browser } from "puppeteer-core";
import { TimeoutError } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.cmux": true,
			// Tern resolves before cmux; keep an ambient Tern pane from capturing the open.
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
		getSessionId: () => "session-open-lease",
	};
}

function createBrowserHost() {
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, {
			session,
			toolCallId: "browser-open-lease-test",
			signal,
		});
}

async function drainAllTabs(): Promise<void> {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

let prevSocketPath: string | undefined;

beforeEach(() => {
	prevSocketPath = process.env.CMUX_SOCKET_PATH;
	// Unique per test so the module-global browsers map (keyed by socket path)
	// never carries a handle across tests.
	process.env.CMUX_SOCKET_PATH = `/tmp/omp-open-lease-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
});

afterEach(async () => {
	vi.useRealTimers();
	await drainAllTabs().catch(() => undefined);
	vi.restoreAllMocks();
	if (prevSocketPath === undefined) delete process.env.CMUX_SOCKET_PATH;
	else process.env.CMUX_SOCKET_PATH = prevSocketPath;
});

describe("browser open — requested timeout bounds the whole acquisition (#6365)", () => {
	it("rejects with a timeout ToolError when browser acquisition stays pending past the deadline", async () => {
		vi.useFakeTimers();
		const connectGate = Promise.withResolvers<void>();
		spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await connectGate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		const invokeBrowser = createBrowserHost();
		const open = invokeBrowser({ action: "open", name: "late", timeout: 1 });
		const settled = open.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);

		// The requested 1s deadline elapses while `acquireBrowser` is still
		// blocked on the (never-resolving) socket connect. Bun's fake timers fire
		// `AbortSignal.timeout` synchronously on advance; awaiting `settled` below
		// flushes the rejection.
		vi.advanceTimersByTime(1000);

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		// The requested action timeout surfaces as a timeout ToolError — never a
		// ToolAbortError (that is reserved for caller cancellation).
		expect(outcome.err).toBeInstanceOf(ToolError);
		expect(outcome.err).not.toBeInstanceOf(ToolAbortError);
		if (!(outcome.err instanceof Error)) throw new Error("Expected an error");
		expect(outcome.err.message).toMatch(/timed out/i);

		// Let the orphan launch resolve; the aborted deadline must dispose it so
		// no refCount:0 browser survives in the registry.
		connectGate.resolve();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(registry.getBrowsersMapForTest().size).toBe(0);
		expect(outcome.err.message).toContain("while launching or connecting to the browser (cmux:split)");
	});

	it("names the tab step when tab acquisition stays pending past the deadline", async () => {
		vi.useFakeTimers();
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const openSplitGate = Promise.withResolvers<void>();
		const openSplitEntered = Promise.withResolvers<void>();
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openSplitEntered.resolve();
					await openSplitGate.promise;
				}
				return {};
			},
		);

		const invokeBrowser = createBrowserHost();
		const open = rejectionOf(invokeBrowser({ action: "open", name: "slow-tab", timeout: 1 }));
		await openSplitEntered.promise;
		vi.advanceTimersByTime(1000);

		const error = await open;
		openSplitGate.resolve();
		expect(error).toBeInstanceOf(ToolError);
		if (!(error instanceof Error)) throw new Error("Expected an error");
		expect(error.message).toContain('timed out after 1000ms while opening tab "slow-tab"');
	});
});

describe("browser open — caller cancellation rolls back the fresh browser (#6365)", () => {
	it("aborting before tab publication rejects with ToolAbortError and leaves both maps empty", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const openSplitGate = Promise.withResolvers<void>();
		const surfaceClosed: string[] = [];
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					await openSplitGate.promise;
					return { surface_id: "surface-abort", url: "about:blank" };
				}
				if (method === "surface.close") {
					surfaceClosed.push(String(params.surface_id));
					return {};
				}
				return {};
			},
		);

		const invokeBrowser = createBrowserHost();
		const controller = new AbortController();
		const open = invokeBrowser({ action: "open", name: "fresh", timeout: 30 }, controller.signal);
		const settled = open.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);

		// Browser acquisition has resolved; tab acquisition is parked in
		// `open_split`. Cancel here — before any tab is published.
		await Promise.resolve();
		controller.abort();

		const outcome = await settled;
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("unreachable");
		expect(outcome.err).toBeInstanceOf(ToolAbortError);

		// The open-acquisition lease rollback disposes the fresh browser exactly
		// once and leaves nothing owned solely by the failed open.
		expect(getTabsMapForTest().has("fresh")).toBe(false);
		expect(registry.getBrowsersMapForTest().size).toBe(0);
		expect(closeSpy).toHaveBeenCalledTimes(1);

		// Let the orphaned acquisition unwind so it does not leak past the test.
		openSplitGate.resolve();
		await Promise.resolve();
	});
});

describe("browser open — an abandoned browser acquisition does not hold up the next one", () => {
	it("starts a fresh connect for the next open instead of waiting out a timed-out one", async () => {
		const stalledConnect = Promise.withResolvers<void>();
		let connects = 0;
		spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			if (++connects === 1) await stalledConnect.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> =>
				method === "browser.open_split" ? { surface_id: "surface-retry", url: "about:blank" } : {},
		);
		const invokeBrowser = createBrowserHost();

		vi.useFakeTimers();
		const first = rejectionOf(invokeBrowser({ action: "open", name: "retry", timeout: 1 }));
		vi.advanceTimersByTime(1000);
		expect(await first).toBeInstanceOf(ToolError);
		vi.useRealTimers();

		// The connect the timed-out open started never returns; the retry must
		// not queue behind it.
		const second = await invokeBrowser({ action: "open", name: "retry", timeout: 2 });
		expect(second.content.some(part => part.type === "text" && /Opened tab "retry"/.test(part.text ?? ""))).toBe(
			true,
		);
		expect(connects).toBe(2);

		// When the abandoned connect finally returns, it disposes only its own
		// client and leaves the retry's browser and tab in place.
		stalledConnect.resolve();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(registry.getBrowsersMapForTest().size).toBe(1);
		expect(getTabsMapForTest().has("retry")).toBe(true);
	});

	it("keeps the replacement acquisition shared when the abandoned one settles while it is still connecting", async () => {
		const kind = { kind: "cmux" as const, socketPath: `/tmp/omp-open-lease-${process.pid}-late.sock` };
		const abandonedConnect = { entered: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
		const replacementConnect = { entered: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
		const gatedConnects = [abandonedConnect, replacementConnect];
		let connects = 0;
		spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			const gated = gatedConnects[connects++];
			gated?.entered.resolve();
			await gated?.gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		const owner = new AbortController();
		const abandoned = rejectionOf(registry.acquireBrowser(kind, { cwd: "/tmp", signal: owner.signal }));
		await abandonedConnect.entered.promise;
		owner.abort();
		const replacement = registry.acquireBrowser(kind, { cwd: "/tmp" });
		await replacementConnect.entered.promise;
		abandonedConnect.gate.resolve();
		expect(await abandoned).toBeInstanceOf(ToolAbortError);

		// A third acquisition arriving now must join the replacement, not launch its own.
		const joined = registry.acquireBrowser(kind, { cwd: "/tmp" });
		for (let i = 0; i < 20; i++) await Promise.resolve();
		replacementConnect.gate.resolve();
		const [first, second] = await Promise.all([replacement, joined]);
		const disposedBeforeRelease = closeSpy.mock.calls.length;
		for (const handle of new Set([first, second])) await registry.releaseBrowser(handle, { kill: false });
		expect(second).toBe(first);
		expect(connects).toBe(2);
		expect(disposedBeforeRelease).toBe(1);
	});

	it("waits until a spawned app's abandoned acquisition has killed the app before looking for one to reuse", async () => {
		// A long-lived stand-in app that exists on every platform: this Bun binary sleeping.
		const kind = { kind: "spawned" as const, path: process.execPath, args: ["-e", "await Bun.sleep(30_000)"] };
		const cwd = os.tmpdir();
		const events: string[] = [];
		let lookups = 0;
		spyOn(attach, "findReusableCdp").mockImplementation(async () => {
			events.push("lookup");
			return lookups++ === 0 ? null : { cdpUrl: "http://127.0.0.1:1", pid: 4242 };
		});
		spyOn(attach, "findFreeCdpPort").mockResolvedValue(1);
		spyOn(attach, "waitForCdp").mockResolvedValue(undefined);
		const stalledConnect = Promise.withResolvers<Browser>();
		const firstConnect = Promise.withResolvers<void>();
		spyOn(launch, "connectPuppeteer").mockImplementation(() => {
			events.push("connect");
			firstConnect.resolve();
			return stalledConnect.promise;
		});
		const killGate = Promise.withResolvers<void>();
		spyOn(attach, "gracefulKillTreeOnce").mockImplementation(async pid => {
			events.push("kill-start");
			await killGate.promise;
			process.kill(pid, "SIGKILL");
			events.push("kill-end");
		});
		const browser = { connected: true, disconnect: () => undefined } as unknown as Browser;

		const owner = new AbortController();
		const first = rejectionOf(registry.acquireBrowser(kind, { cwd, signal: owner.signal }));
		await firstConnect.promise;
		owner.abort();
		const second = registry.acquireBrowser(kind, { cwd });
		stalledConnect.resolve(browser);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		killGate.resolve();

		expect(await first).toBeInstanceOf(ToolAbortError);
		const handle = await second;
		await registry.releaseBrowser(handle, { kill: false });
		expect(events).toEqual(["lookup", "connect", "kill-start", "kill-end", "lookup", "connect"]);
	});
});

describe("browser open — failed spawned-app acquisition reaps its owned process (#9537)", () => {
	it("kills the OMP-spawned process when no page target can be published", async () => {
		const disconnectSpy = vi.fn();
		const browser = {
			key: "spawned:/tmp/chrome-headless-shell",
			kind: { kind: "spawned", path: "/tmp/chrome-headless-shell" },
			refCount: 0,
			browser: {
				connected: true,
				disconnect: disconnectSpy,
				wsEndpoint: () => "ws://127.0.0.1/devtools/browser/test",
				targets: () => [],
				pages: async () => [],
				waitForTarget: async () => {
					throw new TimeoutError("No page target appeared");
				},
			},
			pid: 4242,
			subprocess: { pid: 4242, exitCode: null },
			stealth: { browserSession: null, override: null },
		} as unknown as registry.BrowserHandle;
		spyOn(registry, "acquireBrowser").mockResolvedValue(browser);
		const killSpy = spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);

		const invokeBrowser = createBrowserHost();
		await expect(
			invokeBrowser({
				action: "open",
				name: "failed-open",
				app: { path: "/tmp/chrome-headless-shell" },
				timeout: 1,
			}),
		).rejects.toBeInstanceOf(ToolError);

		expect(disconnectSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy.mock.calls[0]?.[0]).toBe(4242);
		expect(registry.getBrowsersMapForTest().size).toBe(0);
		expect(getTabsMapForTest().has("failed-open")).toBe(false);
	});
});

describe("browser open — concurrent different-name acquisitions each own a lease (#6365)", () => {
	it("aborting one open releases only its lease; the survivor keeps the browser and one tab", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const openGate = Promise.withResolvers<void>();
		let splitCount = 0;
		const aEntered = Promise.withResolvers<void>();
		const bEntered = Promise.withResolvers<void>();
		const surfaceClosed: string[] = [];
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					const id = `surface-${++splitCount}`;
					(splitCount === 1 ? aEntered : bEntered).resolve();
					await openGate.promise;
					return { surface_id: id, url: "about:blank" };
				}
				if (method === "surface.close") {
					surfaceClosed.push(String(params.surface_id));
					return {};
				}
				return {};
			},
		);

		const invokeBrowser = createBrowserHost();

		// Open A first and wait until it is parked inside `open_split` — proof it
		// acquired the shared browser and took its open-acquisition lease.
		const controllerA = new AbortController();
		const openA = invokeBrowser({ action: "open", name: "tab-a", timeout: 30 }, controllerA.signal);
		const settledA = openA.then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, err }),
		);
		await aEntered.promise;
		expect(registry.getBrowsersMapForTest().size).toBe(1);

		// Open B against the SAME browser (different tab name). It reuses the
		// registry handle and takes its own lease; both are now parked.
		const openB = invokeBrowser({ action: "open", name: "tab-b", timeout: 30 });
		await bEntered.promise;

		// Abort A while both are queued; releasing A's lease must not dispose the
		// browser B still needs.
		controllerA.abort();
		const outcomeA = await settledA;
		expect(outcomeA.ok).toBe(false);
		if (outcomeA.ok) throw new Error("unreachable");
		expect(outcomeA.err).toBeInstanceOf(ToolAbortError);

		// Release the gate so B publishes its tab.
		openGate.resolve();
		const resultB = await openB;
		expect(resultB.content.some(part => part.type === "text" && /Opened tab "tab-b"/.test(part.text ?? ""))).toBe(
			true,
		);

		// B's browser survived A's rollback: still present, never closed, exactly
		// one published tab. A's rollback closed only its own orphan surface.
		expect(registry.getBrowsersMapForTest().size).toBe(1);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(getTabsMapForTest().has("tab-b")).toBe(true);
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().size).toBe(1);
		expect(surfaceClosed).toEqual(["surface-1"]);
	});
});
