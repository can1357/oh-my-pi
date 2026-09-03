import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

function contextWithTools(tools: Tool[] = [echoTool]): Context {
	return {
		messages: [{ role: "user", content: "call tool", timestamp: Date.now() }],
		tools,
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface CaptureOptions {
	tools?: Tool[];
	reasoning?: Effort;
	disableReasoning?: boolean;
}

async function capturePayload(
	model: Model<"openai-completions">,
	options: CaptureOptions = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, contextWithTools(options.tools), {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning: options.disableReasoning ? undefined : (options.reasoning ?? Effort.High),
		disableReasoning: options.disableReasoning,
		toolChoice: "auto",
		maxTokens: 123,
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

function customDeepseekFlash(legacyThinkingExtraBody = false): Model<"openai-completions"> {
	return buildModel({
		...getBundledModel("openai", "gpt-4o-mini"),
		api: "openai-completions",
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		provider: "ds",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			reasoningEffortMap: { xhigh: "max" },
			...(legacyThinkingExtraBody ? { extraBody: { thinking: { type: "enabled" } } } : {}),
		},
	} as ModelSpec<"openai-completions">);
}

describe("issue #1207 — DeepSeek V4 keeps reasoning with tools", () => {
	it("detects the documented direct DeepSeek V4 compat shape", () => {
		const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;

		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.maxTokensField).toBe("max_tokens");
		expect(compat.extraBody).toBeUndefined();
		expect(compat.reasoningDisableMode).toBe("zai-thinking-disabled");
		expect(compat.whenThinking?.extraBody).toEqual({ thinking: { type: "enabled" } });
		// DeepSeek V4 Flash's reasoning_effort is the honest wire-exact
		// low/high/max ladder (#7668); no synthetic tiers, no alias map.
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("drops user reasoning map entries outside the honest DeepSeek ladder", () => {
		const model = customDeepseekFlash();

		expect(model.compat.supportsToolChoice).toBe(false);
		// The stale user `xhigh` alias targets a tier the wire-exact
		// [low, high, max] flash ladder does not expose, so it is filtered out.
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
	});

	it("omits tool_choice but preserves documented reasoning when tools are present", async () => {
		const body = await capturePayload(customDeepseekFlash());

		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toEqual({ type: "enabled" });
		expect(body.max_tokens).toBe(123);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("disables thinking for bundled and legacy cached model definitions", async () => {
		const bundled = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
		const legacyCached = customDeepseekFlash(true);

		for (const model of [bundled, legacyCached]) {
			const body = await capturePayload(model, { disableReasoning: true });
			expect(model.compat.extraBody).toBeUndefined();
			expect(body.reasoning_effort).toBeUndefined();
			expect(body.thinking).toEqual({ type: "disabled" });
		}
	});

	it("does not mix Fireworks DeepSeek effort with the native thinking toggle", async () => {
		const model = getBundledModel("fireworks", "deepseek-v4-pro") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.extraBody).toBeUndefined();
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.thinking).toBeUndefined();
		expect(body.max_tokens).toBe(123);
	});

	it("preserves OpenRouter reasoning when tool_choice auto is present", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const compat = model.compat;
		const body = await capturePayload(model);

		expect(compat.disableReasoningOnToolChoice).toBe(false);
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("does not nest anyOf branches in OpenRouter DeepSeek tool schemas", async () => {
		const model = getBundledModel("openrouter", "deepseek/deepseek-v4-flash") as Model<"openai-completions">;
		const unionTool: Tool = {
			name: "union_repro",
			description: "Union schema repro",
			parameters: type({
				paths: "(string | string[])?",
			}),
		};
		const body = await capturePayload(model, { tools: [unionTool] });
		const tools = body.tools as Array<{ function: { parameters: Record<string, unknown> } }>;
		const properties = tools[0].function.parameters.properties as Record<string, Record<string, unknown>>;
		const branches = properties.paths.anyOf as Array<Record<string, unknown>>;

		expect(branches.map(branch => branch.type)).toEqual(["string", "array", "null"]);
		expect(branches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});
});
