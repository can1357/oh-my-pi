import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LiveVisualizer } from "../src/live/visualizer";
import { initTheme } from "../src/modes/theme/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders the classic spectrum across the entire provided width by default", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
		});

		for (const targetWidth of [10, 80, 140, 200]) {
			const lines = visualizer.render(targetWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
			const plain = lines.map(line => Bun.stripANSI(line));
			expect(plain[0]?.startsWith("┌")).toBe(true);
			expect(plain.at(-1)?.startsWith("└")).toBe(true);
			// Spectrum body is two rows; orbs would introduce braille dots.
			expect(plain.slice(1, -2).join("")).not.toMatch(/[\u2800-\u28ff]/u);
		}
	});

	it("renders thinking orbs when style is orbs and still honors narrow widths", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
			style: "orbs",
		});

		for (const targetWidth of [10, 80, 140]) {
			const lines = visualizer.render(targetWidth);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
			const plain = lines.map(line => Bun.stripANSI(line));
			expect(plain.slice(1, -2).join("")).toMatch(/[\u2800-\u28ff]/u);
		}
	});
});
