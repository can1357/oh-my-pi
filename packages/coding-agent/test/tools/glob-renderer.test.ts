import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
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

	it("renders a timed-out empty scan as incomplete instead of a definitive no-files claim", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// `truncated` with zero files only happens on the timeout path — the
		// scan died mid-walk, so "No files found" would be a false claim.
		const result = {
			content: [{ type: "text", text: "Glob timed out after 5s before finding any matches" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: true,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "~/.cache/*" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No matches before timeout (scan incomplete)");
		expect(plain).toContain("timed out");
		expect(plain).not.toContain("No files found");
	});

	it("renders a genuinely empty result as no files found", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: {
				fileCount: 0,
				files: [],
				truncated: false,
			},
		};

		const renderedLines = globToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/*.zig" })
			.render(240);
		const plain = sanitizeText(renderedLines.join("\n"));

		expect(plain).toContain("No files found");
		expect(plain).not.toContain("incomplete");
	});
});
