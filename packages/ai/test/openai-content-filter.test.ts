import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function contentFilterFetch(): FetchImpl {
	const body = [{ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }, "[DONE]"]
		.map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`)
		.join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

describe("OpenAI content-filter classification", () => {
	it("preserves content_filter as structured stop details for recovery policy", async () => {
		const result = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: contentFilterFetch(),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({ type: "content_filter" });
		expect(result.errorMessage).toBe("Provider finish_reason: content_filter");
	});
});
