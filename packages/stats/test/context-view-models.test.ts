import { describe, expect, it } from "bun:test";
import {
	buildActivityCells,
	CATEGORY_STYLE,
	chartCells,
	denseHeatmap,
	filterContextEvents,
	formatContextCost,
	heatmapBuckets,
	sortFiles,
} from "../src/client/routes/context/view-models";
import type { ContextOverview } from "../src/shared-types";

describe("context view models", () => {
	it("densifies response buckets from cutoff using the response bucket size", () => {
		const overview = {
			cutoff: 0,
			heatmapBucketMs: 10,
			heatmap: [
				{
					bucket: 10,
					requests: 2,
					promptTokens: 5,
					outputTokens: 1,
					totalTokens: 6,
					costTotal: 0,
					unpricedRequests: 0,
				},
			],
		};
		expect(heatmapBuckets(overview, 20)).toEqual([0, 10, 20]);
		expect(
			denseHeatmap(
				{
					...overview,
					sessions: [],
					models: [],
					kpi: {
						sessions: 0,
						requests: 2,
						avgPromptTokens: 0,
						peakPromptTokens: 0,
						totalTokens: 0,
						promptTokens: 5,
						inputTokens: 5,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						cacheRate: 0,
						costTotal: 0,
						unpricedRequests: 0,
					},
					range: "1h",
					omittedSessions: 0,
					omittedRequests: 0,
					omittedPromptTokens: 0,
				},
				20,
			).requests,
		).toEqual([0, 2, 0]);
	});

	function overviewFixture(
		range: ContextOverview["range"],
		cutoff: number,
		bucketMs: number,
		now: number,
	): ContextOverview {
		return {
			range,
			cutoff,
			heatmapBucketMs: bucketMs,
			kpi: {
				sessions: 1,
				requests: 2,
				avgPromptTokens: 50,
				peakPromptTokens: 60,
				totalTokens: 120,
				promptTokens: 100,
				inputTokens: 80,
				outputTokens: 20,
				cacheReadTokens: 15,
				cacheWriteTokens: 5,
				cacheRate: 15 / 95,
				costTotal: 0.01,
				unpricedRequests: 1,
			},
			heatmap: [
				{
					bucket: Math.floor(cutoff / bucketMs) * bucketMs,
					requests: 1,
					promptTokens: 40,
					outputTokens: 10,
					totalTokens: 50,
					costTotal: 0.01,
					unpricedRequests: 0,
				},
				{
					bucket: Math.floor((now - 1) / bucketMs) * bucketMs,
					requests: 1,
					promptTokens: 60,
					outputTokens: 10,
					totalTokens: 70,
					costTotal: 0,
					unpricedRequests: 1,
				},
			],
			models: [],
			sessions: [],
			omittedSessions: 0,
			omittedRequests: 0,
			omittedPromptTokens: 0,
		};
	}

	describe("context activity cells", () => {
		it("assigns every 24h bucket once and uses actual partial intervals", () => {
			const cutoff = 12.5 * 3_600_000;
			const now = cutoff + 24 * 3_600_000;
			const cells = buildActivityCells(overviewFixture("24h", cutoff, 3_600_000, now), now);
			expect(cells).toHaveLength(24);
			expect(cells[0]?.partial).toBe(true);
			expect(cells[0]?.start).toBe(cutoff);
			expect(cells.reduce((sum, cell) => sum + cell.requests, 0)).toBe(2);
			expect(cells.reduce((sum, cell) => sum + cell.promptTokens, 0)).toBe(100);
		});

		it("does not make empty cells overlap a populated bucket's interval", () => {
			const cutoff = 12.5 * 3_600_000;
			const now = cutoff + 24 * 3_600_000;
			const requestAt = cutoff + 2.25 * 3_600_000;
			const bucket = Math.floor(requestAt / 3_600_000) * 3_600_000;
			const overview = overviewFixture("24h", cutoff, 3_600_000, now);
			overview.heatmap = [
				{
					bucket,
					requests: 1,
					promptTokens: 100,
					outputTokens: 10,
					totalTokens: 110,
					costTotal: 0,
					unpricedRequests: 0,
				},
			];
			const cells = buildActivityCells(overview, now);
			const containing = cells.filter(cell => requestAt >= cell.start && requestAt < cell.end);
			expect(containing).toHaveLength(1);
			expect(containing[0]?.requests).toBe(1);
			expect(
				cells.filter(cell => cell.requests === 0 && requestAt >= cell.start && requestAt < cell.end),
			).toHaveLength(0);
		});

		it("builds 168 cells for 7d and seven chart bands", () => {
			const cutoff = 12.5 * 3_600_000;
			const now = cutoff + 7 * 24 * 3_600_000;
			const cells = buildActivityCells(overviewFixture("7d", cutoff, 3_600_000, now), now);
			expect(cells).toHaveLength(168);
			expect(chartCells(cells, "7d")).toHaveLength(7);
			expect(cells.reduce((sum, cell) => sum + cell.requests, 0)).toBe(2);
		});

		it("groups 30d by local bucket-start date without losing a bucket", () => {
			const cutoff = 12.5 * 3_600_000;
			const now = cutoff + 30 * 24 * 3_600_000;
			const cells = buildActivityCells(overviewFixture("30d", cutoff, 24 * 3_600_000, now), now);
			expect(cells.length).toBeGreaterThanOrEqual(30);
			expect(cells.reduce((sum, cell) => sum + cell.requests, 0)).toBe(2);
			expect(new Set(cells.map(cell => `${cell.row}:${cell.col}`)).size).toBe(cells.length);
		});

		it("keeps unpriced cost out of a free $0 label", () => {
			expect(formatContextCost(0, 1)).toBe("N/A");
			expect(formatContextCost(0.5, 1)).toBe("~$0.50");
			expect(formatContextCost(0.5, 0)).toBe("$0.50");
		});

		it("exposes one category colour source for every stage", () => {
			for (const value of Object.values(CATEGORY_STYLE)) {
				expect(value.color).toMatch(/^var\(--ctx-/);
			}
		});
	});

	it("filters events and sorts file activity without mutating input", () => {
		const events = [
			{ id: "a", timestamp: 1, kind: "compact", label: "Compact" },
			{ id: "b", timestamp: 2, kind: "reset", label: "Reset" },
		] as const;
		expect(filterContextEvents(events, ["reset"]).map(event => event.id)).toEqual(["b"]);
		const files = [
			{
				path: "b",
				reads: 0,
				writes: 0,
				edits: 0,
				searches: 0,
				linesRead: 0,
				linesAdded: 0,
				linesRemoved: 0,
				bytesRead: 0,
				bytesWritten: 0,
				lastTimestamp: 1,
			},
			{
				path: "a",
				reads: 0,
				writes: 0,
				edits: 0,
				searches: 0,
				linesRead: 0,
				linesAdded: 0,
				linesRemoved: 0,
				bytesRead: 0,
				bytesWritten: 0,
				lastTimestamp: 2,
			},
		] as const;
		expect(sortFiles(files, "path", "asc").map(file => file.path)).toEqual(["a", "b"]);
		expect(files[0]!.path).toBe("b");
	});
});
