import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { RpcClosedError } from "../../src/thread/rpc";
import type { ThreadService, WorkerPeer } from "../../src/thread/services";
import { THREAD_SERVICES } from "../../src/thread/services/index";
import {
	allowedSubagentWorkers,
	SubagentWorker,
	type SubagentWorkerOptions,
	SubagentWorkerPool,
	type SubagentWorkerPoolOptions,
} from "../../src/thread/subagent-worker";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function startWorker(options: SubagentWorkerOptions = {}): SubagentWorker {
	const worker = new SubagentWorker(options);
	cleanups.push(() => worker.terminate());
	return worker;
}

/** Resolves after a prewarm's spawn (setImmediate callbacks run in FIFO order). */
function nextImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Fake timers for the rest of the test (idle countdowns started from here on are driven by `vi`). */
function useFakeTimers(): void {
	vi.useFakeTimers();
	cleanups.push(() => vi.useRealTimers());
}

/** A pool of up to `maxWorkers`; `options` overrides the rest (e.g. `hostsOnMain: false` to place every run on a worker). */
function startPool(
	maxWorkers: number,
	options: Omit<SubagentWorkerPoolOptions, "maxWorkers"> = {},
): SubagentWorkerPool {
	const pool = new SubagentWorkerPool({ maxWorkers: () => maxWorkers, ...options });
	cleanups.push(() => pool.dispose());
	return pool;
}

/** A pool that places every run on a worker (test seam), so worker lifecycle tests need no concurrency. */
function workerOnlyPool(
	maxWorkers: number,
	options: Omit<SubagentWorkerPoolOptions, "maxWorkers"> = {},
): SubagentWorkerPool {
	return startPool(maxWorkers, { hostsOnMain: false, ...options });
}

/** A run placed on a worker; throws when the pool kept it on the main thread. */
async function leaseFrom(pool: SubagentWorkerPool): Promise<{ worker: SubagentWorker; release: () => void }> {
	const placement = await pool.acquire();
	const worker = placement.worker;
	if (!worker) throw new Error("the pool kept the run on the main thread");
	return { worker, release: () => placement.release() };
}

function probeService(): ThreadService & { installed: WorkerPeer[]; exits: string[] } {
	const installed: WorkerPeer[] = [];
	const exits: string[] = [];
	return {
		name: "test-probe",
		installed,
		exits,
		installMain: peer => {
			installed.push(peer);
		},
		onWorkerExit: (_peer, reason) => {
			exits.push(reason);
		},
	};
}

