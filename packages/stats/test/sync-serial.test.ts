import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { __resetStatsSyncWorkerPool, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

// The sync worker pool is module state, and Bun shares module state across the
// test files of a single `bun test` run. Reset before and after so neither a
// leaked warm worker from another file nor one from a test above can be reused
// here, where `globalThis.Worker` spies assert whether a spawn happened.
beforeEach(() => {
	__resetStatsSyncWorkerPool();
});

afterEach(() => {
	__resetStatsSyncWorkerPool();
	vi.restoreAllMocks();
});

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
		.mockImplementation((url: string | URL, options?: { type: "module"; env?: Record<string, string> }) =>
			new NativeWorker(url, options),
		);
}

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, "session.jsonl");
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
});
