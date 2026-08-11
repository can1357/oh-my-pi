import { describe, expect, it } from "bun:test";
import {
	complete,
	completeWithProgress,
	MCPProgressRegistry,
	serverSupportsCompletions,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import type { MCPCompletionResult } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport, createModernMockConnection } from "./mcp-test-utils";

const completion: MCPCompletionResult = {
	completion: { values: ["fusion-formal-law"], total: 1, hasMore: false },
};

const modernCompletion: MCPCompletionResult = {
	resultType: "complete",
	completion: completion.completion,
};

describe("MCP completion", () => {
	it("is capability-gated and preserves the protocol request shape", async () => {
		const unsupportedTransport = createMockTransport(new Map());
		const unsupported = createMockConnection({}, unsupportedTransport);
		expect(serverSupportsCompletions(unsupported.capabilities)).toBeFalse();
		expect(
			await complete(
				unsupported,
				{ type: "ref/resource", uri: "fugu://knowledge/{document}" },
				{ name: "document", value: "fusion" },
			),
		).toBeUndefined();

		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(new Map([["completion/complete", [completion]]]), (_method, params) => {
			requestParams = params;
		});
		const connection = createMockConnection({ completions: {} }, transport);
		const result = await complete(
			connection,
			{ type: "ref/resource", uri: "fugu://knowledge/{document}" },
			{ name: "document", value: "fusion" },
			{ arguments: { audience: "agent" } },
		);

		expect(result).toEqual(completion);
		expect(requestParams).toEqual({
			ref: { type: "ref/resource", uri: "fugu://knowledge/{document}" },
			argument: { name: "document", value: "fusion" },
			context: { arguments: { audience: "agent" } },
		});
	});

	it("routes unique progress tokens only while their request is active", async () => {
		const registry = new MCPProgressRegistry();
		const tokens: Array<string | number> = [];
		const updates: number[] = [];
		const transport = createMockTransport(
			new Map([["completion/complete", [modernCompletion, modernCompletion]]]),
			(_method, params) => {
				const token = (params?._meta as Record<string, unknown> | undefined)?.progressToken;
				if (typeof token !== "string" && typeof token !== "number") throw new Error("Expected progress token");
				tokens.push(token);
				registry.dispatch("notifications/progress", { progressToken: token, progress: tokens.length, total: 2 });
			},
		);
		const connection = createModernMockConnection({ completions: {} }, transport);

		await completeWithProgress(
			connection,
			{ type: "ref/resource", uri: "fugu://knowledge/{document}" },
			{ name: "document", value: "fusion" },
			registry,
			update => updates.push(update.progress),
		);
		await completeWithProgress(
			connection,
			{ type: "ref/resource", uri: "fugu://knowledge/{document}" },
			{ name: "document", value: "fusion" },
			registry,
			update => updates.push(update.progress),
		);

		expect(tokens).toHaveLength(2);
		expect(tokens[0]).not.toBe(tokens[1]);
		expect(updates).toEqual([1, 2]);
		expect(registry.size).toBe(0);
		expect(registry.dispatch("notifications/progress", { progressToken: tokens[0], progress: 3 })).toBeFalse();
	});

	it("rejects malformed completion payloads", async () => {
		const transport = createMockTransport(new Map([["completion/complete", [{ completion: { values: [1] } }]]]));
		const connection = createMockConnection({ completions: {} }, transport);
		await expect(
			complete(
				connection,
				{ type: "ref/prompt", name: "review_rqgm_candidate" },
				{ name: "candidate", value: "candidate" },
			),
		).rejects.toThrow("completion.values");
	});
});
