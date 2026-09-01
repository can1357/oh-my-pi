import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LiveVisualizer } from "../src/live/visualizer";
import { initTheme } from "../src/modes/theme/theme";

describe("LiveVisualizer", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders across the entire provided width even when wider than 120 columns", () => {
		const visualizer = new LiveVisualizer({
			onStop: () => {},
			onToggleMute: () => {},
		});

		for (const targetWidth of [80, 140, 200]) {
			const lines = visualizer.render(targetWidth);
			expect(lines).toHaveLength(10);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
			const plain = lines.map(line => Bun.stripANSI(line));
			expect(plain[0]?.startsWith("┌")).toBe(true);
			expect(plain[9]?.startsWith("└")).toBe(true);
			const orbRows = plain.slice(1, 8);
			expect(orbRows.join("")).toMatch(/[\u2800-\u28ff]/u);
			expect(orbRows.some(row => /[\u2800-\u28ff]/u.test(row.slice(21, -1)))).toBe(false);
		}
	});
});
