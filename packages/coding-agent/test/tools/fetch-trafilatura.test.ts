import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { mockFetch } from "../helpers/fetch-mock";

const ARTICLE = `<article>
<h1>Estuary monitoring</h1>
<p>Scientists tracked coastal currents by measuring the changing salinity of the estuary every six hours.</p>
<div class="post-comments"><p>Unrelated reader comments should not become part of the article.</p></div>
<ul><li><a href="/">Home</a></li><li><a href="/shop">Shop</a></li><li><a href="/contact">Contact</a></li></ul>
<p>During the dry season the monitoring stations still detected <em>freshwater</em> flowing seaward below the surface.</p>
</article>`;

function readArticle(html: string) {
	const url = "https://example.test/estuary";
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

describe("local article selection", () => {
	it("renders the article without unrelated comment blocks or link lists", async () => {
		const { content } = await readArticle(ARTICLE);

		expect(content).toContain("# Estuary monitoring");
		expect(content).toContain("changing salinity");
		expect(content).toContain("*freshwater*");
		expect(content).not.toMatch(/Unrelated reader comments|\[Shop\]/);
	});

	it("keeps the article when a separate widget requires JavaScript", async () => {
		const html = `<div><p>Please enable JavaScript to load the interactive tide chart.</p></div>${ARTICLE}`;
		const { content } = await readArticle(html);

		expect(content).toContain("changing salinity");
		expect(content).not.toContain("interactive tide chart");
	});

	it("keeps useful context when the main outline alone is too short", async () => {
		const supplementary =
			"This plain text outside the article frame is useful context for a reader when the article itself is only a short outline.";
		const { content } = await readArticle(`<main><p>Tiny outline.</p></main><div>${supplementary}</div>`);

		expect(content).toContain(supplementary);
	});
});
