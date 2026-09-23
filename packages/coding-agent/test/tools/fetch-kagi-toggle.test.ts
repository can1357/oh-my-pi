import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as imageResize from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import * as natives from "@oh-my-pi/pi-natives";
import { ptree, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

const withMissingSystemPython = () => {
	const whichSpy = vi.spyOn(Bun, "which").mockImplementation(() => null);
	return {
		[Symbol.dispose]() {
			whichSpy.mockRestore();
		},
	};
};

describe("read tool URL selector shorthands", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-kagi-toggle-shorthand-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	const createSession = (settingsOverrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession => {
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

	it("supports embedded raw selectors in URL paths", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/embedded-raw";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== pageUrl) {
				throw new Error(`Unexpected URL: ${requestedUrl}`);
			}
			return {
				ok: true,
				status: 200,
				contentType: "text/html",
				finalUrl: pageUrl,
				content: "<html><body><main><h1>Embedded raw page</h1></main></body></html>",
			};
		});

		const result = await tool.execute("fetch-embedded-raw", { path: `${pageUrl}:raw` });
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body><main><h1>Embedded raw page</h1></main></body></html>");
		expect(loadPageSpy).toHaveBeenCalledWith(pageUrl, expect.anything());
	});

	it("supports embedded line selectors in URL paths", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/embedded-lines";
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
			if (requestedUrl !== pageUrl) {
				throw new Error(`Unexpected URL: ${requestedUrl}`);
			}
			return {
				ok: true,
				status: 200,
				contentType: "text/plain",
				finalUrl: pageUrl,
				content: "Line 1\nLine 2\nLine 3",
			};
		});

		const result = await tool.execute("fetch-embedded-lines", { path: `${pageUrl}:7-8` });
		const textBlock = result.content.find(content => content.type === "text");

		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Line 1");
		expect(textBlock?.text).toContain("Line 2");
		// Read tool widens the window by ±3 unanchored context lines.
		expect(loadPageSpy).toHaveBeenCalledTimes(1);
		expect(loadPageSpy).toHaveBeenCalledWith(pageUrl, expect.anything());
	});
});

