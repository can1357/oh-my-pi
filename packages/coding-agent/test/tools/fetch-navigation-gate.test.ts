import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { mockFetch } from "../helpers/fetch-mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";

// An API reference page: its markdown is mostly short lines (table rows, code, list items), none of them navigation.
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

// A landing page around a PDF: a few short metadata lines and the download link.
const REPORT_ITEMS = ["Annual report", "Fiscal year 2025", "Published March 2026", "48 pages", "English"]
	.map(item => `<li>${item}</li>`)
	.join("");
const WRAPPER_PAGE = `<!doctype html><html><head><title>Annual report</title></head><body><main>
<h1>Annual report 2025</h1><ul>${REPORT_ITEMS}${REPORT_ITEMS}</ul>
<p><a href="/report.pdf">Download PDF</a></p></main></body></html>`;
describe("read URL: a reader's short-line markdown is not taken for navigation", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	function stubFallbacks() {
		const ensureTool = vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		const remote = vi.fn(() => new Response("unavailable", { status: 503 }));
		return { ensureTool, remote, fetch: mockFetch(remote) };
	}

	it("keeps the native rendering of an API reference page without trying other readers", async () => {
		const { ensureTool, remote, fetch } = stubFallbacks();

		const result = await renderHtmlToText(
			"https://docs.example.com/run",
			DOCS_PAGE,
			5,
			Settings.isolated(),
			undefined,
			null,
			fetch,
		);

		expect(result.method).toBe("native");
		expect(result.content).toContain("option_11");
		expect(result.content).toContain("LAST_NEEDLE");
		expect(ensureTool).not.toHaveBeenCalled();
		expect(remote).not.toHaveBeenCalled();
	});

	async function readLocal(pages: Record<string, () => Response>) {
		const { fetch } = stubFallbacks();
		const server = Bun.serve({
			port: 0,
			fetch: request => pages[new URL(request.url).pathname]?.() ?? new Response("not found", { status: 404 }),
		});
		servers.push(server);
		const cwd = process.cwd();
		const artifactsDir = path.join(cwd, ".fetch-navigation-gate-artifacts");
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => ({
				id: "test",
				path: path.join(artifactsDir, `test.${toolType}.log`),
			}),
			settings: Settings.isolated({ "fetch.enabled": true }),
			fetch,
		};
		const result = await new ReadTool(session).execute("call", { path: `http://127.0.0.1:${server.port}/page` });
		return { method: result.details?.method, text: result.content.find(block => block.type === "text")?.text ?? "" };
	}

	it("reads the page without the 'mostly navigation' note", async () => {
		const { method, text } = await readLocal({
			"/page": () => new Response(DOCS_PAGE, { headers: { "content-type": "text/html" } }),
		});

		expect(method).toBe("native");
		expect(text).toContain("LAST_NEEDLE");
		expect(text).not.toContain("mostly navigation");
	});

	it("still reads the document a short wrapper page links to", async () => {
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: true,
			content: `# Annual report 2025\n\n${"DOCUMENT_ONLY_MARKER revenue and costs by segment. ".repeat(20)}`,
		});

		const { method, text } = await readLocal({
			"/page": () => new Response(WRAPPER_PAGE, { headers: { "content-type": "text/html" } }),
			"/report.pdf": () => new Response("%PDF-1.4 stub", { headers: { "content-type": "application/pdf" } }),
		});

		expect(method).toBe("extracted-document");
		expect(text).toContain("DOCUMENT_ONLY_MARKER");
	});

	it("keeps the page when only its footer links a document", async () => {
		const convert = vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			ok: true,
			content: `# Terms of service\n\n${"TERMS_ONLY_MARKER you agree to these terms. ".repeat(60)}`,
		});
		const page = DOCS_PAGE.replace(
			"</main>",
			'</main><footer><a href="/legal/terms.pdf">Terms of service</a></footer>',
		);

		const { method, text } = await readLocal({
			"/page": () => new Response(page, { headers: { "content-type": "text/html" } }),
			"/legal/terms.pdf": () => new Response("%PDF-1.4 stub", { headers: { "content-type": "application/pdf" } }),
		});

		expect(method).toBe("native");
		expect(text).toContain("LAST_NEEDLE");
		expect(text).not.toContain("TERMS_ONLY_MARKER");
		expect(convert).not.toHaveBeenCalled();
	});
});
