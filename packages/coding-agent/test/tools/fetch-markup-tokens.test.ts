import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const PROSE = "This guide explains how the renderer handles every input it receives in one pass. ".repeat(3);

const DOCS_PAGE = `<!doctype html><html><head>
<title>Renderer guide: when to write <meta name="viewport"></title>
<meta charset="utf-8">
<link rel="canonical" href="https://example.com/guide">
<meta content='"Setup notes": pass name=viewport, or write <meta name="viewport">, to the renderer' name="Description">
<meta content="2026-10-01" property="article:published_time">
<meta name="author" content="Jane Doe">
<meta name="auth&#111;r" content="ENCODED_NAME">
<meta name="descrip\tion" content="TAB_IN_NAME">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Renderer guide > Example Docs">
<meta property="og:image" content="https://example.com/images/social-card-renderer-guide.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="tracking: id" content="abcdefghijklmnopqrstuvwxyz0123456789">
<meta name="google-site-verification" content="abcdefghijklmnopqrstuvwxyz0123456789">
</head><body><main>
<h1>Renderer guide</h1>
<p>---
meta-og:title: BODY_FRONT_MATTER_LOOKALIKE
---</p>
<p>Contents: <a href="#setup">Setup</a>. ${PROSE}</p>
<h2 id="setup">Setup</h2><p>LAST_NEEDLE ${PROSE}</p>
</main></body></html>`;

const HEAD_ONLY_PAGE = `<!doctype html><html><head><title>Account</title>
<meta property="og:title" content="Account settings for your workspace">
<meta property="og:description" content="Manage members, billing and security for the workspace">
</head><body><div id="root"></div></body></html>`;

/** No head metadata, so no front matter: the body opens with a rule and a line shaped like a meta key. */
const RULED_PAGE = `<!doctype html><html><body>
<hr><p>meta-viewport: KEPT_AS_BODY_TEXT</p><hr>
<p>${PROSE}</p>
</body></html>`;

