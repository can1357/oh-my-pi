import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, FetchImpl, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const userMessage: Message = {
	role: "user",
	content: "Compare 2^31 and 3^20, then get the weather in Paris.",
	timestamp: 1,
};

function completionsModel(id: string, provider: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	} satisfies ModelSpec<"openai-completions">);
}

function sse(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sseChunks(modelId: string, deltas: Array<{ delta: Record<string, unknown>; finish?: string }>): string {
	const chunks = deltas.map(({ delta, finish }) => ({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		choices: [{ index: 0, delta, finish_reason: finish ?? null }],
	}));
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

/** Streams `firstTurn`, then replays the restored history on a second turn and returns the replayed assistant message. */
async function streamAndReplay(
	model: Model<"openai-completions">,
	firstTurn: string,
): Promise<{ assistant: AssistantMessage; thinkingDeltas: string[]; replayed: Record<string, unknown> }> {
	const payloads: unknown[] = [];
	let requestIndex = 0;
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
		if (requestIndex++ === 0) return sse(firstTurn);
		return sse(sseChunks(model.id, [{ delta: { role: "assistant", content: "done" }, finish: "stop" }]));
	}
	const fetchMock: FetchImpl = Object.assign(mockFetch, { preconnect: fetch.preconnect });

	const stream = streamOpenAICompletions(model, { messages: [userMessage] }, { apiKey: "test-key", fetch: fetchMock });
	const thinkingDeltas: string[] = [];
	for await (const event of stream) {
		if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
	}
	const assistant = await stream.result();
	const toolCall = assistant.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("streamed tool call missing");
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "18C, cloudy" }],
		isError: false,
		timestamp: 2,
	};
	const restored: Message[] = JSON.parse(JSON.stringify([userMessage, assistant, toolResult]));
	await streamOpenAICompletions(model, { messages: restored }, { apiKey: "test-key", fetch: fetchMock }).result();

	const replayMessages = Reflect.get(payloads[1] as object, "messages") as Array<Record<string, unknown>>;
	const replayed = replayMessages.find(message => message.role === "assistant");
	if (!replayed) throw new Error("replayed assistant message missing");
	return { assistant, thinkingDeltas, replayed };
}

async function bifrostFixture(name: string): Promise<string> {
	return Bun.file(path.join(import.meta.dir, "fixtures", name)).text();
}

