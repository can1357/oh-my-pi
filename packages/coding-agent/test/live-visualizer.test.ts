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
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(targetWidth);
			}
		}
	});
});
