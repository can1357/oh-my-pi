import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchZai, ZaiProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/zai";

interface CapturedRequest {
	method: string | undefined;
	headers: Headers;
	body: Record<string, unknown>;
}

describe("Z.AI web search provider", () => {
	it("initializes a Streamable HTTP MCP session and parses doubly encoded results", async () => {
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
									text: JSON.stringify(
										JSON.stringify([
											{
												title: "Z.AI search result",
												content: "Search result content",
												link: "https://example.com/zai",
												media: "Example",
											},
										]),
									),
								},
								{
									type: "text",
									text: "Plain prose answer.",
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
		expect(response.answer).toBe("Plain prose answer.");
	});

	function createMcpFetch(): { fetchImpl: FetchImpl; capturedRequests: CapturedRequest[] } {
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
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify({ search_result: [] }) }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};
		return { fetchImpl, capturedRequests };
	}

	const authStorage = {
		resolver() {
			return async () => "zai-test-key";
		},
		hasAuth(provider: string) {
			return provider === "zai";
		},
	} as unknown as AuthStorage;

	function toolCallQuery(capturedRequests: CapturedRequest[]): unknown {
		const toolCall = capturedRequests.find(request => request.body.method === "tools/call");
		const params = toolCall?.body.params as { arguments?: { query?: unknown } } | undefined;
		return params?.arguments?.query;
	}

	it("rewrites directive queries into Bing-flavored operator syntax, dropping date bounds", async () => {
		const { fetchImpl, capturedRequests } = createMcpFetch();
		await new ZaiProvider().search({
			query: 'pytest "fixture scope" site:docs.pytest.org -inurl:changelog filetype:html after:2024-01-01',
			systemPrompt: "",
			authStorage,
			fetch: fetchImpl,
		});

		expect(toolCallQuery(capturedRequests)).toBe(
			'pytest "fixture scope" site:docs.pytest.org -inurl:changelog filetype:html',
		);
	});

	it("sends directive-free queries upstream byte-identical", async () => {
		const { fetchImpl, capturedRequests } = createMcpFetch();
		await new ZaiProvider().search({
			query: "latest bun release notes",
			systemPrompt: "",
			authStorage,
			fetch: fetchImpl,
		});

		expect(toolCallQuery(capturedRequests)).toBe("latest bun release notes");
	});
});
