import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

const context: Context = {
	messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
	tools: [echoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(
	model: Model<"openai-completions">,
	opts: OpenAICompletionsOptions,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

async function captureResponsesPayload(
	model: Model<"openai-responses">,
	opts: OpenAIResponsesOptions,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(model, context, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

describe("OpenCode Go tool_choice compatibility", () => {
	it("marks deepseek-v4-pro as not supporting tool_choice via compat override", () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro") as Model<"openai-completions">;
		expect(model.compat?.supportsToolChoice).toBe(false);
	});

	it("omits forced tool_choice from DeepSeek Flash Responses payloads while preserving tools", async () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-responses">;
		expect(model.compat.supportsToolChoice).toBe(false);
		const body = await captureResponsesPayload(model, {
			toolChoice: { type: "tool", name: "echo" },
		});
		expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "echo" })]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("marks mimo-v2.5-pro as not supporting tool_choice via compat override", () => {
		const model = getBundledModel("opencode-go", "mimo-v2.5-pro") as Model<"openai-completions">;
		expect(model.compat?.supportsToolChoice).toBe(false);
	});

	it("omits tool_choice from MiMo title-style payloads while preserving tools", async () => {
		const model = getBundledModel("opencode-go", "mimo-v2.5-pro") as Model<"openai-completions">;
		const body = await capturePayload(model, { reasoning: "high", toolChoice: { type: "tool", name: "echo" } });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});

	it("omits tool_choice from DeepSeek payloads but preserves tools and reasoning_effort", async () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro") as Model<"openai-completions">;
		const body = await capturePayload(model, { reasoning: "high", toolChoice: "auto" });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});
});
