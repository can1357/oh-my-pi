/**
 * Regression tests for issue #10022: the project-shared broker-owned Chromium
 * (`omp.browser.headless`) retains page targets created by omp processes that
 * ended abnormally, because tab ownership was tracked only in per-process
 * memory. `orphan-registry` records ownership durably and reaps targets whose
 * owning process is gone.
 *
 * The contract under test:
 *  - a dead owner's targets are collected for reaping, a live owner's are not;
 *  - this process's own targets are never reaped (a live session keeps its tabs);
 *  - a conservative grace window keeps a just-crashed owner's fresh records;
 *  - confirmed closures are removed, while transient failures remain durable
 *    and are retried on the next reap;
 *  - a shared-target close counts only once Chromium stops listing the target,
 *    and is re-sent until then.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import {
	closeCdpTarget,
	closeSharedTargetUntilGone,
	collectOrphanTargets,
	forgetSharedTarget,
	markSharedTargetUnclosed,
	reapOrphanSharedTargets,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	retryUnclosedSharedTargets,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { Browser } from "puppeteer-core";

const DAEMON_NAME = "omp.browser.headless";

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	const projectDir = path.join("/tmp", `omp-orphan-test-${crypto.randomUUID()}`);
	return { projectDir, daemonName: DAEMON_NAME };
}

function registryDir(scope: SharedTargetScope): string {
	return path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
}

async function writeOwnershipFile(
	scope: SharedTargetScope,
	record: { pid: number; updatedAt: number; targets: string[] },
): Promise<void> {
	const dir = registryDir(scope);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${record.pid}.json`), JSON.stringify(record));
}

/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
async function deadPid(): Promise<number> {
	// Bun's own executable is the only binary guaranteed on every platform (`true` is absent on Windows).
	const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

/** Minimal puppeteer Browser stub recording closes and optionally failing selected targets. */
function makeBrowser(closed: string[], failTargets: ReadonlySet<string> = new Set()): Browser {
	const destroyedHandlers = new Set<(event: { targetId: string }) => void>();
	const connection = {
		send: async (method: string, params?: { targetId: string }) => {
			if (method === "Target.getTargets") {
				return { targetInfos: [...failTargets].map(targetId => ({ targetId })) };
			}
			if (!params) throw new Error(`Missing params for ${method}`);
			if (failTargets.has(params.targetId)) throw new Error("transient CDP failure");
			closed.push(params.targetId);
			const { targetId } = params;
			queueMicrotask(() => {
				for (const handler of destroyedHandlers) handler({ targetId });
			});
			return { success: true };
		},
		on: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.add(handler),
		off: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.delete(handler),
		createSession: async () => {
			throw new Error("closes must not attach to targets");
		},
	};
	return { _connection: connection } as unknown as Browser;
}

/** Fake Chromium behind a puppeteer `Browser` stub; `targets` is Chromium's own view. */
interface FakeChromium {
	browser: Browser;
	/** Target ids Chromium still lists in `Target.getTargets`. */
	targets: Set<string>;
	/**
	 * Leave puppeteer as overlapping browser-target sessions do (puppeteer#15750): the connection
	 * stays up, but `browser.target()` throws `Browser target is not found` from then on.
	 */
	loseBrowserTarget(): void;
	/** Drop the connection: puppeteer then reports `connected: false` and rejects every send. */
	disconnect(): void;
}

/**
 * Chromium answers each close of a listed target with `success: true` and emits
 * `Target.targetDestroyed` when it drops one. A target survives its first `linger`
 * sends; `rejectClose` ids reject every close (yet still go); `silentDestroy` ids go
 * without the event; the first `hangClose` sends never answer; each send waits for
 * `stall`, called as it is written (a frozen Chromium). Puppeteer's own view
 * (`targets()`) is always empty, so confirming through it would be wrong. Two
 * `browser.target().createCDPSession()` calls in flight at once lose the browser
 * target for the rest of the connection, as in puppeteer#15750.
 */
