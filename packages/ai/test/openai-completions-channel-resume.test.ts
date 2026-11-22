/**
 * Some OpenAI-compatible gateways (observed on the omni router fronting
 * DeepSeek V4.1 Flash) flush a channel's buffered tail *after* the other
 * channel's last delta: reasoning deltas, content deltas, then one long
 * `reasoning_content` chunk, then one long `content` chunk — and they do the
 * same after a tool call. Each tail is the verbatim continuation of its own
 * channel, so a block per delta run turns one reasoning block and one answer
 * block into four interleaved blocks and the rendered answer is chopped
 * mid-word. A resumed channel must append to the block it left.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
} from "@oh-my-pi/pi-ai/types";
import { wrapLeakedThinkingStream } from "@oh-my-pi/pi-ai/utils/leaked-thinking-stream";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function gatewayModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		provider: "omni",
		baseUrl: "https://omni.example/v1",
		api: "openai-completions",
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

const context: Context = {
	messages: [{ role: "user", content: "Why does a battery degrade?", timestamp: 0 }],
};

function chunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-channel-resume",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta }],
	};
}

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function streamingFetch(events: unknown[]): FetchImpl {
	return Object.assign(async () => sseResponse(events), { preconnect: fetch.preconnect });
}

const REASONING_HEAD = "Check the chemistry: plating at low temperature. ";
const ANSWER_HEAD = "Lithium batteries degrade because plating is irreversible. ";
const REASONING_TAIL = "r".repeat(512);
const ANSWER_TAIL = "a".repeat(512);

describe("openai-completions channel resume", () => {
	it("appends a deferred channel tail to the block the channel left", async () => {
		const model = gatewayModel();
		const message: AssistantMessage = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: streamingFetch([
				chunk(model, { role: "assistant", reasoning_content: REASONING_HEAD.slice(0, 20) }),
				chunk(model, { reasoning_content: REASONING_HEAD.slice(20) }),
				chunk(model, { content: ANSWER_HEAD.slice(0, 15) }),
				chunk(model, { content: ANSWER_HEAD.slice(15) }),
				chunk(model, { reasoning_content: REASONING_TAIL }),
				chunk(model, { content: ANSWER_TAIL }),
			]),
		}).result();

		expect(message.content.map(block => block.type)).toEqual(["thinking", "text"]);
		const thinking = message.content.find(block => block.type === "thinking");
		const text = message.content.find(block => block.type === "text");
		expect(thinking?.thinking).toBe(REASONING_HEAD + REASONING_TAIL);
		expect(text?.text).toBe(ANSWER_HEAD + ANSWER_TAIL);
	});

	it("appends tails flushed after a tool call to the blocks before it", async () => {
		const model = gatewayModel();
		const message: AssistantMessage = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: streamingFetch([
				chunk(model, { reasoning_content: REASONING_HEAD }),
				chunk(model, { content: ANSWER_HEAD }),
				chunk(model, {
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
				}),
				chunk(model, { reasoning_content: REASONING_TAIL }),
				chunk(model, { content: ANSWER_TAIL }),
			]),
		}).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);
		const thinking = message.content.find(block => block.type === "thinking");
		const text = message.content.find(block => block.type === "text");
		expect(thinking?.thinking).toBe(REASONING_HEAD + REASONING_TAIL);
		expect(text?.text).toBe(ANSWER_HEAD + ANSWER_TAIL);
	});
});

/** Verbatim event shape of the omni/deepseek-flash wire (captured 2026-11-22). */
describe("leaked-thinking projector channel resume", () => {
	it("reopens the answer block when its tail arrives after the reasoning tail", async () => {
		const inner = new AssistantMessageEventStream();
		const out = wrapLeakedThinkingStream(inner);
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "omni",
			model: "ds/deepseek-flash",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		inner.push({ type: "start", partial: message });
		// The gateway opens the answer first, then flushes its reasoning tail
		// (a new source block) and finally the rest of the answer (source 0).
		const text = { type: "text" as const, text: "" };
		const thinking = { type: "thinking" as const, thinking: "", thinkingSignature: "reasoning_content" };
		const partial: AssistantMessage = { ...message, content: [text, thinking] };
		const send = (event: AssistantMessageEvent): void => {
			inner.push(event);
		};
		text.text += ANSWER_HEAD;
		send({ type: "text_delta", contentIndex: 0, delta: ANSWER_HEAD, partial });
		thinking.thinking += REASONING_TAIL;
		send({ type: "thinking_start", contentIndex: 1, partial });
		send({ type: "thinking_delta", contentIndex: 1, delta: REASONING_TAIL, partial });
		text.text += ANSWER_TAIL;
		send({ type: "text_delta", contentIndex: 0, delta: ANSWER_TAIL, partial });
		send({ type: "done", reason: "stop", message: partial });

		for await (const _event of out) {
			// drain
		}
		const result = await out.result();
		expect(result.content.map(block => block.type)).toEqual(["text", "thinking"]);
		const answer = result.content.find(block => block.type === "text");
		const reasoning = result.content.find(block => block.type === "thinking");
		expect(answer?.text).toBe(ANSWER_HEAD + ANSWER_TAIL);
		expect(reasoning?.thinking).toBe(REASONING_TAIL);
	});
});
