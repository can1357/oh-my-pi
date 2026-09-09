import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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

		expect(firstText?.text).toContain("v1");
		expect(secondText?.text).toContain("v2");
		expect(secondText?.text).not.toContain("v1");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("returns slices of raw content when :raw is combined with a range", async () => {
		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const body = Array.from({ length: 20 }, (_, i) => `raw line ${i + 1}`).join("\n");
		stubLoadPage(body, "application/json");

		// `:raw:N-M` must skip JSON pretty-print (raw mode) AND slice. URL output is
		// prefixed with a 6-line header (URL/Content-Type/Method/blank/---/blank), so
		// body line N appears at output line N+6.
		const result = await tool.execute("call", { path: "https://example.com/api.json:raw:9-11" });
		const text =
			result.content
				.filter(c => c.type === "text")
				.map(c => c.text)
				.join("\n") ?? "";

		expect(result.details?.method).toBe("raw");
		expect(text).toContain("raw line 3");
		expect(text).toContain("raw line 5");
		expect(text).not.toContain("raw line 15");
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

		// Body line N is at output line N+6 (URL header prefix). 11-13 = content 5-7,
		// 26-28 = content 20-22.
		expect(text).toContain("content 5");
		expect(text).toContain("content 7");
		expect(text).toContain("content 20");
		expect(text).toContain("content 22");
		// Lines between ranges are elided
		expect(text).not.toContain("content 14");
		// Elision marker between blocks
		expect(text).toContain("…");
		// The URL itself stays clean — no range selector ever hits the network.
		expect(loadSpy).toHaveBeenCalledWith("https://example.com/file.txt", expect.anything());
	});
});
