/**
 * Regression test for issue #4499: closing a cmux-backend tab while a
 * `tab.run(...)` helper call (internally a run action) is in flight rejected an orphaned
 * `Promise.withResolvers()` promise created in `runInTabWithSnapshot`. The
 * cmux branch originally awaited `runCmuxCode(...)` directly and never
 * awaited/`.catch`ed the local `promise`; only `pending.reject` was stashed
 * on the tab so `releaseTab` could signal in-flight runs. Zero consumers
 * meant that `reject(...)` surfaced as an unhandled rejection and the
 * top-level `unhandledRejection` handler tore the whole process down
 * (killing sibling tabs and subagents).
 *
 * The fix in `runInTabWithSnapshot` makes both backends await the same
 * `promise` (so `pending.reject` always has an attached handler AND the
 * caller sees the tab-close error immediately) and composes a new
 * `pending.closeAc` into the cmux run's abort signal, so `wait(...)` /
 * in-flight cmux socket calls / facade proxies unwind promptly when the
 * tab is closed. This test drives real `acquireBrowser` / `acquireTab` /
 * `runInTab` / `releaseTab` against a mocked `CmuxSocketClient` and covers:
 *
 * 1. Racing `releaseTab` against an in-flight cmux run never triggers
 *    `process.on("unhandledRejection", ...)` — the original crash — AND
 *    the awaiting `runInTab` call now rejects with `Tab ... was closed`
 *    immediately instead of blocking to the run's timeout.
 * 2. When the in-flight run is doing work that does NOT make another cmux
 *    socket request (e.g. `await wait(60_000)`), releasing the tab still
 *    unwinds the run — proving `closeAc.signal` reaches `waitForRun`
 *    and the facade proxies, not just the outer race. (Reviewer feedback
 *    from PR #4502.)
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import * as logger from "@oh-my-pi/pi-utils/logger";

function makeKind(socketSuffix: string): CmuxKind {
	return {
		kind: "cmux",
		socketPath: `/tmp/omp-test-${socketSuffix}.sock`,
		surface: `surface-${socketSuffix}`,
	};
}

function makeSession(cwd: string, screenshotDir?: string): ToolSession {
	// Minimal shape: `runInTab` reads `cwd`, `settings.get("browser.screenshotDir")`,
	// and `getActiveModel?.()`. Everything else is untouched by this flow.
	return {
		cwd,
		hasUI: false,
		settings: { get: (key: string) => (key === "browser.screenshotDir" ? screenshotDir : undefined) },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

async function drainAllTabs(): Promise<void> {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser tab-supervisor — cmux tab close mid-run (#4499)", () => {
	afterEach(async () => {
		try {
			await drainAllTabs();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("releaseTab() during an in-flight cmux run rejects the run and never emits unhandledRejection", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		// Signaled the first time the cmux client sees the stalling request
		// from the in-flight `runtime.run(code)` call. By the time the mock
		// enters this branch, tab-supervisor has already populated
		// `tab.pending` (it does so synchronously before invoking
		// `runCmuxCode`, which drives `runtime.run` -> `tab.goto` -> `#request`
		// -> this mock). This is the deterministic "the run is mid-flight" edge.
		const navStarted = Promise.withResolvers<void>();
		// Gate for the mocked `browser.navigate` response. Left pending across
		// the window we care about, then resolved during teardown so nothing
		// leaks past the test.
		const navGate = Promise.withResolvers<Record<string, unknown>>();

		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-mid-run", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						// `readyInfo()` needs `document.title` + geometry during
						// `acquireCmuxTab`; return quickly so setup lands.
						return { value: "" };
					case "browser.navigate":
						navStarted.resolve();
						return await navGate.promise;
					case "browser.wait":
					case "surface.close":
						return {};
					default:
						return {};
				}
			},
		);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const kind = makeKind("close-mid-run");
			const browser = await acquireBrowser(kind, { cwd: "/tmp" });
			const acquired = await acquireTab("docfinal", browser, {
				timeoutMs: 5_000,
				ownerSessionId: "session-mid-run",
			});
			expect(acquired.tab.backend).toBe("cmux");

			const session = makeSession("/tmp");
			// Fire the run WITHOUT awaiting. `runtime.run` drives `tab.goto`,
			// which drives `browser.navigate`, which stalls on `navGate` — so
			// `runInTab` sits inside `runCmuxCode` with `tab.pending` populated.
			// The 60_000ms timeout is intentional: on `main` (or with only the
			// no-op-catch fix), the call would block until this fires; a passing
			// test proves `releaseTab` unblocks it immediately via `promise`.
			const runPromise = runInTab("docfinal", {
				code: 'await tab.goto("https://example.test");',
				timeoutMs: 60_000,
				session,
			});

			// Deterministic wait: proceed only once the cmux request is actually
			// mid-flight (and therefore `tab.pending` is populated).
			await navStarted.promise;
			const tabBeforeRelease = getTabsMapForTest().get("docfinal");
			expect(tabBeforeRelease?.pending.size).toBeGreaterThan(0);

			// `releaseTab` walks `tab.pending` and calls `pending.reject(new
			// ToolError("Tab ... was closed"))`. On `main` this rejected an
			// orphaned promise (unhandledRejection -> fatal). With the fix,
			// the same reject settles the promise the caller is awaiting, so
			// `runInTab` finishes with `Tab "docfinal" was closed`
			// immediately — no 60s timeout wait.
			const released = await releaseTab("docfinal", { kill: false });
			expect(released).toBe(true);

			await expect(runPromise).rejects.toThrow(/Tab "docfinal" was closed/);

			// Drain the microtask queue so any pending unhandled-rejection
			// would have fired by the time we assert.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(unhandled).toEqual([]);
			expect(getTabsMapForTest().has("docfinal")).toBe(false);
		} finally {
			// Unblock the stalled `browser.navigate` so the abort signal
			// composed into the cmux run gets a chance to short-circuit the
			// in-flight request cleanly instead of leaking past the test.
			navGate.resolve({ url: "https://example.test" });
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("releaseTab() unblocks a cmux run that is not making any socket request (wait(...) mid-flight)", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-wait-mid-run", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						return { value: "" };
					case "browser.wait":
					case "surface.close":
						return {};
					default:
						return {};
				}
			},
		);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const kind = makeKind("wait-mid-run");
			const browser = await acquireBrowser(kind, { cwd: "/tmp" });
			const acquired = await acquireTab("docfinal", browser, {
				timeoutMs: 5_000,
				ownerSessionId: "session-wait-mid-run",
			});
			expect(acquired.tab.backend).toBe("cmux");

			const session = makeSession("/tmp");
			// The user code awaits `wait(60_000)` — which drives
			// `waitForRun(60_000, signal)` -> `untilAborted(signal,
			// () => Bun.sleep(60_000))` INSIDE the runtime. Nothing hits the
			// cmux socket, so on `main` the reviewer's exact scenario applies:
			// even after `pending.reject` unblocks the caller, `runCmuxCode`
			// stays blocked in `Bun.sleep(60_000)` until the run's timeout,
			// leaking the run past the tab lifetime.
			//
			// The fix composes `pending.closeAc.signal` into the run's abort
			// signal, so `releaseTab` cancels `untilAborted` synchronously and
			// the run unwinds within a microtask window.
			const runPromise = runInTab("docfinal", {
				code: "await wait(60_000);",
				timeoutMs: 60_000,
				session,
			});

			// Spin the microtask queue until the pending map is populated
			// (`runInTab` sets it synchronously before the first await, but the
			// call itself is async). One tick usually suffices; a small
			// bounded loop keeps the test robust against future micro-batching
			// changes without relying on real timers.
			for (let i = 0; i < 32; i++) {
				const tab = getTabsMapForTest().get("docfinal");
				if (tab && tab.pending.size > 0) break;
				await Promise.resolve();
			}
			const tabBeforeRelease = getTabsMapForTest().get("docfinal");
			expect(tabBeforeRelease?.pending.size).toBeGreaterThan(0);

			// Capture the pending run's `closeAc` BEFORE `releaseTab` clears
			// the map. This is the wire the reviewer asked us to check: the
			// tab-close event must reach the cmux run body, not only the
			// awaiting caller. Its `.signal.aborted` is the observable proof
			// that `waitForRun` / cmux socket calls will unwind
			// synchronously (via `untilAborted`) instead of blocking to the
			// 60_000ms timeout.
			const pendingBeforeRelease = [...(tabBeforeRelease?.pending.values() ?? [])];
			expect(pendingBeforeRelease.length).toBe(1);
			const capturedCloseAc = pendingBeforeRelease[0]?.closeAc;
			expect(capturedCloseAc).toBeDefined();
			expect(capturedCloseAc?.signal.aborted).toBe(false);

			// The scenario the reviewer flagged: no in-flight cmux request,
			// so only the `closeAc` propagation can unwind the run body.
			const released = await releaseTab("docfinal", { kill: false });
			expect(released).toBe(true);

			// Concrete contract: `releaseTab` MUST fire `closeAc.abort(...)` so
			// the composed `runSignal` in `runInTabWithSnapshot` transitions
			// to aborted. Without this line, the reviewer's failure mode
			// stands: the run body keeps executing until its own timeout.
			expect(capturedCloseAc).toBeDefined();
			expect(capturedCloseAc!.signal.aborted).toBe(true);
			expect(capturedCloseAc!.signal.reason).toBeInstanceOf(Error);
			expect((capturedCloseAc!.signal.reason as Error).message).toMatch(/Tab "docfinal" was closed/);

			// Caller-facing contract: `runInTab` rejects with the tab-close
			// error immediately, not after the run's 60_000ms timeout.
			await expect(runPromise).rejects.toThrow(/Tab "docfinal" was closed/);

			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(unhandled).toEqual([]);
			expect(getTabsMapForTest().has("docfinal")).toBe(false);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("logs a user continuation rejection after its cmux run ends", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const continuationStarted = Promise.withResolvers<void>();
		const continuationGate = Promise.withResolvers<void>();
		const globals = globalThis as typeof globalThis & {
			__ompLateRejectionStarted?: () => void;
			__ompLateRejectionGate?: Promise<void>;
		};
		globals.__ompLateRejectionStarted = continuationStarted.resolve;
		globals.__ompLateRejectionGate = continuationGate.promise;

		try {
			spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
				async (method: string): Promise<Record<string, unknown>> => {
					switch (method) {
						case "browser.open_split":
							return { surface_id: "surface-late-rejection", url: "about:blank" };
						case "browser.url.get":
							return { url: "about:blank" };
						case "browser.snapshot":
							return { page: { html: "" } };
						case "browser.eval":
							return { value: "" };
						default:
							return {};
					}
				},
			);
			const warningLogged = Promise.withResolvers<void>();
			const warn = spyOn(logger, "warn").mockImplementation(message => {
				if (message === "Unhandled rejection after browser run ended") warningLogged.resolve();
			});
			const browser = await acquireBrowser(makeKind("late-rejection"), { cwd: "/tmp" });
			await acquireTab("late-rejection", browser, {
				timeoutMs: 5_000,
				ownerSessionId: "session-late-rejection",
			});

			const result = await runInTab("late-rejection", {
				code: `
					const guestStarted = Promise.withResolvers();
					void tab.title().then(async () => {
						guestStarted.resolve();
						globalThis.__ompLateRejectionStarted();
						await globalThis.__ompLateRejectionGate;
						throw new Error("late cmux continuation failed");
					});
					await guestStarted.promise;
					return "completed";
				`,
				timeoutMs: 5_000,
				session: makeSession("/tmp"),
			});
			expect(result.returnValue).toBe("completed");
			await continuationStarted.promise;
			continuationGate.resolve();

			await warningLogged.promise;
			expect(warn).toHaveBeenCalledWith("Unhandled rejection after browser run ended", {
				runId: expect.any(String),
				error: "late cmux continuation failed",
			});
		} finally {
			continuationGate.resolve();
			delete globals.__ompLateRejectionStarted;
			delete globals.__ompLateRejectionGate;
		}
	});

	it("fails a browser error rethrown through a native promise combinator", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-combinator-rejection", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						return { value: "" };
					case "browser.navigate":
						throw new Error("navigation failed");
					default:
						return {};
				}
			},
		);
		const browser = await acquireBrowser(makeKind("combinator-rejection"), { cwd: "/tmp" });
		await acquireTab("combinator-rejection", browser, {
			timeoutMs: 5_000,
			ownerSessionId: "session-combinator-rejection",
		});

		const run = runInTab("combinator-rejection", {
			code: `
				void Promise.all([
					tab.goto("https://example.test"),
				]).catch(reason => {
					throw reason;
				});
				await wait(60_000);
				return "incorrect success";
			`,
			timeoutMs: 5_000,
			session: makeSession("/tmp"),
		});

		await expect(run).rejects.toThrow("Unhandled rejection (missing await?): navigation failed");
	});

	it("aborts the cmux run facade before draining floated continuations", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const delayedTitleStarted = Promise.withResolvers<void>();
		const delayedTitleGate = Promise.withResolvers<Record<string, unknown>>();
		let titleRequestCount = 0;
		const navigatedUrls: string[] = [];
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-drain-abort", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						if (params.script === "document.title" && ++titleRequestCount > 1) {
							delayedTitleStarted.resolve();
							return await delayedTitleGate.promise;
						}
						return { value: "ready" };
					case "browser.navigate":
						navigatedUrls.push(String(params.url));
						return { url: params.url };
					default:
						return {};
				}
			},
		);
		const browser = await acquireBrowser(makeKind("drain-abort"), { cwd: "/tmp" });
		await acquireTab("drain-abort", browser, {
			timeoutMs: 5_000,
			ownerSessionId: "session-drain-abort",
		});

		const result = await runInTab("drain-abort", {
			code: `
				void tab.title().then(() => tab.goto("https://late.example"));
				return "completed";
			`,
			timeoutMs: 5_000,
			session: makeSession("/tmp"),
		});
		expect(result.returnValue).toBe("completed");
		await delayedTitleStarted.promise;
		delayedTitleGate.resolve({ value: "ready" });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(navigatedUrls).toEqual([]);
	});

	it("ignores the daemon screenshot path when no screenshot directory is configured", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-screenshot", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						return { value: "" };
					case "browser.screenshot":
						return {
							path: "/workspace/screenshots/daemon-owned.png",
							png_base64:
								"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4z8ZAAAAAElFTkSuQmCC",
						};
					default:
						return {};
				}
			},
		);

		const browser = await acquireBrowser(makeKind("screenshot-temp"), { cwd: "/tmp" });
		await acquireTab("screenshot-temp", browser, {
			timeoutMs: 5_000,
			ownerSessionId: "session-screenshot-temp",
		});

		const result = await runInTab("screenshot-temp", {
			code: "return await tab.screenshot({ silent: true });",
			timeoutMs: 5_000,
			session: makeSession("/tmp"),
		});
		const savedPath = result.returnValue;
		expect(typeof savedPath).toBe("string");
		if (typeof savedPath !== "string") throw new Error("tab.screenshot() did not return a path");
		expect(path.dirname(savedPath)).toBe(os.tmpdir());
		expect(savedPath).not.toBe("/workspace/screenshots/daemon-owned.png");
		expect(await Bun.file(savedPath).exists()).toBe(true);
		await fs.rm(savedPath);
	});

	it("saves screenshots under the configured screenshot directory", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-screenshot-configured", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						return { value: "" };
					case "browser.screenshot":
						return {
							path: "/workspace/screenshots/daemon-owned.png",
							png_base64:
								"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4z8ZAAAAAElFTkSuQmCC",
						};
					default:
						return {};
				}
			},
		);

		const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cmux-screenshot-"));
		try {
			const browser = await acquireBrowser(makeKind("screenshot-configured"), { cwd: "/tmp" });
			await acquireTab("screenshot-configured", browser, {
				timeoutMs: 5_000,
				ownerSessionId: "session-screenshot-configured",
			});

			const result = await runInTab("screenshot-configured", {
				code: "return await tab.screenshot({ silent: true });",
				timeoutMs: 5_000,
				session: makeSession("/tmp", screenshotDir),
			});
			const savedPath = result.returnValue;
			expect(typeof savedPath).toBe("string");
			if (typeof savedPath !== "string") throw new Error("tab.screenshot() did not return a path");
			expect(path.dirname(savedPath)).toBe(screenshotDir);
			expect(await Bun.file(savedPath).exists()).toBe(true);
		} finally {
			await fs.rm(screenshotDir, { recursive: true, force: true });
		}
	});
});
