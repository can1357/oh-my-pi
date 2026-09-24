import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import {
	findTinyFishApiKey,
	resolveTinyFishFetchUrl,
	scrapeWithTinyFish,
	TinyFishFetchError,
} from "@oh-my-pi/pi-coding-agent/web/tinyfish";
import * as natives from "@oh-my-pi/pi-natives";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { asGlobalFetch, mockFetch } from "../helpers/fetch-mock";

describe("TinyFish fetch client", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	it("resolves default endpoint URL", () => {
		delete process.env.TINYFISH_FETCH_URL;
		delete process.env.TINYFISH_FETCH_BASE_URL;
		expect(resolveTinyFishFetchUrl()).toBe("https://api.fetch.tinyfish.ai");
	});

	it("honors TINYFISH_FETCH_URL and TINYFISH_FETCH_BASE_URL", () => {
		process.env.TINYFISH_FETCH_URL = "https://custom.fetch.tinyfish.ai/endpoint";
		expect(resolveTinyFishFetchUrl()).toBe("https://custom.fetch.tinyfish.ai/endpoint");

		delete process.env.TINYFISH_FETCH_URL;
		process.env.TINYFISH_FETCH_BASE_URL = "https://custom.fetch.tinyfish.ai/";
		expect(resolveTinyFishFetchUrl()).toBe("https://custom.fetch.tinyfish.ai");
	});

	it("rejects invalid URLs or credentials in base URL", () => {
		process.env.TINYFISH_FETCH_URL = "ftp://invalid.com";
		expect(() => resolveTinyFishFetchUrl()).toThrow(/HTTP or HTTPS/);

		process.env.TINYFISH_FETCH_URL = "https://user:pass@invalid.com";
		expect(() => resolveTinyFishFetchUrl()).toThrow(/credentials/);
	});

	it("finds API key from environment", () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key-123";
		expect(findTinyFishApiKey(null)).toBe("test-tinyfish-key-123");
	});

	it("throws when credentials are missing", async () => {
		delete process.env.TINYFISH_API_KEY;
		expect(scrapeWithTinyFish("https://example.com", {}, null)).rejects.toThrow(TinyFishFetchError);
	});

	it("sends correct headers and body to TinyFish API", async () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key";
		let capturedUrl: string | undefined;
		let capturedHeaders: Headers | undefined;
		let capturedBody: any;

		const fetchMock = mockFetch(async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = new Headers(init?.headers);
			capturedBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					results: [
						{
							url: "https://example.com/test",
							title: "Example Title",
							text: "# Hello from TinyFish\n\nThis is content.",
						},
					],
					errors: [],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const result = await scrapeWithTinyFish("https://example.com/test", { fetch: fetchMock }, null);

		expect(capturedUrl).toBe("https://api.fetch.tinyfish.ai");
		expect(capturedHeaders?.get("x-api-key")).toBe("test-tinyfish-key");
		expect(capturedHeaders?.get("content-type")).toBe("application/json");
		expect(capturedBody).toEqual({
			urls: ["https://example.com/test"],
			format: "markdown",
			links: false,
			image_links: false,
		});
		expect(result).toBe("# Hello from TinyFish\n\nThis is content.");
	});

	it("throws on error response status", async () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key";
		const fetchMock = mockFetch(async () => {
			return new Response(JSON.stringify({ error: "Unauthorized access" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		await expect(scrapeWithTinyFish("https://example.com/test", { fetch: fetchMock }, null)).rejects.toThrow(
			/TinyFish API error \(401\): Unauthorized access/,
		);
	});

	it("throws on per-URL error in errors array", async () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key";
		const fetchMock = mockFetch(async () => {
			return new Response(
				JSON.stringify({
					results: [],
					errors: [{ url: "https://example.com/fail", error: "Failed to render target page" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		await expect(scrapeWithTinyFish("https://example.com/fail", { fetch: fetchMock }, null)).rejects.toThrow(
			"Failed to render target page",
		);
	});
});

describe("Read tool TinyFish fetch provider integration", () => {
	let testDir: string;
	const originalApiKey = process.env.TINYFISH_API_KEY;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-tinyfish-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
		if (originalApiKey === undefined) {
			delete process.env.TINYFISH_API_KEY;
		} else {
			process.env.TINYFISH_API_KEY = originalApiKey;
		}
	});

	const createSession = (settingsOverrides: Record<string, unknown> = {}): ToolSession => {
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
				return {
					id,
					path: path.join(artifactsDir, `${id}.${toolType}.log`),
				};
			},
			settings: Settings.isolated({
				"fetch.enabled": true,
				...settingsOverrides,
			}),
		};
	};

	it("prefers TinyFish scrape first when providers.fetch is set to tinyfish", async () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key";
		const session = createSession({ "providers.fetch": "tinyfish" });
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/tinyfish-page";
		const requests: { url: string; apiKey: string | null; body: unknown }[] = [];

		session.fetch = asGlobalFetch(async (input, init) => {
			if (String(input) === "https://api.fetch.tinyfish.ai") {
				requests.push({
					url: String(input),
					apiKey: new Headers(init?.headers).get("x-api-key"),
					body: JSON.parse(String(init?.body)),
				});
				return new Response(
					JSON.stringify({
						results: [
							{
								url: pageUrl,
								title: "TinyFish Page",
								text: "TinyFish-rendered markdown content that is comfortably longer than one hundred characters to clear the quality gate. ".repeat(
									2,
								),
							},
						],
						errors: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});

		const pageHtml = "<html><body><main><h1>TinyFish Page</h1></main></body></html>";
		const ensureToolSpy = vi.spyOn(toolsManager, "ensureTool");
		const htmlToMarkdownSpy = vi.spyOn(natives, "htmlToMarkdown");
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}
			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});

		const result = await tool.execute("fetch-tinyfish-html", { path: pageUrl });
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("tinyfish");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("TinyFish-rendered markdown content");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.apiKey).toBe("test-tinyfish-key");
		expect(requests[0]?.body).toEqual({
			urls: [pageUrl],
			format: "markdown",
			links: false,
			image_links: false,
		});
		expect(ensureToolSpy).not.toHaveBeenCalled();
		expect(htmlToMarkdownSpy).not.toHaveBeenCalled();
	});

	it("falls back to native converter when TinyFish fails", async () => {
		process.env.TINYFISH_API_KEY = "test-tinyfish-key";
		const session = createSession({ "providers.fetch": "tinyfish" });
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/tinyfish-fallback";

		session.fetch = asGlobalFetch(async input => {
			if (String(input) === "https://api.fetch.tinyfish.ai") {
				return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503 });
			}
			return new Response("not found", { status: 404 });
		});

		const pageHtml = `<html><body><article><p>${"Native fallback content that is long enough to easily pass the one hundred characters quality gate requirement.".repeat(2)}</p></article></body></html>`;
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}
			return {
				ok: false,
				status: 404,
				contentType: "text/plain",
				finalUrl: requestedUrl,
				content: "",
			};
		});

		const result = await tool.execute("fetch-tinyfish-fallback", { path: pageUrl });
		expect(result.details?.method).toBe("native");
		const textBlock = result.content.find(content => content.type === "text");
		expect(textBlock?.text).toContain("Native fallback content");
	});
});
