import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

type VimStatus = NonNullable<SegmentContext["vim"]>;

function vimContext(vim: SegmentContext["vim"]): SegmentContext {
	return { width: 80, options: {}, vim } as unknown as SegmentContext;
}

/** Most cases exercise the default `text` display; icon/none get their own tests. */
function textStatus(vim: Omit<VimStatus, "display">): VimStatus {
	return { ...vim, display: "text" };
}

/** Segment content carries SGR color; assert on the text the user reads. */
function plain(content: string): string {
	return content.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("status line vim segment", () => {
	it("stays hidden when vim mode is off", () => {
		const rendered = renderSegment("vim", vimContext(null));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("names the active mode", () => {
		const modes: [VimStatus["mode"], string][] = [
			["normal", "NORMAL"],
			["insert", "INSERT"],
			["visual", "VISUAL"],
			["visual-line", "V-LINE"],
		];
		for (const [mode, label] of modes) {
			const rendered = renderSegment("vim", vimContext(textStatus({ mode, pending: "", selectedLines: 0 })));
			expect(rendered.visible).toBe(true);
			expect(plain(rendered.content)).toBe(label);
		}
	});

	it("echoes a half-typed command beside the mode", () => {
		const rendered = renderSegment(
			"vim",
			vimContext(textStatus({ mode: "normal", pending: "2d", selectedLines: 0 })),
		);
		expect(plain(rendered.content)).toBe("NORMAL 2d");
	});

	it("appends the Visual selection height only once it spans multiple lines", () => {
		const single = renderSegment(
			"vim",
			vimContext(textStatus({ mode: "visual-line", pending: "", selectedLines: 1 })),
		);
		expect(plain(single.content)).toBe("V-LINE");

		const spanning = renderSegment(
			"vim",
			vimContext(textStatus({ mode: "visual-line", pending: "", selectedLines: 4 })),
		);
		expect(plain(spanning.content)).toBe("V-LINE 4L");
	});

	it("colors Insert differently from Normal so the mode reads at a glance", () => {
		const insert = renderSegment("vim", vimContext(textStatus({ mode: "insert", pending: "", selectedLines: 0 })));
		const normal = renderSegment("vim", vimContext(textStatus({ mode: "normal", pending: "", selectedLines: 0 })));
		expect(insert.content).not.toBe(normal.content);
		expect(insert.content).toContain("\x1b[");
	});

	it("collapses each mode to one distinct cell in every symbol preset", async () => {
		// Icons resolve through the theme symbol map, so each preset must supply a full, distinct,
		// single-cell set — a missing key would silently render as an empty segment.
		// initTheme mutates process-wide theme state; the finally restores it even on failure so a
		// broken assertion here cannot poison later test files.
		try {
			for (const preset of ["unicode", "nerd", "ascii"] as const) {
				await initTheme(false, preset);
				const glyphs: string[] = [];
				for (const mode of ["normal", "insert", "visual", "visual-line"] as const) {
					const rendered = renderSegment(
						"vim",
						vimContext({ mode, pending: "", selectedLines: 0, display: "icon" }),
					);
					const glyph = plain(rendered.content);
					expect(rendered.visible).toBe(true);
					expect(Bun.stringWidth(glyph)).toBe(1);
					glyphs.push(glyph);
				}
				// A shared glyph would make two modes indistinguishable.
				expect(new Set(glyphs).size).toBe(glyphs.length);
			}
		} finally {
			await initTheme();
		}
	});

	it("keeps pending and selection height in the icon display", () => {
		const rendered = renderSegment(
			"vim",
			vimContext({ mode: "visual-line", pending: "2", selectedLines: 3, display: "icon" }),
		);
		const text = plain(rendered.content);
		expect(text).toEndWith(" 3L 2");
		expect(Bun.stringWidth(text)).toBe(6);
	});

	it("hides the segment entirely when display is none", () => {
		const rendered = renderSegment(
			"vim",
			vimContext({ mode: "normal", pending: "2d", selectedLines: 4, display: "none" }),
		);
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});
});
