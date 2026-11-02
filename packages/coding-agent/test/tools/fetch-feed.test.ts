import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function makeSession(): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-feed-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Fluxer blog</title><link>https://example.test/</link><description>Channel</description>
<item><title>Mobile clients &amp; v2</title><link>https://example.test/rss-item</link><description><![CDATA[<p>Open source <b>mobile</b> apps.</p>]]></description><pubDate>Mon, 15 Jun 2026 12:00:00 +0000</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom title</title>
<entry><title>First entry</title><link href="https://example.test/atom-entry"/><updated>2026-06-15T12:00:00Z</updated><summary>Entry summary</summary></entry>
<entry><title>Second entry</title><content>Entry content</content></entry>
</feed>`;

describe("read URL RSS/Atom feeds (#15954)", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	async function readFeed(body: string, contentType: string): Promise<string | undefined> {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(body, { headers: { "content-type": contentType } }),
		});
		servers.push(server);
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/feed.xml`,
		});
		expect(result.details?.method).toBe("feed");
		return result.content.find(block => block.type === "text")?.text;
	}

	it("renders RSS channel title, item title, date, description text, and <link> body", async () => {
		const text = await readFeed(RSS, "application/rss+xml");

		expect(text).toContain("# Fluxer blog\n");
		expect(text).toContain("## Mobile clients & v2\n*Mon, 15 Jun 2026 12:00:00 +0000*\n\nOpen source mobile apps.\n");
		expect(text).toContain("[Read more](https://example.test/rss-item)");
		expect(text).not.toContain("Untitled");
	});

	it("renders Atom feed title, entry dates, and summary with content fallback", async () => {
		const text = await readFeed(ATOM, "application/atom+xml");

		expect(text).toContain("# Atom title\n");
		expect(text).toContain(
			"## First entry\n*2026-06-15T12:00:00Z*\n\nEntry summary\n\n[Read more](https://example.test/atom-entry)",
		);
		expect(text).toContain("## Second entry\nEntry content\n");
		expect(text).not.toContain("Untitled");
	});
});
