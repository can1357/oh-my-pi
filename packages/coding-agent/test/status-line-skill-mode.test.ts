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

function createContext(
	skillMode: SegmentContext["skillMode"],
	overrides: Partial<SegmentContext> = {},
): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		skillMode,
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
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

describe("status line pinned skill mode segment", () => {
	it("is hidden when no mode skill is pinned", () => {
		const rendered = renderSegment("mode", createContext(null));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("shows the pin icon and skill name for a single pinned mode skill", () => {
		const rendered = renderSegment("mode", createContext(["poteto-mode"]));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.pin, "poteto-mode"));
	});

	it("shows the first name plus a count for multiple pinned mode skills", () => {
		const rendered = renderSegment("mode", createContext(["ponytail", "unslop", "why"]));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.pin, "ponytail +2"));
	});

	it("sanitizes skill names before display", () => {
		const rendered = renderSegment("mode", createContext(["evil\x1b[31mname", "\u0000"]));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.pin, "evilname"));
	});

	it("yields the slot to plan mode when both are active", () => {
		const rendered = renderSegment(
			"mode",
			createContext(["ponytail"], { planMode: { enabled: true, paused: false } }),
		);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.plan, "Plan"));
	});

	it("yields the slot to vibe mode when both are active", () => {
		const rendered = renderSegment("mode", createContext(["ponytail"], { vibeMode: { enabled: true } }));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.agents, "Vibe"));
	});

	it("yields the slot to loop mode when both are active", () => {
		const rendered = renderSegment("mode", createContext(["ponytail"], { loopMode: { state: "waiting" } }));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.loop, "Loop waiting"));
	});

	it("keeps the pin when no loop is active", () => {
		const rendered = renderSegment("mode", createContext(["ponytail"], { loopMode: null }));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.pin, "ponytail"));
	});

	it("replaces the name with a placeholder during startup", () => {
		const rendered = renderSegment("mode", createContext(["ponytail"], { startupPlaceholder: true }));
		expect(Bun.stripANSI(rendered.content)).toBe(withIcon(theme.icon.pin, "…"));
	});
});
