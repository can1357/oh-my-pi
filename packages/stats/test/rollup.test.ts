import { describe, expect, it } from "bun:test";
import { initDb, insertMessageStats, insertToolCalls } from "@oh-my-pi/omp-stats/db";
import {
	getOverallStats,
	getRollupStatus,
	getSessionRollups,
	getStatsByFolder,
	getStatsByModel,
	getTimeSeries,
	getToolStats,
	getToolTimeSeries,
	refreshRollups,
} from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats, ToolCallStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-rollup-");

const HOUR = 60 * 60 * 1000;
// Anchor mid-hour so a cutoff can split an hour.
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR;

function message(entryId: string, timestamp: number, over: Partial<MessageStats> = {}): MessageStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		folder: "/work/a",
		model: "model-x",
		provider: "prov",
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
		...over,
	};
}

function toolCall(entryId: string, timestamp: number, toolName: string): ToolCallStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		toolCallId: `${entryId}-${toolName}`,
		folder: "/work/a",
		toolName,
		model: "model-x",
		provider: "prov",
		timestamp,
		agentType: "main",
		callsInTurn: 1,
		argsChars: 10,
	};
}

function snapshot(cutoff: number | null) {
	return {
		overall: getOverallStats(cutoff),
		byModel: getStatsByModel(cutoff),
		byFolder: getStatsByFolder(cutoff),
		series: getTimeSeries({ cutoff, bucketMs: HOUR }),
		tools: getToolStats(cutoff),
		toolSeries: getToolTimeSeries({ cutoff, bucketMs: HOUR }),
		sessions: getSessionRollups().sort((a, b) => a.sessionFile.localeCompare(b.sessionFile)),
	};
}

describe("rollups", () => {
	it("answer range queries identically before and after dirty hours are rolled", async () => {
		await initDb();
		insertMessageStats([
			message("a", BASE + 10 * 60_000),
			message("b", BASE + 50 * 60_000, { stopReason: "error", model: "model-y", folder: "/work/b" }),
			message("c", BASE + HOUR + 5 * 60_000, { duration: null, ttft: null }),
			message("d", BASE + 3 * HOUR, { agentType: "subagent" }),
		]);
		insertToolCalls([toolCall("a", BASE + 10 * 60_000, "grep"), toolCall("d", BASE + 3 * HOUR, "read")]);
		// Splits the first hour: excludes "a" (…:10) but keeps "b" (…:50).
		const cutoff = BASE + 30 * 60_000;

		const raw = snapshot(cutoff);
		const rawAll = snapshot(null);
		expect(getRollupStatus().dirtyHours).toBeGreaterThan(0);

		await refreshRollups();
		expect(getRollupStatus().dirtyHours).toBe(0);
		expect(snapshot(cutoff)).toEqual(raw);
		expect(snapshot(null)).toEqual(rawAll);

		expect(raw.overall.totalRequests).toBe(3);
		expect(raw.overall.failedRequests).toBe(1);
		// "c" has no timing, so averages cover only the timed requests.
		expect(raw.overall.avgDuration).toBe(2000);
		expect(raw.overall.avgTokensPerSecond).toBe(20);
		expect(raw.tools.map(t => t.tool)).toEqual(["read"]);
		expect(rawAll.overall.totalRequests).toBe(4);
		expect(rawAll.tools.map(t => t.tool).sort()).toEqual(["grep", "read"]);
		expect(rawAll.sessions.find(s => s.sessionFile === "/tmp/d.jsonl")).toMatchObject({ requests: 1, toolCalls: 1 });
	});

	it("shows rows written into an already rolled hour before the next refresh", async () => {
		await initDb();
		insertMessageStats([message("a", BASE + 10 * 60_000)]);
		await refreshRollups();

		insertMessageStats([message("late", BASE + 20 * 60_000, { model: "model-late" })]);
		expect(getOverallStats(null).totalRequests).toBe(2);
		expect(
			getStatsByModel(null)
				.map(m => m.model)
				.sort(),
		).toEqual(["model-late", "model-x"]);

		await refreshRollups();
		expect(getOverallStats(null).totalRequests).toBe(2);
	});
});