function makeChromium(
	opts: {
		targets?: string[];
		linger?: Record<string, number>;
		rejectClose?: ReadonlySet<string>;
		silentDestroy?: ReadonlySet<string>;
		hangClose?: Record<string, number>;
		onCloseSend?: (targetId: string) => void;
		stall?: (method: string) => Promise<void>;
	} = {},
): FakeChromium {
	let connected = true;
	let browserTargetLost = false;
	let sessionsAttaching = 0;
	const closeSends = new Map<string, number>();
	const chromium: FakeChromium = {
		browser: undefined as unknown as Browser,
		targets: new Set(opts.targets ?? []),
		disconnect: () => {
			connected = false;
		},
		loseBrowserTarget: () => {
			browserTargetLost = true;
		},
	};
	const destroyedHandlers = new Set<(event: { targetId: string }) => void>();
	const connection = {
		send: async (method: string, params?: { targetId: string }) => {
			if (!connected) throw new Error("Protocol error: Connection closed.");
			await opts.stall?.(method);
			if (method === "Target.getTargets") {
				return { targetInfos: [...chromium.targets].map(targetId => ({ targetId, type: "page" })) };
			}
			if (method !== "Target.closeTarget" || !params) throw new Error(`Unexpected ${method}`);
			const { targetId } = params;
			const sends = (closeSends.get(targetId) ?? 0) + 1;
			closeSends.set(targetId, sends);
			opts.onCloseSend?.(targetId);
			if (sends <= (opts.hangClose?.[targetId] ?? 0)) return await new Promise<never>(() => {});
			if (!chromium.targets.has(targetId)) throw new Error("No target with given id found");
			if (sends > (opts.linger?.[targetId] ?? 0)) {
				chromium.targets.delete(targetId);
				if (!opts.silentDestroy?.has(targetId)) {
					queueMicrotask(() => {
						for (const handler of destroyedHandlers) handler({ targetId });
					});
				}
			}
			if (opts.rejectClose?.has(targetId)) throw new Error("Session closed");
			return { success: true };
		},
		on: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.add(handler),
		off: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.delete(handler),
		createSession: async () => {
			throw new Error("closes must not attach to targets");
		},
	};
	const session = {
		send: async (method: string, params?: { targetId: string }) =>
			method === "Target.setDiscoverTargets" ? {} : await connection.send(method, params),
		on: connection.on,
		off: connection.off,
		detach: async () => undefined,
	};
	const browserTarget = {
		createCDPSession: async () => {
			if (++sessionsAttaching > 1) browserTargetLost = true;
			try {
				await Promise.resolve(); // the attach round-trip
			} finally {
				sessionsAttaching--;
			}
			return session;
		},
	};
	chromium.browser = {
		get connected() {
			return connected;
		},
		_connection: connection,
		target: () => {
			if (browserTargetLost) throw new Error("Browser target is not found");
			return browserTarget;
		},
		targets: () => [],
		disconnect: () => chromium.disconnect(),
	} as unknown as Browser;
	return chromium;
}

/** Fast close bounds for tests; the production defaults are seconds. */
const FAST = { intervalMs: 20, budgetMs: 2_000 };

const scopes: SharedTargetScope[] = [];
function trackedScope(): SharedTargetScope {
	const scope = makeScope();
	scopes.push(scope);
	return scope;
}

afterEach(async () => {
	resetOrphanRegistryForTest();
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("orphan-registry — ownership scan", () => {
	it("collects a dead owner's targets and leaves a live owner's untouched", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const live = 424242; // treated as alive by the injected probe below
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 0, targets: ["dead-a", "dead-b"] });
		await writeOwnershipFile(scope, { pid: live, updatedAt: 0, targets: ["live-a"] });

		const scan = await collectOrphanTargets(scope, {
			now: () => 10_000_000,
			isAlive: pid => pid === live,
		});

		expect(scan.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 0,
				targetIds: ["dead-a", "dead-b"],
			},
		]);
	});

	it("never reaps this process's own recorded targets", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "mine-1");
		await recordSharedTarget(scope, "mine-2");

		// Our own file is present on disk...
		const own = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(own.targets.sort()).toEqual(["mine-1", "mine-2"]);

		// ...but a scan (even with everything else forced dead) skips it.
		const scan = await collectOrphanTargets(scope, { now: () => 10_000_000, isAlive: () => false });
		expect(scan.owners).toEqual([]);
	});

	it("forgetSharedTarget drops one id and removes the file once empty", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "a");
		await recordSharedTarget(scope, "b");
		await forgetSharedTarget(scope, "a");
		const after = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(after.targets).toEqual(["b"]);

		await forgetSharedTarget(scope, "b");
		expect(await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).exists()).toBe(false);
	});

	it("keeps a dead owner's records inside the conservative grace window", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 100_000, targets: ["fresh"] });

		const withinGrace = await collectOrphanTargets(scope, {
			now: () => 105_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(withinGrace.owners).toEqual([]);

		const pastGrace = await collectOrphanTargets(scope, {
			now: () => 130_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(pastGrace.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 100_000,
				targetIds: ["fresh"],
			},
		]);
	});
});

