import { describe, expect, it } from "bun:test";
import { parseHTML } from "../src/dom";
import type { ReadabilityDocument } from "../src/readability";
import { isProbablyReaderable, Readability } from "../src/readability";

type Golden = {
	title: string | null;
	byline: string | null;
	excerpt: string | null;
	siteName: string | null;
	publishedTime: string | null;
	lang: string | null;
	textContent: string;
	content: string;
};

const fixtureDirectory = `${import.meta.dir}/fixtures/readability`;

async function fixture(name: string): Promise<{ html: string; expected: Golden | null }> {
	const [html, expected] = await Promise.all([
		Bun.file(`${fixtureDirectory}/${name}.html`).text(),
		Bun.file(`${fixtureDirectory}/${name}.expected.json`).json() as Promise<Golden | null>,
	]);
	return { html, expected };
}

function extract(html: string): Golden | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as ReadabilityDocument).parse();
	if (!article) return null;
	return {
		title: article.title ?? null,
		byline: article.byline ?? null,
		excerpt: article.excerpt ?? null,
		siteName: article.siteName ?? null,
		publishedTime: article.publishedTime ?? null,
		lang: article.lang ?? null,
		textContent: article.textContent?.replace(/\s+/g, " ").trim() ?? "",
		content: article.content ?? "",
	};
}

describe("Readability", () => {
	for (const [name, label] of [
		["news", "extracts a metadata-rich news article"],
		["blog", "extracts JSON-LD metadata and blog prose"],
		["docs", "extracts a structured documentation page"],
		["low-content", "rejects a page without readable text"],
	] as const) {
		it(label, async () => {
			const { html, expected } = await fixture(name);
			expect(extract(html)).toEqual(expected);
		});
	}

	it("honors class preservation and a custom serializer", () => {
		const { document } = parseHTML(
			"<html><head><title>Serializer contract for articles</title></head><body><article class='story keep'><p>" +
				"A sufficiently detailed paragraph, with several clauses, demonstrates extraction while retaining a requested class name for callers. ".repeat(
					6,
				) +
				"</p></article></body></html>",
		);
		const result = new Readability(document as unknown as ReadabilityDocument, {
			charThreshold: 100,
			keepClasses: true,
			serializer: node => {
				if (!("innerHTML" in node) || typeof node.innerHTML !== "string")
					throw new Error("Expected an article element");
				return { html: node.innerHTML };
			},
		}).parse();
		expect(result?.content).not.toBeNull();
		expect(result!.content!.html).toContain('class="story keep"');
	});

	it("provides the inexpensive readerability heuristic", () => {
		const { document } = parseHTML(
			`<article><p>${"Meaningful prose about a measured system and its operational behavior. ".repeat(8)}</p></article>`,
		);
		expect(isProbablyReaderable(document as unknown as ReadabilityDocument)).toBe(true);
	});
});
