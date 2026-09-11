/**
 * Regression tests for issue #8246: session-owned headless tabs outlive their
 * purpose and burn CPU/GPU (unthrottled rAF + SwiftShader) until session
 * dispose. The settle machinery under test:
 *
 * - `freezeTabsForOwner` pauses rAF/timers via `Page.setWebLifecycleState`
 *   while keeping renderer/worker/DOM state for millisecond resume;
 * - `releaseIdleTabsForOwner` closes tabs idle past the timeout as the
 *   memory backstop;
 * - reuse/run refresh `lastActivityAt` and resume frozen tabs.
 *
 * Scope contract (the thing that must never regress): settle touches ONLY
 * OMP-launched headless worker tabs of the owning session that did not opt
 * out with `persist`. Relay/connected/spawned tabs drive the user's own
 * pages, cmux is a different backend with no CDP lifecycle, and other
 * sessions' tabs belong to their owners.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	armIdleCloseForOwner,
	cancelIdleCloseForOwner,
	earliestIdleCloseInMs,
	ensureSpawnedKilledForTest,
	freezeTabsForOwner,
	getTabsMapForTest,
	hasIdleCloseTimerForTest,
	isIdleCloseCandidate,
	releaseIdleTabsForOwner,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
	setTabFrozenForTest,
	unfreezeTabSessionForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { PendingRun, TabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

let mockSurfaceSeq = 0;

function mockCmuxSocket(): void {
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (method: string): Promise<Record<string, unknown>> => {
			if (method === "browser.open_split") {
				mockSurfaceSeq++;
				return { surface_id: `surface-mock-${mockSurfaceSeq}`, url: "about:blank" };
			}
			if (method === "browser.url.get") return { url: "about:blank" };
			if (method === "browser.snapshot") return { page: { html: "" } };
			if (method === "browser.geometry") return {};
			if (method === "browser.eval") return { value: "" };
			return {};
		},
	);
}

async function drainAllTabs(): Promise<void> {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

interface CdpCall {
	method: string;
	params?: unknown;
}

/** Minimal worker-tab double: `_targetId` hits the fast path in target lookup. */
function makeStubTab(overrides: Record<string, unknown> = {}): { tab: TabSession; calls: CdpCall[] } {
	const calls: CdpCall[] = [];
	const session = {
		send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
			calls.push({ method, params });
			return {};
		},
		detach: async (): Promise<void> => undefined,
	};
	const target = {
		_targetId: "stub-target-1",
		createCDPSession: async () => session,
	};
	const tab = {
		name: "stub-tab",
		browser: { browser: { targets: () => [target] } },
		targetId: "stub-target-1",
		backend: "worker",
		state: "alive",
		info: {},
		pending: new Map(),
		kindTag: "headless",
		ownerSessionId: "session-stub",
		persist: false,
		lastActivityAt: Date.now(),
		frozen: false,
		...overrides,
	} as unknown as TabSession;
	return { tab, calls };
}

