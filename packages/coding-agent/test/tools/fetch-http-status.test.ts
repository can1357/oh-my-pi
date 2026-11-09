import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { mockFetch } from "../helpers/fetch-mock";

function makeSession(fetch?: FetchImpl): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-http-status-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
		fetch,
	};
}

describe("read URL HTTP status without a body", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	it("reports a bodyless 204 as a successful empty read, not a failed fetch", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 204, headers: { "content-type": "text/html" } }),
		});
		servers.push(server);
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/healthz`,
		});
		const text = result.content.find(block => block.type === "text")?.text;

		expect(result.details?.method).not.toBe("failed");
		expect(text).toContain("HTTP 204 No Content");
		expect(text).not.toContain("Failed to fetch URL");
	});

	it("reports a bodyless 503 as a failed fetch", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
		servers.push(server);
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/healthz`,
		});
		const text = result.content.find(block => block.type === "text")?.text;

		expect(result.details?.method).toBe("failed");
		expect(text).toContain("Failed to fetch URL (HTTP 503)");
	});
});

// Reddit answers a logged-out fetch of a post with this form, which a browser submits from script.
const REDDIT_CHALLENGE = `<!DOCTYPE html><html><head><title>Reddit</title></head><body>
<form hidden method="GET" action="/r/LocalLLaMA/comments/1j9qhvi/">
<input type="hidden" name="solution" /><input type="hidden" name="js_challenge" value="1"/>
</form></body></html>`;

const POST_MARKDOWN = `# Software 2.0\n\n${"Neural networks are not just another classifier; they change how software is written. ".repeat(4)}`;

describe("read URL answered by a bot wall", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	async function read(wall: (request: Request) => Response, readerBody: string, raw?: true) {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		const server = Bun.serve({ port: 0, fetch: wall });
		servers.push(server);
		const remoteCalls: string[] = [];
		const remote = mockFetch(input => {
			remoteCalls.push(String(input));
			return String(input).startsWith("https://r.jina.ai/")
				? new Response(readerBody)
				: new Response("unavailable", { status: 503 });
		});
		const result = await new ReadTool(makeSession(remote)).execute("call", {
			path: `http://127.0.0.1:${server.port}/post${raw ? ":raw" : ""}`,
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return {
			method: result.details?.method,
			finalUrl: result.details?.finalUrl,
			notes: result.details?.notes?.join("\n") ?? "",
			text,
			remoteCalls,
		};
	}

	// The post's old URL redirects to its canonical one, which serves the challenge.
	const challenge = (request: Request) =>
		new URL(request.url).pathname === "/post"
			? Response.redirect(new URL("/canonical", request.url).href, 301)
			: new Response(REDDIT_CHALLENGE, { headers: { "content-type": "text/html" } });

	it.each([
		{
			reader: "the post",
			body: `Title: Software 2.0\n\nMarkdown Content:\n${POST_MARKDOWN}`,
			method: "jina",
			note: "read through jina",
		},
		{
			reader: "its own block page",
			body: "Title: \n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.\n\nTo continue, log in to your Reddit account or use your developer token",
			method: "blocked",
			note: "JavaScript challenge, HTTP 200",
		},
		{
			reader: "the block page with no warning",
			body: "Title: Reddit\n\nMarkdown Content:\nYou've been blocked by network security.\n\nTo continue, log in to your Reddit account or use your developer token",
			method: "blocked",
			note: "JavaScript challenge, HTTP 200",
		},
		{
			// Over the 1024 characters the generic JavaScript-gate check looks at.
			reader: "a long JavaScript gate",
			body: `Title: Just a moment...\n\nMarkdown Content:\nJust a moment...\n\nTurn on JavaScript and cookies to continue\n\n${"www.reddit.com needs to review the security of your connection before proceeding. ".repeat(14)}`,
			method: "blocked",
			note: "JavaScript challenge, HTTP 200",
		},
	])("ends a 200 challenge read as $method when the remote reader gets $reader", async ({ body, method, note }) => {
		const result = await read(challenge, body);

		expect(result.method).toBe(method);
		expect(result.notes).toContain(note);
		if (method === "jina") {
			expect(result.text).toContain("Neural networks are not just another classifier");
			expect(result.finalUrl).toEndWith("/canonical");
			expect(result.remoteCalls[0]).toEndWith("/canonical");
		} else {
			expect(result.text).not.toMatch(/blocked by network security|(Enable|Turn on) JavaScript/);
			expect(result.notes).toContain("the browser tool");
		}
	});

	it("returns the challenge body as fetched for :raw", async () => {
		const result = await read(challenge, `Markdown Content:\n${POST_MARKDOWN}`, true);

		expect(result.method).toBe("raw");
		expect(result.text).toContain('name="js_challenge"');
		expect(result.remoteCalls).toEqual([]);
	});

	it.each([
		"<input type=hidden name='js_challenge'>",
		'<input type="hidden" name = "js_challenge">',
		"<INPUT TYPE=hidden NAME=js_challenge>",
		'<input type="hidden" name="js&#95;challenge">',
	])("treats %s as a challenge form", async form => {
		const result = await read(
			() =>
				new Response(`<html><body><form>${form}</form></body></html>`, {
					headers: { "content-type": "text/html" },
				}),
			`Markdown Content:\n${POST_MARKDOWN}`,
		);

		expect(result.method).toBe("jina");
		expect(result.notes).toContain("JavaScript challenge, HTTP 200");
	});

	it("names the bot wall on a 403 challenge without sending the URL to a remote reader", async () => {
		const result = await read(
			() =>
				new Response("<html><head><title>Just a moment...</title></head><body></body></html>", {
					status: 403,
					headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
				}),
			`Markdown Content:\n${POST_MARKDOWN}`,
		);

		expect(result.method).toBe("failed");
		expect(result.notes).toContain("Blocked by bot protection (Cloudflare)");
		expect(result.notes).not.toContain("browser tool");
		expect(result.remoteCalls).toEqual([]);
	});

	it("reads an article that quotes challenge markers in its text", async () => {
		const article = `<html><head><title>Detecting bot walls</title></head><body><article><h1>Detecting bot walls</h1>
<p>${"A challenge page carries markers that a scraper can recognise before it renders anything. ".repeat(4)}</p>
<div data-example='> <input type="hidden" name="js_challenge">'></div>
<pre>window._cf_chl_opt={cType:'managed'}; &lt;input type="hidden" name="js_challenge"&gt; id="px-captcha" geo.captcha-delivery.com</pre>
<!-- <input type="hidden" name="js_challenge"> -->
<script>const sample = '</scripture><input type="hidden" name="js_challenge">';</script>
<textarea><input type="hidden" name="js_challenge"></textarea>
<xmp><input type="hidden" name="js_challenge"></xmp>
<input-example name="js_challenge"></input-example>
<input type="hidden" data-name="js_challenge">
<div data-example='<input type="hidden" name="js_challenge">'></div>
</article></body></html>`;
		const result = await read(
			() => new Response(article, { headers: { "content-type": "text/html" } }),
			`Markdown Content:\n${POST_MARKDOWN}`,
		);

		expect(result.method).toBe("native");
		expect(result.text).toContain("A challenge page carries markers");
	});
});
