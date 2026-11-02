import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { materializeReadUrlToFile } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const ATOM = `<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>Sample</title><entry><title>One</title><id>1</id><updated>2024-01-01T00:00:00Z</updated><content>body</content></entry></feed>`;
const JSON_BODY = `{"alpha":1,"beta":[2,3]}`;

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function stubLoadPage(body: string, contentType: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: body,
	}));
}

describe("read URL with :raw selector (regression: JSON/feed parsers ignored raw flag)", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-raw-mode-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("returns the raw atom feed body when :raw is set", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		stubLoadPage(ATOM, "application/atom+xml");

		const result = await tool.execute("call", { path: "https://example.com/feed.xml:raw" });
		const textBlock = result.content.find(c => c.type === "text");

		expect(result.details?.method).toBe("raw");
		// The raw response body must round-trip verbatim — not get rewritten to "# Atom Feed".
		expect(textBlock?.text).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
		expect(textBlock?.text).toContain("<entry>");
		expect(textBlock?.text).not.toContain("# Atom Feed");
	});

	it("returns the rendered atom feed when :raw is absent (existing behavior)", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		stubLoadPage(ATOM, "application/atom+xml");

		const result = await tool.execute("call", { path: "https://example.com/feed.xml" });
		expect(result.details?.method).toBe("feed");
	});

	it("returns the raw JSON body when :raw is set", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		stubLoadPage(JSON_BODY, "application/json");

		const result = await tool.execute("call", { path: "https://example.com/api.json:raw" });
		const textBlock = result.content.find(c => c.type === "text");

		expect(result.details?.method).toBe("raw");
		// Body comes back as-is, not pretty-printed.
		expect(textBlock?.text).toContain('{"alpha":1,"beta":[2,3]}');
	});

	it("still pretty-prints JSON when :raw is absent (existing behavior)", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		stubLoadPage(JSON_BODY, "application/json");

		const result = await tool.execute("call", { path: "https://example.com/api.json" });
		const textBlock = result.content.find(c => c.type === "text");

		expect(result.details?.method).toBe("json");
		expect(textBlock?.text).toContain('"alpha": 1');
	});

	it("refetches the same URL on subsequent reads", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		let body = "v1";
		const loadPage = vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));

		const first = await tool.execute("first", { path: "https://example.com/live.txt:raw" });
		body = "v2";
		const second = await tool.execute("second", { path: "https://example.com/live.txt:raw" });
		const firstText = first.content.find(entry => entry.type === "text");
		const secondText = second.content.find(entry => entry.type === "text");

		expect(firstText?.text).toBe("v1");
		expect(secondText?.text).toBe("v2");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("returns slices of raw content when :raw is combined with a range", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const body = Array.from({ length: 20 }, (_, i) => `raw line ${i + 1}`).join("\n");
		stubLoadPage(body, "application/json");

		// `:raw:N-M` must skip JSON pretty-print and slice the response body.
		const result = await tool.execute("call", { path: "https://example.com/api.json:raw:3-5" });
		const text =
			result.content
				.filter(c => c.type === "text")
				.map(c => c.text)
				.join("\n") ?? "";

		expect(result.details?.method).toBe("raw");
		expect(text).toBe("raw line 3\nraw line 4\nraw line 5");
	});

	it("keeps body coordinates when the response adds a Notes header", async () => {
		const session = makeSession(testDir);
		const body = Array.from({ length: 20 }, (_, i) => `raw line ${i + 1}`).join("\n");
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
			truncated: true,
		}));

		const result = await new ReadTool(session).execute("call", { path: "https://example.com/page.txt:12:raw" });
		expect(result.content.find(c => c.type === "text")?.text).toBe("raw line 12");
		expect(result.details?.totalLines).toBe(20);
	});
});