describe("SubagentWorker", () => {
	it("boots and answers a ping that round-trips through a sync call to main", async () => {
		const probe = probeService();
		const worker = startWorker({ services: [...THREAD_SERVICES, probe] });
		await worker.ready;
		expect(worker.threadId).toMatch(/^w[1-9][0-9]*$/);
		expect(probe.installed).toEqual([worker]);
		expect(await worker.link.call("ping", 42)).toBe(42);
	});

	it("closes the link, rejects pending calls, and reports the exit once when the worker crashes", async () => {
		const probe = probeService();
		const exits: string[] = [];
		const worker = startWorker({
			services: [...THREAD_SERVICES, probe],
			entry: new URL("../fixtures/subagent-crash-worker.ts", import.meta.url),
			onExit: (_worker, reason) => exits.push(reason),
		});
		await worker.ready;
		await expect(worker.link.call("ping", -1)).rejects.toBeInstanceOf(RpcClosedError);
		expect(worker.link.closed).toBe(true);
		expect(worker.alive).toBe(false);
		// The real worker's trailing `close` event arrives from another thread with no
		// observable signal; give it time to land, then assert it reported nothing more.
		await Bun.sleep(50);
		expect(exits).toHaveLength(1);
		expect(exits[0]).toContain("crashed");
		expect(probe.exits).toEqual(exits);
		await expect(worker.link.call("ping", 1)).rejects.toBeInstanceOf(RpcClosedError);
	});

	it("delivers records logged while the worker module evaluates to main's sinks, in order and tagged", async () => {
		const dir = TempDir.createSync("@pi-early-log-");
		logger.setTransports({ console: false, file: path.join(dir.path(), "logs") });
		const events: logger.LogEvent[] = [];
		const unregister = logger.registerLogSink(event => {
			if (event.message.startsWith("early-log:")) events.push(event);
		});
		cleanups.push(() => {
			unregister();
			logger.setTransports({ file: true });
			void dir.remove();
		});
		const after = Promise.withResolvers<void>();
		const worker = startWorker({ entry: new URL("../fixtures/early-log-worker.ts", import.meta.url) });
		const unregisterAfter = logger.registerLogSink(event => {
			if (event.message === "early-log: after init") after.resolve();
		});
		cleanups.push(unregisterAfter);
		await worker.ready;
		await after.promise;
		expect(events.map(event => [event.message, event.context])).toEqual([
			["early-log: during evaluation", { phase: "evaluation", thread: worker.threadId }],
			["early-log: after init", { phase: "init", thread: worker.threadId }],
		]);
	});

	it("routes the worker realm's global fetch through PI_PROXY", async () => {
		using proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(`via ${request.url}`) });
		const saved = ["PI_PROXY", "NO_PROXY", "no_proxy"].map(name => [name, Bun.env[name]] as const);
		cleanups.push(() => {
			for (const [name, value] of saved) {
				if (value === undefined) delete Bun.env[name];
				else Bun.env[name] = value;
			}
		});
		// The worker reads the process environment when its entry evaluates.
		Bun.env.PI_PROXY = `http://127.0.0.1:${proxy.port}`;
		delete Bun.env.NO_PROXY;
		delete Bun.env.no_proxy;
		const probed = Promise.withResolvers<logger.LogEvent>();
		cleanups.push(
			logger.registerLogSink(event => {
				if (event.message.startsWith("proxy-probe:")) probed.resolve(event);
			}),
		);
		const worker = startWorker({ entry: new URL("../fixtures/proxy-probe-worker.ts", import.meta.url) });
		await worker.ready;
		const event = await probed.promise;
		expect([event.message, event.context?.body]).toEqual(["proxy-probe: done", "via http://proxied.invalid/probe"]);
	});
});

