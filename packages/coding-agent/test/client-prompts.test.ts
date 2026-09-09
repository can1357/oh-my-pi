import { describe, expect, it } from "bun:test";
import { getPrompt, listPrompts, serverSupportsPrompts } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPGetPromptResult, MCPPrompt, MCPPromptsListResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

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
