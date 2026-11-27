import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { renderDemotedThinking } from "../src/dialect/demotion";
import { streamAnthropic } from "../src/providers/anthropic";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, Model } from "../src/types";

const trace = "PRIVATE_TRACE\n  unchanged spacing  ";
const signature = "FAKE_SIGNATURE";
const details = [
	{ type: "reasoning.text", text: trace, signature, index: 0 },
	{ type: "reasoning.encrypted", data: "FAKE_REDACTED", index: 1 },
];
function model(api: "openai-completions" | "anthropic-messages", id = "claude-opus-4-6", provider = "proxy") {
	return buildModel({
		api,
		id,
		provider,
		name: id,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		contextWindow: 200000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}
const chat = model("openai-completions");
const native = model("anthropic-messages");
const user = { role: "user" as const, content: "Six times seven?", timestamp: 1 };
const follow = { ...user, content: "Continue.", timestamp: 3 };
async function request(target: Model, messages: Context["messages"]) {
	let body: { messages: Record<string, unknown>[] } | undefined;
	const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		if (target.api === "anthropic-messages")
			return new Response(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fake","type":"message","role":"assistant","model":"claude-opus-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		const chunks = [{ reasoning_content: `${trace}\n\n`, reasoning_details: details }, { content: "Answer 42." }];
		return new Response(
			`${chunks.map(delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join("")}data: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const options = {
		apiKey: "fake-key",
		maxRetries: 0,
		fetch: Object.assign(mockFetch, { preconnect: fetch.preconnect }),
	};
	const result =
		target.api === "anthropic-messages"
			? await streamAnthropic(target as Model<"anthropic-messages">, { messages }, options).result()
			: await streamOpenAICompletions(target as Model<"openai-completions">, { messages }, options).result();
	if (!body || result.errorMessage) throw new Error(result.errorMessage ?? "No request captured");
	return { body, result };
}

describe("Claude private reasoning replay", () => {
	it("keeps exact signed details on unchanged Chat replay, not convenience newlines", async () => {
		const { result } = await request(chat, [user]);
		const { body } = await request(chat, [user, result, follow]);
		expect(body.messages).toEqual([
			userWire(),
			{ role: "assistant", content: "Answer 42.", reasoning_details: details },
			{ role: "user", content: "Continue." },
		]);
	});
	for (const target of [model("openai-completions", "claude-sonnet-4-6"), native]) {
		it(`omits Chat private reasoning after switching to ${target.api}/${target.id}`, async () => {
			const { result } = await request(chat, [user]);
			const { body } = await request(target, [user, result, follow]);
			const assistant = body.messages.find(message => message.role === "assistant");
			expect(assistant).toEqual(
				target.api === "openai-completions"
					? { role: "assistant", content: "Answer 42." }
					: {
							role: "assistant",
							content: [{ type: "text", text: "Answer 42.", cache_control: { type: "ephemeral" } }],
						},
			);
		});
	}
	it("keeps same-model native signed replay byte-for-byte", async () => {
		const { result } = await request(chat, [user]);
		const source: AssistantMessage = {
			...result,
			api: native.api,
			content: [
				{ type: "thinking", thinking: trace, thinkingSignature: signature },
				{ type: "redactedThinking", data: "FAKE_REDACTED" },
				{ type: "text", text: "Answer 42." },
			],
		};
		const { body } = await request(native, [user, source, follow]);
		expect(body.messages.find(message => message.role === "assistant")).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: trace, signature },
				{ type: "redacted_thinking", data: "FAKE_REDACTED" },
				{ type: "text", text: "Answer 42.", cache_control: { type: "ephemeral" } },
			],
		});
	});
	for (const target of [
		chat,
		model("anthropic-messages", native.id, "foreign-proxy"),
		model("anthropic-messages", "claude-sonnet-4-6"),
	]) {
		it(`omits foreign native private reasoning on ${target.api}/${target.provider}`, async () => {
			const { result } = await request(chat, [user]);
			const source: AssistantMessage = {
				...result,
				api: native.api,
				model: native.id,
				content: [
					{ type: "thinking", thinking: trace, thinkingSignature: signature },
					{ type: "redactedThinking", data: "FAKE_REDACTED" },
					{ type: "text", text: "Answer 42." },
				],
			};
			const { body } = await request(target, [user, source, follow]);
			expect(body.messages.find(message => message.role === "assistant")).toEqual(
				target.api === "openai-completions"
					? { role: "assistant", content: "Answer 42." }
					: {
							role: "assistant",
							content: [{ type: "text", text: "Answer 42.", cache_control: { type: "ephemeral" } }],
						},
			);
		});
	}
	it("omits unsigned thinking rather than emitting an empty demotion on Claude", async () => {
		const { result } = await request(chat, [user]);
		const source: AssistantMessage = {
			...result,
			api: native.api,
			content: [
				{ type: "thinking", thinking: trace },
				{ type: "text", text: "Answer 42." },
			],
		};
		const { body } = await request(native, [user, source, follow]);
		expect(body.messages.find(message => message.role === "assistant")).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Answer 42.", cache_control: { type: "ephemeral" } }],
		});
	});
	it("does not expose reasoning through the Claude demotion fallback", () => {
		expect(renderDemotedThinking(chat.id, trace)).toBe("");
	});
});
function userWire() {
	return { role: "user", content: user.content };
}
