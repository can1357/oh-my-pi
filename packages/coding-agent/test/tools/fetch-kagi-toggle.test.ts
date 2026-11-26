import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as imageResize from "@oh-my-pi/pi-coding-agent/utils/image-resize";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { removeSyncWithRetries, Snowflake, spillIdOfFileName } from "@oh-my-pi/pi-utils";
import { mockFetch } from "../helpers/fetch-mock";

const PNG_HEADER = new Uint8Array([137, 80, 78, 71]);

function page(body: string, contentType = "text/html"): Response {
	return new Response(body, { headers: { "content-type": contentType } });
}

function notFound(): Response {
	return new Response(null, { status: 404 });
}

function restoreKey(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}

describe("read tool URL handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-kagi-toggle-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	const createSession = (overrides: Record<string, unknown> = {}): ToolSession => {
		const sessionFile = path.join(testDir, "session.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		let nextArtifactId = 0;
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async () => {
				const id = String(nextArtifactId++);
				return { id, path: path.join(artifactsDir, `${id}.log`) };
			},
			settings: Settings.isolated({ "fetch.enabled": true, ...overrides }),
		};
	};

	it("returns an image content block when fetching image URLs", async () => {
		const session = createSession();
		session.fetch = mockFetch(() => new Response(PNG_HEADER, { headers: { "content-type": "image/png" } }));
		vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
			buffer: PNG_HEADER,
			mimeType: "image/png",
			originalWidth: 1,
			originalHeight: 1,
			width: 1,
			height: 1,
			wasResized: false,
			get data() {
				return PNG_HEADER.toBase64();
			},
		});

		const result = await new ReadTool(session).execute("fetch-image", { path: "https://example.com/image.png" });
		const image = result.content.find(block => block.type === "image");

		expect(result.details?.method).toBe("image");
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data).toBe(PNG_HEADER.toBase64());
	});

	it("resizes fetched images before emitting image content blocks", async () => {
		const session = createSession();
		session.fetch = mockFetch(() => new Response(PNG_HEADER, { headers: { "content-type": "image/png" } }));
		const resize = vi.spyOn(imageResize, "resizeImage").mockResolvedValue({
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
		const convert = vi.spyOn(scraperUtils, "convertWithMarkit");

		const result = await new ReadTool(session).execute("fetch-image-resized", {
			path: "https://example.com/image.png",
		});
		const image = result.content.find(block => block.type === "image");

		expect(resize).toHaveBeenCalledTimes(1);
		expect(result.details?.method).toBe("image");
		expect(image?.mimeType).toBe("image/jpeg");
		expect(image?.data).toBe("cmVzaXplZA==");
		expect(result.content.find(block => block.type === "text")?.text).toContain("displayed at 1000x500");
		expect(convert).not.toHaveBeenCalled();
	});

	it("returns SVG source instead of an unsupported image block", async () => {
		const session = createSession();
		const request = vi.fn(() => page("<svg></svg>", "image/svg+xml"));
		session.fetch = mockFetch(request);

		const result = await new ReadTool(session).execute("fetch-image-unsupported", {
			path: "https://example.com/image.svg",
		});

		expect(request).toHaveBeenCalledTimes(1);
		expect(result.content.find(block => block.type === "image")).toBeUndefined();
		expect(result.content.find(block => block.type === "text")?.text).toContain("<svg></svg>");
	});

	it("does not treat text/html at .png paths as inline images", async () => {
		const session = createSession();
		const html = "<html><body>not really an image</body></html>";
		session.fetch = mockFetch(() => page(html));

		const result = await new ReadTool(session).execute("fetch-html-png-path", {
			path: "https://example.com/foo.png:raw",
		});

		expect(result.details?.method).toBe("raw");
		expect(result.content.find(block => block.type === "image")).toBeUndefined();
		expect(result.content.find(block => block.type === "text")?.text).toBe(html);
	});

	it("keeps gateway page text from a response mislabeled as an image", async () => {
		const session = createSession();
		const request = vi.fn(() => page("<html><body>temporary gateway page</body></html>", "image/png"));
		session.fetch = mockFetch(request);
		const convert = vi.spyOn(scraperUtils, "convertWithMarkit");

		const result = await new ReadTool(session).execute("fetch-image-gateway", {
			path: "https://example.com/transient.png",
		});

		expect(result.content.find(block => block.type === "image")).toBeUndefined();
		expect(result.content.find(block => block.type === "text")?.text).toContain("temporary gateway page");
		expect(convert).not.toHaveBeenCalled();
	});

	it("falls back to text-only output when image payload bytes are invalid", async () => {
		const session = createSession();
		session.fetch = mockFetch(() => new Response(PNG_HEADER, { headers: { "content-type": "image/png" } }));

		const result = await new ReadTool(session).execute("fetch-broken-image", {
			path: "https://example.com/broken.png",
		});

		expect(result.details?.method).toBe("image-invalid");
		expect(result.content.find(block => block.type === "image")).toBeUndefined();
		expect(result.content.find(block => block.type === "text")?.text).toContain("bytes were not a valid image");
	});

	it("prefers rendered page content over site-wide llms.txt for deep pages", async () => {
		const session = createSession();
		const pageUrl = "https://bun.com/reference/bun/UnixSocketOptions";
		const requestedUrls: string[] = [];
		session.fetch = mockFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === pageUrl) {
				return page(
					`<html><body><main><h1>UnixSocketOptions</h1><p>${"Page-specific API docs. ".repeat(8)}</p></main></body></html>`,
				);
			}
			if (url === "https://bun.com/llms.txt") {
				return page(`# Bun\n\n${"Site-wide overview. ".repeat(12)}`, "text/plain");
			}
			return notFound();
		});

		const result = await new ReadTool(session).execute("fetch-deep-page", { path: pageUrl });

		expect(result.content.find(block => block.type === "text")?.text).toContain("Page-specific API docs");
		expect(requestedUrls).not.toContain("https://bun.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.txt");
		expect(requestedUrls).not.toContain("https://bun.com/llms.md");
	});

	it("uses section-scoped llms.txt fallback without requesting the site-wide file", async () => {
		const session = createSession();
		const pageUrl = "https://example.com/docs/reference/widget";
		const requestedUrls: string[] = [];
		session.fetch = mockFetch(input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === pageUrl) {
				return page(
					`<html><body><main><h1>Widget</h1><p>${"Please enable JavaScript to view this page. ".repeat(6)}</p></main></body></html>`,
				);
			}
			if (url === "https://example.com/docs/llms.txt") {
				return page(`# Example Docs\n\n${"Section-scoped fallback. ".repeat(10)}`, "text/plain");
			}
			if (url === "https://example.com/llms.txt") {
				return page(`# Example\n\n${"Site-wide fallback. ".repeat(10)}`, "text/plain");
			}
			return notFound();
		});

		const result = await new ReadTool(session).execute("fetch-section-llms", { path: pageUrl });

		expect(result.details?.method).toBe("llms.txt");
		expect(result.details?.notes).toContain("Used llms.txt fallback: https://example.com/docs/llms.txt");
		expect(result.content.find(block => block.type === "text")?.text).toContain("Section-scoped fallback");
		expect(requestedUrls).toContain("https://example.com/docs/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/.well-known/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.txt");
		expect(requestedUrls).not.toContain("https://example.com/llms.md");
	});

	it("prefers Parallel output over local HTML when configured", async () => {
		const originalApiKey = process.env.PARALLEL_API_KEY;
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		try {
			const session = createSession({ "providers.fetch": "parallel" });
			const pageUrl = "https://example.com/parallel-page";
			session.fetch = mockFetch(input => {
				if (String(input) === pageUrl) return page(`<main>${"Local parallel-page prose. ".repeat(8)}</main>`);
				if (String(input) !== "https://api.parallel.ai/v1beta/extract") return notFound();
				return Response.json({
					extract_id: "extract-fetch-1",
					results: [{ url: pageUrl, title: "Parallel Page", excerpts: ["Parallel-rendered content. ".repeat(8)] }],
					errors: [],
				});
			});

			const result = await new ReadTool(session).execute("fetch-parallel-html", { path: pageUrl });
			const text = result.content.find(block => block.type === "text")?.text;

			expect(result.details?.method).toBe("parallel");
			expect(text).toContain("Parallel-rendered content");
			expect(text).not.toContain("Local parallel-page prose");
		} finally {
			restoreKey("PARALLEL_API_KEY", originalApiKey);
		}
	});

	it("prefers Firecrawl output over local HTML when configured", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const session = createSession({ "providers.fetch": "firecrawl" });
			const pageUrl = "https://example.com/firecrawl-page";
			const requests: { authorization: string | null; body: unknown }[] = [];
			session.fetch = mockFetch((input, init) => {
				if (String(input) === pageUrl) return page(`<main>${"Local Firecrawl-page prose. ".repeat(8)}</main>`);
				if (String(input) !== "https://api.firecrawl.dev/v2/scrape") return notFound();
				requests.push({
					authorization: new Headers(init?.headers).get("authorization"),
					body: JSON.parse(String(init?.body)),
				});
				return Response.json({
					success: true,
					data: {
						markdown: "Firecrawl-rendered content. ".repeat(8),
						metadata: { sourceURL: pageUrl, statusCode: 200 },
					},
				});
			});

			const result = await new ReadTool(session).execute("fetch-firecrawl-html", { path: pageUrl });
			const text = result.content.find(block => block.type === "text")?.text;

			expect(result.details?.method).toBe("firecrawl");
			expect(text).toContain("Firecrawl-rendered content");
			expect(text).not.toContain("Local Firecrawl-page prose");
			expect(requests).toHaveLength(1);
			expect(requests[0]?.authorization).toBe("Bearer test-firecrawl-key");
			expect(requests[0]?.body).toMatchObject({ url: pageUrl, formats: ["markdown"] });
		} finally {
			restoreKey("FIRECRAWL_API_KEY", originalApiKey);
		}
	});

	it("retries a retryable Firecrawl response before falling through", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const session = createSession({ "providers.fetch": "firecrawl" });
			const pageUrl = "https://example.com/firecrawl-retry";
			let scrapeCalls = 0;
			session.fetch = mockFetch(input => {
				if (String(input) === pageUrl) return page(`<main>${"Local retry-page prose. ".repeat(8)}</main>`);
				if (String(input) !== "https://api.firecrawl.dev/v2/scrape") return notFound();
				if (++scrapeCalls === 1) return Response.json({ error: "temporarily unavailable" }, { status: 503 });
				return Response.json({
					success: true,
					data: {
						markdown: "Firecrawl content served on the retry attempt. ".repeat(8),
						metadata: { statusCode: 200 },
					},
				});
			});

			const result = await new ReadTool(session).execute("fetch-firecrawl-retry", { path: pageUrl });

			expect(scrapeCalls).toBe(2);
			expect(result.details?.method).toBe("firecrawl");
			expect(result.content.find(block => block.type === "text")?.text).toContain("served on the retry attempt");
		} finally {
			restoreKey("FIRECRAWL_API_KEY", originalApiKey);
		}
	});

	it("supports offset and limit selectors on URL reads", async () => {
		const session = createSession();
		session.fetch = mockFetch(() => page("Line 1\nLine 2\nLine 3\nLine 4", "text/plain"));

		const result = await new ReadTool(session).execute("fetch-offset-page", {
			path: "https://example.com/offset-test:2-3",
		});
		const text = result.content.find(block => block.type === "text")?.text;

		expect(text).toContain("Line 2");
		expect(text).toContain("Line 3");
		expect(fs.readdirSync(path.join(testDir, "session")).some(file => spillIdOfFileName(file) !== undefined)).toBe(
			true,
		);
	});
});
