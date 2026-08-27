import { describe, expect, it } from "bun:test";
import { getDashboardStats } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-today-origin-");

const HOUR_MS = 60 * 60 * 1000;

function makeMessage(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
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
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
	};
}

/**
 * Mirrors the client's `activeDaysFromSeries` (OverviewRoute): distinct local
 * dates among buckets carrying requests.
 */
function activeDaysFromSeries(series: { timestamp: number; requests: number }[]): number {
	const days = new Set<string>();
	for (const pt of series) if (pt.requests > 0) days.add(new Date(pt.timestamp).toDateString());
	return days.size;
}

describe("today range bucket alignment in fractional-UTC timezone", () => {
	it("labels just-after-midnight requests in local-midnight-aligned buckets and counts one active day", async () => {
		// Asia/Kolkata is UTC+05:30: an epoch-aligned hourly bucket at local
		// 00:10 would be stamped 23:30 of the previous local day, mislabeling
		// the Today chart and double-counting active days. The today range
		// must anchor buckets at local midnight instead.
		const previousTz = process.env.TZ;
		process.env.TZ = "Asia/Kolkata";
		try {
			await initDb();
			expect(new Date().getTimezoneOffset()).toBe(-330);

			const midnight = new Date();
			midnight.setHours(0, 0, 0, 0);
			const early = midnight.getTime() + 10 * 60 * 1000; // local 00:10 today
			const later = midnight.getTime() + 40 * 60 * 1000; // local 00:40 today

			// Sanity: the fixtures really are just after local midnight in the
			// test timezone, and epoch-aligned buckets would fall on the
			// previous local day.
			expect(early).toBeGreaterThan(midnight.getTime());
			expect(later).toBeGreaterThan(midnight.getTime());
			const epochBucket = Math.floor(early / HOUR_MS) * HOUR_MS;
			expect(new Date(epochBucket).toDateString()).not.toBe(new Date(early).toDateString());

			insertMessageStats([makeMessage(early, "today-early"), makeMessage(later, "today-later")]);

			const stats = await getDashboardStats("today");

			// Buckets are hour-aligned from local midnight (not from the Unix
			// epoch, whose :30-UTC boundaries would stamp 23:30 here).
			for (const point of stats.timeSeries) {
				expect((point.timestamp - midnight.getTime()) % HOUR_MS).toBe(0);
				expect(new Date(point.timestamp).toDateString()).toBe(new Date(early).toDateString());
			}
			// Both requests land in the same local-midnight-aligned bucket
			// (00:00) and the chart counts exactly one active day.
			expect(stats.timeSeries).toHaveLength(1);
			expect(stats.timeSeries[0].requests).toBe(2);
			expect(stats.timeSeries[0].timestamp).toBeGreaterThanOrEqual(midnight.getTime());
			expect(activeDaysFromSeries(stats.timeSeries)).toBe(1);
		} finally {
			if (previousTz === undefined) delete process.env.TZ;
			else process.env.TZ = previousTz;
		}
	});
});
