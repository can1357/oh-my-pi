import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import type { SyncWorkerRequest, SyncWorkerResponse } from "@oh-my-pi/omp-stats/sync-worker";
import { getOverallStats, getStatsByAgentType, getStatsByFolder } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-sync-serial-");

// The sync warm pool is module state, and Bun shares module state across the
// files of a `bun test` run, so a worker a pooled sync leaves behind stays live
// into the next test and the next file unless something drops it. Every stats
// test shares `installStatsTestIsolation`, which resets the pool at each test
// boundary; the only thing this file needs is the mock restore.
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Every worker this file's pool spawned and which ones the pool has
 * terminated.
 *
 * A pooled worker is a live Bun thread that outlives its run, so the
 * properties the run has to guarantee are only observable through the
 * instance: it must stop holding the process open when the drain ends
 * (asserted by the subprocess test below, the only place an exit path is
 * observable), and something must be able to end it later.
 */
const spawnedWorkers: Worker[] = [];
const terminatedWorkers = new Set<Worker>();

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
			const terminate = worker.terminate.bind(worker);
			worker.terminate = (): void => {
				terminatedWorkers.add(worker);
				terminate();
			};
			spawnedWorkers.push(worker);
			return worker;
		});
}

/**
 * Run one pooled sync and return the worker it leaves in the warm pool.
 *
 * A returned worker stays live but unref'd as module state, so a single run
 * is enough to leave a handle behind - the shape the run's exit-path
 * guarantees have to be observed on.
 */
