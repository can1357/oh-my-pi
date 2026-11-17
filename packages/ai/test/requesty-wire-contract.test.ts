/**
 * Wire contract for Requesty's chat endpoint, pinned to production behavior
 * (https://docs.requesty.ai/features/reasoning, .../features/web-search):
 *
 *  - The request schema accepts `low`/`medium`/`high`/`xhigh` plus Requesty's
 *    own `min`/`max`/`none`, and rejects the OpenAI tier name `minimal` for
 *    every model with a router-level 400 ("Invalid request").
 *  - On Gemini models Requesty swaps a function tool named `web_search` for
 *    Google's native search: alone the call never reaches the client, beside
 *    other function tools Google 400s ("enable
 *    tool_config.include_server_side_tool_invocations"). Prefixed names
 *    (`_web_search`) stay ordinary function tools. GPT and Claude rows are
 *    unaffected and keep their tool names.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	OptionsForApi,
	Tool,
	ToolCall,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const REQUESTY_BASE_URL = "https://router.requesty.ai/v1";

function requestyModel(
	id: string,
	overrides: Partial<ModelSpec<"openai-completions">> = {},
): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "requesty",
		baseUrl: REQUESTY_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		...overrides,
	});
}

const tools: Tool[] = [
	{ name: "read", description: "Read a file", parameters: type({ path: "string" }) },
	{ name: "web_search", description: "Search the web", parameters: type({ query: "string" }) },
];

const userTurn: Context = { messages: [{ role: "user", content: "2x2", timestamp: 0 }] };

interface WireToolCall {
	id: string;
	function: { name: string; arguments: string };
}

interface CapturedPayload {
	reasoning_effort?: unknown;
	tools?: { function: { name: string } }[];
	tool_choice?: unknown;
	messages: { role: string; name?: string; tool_calls?: WireToolCall[] }[];
}

function sseChunk(model: Model<"openai-completions">, delta: unknown, finishReason: string | null = null): string {
	const chunk = {
		id: "rqsty-cmpl-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function capture(
	model: Model<"openai-completions">,
	context: Context,
	options: Partial<OptionsForApi<"openai-completions">>,
	responseDelta: unknown = { content: "4" },
): Promise<{ payload: CapturedPayload; message: AssistantMessage }> {
	let payload: CapturedPayload | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as CapturedPayload;
			const body = `${sseChunk(model, responseDelta)}${sseChunk(model, {}, "stop")}data: [DONE]\n\n`;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
	const message = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		...options,
	}).result();
	if (!payload) throw new Error("Expected a captured request payload");
	return { payload, message };
}

function assistantToolCallTurn(model: Model<"openai-completions">, toolCall: ToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function searchHistory(model: Model<"openai-completions">): Context {
	const call: ToolCall = { type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "news" } };
	return {
		tools,
		messages: [
			{ role: "user", content: "Search the news", timestamp: 0 },
			assistantToolCallTurn(model, call),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				content: [{ type: "text", text: "headline" }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "Summarize", timestamp: 0 },
		],
	};
}

function streamedCall(name: string) {
	return { tool_calls: [{ index: 0, id: "call_3", type: "function", function: { name, arguments: '{"q":"x"}' } }] };
}

const streamedSearchCall = {
	tool_calls: [
		{ index: 0, id: "call_2", type: "function", function: { name: "_web_search", arguments: '{"query":"x"}' } },
	],
};

describe("Requesty reasoning_effort wire contract", () => {
	it("sends Requesty's `min` for the minimal tier instead of the rejected `minimal`", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		expect(model.thinking?.efforts).toContain(Effort.Minimal);
		const { payload } = await capture(model, userTurn, { reasoning: "minimal" });
		expect(payload.reasoning_effort).toBe("min");
	});

	it("passes the other named tiers through unchanged", async () => {
		const model = requestyModel("openai/gpt-5.6-terra");
		expect((await capture(model, userTurn, { reasoning: "high" })).payload.reasoning_effort).toBe("high");
		expect((await capture(model, userTurn, { reasoning: "xhigh" })).payload.reasoning_effort).toBe("xhigh");
	});
});

describe("Requesty Gemini tool-name escape", () => {
	it("prefixes tool definitions, replayed calls, and a forced tool choice on Gemini", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		const { payload } = await capture(model, searchHistory(model), {
			toolChoice: { type: "tool", name: "web_search" },
		});
		expect(payload.tools?.map(tool => tool.function.name)).toEqual(["read", "_web_search"]);
		const replayed = payload.messages.find(message => message.tool_calls)?.tool_calls;
		expect(replayed?.map(call => call.function.name)).toEqual(["_web_search"]);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "_web_search" } });
	});

	it("returns streamed Gemini tool calls under the client tool name", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		const { message } = await capture(model, { ...userTurn, tools }, {}, streamedSearchCall);
		const call = message.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ name: "web_search", arguments: { query: "x" } });
	});

	it("leaves non-built-in names unchanged, keeping a 64-character MCP name within limits", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		const longName = `mcp_${"a".repeat(60)}`;
		const longTools: Tool[] = [{ name: longName, description: "MCP tool", parameters: type({ q: "string" }) }];
		const { payload } = await capture(model, { ...userTurn, tools: longTools }, {});
		expect(payload.tools?.map(tool => tool.function.name)).toEqual([longName]);
	});

	it("honors an explicit escape override on a custom OpenAI-compatible model", async () => {
		const model = buildModel({
			id: "custom-model",
			name: "custom-model",
			api: "openai-completions",
			provider: "custom-gateway",
			baseUrl: "https://gateway.example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
			compat: { escapeBuiltinToolNames: true },
		});
		const { payload } = await capture(model, { ...userTurn, tools }, {});
		expect(payload.tools?.map(tool => tool.function.name)).toEqual(["read", "_web_search"]);
	});

	it("decodes with the same escape decision that built the request, including tool-result names", async () => {
		// The thinking variant alone enables the escape: request and response must agree.
		const model = requestyModel("google/gemini-3-flash-preview", {
			compat: {
				escapeBuiltinToolNames: false,
				requiresToolResultName: true,
				whenThinking: { escapeBuiltinToolNames: true, requiresToolResultName: true },
			},
		});
		const { payload, message } = await capture(model, searchHistory(model), { reasoning: "low" }, streamedSearchCall);
		expect(payload.tools?.map(tool => tool.function.name)).toEqual(["read", "_web_search"]);
		expect(payload.messages.find(entry => entry.role === "tool")?.name).toBe("_web_search");
		const call = message.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ name: "web_search" });
	});

	it("never renames a client tool that already uses the escaped spelling", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		const ownTool: Tool[] = [{ name: "_web_search", description: "Own tool", parameters: type({ q: "string" }) }];
		const { payload, message } = await capture(
			model,
			{ ...userTurn, tools: ownTool },
			{ toolChoice: { type: "tool", name: "_web_search" } },
			streamedCall("_web_search"),
		);
		expect(payload.tools?.map(tool => tool.function.name)).toEqual(["_web_search"]);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "_web_search" } });
		expect(message.content.find(block => block.type === "toolCall")).toMatchObject({ name: "_web_search" });
	});

	it("keeps a built-in name and its escaped spelling distinct when both are offered", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		const bothTools: Tool[] = [
			{ name: "web_search", description: "Search", parameters: type({ q: "string" }) },
			{ name: "_web_search", description: "Own tool", parameters: type({ q: "string" }) },
		];
		const context = { ...userTurn, tools: bothTools };
		const builtin = await capture(
			model,
			context,
			{ toolChoice: { type: "tool", name: "web_search" } },
			streamedCall("_web_search_2"),
		);
		const wireNames = builtin.payload.tools?.map(tool => tool.function.name);
		expect(wireNames).toEqual(["_web_search_2", "_web_search"]);
		expect(builtin.payload.tool_choice).toEqual({ type: "function", function: { name: "_web_search_2" } });
		expect(builtin.message.content.find(block => block.type === "toolCall")).toMatchObject({ name: "web_search" });

		const own = await capture(
			model,
			context,
			{ toolChoice: { type: "tool", name: "_web_search" } },
			streamedCall("_web_search"),
		);
		expect(own.payload.tool_choice).toEqual({ type: "function", function: { name: "_web_search" } });
		expect(own.message.content.find(block => block.type === "toolCall")).toMatchObject({ name: "_web_search" });
	});

	it("keeps the alias within the 64-character limit when the escaped spellings are all taken", async () => {
		const model = requestyModel("google/gemini-3-flash-preview");
		// `web_search` through 54 underscores + `web_search` (64 characters): all valid client names.
		const chain: Tool[] = Array.from({ length: 55 }, (_, index) => ({
			name: `${"_".repeat(index)}web_search`,
			description: "Tool",
			parameters: type({ q: "string" }),
		}));
		const { payload, message } = await capture(
			model,
			{ ...userTurn, tools: chain },
			{ toolChoice: { type: "tool", name: "web_search" } },
			streamedCall("_web_search_2"),
		);
		const wireNames = payload.tools?.map(tool => tool.function.name) ?? [];
		expect(Math.max(...wireNames.map(name => name.length))).toBeLessThanOrEqual(64);
		expect(new Set(wireNames).size).toBe(chain.length);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "_web_search_2" } });
		expect(message.content.find(block => block.type === "toolCall")).toMatchObject({ name: "web_search" });
	});

	it("keeps tool names unchanged on non-Gemini models", async () => {
		const model = requestyModel("openai/gpt-5.6-terra");
		const { payload } = await capture(model, searchHistory(model), {});
		expect(payload.tools?.map(tool => tool.function.name)).toEqual(["read", "web_search"]);
		const replayed = payload.messages.find(message => message.tool_calls)?.tool_calls;
		expect(replayed?.map(call => call.function.name)).toEqual(["web_search"]);
	});
});
