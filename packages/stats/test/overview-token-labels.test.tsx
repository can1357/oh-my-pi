import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCompact } from "../src/client/data/formatters";
import { MetricCluster } from "../src/client/ui/MetricCluster";
import type { AggregatedStats } from "../src/shared-types";

const stats: AggregatedStats = {
	totalRequests: 1,
	successfulRequests: 1,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 100,
	totalOutputTokens: 20,
	totalCacheReadTokens: 300,
	totalCacheWriteTokens: 40,
	cacheRate: 0.75,
	cacheSavings: 0.695,
	totalCost: 0,
	unpricedRequests: 0,
	totalPremiumRequests: 0,
	avgDuration: 1000,
	avgTtft: 100,
	avgTokensPerSecond: 20,
	firstTimestamp: 1,
	lastTimestamp: 1,
};

describe("overview token metrics", () => {
	it("distinguishes uncached input and cache reads and shows their reconciled total", () => {
		const html = renderToStaticMarkup(<MetricCluster stats={stats} />);

		expect(html).toContain("Uncached Input");
		expect(html).toContain("Cache Read");
		expect(html).toContain("Conversation Total");
		expect(html).toContain("Uncached input + cache reads + cache writes + output");
		expect(html).toContain("Cache Rate");
		expect(html).toContain("Cache Savings");
		expect(html).toContain("75.0%");
		expect(html).toContain("69.5%");
		expect(html).toContain("cache writes can make this negative");

		const expectedTotal = formatCompact(
			stats.totalInputTokens +
				stats.totalOutputTokens +
				stats.totalCacheReadTokens +
				stats.totalCacheWriteTokens,
		);
		expect(html).toContain(`<div class="stats-metric-value">${expectedTotal}</div>`);
	});
});
