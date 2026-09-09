import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function chunk(extra: Record<string, unknown>): Record<string, unknown> {
	return { id: "gen-1", object: "chat.completion.chunk", created: 0, model: model.id, ...extra };
}

describe("openai-completions upstream provider capture", () => {
	// Contract: aggregators (OpenRouter, …) report the upstream provider that served
	// the request via a top-level `provider` field on every chunk. We surface it on
	// the assistant message so telemetry/session logs can attribute routing.
	it("records the aggregator-reported upstream provider from the stream", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createSseResponse([
					chunk({ provider: "Anthropic", choices: [{ index: 0, delta: { content: "Hi" } }] }),
					chunk({
						provider: "Anthropic",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				]),
			);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.upstreamProvider).toBe("Anthropic");
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	});

	it("leaves upstreamProvider undefined when no provider field is present", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createSseResponse([
					chunk({ choices: [{ index: 0, delta: { content: "Hi" } }] }),
					chunk({
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				]),
			);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.upstreamProvider).toBeUndefined();
	});
});
