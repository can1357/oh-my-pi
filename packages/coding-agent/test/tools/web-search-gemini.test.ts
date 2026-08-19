import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";
import { searchGemini } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/gemini";

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-3.7-flash"}}\n\n';

type CapturedRequest = {
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	function mockGeminiFetch(): FetchImpl {
		capturedRequest = null;
		return (_url, init) => {
			capturedRequest = {
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(SSE_RESPONSE, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		capturedRequest = null;
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.model).toBe("gemini-3.7-flash");
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});
});
