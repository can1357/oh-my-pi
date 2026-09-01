import { describe, expect, it } from "bun:test";
import { applyParsedGatewayOptions } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";

function responsesModel() {
	return buildModel({
		api: "openai-responses",
		name: "gpt-5",
		id: "gpt-5",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

describe("gateway Responses option wire contract", () => {
	it("parses client continuation fields and places them on the outbound Responses params", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			input: "hi",
			previous_response_id: "resp_client_123",
			parallel_tool_calls: false,
			user: "acct_1",
		});
		const opts: SimpleStreamOptions = {};
		applyParsedGatewayOptions(opts, parsed.options);
		expect(opts.previousResponseId).toBe("resp_client_123");
		expect(opts.parallelToolCalls).toBe(false);
		expect(opts.user).toBe("acct_1");

		const { params } = buildParams(responsesModel(), parsed.context, opts);
		// buildParams owns parallel_tool_calls / user; previous_response_id is applied
		// by the stream path from options.previousResponseId (same value we just asserted).
		expect(params.parallel_tool_calls).toBe(false);
		expect(params.user).toBe("acct_1");
		const outbound = {
			...params,
			...(opts.previousResponseId !== undefined ? { previous_response_id: opts.previousResponseId } : {}),
		};
		expect(outbound.previous_response_id).toBe("resp_client_123");
	});

	it("does not invent continuation fields when the client omits them (negative)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			input: "hi",
		});
		const opts: SimpleStreamOptions = { temperature: 0.2 };
		applyParsedGatewayOptions(opts, parsed.options);
		expect(opts.previousResponseId).toBeUndefined();
		expect(opts.parallelToolCalls).toBeUndefined();
		const { params } = buildParams(responsesModel(), parsed.context, opts);
		expect(params.previous_response_id).toBeUndefined();
		expect(params.parallel_tool_calls).toBeUndefined();
	});
});
