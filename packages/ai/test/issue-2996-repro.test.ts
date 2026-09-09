/**
 * Regression guard for the openai-completions streaming reasoning contract.
 *
 * Some OpenAI-compatible hosts (GLM, Qwen reasoning variants behind custom
 * `openai-completions` providers) stream the DeepSeek-format dual-key pattern:
 *
 *   {"delta":{"content":null,"reasoning_content":"..."}}
 *
 * where `content` is explicitly JSON `null` (not absent) while `reasoning_content`
 * carries the thinking text. The provider must emit a `thinking` block for that
 * text — the null `content` must not cause the reasoning delta to be dropped,
 * and it must not be coerced into an empty text block either.
 *
 * This pins the behavior so a future change that introduces an `if (delta.content)`
 * guard (or routes the reasoning path behind a content-presence check) is caught.
 * See issue #2996 for the reported (non-reproducing) scenario this defends.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "1+1=?", timestamp: Date.now() }],
	};
}

/** A custom openai-completions provider model (e.g. yunwu/glm-5.2) with reasoning enabled. */
function customReasoningModel(id = "glm-5.2"): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "yunwu",
		baseUrl: "https://yunwu.ai/v1",
		id,
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function deltaChunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
	return {
		id: "x",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta }],
	};
}

describe("openai-completions keeps reasoning_content when delta.content is null", () => {
	it("emits a thinking block for reasoning_content deltas paired with content:null", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { content: null, reasoning_content: "分析" }),
			deltaChunk(model, { content: null, reasoning_content: "步骤" }),
			deltaChunk(model, { content: "2", reasoning_content: null }),
			{
				id: "x",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "分析步骤", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "2" },
		]);
	});

	it("does not coerce a content:null delta into a text block when only reasoning_content is present", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { content: null, reasoning_content: "only thinking" }),
			deltaChunk(model, { content: "answer", reasoning_content: null }),
			{
				id: "x",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		const textBlocks = result.content.filter(b => b.type === "text");
		expect(textBlocks).toEqual([{ type: "text", text: "answer" }]);
	});
});
