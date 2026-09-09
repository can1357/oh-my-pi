import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderSearchResult, type SearchRenderDetails } from "@oh-my-pi/pi-coding-agent/web/search/render";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const ANSWER = [
	"## Overview Heading",
	"This is the **first** paragraph with bold text.",
	"",
	"Para two line here.",
	"Para three line here.",
	"Para four line here.",
	"Para five line here.",
	"Para six line here.",
	"Para seven line here.",
	"Para eight line here.",
	"The FINAL_UNIQUE_MARKER paragraph at the very end.",
].join("\n");

function buildResult(answer: string): {
	content: Array<{ type: string; text?: string }>;
	details: SearchRenderDetails;
} {
	const response: SearchResponse = {
		provider: "perplexity",
		answer,
		sources: [
			{ title: "Src One", url: "https://example.com/a", snippet: "snip a" },
			{ title: "Src Two", url: "https://example.com/b", snippet: "snip b" },
		],
	};
	return { content: [{ type: "text", text: answer }], details: { response } };
}

/** Slice the sanitized lines belonging to the framed "Answer" section. */
function answerSection(lines: string[]): string {
	const start = lines.findIndex(l => / Answer /.test(l));
	const end = lines.findIndex((l, i) => i > start && / Sources /.test(l));
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

describe("renderSearchResult", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the answer as markdown (strips ## and ** markers)", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// Heading hashes and bold asterisks are consumed by the markdown renderer.
		expect(answer).not.toContain("##");
		expect(answer).not.toContain("**");
		// The text content survives.
		expect(answer.toLowerCase()).toContain("overview heading");
		expect(answer).toContain("first");
	});

	it("shows the full answer when expanded — no answer truncation summary", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: true, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// The final paragraph is present and there is no "… N more lines" cap inside the Answer section.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("shows the full answer when collapsed by default", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));
		// TUI collapsed view keeps the answer intact; only explicit compact mode caps it.
		expect(answer).toContain("FINAL_UNIQUE_MARKER");
		expect(answer).not.toMatch(/more line/);
	});

	it("truncates the answer only when compact mode provides maxAnswerLines", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const component = renderSearchResult(buildResult(ANSWER), { expanded: false, isPartial: false }, uiTheme, {
			query: "test query",
			maxAnswerLines: 3,
		});
		const answer = answerSection(component.render(120).map(l => sanitizeText(l)));

		expect(answer).toMatch(/more line/);
		expect(answer).not.toContain("FINAL_UNIQUE_MARKER");
	});
});
