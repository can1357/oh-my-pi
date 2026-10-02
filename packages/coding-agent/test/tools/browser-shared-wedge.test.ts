/**
 * Regression tests for the wedged shared browser (field incident 2026-09-27,
 * omp 18.3.1): under memory pressure the project-shared broker-owned Chromium
 * stopped answering CDP, so every tab close ended at the bounded
 * `orphan CDP target … (Page.close)` timeout.
 *
 * Two leaks followed that timeout:
 *
 * - `releaseTabInner` dropped the target's durable ownership record even though
 *   the target was never closed, so the surviving page became invisible to
 *   every later reap; and
 * - the shared Chromium is health-checked only while attaching
 *   (`ensureSharedBrowser`), and `acquireBrowser` reuses a cached handle while
 *   `browser.connected` is still true — so nothing re-probed an unreachable
 *   browser while a session lived. The 9.1 GB / 44-process tree survived 19 h
 *   until the last omp client in the project exited.
 *
 * Contract pinned here: a timed-out target close keeps the ownership record and
 * re-checks the shared browser, and that check stops the daemon only when the
 * CDP endpoint no longer answers.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { DaemonOperation } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { stopSharedBrowserIfUnreachable } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { getTabsMapForTest, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { TabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

const DAEMON_NAME = "omp.browser.headless";
/** The target id the incident log names for the tab whose close never landed. */
const TARGET_ID = "D6895F960DB1F4D842FD7B0286F3F818";

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	return { projectDir: path.join("/tmp", `omp-wedge-test-${crypto.randomUUID()}`), daemonName: DAEMON_NAME };
}

/** Scopes created since the last sweep; `afterEach` removes them even when a test fails. */
const scopes: SharedTargetScope[] = [];

/** A scope registered for cleanup, so no assertion failure can leave it on disk. */
function trackedScope(): SharedTargetScope {
	const scope = makeScope();
	scopes.push(scope);
	return scope;
}

