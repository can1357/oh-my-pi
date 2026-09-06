import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleOllama } from "@oh-my-pi/pi-coding-agent/web/scrapers/ollama";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

describe("handleOllama URL parsing & route rejection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null for non-Ollama hostnames", async () => {
		expect(await handleOllama("https://example.com/llama3", 5000)).toBeNull();
		expect(await handleOllama("https://github.com/ollama/ollama", 5000)).toBeNull();
		expect(await handleOllama("https://notollama.com/library/llama3", 5000)).toBeNull();
	});

	it("returns null for empty root or reserved routes", async () => {
		expect(await handleOllama("https://ollama.com", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/library", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/library:latest", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/models", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/blog", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/blog:post", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/blog/some-post", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/docs", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/download", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/search", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/signin", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/pricing", 5000)).toBeNull();
		expect(await handleOllama("https://ollama.com/account", 5000)).toBeNull();
	});

	it("returns null for malformed URLs", async () => {
		expect(await handleOllama("not-a-valid-url", 5000)).toBeNull();
	});
});

describe("handleOllama scraper with mocked responses", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when both page fetch and tags API fail", async () => {
		vi.spyOn(scrapers, "loadPage").mockResolvedValue({
			ok: false,
			status: 404,
			finalUrl: "https://ollama.com/library/nonexistent",
			contentType: "text/html",
			content: "Not found",
		});

		const result = await handleOllama("https://ollama.com/nonexistent", 5000);
		expect(result).toBeNull();
	});

	it("returns null when page fetch fails and tags API returns no matching models", async () => {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: true,
					status: 200,
					finalUrl: url,
					contentType: "application/json",
					content: JSON.stringify({ models: [{ name: "mistral:latest" }] }),
				};
			}
			return {
				ok: false,
				status: 404,
				finalUrl: url,
				contentType: "text/html",
				content: "404 Not Found",
			};
		});

		const result = await handleOllama("https://ollama.com/llama3", 5000);
		expect(result).toBeNull();
	});

	it("scrapes root single-segment official model URL (e.g. /llama3)", async () => {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: true,
					status: 200,
					finalUrl: url,
					contentType: "application/json",
					content: JSON.stringify({
						models: [
							{
								name: "llama3:8b",
								size: 4700000000,
								details: { parameter_size: "8.0B" },
							},
							{
								name: "llama3:latest",
								size: 4700000000,
								details: { parameter_size: "8.0B" },
							},
							{
								name: "llama3:70b",
								size: 40000000000,
								details: { parameter_size: "70.6B" },
							},
						],
					}),
				};
			}
			return {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "text/html",
				content: `
					<html>
						<head>
							<meta name="description" content="Meta Llama 3 &amp; next-gen AI" />
						</head>
						<body>
							<span x-test-size>8B</span>
							<span x-test-size>70B</span>
						</body>
					</html>
				`,
			};
		});

		const result = await handleOllama("https://ollama.com/llama3", 5000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("ollama");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("# llama3");
		expect(result?.content).toContain("Meta Llama 3 & next-gen AI");
		expect(result?.content).toContain("**Model:** llama3");
		expect(result?.content).toContain("**Parameters:** 8.0B, 70.6B, 8B, 70B");
		expect(result?.content).toContain("**Size Range:**");
		// :latest must sort first in available tags
		expect(result?.content).toContain("`llama3:latest`, `llama3:70b`, `llama3:8b`");
		expect(result?.notes).toContain("Fetched via Ollama API");
	});

	it("handles specific tagged model URL and filters details for tag", async () => {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: true,
					status: 200,
					finalUrl: url,
					contentType: "application/json",
					content: JSON.stringify({
						models: [
							{
								name: "deepseek-r1:8b",
								size: 4900000000,
								details: { parameter_size: "8B" },
							},
							{
								name: "deepseek-r1:70b",
								size: 43000000000,
								details: { parameter_size: "70B" },
							},
						],
					}),
				};
			}
			return {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "text/html",
				content: `<html><head><meta name="description" content="DeepSeek R1 reasoning model" /></head></html>`,
			};
		});

		const result = await handleOllama("https://ollama.com/deepseek-r1:8b", 5000);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("# deepseek-r1");
		expect(result?.content).toContain("**Tag:** deepseek-r1:8b");
		expect(result?.content).toContain("**Parameters:** 8B");
		expect(result?.content).toMatch(/\*\*Size:\*\*\s*\d+(\.\d+)?\s*GB/i);
	});

	it("handles namespaced model URLs (e.g. /mattw/mistral:7b)", async () => {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: true,
					status: 200,
					finalUrl: url,
					contentType: "application/json",
					content: JSON.stringify({
						models: [
							{
								name: "mattw/mistral:7b",
								size: 4100000000,
								details: { parameter_size: "7B" },
							},
						],
					}),
				};
			}
			return {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "text/html",
				content: `<html><head><meta property="og:description" content="Custom tuned Mistral" /></head></html>`,
			};
		});

		const result = await handleOllama("https://ollama.com/mattw/mistral:7b", 5000);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("# mattw/mistral");
		expect(result?.content).toContain("**Model:** mattw/mistral");
		expect(result?.content).toContain("**Tag:** mattw/mistral:7b");
		expect(result?.content).toContain("Custom tuned Mistral");
	});

	it("falls back to HTML extracted tags and metadata when tags API is unavailable", async () => {
		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: false,
					status: 500,
					finalUrl: url,
					contentType: "application/json",
					content: "Internal Error",
				};
			}
			return {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "text/html",
				content: `
					<html>
						<head>
							<meta name="description" content="Community model &quot;Special&quot;" />
						</head>
						<body>
							<span x-test-size>13B</span>
							<a href="/library/special-model:latest">latest</a>
							<a href="/library/special-model:13b">13b</a>
						</body>
					</html>
				`,
			};
		});

		const result = await handleOllama("https://ollama.com/library/special-model", 5000);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("# special-model");
		expect(result?.content).toContain('Community model "Special"');
		expect(result?.content).toContain("**Parameters:** 13B");
		expect(result?.content).toContain("`special-model:latest`, `special-model:13b`");
	});

	it("elides tags when there are more than 40 available tags", async () => {
		const models = Array.from({ length: 45 }, (_, i) => ({
			name: `big-model:v${i + 1}`,
		}));

		vi.spyOn(scrapers, "loadPage").mockImplementation(async url => {
			if (url.includes("/api/tags")) {
				return {
					ok: true,
					status: 200,
					finalUrl: url,
					contentType: "application/json",
					content: JSON.stringify({ models }),
				};
			}
			return {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "text/html",
				content: `<html><head><meta name="description" content="Model with many tags" /></head></html>`,
			};
		});

		const result = await handleOllama("https://ollama.com/library/big-model", 5000);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("[…5 tags elided…]");
	});
});
