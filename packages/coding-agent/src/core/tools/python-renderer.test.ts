import { describe, expect, it } from "bun:test";
import stripAnsi from "strip-ansi";
import { getThemeByName } from "../../modes/interactive/theme/theme";
import { pythonToolRenderer } from "./python";
import { truncateTail } from "./truncate";

describe("pythonToolRenderer", () => {
	it("renders truncated output when collapsed and full output when expanded", () => {
		const theme = getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const fullOutput = ["line 1", "line 2", "line 3", "line 4"].join("\n");
		const truncation = truncateTail(fullOutput, { maxLines: 2, maxBytes: 128 });

		const result = {
			content: [{ type: "text", text: truncation.content }],
			details: {
				truncation,
				fullOutput,
			},
		};

		const collapsed = pythonToolRenderer.renderResult(result, { expanded: false, isPartial: false }, uiTheme);
		const collapsedLines = stripAnsi(collapsed.render(80).join("\n"));
		expect(collapsedLines).toContain("line 4");
		expect(collapsedLines).not.toContain("line 1");
		expect(collapsedLines).toContain("Truncated:");

		const expanded = pythonToolRenderer.renderResult(result, { expanded: true, isPartial: false }, uiTheme);
		const expandedLines = stripAnsi(expanded.render(80).join("\n"));
		expect(expandedLines).toContain("line 1");
		expect(expandedLines).toContain("line 4");
		expect(expandedLines).not.toContain("Truncated:");
	});
});
