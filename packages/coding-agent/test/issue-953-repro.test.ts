import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function createCtx(usage: Partial<SegmentContext["usageStats"]>): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		loopMode: null,
		goalMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
			...usage,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		activeRepo: null,
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

describe("issue #953 cache status line icons", () => {
	it("renders cache reads as cache output and cache writes as cache input", () => {
		const cacheRead = renderSegment("cache_read", createCtx({ cacheRead: 28_919_910 }));
		const cacheWrite = renderSegment("cache_write", createCtx({ cacheWrite: 1_759_992 }));

		expect(cacheRead.visible).toBe(true);
		expect(cacheRead.content).toContain(theme.icon.cache);
		expect(cacheRead.content).toContain(theme.icon.output);
		expect(cacheRead.content).not.toContain(theme.icon.input);

		expect(cacheWrite.visible).toBe(true);
		expect(cacheWrite.content).toContain(theme.icon.cache);
		expect(cacheWrite.content).toContain(theme.icon.input);
		expect(cacheWrite.content).not.toContain(theme.icon.output);
	});
});

describe("cache_hit segment", () => {
	it("shows hit rate from cacheRead / (cacheRead + cacheWrite) when cacheWrite > 0", () => {
		const segment = renderSegment("cache_hit", createCtx({ cacheRead: 7_500, cacheWrite: 2_500 }));

		expect(segment.visible).toBe(true);
		expect(segment.content).toContain(theme.icon.cache);
		// 7500 / (7500 + 2500) = 75%
		expect(segment.content).toContain("75.00%");
	});

	it("shows hit rate from cacheRead / (cacheRead + input) when cacheWrite = 0 (DeepSeek fallback)", () => {
		// DeepSeek: cacheWrite=0, input=miss_tokens
		const segment = renderSegment("cache_hit", createCtx({ cacheRead: 6_000, cacheWrite: 0, input: 4_000 }));

		expect(segment.visible).toBe(true);
		// 6000 / (6000 + 4000) = 60%
		expect(segment.content).toContain("60.00%");
	});

	it("shows 100% when all input was cached (cacheWrite=0, input=0)", () => {
		const segment = renderSegment("cache_hit", createCtx({ cacheRead: 5_000, cacheWrite: 0, input: 0 }));

		expect(segment.visible).toBe(true);
		expect(segment.content).toContain("100.00%");
	});

	it("is hidden when cacheRead is 0", () => {
		const segment = renderSegment("cache_hit", createCtx({ cacheRead: 0, cacheWrite: 5_000 }));

		expect(segment.visible).toBe(false);
	});

	it("is hidden when there is no cache activity at all", () => {
		const segment = renderSegment("cache_hit", createCtx({ cacheRead: 0, cacheWrite: 0, input: 1_000 }));

		expect(segment.visible).toBe(false);
	});
});