describe("browser settle — lifecycle freeze via CDP", () => {
	it("freezes a managed headless tab and resumes it", async () => {
		const { tab, calls } = makeStubTab();

		expect(await setTabFrozenForTest(tab, true)).toBe(true);
		expect(tab.frozen).toBe(true);
		expect(calls.map(call => call.method)).toEqual(["Page.enable", "Page.setWebLifecycleState"]);
		expect(calls[1]?.params).toEqual({ state: "frozen" });

		expect(await setTabFrozenForTest(tab, false)).toBe(true);
		expect(tab.frozen).toBe(false);
		expect(calls.at(-1)).toEqual({ method: "Page.setWebLifecycleState", params: { state: "active" } });
	});

	it("a repeated transition without state change issues no CDP call", async () => {
		const { tab, calls } = makeStubTab();
		expect(await setTabFrozenForTest(tab, true)).toBe(true);
		const sendCount = calls.length;

		expect(await setTabFrozenForTest(tab, true)).toBe(false);
		expect(calls.length).toBe(sendCount);
	});

	it("never touches tabs outside the settle scope", async () => {
		const cases: Array<{ label: string; overrides: Record<string, unknown> }> = [
			{ label: "relay", overrides: { kindTag: "relay" } },
			{ label: "connected", overrides: { kindTag: "connected" } },
			{ label: "spawned", overrides: { kindTag: "spawned" } },
			{ label: "cmux backend", overrides: { backend: "cmux", kindTag: "cmux" } },
			{ label: "persist opt-out", overrides: { persist: true } },
			{ label: "dead tab", overrides: { state: "dead" } },
			{ label: "in-flight run", overrides: { pending: new Map([["run-1", {}]]) } },
		];
		for (const { label, overrides } of cases) {
			const { tab, calls } = makeStubTab(overrides);
			expect(await setTabFrozenForTest(tab, true), label).toBe(false);
			expect(tab.frozen, label).toBe(false);
			expect(calls.length, label).toBe(0);
		}
	});

	it("leaves the tab unfrozen when its target is gone", async () => {
		const { tab, calls } = makeStubTab({
			browser: { browser: { targets: () => [] } },
		});
		expect(await setTabFrozenForTest(tab, true)).toBe(false);
		expect(tab.frozen).toBe(false);
		expect(calls.length).toBe(0);
	});

	it("leaves the tab unfrozen when the protocol call fails", async () => {
		const { tab, calls } = makeStubTab({
			browser: {
				browser: {
					targets: () => [
						{
							_targetId: "stub-target-1",
							createCDPSession: async () => {
								throw new Error("target crashed");
							},
						},
					],
				},
			},
		});
		expect(await setTabFrozenForTest(tab, true)).toBe(false);
		expect(tab.frozen).toBe(false);
		expect(calls.length).toBe(0);
	});
	describe("browser settle — freeze vs run race", () => {
		it("a run that registers mid-transition forces the freeze to undo itself", async () => {
			const calls: CdpCall[] = [];
			const frozenStarted = Promise.withResolvers<void>();
			const releaseFrozenSend = Promise.withResolvers<void>();
			let lifecycleSends = 0;
			const session = {
				send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
					calls.push({ method, params });
					if (method === "Page.setWebLifecycleState" && lifecycleSends++ === 0) {
						frozenStarted.resolve();
						await releaseFrozenSend.promise;
					}
					return {};
				},
				detach: async (): Promise<void> => undefined,
			};
			const { tab } = makeStubTab({
				browser: {
					browser: { targets: () => [{ _targetId: "stub-target-1", createCDPSession: async () => session }] },
				},
			});

			const freeze = setTabFrozenForTest(tab, true);
			await frozenStarted.promise;
			// The run path registers `pending` before driving the page; the
			// freeze observes it at completion and must back out.
			const inFlight = {} as unknown as PendingRun;
			tab.pending.set("run-1", inFlight);
			releaseFrozenSend.resolve();

			expect(await freeze).toBe(false);
			expect(tab.frozen).toBe(false);
			expect(calls.map(call => call.method)).toEqual([
				"Page.enable",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
			]);
			expect(calls.at(-1)?.params).toEqual({ state: "active" });
		});

		it("backs out when the tab opts out mid-transition", async () => {
			const calls: CdpCall[] = [];
			const frozenStarted = Promise.withResolvers<void>();
			const releaseFrozenSend = Promise.withResolvers<void>();
			let lifecycleSends = 0;
			const session = {
				send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
					calls.push({ method, params });
					if (method === "Page.setWebLifecycleState") {
						lifecycleSends++;
						if (lifecycleSends === 1) {
							frozenStarted.resolve();
							await releaseFrozenSend.promise;
						}
					}
					return {};
				},
				detach: async (): Promise<void> => undefined,
			};
			const { tab } = makeStubTab({
				browser: {
					browser: { targets: () => [{ _targetId: "stub-target-1", createCDPSession: async () => session }] },
				},
			});

			const freeze = setTabFrozenForTest(tab, true);
			await frozenStarted.promise;
			// Owner promotes to persist with no run involved: the freeze
			// must still undo instead of recording a frozen persist tab.
			tab.persist = true;
			releaseFrozenSend.resolve();

			expect(await freeze).toBe(false);
			expect(tab.frozen).toBe(false);
			expect(calls.map(call => call.method)).toEqual([
				"Page.enable",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
			]);
			expect(calls.at(-1)?.params).toEqual({ state: "active" });
		});

		it("records frozen when the race undo itself fails", async () => {
			const calls: CdpCall[] = [];
			const frozenStarted = Promise.withResolvers<void>();
			const releaseFrozenSend = Promise.withResolvers<void>();
			let lifecycleSends = 0;
			const session = {
				send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
					calls.push({ method, params });
					if (method === "Page.setWebLifecycleState") {
						lifecycleSends++;
						if (lifecycleSends === 1) {
							frozenStarted.resolve();
							await releaseFrozenSend.promise;
						} else {
							throw new Error("undo lost");
						}
					}
					return {};
				},
				detach: async (): Promise<void> => undefined,
			};
			const { tab } = makeStubTab({
				browser: {
					browser: { targets: () => [{ _targetId: "stub-target-1", createCDPSession: async () => session }] },
				},
			});

			const freeze = setTabFrozenForTest(tab, true);
			await frozenStarted.promise;
			tab.pending.set("run-1", {} as unknown as PendingRun);
			releaseFrozenSend.resolve();

			// No transition happened, but the frozen frame very likely landed
			// while its undo did not (initial attempt plus one retry): later
			// runs must resume via unfreeze.
			expect(await freeze).toBe(false);
			expect(tab.frozen).toBe(true);
			expect(calls.map(call => call.method)).toEqual([
				"Page.enable",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
			]);
		});

		it("recovers the in-flight run when the race undo succeeds on retry", async () => {
			const calls: CdpCall[] = [];
			const frozenStarted = Promise.withResolvers<void>();
			const releaseFrozenSend = Promise.withResolvers<void>();
			let lifecycleSends = 0;
			const session = {
				send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
					calls.push({ method, params });
					if (method === "Page.setWebLifecycleState") {
						lifecycleSends++;
						if (lifecycleSends === 1) {
							frozenStarted.resolve();
							await releaseFrozenSend.promise;
						} else if (lifecycleSends === 2) {
							throw new Error("undo blip");
						}
					}
					return {};
				},
				detach: async (): Promise<void> => undefined,
			};
			const { tab } = makeStubTab({
				browser: {
					browser: { targets: () => [{ _targetId: "stub-target-1", createCDPSession: async () => session }] },
				},
			});

			const freeze = setTabFrozenForTest(tab, true);
			await frozenStarted.promise;
			tab.pending.set("run-1", {} as unknown as PendingRun);
			releaseFrozenSend.resolve();

			expect(await freeze).toBe(false);
			expect(tab.frozen).toBe(false);
			expect(calls.map(call => call.method)).toEqual([
				"Page.enable",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
				"Page.setWebLifecycleState",
			]);
			expect(calls.at(-1)?.params).toEqual({ state: "active" });
		});
	});

	describe("browser settle — pre-run resume", () => {
		it("reports resumable tabs without touching CDP", async () => {
			const { tab, calls } = makeStubTab();
			expect(await unfreezeTabSessionForTest(tab)).toBe(true);
			expect(calls.length).toBe(0);
		});

		it("resumes a frozen tab and clears the flag", async () => {
			const { tab, calls } = makeStubTab({ frozen: true });
			expect(await unfreezeTabSessionForTest(tab)).toBe(true);
			expect(tab.frozen).toBe(false);
			expect(calls.map(call => call.method)).toEqual(["Page.enable", "Page.setWebLifecycleState"]);
			expect(calls.at(-1)?.params).toEqual({ state: "active" });
		});

		it("fails a refused resume so the run errors instead of stalling", async () => {
			const { tab, calls } = makeStubTab({
				frozen: true,
				browser: {
					browser: {
						targets: () => [
							{
								_targetId: "stub-target-1",
								createCDPSession: async () => ({
									send: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
										calls.push({ method, params });
										if (method === "Page.setWebLifecycleState") throw new Error("refused");
										return {};
									},
									detach: async (): Promise<void> => undefined,
								}),
							},
						],
					},
				},
			});
			expect(await unfreezeTabSessionForTest(tab)).toBe(false);
			expect(tab.frozen).toBe(true);
		});

		it("lets a run proceed when the frozen target is already gone", async () => {
			const { tab, calls } = makeStubTab({
				frozen: true,
				browser: { browser: { targets: () => [] } },
			});
			expect(await unfreezeTabSessionForTest(tab)).toBe(true);
			expect(calls.length).toBe(0);
		});
	});

	describe("browser settle — spawned kill guards", () => {
		function stubBrowser(overrides: Record<string, unknown> = {}): BrowserHandle {
			return { kind: { kind: "headless" }, ...overrides } as unknown as BrowserHandle;
		}

		it("never touches non-spawned browsers", async () => {
			await expect(ensureSpawnedKilledForTest(stubBrowser())).resolves.toBeUndefined();
			await expect(
				ensureSpawnedKilledForTest(stubBrowser({ kind: { kind: "connected", cdpUrl: "http://x" } })),
			).resolves.toBeUndefined();
		});

		it("skips exited or untracked spawned apps", async () => {
			await expect(
				ensureSpawnedKilledForTest(
					stubBrowser({ kind: { kind: "spawned", path: "/x" }, pid: 1, subprocess: { exitCode: 0 } }),
				),
			).resolves.toBeUndefined();
			await expect(
				ensureSpawnedKilledForTest(stubBrowser({ kind: { kind: "spawned", path: "/x" }, pid: 1 })),
			).resolves.toBeUndefined();
			await expect(
				ensureSpawnedKilledForTest(stubBrowser({ kind: { kind: "spawned", path: "/x" } })),
			).resolves.toBeUndefined();
		});
	});

	describe("browser settle — idle-close eligibility", () => {
		const NOW = 1_000_000;
		function candidate(overrides: Record<string, unknown> = {}): TabSession {
			return makeStubTab({ lastActivityAt: NOW - 120_000, ...overrides }).tab;
		}

		it("selects owned managed tabs idle past the deadline, including the boundary", () => {
			expect(isIdleCloseCandidate(candidate(), "session-stub", NOW, 60_000)).toBe(true);
			expect(isIdleCloseCandidate(candidate({ lastActivityAt: NOW - 60_000 }), "session-stub", NOW, 60_000)).toBe(
				true,
			);
		});

		it("holds back fresh tabs", () => {
			expect(isIdleCloseCandidate(candidate({ lastActivityAt: NOW - 1_000 }), "session-stub", NOW, 60_000)).toBe(
				false,
			);
		});

		it("never selects other owners, opt-outs, foreign kinds, dead, or executing tabs", () => {
			const cases: Array<[string, Record<string, unknown>]> = [
				["other owner", { ownerSessionId: "session-other" }],
				["persist opt-out", { persist: true }],
				["relay", { kindTag: "relay" }],
				["connected", { kindTag: "connected" }],
				["spawned", { kindTag: "spawned" }],
				["cmux backend", { backend: "cmux", kindTag: "cmux" }],
				["dead tab", { state: "dead" }],
			];
			for (const [label, overrides] of cases) {
				expect(isIdleCloseCandidate(candidate(overrides), "session-stub", NOW, 60_000), label).toBe(false);
			}
			const executing = candidate();
			executing.pending.set("run-1", {} as unknown as PendingRun);
			expect(isIdleCloseCandidate(executing, "session-stub", NOW, 60_000)).toBe(false);
		});
	});

	describe("browser settle — ownership and bookkeeping", () => {
		afterEach(async () => {
			try {
				await drainAllTabs();
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("acquireTab records persist and activity; reuse preserves persist and refreshes activity", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-bookkeeping"), { cwd: "/tmp" });

			const before = Date.now();
			const first = await acquireTab("settle-book", browser, {
				timeoutMs: 1_000,
				ownerSessionId: "session-A",
				persist: true,
			});
			expect(first.tab.persist).toBe(true);
			expect(first.tab.frozen).toBe(false);
			expect(first.tab.lastActivityAt).toBeGreaterThanOrEqual(before);
			// Backdate, then reuse under a different session without persist: the
			// creator's opt-out and ownership survive, the clock refreshes.
			first.tab.lastActivityAt -= 60_000;
			const stale = first.tab.lastActivityAt;
			const second = await acquireTab("settle-book", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });
			expect(second.tab).toBe(first.tab);
			expect(second.created).toBe(false);
			expect(second.tab.ownerSessionId).toBe("session-A");
			expect(second.tab.persist).toBe(true);
			expect(second.tab.lastActivityAt).toBeGreaterThan(stale);
		});

		it("freezeTabsForOwner skips non-headless tabs", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-freeze-skip"), { cwd: "/tmp" });
			const { tab } = await acquireTab("settle-cmux", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });

			expect(await freezeTabsForOwner("session-A")).toBe(0);
			expect(tab.frozen).toBe(false);
			expect(tab.state).toBe("alive");
		});

		it("releaseIdleTabsForOwner skips non-headless tabs even when ancient", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-idle-skip"), { cwd: "/tmp" });
			const { tab } = await acquireTab("settle-old", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			tab.lastActivityAt = Date.now() - 3_600_000;

			expect(await releaseIdleTabsForOwner("session-A", { idleMs: 60_000 })).toBe(0);
			expect(getTabsMapForTest().has("settle-old")).toBe(true);
		});

		it("refreshes activity when a run completes", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-complete"), { cwd: "/tmp" });
			const { tab } = await acquireTab("settle-done", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			tab.lastActivityAt = Date.now() - 3_600_000;

			const result = await runInTab("settle-done", {
				code: "return 42;",
				timeoutMs: 5_000,
				session: makeSession("/tmp"),
			});
			expect(result.returnValue).toBe(42);
			expect(tab.lastActivityAt).toBeGreaterThan(Date.now() - 5_000);
		});

		it("fails the run instead of dispatching onto an unresumable page", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-unresumable"), { cwd: "/tmp" });
			const { tab } = await acquireTab("settle-stuck", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			tab.frozen = true;

			await expect(
				runInTab("settle-stuck", { code: "return 1;", timeoutMs: 5_000, session: makeSession("/tmp") }),
			).rejects.toThrow(/could not be resumed/);
			expect(tab.pending.size).toBe(0);
			expect(getTabsMapForTest().has("settle-stuck")).toBe(true);
		});

		it("rejects an already-aborted run before dispatching", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-abort"), { cwd: "/tmp" });
			const { tab } = await acquireTab("settle-cancelled", browser, {
				timeoutMs: 1_000,
				ownerSessionId: "session-A",
			});

			await expect(
				runInTab("settle-cancelled", {
					code: "return 1;",
					timeoutMs: 5_000,
					session: makeSession("/tmp"),
					signal: AbortSignal.abort(),
				}),
			).rejects.toThrow(ToolAbortError);
			expect(tab.pending.size).toBe(0);
			expect(getTabsMapForTest().has("settle-cancelled")).toBe(true);
		});

		it("double release is idempotent for concurrent sweep losers", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-idempotent"), { cwd: "/tmp" });
			await acquireTab("settle-twice", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });

			expect(await releaseTab("settle-twice", { kill: false })).toBe(true);
			expect(await releaseTab("settle-twice", { kill: false })).toBe(false);
			expect(getTabsMapForTest().has("settle-twice")).toBe(false);
		});

		it("honors persist only on reuse by the owning session", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-reuse-persist"), { cwd: "/tmp" });
			const first = await acquireTab("settle-rp", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			expect(first.tab.persist).toBe(false);

			const second = await acquireTab("settle-rp", browser, {
				timeoutMs: 1_000,
				ownerSessionId: "session-A",
				persist: true,
			});
			expect(second.tab).toBe(first.tab);
			expect(second.tab.persist).toBe(true);

			const third = await acquireTab("settle-rp", browser, {
				timeoutMs: 1_000,
				ownerSessionId: "session-B",
				persist: false,
			});
			expect(third.tab).toBe(first.tab);
			expect(third.tab.ownerSessionId).toBe("session-A");
			expect(third.tab.persist).toBe(true);

			// Omitted on reuse leaves a previously set value alone.
			const fourth = await acquireTab("settle-rp", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			expect(fourth.tab).toBe(first.tab);
			expect(fourth.tab.persist).toBe(true);
		});
		it("rejects reuse when the frozen tab cannot resume", async () => {
			mockCmuxSocket();
			const browser = await acquireBrowser(makeKind("settle-reuse-frozen"), { cwd: "/tmp" });
			await acquireTab("settle-frozreuse", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			const tab = getTabsMapForTest().get("settle-frozreuse");
			expect(tab).toBeDefined();
			if (tab) tab.frozen = true;

			await expect(
				acquireTab("settle-frozreuse", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" }),
			).rejects.toThrow(/could not be resumed/);
		});

		it("tears down once when two releases race the same tab", async () => {
			let clientCloses = 0;
			const closedSurfaces: string[] = [];
			spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
			spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => {
				clientCloses++;
			});
			spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
				async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
					if (method === "browser.open_split") {
						return { surface_id: `surface-join-${++mockSurfaceSeq}`, url: "about:blank" };
					}
					if (method === "surface.close") {
						closedSurfaces.push(String(params.surface_id ?? ""));
						return {};
					}
					return {};
				},
			);
			// No pre-attached surface: the tab owns its split, so the race
			// below contends over one real teardown.
			const browser = await acquireBrowser(
				{ kind: "cmux", socketPath: "/tmp/omp-test-settle-join.sock" },
				{ cwd: "/tmp" },
			);
			await acquireTab("settle-join", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });

			// Both expressions run their synchronous prefixes in order: the
			// second lookup provably observes the first release in flight,
			// so it must join instead of redoubling teardown.
			const [first, second] = await Promise.all([
				releaseTab("settle-join", { kill: false }),
				releaseTab("settle-join", { kill: false }),
			]);
			expect(first).toBe(true);
			expect(second).toBe(true);
			expect(closedSurfaces.length).toBe(1);
			expect(clientCloses).toBe(1);
			expect(getTabsMapForTest().has("settle-join")).toBe(false);
		});

		it("settle is a no-op for unknown owners", async () => {
			expect(await freezeTabsForOwner("session-nobody")).toBe(0);
			expect(await releaseIdleTabsForOwner("session-nobody", { idleMs: 0 })).toBe(0);
			expect(await freezeTabsForOwner("")).toBe(0);
			expect(await releaseIdleTabsForOwner("", { idleMs: 0 })).toBe(0);
		});
	});

	describe("browser settle — idle deadline arithmetic", () => {
		it("returns undefined without an owner, a timeout, or tracked tabs", () => {
			expect(earliestIdleCloseInMs("session-nobody", 60_000)).toBeUndefined();
			expect(earliestIdleCloseInMs("", 60_000)).toBeUndefined();
			expect(earliestIdleCloseInMs("session-nobody", 0)).toBeUndefined();
			expect(earliestIdleCloseInMs("session-nobody", -5)).toBeUndefined();
		});
	});

	describe.skipIf(!CHROMIUM_AVAILABLE)("browser settle — real headless Chromium", () => {
		afterEach(async () => {
			await drainAllTabs();
		});

		it("freezes at settle, resumes transparently on run, and idle-closes", async () => {
			const session = makeSession(process.cwd());
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-real-${process.pid}`;
			const { tab } = await acquireTab(name, browser, {
				url: "about:blank",
				timeoutMs: 30_000,
				ownerSessionId: "session-settle-real",
			});
			expect(tab.frozen).toBe(false);

			expect(await freezeTabsForOwner("session-settle-real")).toBe(1);
			expect(tab.frozen).toBe(true);

			// A run resumes the page without the caller knowing it was frozen.
			const result = await runInTab(name, { code: "return 40 + 2;", timeoutMs: 30_000, session });
			expect(tab.frozen).toBe(false);
			expect(result.returnValue).toBe(42);

			// Backdated past the timeout, the owned tab closes. Tabs default
			// to reaping: no `persist` was passed at creation.
			expect(tab.persist).toBe(false);
			tab.lastActivityAt = Date.now() - 3_600_000;
			expect(await releaseIdleTabsForOwner("session-settle-real", { idleMs: 60_000 })).toBe(1);
			expect(getTabsMapForTest().has(name)).toBe(false);
		}, 120_000);

		it("closes a frozen tab directly", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-frozclose-${process.pid}`;
			await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-frozclose" });
			expect(await freezeTabsForOwner("session-frozclose")).toBe(1);
			expect(await releaseTab(name, { kill: false })).toBe(true);
			expect(getTabsMapForTest().has(name)).toBe(false);
		}, 120_000);

		it("reopens a frozen tab with persist without failing the resume", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-frozpersist-${process.pid}`;
			const first = await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-frozpersist" });
			expect(first.tab.persist).toBe(false);
			expect(await freezeTabsForOwner("session-frozpersist")).toBe(1);
			expect(first.tab.frozen).toBe(true);

			// The resume must run while the tab is still managed; applying
			// `persist` first would gate the resume off and always throw.
			const second = await acquireTab(name, browser, {
				timeoutMs: 30_000,
				ownerSessionId: "session-frozpersist",
				persist: true,
			});
			expect(second.created).toBe(false);
			expect(second.tab).toBe(first.tab);
			expect(second.tab.frozen).toBe(false);
			expect(second.tab.persist).toBe(true);
		}, 120_000);

		it("recreates a tab reused after eviction instead of resurrecting state", async () => {
			// Worker-tab release→recreate cannot run in this environment
			// (Bun worker re-spawn fails even on the clean tree); the
			// eviction→recreate shape is backend-independent — a missing
			// name always takes the create path — so pin it on cmux while
			// the worker half is covered by removal assertions above.
			mockCmuxSocket();
			// No pre-attached surface: each open mints an owned split, so
			// the two generations land on distinct targets.
			const browser = await acquireBrowser(
				{ kind: "cmux", socketPath: "/tmp/omp-test-settle-recreate.sock" },
				{ cwd: "/tmp" },
			);
			const first = await acquireTab("settle-gone", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			expect(await releaseTabsForOwner("session-A", { kill: false })).toBe(1);
			expect(getTabsMapForTest().has("settle-gone")).toBe(false);

			const second = await acquireTab("settle-gone", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
			expect(second.created).toBe(true);
			expect(second.tab.targetId).not.toBe(first.tab.targetId);
			expect(second.tab.frozen).toBe(false);
			expect(second.tab.ownerSessionId).toBe("session-A");
		});

		it("revalidates candidates mid-drain: reuse during an earlier close is honored", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const base = `settle-reval-${process.pid}`;
			const a = await acquireTab(`${base}-a`, browser, { timeoutMs: 30_000, ownerSessionId: "session-reval" });
			const b = await acquireTab(`${base}-b`, browser, { timeoutMs: 30_000, ownerSessionId: "session-reval" });
			const ancient = Date.now() - 3_600_000;
			a.tab.lastActivityAt = ancient;
			b.tab.lastActivityAt = ancient;

			const closing = releaseIdleTabsForOwner("session-reval", { idleMs: 60_000 });
			void closing.catch(() => undefined);
			// Refresh b synchronously in this same task: the touch provably
			// precedes the loop's second-iteration recheck, which runs only
			// after a's full worker teardown. Without the recheck, b would
			// close from the stale snapshot and this would return 2.
			await acquireTab(`${base}-b`, browser, { timeoutMs: 30_000, ownerSessionId: "session-reval" });
			expect(await closing).toBe(1);
			expect(getTabsMapForTest().has(`${base}-a`)).toBe(false);
			expect(getTabsMapForTest().has(`${base}-b`)).toBe(true);
		}, 120_000);

		it("closes idle tabs when the timeout elapses without further activity", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-timer-${process.pid}`;
			await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-timer" });
			const due = earliestIdleCloseInMs("session-timer", 60_000);
			expect(due).toBeGreaterThan(0);
			expect(due).toBeLessThanOrEqual(60_000);

			armIdleCloseForOwner("session-timer", 200);
			// Real clock required: the deadline, worker teardown, and CDP
			// roundtrips all run on platform time; fake timers cannot advance
			// real subprocess IPC, so poll the exercised condition instead.
			for (let i = 0; i < 100 && getTabsMapForTest().has(name); i++) await Bun.sleep(50);
			expect(getTabsMapForTest().has(name)).toBe(false);
		}, 120_000);

		it("re-arming replaces the pending deadline", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-retimer-${process.pid}`;
			await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-retimer" });

			armIdleCloseForOwner("session-retimer", 200);
			armIdleCloseForOwner("session-retimer", 3_600_000);
			// Real clock required (see above): past the first deadline with
			// the replacement armed, the tab must still be tracked.
			await Bun.sleep(600);
			expect(getTabsMapForTest().has(name)).toBe(true);
		}, 120_000);

		it("re-arms when the timer fires into an in-flight run", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-retry-${process.pid}`;
			const session = makeSession(process.cwd());
			await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-retry" });

			const run = runInTab(name, { code: "await wait(2000); return 1;", timeoutMs: 30_000, session });
			void run.catch(() => undefined);
			armIdleCloseForOwner("session-retry", 300, 150);
			// The 300ms deadline fires mid-run: skipped, not closed.
			// Real clock required (see above).
			await Bun.sleep(1000);
			expect(getTabsMapForTest().has(name)).toBe(true);
			expect((await run).returnValue).toBe(1);
			// After completion the chain re-arms from the fresh timestamp
			// and the tab closes without any further settle or open.
			for (let i = 0; i < 120 && getTabsMapForTest().has(name); i++) await Bun.sleep(50);
			expect(getTabsMapForTest().has(name)).toBe(false);
		}, 120_000);

		it("cancelling drops the armed deadline", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const name = `settle-cancel-${process.pid}`;
			await acquireTab(name, browser, { timeoutMs: 30_000, ownerSessionId: "session-cancel" });

			armIdleCloseForOwner("session-cancel", 200);
			cancelIdleCloseForOwner("session-cancel");
			// Real clock required (see above): past the deadline with the
			// timer cancelled, the tab must still be tracked.
			await Bun.sleep(600);
			expect(getTabsMapForTest().has(name)).toBe(true);
		}, 120_000);

		it("does not re-arm when cancelled mid-sweep", async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const base = `settle-cancelsweep-${process.pid}`;
			const due = await acquireTab(`${base}-due`, browser, {
				timeoutMs: 30_000,
				ownerSessionId: "session-cancelsweep",
			});
			await acquireTab(`${base}-fresh`, browser, { timeoutMs: 30_000, ownerSessionId: "session-cancelsweep" });
			due.tab.lastActivityAt = Date.now() - 3_600_000;

			// Cancel strictly after the sweep entry takes its sequence
			// token, while the first close is still awaiting worker
			// teardown: the sweep completes, but no deadline may survive.
			const closing = releaseIdleTabsForOwner("session-cancelsweep", { idleMs: 60_000 });
			cancelIdleCloseForOwner("session-cancelsweep");
			expect(await closing).toBe(1);
			expect(getTabsMapForTest().has(`${base}-due`)).toBe(false);
			expect(getTabsMapForTest().has(`${base}-fresh`)).toBe(true);
			expect(hasIdleCloseTimerForTest("session-cancelsweep")).toBe(false);
		}, 120_000);
	});
});
