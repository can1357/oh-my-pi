import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "../src/utils";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function statusContext(hookStatuses: readonly string[]): SegmentContext {
	return { width: 80, options: {}, hookStatuses } as unknown as SegmentContext;
}

const RESET_FG = "\x1b[39m";

describe("status line status segment", () => {
	it("paints unstyled statuses in the accent colour, joined by a dim dot separator", () => {
		const accent = theme.getFgAnsi("accent");
		const dim = theme.getFgAnsi("dim");
		const rendered = renderSegment("status", statusContext(["build ok", "2 tests"]));

		expect(rendered.visible).toBe(true);
		expect(rendered.content).toBe(`${accent}build ok${dim}${theme.sep.dot}${accent}2 tests${RESET_FG}`);
	});

	it("keeps an extension's own colour instead of repainting it in the accent colour", () => {
		const accent = theme.getFgAnsi("accent");
		const rendered = renderSegment("status", statusContext(["\x1b[33mbuilding\x1b[0m"]));

		expect(rendered.content).toBe(`${accent}\x1b[33mbuilding${RESET_FG}${RESET_FG}`);
	});

	it("returns to the accent colour for the unstyled status after a styled one", () => {
		const accent = theme.getFgAnsi("accent");
		const dim = theme.getFgAnsi("dim");
		const rendered = renderSegment("status", statusContext(["\x1b[1;31mfail\x1b[0m", "idle"]));

		expect(rendered.content).toBe(`${accent}\x1b[1;31mfail\x1b[22;39m${dim}${theme.sep.dot}${accent}idle${RESET_FG}`);
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
});
