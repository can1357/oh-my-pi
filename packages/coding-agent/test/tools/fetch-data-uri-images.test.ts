import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { mockFetch } from "../helpers/fetch-mock";

const ICON_PATH = "M0 0h32v32H0z ".repeat(40);
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function readPage(html: string) {
	const url = "https://example.com/post";
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "providers.fetch": "local" }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		fetch: mockFetch(input =>
			String(input) === url
				? new Response(html, { headers: { "content-type": "text/html" } })
				: new Response(null, { status: 404 }),
		),
	};
	return fetchReadUrl(session, { path: url });
}

describe("read URL: inline data URI images", () => {
	it("drops base64 payloads from inline <svg> and data: <img> while keeping text and alt", async () => {
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

		const result = await readPage(html);
		expect(result.content).not.toContain("data:");
		expect(result.content).not.toContain(PNG_BASE64);
		expect(result.content).toContain("Benchmark chart");
		expect(result.content).toContain("All posts");
		expect(result.content).toContain("Paragraph 4 holds real article text");
	});

	it("drops payloads with an uppercase scheme or a Markdown title", async () => {
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

		const result = await readPage(html);
		expect(result.content).not.toContain(PNG_BASE64);
		expect(result.content.toLowerCase()).not.toContain("data:");
		expect(result.content).not.toContain("caption");
		expect(result.content).toContain("Upper chart");
		expect(result.content).toContain("Titled chart");
		expect(result.content).toContain("Paragraph 4 holds real article text");
	});
});
