import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"ollama-chat"> = buildModel({
	id: "qwen3.6-coder:27b",
	name: "Qwen 3.6 Coder 27B",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 8192,
});

const context: Context = {
	messages: [{ role: "user", content: "Use bash to run a Python command.", timestamp: 0 }],
};

const llamaToolParseFailure = JSON.stringify({
	error: {
		code: 500,
		message:
			"Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 557: syntax error while parsing value - invalid string: missing closing quote; last read: '\"uv run python -c \\\"\\nimport jax.numpy as jnp\\nimport'",
	},
});

describe("Ollama malformed tool-call JSON errors", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not retry deterministic llama.cpp tool argument parse failures", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let calls = 0;
		const fetchMock = async () => {
			calls += 1;
			return new Response(llamaToolParseFailure, { status: 500 });
		};

		const result = await streamOllama(model, context, {
			apiKey: "ollama",
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(500);
		expect(result.errorMessage).toContain("Local Ollama model emitted malformed tool-call JSON");
		expect(result.errorMessage).toContain("reload the model");
	});

	it("strips Transient so agent-level auto-retry will not replay the deterministic failure", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const fetchMock = async () => new Response(llamaToolParseFailure, { status: 500 });

		const result = await streamOllama(model, context, {
			apiKey: "ollama",
			fetch: fetchMock,
		}).result();

		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(result.errorId)).toBe(false);
	});
});
