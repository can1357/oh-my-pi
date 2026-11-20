import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "../src/utils";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function statusContext(hookStatuses: readonly string[]): SegmentContext {
	return { width: 80, options: {}, hookStatuses } as unknown as SegmentContext;
}

/** Extension statuses as a session publishes them, with the session accent
 *  disabled so the theme's own accent color is the one the segment paints. */
function createStatusContext(hookStatuses: readonly string[]): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		sessionAccent: false,
		hookStatuses,
		planMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumTokens: 0,
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
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	} as unknown as SegmentContext;
}

const RESET_FG = "\x1b[39m";

/** Render an ANSI escape visibly, so a failed assertion names the color it got. */
function visibleAnsi(ansi: string | undefined): string {
	return ansi === undefined ? "<none>" : ansi.replace(/\x1b/g, "<ESC>");
}

describe("status line status segment", () => {
	it("paints unstyled statuses in the accent colour, joined by a separator-coloured dot", () => {
		const accent = theme.getFgAnsi("accent");
		const separator = theme.getFgAnsi("statusLineSep");
		const rendered = renderSegment("status", statusContext(["build ok", "2 tests"]));

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toBe(`${accent}build ok${separator}${theme.sep.dot}${accent}2 tests${RESET_FG}`);
	});

	it("keeps an extension's own colour instead of repainting it in the accent colour", () => {
		const accent = theme.getFgAnsi("accent");
		const rendered = renderSegment("status", statusContext(["\x1b[33mbuilding\x1b[0m"]));

		expect(rendered.content).toBe(`${accent}\x1b[33mbuilding${RESET_FG}${accent}${RESET_FG}`);
	});

	it("returns to the accent colour for the unstyled status after a styled one", () => {
		const accent = theme.getFgAnsi("accent");
		const separator = theme.getFgAnsi("statusLineSep");
		const rendered = renderSegment("status", statusContext(["\x1b[1;31mfail\x1b[0m", "idle"]));

		expect(rendered.content).toBe(
			`${accent}\x1b[1;31mfail\x1b[22;39m${accent}${separator}${theme.sep.dot}${accent}idle${RESET_FG}`,
		);
	});

	it("restores the accent for text after a foreground reset inside one status", () => {
		const accent = theme.getFgAnsi("accent");

		for (const reset of ["\x1b[0m", "\x1b[39m"]) {
			const rendered = renderSegment("status", statusContext([`before \x1b[33mhot${reset} after`]));
			expect(rendered.content).toBe(`${accent}before \x1b[33mhot\x1b[39m${accent} after${RESET_FG}`);
		}
		// A colour that follows the reset in the same sequence stands on its own.
		const recoloured = renderSegment("status", statusContext(["\x1b[33ma\x1b[0;31mb\x1b[0m c"]));
		expect(recoloured.content).toBe(`${accent}\x1b[33ma\x1b[39;31mb\x1b[39m${accent} c${RESET_FG}`);
	});

	it("re-opens the bar's faint after the bold that a focused subagent's bar is dimmed under", () => {
		const accent = theme.getFgAnsi("accent");
		const context = { ...statusContext(["\x1b[1mbold\x1b[0m after"]), focusedAgentId: "worker" };

		expect(renderSegment("status", context).content).toBe(`${accent}\x1b[1mbold\x1b[22m\x1b[2m after${RESET_FG}`);
		expect(renderSegment("status", statusContext(["\x1b[1mbold\x1b[0m after"])).content).toBe(
			`${accent}\x1b[1mbold\x1b[22m after${RESET_FG}`,
		);
	});

	it("drops backgrounds, full resets, and unsafe escapes the bar cannot tolerate", () => {
		const rendered = renderSegment(
			"status",
			statusContext(["\x1b[41;33m\x1b]8;;https://example.com\x07hot\x1b]8;;\x07\x1b[2J\x1b[0m"]),
		);

		expect(rendered.content).toContain("\x1b[33mhot");
		expect(rendered.content).not.toContain("\x1b[0m");
		expect(rendered.content).not.toContain("41");
		expect(rendered.content).not.toContain("example.com");
		expect(rendered.content).not.toContain("\x1b[2J");
	});

	it("counts only the visible text toward the segment width", () => {
		const rendered = renderSegment("status", statusContext(["\x1b[38;5;208mhot\x1b[0m", "cold"]));

		expect(visibleWidth(rendered.content)).toBe(visibleWidth(`hot${theme.sep.dot}cold`));
	});

	it("stays hidden when every status is empty or carries no visible text", () => {
		const rendered = renderSegment("status", statusContext(["", "\x1b[33m\x1b[0m", "\x1b[41m  \x1b[49m"]));

		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("paints the separator between statuses with the separator color", () => {
		const content = renderSegment("status", createStatusContext(["A !", "B ?"])).content;
		const accentAnsi = theme.getFgAnsi("accent");
		const separatorAnsi = theme.getFgAnsi("statusLineSep");
		// Without distinct foregrounds the assertions below would be vacuous.
		expect(accentAnsi).not.toBe(separatorAnsi);

		// The dot carries the separator's own foreground, not the statuses' accent.
		// Compare the escape sequences themselves: `muted` and `statusLineSep`
		// share one ANSI color, so reverse-mapping a color back to a token
		// cannot tell which token painted the dot.
		const dotAt = content.indexOf(theme.sep.dot);
		expect(dotAt).toBeGreaterThan(-1);
		const dotForeground = /\x1b\[[0-9;:]*m$/.exec(content.slice(0, dotAt))?.[0];
		expect(visibleAnsi(dotForeground)).toBe(visibleAnsi(separatorAnsi));
		expect(visibleAnsi(dotForeground)).not.toBe(visibleAnsi(accentAnsi));

		// The status text keeps the accent.
		expect(content).toContain(`${accentAnsi}A !`);
		expect(content).toContain(`${accentAnsi}B ?`);
	});

	it("describes the separator between statuses with the separator token", () => {
		const view = describeSegment("status", createStatusContext(["A !", "B ?"]));
		expect(view?.spans.map(span => span.s)).toEqual(["accent", "statusLineSep", "accent"]);
		expect(view?.spans[0]?.t).toBe("A !");
		expect(view?.spans[1]?.t).toBe(theme.sep.dot);
		expect(view?.spans[2]?.t).toBe("B ?");
	});

	it("renders a single status without a separator", () => {
		const content = renderSegment("status", createStatusContext(["A !"])).content;
		expect(content).not.toContain(theme.sep.dot);
		expect(content).toContain("A !");

		const view = describeSegment("status", createStatusContext(["A !"]));
		expect(view?.spans.map(span => span.s)).toEqual(["accent"]);
	});
});
