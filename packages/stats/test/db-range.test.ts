import { describe, expect, it } from "bun:test";
import { getDashboardStats, getFolderStats, getTimeRangeConfig } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-range-");

function makeMessage(timestamp: number, entryId: string, folder = "/tmp/project"): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder,
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

describe("getTimeRangeConfig 2d/3d windows", () => {
	it("resolves 2d and 3d to hourly buckets spanning 2 and 3 days", () => {
		const before = Date.now();
		const twoDays = getTimeRangeConfig("2d");
		const threeDays = getTimeRangeConfig("3d");
		const after = Date.now();
		expect(twoDays.bucketMs).toBe(3_600_000);
		expect(threeDays.bucketMs).toBe(3_600_000);
		expect(twoDays.cutoff).toBeGreaterThanOrEqual(before - 2 * 86_400_000);
		expect(twoDays.cutoff).toBeLessThanOrEqual(after - 2 * 86_400_000);
		expect(threeDays.cutoff).toBeGreaterThanOrEqual(before - 3 * 86_400_000);
		expect(threeDays.cutoff).toBeLessThanOrEqual(after - 3 * 86_400_000);
	});

	it("filters dashboard stats by the 2d range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-2d"), makeMessage(now - 72 * 60 * 60 * 1000, "outside-2d")]);

		const stats = await getDashboardStats("2d");
		expect(stats.overall.totalRequests).toBe(1);
	});
});

describe("getDashboardStats time range", () => {
	it("filters dashboard stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const dayStats = await getDashboardStats("24h");
		expect(dayStats.overall.totalRequests).toBe(1);
		expect(dayStats.byModel[0]).toMatchObject({
			totalRequests: 1,
			model: "gpt-5.4",
			provider: "openai-codex",
		});

		const weekStats = await getDashboardStats("7d");
		expect(weekStats.overall.totalRequests).toBe(2);
		expect(weekStats.byModel[0]).toMatchObject({ totalRequests: 2, model: "gpt-5.4", provider: "openai-codex" });

		const allStats = await getDashboardStats("all");
		expect(allStats.overall.totalRequests).toBe(2);
	});

	it("falls back to 24h for unknown range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const stats = await getDashboardStats("last century");
		expect(stats.overall.totalRequests).toBe(1);
	});

	it("filters dedicated folder stats by selected range", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "folder-within-24h", "/tmp/current-project"),
			makeMessage(now - 48 * 60 * 60 * 1000, "folder-outside-24h", "/tmp/older-project"),
		]);

		const dayStats = await getFolderStats("24h");
		expect(dayStats).toEqual([expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 })]);

		const allStats = await getFolderStats("all");
		expect(allStats).toHaveLength(2);
		expect(allStats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 }),
				expect.objectContaining({ folder: "/tmp/older-project", totalRequests: 1 }),
			]),
		);
	});
});
