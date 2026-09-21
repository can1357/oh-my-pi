import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

const ZERO_USAGE: SegmentContext["usageStats"] = {
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
};

function ctxWith(contextTokens: number, usage: Partial<SegmentContext["usageStats"]> = {}): SegmentContext {
	return {
		contextTokens,
		usageStats: { ...ZERO_USAGE, ...usage },
	} as unknown as SegmentContext;
}

describe("session_tokens status-line segment", () => {
	it("shows live context load while token_total keeps climbing (#11643)", () => {
		// Post-handoff shape: 1.2M tokens billed across the session, 34K of context
		// left after compaction. The two segments read different sources, so they
		// must disagree here — that divergence is the entire point of the segment.
		const ctx = ctxWith(34_000, { input: 1_200_000 });

		const live = renderSegment("session_tokens", ctx);
		expect(live.visible).toBe(true);
		expect(stripVTControlCharacters(live.content)).toContain("34K");
		expect(stripVTControlCharacters(live.content)).not.toContain("1.2M");

		const cumulative = renderSegment("token_total", ctx);
		expect(stripVTControlCharacters(cumulative.content)).toContain("1.2M");
	});

	it("stays hidden with no context yet, even after tokens have been billed", () => {
		// A resumed-but-not-yet-measured session must render nothing rather than a
		// bare `0`, and must not fall back to the cumulative counter.
		const result = renderSegment("session_tokens", ctxWith(0, { input: 1_200_000 }));

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});
});
