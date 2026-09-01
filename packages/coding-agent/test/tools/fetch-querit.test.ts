import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "../helpers/fetch-mock";

const QUERIT_CONTENTS_URL = "https://api.querit.ai/v1/contents";
const MARKDOWN = `# Extracted article\n\n${"Substantive reader content. ".repeat(8)}`.trim();
const SHORT_HTML = "<html><body>short</body></html>";

function contentsResponse(content = MARKDOWN): Response {
	return new Response(
		JSON.stringify({
			error_code: 200,
			results: [{ url: "https://example.com/article", content }],
			statuses: [{ status: "success" }],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("renderHtmlToText: Querit contents reader", () => {
	it("POSTs /v1/contents with bearer auth and maps markdown content", async () => {
		const originalApiKey = process.env.QUERIT_API_KEY;
		process.env.QUERIT_API_KEY = "env-querit-key";
		try {
			const settings = Settings.isolated({ "providers.fetch": "querit" });
			let requestUrl: string | undefined;
			let requestInit: RequestInit | undefined;
			const fetchMock = asGlobalFetch((input, init) => {
				requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				requestInit = init;
				return contentsResponse();
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				SHORT_HTML,
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result).toEqual({ content: MARKDOWN, ok: true, method: "querit" });
			expect(requestUrl).toBe(QUERIT_CONTENTS_URL);
			expect(requestInit?.method).toBe("POST");
			expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer env-querit-key");
			expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
			expect(JSON.parse(String(requestInit?.body))).toEqual({
				urls: ["https://example.com/article"],
				format: "markdown",
				crawlTimeout: 1,
				extrasMeta: false,
			});
		} finally {
			if (originalApiKey === undefined) delete process.env.QUERIT_API_KEY;
			else process.env.QUERIT_API_KEY = originalApiKey;
		}
	});

	it("uses a stored Querit credential when the environment key is absent", async () => {
		const originalApiKey = process.env.QUERIT_API_KEY;
		delete process.env.QUERIT_API_KEY;
		const tempDir = TempDir.createSync("@omp-querit-reader-auth-");
		try {
			const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
			storage.replaceAuthCredentialsForProvider("querit", [{ type: "api_key", key: "stored-querit-key" }]);
			const settings = Settings.isolated({ "providers.fetch": "querit" });
			let requestHeaders: Headers | undefined;
			const fetchMock = asGlobalFetch((_input, init) => {
				requestHeaders = new Headers(init?.headers);
				return contentsResponse();
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				SHORT_HTML,
				1,
				settings,
				undefined,
				storage,
				fetchMock,
			);

			expect(result.method).toBe("querit");
			expect(requestHeaders?.get("authorization")).toBe("Bearer stored-querit-key");
		} finally {
			AgentStorage.close();
			await tempDir.remove().catch(() => {});
			if (originalApiKey === undefined) delete process.env.QUERIT_API_KEY;
			else process.env.QUERIT_API_KEY = originalApiKey;
		}
	});

	it("skips Querit without posting when no credential resolves", async () => {
		const originalApiKey = process.env.QUERIT_API_KEY;
		delete process.env.QUERIT_API_KEY;
		try {
			const settings = Settings.isolated({ "providers.fetch": "querit" });
			const paragraph =
				"This locally rendered article contains enough meaningful prose to satisfy the shared reader quality gate. ";
			const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
			let postedQuerit = false;
			const fetchMock = asGlobalFetch(input => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes("api.querit.ai")) postedQuerit = true;
				return new Response("not used", { status: 500 });
			});

			const result = await renderHtmlToText(
				"https://example.com/article",
				html,
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(postedQuerit).toBe(false);
			expect(result.ok).toBe(true);
			expect(result.method).not.toBe("querit");
		} finally {
			if (originalApiKey === undefined) delete process.env.QUERIT_API_KEY;
			else process.env.QUERIT_API_KEY = originalApiKey;
		}
	});

	it("falls back when Querit returns a failed envelope", async () => {
		const originalApiKey = process.env.QUERIT_API_KEY;
		process.env.QUERIT_API_KEY = "env-querit-key";
		try {
			const settings = Settings.isolated({ "providers.fetch": "querit" });
			const paragraph =
				"This locally rendered article contains enough meaningful prose to satisfy the shared reader quality gate. ";
			const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
			const fetchMock = asGlobalFetch(
				() =>
					new Response(JSON.stringify({ error_code: 403, error_msg: "No active contents subscription" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);

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
			expect(["native", "trafilatura", "lynx"]).toContain(result.method);
		} finally {
			if (originalApiKey === undefined) delete process.env.QUERIT_API_KEY;
			else process.env.QUERIT_API_KEY = originalApiKey;
		}
	});
});
