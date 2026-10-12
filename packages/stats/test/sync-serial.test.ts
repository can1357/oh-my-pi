import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import type { SyncWorkerRequest, SyncWorkerResponse } from "@oh-my-pi/omp-stats/sync-worker";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

// The sync warm pool is module state, and Bun shares module state across the
// files of a `bun test` run, so a worker a pooled sync leaves behind stays live
// into the next test and the next file unless something drops it. Every stats
// test shares `installStatsTestIsolation`, which resets the pool at each test
// boundary; the only thing this file needs is the mock restore.
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Every worker this file's pool spawned, how many `ref()` calls each still owes
 * an `unref()` for, and which ones the pool has terminated.
 *
 * A pooled worker is a live Bun thread that outlives its run, so both properties
 * the run has to guarantee are only observable through the instance: it must
 * stop holding the process open when the drain ends, and something must be able
 * to end it later.
 */
const spawnedWorkers: Worker[] = [];
const workerRefDepth = new WeakMap<Worker, number>();
const terminatedWorkers = new Set<Worker>();
/** Warm worker the previous test left in the pool, for the teardown test. */
let warmWorkerFromPreviousTest: Worker | undefined;

/**
 * Install a `globalThis.Worker` spy that still builds real workers.
 *
 * A bare `vi.spyOn(globalThis, "Worker")` is not constructible: Bun's mock
 * forwards to the native constructor without `new.target`, so every
 * construction shape the pool can use - `new C(...)`, `Reflect.construct(C, args)`,
 * `Reflect.construct(C, args, C)` - dies with `ERR_ILLEGAL_CONSTRUCTOR` once the
 * spy is installed. Capturing the native constructor before spying and building
 * through it keeps the spy's call counting (so "did a spawn happen" stays the
 * assertion) while the pool spawns and reuses genuinely functional workers.
 *
 * Tests that assert *no* spawn can keep the bare spy: an unexpected spawn there
 * throws instead of silently constructing, which is the stricter signal.
 */
function spyOnWorkerSpawns() {
	const NativeWorker = globalThis.Worker;
	return vi
		.spyOn(globalThis, "Worker")
		.mockImplementation((url: string | URL, options?: { type: "module"; env?: Record<string, string> }) => {
			const worker = new NativeWorker(url, options);
			const nativeRef = worker.ref.bind(worker);
			const nativeUnref = worker.unref.bind(worker);
			const ref = (): void => {
				workerRefDepth.set(worker, (workerRefDepth.get(worker) ?? 0) + 1);
				nativeRef();
			};
			const unref = (): void => {
				workerRefDepth.set(worker, (workerRefDepth.get(worker) ?? 0) - 1);
				nativeUnref();
			};
			const terminate = worker.terminate.bind(worker);
			worker.ref = ref;
			worker.unref = unref;
			worker.terminate = (): void => {
				terminatedWorkers.add(worker);
				terminate();
			};
			spawnedWorkers.push(worker);
			// A Bun worker starts out referenced, so its depth starts at 1.
			workerRefDepth.set(worker, 1);
			return worker;
		});
}

/**
 * Worker double that dies the moment it answers.
 *
 * The pool's remaining lifecycle hole is a crash that lands while a handle is
 * checked out but idle: `onerror` flags it dead with no in-flight dispatch to
 * reject, so the lane's next dispatch has to fail the run instead of posting
 * into the corpse — Bun drops that post silently, and a lane that waits for a
 * reply that never comes holds the stats sync lock forever. A real Bun worker
 * cannot be steered into that window on demand: its `onerror` is a task while
 * the lane resumes from a reply through microtasks only, so a real crash always
 * lands either in flight or after the last dispatch. Delivering the reply and
 * the crash from one `postMessage` call is the shape that window has. Everything
 * above the `Worker` boundary — dispatch, the ref/unref bookkeeping, the drain's
 * failure path, handle release — runs for real.
 */
class DyingWorker {
	onmessage: ((event: { data: SyncWorkerResponse }) => void) | null = null;
	onerror: ((event: { error: unknown }) => void) | null = null;
	/** Every request the pool managed to post, so a test can prove it stopped. */
	readonly requests: SyncWorkerRequest[] = [];

	postMessage(request: SyncWorkerRequest): void {
		this.requests.push(request);
		this.onmessage?.({
			data: {
				ok: true,
				result: { stats: [], userStats: [], userLinks: [], toolCalls: [], toolResults: [], newOffset: 0 },
			},
		});
		this.onerror?.({ error: new Error("simulated worker crash") });
	}

	// The pool's Worker surface it calls but whose effect this double cannot
	// reproduce: the run's reference handling is what the spy above observes, and
	// the double is discarded (never pooled) by the time the run ends.
	readonly ref = (): void => {};
	readonly unref = (): void => {};
	readonly terminate = (): void => {};
}

