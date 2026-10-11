import { describe, expect, it } from "bun:test";
import { describeSegment, type SegmentContext } from "../src/status-line/segments";

describe("status line token total segment", () => {
	it("describes configured traffic breakdowns for native renderers", () => {
		const ctx = {
			options: { token_total: { breakdown: true } },
			usageStats: {
				input: 20_000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 5_000,
				totalTokens: 25_005,
				orchestrationInput: 2,
				orchestrationOutput: 1,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			},
		} as SegmentContext;

		const described = describeSegment("token_total", ctx);
		expect(described?.spans.map(item => item.t).join(" ")).toBe("in:25K out:5 orch:3");
	});

	it("describes masked cached traffic at startup for native renderers", () => {
		const ctx = {
			options: { token_total: { breakdown: true } },
			usageStats: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			},
			session: {
				startupTokenBreakdown: {
					input: 25_000,
					output: 5,
					cacheWrite: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
				},
			},
		} as SegmentContext;

		const described = describeSegment("token_total", ctx);
		expect(described?.spans.map(item => item.t).join(" ")).toBe("in:…   out:…");
	});
});
