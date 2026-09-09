import { beforeAll, describe, expect, it } from "bun:test";
import {
	renderSegmentTrack,
	resolveSegmentPalette,
	type TrackSegment,
} from "@oh-my-pi/pi-coding-agent/modes/components/segment-track";
import { initTheme, type ThemeColor, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const SEGMENTS: TrackSegment[] = [{ label: "smol" }, { label: "default" }, { label: "slow" }];

/** Pull the RGB out of a truecolor fg/bg escape, or null for 256-palette ones. */
function rgb(ansi: string): [number, number, number] | null {
	const m = /3[84];2;(\d+);(\d+);(\d+)/.exec(ansi);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function luma([r, g, b]: [number, number, number]): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe("resolveSegmentPalette", () => {
	it("returns theme colors that resolve to pairwise-distinct escapes", () => {
		const palette = resolveSegmentPalette(SEGMENTS.length);
		expect(palette.length).toBeGreaterThan(0);
		expect(palette.length).toBeLessThanOrEqual(SEGMENTS.length);
		const escapes = palette.map(color => theme.getFgAnsi(color));
		expect(new Set(escapes).size).toBe(palette.length);
	});

	it("starts from the theme accent and never exceeds the requested count", () => {
		expect(resolveSegmentPalette(1)).toEqual(["accent"]);
		expect(resolveSegmentPalette(4).length).toBeLessThanOrEqual(4);
	});
});

describe("renderSegmentTrack", () => {
	it("colors each segment by position from the theme palette", () => {
		const raw = renderSegmentTrack(SEGMENTS, 1);
		expect(Bun.stripANSI(raw)).toContain("smol");
		expect(Bun.stripANSI(raw)).toContain("default");
		expect(Bun.stripANSI(raw)).toContain("slow");
		// Each position carries the escape of its palette slot (modulo wrap).
		const palette = resolveSegmentPalette(SEGMENTS.length);
		for (let i = 0; i < SEGMENTS.length; i++) {
			expect(raw).toContain(theme.getFgAnsi(palette[i % palette.length]));
		}
	});

	it("fills exactly the active segment as a bold chip with a background", () => {
		const raw = renderSegmentTrack(SEGMENTS, 1);
		// One filled chip: a single bold run and a single background fill. The bg
		// introducer is `48;2;` on truecolor terminals and `48;5;` on 256-palette
		// ones (CI), so match the palette-agnostic `\x1b[48;` prefix.
		expect(raw.match(/\x1b\[1m/g)?.length).toBe(1);
		expect(raw.match(/\x1b\[48;/g)?.length).toBe(1);
		// The active label sits inside the bold run, and the fill is its own slot color.
		expect(raw).toContain("\x1b[1m default \x1b[22m");
		const palette = resolveSegmentPalette(SEGMENTS.length);
		const activeBg = theme.getFgAnsi(palette[1 % palette.length]).replace("\x1b[38;", "\x1b[48;");
		expect(raw).toContain(activeBg);
	});

	it("moves the filled chip with the active index", () => {
		expect(renderSegmentTrack(SEGMENTS, 0)).toContain("\x1b[1m smol \x1b[22m");
		expect(renderSegmentTrack(SEGMENTS, 2)).toContain("\x1b[1m slow \x1b[22m");
		// A non-active label is never wrapped in the bold chip run.
		expect(renderSegmentTrack(SEGMENTS, 0)).not.toContain("\x1b[1m slow \x1b[22m");
	});
});

describe("theme.getContrastFgAnsi", () => {
	it("returns a high-contrast near-black/near-white over any fill", () => {
		const BLACK = "\x1b[38;2;0;0;0m";
		const WHITE = "\x1b[38;2;255;255;255m";
		const colors: ThemeColor[] = ["warning", "accent", "success", "error", "border", "muted", "text"];
		for (const color of colors) {
			const fill = rgb(theme.getFgAnsi(color));
			if (!fill) continue; // 256-palette terminal: falls back to `text`, not under test here
			const picked = theme.getContrastFgAnsi(color);
			expect(picked === BLACK || picked === WHITE).toBe(true);
			const pickedRgb = rgb(picked);
			expect(pickedRgb).not.toBeNull();
			// Whichever it picked must read clearly against the fill.
			expect(Math.abs(luma(pickedRgb as [number, number, number]) - luma(fill))).toBeGreaterThan(100);
		}
	});
});
