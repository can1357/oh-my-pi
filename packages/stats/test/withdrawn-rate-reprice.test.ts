import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { buildSessionTrace } from "@oh-my-pi/omp-stats/trace";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-withdrawn-");

// DeepSeek's Flash card for V4 Pro started 2026-09-14T04:00Z in v18.1.17
// through v18.12.6, and #16881 withdrew it. Tuesday 2026-09-15 06:30Z is
// inside the 06:00-10:00 peak window; 12:00Z is off-peak (half price).
const PEAK = Date.parse("2026-09-15T06:30:00Z");
const OFF_PEAK = Date.parse("2026-09-15T12:00:00Z");
// Monday 2026-09-14 03:30Z: peak, but before the withdrawn card started.
const BEFORE_CARD = Date.parse("2026-09-14T03:30:00Z");

// What those releases recorded for 200K input, 20K output and 800K cache-read
// tokens on V4 Pro: Flash rates ($0.30 / $1.20 / $0.006 per 1M).
const RELEASED_PEAK = { input: 0.06, output: 0.024, cacheRead: 0.0048, cacheWrite: 0, total: 0.0888 };
const RELEASED_OFF_PEAK = { input: 0.03, output: 0.012, cacheRead: 0.0024, cacheWrite: 0, total: 0.0444 };
// The same requests at the Pro card ($1.32 / $3.96 / $0.044 per 1M).
const PRO_PEAK = { input: 0.264, output: 0.0792, cacheRead: 0.0352, cacheWrite: 0, total: 0.3784 };
const PRO_OFF_PEAK = { input: 0.132, output: 0.0396, cacheRead: 0.0176, cacheWrite: 0, total: 0.1892 };

type Cost = MessageStats["usage"]["cost"];

function request(entryId: string, provider: string, model: string, timestamp: number, cost: Cost): MessageStats {
	return {
		sessionFile: "/tmp/withdrawn.jsonl",
		entryId,
		folder: "/tmp/project",
		model,
		provider,
		api: "openai-completions",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 200_000,
			output: 20_000,
			cacheRead: 800_000,
			cacheWrite: 0,
			totalTokens: 1_020_000,
			cost: { ...cost },
		},
		agentType: "main",
	};
}

function requests(): MessageStats[] {
	return [
		request("peak", "deepseek", "deepseek-v4-pro", PEAK, RELEASED_PEAK),
		request("off-peak", "deepseek", "deepseek-v4-pro", OFF_PEAK, RELEASED_OFF_PEAK),
		// Controls. Each one keeps the cost it recorded.
		request("before-card", "deepseek", "deepseek-v4-pro", BEFORE_CARD, RELEASED_PEAK),
		request("own-price", "deepseek", "deepseek-v4-pro", PEAK, {
			input: 0.1,
			output: 0.05,
			cacheRead: 0.01,
			cacheWrite: 0,
			total: 0.16,
		}),
		request("total-only", "deepseek", "deepseek-v4-pro", PEAK, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.0888,
		}),
		request("flash", "deepseek", "deepseek-v4-flash", PEAK, RELEASED_PEAK),
		request("fireworks", "fireworks", "deepseek-v4-pro", PEAK, RELEASED_PEAK),
	];
}

const REPRICED: Record<string, Cost> = {
	peak: PRO_PEAK,
	"off-peak": PRO_OFF_PEAK,
	"before-card": RELEASED_PEAK,
	"own-price": { input: 0.1, output: 0.05, cacheRead: 0.01, cacheWrite: 0, total: 0.16 },
	"total-only": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0888 },
	flash: RELEASED_PEAK,
	fireworks: RELEASED_PEAK,
};

// Twelve decimal places: far below any price difference, far above float noise.
function rounded(cost: Cost): Cost {
	const round = (value: number) => Math.round(value * 1e12) / 1e12;
	return {
		input: round(cost.input),
		output: round(cost.output),
		cacheRead: round(cost.cacheRead),
		cacheWrite: round(cost.cacheWrite),
		total: round(cost.total),
	};
}

function expectCosts(expected: Record<string, Cost>): void {
	const stored = Object.fromEntries(getRecentRequests(50).map(row => [row.entryId, rounded(row.usage.cost)]));
	expect(stored).toEqual(
		Object.fromEntries(Object.entries(expected).map(([entryId, cost]) => [entryId, rounded(cost)])),
	);
}

