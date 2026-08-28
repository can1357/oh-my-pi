import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(loopMode: SegmentContext["loopMode"]): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
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
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

describe("status line loop mode segment", () => {
	it("shows that a bounded loop is waiting for its first prompt", () => {
		const rendered = renderSegment(
			"mode",
			createContext({ state: "waiting", limit: { kind: "iterations", initial: 10, remaining: 10 } }),
		);

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop waiting 10/10"));
	});

	it("shows the live remaining duration while a loop is running", () => {
		const now = Date.parse("2026-07-17T12:00:00Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const rendered = renderSegment(
			"mode",
			createContext({
				state: "running",
				limit: { kind: "duration", durationMs: 90_000, deadlineMs: now + 90_000 },
			}),
		);

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop running 1m30s left"));
	});

	it("distinguishes a paused loop from an active loop", () => {
		const rendered = renderSegment("mode", createContext({ state: "paused" }));
		const icon = theme.icon.pause || theme.icon.loop;

		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(icon, "Loop paused"));
		expect(rendered.content).toBe(theme.fg("warning", withIcon(icon, "Loop paused")));
	});
});