describe("orphan-registry — closeSharedTargetUntilGone", () => {
	it("confirms concurrent closes only once Chromium stops listing each target, and keeps the browser target", async () => {
		// Concurrent browser-target sessions made puppeteer 25.3.0 drop the browser target,
		// so every later web search failed with `Browser target is not found`.
		const chromium = makeChromium({
			targets: ["plain", "lingering", "rejected", "hung", "quiet"],
			// `success: true` twice while the page stays open.
			linger: { lingering: 2, rejected: 1 },
			// Every reply is an error, though the second send closes it.
			rejectClose: new Set(["rejected"]),
			// The first send never answers.
			hangClose: { hung: 1 },
			// Goes without `Target.targetDestroyed`.
			silentDestroy: new Set(["quiet"]),
		});
		const ids = [...chromium.targets];

		const results = await Promise.all(ids.map(id => closeSharedTargetUntilGone(chromium.browser, id, FAST)));

		expect(results).toEqual(ids.map(() => true));
		expect([...chromium.targets]).toEqual([]);
		expect(() => chromium.browser.target()).not.toThrow();
	});

	it("returns false within its budget while Chromium keeps listing the target", async () => {
		const chromium = makeChromium({ targets: ["stuck"], linger: { stuck: Infinity } });
		const started = performance.now();

		expect(await closeSharedTargetUntilGone(chromium.browser, "stuck", { intervalMs: 20, budgetMs: 150 })).toBe(
			false,
		);

		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("stops as soon as the connection drops instead of spinning to its budget", async () => {
		const chromium: FakeChromium = makeChromium({
			targets: ["stuck"],
			linger: { stuck: Infinity },
			onCloseSend: () => chromium.disconnect(),
		});
		const started = performance.now();

		expect(await closeSharedTargetUntilGone(chromium.browser, "stuck", { intervalMs: 20, budgetMs: 60_000 })).toBe(
			false,
		);

		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("writes the close while Chromium is stalled, so it lands once Chromium resumes", async () => {
		// Replies outlasting the round must not skip the close: a frozen Chromium then never gets one.
		const stall = Promise.withResolvers<void>();
		const secondRound = Promise.withResolvers<void>();
		let closeSends = 0;
		let listings = 0;
		const chromium = makeChromium({
			targets: ["frozen"],
			stall: method => {
				if (method === "Target.closeTarget") closeSends++;
				else if (++listings === 2) secondRound.resolve();
				return stall.promise;
			},
		});

		const closing = closeSharedTargetUntilGone(chromium.browser, "frozen", FAST);
		// A whole round went by unanswered.
		await secondRound.promise;
		expect(closeSends).toBeGreaterThan(0);
		stall.resolve();

		expect(await closing).toBe(true);
		expect([...chromium.targets]).toEqual([]);
	});
});

describe("orphan-registry — closeCdpTarget", () => {
	it("confirms concurrent closes, of open and already-gone targets, and keeps the browser target", async () => {
		// Each close attaching its own session made puppeteer lose the browser target, so
		// closing tabs together broke every later web search with `Browser target is not found`.
		const chromium = makeChromium({ targets: ["a", "b", "c"] });
		const ids = ["a", "b", "c", "gone"];

		const results = await Promise.all(ids.map(id => closeCdpTarget(chromium.browser, id)));

		expect(results).toEqual(ids.map(() => true));
		expect([...chromium.targets]).toEqual([]);
		expect(() => chromium.browser.target()).not.toThrow();
	});
});

describe("orphan-registry — retryUnclosedSharedTargets", () => {
	it("also closes ids marked while the shared run is busy, for searches that joined it", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "a");
		await recordSharedTarget(scope, "b");
		markSharedTargetUnclosed(scope, "a");
		let joined: Promise<number> | undefined;
		const chromium = makeChromium({
			targets: ["a", "b"],
			// While the run closes "a", another search fails to close "b", then joins the run.
			onCloseSend: id => {
				if (id !== "a" || joined) return;
				markSharedTargetUnclosed(scope, "b");
				joined = retryUnclosedSharedTargets(chromium.browser, scope);
			},
		});

		expect(await retryUnclosedSharedTargets(chromium.browser, scope)).toBe(2);

		expect(await joined).toBe(2);
		expect([...chromium.targets]).toEqual([]);
		expect(await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).exists()).toBe(false);
	});
});

describe("orphan-registry — reap", () => {
	it("closes a dead owner's targets via CDP and deletes its ownership file", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt: Date.now() - 60_000,
			targets: ["orphan-1", "orphan-2"],
		});
		const closed: string[] = [];

		const count = await reapOrphanSharedTargets(makeBrowser(closed), scope);

		expect(count).toBe(2);
		expect(closed.sort()).toEqual(["orphan-1", "orphan-2"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});

	it("retains transient CDP failures and retries them on the next reap", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const updatedAt = Date.now() - 60_000;
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt,
			targets: ["closed-now", "retry-later"],
		});
		const firstClosed: string[] = [];

		const firstCount = await reapOrphanSharedTargets(makeBrowser(firstClosed, new Set(["retry-later"])), scope);

		expect(firstCount).toBe(1);
		expect(firstClosed).toEqual(["closed-now"]);
		const retained = (await Bun.file(path.join(registryDir(scope), `${dead}.json`)).json()) as {
			pid: number;
			updatedAt: number;
			targets: string[];
		};
		expect(retained).toEqual({ pid: dead, updatedAt, targets: ["retry-later"] });

		const retryClosed: string[] = [];
		const retryCount = await reapOrphanSharedTargets(makeBrowser(retryClosed), scope);

		expect(retryCount).toBe(1);
		expect(retryClosed).toEqual(["retry-later"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});

	it("closes a dead owner's targets after puppeteer lost the browser target", async () => {
		// The reap runs unawaited on attach: a browser-target session here rejected and exited omp.
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: Date.now() - 60_000, targets: ["orphan-1", "orphan-2"] });
		const chromium = makeChromium({ targets: ["orphan-1", "orphan-2"] });
		chromium.loseBrowserTarget();

		expect(await reapOrphanSharedTargets(chromium.browser, scope)).toBe(2);

		expect([...chromium.targets]).toEqual([]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});
});
