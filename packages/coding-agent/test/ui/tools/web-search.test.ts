import { expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/tools/web-search";
import { type WebSearchResponse, webSearchPresenter } from "../../../src/ui/tools/web-search";
import { bodyNodes, toolNode, toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("web_search", "web_search", webSearchPresenter);

const URL = "https://example.com/docs";
const EXCERPT = ["First finding", "Deuxième résultat", "3"];
const RESPONSE: WebSearchResponse = {
	provider: "exa",
	searchQueries: ["reference documentation"],
	sources: [
		{
			url: URL,
			publishedDate: "2025-07-24",
			snippet: "``` \nFirst\t  finding\n---\n\x1b[31mDeuxième résultat\x1b[0m\n3\nFourth finding",
		},
	],
};

function searchCard(
	response: WebSearchResponse,
	{ expanded = false, text = "Model-facing listing" }: { expanded?: boolean; text?: string } = {},
) {
	const state = { expanded, isPartial: false, argsComplete: true, executionStarted: true };
	const view = webSearchPresenter.result?.({ content: [{ type: "text", text }], details: { response } }, state);
	return toolNode("web_search", view, bodyNodes(view?.body), "done", state);
}

test("a source card sends a muted excerpt to the native host only without a synthesized answer", () => {
	createRoot(dispose => {
		try {
			const env = staticEnvironment(currentTheme());
			const tree = describeTree(searchCard(RESPONSE), env);
			expect(tree).toMatchObject({
				p: { target: "reference documentation" },
				c: [
					{
						k: "col",
						p: { role: "omp.tool.sources" },
						c: [
							{
								k: "row",
								p: { role: "omp.tool.source", href: URL },
								c: [
									{ k: "badge" },
									{ k: "text", p: { spans: [{ t: URL, s: "link", href: URL }] } },
									{ k: "text", p: { spans: [{ t: "example.com · 2025-07-24", s: "muted" }] } },
									{
										k: "text",
										p: {
											role: "omp.tool.excerpt",
											wrap: "word",
											lines: 3,
											spans: [{ t: EXCERPT.join("\n"), s: "muted" }],
										},
									},
								],
							},
						],
					},
				],
			});
			const answered = describeTree(searchCard({ ...RESPONSE, answer: "Synthesized answer" }), env);
			expect(answered).toMatchObject({
				c: [{ k: "md" }, { c: [{ c: [{ k: "badge" }, { k: "text" }, { k: "text" }] }] }],
			});
		} finally {
			dispose();
		}
	});
});

test("the native tool warns on no sources, not on the absence of an answer", () => {
	createRoot(dispose => {
		try {
			const env = staticEnvironment(currentTheme());
			expect(describeTree(searchCard(RESPONSE), env)).not.toHaveProperty("p.tone");
			expect(describeTree(searchCard({ ...RESPONSE, sources: [] }), env)).toHaveProperty("p.tone", "warning");
		} finally {
			dispose();
		}
	});
});

test("the terminal expands source excerpts and reveals sources beyond the collapsed preview", () => {
	createRoot(dispose => {
		try {
			const env = staticEnvironment(currentTheme());
			const response: WebSearchResponse = {
				...RESPONSE,
				sources: [
					...(RESPONSE.sources ?? []),
					...Array.from({ length: 8 }, (_, i) => ({ title: `Source ${i + 2}` })),
				],
			};
			const collapsed = paintNode(env, searchCard(response), 100).rows.map(row => Bun.stripANSI(row));
			const expanded = paintNode(env, searchCard(response, { expanded: true }), 100).rows.map(row =>
				Bun.stripANSI(row),
			);
			expect(collapsed.some(row => row.includes("Answer") || row.includes("Model-facing listing"))).toBe(false);
			expect(collapsed.some(row => row.includes("1 more source"))).toBe(true);
			expect(collapsed.some(row => row.includes("Source 9"))).toBe(false);
			expect(expanded.some(row => row.includes("Source 9"))).toBe(true);
			const sourceRow = collapsed.findIndex(row => row.includes(URL));
			expect(sourceRow).toBeGreaterThanOrEqual(0);
			expect(collapsed[sourceRow + 1]).toContain(EXCERPT[0]!);
			expect(collapsed[sourceRow + 2]).toContain("Source 2");
			EXCERPT.forEach((line, i) => {
				expect(expanded[sourceRow + 1 + i]).toContain(line);
			});
			expect(expanded[sourceRow + 4]).toContain("Source 2");
		} finally {
			dispose();
		}
	});
});

test("the terminal caps the raw fallback to three lines when there are no sources or synthesized answer", () => {
	createRoot(dispose => {
		try {
			const env = staticEnvironment(currentTheme());
			const response = { provider: "exa", sources: [] };
			const text = "Result one\n\nResult two\nResult three\nResult four";
			const collapsed = paintNode(env, searchCard(response, { text }), 100).rows.join("\n");
			const expanded = paintNode(env, searchCard(response, { text, expanded: true }), 100).rows.join("\n");
			expect(collapsed).toContain("Result three");
			expect(collapsed).toContain("1 more line");
			expect(collapsed).not.toContain("Result four");
			expect(expanded).toContain("Result four");
		} finally {
			dispose();
		}
	});
});
