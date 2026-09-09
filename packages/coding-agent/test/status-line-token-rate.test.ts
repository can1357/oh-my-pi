import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";

beforeAll(async () => {
	await initTheme();
});

function assistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.5",
		usage: {
			input: 10,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 60,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_000,
		...overrides,
	};
}

function ctxWithTokenRate(tokensPerSecond: number | null): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond,
		},
	} as unknown as SegmentContext;
}

describe("token_rate status-line segment", () => {
	it("renders per-second throughput without a numeric slash path", () => {
		const rendered = renderSegment("token_rate", ctxWithTokenRate(35.5));
		const content = stripVTControlCharacters(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(content).toContain("35.5");
		expect(content).toMatch(/(?:\/s|\bs\b|\bsec(?:ond)?s?\b|\btps\b)/i);
		expect(content).not.toContain("35.5/s");
		expect(content).not.toMatch(/\b\d+(?:\.\d+)?\/s\b/);
	});
});

describe("token rate calculation", () => {
	it("computes from completed message duration metadata", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 120 }, duration: 2_000 })],
			false,
		);
		expect(rate).toBe(60);
	});

	it("computes from elapsed time while streaming when duration metadata is missing", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ timestamp: 10_000, duration: undefined, usage: { ...base.usage, output: 45 } })],
			true,
			13_000,
		);
		expect(rate).toBe(15);
	});

	it("returns null for near-zero durations to avoid unstable spikes", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ duration: 50, usage: { ...base.usage, output: 5 } })],
			false,
		);
		expect(rate).toBeNull();
	});

	it("returns null when stream is interrupted and duration metadata is unavailable", () => {
		const rate = calculateTokensPerSecond([assistantMessage({ stopReason: "aborted", duration: undefined })], false);
		expect(rate).toBeNull();
	});

	it("returns null when usage metadata has no output tokens", () => {
		const base = assistantMessage();
		const rate = calculateTokensPerSecond(
			[assistantMessage({ usage: { ...base.usage, output: 0, totalTokens: 10 } })],
			false,
		);
		expect(rate).toBeNull();
	});
});
