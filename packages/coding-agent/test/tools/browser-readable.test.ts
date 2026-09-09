import { describe, expect, it } from "bun:test";
import { extractReadableFromHtml } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("browser readable extraction", () => {
	it("extracts markdown content from article-style pages", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Docs</title></head>
				<body>
					<article>
						<h1>Responses API</h1>
						<p>The Responses API stores output only when you opt in.</p>
					</article>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/docs", "markdown");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Docs");
		expect(result?.markdown).toContain("Responses API");
		expect(result?.markdown).toContain("stores output only when you opt in");
	});

	it("extracts docs-style main content", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Reference</title></head>
				<body>
					<div class="app-shell">
						<nav>Navigation</nav>
						<main data-pagefind-body>
							<section>
								<h1>Apps SDK</h1>
								<p>Build once, run in many places.</p>
							</section>
						</main>
					</div>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://developers.openai.com/apps-sdk/reference", "text");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Reference");
		expect(result?.text).toContain("Apps SDK");
		expect(result?.text).toContain("Build once, run in many places");
	});
});
