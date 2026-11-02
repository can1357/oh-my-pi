import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	prepareCompaction,
	resolveThresholdTokens,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";
import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const base: CompactionSettings = { enabled: true, thresholdPercent: -1, thresholdTokens: -1, keepRecentTokens: 20000 };
const window = 1_000_000;

describe("baseWindowTokens", () => {
	it("rescales the reserve and percentage policies from the base", () => {
		// 400K base minus max(15%, 16384) = 340K, instead of 850K on the real window.
		expect(resolveThresholdTokens(window, { ...base, baseWindowTokens: 400_000 })).toBe(340_000);
		expect(resolveThresholdTokens(window, { ...base, thresholdPercent: 80, baseWindowTokens: 400_000 })).toBe(
			320_000,
		);
	});

	it("leaves a fixed threshold clamped to the real window, not the base", () => {
		expect(resolveThresholdTokens(window, { ...base, thresholdTokens: 500_000, baseWindowTokens: 400_000 })).toBe(
			500_000,
		);
	});

	it("keeps a low percentage trigger and shrinks the kept tail to land in its recovery band", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: 40,
			thresholdTokens: -1,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		};
		// The configured trigger is honored, not raised.
		expect(resolveThresholdTokens(100_000, settings)).toBe(40_000);

		const entries: SessionEntry[] = Array.from({ length: 12 }, (_, index) => ({
			type: "message",
			id: `u${index}`,
			parentId: index === 0 ? null : `u${index - 1}`,
			timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
			message: { role: "user", content: `turn-${index} ${"word ".repeat(2_000)}`, timestamp: index },
		}));
		const bundled = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-haiku-4-5 model");
		const model = { ...bundled, contextWindow: 100_000 };
		// 20K of ~2K-token turns would leave the compacted context above 0.8 × 40K once the
		// 16K reserve is counted, so it would compact again at once; the tail is capped at
		// 32_000 − 16_384 = 15_616 tokens instead.
		const capped = prepareCompaction(entries, settings, model);
		const uncapped = prepareCompaction(entries, { ...settings, thresholdPercent: -1 }, model);
		expect(capped).toBeDefined();
		expect(uncapped).toBeDefined();
		expect(capped!.recentMessages.length).toBeLessThan(uncapped!.recentMessages.length);
		expect(capped!.recentMessages.length).toBeGreaterThan(0);
	});

	it("scopes prepareCompaction usage ratio to post-compaction entries and caps keepRecentTokens on small windows", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "pre-u1",
				parentId: null,
				timestamp: "2026-10-01T00:00:00Z",
				message: { role: "user", content: `old-user ${"word ".repeat(800)}`, timestamp: 1 },
			},
			{
				type: "message",
				id: "pre-a1",
				parentId: "pre-u1",
				timestamp: "2026-10-01T00:00:01Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `old-assistant ${"word ".repeat(800)}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-haiku-4-5",
					usage: {
						input: 180_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 181_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
			},
			{
				type: "compaction",
				id: "comp-1",
				parentId: "pre-a1",
				timestamp: "2026-10-01T00:00:02Z",
				summary: "prior summary",
				firstKeptEntryId: "post-u1",
				tokensBefore: 181_000,
			},
			{
				type: "message",
				id: "post-u1",
				parentId: "comp-1",
				timestamp: "2026-10-01T00:00:03Z",
				message: { role: "user", content: `turn-1 ${"word ".repeat(5_000)}`, timestamp: 3 },
			},
			{
				type: "message",
				id: "post-u2",
				parentId: "post-u1",
				timestamp: "2026-10-01T00:00:04Z",
				message: { role: "user", content: `turn-2 ${"word ".repeat(5_000)}`, timestamp: 4 },
			},
			{
				type: "message",
				id: "post-u3",
				parentId: "post-u2",
				timestamp: "2026-10-01T00:00:05Z",
				message: { role: "user", content: `turn-3 ${"word ".repeat(5_000)}`, timestamp: 5 },
			},
		];
		const bundled = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-haiku-4-5 model");
		const smallModel = { ...bundled, contextWindow: 32_000, maxTokens: 4_096 };
		const prep = prepareCompaction(
			entries,
			{
				enabled: true,
				thresholdPercent: 40,
				thresholdTokens: -1,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			},
			smallModel,
		);
		expect(prep).toBeDefined();
		// Stale pre-compaction usage (181K) must not leak into tokensBefore after comp-1.
		expect(prep!.tokensBefore).toBe(0);
		// The kept tail is capped to land in the recovery band under the 40% trigger of the
		// 32K window, so only the final ~6K-token message is kept instead of two (~12K).
		expect(prep!.messagesToSummarize).toHaveLength(2);
		expect(prep!.recentMessages).toHaveLength(1);
	});
});
