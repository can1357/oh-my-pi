import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { mockFetch } from "../helpers/fetch-mock";

const PARAMETERS = Array.from(
	{ length: 12 },
	(_, i) => `<tr><td><code>option_${i}</code></td><td>int</td><td>${i}</td></tr>`,
).join("");
const DOCS_PAGE = `<!doctype html><html><head><title>run() reference</title></head><body>
<nav><a href="/">Home</a><a href="/api">API</a></nav>
<main><h1>run()</h1><p>Runs one fixture and returns its result, raising on the first failed check.</p>
<h2>Parameters</h2><table><thead><tr><th>Name</th><th>Type</th><th>Default</th></tr></thead><tbody>${PARAMETERS}</tbody></table>
<h2>Example</h2><pre><code>import harness
r = harness.run("docs")
print(r.ok)
print(r.time)</code></pre>
<h2>Returns</h2><ul><li>ok: bool</li><li>time: float</li><li>log: str</li></ul>
<p>LAST_NEEDLE: the result object is immutable.</p></main></body></html>`;

const REPORT_ITEMS = [
	"Annual report",
	"Fiscal year 2025",
	"Published March 2026",
	"48 pages",
	"English",
	"Financial statements",
	"Audited",
	"Reviewed by the board",
	"Public edition",
	"Print-ready",
	"Version 2",
	"Indexed",
]
	.map(item => `<li>${item}</li>`)
	.join("");
const WRAPPER_PAGE = `<!doctype html><html><head><title>Annual report</title></head><body><main>
<h1>Annual report 2025</h1><ul>${REPORT_ITEMS}</ul>
<p><a href="/report.pdf">Download PDF</a></p></main></body></html>`;

function htmlResponse(html: string): Response {
	return new Response(html, { headers: { "content-type": "text/html" } });
}

function readPage(pages: Record<string, () => Response>) {
	const requests: string[] = [];
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "providers.fetch": "local" }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		fetch: mockFetch(input => {
			const url = new URL(String(input));
			requests.push(url.href);
			return pages[url.pathname]?.() ?? new Response(null, { status: 404 });
		}),
	};
	return { requests, result: fetchReadUrl(session, { path: "https://example.com/page" }) };
}

describe("read URL: short-line documentation and linked documents", () => {
	afterEach(() => vi.restoreAllMocks());

	it("keeps a short-line API reference instead of treating it as navigation", async () => {
		const { requests, result } = readPage({ "/page": () => htmlResponse(DOCS_PAGE) });
		const page = await result;

		expect(page.content).toContain("option_11");
		expect(page.content).toContain("LAST_NEEDLE");
		expect(page.details.notes.join("\n")).not.toContain("mostly navigation");
		expect(requests.every(url => new URL(url).origin === "https://example.com")).toBe(true);
	});

	it("reads the document a short wrapper page links to", async () => {
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: true,
			content: `# Annual report 2025\n\n${"DOCUMENT_ONLY_MARKER revenue and costs by segment. ".repeat(20)}`,
		});
		const { result } = readPage({
			"/page": () => htmlResponse(WRAPPER_PAGE),
			"/report.pdf": () => new Response("%PDF-1.4 stub", { headers: { "content-type": "application/pdf" } }),
		});

		expect((await result).content).toContain("DOCUMENT_ONLY_MARKER");
	});

	it("keeps the page when only its footer links a document", async () => {
		const page = DOCS_PAGE.replace(
			"</main>",
			'</main><footer><a href="/legal/terms.pdf">Terms of service</a></footer>',
		);
		const { requests, result } = readPage({
			"/page": () => htmlResponse(page),
			"/legal/terms.pdf": () => new Response("%PDF-1.4 stub", { headers: { "content-type": "application/pdf" } }),
		});

		expect((await result).content).toContain("LAST_NEEDLE");
		expect(requests).not.toContain("https://example.com/legal/terms.pdf");
	});
});
