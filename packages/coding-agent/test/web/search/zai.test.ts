import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { searchZai } from "@pk-nerdsaver-ai/pi-coding-agent/web/search/providers/zai";

interface CapturedRequest {
	method: string | undefined;
	headers: Headers;
	body: Record<string, unknown>;
}

describe("Z.AI web search provider", () => {
	it("initializes a Streamable HTTP MCP session before calling web_search_prime", async () => {
		const capturedRequests: CapturedRequest[] = [];
		const fetchImpl: FetchImpl = (_input, init) => {
			const request = {
				method: init?.method,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			capturedRequests.push(request);

			if (request.body.method === "initialize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: request.body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "zai-web-search", version: "test" },
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json", "Mcp-Session-Id": "zai-session-1" },
						},
					),
				);
			}

			if (request.body.method === "notifications/initialized") {
				return Promise.resolve(new Response(null, { status: 202 }));
			}

			expect(request.body.method).toBe("tools/call");
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										search_result: [
											{
												title: "Z.AI search result",
												content: "Search result content",
												link: "https://example.com/zai",
												media: "Example",
											},
										],
									}),
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string }) {
				expect(provider).toBe("zai");
				expect(options?.sessionId).toBe("session-zai-test");
				return async () => "zai-test-key";
			},
			hasAuth(provider: string) {
				return provider === "zai";
			},
		} as unknown as AuthStorage;

		const response = await searchZai({
			query: "omp z.ai search",
			authStorage,
			fetch: fetchImpl,
			sessionId: "session-zai-test",
		});

		expect(capturedRequests.map(request => request.body.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect(capturedRequests[0]?.headers.get("Authorization")).toBe("Bearer zai-test-key");
		expect(capturedRequests[1]?.headers.get("Mcp-Session-Id")).toBe("zai-session-1");
		expect(capturedRequests[2]?.headers.get("Mcp-Session-Id")).toBe("zai-session-1");
		expect(response.sources).toEqual([
			{
				title: "Z.AI search result",
				url: "https://example.com/zai",
				snippet: "Search result content",
				publishedDate: undefined,
				ageSeconds: undefined,
				author: "Example",
			},
		]);
	});
});
