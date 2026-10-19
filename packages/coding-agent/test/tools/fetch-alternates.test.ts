import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const filler = "Page content that a reader must not silently replace with a site-wide alternate. ".repeat(6);
const html = (title: string, alternate: string) =>
	`<!doctype html><html><head><title>${title}</title>${alternate}</head><body><main><h1>${title}</h1><p>${filler}</p></main></body></html>`;
let server: Bun.Server<undefined>;
let origin: string;

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const feedLink = `<link rel="alternate" type="application/rss+xml" href="${origin}/blog/rss.xml">`;
			const markdownLink =
				'<link rel="alternate" type="text/markdown" href="/llms.txt"><link rel="alternate" type="text/markdown" href="/llms.md">';
			switch (pathname) {
				case "/":
					return new Response(html("HOMEPAGE_BODY", feedLink), { headers: { "content-type": "text/html" } });
				case "/about":
					return new Response(html("ABOUT_BODY", feedLink), { headers: { "content-type": "text/html" } });
				case "/pricing/":
					return new Response(html("PRICING_BODY", markdownLink), { headers: { "content-type": "text/html" } });
				case "/guide/":
					return new Response(
						html("GUIDE_BODY", '<link rel="alternate" type="text/markdown" href="/guide/index.txt">'),
						{
							headers: { "content-type": "text/html" },
						},
					);
				case "/guide/index.txt":
					return new Response(`# GUIDE_MARKDOWN\n\n${filler}`, { headers: { "content-type": "text/markdown" } });
				case "/llms.txt":
					return new Response(`# SITE_WIDE_LLMS_TXT\n\n${filler}`, { headers: { "content-type": "text/plain" } });
				case "/llms.md":
					return new Response(`# SITE_WIDE_LLMS_MD\n\n${filler}`, {
						headers: { "content-type": "text/markdown" },
					});
				case "/blog/rss.xml":
					return new Response(
						`<?xml version="1.0"?><rss version="2.0"><channel><title>BLOG</title><item><description>${filler}</description></item></channel></rss>`,
						{
							headers: { "content-type": "application/rss+xml" },
						},
					);
				case "/posts/one":
					return new Response(
						html("POST_BODY", '<link rel="alternate" type="application/rss+xml" href="/posts/one/comments.xml">'),
						{
							headers: { "content-type": "text/html" },
						},
					);
				case "/posts/one/comments.xml":
					return new Response(
						`<?xml version="1.0"?><rss version="2.0"><channel><title>POST_COMMENTS</title><item><description>${filler}</description></item></channel></rss>`,
						{
							headers: { "content-type": "application/rss+xml" },
						},
					);
			}
			return new Response("Not found", { status: 404 });
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated({ "fetch.enabled": true }),
	getSessionFile: () => null,
	getSessionSpawns: () => null,
};

describe("read HTML alternates", () => {
	it("keeps the homepage instead of substituting its site-wide RSS feed", async () => {
		const result = await fetchReadUrl(session, { path: `${origin}/` });
		expect(result.details.method).toBe("native");
		expect(result.content).toContain("HOMEPAGE_BODY");
		expect(result.content).not.toContain("BLOG");
	});

	it("keeps a pricing page instead of substituting site-wide llms.txt", async () => {
		const result = await fetchReadUrl(session, { path: `${origin}/pricing/` });
		expect(result.details.method).toBe("native");
		expect(result.content).toContain("PRICING_BODY");
		expect(result.content).not.toContain("SITE_WIDE_LLMS_TXT");
		expect(result.content).not.toContain("SITE_WIDE_LLMS_MD");
	});

	it("uses a page-specific markdown alternate regardless of filename extension", async () => {
		const result = await fetchReadUrl(session, { path: `${origin}/guide/` });
		expect(result.details.method).toBe("alternate-markdown");
		expect(result.content).toContain("GUIDE_MARKDOWN");
	});

	it("retains a page-specific comments feed", async () => {
		const result = await fetchReadUrl(session, { path: `${origin}/posts/one` });
		expect(result.details.method).toBe("alternate-feed");
		expect(result.details.notes).toContain(`Used feed alternate: ${origin}/posts/one/comments.xml`);
	});
});
