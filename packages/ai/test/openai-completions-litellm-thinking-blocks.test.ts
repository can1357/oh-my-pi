import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, FetchImpl, Message, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// LiteLLM serving Anthropic with thinking streams `thinking_blocks` (plus a
// `provider_specific_fields` mirror) and requires them back verbatim on the
// assistant tool-call turn: https://docs.litellm.ai/docs/reasoning_content#tool-calling-with-thinking

function liteLLMModel(id = "claude-test") {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://127.0.0.1:4000/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} satisfies ModelSpec<"openai-completions">);
}

const userMessage: Message = { role: "user", content: "run echo hi", timestamp: 1 };

const toolCallDelta = {
	tool_calls: [
		{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } },
	],
};

function sse(deltas: Record<string, unknown>[], finishReason: "stop" | "tool_calls"): Response {
	const chunks = [
		...deltas.map(delta => ({
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta }],
		})),
		{
			id: "c",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		},
	];
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** First call streams `firstTurn`; every later call answers "done". Captures request bodies. */
function createFetch(firstTurn: Record<string, unknown>[], payloads: unknown[]): FetchImpl {
	let requestIndex = 0;
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
		if (requestIndex++ === 0) return sse(firstTurn, "tool_calls");
		return sse([{ role: "assistant", content: "done" }], "stop");
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

/** Streams the tool-call turn, then sends the continuation to `replayModel` and returns its assistant turn. */
async function roundTrip(
	firstTurn: Record<string, unknown>[],
	replayModel = liteLLMModel(),
): Promise<{ assistant: AssistantMessage; replayed: Record<string, unknown> }> {
	const payloads: unknown[] = [];
	const fetchMock = createFetch(firstTurn, payloads);
	const assistant = await streamOpenAICompletions(
		liteLLMModel(),
		{ messages: [userMessage] },
		{ apiKey: "k", fetch: fetchMock },
	).result();
	const toolCall = assistant.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("streamed tool call missing");
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: 2,
	};
	await streamOpenAICompletions(
		replayModel,
		{ messages: [userMessage, assistant, toolResult] },
		{ apiKey: "k", fetch: fetchMock },
	).result();
	const messages = Reflect.get(payloads[1] as object, "messages");
	if (!Array.isArray(messages)) throw new Error("continuation messages missing");
	const replayed = messages.find(message => message.role === "assistant");
	if (!replayed) throw new Error("replayed assistant message missing");
	return { assistant, replayed };
}

const thinking = (text: string, signature: string) => [{ type: "thinking", thinking: text, signature }];

describe("openai-completions LiteLLM thinking_blocks", () => {
	it("captures the signed block once and replays it on the tool-call turn", async () => {
		const { assistant, replayed } = await roundTrip([
			{
				role: "assistant",
				content: "",
				reasoning_content: "I should list files.",
				thinking_blocks: thinking("I should list files.", ""),
				provider_specific_fields: { thinking_blocks: thinking("I should list files.", "") },
			},
			// Signature split across deltas must concatenate, like Anthropic signature_delta.
			{ reasoning_content: "", thinking_blocks: thinking("", "SIG_part1_") },
			{ reasoning_content: "", thinking_blocks: thinking("", "part2") },
			toolCallDelta,
		]);

		expect(assistant.content.filter(block => block.type === "thinking")).toEqual([
			{ type: "thinking", thinking: "I should list files.", thinkingSignature: "SIG_part1_part2" },
		]);
		expect(replayed.thinking_blocks).toEqual([
			{ type: "thinking", thinking: "I should list files.", signature: "SIG_part1_part2" },
		]);
		expect(replayed.tool_calls).toMatchObject([{ id: "call_1" }]);
	});

	it("reads the provider_specific_fields mirror and keeps hidden, redacted, and sequential blocks in order", async () => {
		const mirrored = (blocks: unknown[]) => ({ provider_specific_fields: { thinking_blocks: blocks } });
		const { replayed } = await roundTrip([
			// Hidden thinking: signature with no text.
			{ role: "assistant", ...mirrored(thinking("", "SIG_hidden")) },
			mirrored([{ type: "redacted_thinking", data: "REDACTED_BLOB" }]),
			mirrored(thinking("first", "")),
			mirrored(thinking("", "SIG_first")),
			// Text after a signature opens the next block.
			mirrored(thinking("second", "")),
			mirrored(thinking("", "SIG_second")),
			toolCallDelta,
		]);

		expect(replayed.thinking_blocks).toEqual([
			{ type: "thinking", thinking: "", signature: "SIG_hidden" },
			{ type: "redacted_thinking", data: "REDACTED_BLOB" },
			{ type: "thinking", thinking: "first", signature: "SIG_first" },
			{ type: "thinking", thinking: "second", signature: "SIG_second" },
		]);
	});

	it("does not replay signatures to a different model", async () => {
		const { replayed } = await roundTrip(
			[
				{ role: "assistant", thinking_blocks: thinking("plan", "SIG_other_model") },
				{ thinking_blocks: [{ type: "redacted_thinking", data: "REDACTED_BLOB" }] },
				toolCallDelta,
			],
			liteLLMModel("claude-other"),
		);

		expect(replayed.thinking_blocks).toBeUndefined();
		expect(JSON.stringify(replayed)).not.toContain("SIG_other_model");
	});

	it("leaves plain reasoning_content turns without thinking_blocks", async () => {
		const { replayed } = await roundTrip([{ role: "assistant", reasoning_content: "plain" }, toolCallDelta]);

		expect(replayed.thinking_blocks).toBeUndefined();
	});
});