describe("openai-completions reasoning_details", () => {
	it("keeps Bifrost gemini-2.5 reasoning.text as thinking and replays the signature-shaped encrypted entry", async () => {
		const model = completionsModel("gemini/gemini-2.5-flash", "bifrost", "http://localhost:8080/v1");
		const { assistant, thinkingDeltas, replayed } = await streamAndReplay(
			model,
			await bifrostFixture("bifrost-gemini-2.5-flash-reasoning-details.sse"),
		);
		const reasoningText =
			"**Analyzing the problem**\n\nI'm initially focusing on comparing 2^31 and 3^20." +
			"**Comparing the Powers**\n\nI've now calculated the actual values of both expressions.";

		expect(thinkingDeltas.join("")).toBe(reasoningText);
		const thinkingBlocks = assistant.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(1);
		expect(thinkingBlocks[0]).toMatchObject({ thinking: reasoningText });
		expect(assistant.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);

		expect(replayed.reasoning_details).toEqual([
			{ index: 0, type: "reasoning.text", text: reasoningText },
			{ index: 0, type: "reasoning.encrypted", signature: "gemini-2.5-thought-signature" },
		]);
		expect(replayed.tool_calls).toMatchObject([{ id: "get_weather", function: { name: "get_weather" } }]);
	});

	it("replays Bifrost gemini-3.5 encrypted entries with their tool_call id unchanged", async () => {
		const model = completionsModel("gemini/gemini-3.5-flash", "bifrost", "http://localhost:8080/v1");
		const { assistant, thinkingDeltas, replayed } = await streamAndReplay(
			model,
			await bifrostFixture("bifrost-gemini-3.5-flash-reasoning-details.sse"),
		);

		const thinking = assistant.content.find(block => block.type === "thinking");
		expect(thinking?.type === "thinking" && thinking.thinking).toBe(thinkingDeltas.join(""));
		expect(thinkingDeltas.join("")).toStartWith("**Comparing Exponents**");
		expect(thinkingDeltas.join("")).toEndWith("I've confirmed $3^{20} > 2^{31}$.");

		const details = replayed.reasoning_details as Array<Record<string, unknown>>;
		expect(details.map(detail => detail.type)).toEqual(["reasoning.text", "reasoning.encrypted"]);
		expect(details[0]).toEqual({ index: 0, type: "reasoning.text", text: thinkingDeltas.join("") });
		expect(details[1]).toEqual({
			id: "tool_call_call_1",
			index: 0,
			type: "reasoning.encrypted",
			signature: "gemini-3.5-thought-signature",
		});
		expect(replayed.tool_calls).toMatchObject([{ id: "call_1_ts_gemini-3.5-thought-signature" }]);
	});

	it("round-trips OpenRouter's reasoning string plus reasoning_details without duplicating thinking", async () => {
		const model = completionsModel("google/gemini-3-pro-preview", "openrouter", "https://openrouter.ai/api/v1");
		const format = "google-gemini-v1";
		const firstTurn = sseChunks(model.id, [
			{
				delta: {
					role: "assistant",
					reasoning: "Need the weather. ",
					reasoning_details: [
						{ type: "reasoning.text", text: "Need the weather. ", signature: null, format, index: 0 },
					],
				},
			},
			{
				delta: {
					reasoning: "Call the tool.",
					reasoning_details: [{ type: "reasoning.text", text: "Call the tool.", format, index: 0 }],
				},
			},
			{
				delta: {
					reasoning_details: [{ type: "reasoning.text", text: "", signature: "text-signature", format, index: 0 }],
				},
			},
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "get_weather", arguments: '{"city":"Paris"}' },
						},
					],
					reasoning_details: [
						{ type: "reasoning.encrypted", data: "encrypted-blob", id: "call_1", format, index: 1 },
					],
				},
			},
			{ delta: {}, finish: "tool_calls" },
		]);
		const { assistant, thinkingDeltas, replayed } = await streamAndReplay(model, firstTurn);

		expect(thinkingDeltas.join("")).toBe("Need the weather. Call the tool.");
		const thinkingBlocks = assistant.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(1);
		expect(thinkingBlocks[0]).toMatchObject({ thinking: "Need the weather. Call the tool." });

		expect(replayed.reasoning_details).toEqual([
			{
				type: "reasoning.text",
				text: "Need the weather. Call the tool.",
				signature: "text-signature",
				format,
				index: 0,
			},
			{ type: "reasoning.encrypted", data: "encrypted-blob", id: "call_1", format, index: 1 },
		]);
		expect(replayed.tool_calls).toMatchObject([{ id: "call_1", function: { name: "get_weather" } }]);
	});

	it("still replays encrypted entries persisted on tool calls by earlier versions", async () => {
		const model = completionsModel("google/gemini-3-pro-preview", "openrouter", "https://openrouter.ai/api/v1");
		const detail = { type: "reasoning.encrypted", data: "encrypted-blob", id: "call_1", index: 0 };
		const persisted: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "get_weather",
					arguments: { city: "Paris" },
					thoughtSignature: JSON.stringify({ perCall: detail }),
				},
			],
			api: "openai-completions",
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
			timestamp: 2,
		};
		const payloads: unknown[] = [];
		async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
			if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
			return sse(sseChunks(model.id, [{ delta: { role: "assistant", content: "done" }, finish: "stop" }]));
		}
		const fetchMock: FetchImpl = Object.assign(mockFetch, { preconnect: fetch.preconnect });
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "get_weather",
			content: [{ type: "text", text: "18C, cloudy" }],
			isError: false,
			timestamp: 3,
		};
		await streamOpenAICompletions(
			model,
			{ messages: [userMessage, persisted, toolResult] },
			{ apiKey: "test-key", fetch: fetchMock },
		).result();

		const replayMessages = Reflect.get(payloads[0] as object, "messages") as Array<Record<string, unknown>>;
		const replayed = replayMessages.find(message => message.role === "assistant");
		expect(replayed?.reasoning_details).toEqual([detail]);
	});
});