/** Targets this process still claims ownership of, straight from the durable record. */
async function ownedTargets(scope: SharedTargetScope): Promise<string[]> {
	// Reading straight after `releaseTab` would race the registry's serialized
	// write chain (the supervisor forgets fire-and-forget). A record→forget pair
	// for a throwaway id joins that chain, so when it returns the earlier write
	// has landed and the file below is stable.
	const probe = `chain-probe-${crypto.randomUUID()}`;
	await recordSharedTarget(scope, probe);
	await forgetSharedTarget(scope, probe);
	const file = path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`, `${process.pid}.json`);
	const raw = await Bun.file(file)
		.text()
		.catch(() => null);
	if (raw === null) return [];
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("targets" in parsed)) return [];
	const { targets } = parsed;
	return Array.isArray(targets) ? targets.filter((id): id is string => typeof id === "string") : [];
}

/** How the stub's CDP close behaves: never answers, fails fast, or fails after a gate. */
interface WedgeOptions {
	/** Whether the handle carries the shared-daemon scope (`false` = private launch). */
	shared?: boolean;
	close?: "hang" | "fail" | "gate";
	/** Held by a `gate` close until the test releases it. */
	gate?: Promise<void>;
	/** Fires when a `gate` close starts, so the test can interleave a release. */
	entered?: () => void;
	/** Counts worker terminations instead of the default no-op. */
	onTerminate?: () => void;
}

/** Handle for a shared Chromium whose CDP endpoint answers nothing: every call hangs. */
function makeWedgeHandle(scope: SharedTargetScope, options: WedgeOptions = {}): BrowserHandle {
	const { shared = true, close = "hang", gate, entered } = options;
	const session = {
		send: async (): Promise<never> => {
			if (close === "fail") throw new Error("CDP target session unavailable");
			if (close === "gate") {
				entered?.();
				await gate;
				throw new Error("CDP target session unavailable");
			}
			return await new Promise<never>(() => {});
		},
		detach: async (): Promise<void> => undefined,
	};
	const handle: Record<string, unknown> = {
		key: "headless:1::",
		kind: { kind: "headless", headless: true },
		// Another tab still holds the shared browser: closing this one must not
		// dispose the handle (that is what leaves the target behind in Chrome).
		refCount: 2,
		stealth: { browserSession: null, override: null },
		browser: {
			connected: true,
			targets: () => [],
			target: () => ({ createCDPSession: async () => session }),
			disconnect: () => undefined,
		},
	};
	if (shared) handle.sharedDaemon = { name: scope.daemonName, projectDir: scope.projectDir };
	return handle as unknown as BrowserHandle;
}

/** Tab whose page-close handshake never completes, so cleanup runs the forced path. */
function makeWedgeTab(scope: SharedTargetScope, options: WedgeOptions = {}): TabSession {
	return {
		name: "logos-b2b",
		browser: makeWedgeHandle(scope, options),
		targetId: TARGET_ID,
		backend: "worker",
		state: "alive",
		info: {},
		pending: new Map(),
		kindTag: "headless",
		ownsPage: true,
		ownerSessionId: "session-wedge",
		persist: false,
		lastActivityAt: Date.now(),
		frozen: false,
		worker: {
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				options.onTerminate?.();
			},
		},
	} as unknown as TabSession;
}

/** Minimal tool session for the `runInTab` entry point. */
function makeSession(): ToolSession {
	return {
		cwd: "/tmp/omp-wedge-session",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function makeSnapshot(readyMatch: string | undefined): DaemonSnapshot {
	return {
		name: DAEMON_NAME,
		id: "daemon-wedge",
		state: "ready",
		createdAt: 0,
		startedAt: 0,
		readyAt: 1,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...(readyMatch === undefined ? {} : { readyMatch }),
	};
}

/**
 * Broker double: answers `describe` with a snapshot, records every `stop`, and
 * reports a terminal snapshot for a stop unless told otherwise — a real broker
 * returns the post-stop record, so a stop that never landed is either a
 * rejected request (`stopFails`) or a non-terminal snapshot (`stopState`).
 */
function makeBroker(
	opts: { snapshot?: DaemonSnapshot; fail?: boolean; stopFails?: boolean; stopState?: DaemonSnapshot["state"] },
	stops: string[],
): DaemonBrokerClient {
	return {
		projectDir: "/tmp/omp-wedge-broker",
		close: () => undefined,
		onCompletion: () => () => undefined,
		request: async (operation: DaemonOperation) => {
			if (opts.fail === true) throw new Error("broker unreachable");
			if (operation.op === "describe") return { op: "describe", daemon: opts.snapshot };
			if (operation.op === "stop") {
				stops.push(operation.name);
				if (opts.stopFails === true) throw new Error("broker rejected the stop");
				const stopped = { ...(opts.snapshot ?? makeSnapshot(undefined)), state: opts.stopState ?? "exited" };
				return { op: "stop", daemon: stopped };
			}
			throw new Error(`unexpected broker op ${operation.op}`);
		},
	} as unknown as DaemonBrokerClient;
}

/** Live endpoint string as the broker stamps it once Chrome's listener is up. */
const READY_MATCH = "DevTools listening on ws://127.0.0.1:63199/devtools/browser/wedged";

afterEach(async () => {
	vi.restoreAllMocks();
	resetOrphanRegistryForTest();
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("browser cleanup — timed-out target close in a shared browser", () => {
	it("keeps the ownership record and re-checks the shared browser", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);

		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope));
		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow();

		// The tab still leaves the map (the close is reported as failed)...
		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		// ...but the target it never closed stays owned, so a later reap can
		// still find it, and the browser itself is re-checked for reachability.
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("forgets the retained target once the browser it belonged to is stopped", async () => {
		const scope = trackedScope();
		// The check proves the whole browser gone: the target that could not be
		// closed died with it, so its record must not linger until this process
		// exits and be rewritten on every later write.
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("still forgets a tab that was already dead when it was released", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const tab = makeWedgeTab(scope);
		tab.state = "dead";
		getTabsMapForTest().set("logos-b2b", tab);

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([]);
		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("force-kills a wedged tab without forgetting the target it could not close", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// `runInTab` reaching its grace period is one of the two real entry points
		// into `forceKillTab` (the other is a failed worker recycle — the
		// incident's "Failed to recycle browser tab worker; killing tab").
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(
			runInTab("logos-b2b", { code: "await wait(60_000);", timeoutMs: 20, session: makeSession() }),
		).rejects.toThrow("hung past grace");

		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("lets a release join an in-flight force-kill instead of tearing the tab down twice", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let terminations = 0;
		const tab = makeWedgeTab(scope, {
			close: "gate",
			gate: gate.promise,
			entered: () => entered.resolve(),
			onTerminate: () => terminations++,
		});
		getTabsMapForTest().set("logos-b2b", tab);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		// Force-kill is now parked inside the CDP close: the release that lands
		// here must join it, not release the browser hold a second time or make
		// its own ownership decision.
		await entered.promise;
		expect(tab.state).toBe("dead");
		expect(tab.browser.refCount).toBe(2);
		// The release must join the in-flight force-kill, so it settles only when
		// that teardown does — hence starting it, not awaiting it, before the gate.
		const released = releaseTab("logos-b2b", { timeoutMs: 40 });
		gate.resolve();
		// The join reports the release contract, not the target-close outcome:
		// the tab is gone either way, and a surviving target is kept in the
		// registry (asserted below) rather than reported as an unreleased tab.
		expect(await released).toBe(true);
		await killed;

		expect(terminations).toBe(1);
		expect(tab.browser.refCount).toBe(1);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});

	it("bounds the close a joining release waits on when force-kill is stuck on a wedged browser", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// Never resolves: the CDP close hangs exactly as it does against a wedged
		// Chromium, so only the supervisor's own close budget can end this wait.
		const wedged = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		getTabsMapForTest().set(
			"logos-b2b",
			makeWedgeTab(scope, { close: "gate", gate: wedged.promise, entered: () => entered.resolve() }),
		);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		await entered.promise;

		// A release joining the force-kill must not inherit an unbounded CDP wait
		// (Puppeteer's protocol timeout is 60 s); the supervisor's 5 s close
		// budget ends it, and the join still reports the tab as released.
		const joined = await withTimeout(
			releaseTab("logos-b2b", { timeoutMs: 50 }),
			9_000,
			"joined release outlived the force-kill close budget",
		).catch(() => "timed-out" as const);
		expect(joined).toBe(true);

		await killed;
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	}, 20_000);

	it("never checks a browser that is not the shared one", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { shared: false }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow("Timed out after 60ms");

		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("treats an unconfirmed close (CDP session failure) as unclosed too", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});
});

describe("shared browser reachability check", () => {
	it("stops a browser whose endpoint stopped answering twice in a row", async () => {
		const stops: string[] = [];
		const probes: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-a", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async wsEndpoint => {
					probes.push(wsEndpoint);
					return false;
				},
			},
		);

		expect(stopped).toBe(true);
		expect(probes).toEqual([
			"ws://127.0.0.1:63199/devtools/browser/wedged",
			"ws://127.0.0.1:63199/devtools/browser/wedged",
		]);
		expect(stops).toEqual([DAEMON_NAME]);
	});

	it("leaves a replacement browser alone instead of stopping it under the old name", async () => {
		const stops: string[] = [];
		const probes: string[] = [];
		let describeCount = 0;
		let current = makeSnapshot(READY_MATCH);
		const broker = {
			projectDir: "/tmp/omp-wedge-replaced",
			close: () => undefined,
			onCompletion: () => () => undefined,
			request: async (operation: DaemonOperation) => {
				if (operation.op === "describe") {
					describeCount++;
					return { op: "describe", daemon: current };
				}
				if (operation.op === "stop") {
					stops.push(operation.name);
					return { op: "stop", daemon: current };
				}
				throw new Error(`unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-replaced", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async wsEndpoint => {
					probes.push(wsEndpoint);
					// Another session replaced the daemon while we probe its
					// predecessor: a healthy browser now answers to that name.
					current = makeSnapshot("DevTools listening on ws://127.0.0.1:63199/devtools/browser/replacement");
					return false;
				},
			},
		);

		expect(stopped).toBe(false);
		expect(stops).toEqual([]);
		// Both probes addressed the instance we described, and the stop was
		// withheld after re-describing found a different one.
		expect(probes).toEqual([
			"ws://127.0.0.1:63199/devtools/browser/wedged",
			"ws://127.0.0.1:63199/devtools/browser/wedged",
		]);
		expect(describeCount).toBe(2);
	});

	it("settles and frees its single-flight slot when the CDP connect never opens", async () => {
		// `rawHttpGet` awaits `Bun.connect` before its own timer can settle the
		// call, so a stalled connect used to pin the check (and every later
		// cleanup that joined it) indefinitely.
		const connect = Promise.withResolvers<unknown>();
		const connectSpy = spyOn(Bun, "connect").mockImplementation((() => connect.promise) as never);
		try {
			const scope = trackedScope();
			const stops: string[] = [];
			const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

			const capMs = 50;
			const first = stopSharedBrowserIfUnreachable(scope, { client: broker, probeCapMs: capMs });
			const joined = stopSharedBrowserIfUnreachable(scope, { client: broker, probeCapMs: capMs });
			expect(joined).toBe(first);

			expect(await first).toBe(true);
			expect(stops).toEqual([DAEMON_NAME]);

			// Settled slot: the next check describes again instead of joining a
			// promise that never clears.
			const stopsAfter = [...stops];
			expect(await stopSharedBrowserIfUnreachable(scope, { client: broker, probe: async () => true })).toBe(false);
			expect(stops).toEqual(stopsAfter);
		} finally {
			connectSpy.mockRestore();
			connect.resolve(undefined);
		}
	});

	it("does not report a stop the broker never confirmed", async () => {
		// `stopQuietly` absorbs a rejected stop, so the only proof a daemon ended
		// is a terminal snapshot. Reporting success without one would let the
		// caller forget targets that are still open — the leak this exists for.
		for (const opts of [{ stopFails: true }, { stopState: "stopping" as const }]) {
			const stops: string[] = [];
			const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH), ...opts }, stops);

			const stopped = await stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-unconfirmed", daemonName: DAEMON_NAME },
				{ client: broker, probe: async () => false },
			);

			expect(stopped).toBe(false);
			expect(stops).toEqual([DAEMON_NAME]);
		}
	});

	it("survives a single failed probe, so one slow answer is not a wedge", async () => {
		const stops: string[] = [];
		let probes = 0;
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-single", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async () => ++probes > 1,
			},
		);

		expect(stopped).toBe(false);
		expect(probes).toBe(2);
		expect(stops).toEqual([]);
	});

	it("treats one timed-out real probe followed by an answer as not a wedge", async () => {
		// The production probe, against an endpoint that misses its 1.5 s budget
		// once — a loaded machine, not a dead browser. Real wall-clock time is
		// the subject here, so the slow answer is held until the probe's own
		// timeout aborts the request rather than a guessed sleep.
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				requests++;
				if (requests === 1) {
					const aborted = Promise.withResolvers<void>();
					req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await aborted.promise;
					return new Response("too late", { status: 504 });
				}
				return Response.json({ Browser: "Chrome/150.0.7871.24" });
			},
		});
		const stops: string[] = [];
		const broker = makeBroker(
			{ snapshot: makeSnapshot(`DevTools listening on ws://127.0.0.1:${server.port}/`) },
			stops,
		);
		try {
			const stopped = await stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-slow", daemonName: DAEMON_NAME },
				{ client: broker },
			);

			expect(stopped).toBe(false);
			expect(requests).toBe(2);
			expect(stops).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});

	it("leaves a browser that still answers alone, so other sessions keep their tabs", async () => {
		const stops: string[] = [];
		let probes = 0;
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-b", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async () => {
					probes++;
					return true;
				},
			},
		);

		expect(stopped).toBe(false);
		expect(probes).toBe(1);
		expect(stops).toEqual([]);
	});

	it("leaves a daemon that never became ready to the attach path", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(undefined) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-c", daemonName: DAEMON_NAME },
			{ client: broker, probe: async () => false },
		);

		expect(stopped).toBe(false);
		expect(stops).toEqual([]);
	});

	it("gives up quietly when the broker cannot be reached", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ fail: true }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-d", daemonName: DAEMON_NAME },
			{ client: broker, probe: async () => false },
		);

		expect(stopped).toBe(false);
		expect(stops).toEqual([]);
	});

	it("absorbs a probe that throws", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		await expect(
			stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-e", daemonName: DAEMON_NAME },
				{
					client: broker,
					probe: async () => {
						throw new Error("probe exploded");
					},
				},
			),
		).resolves.toBe(false);
		expect(stops).toEqual([]);
	});
});
