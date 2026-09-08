import { describe, expect, it } from "bun:test";
import { applyParsedGatewayOptions } from "@oh-my-pi/pi-ai/auth-gateway";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import type { OpenAIResponsesOptions } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

describe("applyParsedGatewayOptions", () => {
	it("forwards previousResponseId and parallelToolCalls onto SimpleStreamOptions", () => {
		const opts: SimpleStreamOptions = {};
		applyParsedGatewayOptions(opts, {
			previousResponseId: "resp_client_123",
			parallelToolCalls: false,
		});
		expect(opts.previousResponseId).toBe("resp_client_123");
		expect(opts.parallelToolCalls).toBe(false);
	});

	it("does not drop seed, logitBias, user, or responseFormat", () => {
		const opts: SimpleStreamOptions = {};
		applyParsedGatewayOptions(opts, {
			seed: 7,
			logitBias: { "42": -1 },
			user: "acct_1",
			responseFormat: { type: "json_object" },
		});
		expect(opts.seed).toBe(7);
		expect(opts.logitBias).toEqual({ "42": -1 });
		expect(opts.user).toBe("acct_1");
		expect(opts.responseFormat).toEqual({ type: "json_object" });
	});

	it("carries native text.format from parse to provider wire end to end", () => {
		const parsed = parseRequest({
			model: "gpt-test",
			input: "hi",
			text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
		});
		const opts: SimpleStreamOptions & OpenAIResponsesOptions = {};
		applyParsedGatewayOptions(opts, parsed.options);
		const model = buildModel({
			api: "openai-responses",
			name: "gpt-test",
			id: "gpt-test",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const { params } = buildParams(model, parsed.context, opts, undefined);
		expect(params.text?.format).toEqual({
			type: "json_schema",
			name: "answer",
			schema: { type: "object" },
			strict: true,
		});
	});

	it("does not invent fields that were omitted (negative)", () => {
		const opts: SimpleStreamOptions = { temperature: 0.2 };
		applyParsedGatewayOptions(opts, { temperature: 0.9 });
		expect(opts.previousResponseId).toBeUndefined();
		expect(opts.parallelToolCalls).toBeUndefined();
		expect(opts.temperature).toBe(0.2);
	});
});
