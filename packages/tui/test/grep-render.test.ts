import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { grepToolRenderer } from "@oh-my-pi/pi-tui/tools/grep";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

afterEach(() => {
	applyHyperlinkSetting("auto");
});

describe("grepToolRenderer", () => {
	it("starts grep output at the tool column and avoids accent-colored success headers", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				displayContent: ["# src/", "## file.ts#ABCD", "*12│const needle = true;"].join("\n"),
			},
		};

		const renderedLines = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240);
		const plainLines = sanitizeText(renderedLines.join("\n")).split("\n");

		// Same left edge as every other tool row (read, todo, framed cards).
		expect(plainLines[0]).not.toStartWith(" ");
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", uiTheme.symbol("icon.search")));
		expect(renderedLines[0]).not.toContain(uiTheme.fg("accent", "Search"));
	});

	it("gives each file of a directory its own branch, labelled with its full path", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 2,
				fileCount: 2,
				displayContent: ["# src/", "## a.ts#ABCD", "*1│needle", "## b.ts#EF01", "*2│needle"].join("\n"),
			},
		};
		const plainLines = sanitizeText(
			grepToolRenderer
				.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
				.render(120)
				.join("\n"),
		)
			.split("\n")
			.map(line => line.trimEnd());
		const fileRows = plainLines.filter(line => line.endsWith(".ts"));
		expect(fileRows).toEqual([`${uiTheme.tree.branch} src/a.ts`, `${uiTheme.tree.last} src/b.ts`]);
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

	it("cuts the collapsed list between files, never after a file row without its match", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 4,
				fileCount: 4,
				displayContent: [
					"# src/",
					"## first.ts#AAAA",
					" 1│before",
					"*2│const firstFlag = true;",
					" 3│after",
					"## second.ts#BBBB",
					"*4│const secondFlag = true;",
					"## third.ts#CCCC",
					"*5│const thirdFlag = true;",
					"## fourth.ts#DDDD",
					"*6│const fourthFlag = true;",
				].join("\n"),
			},
		};

		const collapsed = grepToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
			pattern: "Flag",
		});
		const renderedLines = sanitizeText(collapsed.render(240).join("\n")).split("\n");
		const bodyLines = renderedLines.slice(1);

		// first.ts and second.ts with their matches, then the summary: third.ts's row would fit, its match would not.
		expect(bodyLines).toHaveLength(5);
		expect(bodyLines.some(line => line.includes("const firstFlag = true;"))).toBe(true);
		expect(bodyLines.some(line => line.includes("const secondFlag = true;"))).toBe(true);
		expect(bodyLines.at(-1)).toContain("2 more matches");
		expect(bodyLines.some(line => line.includes("before"))).toBe(false);
		expect(bodyLines.some(line => line.includes("third"))).toBe(false);
	});

	it("links grouped file headers and code-frame lines to filesystem targets", async () => {
		applyHyperlinkSetting("always");
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
				displayContent: ["# src/", "## file.ts#ABCD", "*12│const needle = true;"].join("\n"),
			},
		};

		const rendered = grepToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240)
			.join("\n");
		const fileUri = url.pathToFileURL(path.resolve(filePath)).href;
		const uris = extractLinkUris(rendered);

		// The file row and its match row both link to the file.
		expect(uris.filter(uri => uri === fileUri)).toHaveLength(2);
	});

	it("links sanitized grouped headers and matches to the original control-byte filename and cwd", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const control = "\x1b[?1049h";
		const cwd = `/tmp/grep${control}-project`;
		const searchPath = path.join(cwd, "src");
		const file = `src/fi${control}xture.ts`;
		const filename = path.join(cwd, file);
		const displayContent = ["# src/", `## fi${control}xture.ts#ABCD`, "*12│needle"].join("\n");
		const rawDetails = {
			cwd,
			searchPath,
			scopePath: "src",
			files: [file],
			matchCount: 1,
			fileCount: 1,
			displayContent,
		};
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				...rawDetails,
				cwd: sanitizeText(cwd),
				searchPath: sanitizeText(searchPath),
				files: [sanitizeText(file)],
				displayContent: sanitizeText(displayContent),
			},
		};
		const rendered = grepToolRenderer
			.renderResult(result, { expanded: true, isPartial: false, renderContext: { rawDetails } }, theme!, {
				pattern: "needle",
			})
			.render(240)
			.join("\n");
		const uris = extractLinkUris(rendered);
		expect(uris.filter(uri => uri === url.pathToFileURL(filename).href)).toHaveLength(2);
		expect(uris).toContain(url.pathToFileURL(searchPath).href);
		expect(rendered).not.toContain(control);
		expect(sanitizeText(rendered)).toContain("fixture.ts");
	});

	it("retains the original single-file and URL display targets after detail sanitization", async () => {
		applyHyperlinkSetting("always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const control = "\x1b[?1003h";
		const filename = `/tmp/grep/file${control}.ts`;
		const singleDetails = {
			matchCount: 1,
			fileCount: 1,
			searchPath: filename,
			scopePath: `file${control}.ts`,
			files: [filename],
			displayContent: "*7│needle",
		};
		const single = grepToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						...singleDetails,
						searchPath: sanitizeText(filename),
						scopePath: sanitizeText(singleDetails.scopePath),
						files: [sanitizeText(filename)],
					},
				},
				{ expanded: true, isPartial: false, renderContext: { rawDetails: singleDetails } },
				theme!,
				{ pattern: "needle" },
			)
			.render(240)
			.join("\n");
		expect(extractLinkUris(single)).toEqual([url.pathToFileURL(filename).href, url.pathToFileURL(filename).href]);
		expect(single).not.toContain(control);

		const label = `local://fixture${control}.ts`;
		const displayContent = [`# ${label}`, "*4│needle"].join("\n");
		const urlDetails = {
			matchCount: 1,
			fileCount: 1,
			displayTargets: { [label]: filename },
			displayContent,
		};
		const linked = grepToolRenderer
			.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						...urlDetails,
						displayContent: sanitizeText(displayContent),
						displayTargets: { [label]: sanitizeText(filename) },
					},
				},
				{ expanded: true, isPartial: false, renderContext: { rawDetails: urlDetails } },
				theme!,
				{ pattern: "needle" },
			)
			.render(240)
			.join("\n");
		expect(extractLinkUris(linked)).toEqual([url.pathToFileURL(filename).href, url.pathToFileURL(filename).href]);
		expect(linked).not.toContain(control);
	});

	it("links single-file code-frame lines to the searched file", async () => {
		applyHyperlinkSetting("always");
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

		const fileUri = url.pathToFileURL(path.resolve(filePath)).href;
		expect(extractLinkUris(rendered)).toEqual([fileUri, fileUri]);
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

	it("wraps a long-pattern header so the match summary stays visible", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const pattern = Array.from({ length: 20 }, (_, i) => `alternative${i}`).join("|");
		const longLine = `const value = "${"x".repeat(200)}";`;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 8,
				fileCount: 3,
				truncated: true,
				displayContent: ["# src/a.ts", `*12│${longLine}`].join("\n"),
			},
		};
		const width = 80;

		for (const expanded of [false, true]) {
			const lines = grepToolRenderer
				.renderResult(result as never, { expanded, isPartial: false }, uiTheme, { pattern })
				.render(width);
			const plain = sanitizeText(lines.join("\n"));
			expect(plain).toContain("8 matches · 3 files · truncated");
			expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
			// Body rows stay single-row truncated: the long match line is clipped, not wrapped.
			expect(plain).not.toContain("x".repeat(200));
			expect(plain.split("\n").filter(line => line.includes("12│"))).toHaveLength(1);
		}
	});
});