type RawRow = Record<string, number | string | null>;

function rawRows(database: Database): RawRow[] {
	return database.query("SELECT * FROM messages ORDER BY entry_id").all() as RawRow[];
}

describe("stats costs from a withdrawn rate card", () => {
	it("re-prices the withdrawn card's costs on ingest and keeps every other recorded cost", async () => {
		const database = await initDb();
		insertMessageStats(requests());
		expectCosts(REPRICED);

		// Re-ingesting the unchanged transcript costs must not bring the Flash prices back.
		const repriced = rawRows(database);
		insertMessageStats(requests());
		expect(rawRows(database)).toEqual(repriced);
		closeDb();
		await initDb();
		expectCosts(REPRICED);
	});

	it("repairs rows an affected release stored, and a second pass changes nothing", async () => {
		const database = await initDb();
		insertMessageStats(requests());
		// A database written by an affected release: Flash-rate costs, and
		// cache savings measured against the Flash input rate.
		const age = database.query(
			"UPDATE messages SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?, cost_no_cache_input = ? WHERE entry_id = ?",
		);
		for (const [entryId, cost, noCacheInput] of [
			["peak", RELEASED_PEAK, 0.3],
			["off-peak", RELEASED_OFF_PEAK, 0.15],
		] as const) {
			age.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, noCacheInput, entryId);
		}
		const controls = rawRows(database).filter(row => row.entry_id !== "peak" && row.entry_id !== "off-peak");
		database.run("DELETE FROM meta WHERE key = 'withdrawn_rate_repair'");
		closeDb();

		const reopened = await initDb();
		expectCosts(REPRICED);
		const noCacheInput = Object.fromEntries(
			(
				reopened
					.query("SELECT entry_id, cost_no_cache_input FROM messages WHERE entry_id IN ('peak', 'off-peak')")
					.all() as { entry_id: string; cost_no_cache_input: number }[]
			).map(row => [row.entry_id, row.cost_no_cache_input]),
		);
		expect(noCacheInput.peak).toBeCloseTo(1.32, 12);
		expect(noCacheInput["off-peak"]).toBeCloseTo(0.66, 12);
		expect(rawRows(reopened).filter(row => row.entry_id !== "peak" && row.entry_id !== "off-peak")).toEqual(controls);

		const repaired = rawRows(reopened);
		reopened.run("DELETE FROM meta WHERE key = 'withdrawn_rate_repair'");
		closeDb();
		const again = await initDb();
		expect(rawRows(again)).toEqual(repaired);
		insertMessageStats(requests());
		expect(rawRows(again)).toEqual(repaired);
	});

	it("re-prices a synced transcript and its trace, and leaves the transcript as written", async () => {
		const projectDir = path.join(getSessionsDir(), "--tmp--withdrawn-rate");
		await fs.mkdir(projectDir, { recursive: true });
		const file = path.join(projectDir, "1789459800000_withdrawn.jsonl");
		const entries = [
			{ type: "session", version: 3, id: "s", timestamp: new Date(PEAK).toISOString(), cwd: "/tmp/project" },
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: new Date(PEAK + 1000).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 200_000,
						output: 20_000,
						cacheRead: 800_000,
						cacheWrite: 0,
						totalTokens: 1_020_000,
						cost: RELEASED_PEAK,
					},
					stopReason: "stop",
					timestamp: PEAK,
					duration: 1000,
					ttft: 100,
				},
			},
		];
		const transcript = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
		await Bun.write(file, transcript);

		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests(1)[0]?.usage.cost.total).toBeCloseTo(0.3784, 12);

		// A full re-parse of the same transcript keeps the Pro price.
		const database = await initDb();
		database.run("DELETE FROM meta WHERE key = 'messages_cost_reingest_v1'");
		closeDb();
		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests(1)[0]?.usage.cost.total).toBeCloseTo(0.3784, 12);

		const { summary } = await buildSessionTrace(file);
		expect(summary.costTotal).toBeCloseTo(0.3784, 12);
		expect(await Bun.file(file).text()).toBe(transcript);
	});
});
