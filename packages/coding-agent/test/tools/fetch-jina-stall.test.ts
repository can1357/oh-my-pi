import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

/**
 * Regression test for #1449: a stalled Jina reader request must not prevent
 * local fallback renderers (trafilatura/lynx/native) from running within the
 * overall reader-mode budget.
 */
describe("renderHtmlToText: jina stall does not starve local fallbacks (#1449)", () => {
	it("falls back to native renderer when jina hangs until aborted", async () => {
		// Force jina first so the stall path is actually exercised before the
		// native fallback runs.
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		// Substantive HTML so the native converter produces >100 chars and
		// `isLowQualityOutput` does not reject it.
		const paragraphs = Array.from(
			{ length: 6 },
			(_, i) =>
				`<p>Paragraph number ${i + 1} carries some real content for the article body so the native renderer has enough text to satisfy the length threshold.</p>`,
		).join("");
		const html = `<!doctype html><html><head><title>Example</title></head><body><article><h1>Example article</h1>${paragraphs}</article></body></html>`;

		const fetchMock = asGlobalFetch((input, init) => {
			const url = String(input);
			if (url.startsWith("https://r.jina.ai/")) {
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					if (signal.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					signal.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			}
			return new Response("", { status: 404 });
		});

		// A short real budget is intentional: the combined AbortSignal clock is
		// the behavior under test, and fake timers do not drive it reliably.
		const result = await renderHtmlToText(
			"https://example.com/article",
			html,
			0.05,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result.ok).toBe(true);
		expect(["native", "trafilatura", "lynx"]).toContain(result.method);
	});

	it("re-throws when the user signal is aborted, not when Jina sub-budget expires", async () => {
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		const html = "<html><body><p>short</p></body></html>";

		const fetchMock2 = asGlobalFetch((_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) {
					reject(new DOMException("aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});

		const controller = new AbortController();
		const pending = renderHtmlToText(
			"https://example.com/article",
			html,
			30,
			settings,
			controller.signal,
			null,
			fetchMock2,
		).catch(err => err);

		controller.abort();
		const outcome = await pending;
		expect(outcome).toBeInstanceOf(Error);
		expect(
			(outcome as Error).name === "AbortError" || (outcome as Error).message.toLowerCase().includes("abort"),
		).toBe(true);
	});
});

describe("renderHtmlToText: Jina response validation", () => {
	it("sends JINA_API_KEY as optional bearer authentication", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		process.env.JINA_API_KEY = "env-jina-key";
		try {
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			let requestHeaders: Headers | undefined;
			const markdown = `# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			const fetchMock = asGlobalFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response(`Markdown Content:\n${markdown}`);
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				"<html><body>short</body></html>",
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result.method).toBe("jina");
			expect(requestHeaders?.get("authorization")).toBe("Bearer env-jina-key");
		} finally {
			if (originalApiKey === undefined) delete process.env.JINA_API_KEY;
			else process.env.JINA_API_KEY = originalApiKey;
		}
	});

	it("uses a stored Jina credential when the environment key is absent", async () => {
		const originalApiKey = process.env.JINA_API_KEY;
		delete process.env.JINA_API_KEY;
		const tempDir = TempDir.createSync("@omp-jina-reader-auth-");
		try {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
			storage.replaceAuthCredentialsForProvider("jina", [{ type: "api_key", key: "stored-jina-key" }]);
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			let requestHeaders: Headers | undefined;
			const markdown = `# Authenticated article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
			const fetchMock = asGlobalFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return new Response(`Markdown Content:\n${markdown}`);
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				"<html><body>short</body></html>",
				1,
				settings,
				undefined,
				storage,
				fetchMock,
			);

			expect(result.method).toBe("jina");
			expect(requestHeaders?.get("authorization")).toBe("Bearer stored-jina-key");
		} finally {
			AgentStorage.close();
			await tempDir.remove().catch(() => {});
			if (originalApiKey === undefined) delete process.env.JINA_API_KEY;
			else process.env.JINA_API_KEY = originalApiKey;
		}
	});

	it("requests fresh markdown and strips the Jina metadata preamble", async () => {
		const settings = Settings.isolated({ "providers.fetch": "jina" });
		const markdown = `# Extracted article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
		let requestHeaders: Headers | undefined;
		const fetchMock = asGlobalFetch((_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(`Title: Example\nURL Source: https://example.com/article\nMarkdown Content:\n${markdown}`);
		});

		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body>short</body></html>",
			1,
			settings,
			undefined,
			null,
			fetchMock,
		);

		expect(result).toEqual({ content: markdown, ok: true, method: "jina" });
		expect(requestHeaders?.get("accept")).toBe("text/markdown");
		expect(requestHeaders?.get("x-no-cache")).toBe("true");
		expect(requestHeaders?.get("authorization")).toBeNull();
	});

	for (const { label, readerBody, headers } of [
		{ label: "missing marker", readerBody: "Plausible but unstructured output. ".repeat(8) },
		{ label: "short body", readerBody: "Markdown Content:\nToo short" },
		{ label: "loading shell", readerBody: `Markdown Content:\nLoading...${" ".repeat(120)}` },
		{ label: "JavaScript gate", readerBody: `Markdown Content:\nPlease enable JavaScript${" ".repeat(120)}` },
		{
			label: "declared oversized body",
			readerBody: `Markdown Content:\n${"Substantive content. ".repeat(8)}`,
			headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
		},
	]) {
		it(`falls back when Jina returns a ${label}`, async () => {
			const settings = Settings.isolated({ "providers.fetch": "jina" });
			const paragraph =
				"This locally rendered article contains enough meaningful prose to satisfy the shared reader quality gate. ";
			const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
			const fetchMock = asGlobalFetch(() => new Response(readerBody, { headers }));

			const result = await renderHtmlToText(
				"https://example.com/article",
				html,
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result.ok).toBe(true);
			expect(result.method).toBe("native");
			expect(result.content).toContain("Fallback article");
		});
	}
});