describe("read URL: native rendering keeps only the head metadata a reader uses", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	async function readPage(
		html: string,
		{
			selector = "",
			method = "native",
			provider = "auto",
			reader = () => new Response("offline", { status: 503 }),
		}: { selector?: string; method?: string; provider?: string; reader?: () => Response } = {},
	): Promise<{ text: string; notes: string[]; readerCalls: string[] }> {
		const server = Bun.serve({
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/page"
					? new Response(html, { headers: { "content-type": "text/html" } })
					: new Response("not found", { status: 404 }),
		});
		servers.push(server);
		const readerCalls: string[] = [];
		const cwd = process.cwd();
		const artifactsDir = path.join(cwd, ".fetch-markup-tokens-artifacts");
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
			settings: Settings.isolated({ "fetch.enabled": true, "providers.fetch": provider }),
			// Remote readers (Jina and the like) answer through here.
			fetch: async input => {
				readerCalls.push(String(input instanceof Request ? input.url : input));
				return reader();
			},
		};
		const result = await new ReadTool(session).execute("call", {
			path: `http://127.0.0.1:${server.port}/page${selector}`,
		});
		expect(result.details?.method).toBe(method);
		return {
			text: result.content.find(block => block.type === "text")?.text ?? "",
			notes: result.details?.notes ?? [],
			readerCalls,
		};
	}

	it("keeps the title, canonical, description, author and dates and drops social-card and viewport tags", async () => {
		const { text } = await readPage(DOCS_PAGE);

		expect(text).toContain('title: "Renderer guide: when to write <meta name=\\"viewport\\">"');
		expect(text).toContain("canonical: https://example.com/guide");
		// A quoted value keeps its escapes, and the name matches in any letter case.
		expect(text).toContain(
			'meta-Description: "\\"Setup notes\\": pass name=viewport, or write <meta name=\\"viewport\\">, to the renderer"',
		);
		expect(text).toContain('meta-article:published_time: "2026-10-01"');
		expect(text).toContain("meta-author: Jane Doe");
		const frontMatter = text.slice(0, text.indexOf("# Renderer guide"));
		expect(frontMatter).not.toContain("meta-og");
		expect(frontMatter).not.toContain("meta-twitter");
		expect(frontMatter).not.toContain("meta-viewport");
		expect(frontMatter).not.toContain("meta-tracking");
		expect(frontMatter).not.toContain("meta-google-site-verification");
		// A name is matched as written: an escaped character in it is no letter of a kept name.
		expect(frontMatter).not.toContain("ENCODED_NAME");
		expect(frontMatter).not.toContain("TAB_IN_NAME");
		// The dropped tags are named, with the way to read their values.
		expect(text).toContain(
			'meta_omitted: "auth&#111;r, descrip\\tion, google-site-verification, og:image, og:title, tracking: id, twitter:card, viewport; read the URL with :raw for their values"',
		);
		// The body is left as the converter wrote it, a front-matter lookalike and same-page links included.
		expect(text).toContain("meta-og:title: BODY_FRONT_MATTER_LOOKALIKE");
		expect(text).toContain("[Setup](#setup)");
		expect(text).toContain("LAST_NEEDLE");
	});

	it("names the first 25 dropped tags and counts the rest", async () => {
		const tags = Array.from({ length: 30 }, (_, i) => `<meta name="x-${String(i).padStart(2, "0")}" content="v">`);
		const { text } = await readPage(
			`<!doctype html><html><head><title>Guide</title>${tags.join("")}</head><body><p>${PROSE}</p></body></html>`,
		);
		const listed = Array.from({ length: 25 }, (_, i) => `x-${String(i).padStart(2, "0")}`).join(", ");

		expect(text).toContain(`meta_omitted: "${listed} (+5 more); read the URL with :raw for their values"`);
		expect(text).not.toContain("meta-x-");
	});

	it("adds no omitted-tags line when the page has only tags a reader uses", async () => {
		const { text } = await readPage(
			`<!doctype html><html><head><title>Guide</title><meta name="description" content="How it works"></head><body><p>${PROSE}</p></body></html>`,
		);

		expect(text).toContain("meta-description: How it works");
		expect(text).not.toContain("meta_omitted");
	});

	it("chooses the reader on the whole rendering, before its metadata is pruned", async () => {
		// Whole, the rendering is too long to be a JavaScript wall; pruned, it would not be.
		const card = "A city guide to every route, stop and timetable, with live arrivals. ".repeat(18);
		const { text, notes, readerCalls } = await readPage(
			`<!doctype html><html><head><title>Transit</title><meta property="og:description" content="${card}"></head><body><p>Please enable JavaScript to use the live map; the timetable below works without it.</p><p>${PROSE}</p></body></html>`,
		);

		expect(readerCalls).toEqual([]);
		expect(notes.join("; ")).not.toContain("JavaScript");
		expect(text).toContain('meta_omitted: "og:description; read the URL with :raw for their values"');
		expect(text).toContain("the timetable below works without it");
	});

	it("still reads a page whose only content is its head", async () => {
		const { text } = await readPage(HEAD_ONLY_PAGE);

		expect(text).toContain("Manage members, billing and security");
		expect(text).not.toContain("meta_omitted");
	});

	it("leaves a page without front matter as it came", async () => {
		const { text } = await readPage(RULED_PAGE);

		expect(text).toContain("meta-viewport: KEPT_AS_BODY_TEXT");
		expect(text).not.toContain("meta_omitted");
	});

	it("leaves another reader's output as it came", async () => {
		const markdown = `---\nlicense: Do not redistribute\nmeta-og:title: Example\n---\n\n# Example\n\n${PROSE}`;
		const { text } = await readPage(DOCS_PAGE, {
			method: "jina",
			provider: "jina",
			reader: () => new Response(`Markdown Content:\n${markdown}`),
		});

		expect(text).toContain("license: Do not redistribute");
		expect(text).toContain("meta-og:title: Example");
		expect(text).not.toContain("meta_omitted");
	});
});
