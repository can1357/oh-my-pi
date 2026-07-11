import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool, ToolChoice } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { z } from "zod/v4";

interface ChatCompletionsPayload {
	tool_choice?: unknown;
	tools?: Array<{ type?: string; function?: { name?: string } }>;
}

const resolveTool: Tool = {
	name: "resolve",
	description: "Apply or discard a pending preview",
	parameters: z.object({ action: z.enum(["apply", "discard"]), reason: z.string() }),
};

const context: Context = {
	messages: [{ role: "user", content: "Resolve the pending preview.", timestamp: 0 }],
	tools: [resolveTool],
};

const forcedResolve: ToolChoice = { type: "tool", name: "resolve" };

function model(overrides: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
		...overrides,
	} satisfies ModelSpec<"openai-completions">);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(target: Model<"openai-completions">): Promise<ChatCompletionsPayload> {
	const { promise, resolve } = Promise.withResolvers<ChatCompletionsPayload>();
	streamOpenAICompletions(target, context, {
		apiKey: "test-key",
		toolChoice: forcedResolve,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ChatCompletionsPayload),
	});
	return promise;
}

describe("issue #3593 — llama.cpp string-only tool_choice", () => {
	it("downgrades named forced tool_choice to required for llama.cpp", async () => {
		const payload = await capturePayload(model({}));

		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["resolve"]);
		expect(payload.tool_choice).toBe("required");
	});

	it("preserves OpenAI's named tool_choice object", async () => {
		const payload = await capturePayload(
			model({ provider: "openai", baseUrl: "https://api.openai.com/v1", id: "gpt-4o-mini", name: "GPT-4o mini" }),
		);

		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "resolve" } });
	});
});
