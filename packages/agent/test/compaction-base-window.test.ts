import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	prepareCompaction,
	promptBudgetTokens,
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

	it("floors percentage thresholds on small/capped windows so keepRecentTokens + reserve fit the recovery band", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: 40,
			thresholdTokens: -1,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		};
		// Raw 40% of a 100K capped window is 40K (recovery band 32K, snapcompact target 24K),
		// leaving no room for 20K kept history + 16.4K reserve. The floor raises the trigger
		// to ceil((2 * 20_000 + 16_384) / 0.8) = 70_480 (recovery band 56_384).
		const threshold100k = resolveThresholdTokens(100_000, settings);
		expect(threshold100k).toBe(70_480);
		expect(Math.floor(threshold100k * 0.8)).toBeGreaterThanOrEqual(2 * settings.keepRecentTokens + 16_384);

		// On a 200K window, 40% (80K) already exceeds the 70,480 floor.
		expect(resolveThresholdTokens(200_000, settings)).toBe(80_000);

		// On a 32K window, the floor clamps to promptBudgetTokens(32_000, settings) = 15_616.
		expect(resolveThresholdTokens(32_000, settings)).toBe(promptBudgetTokens(32_000, settings));
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
		// Capping keepRecentTokens to 50% of the 32K model's prompt budget (~7.8K) keeps only
		// the final ~6K-token message instead of retaining two messages (~12K) and summarizing only one.
		expect(prep!.messagesToSummarize).toHaveLength(2);
		expect(prep!.recentMessages).toHaveLength(1);
	});
});
