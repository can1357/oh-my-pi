import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
});

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

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});
});