describe("raw URL response bytes", () => {
	let testDir: string;
	const servers: Bun.Server<undefined>[] = [];

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-raw-bytes-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
		removeSyncWithRetries(testDir);
	});

	function serve(body: string, contentType: string): string {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/redirect"
					? Response.redirect(new URL("/body", request.url).href)
					: new Response(body, { headers: { "content-type": contentType } }),
		});
		servers.push(server);
		return `http://127.0.0.1:${server.port}`;
	}

	it.each([
		["application/json", '{"ok":true}\n'],
		["text/plain", " \talpha\r\n\r\n\r\nomega\r\n "],
		["text/html", "<!doctype html>\n<html>\n\n\n<body>raw</body>\n</html>\n"],
	])("returns only the unnormalized %s response body", async (contentType, body) => {
		const origin = serve(body, contentType);
		const result = await new ReadTool(makeSession(testDir)).execute("raw-body", { path: `${origin}/body:raw` });
		const text = result.content.find(c => c.type === "text")?.text;

		expect(text).toBe(body);
		if (contentType === "application/json") expect(JSON.parse(text ?? "")).toEqual({ ok: true });
		expect(result.details).toMatchObject({
			url: `${origin}/body`,
			finalUrl: `${origin}/body`,
			contentType,
			method: "raw",
			notes: [],
		});
	});

	it("slices raw JSON body coordinates in either selector order without trimming the source", async () => {
		const body = '\n{\n  "ok": true\n}\n';
		const origin = serve(body, "application/json");
		const tool = new ReadTool(makeSession(testDir));

		for (const selector of ["raw:2-4", "2-4:raw"]) {
			const result = await tool.execute("raw-json-range", { path: `${origin}/body:${selector}` });
			const text = result.content.find(c => c.type === "text")?.text;
			expect(text).toBe('{\n  "ok": true\n}');
			expect(JSON.parse(text ?? "")).toEqual({ ok: true });
		}
		const open = await tool.execute("raw-json-open", { path: `${origin}/body:raw:2-` });
		expect(open.content.find(c => c.type === "text")?.text).toBe(body.slice(1));
	});

	it("keeps redirect metadata out of a raw JSON body and preserves the normal wrapper", async () => {
		const origin = serve('{"ok":true}\n', "application/json");
		const tool = new ReadTool(makeSession(testDir));
		const raw = await tool.execute("redirect-raw", { path: `${origin}/redirect:raw` });

		expect(raw.content.find(c => c.type === "text")?.text).toBe('{"ok":true}\n');
		expect(raw.details).toMatchObject({ url: `${origin}/redirect`, finalUrl: `${origin}/body` });

		const normal = await tool.execute("redirect-normal", { path: `${origin}/redirect` });
		expect(normal.content.find(c => c.type === "text")?.text).toBe(
			`URL: ${origin}/body\nContent-Type: application/json\nMethod: json\n\n---\n\n{\n  "ok": true\n}`,
		);
	});

	it("keeps repeated raw JSON URL bodies parseable without suppressing the loop diagnostic", async () => {
		const origin = serve('{"ok":true}\n', "application/json");
		const tool = new ReadTool(makeSession(testDir));
		for (let count = 1; count <= 4; count++) {
			const result = await tool.execute("repeat-raw-url", { path: `${origin}/body:raw` });
			const text = result.content.find(c => c.type === "text")?.text;
			expect(text).toBe('{"ok":true}\n');
			expect(JSON.parse(text ?? "")).toEqual({ ok: true });
			if (count >= 3) expect(result.details?.notes?.join("\n")).toContain(`identical output ${count} times`);
		}
	});

	it("stores raw artifacts and search materialization in the same body coordinates as URL ranges", async () => {
		const body = `${Array.from({ length: 320 }, (_, i) => `body ${i + 1}`).join("\n")}\n`;
		const origin = serve(body, "text/plain");
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const preview = await tool.execute("raw-preview", { path: `${origin}/body:raw` });
		const artifactId = preview.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		const artifactPath = path.join(testDir, "session", `${artifactId}.read.log`);
		expect(await Bun.file(artifactPath).text()).toBe(body);

		const materialized = await materializeReadUrlToFile(session, { path: `${origin}/body`, raw: true });
		expect(await Bun.file(materialized.path).text()).toBe(body);
		for (const target of [`${origin}/body`, artifactPath, materialized.path]) {
			const result = await tool.execute("body-coordinates", { path: `${target}:301-302:raw` });
			expect(result.content.find(c => c.type === "text")?.text).toBe("body 301\nbody 302");
		}

		const normal = await tool.execute("normal-coordinates", { path: `${origin}/body:12-12` });
		expect(normal.content.find(c => c.type === "text")?.text).toBe(
			"body 11\nbody 12\nbody 13\nbody 14\nbody 15\n\n[305 more lines in URL output. Use :16 to continue]",
		);
		expect(normal.details?.displayContent?.startLine).toBe(11);
	});
});

