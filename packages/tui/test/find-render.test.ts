import { afterEach, describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { findToolRenderer, type FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { applyHyperlinkSetting } from "../src/render/hyperlink";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

afterEach(() => {
	applyHyperlinkSetting("auto");
});

const details: FindToolDetails = {
	query: "retry budget",
	keywords: ["retry", "budget"],
	threshold: 0.2,
	cwd: "/repo",
	elapsedMs: 1500,
	hits: [
		{
			rel: "src/retry.ts",
			contentScore: 0.9,
			linesSeen: 40,
			truncated: false,
			ranges: [
				{ start: 10, end: 20, p: 0.9, snippet: "function retryBudget() {" },
				{ start: 30, end: 40, p: 0.5, snippet: "\tconst attempts = 3;" },
			],
		},
		{
			rel: "src/other.ts",
			contentScore: 0.3,
			linesSeen: 5,
			truncated: true,
			ranges: [{ start: 1, end: 5, p: 0.3, snippet: "x" }],
		},
	],
	coverage: "partial",
	stats: {
		listed: 2,
		requests: 3,
		failed: 1,
		unanswered: 0,
		judged: 2,
		filesRead: 2,
		fileBytes: 100,
		inputTokens: 1200,
		outputTokens: 0,
		cost: 0,
		apiMs: 900,
		windowsJudged: 3,
		windowsPruned: 0,
		mapCards: 3,
		failures: ["verification: boom"],
	},
};
const args = { query: details.query, grep_keywords: [] };
const result = { content: [{ type: "text", text: "" }], details };

describe("findToolRenderer", () => {
	it("links every hit and range to its absolute file location under cwd", async () => {
		applyHyperlinkSetting("always");
		const uiTheme = (await getThemeByName("dark"))!;
		const lines = findToolRenderer
			.renderResult(result, { expanded: true, isPartial: false }, uiTheme, args)
			.render(200);
		const uris = extractLinkUris(lines.join("\n"));
		// One link per hit row plus one per range row; line positions are
		// terminal-specific (see fileUriForTerminal), so only the target is asserted.
		expect(uris.filter(uri => uri.endsWith("/repo/src/retry.ts"))).toHaveLength(3);
		expect(uris.filter(uri => uri.endsWith("/repo/src/other.ts"))).toHaveLength(2);
	});

	it("uses raw DEC-byte filenames only in file hyperlink targets", async () => {
		applyHyperlinkSetting("always");
		const uiTheme = (await getThemeByName("dark"))!;
		const rawDetails: FindToolDetails = {
			...details,
			cwd: "/repo/\x1b[1m",
			hits: [{ ...details.hits[0]!, rel: "src/\x1b[31mretry.ts" }],
		};
		const safeDetails: FindToolDetails = {
			...rawDetails,
			cwd: sanitizeText(rawDetails.cwd),
			hits: [{ ...rawDetails.hits[0]!, rel: sanitizeText(rawDetails.hits[0]!.rel) }],
		};
		const input = { content: result.content, details: safeDetails };
		const options = { expanded: true, isPartial: false, renderContext: { rawDetails } };
		const ansi = findToolRenderer.renderResult(input, options, uiTheme, args).render(200).join("\n");
		const uris = extractLinkUris(ansi);
		expect(uris).toHaveLength(3);
		expect(uris.every(uri => uri.includes("/repo/%1B%5B1m/src/%1B%5B31mretry.ts"))).toBe(true);
		expect(ansi).not.toContain("\x1b[31mretry.ts");
		expect(ansi).not.toContain("\x1b[1m/src/");

		const native = JSON.stringify(findToolRenderer.describeResult(input, options, args));
		// Windows resolves `/repo` under the current drive (`file:///C:/repo/…`).
		expect(native).toMatch(/file:\/\/\/(?:[A-Za-z]:\/)?repo\/%1B%5B1m\/src\/%1B%5B31mretry\.ts/);
		expect(native).not.toContain("\\u001b");
	});

	it("links omp hits to their doc URL instead of joining them onto cwd", async () => {
		applyHyperlinkSetting("always");
		const uiTheme = (await getThemeByName("dark"))!;
		const ompDetails: FindToolDetails = {
			...details,
			scopePath: "omp://",
			hits: [
				{
					rel: "omp://tools/read.md",
					contentScore: 0.9,
					linesSeen: 40,
					truncated: false,
					ranges: [{ start: 10, end: 20, p: 0.9, snippet: "read docs" }],
				},
			],
		};
		const lines = findToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "" }], details: ompDetails },
				{ expanded: true, isPartial: false },
				uiTheme,
				args,
			)
			.render(200);
		const uris = extractLinkUris(lines.join("\n"));
		expect(uris).toContain("omp://tools/read.md");
		expect(uris).toContain("omp://tools/read.md:10");
		expect(uris.every(uri => !uri.endsWith("/repo/omp://tools/read.md"))).toBe(true);
	});

	it("shows one range per hit collapsed and all ranges plus failures expanded", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const collapsed = sanitizeText(
			findToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, args)
				.render(200)
				.join("\n"),
		);
		const expanded = sanitizeText(
			findToolRenderer
				.renderResult(result, { expanded: true, isPartial: false }, uiTheme, args)
				.render(200)
				.join("\n"),
		);
		expect(collapsed).toContain(":10-20");
		expect(collapsed).not.toContain(":30-40");
		expect(collapsed).not.toContain("verification: boom");
		expect(collapsed).toContain("1/3 requests failed");
		expect(expanded).toContain(":30-40");
		expect(expanded).toContain("const attempts = 3;");
		expect(expanded).not.toContain("\t");
		expect(expanded).toContain("verification: boom");
		expect(expanded).toContain("keywords: retry, budget");
	});

	it("renders the streamed phase while the call is still running", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const partial = findToolRenderer.renderResult(
			{ content: [{ type: "text", text: "verifying 8 passages in 5 files" }] },
			{ expanded: false, isPartial: true, spinnerFrame: 2 },
			uiTheme,
			args,
		);
		const text = sanitizeText(partial.render(200).join("\n"));
		expect(text).toContain('"retry budget"');
		expect(text).toContain("verifying 8 passages in 5 files");
	});
});
