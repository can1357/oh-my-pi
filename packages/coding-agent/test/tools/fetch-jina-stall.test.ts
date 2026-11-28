import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockFetch } from "../helpers/fetch-mock";

const ARTICLE_URL = "https://example.com/article";
const ARTICLE = `<html><body><article><h1>Fallback article</h1><p>${"This article is available directly from the publisher and contains enough readable prose to use without a remote reader. ".repeat(4)}</p></article></body></html>`;
const JINA_URL = `https://r.jina.ai/${ARTICLE_URL}`;
const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/scrape";

async function read(settings: Settings, transport: FetchImpl, signal?: AbortSignal) {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		fetch: transport,
	};
	const result = await fetchReadUrl(session, { path: ARTICLE_URL }, signal);
	return { method: result.details.method, content: result.content };
}

function articleResponse(): Response {
	return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
}

function notFound(): Response {
	return new Response(null, { status: 404 });
}

function withJina(handler: (init?: RequestInit) => Response | Promise<Response>): FetchImpl {
	return mockFetch((input, init) => {
		if (String(input) === ARTICLE_URL) return articleResponse();
		if (String(input) === JINA_URL) return handler(init);
		return notFound();
	});
}

function restoreKey(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}

function stall(signal: AbortSignal, onAbort?: () => void): Promise<Response> {
	const pending = Promise.withResolvers<Response>();
	const abort = () => {
		onAbort?.();
		pending.reject(signal.reason);
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	return pending.promise;
}

const jinaSettings = {
	"providers.fetch": "jina",
	"providers.webKeyless": true,
	"tools.maxTimeout": 1,
};

describe("read URL: Jina stall does not starve local fallback (#1449)", () => {
	it("returns the local article when Jina hangs until its deadline", async () => {
		let readerAborted = false;
		const transport = withJina(init => {
			if (!init?.signal) throw new Error("Jina request had no deadline");
			return stall(init.signal, () => {
				readerAborted = true;
			});
		});

		const result = await read(Settings.isolated(jinaSettings), transport);

		expect(readerAborted).toBe(true);
		expect(result.content).toContain("Fallback article");
		expect(result.method).not.toBe("jina");
	});

	it("rethrows a user abort while waiting for Jina instead of returning local content", async () => {
		const started = Promise.withResolvers<void>();
		const transport = withJina(init => {
			if (!init?.signal) throw new Error("Jina request had no abort signal");
			started.resolve();
			return stall(init.signal);
		});
		const controller = new AbortController();
		const pending = read(Settings.isolated(jinaSettings), transport, controller.signal);

		await Promise.race([started.promise, pending]);
		controller.abort();
		await expect(pending).rejects.toThrow(/abort/i);
	});
});

describe("read URL: Jina response validation", () => {
	it("sends JINA_API_KEY as optional bearer authentication", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		process.env.JINA_API_KEY = "env-jina-key";
		try {
			let authorization: string | null | undefined;
			const transport = withJina(init => {
				authorization = new Headers(init?.headers).get("authorization");
				return new Response(
					`Markdown Content:\n# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`,
				);
			});
			const result = await read(Settings.isolated(jinaSettings), transport);

			expect(result.method).toBe("jina");
			expect(authorization).toBe("Bearer env-jina-key");
		} finally {
			restoreKey("JINA_API_KEY", originalApiKey);
		}
	});

	it("uses a stored Jina credential when the environment key is absent", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		delete process.env.JINA_API_KEY;
		const tempDir = TempDir.createSync("@omp-jina-reader-auth-");
		try {
			const dbPath = path.join(tempDir.path(), "agent.db");
			const auth = await SqliteAuthCredentialStore.open(dbPath);
			try {
				await auth.saveApiKey("jina", "stored-jina-key");
			} finally {
				auth.close();
			}
			const storage = await AgentStorage.open(dbPath);
			let authorization: string | null | undefined;
			const transport = withJina(init => {
				authorization = new Headers(init?.headers).get("authorization");
				return new Response(
					`Markdown Content:\n# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`,
				);
			});
			const result = await read(Settings.isolated(jinaSettings, { storage }), transport);

			expect(result.method).toBe("jina");
			expect(authorization).toBe("Bearer stored-jina-key");
		} finally {
			AgentStorage.close();
			await tempDir.remove().catch(() => {});
			restoreKey("JINA_API_KEY", originalApiKey);
		}
	});

	it("never calls the keyless reader when providers.webKeyless is off", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		delete process.env.JINA_API_KEY;
		try {
			let jinaRequests = 0;
			const transport = withJina(() => {
				jinaRequests++;
				return notFound();
			});
			const result = await read(Settings.isolated({ ...jinaSettings, "providers.webKeyless": false }), transport);

			expect(jinaRequests).toBe(0);
			expect(result.content).toContain("Fallback article");
		} finally {
			restoreKey("JINA_API_KEY", originalApiKey);
		}
	});

	it("requests fresh markdown and strips the Jina metadata preamble", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		delete process.env.JINA_API_KEY;
		try {
			const markdown = `# Extracted article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			let requestHeaders: Headers | undefined;
			const transport = withJina(init => {
				requestHeaders = new Headers(init?.headers);
				return new Response(`Title: Example\nURL Source: ${ARTICLE_URL}\nMarkdown Content:\n${markdown}`);
			});
			const result = await read(Settings.isolated(jinaSettings), transport);

			expect(result).toEqual({ content: markdown, method: "jina" });
			expect(requestHeaders?.get("accept")).toBe("text/markdown");
			expect(requestHeaders?.get("x-no-cache")).toBe("true");
			expect(requestHeaders?.get("authorization")).toBeNull();
		} finally {
			restoreKey("JINA_API_KEY", originalApiKey);
		}
	});

	for (const { label, readerBody, headers } of [
		{ label: "missing marker", readerBody: "Plausible but unstructured output. ".repeat(8) },
		{ label: "short body", readerBody: "Markdown Content:\nToo short" },
		{ label: "loading shell", readerBody: `Markdown Content:\nLoading... ${"Content has not loaded. ".repeat(8)}` },
		{
			label: "JavaScript gate",
			readerBody: `Markdown Content:\nPlease enable JavaScript. ${"Content has not loaded. ".repeat(8)}`,
		},
		{
			label: "declared oversized body",
			readerBody: `Markdown Content:\n${"Substantive content. ".repeat(8)}`,
			headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
		},
	]) {
		it(`falls back when Jina returns a ${label}`, async () => {
			let requested = false;
			const transport = withJina(() => {
				requested = true;
				return new Response(readerBody, { headers });
			});
			const result = await read(Settings.isolated(jinaSettings), transport);

			expect(requested).toBe(true);
			expect(result.method).not.toBe("jina");
			expect(result.content).toContain("Fallback article");
		});
	}
});

describe("read URL: Firecrawl response validation", () => {
	it("falls back when Firecrawl's own fetch of the page got an error status", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			let firecrawlRequested = false;
			const transport = mockFetch(input => {
				if (String(input) === ARTICLE_URL) return articleResponse();
				if (String(input) !== FIRECRAWL_URL) return notFound();
				firecrawlRequested = true;
				return Response.json({
					success: true,
					data: {
						markdown: "The page you were looking for could not be found on this server. ".repeat(3),
						metadata: { statusCode: 404 },
					},
				});
			});
			const result = await read(
				Settings.isolated({ "providers.fetch": "firecrawl", "tools.maxTimeout": 1 }),
				transport,
			);

			expect(firecrawlRequested).toBe(true);
			expect(result.method).not.toBe("firecrawl");
			expect(result.content).toContain("Fallback article");
		} finally {
			restoreKey("FIRECRAWL_API_KEY", originalApiKey);
		}
	});

	it("tries the next remote reader when Firecrawl is served a block page", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const markdown = `# Extracted article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			const remoteCalls: string[] = [];
			const transport = mockFetch(input => {
				const url = String(input);
				if (url === ARTICLE_URL) {
					return new Response('<html><body><form><input type="hidden" name="js_challenge"></form></body></html>', {
						headers: { "content-type": "text/html" },
					});
				}
				if (url !== FIRECRAWL_URL && url !== JINA_URL) return notFound();
				remoteCalls.push(url);
				if (url === JINA_URL) return new Response(`Markdown Content:\n${markdown}`);
				return Response.json({
					success: true,
					data: {
						markdown:
							"You've been blocked by network security. To continue, log in to your account or use your developer token. If you think you've been blocked by mistake, file a ticket.",
						metadata: { statusCode: 200 },
					},
				});
			});
			const result = await read(Settings.isolated({ ...jinaSettings, "providers.fetch": "firecrawl" }), transport);

			expect(remoteCalls).toEqual([FIRECRAWL_URL, JINA_URL]);
			expect(result).toEqual({ content: markdown, method: "jina" });
		} finally {
			restoreKey("FIRECRAWL_API_KEY", originalApiKey);
		}
	});
});
