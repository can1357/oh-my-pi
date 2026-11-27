import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { mockFetch } from "../helpers/fetch-mock";

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

describe("read URL: local rendering keeps only the head metadata a reader uses", () => {
	async function readPage(html: string, jinaResponse?: () => Response) {
		const url = "https://example.com/page";
		const readerCalls: string[] = [];
		const cwd = process.cwd();
		const artifactsDir = path.join(cwd, ".fetch-markup-tokens-artifacts");
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async () => ({
				id: "test",
				path: path.join(artifactsDir, `test.log`),
			}),
			settings: Settings.isolated({
				"fetch.enabled": true,
				"providers.fetch": jinaResponse ? "jina" : "local",
				"providers.webKeyless": true,
			}),
			fetch: mockFetch(input => {
				const target = String(input);
				if (target === url) return new Response(html, { headers: { "content-type": "text/html" } });
				if (new URL(target).origin !== new URL(url).origin) readerCalls.push(target);
				if (target.startsWith("https://r.jina.ai/") && jinaResponse) return jinaResponse();
				return new Response(null, { status: 404 });
			}),
		};
		const result = await new ReadTool(session).execute("call", { path: url });
		return {
			text: result.content.find(block => block.type === "text")?.text ?? "",
			method: result.details?.method,
			notes: result.details?.notes ?? [],
			readerCalls,
		};
	}

	it("keeps the title, canonical, description, author and dates and drops social-card and viewport tags", async () => {
		const { text } = await readPage(DOCS_PAGE);

		expect(text).toContain('title: "Renderer guide: when to write <meta name=\\"viewport\\">"');
		expect(text).toMatch(/canonical: "?https:\/\/example.com\/guide"?\n/);
		expect(text).toContain(
			'description: "\\"Setup notes\\": pass name=viewport, or write <meta name=\\"viewport\\">, to the renderer"',
		);
		expect(text).toMatch(/published: "?2026-10-01"?\n/);
		expect(text).toMatch(/author: "?Jane Doe"?\n/);
		const frontMatter = text.slice(0, text.indexOf("# Renderer guide"));
		expect(frontMatter).not.toContain("social-card-renderer-guide.png");
		expect(frontMatter).not.toContain("summary_large_image");
		expect(frontMatter).not.toContain("width=device-width");
		expect(frontMatter).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(frontMatter).not.toContain("ENCODED_NAME");
		expect(frontMatter).not.toContain("TAB_IN_NAME");
		// Metadata-like body text and same-page links are still content.
		expect(text).toContain("meta-og:title: BODY_FRONT_MATTER_LOOKALIKE");
		expect(text).toMatch(/\[Setup\]\((?:https:\/\/example.com\/page)?#setup\)/);
		expect(text).toContain("LAST_NEEDLE");
	});

	it("does not dump arbitrary metadata into rendered content", async () => {
		const tags = Array.from({ length: 30 }, (_, i) => `<meta name="x-${i}" content="PRIVATE_META_${i}">`);
		const { text } = await readPage(
			`<!doctype html><html><head><title>Guide</title>${tags.join("")}</head><body><p>${PROSE}</p></body></html>`,
		);

		expect(text).toContain("This guide explains");
		expect(text).not.toContain("PRIVATE_META_");
	});

	it("keeps a description on a page with no unrelated metadata", async () => {
		const { text } = await readPage(
			`<!doctype html><html><head><title>Guide</title><meta name="description" content="How it works"></head><body><p>${PROSE}</p></body></html>`,
		);

		expect(text).toMatch(/description: "?How it works"?\n/);
	});

	it("does not mistake an article mentioning JavaScript for a wall", async () => {
		const card = "A city guide to every route, stop and timetable, with live arrivals. ".repeat(18);
		const { text, notes, readerCalls } = await readPage(
			`<!doctype html><html><head><title>Transit</title><meta property="og:description" content="${card}"></head><body><p>Please enable JavaScript to use the live map; the timetable below works without it.</p><p>${PROSE.repeat(5)}</p></body></html>`,
		);

		expect(readerCalls).toEqual([]);
		expect(notes.join("; ")).not.toContain("JavaScript");
		expect(text).toContain("the timetable below works without it");
	});

	it("still reads a page whose only content is its head", async () => {
		const { text } = await readPage(HEAD_ONLY_PAGE);

		expect(text).toContain("Manage members, billing and security");
	});

	it("leaves a page without front matter as it came", async () => {
		const { text } = await readPage(RULED_PAGE);

		expect(text).toContain("meta-viewport: KEPT_AS_BODY_TEXT");
		expect(text).not.toMatch(/\n---\n(?:title|description|author|published|canonical):/);
	});

	it("leaves another reader's output as it came", async () => {
		const markdown = `---\nlicense: Do not redistribute\nmeta-og:title: Example\n---\n\n# Example\n\n${PROSE}`;
		const { text, method } = await readPage(DOCS_PAGE, () => new Response(`Markdown Content:\n${markdown}`));

		expect(method).toBe("jina");
		// Every read is finalized, which trims the trailing space PROSE ends with.
		expect(text).toContain(markdown.trimEnd());
	});
});
