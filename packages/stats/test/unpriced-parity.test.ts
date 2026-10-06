import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "../src/aggregator";
import {
	closeDb,
	getFileOffset,
	getRecentRequests,
	initDb,
	insertMessageStats,
	insertToolCalls,
	markSessionBackfillsComplete,
	setFileOffset,
} from "../src/db";
import { parseSessionFile } from "../src/parser";
import {
	getCostTimeSeries,
	getOverallStats,
	getProviderTimeSeries,
	getStatsByFolder,
	getStatsByModel,
	getStatsByProvider,
	getToolStats,
	refreshRollups,
} from "../src/rollup";
import { handleApi } from "../src/server";
import type { MessageStatsInput } from "../src/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-unpriced-parity-");

const DAY = 86_400_000;
const START = Date.parse("2026-09-10T03:00:00Z");

function request(entryId: string, provider = "custom", model = "claude-sonnet-4-6", timestamp = START): MessageStatsInput {
	return {
		sessionFile: "/tmp/unpriced-parity.jsonl",
		entryId,
		folder: "/tmp/unpriced-parity",
		model,
		provider,
		api: "openai-completions",
		timestamp,
		duration: 100,
		ttft: 10,
		stopReason: "stop",
		errorMessage: null,
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
		agentType: "main",
	};
}

