import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { buildRailRow } from "../src/modes/components/composer/rail";
import { initTheme } from "../src/modes/theme/theme";

await initTheme();

describe("intent composer rail", () => {
	it("surfaces the double-left Agent Hub shortcut without overflowing", () => {
		const width = 72;
		const row = buildRailRow(
			{
				modeLabel: "Build",
				cta: "Run",
				streaming: false,
				hasInput: true,
				queuedCount: 0,
				agentHubHint: "Agent Hub (alt+a or ←←)",
			},
			width,
		);

		expect(row).toContain("Agent Hub");
		expect(row).toContain("←←");
		expect(row).toContain("Run");
		expect(visibleWidth(row)).toBe(width);
	});
});
