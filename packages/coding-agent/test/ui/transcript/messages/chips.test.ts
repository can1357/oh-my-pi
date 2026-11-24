import { describe, expect, it } from "bun:test";
import { chipText, termChips } from "../../../../src/ui/transcript/messages/chips";

describe("skill chips in a sent prompt", () => {
	it("styles only registered skills, not other skill-glyph prose", () => {
		const skillPath = (name: string) => (name === "reviewer" ? "/skills/reviewer/SKILL.md" : undefined);
		const display = chipText("✦ whatevertext then ✦ reviewer", { skillPath });
		expect(display.chips.map(chip => chip.label)).toEqual(["✦ reviewer"]);
		expect(termChips(display.chips)).toEqual([
			{
				t: "✦ reviewer",
				color: "customMessageLabel strong",
				pill: true,
				link: { path: "/skills/reviewer/SKILL.md", line: 1 },
			},
		]);
	});
});
