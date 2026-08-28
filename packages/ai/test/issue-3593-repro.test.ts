import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ModelSpec, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface ChatCompletionsPayload {
	tool_choice?: unknown;
	tools?: Array<{ type?: string; function?: { name?: string } }>;
}

interface ResponsesPayload {
	tool_choice?: unknown;
	tools?: Array<{ type?: string; name?: string }>;
}

const resolveTool: Tool = {
	name: "resolve",
	description: "Apply or discard a pending preview",
	parameters: type({ action: type.enumeration(["apply", "discard"]), reason: type("string") }),
};

const todoTool: Tool = {
	name: "todo",
	description: "Track work items",
	parameters: type({ note: type("string") }),
};

const multiToolContext: Context = {
	messages: [{ role: "user", content: "Inspect this project.", timestamp: 0 }],
	tools: [todoTool, resolveTool],
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

function responsesModel(overrides: Partial<ModelSpec<"openai-responses">>): Model<"openai-responses"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-responses",
		provider: "lm-studio",
		baseUrl: "http://127.0.0.1:1234/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
		...overrides,
	} satisfies ModelSpec<"openai-responses">);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	target: Model<"openai-completions">,
	overrides?: { context?: Context; toolChoice?: ToolChoice },
): Promise<ChatCompletionsPayload> {
	const { promise, resolve } = Promise.withResolvers<ChatCompletionsPayload>();
	streamOpenAICompletions(target, overrides?.context ?? context, {
		apiKey: "test-key",
		toolChoice: overrides?.toolChoice ?? forcedResolve,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ChatCompletionsPayload),
	});
	return promise;
}

function captureResponsesPayload(
	target: Model<"openai-responses">,
	requestContext: Context,
	toolChoice: ToolChoice,
): Promise<ResponsesPayload> {
	const { promise, resolve } = Promise.withResolvers<ResponsesPayload>();
	streamOpenAIResponses(target, requestContext, {
		apiKey: "test-key",
		toolChoice,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ResponsesPayload),
	});
	return promise;
}

describe("issues #3593 and #6925 — string-only tool_choice hosts", () => {
	it.each([
		["llama.cpp", "http://localhost:8080/v1"],
		["lm-studio", "http://127.0.0.1:1234/v1"],
	])("downgrades named forced tool_choice to required for %s", async (provider, baseUrl) => {
		const payload = await capturePayload(model({ provider, baseUrl }));

		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["resolve"]);
		expect(payload.tool_choice).toBe("required");
	});

	it.each([
		["llama.cpp", "http://localhost:8080/v1"],
		["lm-studio", "http://127.0.0.1:1234/v1"],
	])("drops the forced choice for %s when the named tool is absent", async (provider, baseUrl) => {
		const payload = await capturePayload(model({ provider, baseUrl }), {
			context: { messages: context.messages, tools: [] },
			toolChoice: { type: "tool", name: "resolve" },
		});

		expect(payload.tool_choice).toBeUndefined();
	});

	it.each([
		["llama.cpp", "http://localhost:8080/v1"],
		["lm-studio", "http://127.0.0.1:1234/v1"],
	])("narrows the advertised tools to the forced one for %s", async (provider, baseUrl) => {
		const payload = await capturePayload(model({ provider, baseUrl }), {
			context: multiToolContext,
			toolChoice: { type: "tool", name: "todo" },
		});

		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["todo"]);
		expect(payload.tool_choice).toBe("required");
	});

	it("keeps every tool for OpenAI's named object, without narrowing", async () => {
		const payload = await capturePayload(
			model({ provider: "openai", baseUrl: "https://api.openai.com/v1", id: "gpt-4o-mini", name: "GPT-4o mini" }),
			{ context: multiToolContext, toolChoice: { type: "tool", name: "todo" } },
		);

		expect(payload.tools?.map(tool => tool.function?.name)).toEqual(["todo", "resolve"]);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "todo" } });
	});

	it("preserves OpenAI's named tool_choice object", async () => {
		const payload = await capturePayload(
			model({ provider: "openai", baseUrl: "https://api.openai.com/v1", id: "gpt-4o-mini", name: "GPT-4o mini" }),
		);

		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "resolve" } });
	});
});

describe("issue #6925 — LM Studio Responses string-only tool_choice", () => {
	it("narrows the advertised tools before downgrading the named choice", async () => {
		const payload = await captureResponsesPayload(responsesModel({}), multiToolContext, {
			type: "tool",
			name: "todo",
		});

		expect(payload.tools?.map(tool => tool.name)).toEqual(["todo"]);
		expect(payload.tool_choice).toBe("required");
	});

	it("keeps every tool and drops the choice when the named tool is absent", async () => {
		const payload = await captureResponsesPayload(responsesModel({}), multiToolContext, {
			type: "tool",
			name: "missing",
		});

		expect(payload.tools?.map(tool => tool.name)).toEqual(["todo", "resolve"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("preserves OpenAI's named object and full tool catalogue", async () => {
		const payload = await captureResponsesPayload(
			responsesModel({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
			}),
			multiToolContext,
			{ type: "tool", name: "todo" },
		);

		expect(payload.tools?.map(tool => tool.name)).toEqual(["todo", "resolve"]);
		expect(payload.tool_choice).toEqual({ type: "function", name: "todo" });
	});
});