describe("allowedSubagentWorkers", () => {
	it("allows no worker through 8 concurrent runs, then one more per doubling up to the cap", () => {
		const inFlight = [8, 9, 17, 18, 35, 36, 71, 72, 144];
		expect(inFlight.map(n => allowedSubagentWorkers(n, 4))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
		expect(inFlight.map(n => allowedSubagentWorkers(n, 1))).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(inFlight.map(n => allowedSubagentWorkers(n, 0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
	});
});

describe("SubagentWorkerPool", () => {
	it("keeps 8 concurrent runs on main, balances runs 9–17 over main and one worker, and adds a second at 18", async () => {
		const pool = startPool(4);
		const placements = Array.from({ length: 8 }, () => pool.place());
		expect(placements.every(placement => placement.worker === undefined)).toBe(true);
		expect(pool.mainRuns).toBe(8);

		placements.push(pool.place());
		const [first] = pool.workers();
		if (!first) throw new Error("the 9th run started no worker");
		expect(placements[8]?.worker).toBe(first);
		// The worker catches up and wins the tie, keeping the TUI thread free.
		for (let i = 0; i < 8; i++) placements.push(pool.place());
		expect(placements.slice(9).every(placement => placement.worker === first)).toBe(true);
		expect([pool.mainRuns, first.runs]).toEqual([8, 9]);
		placements[0]?.release();
		const onMain = pool.place();
		expect(onMain.worker).toBeUndefined();
		placements[0] = onMain;

		placements.push(pool.place());
		const second = pool.workers()[1];
		expect(second).toBeDefined();
		expect(placements[17]?.worker).toBe(second);
		expect(pool.runsInFlight).toBe(18);

		for (const placement of placements) placement.release();
		expect(pool.runsInFlight).toBe(0);
		// Released runs keep their (now idle) workers until the idle countdown ends them.
		expect(pool.workers()).toHaveLength(2);
		await Promise.all(pool.workers().map(worker => worker.ready));
	});

	it("counts main-thread runs that bypass placement toward the balance", () => {
		const pool = startPool(4);
		const ends = Array.from({ length: 8 }, () => pool.beginMainRun());
		const placed = pool.place();
		expect(placed.worker).toBeDefined();
		for (const end of ends) end();
		ends[0]?.();
		expect(pool.mainRuns).toBe(0);
		placed.release();
	});

	it("starts a worker on prewarm only when the coming spawns reach a worker bracket", async () => {
		const pool = startPool(4);
		pool.prewarm(8);
		await nextImmediate();
		expect(pool.workers()).toEqual([]);
		pool.prewarm(9);
		await nextImmediate();
		const [prewarmed] = pool.workers();
		if (!prewarmed) throw new Error("prewarm for 9 spawns started no worker");
		await prewarmed.ready;
		expect(prewarmed.booted).toBe(true);
		const placements = Array.from({ length: 9 }, () => pool.place());
		expect(placements.slice(0, 8).every(placement => placement.worker === undefined)).toBe(true);
		expect(placements[8]?.worker).toBe(prewarmed);
		for (const placement of placements) placement.release();
	});

	it("places a run on a worker whose only load is a resident session instead of spawning", async () => {
		const pool = workerOnlyPool(2);
		const first = await leaseFrom(pool);
		const resident = first.worker.retain();
		first.release();
		expect(first.worker.load).toBe(1);
		expect(first.worker.runs).toBe(0);
		const second = await leaseFrom(pool);
		expect(second.worker).toBe(first.worker);
		second.release();
		resident();
	});

	it("terminates every worker left without runs or resident sessions for idleMs, the last one included", async () => {
		// Threshold 1: two concurrent runs open two worker slots.
		const pool = workerOnlyPool(2, { idleMs: 1_000, threshold: 1 });
		const exits: Array<{ worker: SubagentWorker; reason: string }> = [];
		pool.onWorkerExit((worker, reason) => exits.push({ worker, reason }));
		const [a, b] = await Promise.all([leaseFrom(pool), leaseFrom(pool)]);
		expect(a.worker).not.toBe(b.worker);
		useFakeTimers();
		a.release();
		b.release();
		vi.advanceTimersByTime(999);
		expect(exits).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(exits.map(exit => exit.reason)).toEqual(["idle", "idle"]);
		expect(exits.every(exit => exit.worker.link.closed)).toBe(true);
		expect(pool.workers()).toEqual([]);
	});

	it("keeps a worker with a resident session alive past idleMs and terminates it idleMs after the release", async () => {
		const pool = workerOnlyPool(1, { idleMs: 1_000 });
		const lease = await leaseFrom(pool);
		useFakeTimers();
		const resident = lease.worker.retain();
		lease.release();
		vi.advanceTimersByTime(10_000);
		expect(lease.worker.alive).toBe(true);
		resident();
		vi.advanceTimersByTime(1_000);
		expect(lease.worker.exitReason).toBe("idle");
		expect(pool.workers()).toEqual([]);
	});

	it("fails a run whose worker dies at startup with that worker's own error", async () => {
		const pool = workerOnlyPool(1, {
			worker: { entry: new URL("../fixtures/subagent-fatal-worker.ts", import.meta.url) },
		});

		await expect(pool.acquire()).rejects.toThrow(
			/exited before ready: worker crashed: .*Cannot find module '\.\/gone'/s,
		);
		expect(pool.runsInFlight).toBe(0);
		expect(pool.workers()).toEqual([]);
	});

	it("restarts an idle worker's countdown on prewarm instead of starting another", async () => {
		const pool = workerOnlyPool(2, { idleMs: 1_000 });
		const lease = await leaseFrom(pool);
		const worker = lease.worker;
		useFakeTimers();
		lease.release();
		vi.advanceTimersByTime(600);
		pool.prewarm();
		vi.advanceTimersByTime(600);
		expect(worker.alive).toBe(true);
		expect(pool.workers()).toEqual([worker]);
		vi.advanceTimersByTime(400);
		expect(worker.exitReason).toBe("idle");
	});
});