async function poolOneWorker(): Promise<Worker> {
	await writeSessionFile();
	const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
	const spawnSpy = spyOnWorkerSpawns();

	await syncAllSessions({ workers: 2, files: [sessionFile] });

	expect(spawnSpy).toHaveBeenCalled();
	const pooled = spawnedWorkers.at(-1);
	expect(pooled).toBeDefined();
	return pooled as Worker;
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

/** One assistant message with usage, in the shape the stats sync reads. */
function assistantMessage(options: { id?: string; output?: number; includeCost?: boolean }): Record<string, unknown> {
	const timestamp = new Date().toISOString();
	const input = 1;
	const output = options.output ?? 2;
	const includeCost = options.includeCost ?? true;
	return {
		type: "message",
		id: options.id ?? "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + output,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
}

/** Write a one-message transcript at an explicit path. */
async function writeTranscriptAt(file: string, options: { id?: string; output?: number } = {}): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${JSON.stringify(assistantMessage(options))}\n`);
	return file;
}

async function writeSessionFile(options?: { includeCost?: boolean; name?: string }): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	const sessionFile = path.join(sessionDir, options?.name ?? "session.jsonl");
	return writeTranscriptAt(sessionFile, { includeCost: options?.includeCost });
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
	it.skipIf(process.platform === "darwin")(
		"fails the run when a dispatch lands on a worker that died between parses",
		async () => {
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
		},
	);

	// The warm pool is module state, so a pooled worker outlives its run: it is
	// unref'd (never holding the process open) but still a live Bun worker thread
	// that only an idle deadline, a checkout, or an explicit reset ends. This is
	// the exit-path guarantee an uninterrupted `omp stats` run depends on - if a
	// returned worker were left referenced, the run would not exit past its last
	// parse. The exit path is only observable in a fresh process: the test binary
	// stays alive regardless, so a child that runs two pooled syncs and drains on
	// its own is the proof. Skipped on darwin, where the serial parser never spawns.
	//
	// The abort bound has to stay below the pool's own
	// `STATS_SYNC_WORKER_IDLE_MS` eviction deadline. A bound longer than the
	// deadline lets that timer terminate a wrongly-referenced pooled worker
	// instead, which frees the event loop, so the child still exits 0 with the
	// right output and the run silently costs the dead timeout instead of
	// failing. Below it, the only way out is the child's own exit.
	it.skipIf(process.platform === "darwin")("drains on its own after the warm pool reuses a worker", async () => {
		const script = [
			`import { readdirSync, readlinkSync } from "node:fs";`,
			`import * as fs from "node:fs/promises";`,
			`import * as os from "node:os";`,
			`import * as path from "node:path";`,
			`import { Database } from "bun:sqlite";`,
			`import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";`,
			`import { closeDb } from "@oh-my-pi/omp-stats/db";`,
			`import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";`,
			`import { getSessionsDir, getStatsDbPath, setAgentDir } from "@oh-my-pi/pi-utils";`,
			"",
			`const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-pool-sub-"));`,
			`const configDir = path.join(tempDir, "config");`,
			`await fs.mkdir(configDir, { recursive: true });`,
			`process.env.PI_CONFIG_DIR = path.relative(os.homedir(), configDir);`,
			`setAgentDir(path.join(os.homedir(), process.env.PI_CONFIG_DIR, "agent"));`,
			`for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[key];`,
			"",
			`const sessionDir = path.join(getSessionsDir(), "--tmp--pool-subprocess");`,
			`await fs.mkdir(sessionDir, { recursive: true });`,
			`const sessionFile = path.join(sessionDir, "session.jsonl");`,
			`const assistant = { type: "message", parentId: null, timestamp: new Date().toISOString(),`,
			`    message: { role: "assistant", content: [{ type: "text", text: "ok" }],`,
			`        api: "openai-responses", provider: "openai", model: "gpt-5.4",`,
			`        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,`,
			`            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },`,
			`        stopReason: "stop", timestamp: Date.now(), duration: 10, ttft: 5 },`,
			`};`,
			`await Bun.write(sessionFile, JSON.stringify({ ...assistant, id: "a1" }) + "\\n");`,
			`await syncAllSessions({ workers: 2, files: [sessionFile] });`,
			`await fs.appendFile(sessionFile, JSON.stringify({ ...assistant, id: "a2" }) + "\\n");`,
			`await syncAllSessions({ workers: 2, files: [sessionFile] });`,
			`console.log("totalRequests=" + getOverallStats().totalRequests);`,
			`// The sync opened config/stats.db through the module-global handle. Windows`,
			`// cannot delete a still-open sqlite file (or its WAL sidecars), so close the`,
			`// database before the recursive removal — without it the child exits nonzero`,
			`// on Windows even when pooling is correct.`,
			`closeDb();`,
			`// A stdout marker cannot prove that: it prints before the removal whether`,
			`// the handle was closed or the reference was merely dropped, and on Linux`,
			`// the removal still succeeds against a leaked handle. What the close has to`,
			`// leave behind is observable in the OS, so read it there instead.`,
			`const dbPath = getStatsDbPath();`,
			`// A released handle leaves no descriptor on stats.db or on either WAL sidecar.`,
			`// /proc is Linux-only; elsewhere this line is simply not printed.`,
			`try {`,
			`    const held = readdirSync("/proc/self/fd")`,
			`        .flatMap((fd) => {`,
			`            try { return [readlinkSync(\`/proc/self/fd/\${fd}\`)]; } catch { return []; }`,
			`        })`,
			`        .filter((target) => target === dbPath || target.startsWith(dbPath));`,
			`    console.log("leakedDbHandles=" + held.length);`,
			`} catch { /* descriptor table not exposed on this platform */ }`,
			`// A fresh connection on the same path is the platform-free half of the check:`,
			`// the close has to leave the file free to open again and the synced rows`,
			`// readable from that new connection.`,
			`const reopened = new Database(dbPath);`,
			`console.log("reopenedRequests=" + reopened.query("SELECT COUNT(*) AS n FROM messages").get().n);`,
			`reopened.close();`,
			`// No process.exit: the child must drain on its own. A pooled worker left`,
			`// referenced would hold the event loop open and hang this script.`,
			`await fs.rm(tempDir, { recursive: true, force: true });`,
		].join("\n");
		const file = path.join(import.meta.dir, ".tmp-pool-subprocess.ts");
		await fs.writeFile(file, script);
		try {
			const proc = Bun.spawn([process.execPath, file], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(4_000),
			});
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
					new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
				]);
				expect(exitCode).toBe(0);
				expect(stderr).toBe("");
				expect(stdout).toContain("totalRequests=2");
				// The close has to prove itself against the OS, not against a marker
				// printed before the removal: no descriptor may still point at stats.db
				// (where /proc exposes the table) and the file has to open again with the
				// synced rows still in it. A `closeDb` that drops the reference instead of
				// closing the handle fails the first; the exit status stays 0 and the old
				// stdout marker would have passed either way.
				if (process.platform === "linux") expect(stdout).toContain("leakedDbHandles=0");
				expect(stdout).toContain("reopenedRequests=2");
			} catch (error) {
				throw new Error("pooled worker held the process open: child did not exit within 4s", { cause: error });
			}
		} finally {
			await fs.rm(file, { force: true });
		}
	});

	// The warm pool is module state that outlives its run: a returned worker stays
	// a live Bun thread until an idle deadline, a checkout, or an explicit reset
	// ends it. `installStatsTestIsolation` is the seam every stats test file shares,
	// so a worker that survives one test's boundary must be gone before the next
	// test's checkout. Skipped on darwin, where the serial parser never spawns.
	it.skipIf(process.platform === "darwin")("drops the warm pool at the shared isolation boundary", async () => {
		const pooled = await poolOneWorker();

		isolation.resetWarmPool();

		expect(terminatedWorkers.has(pooled)).toBe(true);
	});

	// A pooled worker classifies transcripts against the sessions root it was
	// spawned under, so the pool may only hand it out while that root is still
	// the current one. An SDK that reuses the module after a `chdir()` and a
	// second `setAgentDir("agent")` is the case where the raw environment cannot
	// tell the two apart: `setAgentDir` stores the relative override verbatim, so
	// `process.env` is byte-identical both times while `getSessionsDir()` moves
	// with the cwd. Reusing the warm worker there would leave transcripts from the
	// new root parsed by a `path.relative()` against the old one, which is
	// observable as requests filed under `../..` instead of the project folder and
	// as `subagent` instead of `main`. Skipped on darwin, where the serial parser
	// never spawns.
	it.skipIf(process.platform === "darwin")(
		"does not reuse a pooled worker after the sessions root moves",
		async () => {
			const originalCwd = process.cwd();
			const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-stats-reuse-first-"));
			const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-stats-reuse-second-"));
			try {
				process.chdir(firstRoot);
				setAgentDir("agent");
				const firstSessions = getSessionsDir();
				await writeSessionFile();
				const firstRun = spyOnWorkerSpawns();
				await syncAllSessions({
					workers: 2,
					files: [path.join(firstSessions, "--tmp--sync-serial", "session.jsonl")],
				});
				expect(firstRun.mock.calls.length).toBeGreaterThan(0);
				firstRun.mockRestore();

				// No process.env edit: the reuse key has to notice the move through the
				// resolved sessions root alone, which is the whole point of this case.
				process.chdir(secondRoot);
				setAgentDir("agent");
				const secondSessions = getSessionsDir();
				await fs.rm(secondSessions, { recursive: true, force: true });
				await writeSessionFile();
				const secondRun = spyOnWorkerSpawns();
				await syncAllSessions({
					workers: 2,
					files: [path.join(secondSessions, "--tmp--sync-serial", "session.jsonl")],
				});
				expect(secondRun).toHaveBeenCalled();
				secondRun.mockRestore();

				expect(getStatsByFolder().map(folder => folder.folder)).toEqual(["/tmp/sync-serial"]);
				expect(getStatsByAgentType().map(byType => byType.agentType)).toEqual(["main"]);
			} finally {
				process.chdir(originalCwd);
				await fs.rm(firstRoot, { recursive: true, force: true });
				await fs.rm(secondRoot, { recursive: true, force: true });
				vi.restoreAllMocks();
			}
		},
	);

	// A pooled worker keeps the cwd it was spawned under, so a relative
	// transcript path resolves to a different file inside the worker than in the
	// parent. The reuse key has to notice the move: with an absolute agent dir
	// neither `process.env` nor `getSessionsDir()` changes when the parent
	// chdir's, so a reused worker would open the previous directory's transcript
	// while the parent stats the new one — the sync would silently ingest the
	// wrong file. Skipped on darwin, where the serial parser never spawns.
	it.skipIf(process.platform === "darwin")(
		"does not reuse a pooled worker after the working directory moves",
		async () => {
			const originalCwd = process.cwd();
			const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-stats-cwd-first-"));
			const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-stats-cwd-second-"));
			try {
				await writeTranscriptAt(path.join(firstDir, "shared", "session.jsonl"), { id: "assistant-1", output: 2 });
				await writeTranscriptAt(path.join(secondDir, "shared", "session.jsonl"), { id: "assistant-2", output: 99 });

				process.chdir(firstDir);
				const firstRun = spyOnWorkerSpawns();
				await syncAllSessions({ workers: 2, files: ["shared/session.jsonl"] });
				expect(firstRun).toHaveBeenCalled();
				firstRun.mockRestore();

				// No env and no agent-dir change: only the cwd moves, which is exactly
				// the case the reuse key cannot see through the environment.
				process.chdir(secondDir);
				const secondRun = spyOnWorkerSpawns();
				const secondSync = await syncAllSessions({ workers: 2, files: ["shared/session.jsonl"] });
				expect(secondRun).toHaveBeenCalled();
				secondRun.mockRestore();

				// The run has to have ingested the transcript in the new directory: a
				// reused worker would have read the first directory's file instead.
				expect(secondSync).toEqual({ processed: 1, files: 1 });
				expect(getOverallStats().totalOutputTokens).toBe(99);
			} finally {
				process.chdir(originalCwd);
				await fs.rm(firstDir, { recursive: true, force: true });
				await fs.rm(secondDir, { recursive: true, force: true });
				vi.restoreAllMocks();
			}
		},
	);
});