describe("read tool URL handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-kagi-toggle-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
		removeSyncWithRetries(testDir);
	});

	const createSession = (overrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession => {
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
				...overrides,
			}),
		};
	};

	it("returns an image content block when fetching image URLs", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const imageBytes = new Uint8Array([137, 80, 78, 71]);
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: imageBytes,
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: imageBytes,
			mimeType: "image/png",
			originalWidth: 1,
			originalHeight: 1,
			width: 1,
			height: 1,
			wasResized: false,
			get data() {
				return imageBytes.toBase64();
			},
		});

		const result = await tool.execute("fetch-image", { path: "https://example.com/image.png" });
		const imageBlock = result.content.find(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);

		expect(result.details?.method).toBe("image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock?.mimeType).toBe("image/png");
		expect(imageBlock?.data).toBe(imageBytes.toBase64());
	});

	it("resizes fetched images before emitting image content blocks", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const resizeSpy = vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([1, 2, 3]),
			mimeType: "image/jpeg",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
			get data() {
				return "cmVzaXplZA==";
			},
		});
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/image.png",
			content: "",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([137, 80, 78, 71]),
		});
		const convertSpy = vi.spyOn(scraperUtils, "convertWithMarkit");

		const result = await tool.execute("fetch-image-resized", { path: "https://example.com/image.png" });
		const imageBlock = result.content.find(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);
		const textBlock = result.content.find(content => content.type === "text");

		expect(resizeSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.method).toBe("image");
		expect(imageBlock?.mimeType).toBe("image/jpeg");
		expect(imageBlock?.data).toBe("cmVzaXplZA==");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("displayed at 1000x500");
		expect(convertSpy).not.toHaveBeenCalled();
	});

	it("falls back to text-only output for unsupported image MIME types", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const fetchBinarySpy = vi.spyOn(scraperUtils, "fetchBinary");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/svg+xml",
			finalUrl: "https://example.com/image.svg",
			content: "<svg></svg>",
		});

		const result = await tool.execute("fetch-image-unsupported", { path: "https://example.com/image.svg" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(fetchBinarySpy).not.toHaveBeenCalled();
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<svg></svg>");
	});

	it("does not treat text/html at .png paths as inline images", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({ ok: false, error: "not an image" });
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/html",
			finalUrl: "https://example.com/foo.png",
			content: "<html><body>not really an image</body></html>",
		});

		const result = await tool.execute("fetch-html-png-path", { path: "https://example.com/foo.png:raw" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>not really an image</body></html>");
	});

	it("falls back to textual output when inline image refetch fails", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const convertSpy = vi.spyOn(scraperUtils, "convertWithMarkit");
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/transient.png",
			content: "<html><body>temporary gateway page</body></html>",
		});
		const fetchBinarySpy = vi
			.spyOn(scraperUtils, "fetchBinary")
			.mockResolvedValue({ ok: false, error: "upstream blocked" });

		const result = await tool.execute("fetch-image-refetch-failed", { path: "https://example.com/transient.png" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("raw");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>temporary gateway page</body></html>");
		expect(convertSpy).not.toHaveBeenCalled();
		expect(fetchBinarySpy).toHaveBeenCalledTimes(1);
	});
	it("falls back to text-only output when image payload bytes are invalid", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "image/png",
			finalUrl: "https://example.com/broken.png",
			content: "<html><body>gateway error</body></html>",
		});
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
		});
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: new Uint8Array([60, 104, 116, 109, 108]),
			mimeType: "image/png",
			originalWidth: 0,
			originalHeight: 0,
			width: 0,
			height: 0,
			wasResized: false,
			get data() {
				return "PGh0bWw=";
			},
		});

		const result = await tool.execute("fetch-broken-image", { path: "https://example.com/broken.png" });
		const imageBlock = result.content.find(content => content.type === "image");
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("image-invalid");
		expect(imageBlock).toBeUndefined();
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("<html><body>gateway error</body></html>");
	});
	it("prefers rendered page content over site-wide llms.txt for deep pages", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://bun.com/reference/bun/UnixSocketOptions";
		const pageHtml = "<html><body><main><h1>UnixSocketOptions</h1><p>Page-specific docs.</p></main></body></html>";
		const renderedMarkdown = `# UnixSocketOptions\n\n${"Page-specific API docs. ".repeat(8)}`;
		using missingSystemPython = withMissingSystemPython();
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}

			if (requestedUrl === `${pageUrl}.md`) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}

			if (requestedUrl === "https://bun.com/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Bun\n\n${"Site-wide overview. ".repeat(12)}`,
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
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);
		vi.spyOn(natives, "htmlToMarkdown").mockResolvedValue(renderedMarkdown);

		const result = await tool.execute("fetch-deep-page", { path: pageUrl });
		const requestedUrls = loadPageSpy.mock.calls.map(([requestedUrl]) => requestedUrl);
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("native");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("UnixSocketOptions");
		expect(requestedUrls).not.toContain("https://bun.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.md");
		void missingSystemPython;
	});

	it("uses section-scoped llms.txt fallback without requesting the site-wide file", async () => {
		const session = createSession();
		session.fetch = asGlobalFetch(() => new Response("blocked", { status: 500, statusText: "Blocked" }));
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/docs/reference/widget";
		const pageHtml = "<html><body><nav>Docs</nav><main><h1>Widget</h1></main></body></html>";
		const lowQualityRender = `${"Please enable JavaScript to view this page.\n".repeat(6)}${"navigation\n".repeat(4)}`;
		using missingSystemPython = withMissingSystemPython();
		vi.spyOn(ptree, "exec").mockResolvedValue({ ok: true, stdout: lowQualityRender } as never);
		const loadPageSpy = vi.spyOn(scrapers, "loadPage").mockImplementation(async (requestedUrl: string) => {
			if (requestedUrl === pageUrl) {
				return {
					ok: true,
					status: 200,
					contentType: "text/html",
					finalUrl: pageUrl,
					content: pageHtml,
				};
			}

			if (
				[
					`${pageUrl}.md`,
					"https://example.com/docs/reference/llms.txt",
					"https://example.com/docs/reference/llms.md",
					"https://example.com/docs/llms.md",
				].includes(requestedUrl)
			) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
				};
			}

			if (requestedUrl === "https://example.com/docs/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Example Docs\n\n${"Section-scoped fallback. ".repeat(10)}`,
				};
			}

			if (requestedUrl === "https://example.com/llms.txt") {
				return {
					ok: true,
					status: 200,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: `# Example\n\n${"Site-wide fallback. ".repeat(10)}`,
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
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/usr/bin/trafilatura");

		const result = await tool.execute("fetch-section-llms", { path: pageUrl });
		const requestedUrls = loadPageSpy.mock.calls.map(([requestedUrl]) => requestedUrl);
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("llms.txt");
		expect(result.details?.notes).toContain("Used llms.txt fallback: https://example.com/docs/llms.txt");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Section-scoped fallback");
		expect(requestedUrls).toContain("https://example.com/docs/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.md");
		void missingSystemPython;
	});
	it("prefers Parallel extract first when providers.fetch is set to parallel", async () => {
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		const session = createSession({ "providers.fetch": "parallel" });
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/parallel-page";
		session.fetch = asGlobalFetch(input => {
			if (String(input) === "https://api.parallel.ai/v1beta/extract") {
				return new Response(
					JSON.stringify({
						extract_id: "extract-fetch-1",
						results: [
							{
								url: pageUrl,
								title: "Parallel Page",
								excerpts: [
									"Parallel-rendered content that is comfortably longer than one hundred characters. ".repeat(
										2,
									),
								],
								full_content: null,
							},
						],
						errors: [],
						warnings: null,
						usage: null,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("blocked", { status: 500, statusText: "Blocked" });
		});
		const pageHtml = "<html><body><main><h1>Parallel Page</h1></main></body></html>";
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

			if (requestedUrl === `${pageUrl}.md`) {
				return {
					ok: false,
					status: 404,
					contentType: "text/plain",
					finalUrl: requestedUrl,
					content: "",
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

		const result = await tool.execute("fetch-parallel-html", { path: pageUrl });
		const textBlock = result.content.find(content => content.type === "text");

		expect(result.details?.method).toBe("parallel");
		expect(textBlock?.type).toBe("text");
		expect(textBlock?.text).toContain("Parallel-rendered content");
		expect(ensureToolSpy).not.toHaveBeenCalled();
		expect(htmlToMarkdownSpy).not.toHaveBeenCalled();
	});

	it("prefers Firecrawl scrape first when providers.fetch is set to firecrawl", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const session = createSession({ "providers.fetch": "firecrawl" });
			const tool = new ReadTool(session);
			const pageUrl = "https://example.com/firecrawl-page";
			const requests: { url: string; authorization: string | null; body: unknown }[] = [];
			session.fetch = asGlobalFetch(async (input, init) => {
				if (String(input) === "https://api.firecrawl.dev/v2/scrape") {
					requests.push({
						url: String(input),
						authorization: new Headers(init?.headers).get("authorization"),
						body: JSON.parse(String(init?.body)),
					});
					return new Response(
						JSON.stringify({
							success: true,
							data: {
								markdown:
									"Firecrawl-rendered content that is comfortably longer than one hundred characters. ".repeat(
										2,
									),
								metadata: { sourceURL: pageUrl, statusCode: 200 },
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("blocked", { status: 500, statusText: "Blocked" });
			});
			const pageHtml = "<html><body><main><h1>Firecrawl Page</h1></main></body></html>";
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

			const result = await tool.execute("fetch-firecrawl-html", { path: pageUrl });
			const textBlock = result.content.find(content => content.type === "text");

			expect(result.details?.method).toBe("firecrawl");
			expect(textBlock?.type).toBe("text");
			expect(textBlock?.text).toContain("Firecrawl-rendered content");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.authorization).toBe("Bearer test-firecrawl-key");
			expect(requests[0]?.body).toMatchObject({ url: pageUrl, formats: ["markdown"] });
			expect(ensureToolSpy).not.toHaveBeenCalled();
			expect(htmlToMarkdownSpy).not.toHaveBeenCalled();
		} finally {
			if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
			else process.env.FIRECRAWL_API_KEY = originalApiKey;
		}
	});

	it("retries a retryable Firecrawl response before falling through", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const session = createSession({ "providers.fetch": "firecrawl" });
			const tool = new ReadTool(session);
			const pageUrl = "https://example.com/firecrawl-retry";
			let scrapeCalls = 0;
			session.fetch = asGlobalFetch(async input => {
				if (String(input) === "https://api.firecrawl.dev/v2/scrape") {
					scrapeCalls++;
					if (scrapeCalls === 1) {
						return new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 });
					}
					return new Response(
						JSON.stringify({
							success: true,
							data: {
								markdown:
									"Firecrawl content served on the retry attempt, comfortably over one hundred characters. ".repeat(
										2,
									),
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("blocked", { status: 500, statusText: "Blocked" });
			});
			vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => {
				if (requestedUrl === pageUrl) {
					return {
						ok: true,
						status: 200,
						contentType: "text/html",
						finalUrl: pageUrl,
						content: "<html><body><main><h1>Firecrawl Retry</h1></main></body></html>",
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

			const result = await tool.execute("fetch-firecrawl-retry", { path: pageUrl });
			const textBlock = result.content.find(content => content.type === "text");

			expect(scrapeCalls).toBe(2);
			expect(result.details?.method).toBe("firecrawl");
			expect(textBlock?.text).toContain("served on the retry attempt");
		} finally {
			if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
			else process.env.FIRECRAWL_API_KEY = originalApiKey;
		}
	});

	it("supports offset and limit selectors on URL reads", async () => {
		const session = createSession();
		const tool = new ReadTool(session);
		const pageUrl = "https://example.com/offset-test";
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: true,
			status: 200,
			contentType: "text/plain",
			finalUrl: pageUrl,
			content: "Line 1\nLine 2\nLine 3\nLine 4",
		});

		const pagedResult = await tool.execute("fetch-offset-page", {
			path: `${pageUrl}:7-8`,
		});
		const pagedText = pagedResult.content.find(content => content.type === "text");
		expect(pagedText?.type).toBe("text");
		// `:7-8` selects 2 lines starting at offset 7 of the wrapped URL
		// output. Read tool widens the window by ±3 unanchored context lines
		// so anchors at the boundary stay fresh, so adjacent content lines are
		// also visible.
		expect(pagedText?.text).toContain("Line 1");
		expect(pagedText?.text).toContain("Line 2");
		expect(fs.readdirSync(path.join(testDir, "session")).some(file => file.endsWith(".read.log"))).toBe(true);
	});
});
