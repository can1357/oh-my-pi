import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const openAIResponsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
const openAICompletionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("StreamOptions.fetch override", () => {
	it("routes openai-completions requests through the override", async () => {
		const calls: Array<{ url: string }> = [];

		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: { content: "hi" } }],
					},
					{
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: openAICompletionsModel.id,
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
					"[DONE]",
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(openAICompletionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: customFetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]?.url).toContain("/chat/completions");
	});

	it("routes openai-responses requests through the override", async () => {
		const calls: Array<{ url: string }> = [];

		const customFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit) => {
				calls.push({ url: String(input instanceof Request ? input.url : input) });
				return createSseResponse([
					{ type: "response.created", response: { id: "resp_test" } },
					{
						type: "response.output_item.added",
						item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: "hi" },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_test",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "hi" }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]);
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(openAIResponsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: customFetch,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]?.url).toContain("/responses");
	});
});
