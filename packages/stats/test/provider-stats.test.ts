import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProviderDashboardStats } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import {
	computeUsageWindowStats,
	readUsageSnapshots,
	sumFleetTokens,
	type UsageSnapshotRow,
} from "@oh-my-pi/omp-stats/usage-windows";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-providers-");

const T0 = Date.UTC(2026, 6, 20, 10, 0, 0);
const MINUTE = 60_000;

function snapshot(overrides: Partial<UsageSnapshotRow> & { recordedAt: number }): UsageSnapshotRow {
	return {
		provider: "prov-a",
		accountKey: "acct-1",
		email: null,
		accountId: null,
		limitId: "5h",
		label: "5h limit",
		windowLabel: "5h",
		usedFraction: null,
		status: null,
		...overrides,
	};
}

function message(overrides: Partial<MessageStats> & { entryId: string }): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		folder: "/tmp/project",
		model: "model-x",
		provider: "prov-a",
		api: "openai-completions",
		timestamp: T0,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 600,
			output: 300,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
		...overrides,
	};
}

function createAgentDb(rows: UsageSnapshotRow[]): void {
	const dbPath = getAgentDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	try {
		db.run(`
			CREATE TABLE usage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				provider TEXT NOT NULL,
				account_key TEXT NOT NULL,
				email TEXT,
				account_id TEXT,
				limit_id TEXT NOT NULL,
				label TEXT NOT NULL,
				window_label TEXT,
				used_fraction REAL,
				status TEXT,
				resets_at INTEGER
			)
		`);
		const insert = db.prepare(
			`INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		);
		for (const row of rows) {
			insert.run(
				row.recordedAt,
				row.provider,
				row.accountKey,
				row.email,
				row.accountId,
				row.limitId,
				row.label,
				row.windowLabel,
				row.usedFraction,
				row.status,
			);
		}
	} finally {
		db.close();
	}
}

describe("computeUsageWindowStats", () => {
	it("derives consumption, cycles, peak utilization, and capacity from snapshot deltas", () => {
		// Account 1 burns 0.1→0.5→0.9, resets to 0.2, climbs to 0.4: 1.0 windows.
		// Account 2 burns 0.3→0.8→1.0 (exhausted), resets to 0.1: 0.7 windows.
		const rows: UsageSnapshotRow[] = [
			snapshot({ recordedAt: T0 + 0 * MINUTE, accountKey: "acct-1", usedFraction: 0.1 }),
			snapshot({ recordedAt: T0 + 1 * MINUTE, accountKey: "acct-2", usedFraction: 0.3 }),
			snapshot({ recordedAt: T0 + 2 * MINUTE, accountKey: "acct-1", usedFraction: 0.5 }),
			snapshot({ recordedAt: T0 + 3 * MINUTE, accountKey: "acct-2", usedFraction: 0.8 }),
			snapshot({ recordedAt: T0 + 4 * MINUTE, accountKey: "acct-1", usedFraction: 0.9 }),
			snapshot({ recordedAt: T0 + 5 * MINUTE, accountKey: "acct-2", usedFraction: 1.0, status: "exhausted" }),
			snapshot({ recordedAt: T0 + 6 * MINUTE, accountKey: "acct-1", usedFraction: 0.2 }),
			snapshot({ recordedAt: T0 + 7 * MINUTE, accountKey: "acct-2", usedFraction: 0.1 }),
			snapshot({ recordedAt: T0 + 8 * MINUTE, accountKey: "acct-1", usedFraction: 0.4 }),
		];
		const { usageSeries, windowInsights } = computeUsageWindowStats(rows, new Map([["prov-a", 1_700_000]]));

		expect(windowInsights).toHaveLength(1);
		const insight = windowInsights[0];
		expect(insight.provider).toBe("prov-a");
		expect(insight.windowKey).toBe("5h");
		expect(insight.accounts).toBe(2);
		expect(insight.cycles).toBe(2);
		expect(insight.fractionConsumed).toBeCloseTo(1.7, 10);
		// 1.7M provider tokens over 1.7 windows → one window ≈ 1M tokens.
		expect(insight.estTokensPerWindow).toBe(1_000_000);
		// Peak: acct-1 at 0.9 while acct-2 hits 1.0 → 1.9 combined.
		expect(insight.peakConcurrentFraction).toBeCloseTo(1.9, 10);
		// ceil(1.9 / 0.9) = 3 accounts to keep peak under 90% of fleet capacity.
		expect(insight.idealAccounts).toBe(3);
		expect(insight.exhaustedEvents).toBe(1);

		expect(usageSeries).toHaveLength(2);
		const acct1 = usageSeries.find(s => s.accountKey === "acct-1");
		expect(acct1?.points.map(p => p.usedFraction)).toEqual([0.1, 0.5, 0.9, 0.2, 0.4]);
		expect(usageSeries.find(s => s.accountKey === "acct-2")?.points.some(p => p.exhausted)).toBe(true);
	});

	it("withholds capacity extrapolation when too little of the window was consumed", () => {
		const rows: UsageSnapshotRow[] = [
			snapshot({ recordedAt: T0, usedFraction: 0.5 }),
			snapshot({ recordedAt: T0 + MINUTE, usedFraction: 0.52 }),
		];
		const { windowInsights } = computeUsageWindowStats(rows, new Map([["prov-a", 1_000_000]]));
		expect(windowInsights[0].fractionConsumed).toBeCloseTo(0.02, 10);
		expect(windowInsights[0].estTokensPerWindow).toBeNull();
		expect(windowInsights[0].idealAccounts).toBe(1);
	});

	it("keeps windows with distinct limit ids separate", () => {
		const rows: UsageSnapshotRow[] = [
			snapshot({ recordedAt: T0, usedFraction: 0.2, limitId: "5h", windowLabel: "5h" }),
			snapshot({ recordedAt: T0, usedFraction: 0.1, limitId: "weekly", windowLabel: "Weekly", label: "Weekly" }),
			snapshot({ recordedAt: T0 + MINUTE, usedFraction: 0.6, limitId: "5h", windowLabel: "5h" }),
			snapshot({
				recordedAt: T0 + MINUTE,
				usedFraction: 0.15,
				limitId: "weekly",
				windowLabel: "Weekly",
				label: "Weekly",
			}),
		];
		const { windowInsights } = computeUsageWindowStats(rows, new Map());
		expect(windowInsights.map(i => i.windowKey).sort()).toEqual(["5h", "weekly"]);
	});

	it("never merges distinct limits sharing a window label", () => {
		// Anthropic reports an overall 7-day window and a model-scoped one with
		// the same "7 Day" window label. Grouping by label interleaved the two
		// fraction series per account, inflating consumption from oscillation:
		// here 0.8 - 0.1 = 0.7 fake burn per interleaved pair.
		const base = { windowLabel: "7 Day", accountKey: "acct-1" };
		const rows: UsageSnapshotRow[] = [
			snapshot({ ...base, recordedAt: T0 + 0 * MINUTE, limitId: "7d", label: "Claude 7 Day", usedFraction: 0.8 }),
			snapshot({
				...base,
				recordedAt: T0 + 1 * MINUTE,
				limitId: "7d:opus",
				label: "Claude 7 Day (Opus)",
				usedFraction: 0.1,
			}),
			snapshot({ ...base, recordedAt: T0 + 2 * MINUTE, limitId: "7d", label: "Claude 7 Day", usedFraction: 0.9 }),
			snapshot({
				...base,
				recordedAt: T0 + 3 * MINUTE,
				limitId: "7d:opus",
				label: "Claude 7 Day (Opus)",
				usedFraction: 0.15,
			}),
		];
		const { windowInsights } = computeUsageWindowStats(rows, new Map([["prov-a", 1_000_000]]));

		expect(windowInsights.map(i => i.windowKey).sort()).toEqual(["7d", "7d:opus"]);
		const overall = windowInsights.find(i => i.windowKey === "7d");
		const opus = windowInsights.find(i => i.windowKey === "7d:opus");
		expect(overall?.fractionConsumed).toBeCloseTo(0.1, 10);
		expect(opus?.fractionConsumed).toBeCloseTo(0.05, 10);
		expect(overall?.cycles).toBe(0);
		// The limit label (not the shared window label) tells the two apart.
		expect(overall?.windowLabel).toBe("Claude 7 Day");
		expect(opus?.windowLabel).toBe("Claude 7 Day (Opus)");
	});

	it("suffixes the window label when the limit label lacks the duration", () => {
		// Antigravity exposes daily and weekly limits under the same limit
		// label; the display label must carry the duration to tell them apart.
		const rows: UsageSnapshotRow[] = [
			snapshot({
				recordedAt: T0,
				limitId: "g:daily",
				label: "Usage (Google)",
				windowLabel: "Daily",
				usedFraction: 0.2,
			}),
			snapshot({
				recordedAt: T0,
				limitId: "g:weekly",
				label: "Usage (Google)",
				windowLabel: "Weekly",
				usedFraction: 0.1,
			}),
		];
		const { windowInsights } = computeUsageWindowStats(rows, new Map());
		expect(windowInsights.map(i => i.windowLabel).sort()).toEqual([
			"Usage (Google) · Daily",
			"Usage (Google) · Weekly",
		]);
	});
});

describe("sumFleetTokens", () => {
	it("sums all four token components per provider across clients, null when empty", () => {
		const client = (installId: string, provider: string, tokens: [number, number, number, number]) => ({
			installId,
			firstSeen: T0,
			lastSeen: T0,
			providers: [
				{
					provider,
					requests: 1,
					inputTokens: tokens[0],
					outputTokens: tokens[1],
					cacheReadTokens: tokens[2],
					cacheWriteTokens: tokens[3],
					costUsd: 0,
				},
			],
		});
		const tokens = sumFleetTokens([
			client("install-1", "prov-a", [100, 20, 300, 4]),
			client("install-2", "prov-a", [1, 2, 3, 4]),
			client("install-3", "prov-b", [10, 0, 0, 0]),
		]);
		expect(tokens?.get("prov-a")).toBe(434);
		expect(tokens?.get("prov-b")).toBe(10);
		// No reports must read as "no data" (fall back to local stats), not zero burn.
		expect(sumFleetTokens([])).toBeNull();
	});
});

describe("readUsageSnapshots", () => {
	it("returns rows at or after sinceMs and empty results without an agent db", () => {
		// No agent.db yet — must not throw.
		expect(readUsageSnapshots(0)).toEqual([]);

		createAgentDb([
			snapshot({ recordedAt: T0 - MINUTE, usedFraction: 0.1 }),
			snapshot({ recordedAt: T0 + MINUTE, usedFraction: 0.3, email: "a@example.com" }),
		]);
		const rows = readUsageSnapshots(T0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "prov-a",
			accountKey: "acct-1",
			email: "a@example.com",
			usedFraction: 0.3,
		});
	});

	it("waits for a contended database instead of returning no snapshots", async () => {
		createAgentDb([snapshot({ recordedAt: T0, usedFraction: 0.3 })]);
		const locker = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
db.run("BEGIN EXCLUSIVE");
process.stdout.write("locked\\n");
// This integration probe needs a real SQLite lock lifetime; fake timers cannot advance a separate process.
await Bun.sleep(100);
db.run("COMMIT");
db.close();`,
				getAgentDbPath(),
			],
			{ env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
		);
		const output = locker.stdout.getReader();
		const ready = await output.read();
		output.releaseLock();
		expect(new TextDecoder().decode(ready.value)).toContain("locked");

		const rows = readUsageSnapshots(0);
		const [exitCode, stderr] = await Promise.all([locker.exited, new Response(locker.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		expect(rows).toHaveLength(1);
	});
});

describe("getProviderDashboardStats", () => {
	it("aggregates per-provider totals, hourly burn, and window insights end to end", async () => {
		await initDb();
		insertMessageStats([
			message({ entryId: "a1", provider: "prov-a", timestamp: T0 }),
			message({ entryId: "a2", provider: "prov-a", timestamp: T0 + MINUTE, stopReason: "error" }),
			message({
				entryId: "b1",
				provider: "prov-b",
				model: "model-y",
				timestamp: T0 + 2 * MINUTE,
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
			}),
		]);
		createAgentDb([
			snapshot({ recordedAt: T0, usedFraction: 0.1 }),
			snapshot({ recordedAt: T0 + MINUTE, usedFraction: 0.6 }),
		]);

		const stats = await getProviderDashboardStats("all");

		expect(stats.providers.map(p => p.provider)).toEqual(["prov-a", "prov-b"]);
		const provA = stats.providers[0];
		expect(provA.totalRequests).toBe(2);
		expect(provA.failedRequests).toBe(1);
		expect(provA.totalTokens).toBe(2000);
		expect(provA.models).toBe(1);

		// All prov-a messages land in one hour bucket. Bun test pins JS `Date`
		// to UTC while SQLite 'localtime' uses the OS timezone, so assert the
		// grouping/summing contract rather than a specific hour value.
		const provAHours = stats.hourly.filter(p => p.provider === "prov-a");
		expect(provAHours).toHaveLength(1);
		expect(provAHours[0].hour).toBeGreaterThanOrEqual(0);
		expect(provAHours[0].hour).toBeLessThan(24);
		expect(provAHours[0].totalTokens).toBe(2000);
		expect(provAHours[0].outputTokens).toBe(600);
		expect(provAHours[0].requests).toBe(2);
		expect(stats.series.some(p => p.provider === "prov-b" && p.totalTokens === 150)).toBe(true);

		expect(stats.windowInsights).toHaveLength(1);
		const insight = stats.windowInsights[0];
		expect(insight.fractionConsumed).toBeCloseTo(0.5, 10);
		// prov-a burned 2000 tokens over 0.5 windows → 4000 tokens per window.
		expect(insight.estTokensPerWindow).toBe(4000);
		expect(stats.usageSeries).toHaveLength(1);
		expect(stats.usageSeries[0].accountLabel).toBe("acct-1");
	});
});
