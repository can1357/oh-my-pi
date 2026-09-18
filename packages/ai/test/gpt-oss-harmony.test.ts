import { describe, expect, it } from "bun:test";
import { convertMessages, streamOpenAICompletions } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	Tool,
	ToolChoice,
	ToolResultMessage,
	Usage,
} from "@pk-nerdsaver-ai/pi-ai/types";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { type } from "arktype";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const weatherTool: Tool = {
	name: "get_weather",
	description: "Look up the weather for a location",
	parameters: type({ location: "string" }),
};

function toolContext(): Context {
	return {
		messages: [{ role: "user", content: "what is the weather in SF?", timestamp: Date.now() }],
		tools: [weatherTool],
	};
}

type FinishReason = "stop" | "tool_calls" | "length" | null;

interface SseToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
	content?: string;
	tool_calls?: SseToolCallDelta[];
}

interface SseChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: Array<{ index: number; delta: SseChoiceDelta; finish_reason?: FinishReason }>;
}

function chunk(model: string, delta: SseChoiceDelta, finish: FinishReason = null): SseChunk {
	return {
		id: "chatcmpl-harmony-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function createSseResponse(events: ReadonlyArray<SseChunk | "[DONE]">): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: ReadonlyArray<SseChunk | "[DONE]">): FetchImpl {
	const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
		createSseResponse(events);
	return Object.assign(fn, { preconnect: fetch.preconnect });
}

function toRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Capture the request body `buildParams` produced. The already-aborted signal
 * lets `onPayload` observe the payload without a completed turn.
 */
function capturePayload(
	model: Model<"openai-completions">,
	context: Context,
	options?: { readonly toolChoice?: ToolChoice },
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	const controller = new AbortController();
	controller.abort();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: createMockFetch(["[DONE]"]),
		signal: controller.signal,
		onPayload: payload => resolve(toRecord(payload)),
		...options,
	});
	return promise;
}

function cerebrasGptOss(): Model<"openai-completions"> {
	return getBundledModel("cerebras", "gpt-oss-120b") as Model<"openai-completions">;
}

/** Same provider and same chat-completions surface, different (non-gpt-oss) family. */
function cerebrasQwen(): Model<"openai-completions"> {
	return getBundledModel("cerebras", "qwen-3.8-27b") as Model<"openai-completions">;
}

describe("gpt-oss harmony catalog contract", () => {
	it("auto-detects sequential tool calls and harmony healing for the gpt-oss family only", () => {
		const cerebras = cerebrasGptOss();
		expect(cerebras.compat.disableParallelToolCalls).toBe(true);
		expect(cerebras.compat.streamMarkupHealingPattern).toBe("harmony");

		const groq = getBundledModel("groq", "openai/gpt-oss-20b") as Model<"openai-completions">;
		expect(groq.compat.disableParallelToolCalls).toBe(true);
		expect(groq.compat.streamMarkupHealingPattern).toBe("harmony");

		const qwen = cerebrasQwen();
		expect(qwen.compat.disableParallelToolCalls).toBe(false);
		expect(qwen.compat.streamMarkupHealingPattern).toBeUndefined();

		// The Responses-API surface is intentionally uncovered: `openai/gpt-4o-mini`
		// resolves Responses compat, which never carries the chat-completions flag.
		const responsesModel = getBundledModel("openai", "gpt-4o-mini");
		expect(responsesModel.api).toBe("openai-responses");
		expect(Object.keys(responsesModel.compat ?? {})).not.toContain("disableParallelToolCalls");
	});
});

describe("gpt-oss harmony request body", () => {
	it("asks the gpt-oss host for one tool call per turn", async () => {
		const model = cerebrasGptOss();
		const payload = await capturePayload(model, toolContext(), { toolChoice: "any" });

		expect(payload.parallel_tool_calls).toBe(false);
		expect(payload.tool_choice).toBe("required");

		const tools = payload.tools as Array<{ type?: string; function?: { name?: string } }>;
		expect(tools).toHaveLength(1);
		expect(tools[0]?.type).toBe("function");
		expect(tools[0]?.function?.name).toBe("get_weather");
		// Cerebras resolves `supportsUsageInStreaming: false`.
		expect(payload.stream_options).toBeUndefined();
	});

	it("leaves non-gpt-oss chat-completions requests untouched", async () => {
		const model = cerebrasQwen();
		const payload = await capturePayload(model, toolContext(), { toolChoice: "any" });

		expect(payload.parallel_tool_calls).toBeUndefined();
		expect(payload.tool_choice).toBe("required");
		const tools = payload.tools as Array<{ function?: { name?: string } }>;
		expect(tools[0]?.function?.name).toBe("get_weather");
	});
});

describe("gpt-oss harmony tool-result injection", () => {
	it("replays the tool turn as assistant tool_calls plus a role: tool result", () => {
		const model = cerebrasGptOss();
		const now = Date.now();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { location: "SF" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "get_weather",
			content: [{ type: "text", text: "18C and sunny" }],
			isError: false,
			timestamp: now + 1,
		};

		const messages = convertMessages(model, { messages: [assistant, toolResult] }, model.compat);

		expect(messages).toEqual([
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"SF"}' },
					},
				],
			},
			{ role: "tool", content: "18C and sunny", tool_call_id: "call_1" },
		]);
	});
});

describe("gpt-oss harmony stream parsing", () => {
	it("separates content from structured tool_calls on a translating endpoint", async () => {
		const model = cerebrasGptOss();
		const fetchMock = createMockFetch([
			chunk(model.id, { content: "Checking the weather " }),
			chunk(model.id, {
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"location"' },
					},
				],
			}),
			chunk(model.id, { tool_calls: [{ index: 0, function: { arguments: ':"SF"}' } }] }),
			chunk(model.id, {}, "tool_calls"),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, toolContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content.map(block => block.type)).toEqual(["text", "toolCall"]);
		const [text, call] = result.content;
		if (text?.type !== "text" || call?.type !== "toolCall") {
			throw new Error("gpt-oss stream emitted unexpected content");
		}
		expect(text.text).toBe("Checking the weather ");
		expect(call.id).toBe("call_1");
		expect(call.name).toBe("get_weather");
		expect(call.arguments).toEqual({ location: "SF" });
	});

	it("heals leaked Harmony markup into thinking, tool call, and final text", async () => {
		const model = cerebrasGptOss();
		const leaked =
			"<|start|>assistant<|channel|>analysis<|message|>reason<|end|>" +
			'<|start|>assistant<|channel|>commentary to=functions.weather<|message|>{"location":"SF"}<|call|>' +
			"<|start|>assistant<|channel|>final<|message|>done<|end|>";
		// The mock never reports `finish_reason: "tool_calls"`: the healed call
		// alone must promote the natural-completion stop to `toolUse`.
		const fetchMock = createMockFetch([chunk(model.id, { content: leaked }), chunk(model.id, {}, "stop"), "[DONE]"]);

		const result = await streamOpenAICompletions(model, toolContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content.map(block => block.type)).toEqual(["thinking", "toolCall", "text"]);
		const [thinking, call, text] = result.content;
		if (thinking?.type !== "thinking" || call?.type !== "toolCall" || text?.type !== "text") {
			throw new Error("gpt-oss harmony healing emitted unexpected content order");
		}
		expect(thinking.thinking).toBe("reason");
		expect(call.name).toBe("weather");
		expect(call.arguments).toEqual({ location: "SF" });
		expect(text.text).toBe("done");
		expect(result.stopReason).toBe("toolUse");
	});
});
