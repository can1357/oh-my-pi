import { describe, expect, it } from "bun:test";
import { getDashboardStats, getFolderStats } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { FolderStats, MessageStats } from "@oh-my-pi/omp-stats/types";
import { handleApi } from "../src/server";
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

async function readFolderStats(response: Response): Promise<FolderStats[]> {
	expect(response.status).toBe(200);
	return response.json() as Promise<FolderStats[]>;
}

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

	it("returns range-filtered folder stats through the HTTP API", async () => {
		const db = await initDb();

		const now = Date.now();
		insertMessageStats([
			makeMessage(now, "api-folder-within-24h", "/tmp/current-project"),
			makeMessage(now - 48 * 60 * 60 * 1000, "api-folder-outside-24h", "/tmp/older-project"),
		]);

		// The legacy dashboard path reads this in getStatsByAgentType; the folder query does not.
		db.run("DROP INDEX idx_messages_timestamp_agent_type");
		db.run("ALTER TABLE messages DROP COLUMN agent_type");

		const folders = await readFolderStats(
			await handleApi(new Request("http://stats.test/api/stats/folders?range=24h")),
		);
		expect(folders).toEqual([expect.objectContaining({ folder: "/tmp/current-project", totalRequests: 1 })]);
	});
});
