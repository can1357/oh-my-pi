import { describe, expect, it } from "bun:test";
import { getPrompt, listPrompts, serverSupportsPrompts } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import type { MCPGetPromptResult, MCPPrompt, MCPPromptsListResult } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport, createModernMockConnection } from "./mcp-test-utils";

describe("listPrompts", () => {
	it("returns empty array when server does not support prompts", async () => {
		const transport = createMockTransport(new Map());
		const conn = createMockConnection({}, transport);
		const result = await listPrompts(conn);
		expect(result).toEqual([]);
	});

	it("fetches and caches prompts on first call", async () => {
		const prompts: MCPPrompt[] = [
			{ name: "greet", description: "Greeting prompt" },
			{ name: "summarize", description: "Summarize text" },
		];
		const responses = new Map<string, unknown[]>([
			["prompts/list", [{ prompts, nextCursor: undefined } satisfies MCPPromptsListResult]],
		]);
		const transport = createMockTransport(responses);
		const conn = createMockConnection({ prompts: {} }, transport);

		const result = await listPrompts(conn);
		expect(result).toEqual(prompts);
		expect(conn.prompts).toEqual(prompts);
	});

	it("returns cached prompts on second call", async () => {
		const prompts: MCPPrompt[] = [{ name: "cached-prompt" }];
		const responses = new Map<string, unknown[]>([
			["prompts/list", [{ prompts, nextCursor: undefined } satisfies MCPPromptsListResult]],
		]);
		const transport = createMockTransport(responses);
		const conn = createMockConnection({ prompts: {} }, transport);

		const first = await listPrompts(conn);
		const second = await listPrompts(conn);
		expect(first).toEqual(prompts);
		expect(second).toBe(first);
	});

	it("handles pagination", async () => {
		const page1: MCPPrompt[] = [{ name: "prompt-a" }, { name: "prompt-b" }];
		const page2: MCPPrompt[] = [{ name: "prompt-c" }];
		const responses = new Map<string, unknown[]>([
			[
				"prompts/list",
				[
					{ prompts: page1, nextCursor: "cursor-1" } satisfies MCPPromptsListResult,
					{ prompts: page2, nextCursor: undefined } satisfies MCPPromptsListResult,
				],
			],
		]);
		const transport = createMockTransport(responses);
		const conn = createMockConnection({ prompts: {} }, transport);

		const result = await listPrompts(conn);
		expect(result).toEqual([...page1, ...page2]);
	});

	it("requires modern cache hints and does not retain zero-TTL prompt lists", async () => {
		let requests = 0;
		const zeroTtl = {
			resultType: "complete",
			ttlMs: 0,
			cacheScope: "public",
			prompts: [{ name: "volatile" }],
		};
		const zeroConnection = createModernMockConnection(
			{ prompts: {} },
			createMockTransport(new Map([["prompts/list", [zeroTtl, zeroTtl]]]), () => requests++),
		);
		await listPrompts(zeroConnection);
		await listPrompts(zeroConnection);
		expect(requests).toBe(2);
		expect(zeroConnection.prompts).toBeUndefined();

		const missingConnection = createModernMockConnection(
			{ prompts: {} },
			createMockTransport(new Map([["prompts/list", [{ resultType: "complete", prompts: [] }]]])),
		);
		await expect(listPrompts(missingConnection)).rejects.toThrow("ttlMs");
	});
});

describe("getPrompt", () => {
	it("sends prompts/get with name", async () => {
		const mockResult: MCPGetPromptResult = {
			description: "A greeting",
			messages: [{ role: "user", content: { type: "text", text: "Hello!" } }],
		};
		const responses = new Map<string, unknown[]>([["prompts/get", [mockResult]]]);
		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(responses, (_method, params) => {
			requestParams = params;
		});
		const conn = createMockConnection({ prompts: {} }, transport);

		const result = await getPrompt(conn, "greet");
		expect(result).toEqual(mockResult);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("user");
		expect(requestParams).toEqual({ name: "greet" });
	});

	it("sends arguments when provided", async () => {
		const mockResult: MCPGetPromptResult = {
			messages: [{ role: "assistant", content: { type: "text", text: "const x = 1" } }],
		};
		const responses = new Map<string, unknown[]>([["prompts/get", [mockResult]]]);
		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(responses, (_method, params) => {
			requestParams = params;
		});
		const conn = createMockConnection({ prompts: {} }, transport);

		const args = { code: "const x = 1" };
		const result = await getPrompt(conn, "review-code", args);
		expect(result).toEqual(mockResult);
		expect(requestParams).toEqual({ name: "review-code", arguments: args });
		expect(requestParams?.arguments).toBe(args);
	});

	it("sends without arguments when args is empty object", async () => {
		const mockResult: MCPGetPromptResult = {
			messages: [{ role: "user", content: { type: "text", text: "No args" } }],
		};
		const responses = new Map<string, unknown[]>([["prompts/get", [mockResult]]]);
		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(responses, (_method, params) => {
			requestParams = params;
		});
		const conn = createMockConnection({ prompts: {} }, transport);

		const result = await getPrompt(conn, "no-args-prompt", {});
		expect(result).toEqual(mockResult);
		expect(requestParams).toEqual({ name: "no-args-prompt" });
	});

	it("sends without arguments when args is undefined", async () => {
		const mockResult: MCPGetPromptResult = {
			messages: [{ role: "user", content: { type: "text", text: "No args" } }],
		};
		const responses = new Map<string, unknown[]>([["prompts/get", [mockResult]]]);
		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(responses, (_method, params) => {
			requestParams = params;
		});
		const conn = createMockConnection({ prompts: {} }, transport);

		const result = await getPrompt(conn, "no-args-prompt", undefined);
		expect(result).toEqual(mockResult);
		expect(requestParams).toEqual({ name: "no-args-prompt" });
	});

	it("requires a complete modern result but does not cache prompts/get", async () => {
		let requests = 0;
		const complete = {
			resultType: "complete" as const,
			_meta: { "com.example/prompt": "preserved" },
			messages: [{ role: "user" as const, content: { type: "text" as const, text: "Modern" } }],
		};
		const connection = createModernMockConnection(
			{ prompts: {} },
			createMockTransport(new Map([["prompts/get", [complete, complete]]]), () => requests++),
		);
		const first = await getPrompt(connection, "modern");
		const second = await getPrompt(connection, "modern");
		expect(first._meta).toBe(complete._meta);
		expect(second).toBe(complete);
		expect(requests).toBe(2);

		const malformed = createModernMockConnection(
			{ prompts: {} },
			createMockTransport(
				new Map([["prompts/get", [{ messages: [{ role: "user", content: { type: "text", text: "missing" } }] }]]]),
			),
		);
		await expect(getPrompt(malformed, "missing")).rejects.toThrow("resultType");
	});
});

describe("serverSupportsPrompts", () => {
	it("returns true when prompts capability exists", () => {
		expect(serverSupportsPrompts({ prompts: {} })).toBe(true);
		expect(serverSupportsPrompts({ prompts: { listChanged: true } })).toBe(true);
	});

	it("returns false when prompts capability is absent", () => {
		expect(serverSupportsPrompts({})).toBe(false);
		expect(serverSupportsPrompts({ tools: {} })).toBe(false);
	});
});