async function writeSessionFile(options?: { includeCost?: boolean; name?: string }): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, options?.name ?? "session.jsonl");
	const includeCost = options?.includeCost ?? true;
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
	return sessionFile;
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("skips gc compress scratch copies but keeps transcripts in other dot directories", async () => {
		await writeSessionFile();
		const folder = path.join(getSessionsDir(), "--tmp--sync-serial");
		const scratch = path.join(folder, ".omp-gc-compress-a1b2c3");
		const hidden = path.join(folder, "session", ".runs");
		await fs.mkdir(scratch);
		await fs.mkdir(hidden, { recursive: true });
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(scratch, "session.jsonl"));
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(hidden, "child.jsonl"));

		const synced = await syncAllSessions({ workers: 1 });

		expect(synced.files).toBe(2);
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns no worker when every transcript is unchanged", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 2 });

		expect(synced).toEqual({ processed: 0, files: 0 });
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("parses a few already-tracked transcripts inline by default", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
		await fs.appendFile(sessionFile, "\n");
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		await syncAllSessions({ files: [sessionFile] });

		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});

	// The warm pool is what keeps a watcher-driven sync free of spawns, so it
	// needs coverage on the spawn count of back-to-back runs. Skipped on darwin,
	// where `syncAllSessions` stays on the serial parser and the worker spawn
	// surface is the documented macOS abort.
	it.skipIf(process.platform === "darwin")("reuses the pooled worker on the next sync run", async () => {
		const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
		await writeSessionFile();
		const firstRun = spyOnWorkerSpawns();
		await syncAllSessions({ workers: 2, files: [sessionFile] });
		expect(firstRun.mock.calls.length).toBeGreaterThan(0);
		firstRun.mockRestore();

		// Track the transcript again so the second run has real parse work to hand
		// a pooled worker; an unchanged file would parse nothing at all.
		await fs.appendFile(sessionFile, "\n");
		const secondRun = spyOnWorkerSpawns();
		await syncAllSessions({ workers: 2, files: [sessionFile] });

		expect(secondRun).not.toHaveBeenCalled();
	});

	// A worker that dies between two of a lane's dispatches is the one lifecycle
	// case the pool cannot paper over by discarding a handle: the handle is
	// checked out with nothing in flight when `onerror` flags it dead, so the
	// next dispatch must fail the run instead of posting into a corpse Bun has
	// already abandoned (Bun neither rejects that post nor answers it, so the
	// lane would wait forever holding the stats sync lock). Skipped on darwin,
	// where the serial parser never spawns.
	it.skipIf(process.platform === "darwin")("fails the run when a dispatch lands on a worker that died between parses", async () => {
		// Two files per lane, so each lane reaches for its worker a second time
		// after the crash has already been flagged.
		const sessionFiles = await Promise.all(
			[0, 1, 2, 3].map(index => writeSessionFile({ name: `crash-${index}.jsonl` })),
		);
		const dying: DyingWorker[] = [];
		vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			const worker = new DyingWorker();
			dying.push(worker);
			return worker as unknown as Worker;
		});

		await expect(syncAllSessions({ workers: 2, files: sessionFiles })).rejects.toThrow(
			"sync worker died before the request was sent",
		);

		// The lane never posted its second request into the dead worker.
		for (const worker of dying) expect(worker.requests).toHaveLength(1);
	});

	// The warm pool is module state, so a pooled worker outlives its run: it is
	// unref'd (never holding the process open) but still a live Bun worker thread
	// that only an idle deadline, a checkout, or an explicit reset ends. This is
	// the exit-path guarantee an uninterrupted `omp stats` run depends on - if a
	// returned worker were left referenced, the run would not exit past its last
	// parse. Skipped on darwin, where the serial parser never spawns.
	it.skipIf(process.platform === "darwin")("unrefs a returned worker so it cannot hold the process open", async () => {
		await writeSessionFile();
		const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
		const workerSpy = spyOnWorkerSpawns();

		await syncAllSessions({ workers: 2, files: [sessionFile] });

		const pooled = spawnedWorkers.at(-1);
		expect(pooled).toBeDefined();
		expect(workerSpy).toHaveBeenCalled();
		// Every dispatch settled, so the run must have handed back the reference it
		// held for the parse: a still-referenced worker would keep the process (and
		// this test binary) open past the end of the sync.
		expect(workerRefDepth.get(pooled as Worker)).toBe(0);
		// Kept for the test below, which asserts what the shared isolation boundary
		// does to the warm worker this run leaves behind.
		warmWorkerFromPreviousTest = pooled;
	});

	// The test above leaves a worker sitting in the warm pool, and
	// `installStatsTestIsolation` is the seam every stats test file shares. Bun
	// shares module state across the files of one `bun test` run, so a warm worker
	// that survives its test's boundary stays live for the rest of the run and
	// only the next checkout or its own 10s deadline ends it.
	it.skipIf(process.platform === "darwin")("drops the warm pool at the shared isolation boundary", () => {
		expect(warmWorkerFromPreviousTest).toBeDefined();
		expect(terminatedWorkers.has(warmWorkerFromPreviousTest as Worker)).toBe(true);
	});
});
