import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function vimContext(vim: NonNullable<SegmentContext["vim"]>): SegmentContext {
	return { vim } as SegmentContext;
}

function shown(ctx: SegmentContext): string {
	const rendered = renderSegment("vim", ctx);
	return rendered.visible ? Bun.stripANSI(rendered.content) : "";
}

describe("vim status-line segment", () => {
	it("echoes the half-typed command after the mode", () => {
		expect(shown(vimContext({ mode: "normal", pending: "15d", selectedLines: 0, display: "text" }))).toBe(
			"NORMAL 15d",
		);
	});

	it("with the mode hidden, shows only a half-typed command, and nothing once it completes", () => {
		expect(shown(vimContext({ mode: "normal", pending: "15d", selectedLines: 0, display: "none" }))).toBe("15d");
		expect(shown(vimContext({ mode: "normal", pending: "", selectedLines: 0, display: "none" }))).toBe("");
		// The native description follows the same rule.
		expect(
			describeSegment("vim", vimContext({ mode: "normal", pending: "", selectedLines: 0, display: "none" })),
		).toBeNull();
		expect(
			describeSegment("vim", vimContext({ mode: "normal", pending: '"a', selectedLines: 0, display: "none" }))
				?.spans,
		).toEqual([expect.objectContaining({ t: '"a' })]);
	});
});
