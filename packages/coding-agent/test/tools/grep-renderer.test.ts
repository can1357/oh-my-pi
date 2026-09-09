import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { grepToolRenderer } from "../../src/tools/grep";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("grepToolRenderer", () => {
	it("indents inline grep output and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				displayContent: ["# src/", "## file.ts#abcd", "*12│const needle = true;"].join("\n"),
			},
		};

		const renderedLines = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		expect(plainLines.every(line => line.startsWith(" "))).toBe(true);
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Search"));
	});

	it("keeps truncation status in the header without a bottom notice", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [
				{
					type: "text",
					text: ["alpha:1", "alpha:2", "", "beta:1", "beta:2", "", "gamma:1", "gamma:2"].join("\n"),
				},
			],
			details: {
				matchCount: 6,
				fileCount: 3,
				fileLimitReached: 3,
				perFileLimitReached: 20,
				truncated: true,
			},
		};

		const collapsed = grepToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
			pattern: "needle",
		});
		const renderedLines = sanitizeText(collapsed.render(200).join("\n")).split("\n");
		const bodyLines = renderedLines.slice(1);

		expect(renderedLines[0]).toContain("truncated");
		expect(bodyLines).toHaveLength(6);
		expect(renderedLines.join("\n")).not.toContain("truncated:");
		expect(renderedLines.join("\n")).not.toContain("skip to paginate");
		expect(renderedLines.join("\n")).not.toContain("matches per file");
		expect(bodyLines.some(line => line.includes("gamma:1"))).toBe(true);
	});

	it("shows actual matches when one grouped search section is larger than the collapsed budget", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 3,
				fileCount: 3,
				displayContent: [
					"# src/",
					"## first.ts#aaaa",
					" 1│before",
					"*2│const firstFlag = true;",
					" 3│after",
					"## second.ts#bbbb",
					"*4│const secondFlag = true;",
					"## third.ts#cccc",
					"*5│const thirdFlag = true;",
				].join("\n"),
			},
		};

		const collapsed = grepToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
			pattern: "Flag",
		});
		const renderedLines = sanitizeText(collapsed.render(240).join("\n")).split("\n");
		const bodyLines = renderedLines.slice(1);

		expect(bodyLines).toHaveLength(6);
		expect(bodyLines.some(line => line.includes("const firstFlag = true;"))).toBe(true);
		expect(bodyLines.some(line => line.includes("const secondFlag = true;"))).toBe(true);
		expect(bodyLines.some(line => line.includes("1 more match"))).toBe(true);
		expect(bodyLines.some(line => line.includes("before"))).toBe(false);
		expect(bodyLines.some(line => line.includes("thirdFlag"))).toBe(false);
	});

	it("links grouped file headers and code-frame lines to filesystem targets", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const projectRoot = path.resolve("/tmp/omp-project");
		const filePath = path.join(projectRoot, "src", "file.ts");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				searchPath: projectRoot,
				scopePath: "src",
				displayContent: ["# src/", "## file.ts#abcd", "*12│const needle = true;"].join("\n"),
			},
		};

		const rendered = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240)
			.join("\n");
		const fileUri = url.pathToFileURL(path.resolve(filePath)).href;
		const lineUri = new URL(fileUri);
		lineUri.searchParams.set("line", "12");
		const uris = extractLinkUris(rendered);

		expect(uris).toContain(fileUri);
		expect(uris).toContain(lineUri.href);
	});

	it("links single-file code-frame lines to the searched file", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const filePath = path.resolve("/tmp/omp-project/file.ts");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				searchPath: filePath,
				scopePath: "file.ts",
				displayContent: "*7│needle();",
			},
		};

		const rendered = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240)
			.join("\n");

		const lineUri = new URL(url.pathToFileURL(path.resolve(filePath)).href);
		lineUri.searchParams.set("line", "7");
		expect(extractLinkUris(rendered)).toContain(lineUri.href);
	});

	it("bounds the expanded single-file view instead of dumping every match", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		// One file's matches collapse into a single blank-line group (no `#`/`##`
		// headers, `│...` gap separators). Before the fix the expanded renderer
		// dumped the entire span because the tree list ignored the line budget.
		const clusters = Array.from({ length: 12 }, (_, i) => i * 100 + 1);
		const displayContent = clusters
			.map((line, idx) => {
				const cluster = [` ${line}│ context before`, `*${line + 1}│ MATCH ${idx}`, ` ${line + 2}│ context after`];
				return idx === 0 ? cluster.join("\n") : ["    │...", ...cluster].join("\n");
			})
			.join("\n");

		const filePath = path.resolve("/tmp/omp-project/renderer.ts");
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: clusters.length,
				fileCount: 1,
				searchPath: filePath,
				scopePath: "renderer.ts",
				displayContent,
			},
		};

		const render = (expanded: boolean) =>
			sanitizeText(
				grepToolRenderer
					.renderResult(result as never, { expanded, isPartial: false }, uiTheme, { pattern: "needle" })
					.render(200)
					.join("\n"),
			).split("\n");

		const expanded = render(true);
		const expandedBody = expanded.slice(1);
		// Bounded: must not render all 12 clusters (36+ lines).
		expect(expandedBody.length).toBeLessThan(clusters.length * 3);
		expect(expandedBody.some(line => line.includes("more matches"))).toBe(true);
		// Expanded keeps surrounding context lines (unlike the compact collapsed view).
		expect(expandedBody.some(line => line.includes("context before"))).toBe(true);

		const collapsedBody = render(false).slice(1);
		expect(collapsedBody.length).toBeLessThan(expandedBody.length);
		// Collapsed compacts to match lines only — no context.
		expect(collapsedBody.some(line => line.includes("context before"))).toBe(false);
		expect(collapsedBody.some(line => line.includes("more matches"))).toBe(true);
	});
});