describe("read URL with multi-range selector (regression: was stuck on URL → 404)", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-multi-range-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("routes :A-B,C-D to the multi-range builder against the cached body", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const body = Array.from({ length: 40 }, (_, i) => `content ${i + 1}`).join("\n");
		const loadSpy = stubLoadPage(body, "text/plain");

		const result = await tool.execute("call", { path: "https://example.com/file.txt:11-13,26-28" });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).toContain("content 11");
		expect(text).toContain("content 13");
		expect(text).toContain("content 26");
		expect(text).toContain("content 28");
		expect(text).not.toContain("content 10");
		expect(text).not.toContain("content 29");
		// Lines between ranges are elided
		expect(text).not.toContain("content 14");
		// Elision marker between blocks
		expect(text).toContain("…");
		// The URL itself stays clean — no range selector ever hits the network.
		expect(loadSpy).toHaveBeenCalledWith("https://example.com/file.txt", expect.anything());
	});
});

interface StubPage {
	content: string;
	contentType: string;
	truncated: boolean;
}

interface TruncationSourceCase {
	name: string;
	url: string;
	pages: Record<string, StubPage>;
	method: string;
	truncated: boolean;
}

const PAGE_WITH_MD_ALTERNATE = `<html><head><link rel="alternate" type="text/markdown" href="/docs/page.md"></head><body>x</body></html>`;
const MD_ALTERNATE = `# Page\n\n${"markdown body ".repeat(20)}`;

const truncationSourceCases: TruncationSourceCase[] = [
	{
		name: "a cut markdown alternate of a complete HTML page",
		url: "https://example.com/docs/page",
		pages: {
			"https://example.com/docs/page": {
				content: PAGE_WITH_MD_ALTERNATE,
				contentType: "text/html",
				truncated: false,
			},
			"https://example.com/docs/page.md": { content: MD_ALTERNATE, contentType: "text/markdown", truncated: true },
		},
		method: "alternate-markdown",
		truncated: true,
	},
	{
		name: "a complete markdown alternate of a cut HTML page",
		url: "https://example.com/docs/page",
		pages: {
			"https://example.com/docs/page": {
				content: PAGE_WITH_MD_ALTERNATE,
				contentType: "text/html",
				truncated: true,
			},
			"https://example.com/docs/page.md": { content: MD_ALTERNATE, contentType: "text/markdown", truncated: false },
		},
		method: "alternate-markdown",
		truncated: false,
	},
	{
		name: "a cut GitHub raw blob",
		url: "https://github.com/owner/repo/blob/main/data.txt",
		pages: {
			"https://raw.githubusercontent.com/owner/repo/main/data.txt": {
				content: "partial blob",
				contentType: "text/plain",
				truncated: true,
			},
		},
		method: "github-raw",
		truncated: true,
	},
];

describe("read URL beyond the inline preview (regression: tail past 500,000 chars was discarded)", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-large-body-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("keeps the full response body reachable through tail selectors and the full-output artifact", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const marker = "COMPLETE_TAIL_MARKER";
		const lines = Array.from({ length: 12_000 }, (_, i) => `+line-${i + 1} ${"x".repeat(80)}`);
		stubLoadPage(`${lines.join("\n")}\n${marker}\n`, "text/plain");

		const preview = await tool.execute("preview", { path: "https://example.com/big.diff" });
		const artifactId = preview.details?.meta?.truncation?.artifactId;
		expect(artifactId).toBeDefined();
		const artifact = fs.readdirSync(path.join(testDir, "session")).find(file => file.startsWith(`${artifactId}.`));
		expect(fs.readFileSync(path.join(testDir, "session", artifact ?? ""), "utf8")).toEndWith(marker);

		const tail = await tool.execute("tail", { path: "https://example.com/big.diff:-2" });
		const tailText = tail.content.find(c => c.type === "text")?.text ?? "";
		expect(tailText).toContain("+line-12000");
		expect(tailText).toContain(marker);
	});

	it.each(truncationSourceCases)(
		"reports truncation of the response that supplied the content: $name",
		async ({ url, pages, method, truncated }) => {
			vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
				const page = pages[requestedUrl];
				return page
					? { ok: true, status: 200, finalUrl: requestedUrl, ...page }
					: { ok: false, status: 404, finalUrl: requestedUrl, contentType: "", content: "" };
			});

			const result = await new ReadTool(makeSession(testDir)).execute("call", { path: url });
			const text = result.content.find(c => c.type === "text")?.text ?? "";

			expect(result.details?.method).toBe(method);
			expect(text.includes("was cut mid-stream; content is incomplete")).toBe(truncated);
		},
	);
});