describe("unpriced upstream parity", () => {
	it("keeps provider/model identity, explicit zero, free cards, and bucket attribution", async () => {
		await initDb();
		const unknown = request("unknown");
		const known = request("known", "anthropic");
		const secondDay = request("next-day", "custom", unknown.model, START + DAY);
		const explicitZero = request("recorded-zero");
		explicitZero.usage.cost = { total: 0 };
		const paidZero = request("paid-recorded-zero", "anthropic");
		paidZero.usage.cost = { total: 0 };
		const free = request("free", "ollama-cloud", "deepseek-v3.2");
		const unused = request("unused");
		unused.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		insertMessageStats([unknown, known, secondDay, explicitZero, paidZero, free, unused]);
		insertToolCalls(["read", "grep"].map(toolName => ({
			sessionFile: unknown.sessionFile,
			entryId: unknown.entryId,
			toolCallId: toolName,
			folder: unknown.folder,
			toolName,
			model: unknown.model,
			provider: unknown.provider,
			timestamp: unknown.timestamp,
			agentType: unknown.agentType,
			callsInTurn: 2,
			argsChars: 0,
		})));
		await refreshRollups();
		expect(getRecentRequests().find(row => row.entryId === "unknown")?.costUnpriced).toBe(true);
		for (const id of ["recorded-zero", "paid-recorded-zero", "free"]) {
			expect(getRecentRequests().find(row => row.entryId === id)).toMatchObject({ costUnpriced: false, usage: { cost: { total: 0 } } });
		}
		expect(getOverallStats().unpricedRequests).toBe(2);
		expect(getStatsByProvider().find(row => row.provider === "custom")?.unpricedRequests).toBe(2);
		expect(getStatsByProvider().find(row => row.provider === "anthropic")?.unpricedRequests).toBe(0);
		expect(getStatsByModel().find(row => row.provider === "custom")?.unpricedRequests).toBe(2);
		expect(getStatsByFolder()[0]?.unpricedRequests).toBe(2);
		expect(getToolStats().map(row => row.unpricedRequestsShare)).toEqual([0.5, 0.5]);
		const series = getCostTimeSeries().filter(row => row.provider === "custom");
		expect(series.map(row => row.unpricedRequests)).toEqual([1, 1]);
		expect(series[1].timestamp - series[0].timestamp).toBe(DAY);
		expect(getProviderTimeSeries({ cutoff: START + DAY, bucketMs: DAY }).find(row => row.provider === "custom")).toMatchObject({
			unpricedRequests: 1,
			outputTokens: 20,
			totalTokens: 120,
		});
		closeDb();
		await initDb();
		expect(getRecentRequests().find(row => row.entryId === "paid-recorded-zero")?.usage.cost.total).toBe(0);
		expect(getOverallStats().unpricedRequests).toBe(2);
	});

	it("requires a timestamp only for absent scheduled charges and moves repaired buckets", async () => {
		await initDb();
		const undated = request("undated", "deepseek", "deepseek-v4-flash", 0);
		const recorded = request("recorded", "deepseek", "deepseek-v4-flash", 0);
		recorded.usage.cost = { total: 0 };
		const dated = request("dated", "deepseek", "deepseek-v4-flash");
		insertMessageStats([undated, recorded, dated]);
		await refreshRollups();
		expect(getRecentRequests().find(row => row.entryId === "undated")?.costUnpriced).toBe(true);
		expect(getRecentRequests().find(row => row.entryId === "recorded")?.costUnpriced).toBe(false);
		expect(getRecentRequests().find(row => row.entryId === "dated")?.usage.cost.total).toBeGreaterThan(0);
		expect(getOverallStats().unpricedRequests).toBe(1);
		undated.timestamp = START;
		insertMessageStats([undated]);
		await refreshRollups();
		expect(getOverallStats().unpricedRequests).toBe(0);
		expect(getRecentRequests().find(row => row.entryId === "undated")?.timestamp).toBe(START);
		expect(getProviderTimeSeries({ cutoff: START, bucketMs: DAY })[0]?.requests).toBe(2);
		expect(getCostTimeSeries().find(row => row.timestamp === 0)?.requests).toBe(1);
	});

	it("replays historic absent-card entries once and invalidates materialized rollups", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--unpriced-parity");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		await Bun.write(file, [
			{ type: "session", version: 3, id: "parity", timestamp: new Date(START).toISOString(), cwd: "/tmp/unpriced-parity" },
			...[["missing", undefined], ["recorded", { total: 0 }]].map(([id, cost]) => ({
				type: "message", id, timestamp: new Date(START).toISOString(),
				message: { role: "assistant", provider: "custom", model: "private-model", api: "openai-completions", timestamp: START, stopReason: "stop", content: [], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost } },
			})),
		].map(row => JSON.stringify(row)).join("\n") + "\n");
		const database = await initDb();
		insertMessageStats((await parseSessionFile(file)).stats);
		database.run("UPDATE messages SET cost_unpriced = 0");
		await refreshRollups();
		expect(getOverallStats().unpricedRequests).toBe(0);
		markSessionBackfillsComplete();
		database.run("DELETE FROM meta WHERE key = 'messages_cost_unpriced_v2'");
		database.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('messages_cost_unpriced_v1', 'complete')");
		database.run("UPDATE meta SET value = '2' WHERE key = 'rollup_version'");
		const stat = await fs.stat(file);
		setFileOffset(file, stat.size, stat.mtimeMs);
		closeDb();
		const reopened = await initDb();
		expect(getFileOffset(file)).toBeNull();
		expect(reopened.prepare("SELECT value FROM meta WHERE key = 'messages_cost_unpriced_v2'").get()).toEqual({ value: "pending" });
		setFileOffset(file, stat.size, stat.mtimeMs);
		closeDb();
		await initDb();
		expect(getFileOffset(file)?.offset).toBe(stat.size);
		// Resume the interrupted replay without another reset: the cursor here is
		// deliberately returned to zero to model its first pending work item.
		setFileOffset(file, 0, 0);
		await syncAllSessions({ workers: 1 });
		await refreshRollups();
		expect(getOverallStats().unpricedRequests).toBe(1);
		expect(getRecentRequests().find(row => row.entryId === "recorded")?.costUnpriced).toBe(false);
		const offset = getFileOffset(file);
		closeDb();
		await initDb();
		expect(getFileOffset(file)).toEqual(offset);
		expect(getOverallStats().unpricedRequests).toBe(1);
	});

	it("filters recent requests before limiting and retains all-range behavior", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([request("newest", "custom", "private", now - 1_000), request("newer", "custom", "private", now - 2_000), request("old", "custom", "private", now - 2 * DAY)]);
		expect(getRecentRequests(3, now - DAY).map(row => row.entryId)).toEqual(["newest", "newer"]);
		for (const query of ["range=24h&limit=3", "range=24h&limit=1", "range=all&limit=3", "limit=3"]) {
			const response = await handleApi(new Request(`http://stats.test/api/stats/recent?${query}`));
			expect(response.status).toBe(200);
			const rows = await response.json() as { entryId: string }[];
			expect(rows.map(row => row.entryId)).toEqual(query.includes("24h") ? (query.endsWith("=1") ? ["newest"] : ["newest", "newer"]) : ["newest", "newer", "old"]);
		}
	});
});
