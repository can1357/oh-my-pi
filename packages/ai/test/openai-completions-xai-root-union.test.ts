import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface ChatCompletionsPayload {
	tool_choice?: unknown;
	tools?: Array<{ type?: string; function?: { name?: string; parameters?: { anyOf?: unknown } } }>;
}

const coverageTool: Tool = {
	name: "mcp__codebase_memory_check_index_coverage",
	description: "coverage",
	parameters: {
		type: "object",
		properties: {
			project: { type: "string" },
			paths: { type: "array", items: { type: "string" } },
			scopes: { type: "array", items: { type: "string" } },
		},
		required: ["project"],
		anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
	} as unknown as Tool["parameters"],
};

const leftoverTool: Tool = {
	name: "mcp__leftover_union",
	description: "union",
	parameters: {
		type: "object",
		properties: { kind: { type: "string" } },
		anyOf: [
			{ required: ["kind"], minProperties: 1 },
			{ required: ["kind"], minProperties: 2 },
		],
	} as unknown as Tool["parameters"],
};

const goodTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: type({ path: type("string") }),
};

function makeModel(provider: "openai" | "xai"): Model<"openai-completions"> {
	return buildModel({
		id: provider === "xai" ? "grok-4" : "gpt-4o-mini",
		name: provider === "xai" ? "Grok 4" : "GPT-4o Mini",
		api: "openai-completions",
		provider,
		baseUrl: provider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as ModelSpec<"openai-completions">);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	provider: "openai" | "xai",
	tools: Tool[],
	toolChoice?: ToolChoice,
): Promise<ChatCompletionsPayload> {
	const { promise, resolve } = Promise.withResolvers<ChatCompletionsPayload>();
	const context: Context = {
		messages: [{ role: "user", content: "check coverage", timestamp: 0 }],
		tools,
	};
	streamOpenAICompletions(makeModel(provider), context, {
		apiKey: "test-key",
		toolChoice,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ChatCompletionsPayload),
	});
	return promise;
}

function toolNames(payload: ChatCompletionsPayload): Array<string | undefined> {
	return payload.tools?.map(tool => tool.function?.name) ?? [];
}

describe("openai-completions xAI leftover-union quarantine", () => {
	it("keeps an exclusive-required MCP tool after xAI flatten on paid xAI", async () => {
		const payload = await capturePayload("xai", [coverageTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toBeUndefined();
	});

	it("preserves an exclusive-required MCP tool on OpenAI Completions", async () => {
		const payload = await capturePayload("openai", [coverageTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toHaveLength(2);
	});

	it("keeps a leftover object-root union on OpenAI Completions", async () => {
		const payload = await capturePayload("openai", [leftoverTool, goodTool]);
		expect(toolNames(payload)).toEqual(["mcp__leftover_union", "read_file"]);
		expect(payload.tools?.[0]?.function?.parameters?.anyOf).toHaveLength(2);
	});

	it("quarantines a leftover object-root union on paid xAI only", async () => {
		const payload = await capturePayload("xai", [leftoverTool, goodTool]);
		expect(toolNames(payload)).toEqual(["read_file"]);
	});

	it("drops a forced tool_choice when the leftover-union tool was quarantined", async () => {
		const payload = await capturePayload("xai", [leftoverTool, goodTool], {
			type: "tool",
			name: "mcp__leftover_union",
		});
		expect(toolNames(payload)).toEqual(["read_file"]);
		expect(payload.tool_choice).toBeUndefined();
	});
});
