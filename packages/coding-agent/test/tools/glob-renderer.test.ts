import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@pk-nerdsaver-ai/pi-utils";
import { globToolRenderer } from "../../src/tools/glob";

describe("globToolRenderer", () => {
	it("indents inline glob output and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		expect(plainLines.every(line => line.startsWith(" "))).toBe(true);
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Find"));
	});
});
