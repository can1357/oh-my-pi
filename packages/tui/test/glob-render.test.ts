import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { globToolRenderer } from "@oh-my-pi/pi-tui/tools/glob";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

afterEach(() => {
	applyHyperlinkSetting("auto");
});

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

	it("distinguishes a timed-out partial listing from a result-limit truncation", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		// Both are `truncated`, but only one means the scan died. Showing a
		// dead scan as "truncated" invites a blind retry with a bigger limit.
		const timedOut = {
			content: [{ type: "text", text: "src/a.ts\nglob timed out after 5s; returning 2 partial matches" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
				truncated: true,
				timedOut: true,
			},
		};
		const limitOnly = {
			content: [{ type: "text", text: "src/a.ts" }],
			details: {
				fileCount: 2,
				files: ["src/a.ts", "src/b.ts"],
				truncated: true,
				resultLimitReached: 2,
			},
		};

		const render = (result: unknown): string =>
			sanitizeText(
				globToolRenderer
					.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { paths: "src/**/*.ts" })
					.render(240)
					.join("\n"),
			);

		expect(render(timedOut)).toContain("timed out");
		const limited = render(limitOnly);
		expect(limited).toContain("truncated");
		expect(limited).not.toContain("timed out");
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

	it("keeps raw control-byte file targets while displaying sanitized labels in terminal and native results", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const control = "\x1b[?1049h";
		const cwd = `/tmp/glob${control}-project`;
		const file = `src/fi${control}xture.ts`;
		const rawDetails = { cwd, fileCount: 1, files: [file] };
		const result = {
			content: [{ type: "text", text: "" }],
			details: { cwd: sanitizeText(cwd), fileCount: 1, files: [sanitizeText(file)] },
		};
		const options = { expanded: true, isPartial: false, renderContext: { rawDetails } };
		const rendered = globToolRenderer.renderResult(result, options, theme!).render(240).join("\n");
		const uri = url.pathToFileURL(path.resolve(cwd, file)).href;
		expect(extractLinkUris(rendered)).toEqual([uri]);
		expect(rendered).not.toContain(control);
		expect(sanitizeText(rendered)).toContain("fixture.ts");

		const native = globToolRenderer.describeResult(result, options);
		const serialized = JSON.stringify(native);
		expect(serialized).toContain(uri);
		expect(serialized).not.toContain(control);
		expect(serialized).toContain("fixture.ts");
	});
});
