import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";

const ICON_PATH = "M0 0h32v32H0z ".repeat(40);
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("renderHtmlToText: inline data URI images", () => {
	it("drops base64 payloads from inline <svg> and data: <img> while keeping text and alt", async () => {
		const settings = Settings.isolated({ "providers.fetch": "native" });
		const paragraphs = Array.from(
			{ length: 4 },
			(_, i) => `<p>Paragraph ${i + 1} holds real article text that the reader must keep intact for the model.</p>`,
		).join("");
		const html = `<!doctype html><html><body><article>
<a href="/blog/"><svg viewBox="0 0 32 32"><path d="${ICON_PATH}"/></svg>All posts</a>
<h1>Launch post</h1>
<img src="data:image/png;base64,${PNG_BASE64}" alt="Benchmark chart">
${paragraphs}
</article></body></html>`;

		const result = await renderHtmlToText("https://example.com/post", html, 5, settings, undefined, null);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(result.content).not.toContain("data:");
		expect(result.content).not.toContain(PNG_BASE64);
		expect(result.content).toContain("![Benchmark chart]");
		expect(result.content).toContain("All posts");
		expect(result.content).toContain("Paragraph 4 holds real article text");
	});

	it("drops payloads with an uppercase scheme or a Markdown title", async () => {
		const settings = Settings.isolated({ "providers.fetch": "native" });
		const paragraphs = Array.from(
			{ length: 4 },
			(_, i) => `<p>Paragraph ${i + 1} holds real article text that the reader must keep intact for the model.</p>`,
		).join("");
		const html = `<!doctype html><html><body><article>
<h1>Launch post</h1>
<img src="DATA:image/png;base64,${PNG_BASE64}" alt="Upper chart">
<img src="data:image/png;base64,${PNG_BASE64}" alt="Titled chart" title="caption">
${paragraphs}
</article></body></html>`;

		const result = await renderHtmlToText("https://example.com/post", html, 5, settings, undefined, null);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(result.content).not.toContain(PNG_BASE64);
		expect(result.content.toLowerCase()).not.toContain("data:");
		expect(result.content).not.toContain("caption");
		expect(result.content).toContain("![Upper chart]");
		expect(result.content).toContain("![Titled chart]");
		expect(result.content).toContain("Paragraph 4 holds real article text");
	});
});
