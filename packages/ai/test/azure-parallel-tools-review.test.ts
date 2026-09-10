import { expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "gpt-5-review",
	name: "GPT review",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://review.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}) as Model<"azure-openai-responses">;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

async function capture(parallelToolCalls: boolean): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	const fetchMock: FetchImpl = async (_input, init) => {
		resolve(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	};
	const events = streamSimple(model, context, {
		apiKey: "review-key",
		parallelToolCalls,
		fetch: fetchMock,
	});
	await events.result();
	return promise;
}

it("preserves explicit Azure parallel_tool_calls false and true on the wire", async () => {
	const disabled = await capture(false);
	const enabled = await capture(true);
	expect(disabled.parallel_tool_calls).toBe(false);
	expect(enabled.parallel_tool_calls).toBe(true);
});
