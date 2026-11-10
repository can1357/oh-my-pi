import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Captured from OpenRouter → "Claude Platform on AWS" for anthropic/claude-opus-5
// (2026-09-15); its header names the serving model, see anthropic-signature.test.ts.
const OPUS_5_SIGNATURE =
	"CAISnAIKrgEIERgCKkBun5aw4pp8OwMcmPih8WPkWUcibrzQ8Jg5AooTtYTxb4OGtHksxfgAiCJWYNO0xqC4zVwgAFZ0nU0+5/QoKQStMg1jbGF1ZGUtb3B1cy01OAFCCHRoaW5raW5nWiQ0YzBmMDQ2Zi0yNWZkLTQ1ZmItYmZiMy1hMDhhOGUyNDljYTd6HnVwcm9mXzAxMUNlUVRqY1ZkV2lES1F4d0Zlc3BldqgBndWi1QYSDDfLtFY9SutE7G2OLhoMvcDeJZgBIoqoYb4IIjBvpyKZu6JlaYZEy4cKXscU+OxzGZkpQapVraxYNEwKypi+Dbvz9FD2bO0yHjFhi5kqGwmcLJKipAse80nNfJfANbVYCqh6yW6HgnkXAxgB";

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

async function streamWith(chunks: Record<string, unknown>[]) {
	const fetchMock: FetchImpl = () =>
		Promise.resolve(
			createSseResponse([
				...chunks.map(extra => chunk(extra)),
				chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			]),
		);
	return await streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch: fetchMock }).result();
}

describe("openai-completions served model capture", () => {
	// Contract: local OpenAI-compatible hosts (llama.cpp, LM Studio, VLM `serve`, …)
	// echo the weights they actually loaded in `ChatCompletionChunk.model`. Capture a
	// genuine difference from the id we asked for; deciding whether an echo names the
	// same model (snapshot suffix, gateway prefix, checkpoint path) is the shared
	// classifier's job at display time, so the capture records the raw id.
	it("records a served model id that differs from the requested id", async () => {
		const result = await streamWith([
			{ model: "qwen2.5-coder-32b-instruct", choices: [{ index: 0, delta: { content: "Hi" } }] },
		]);
		expect(result.upstreamModel).toBe("qwen2.5-coder-32b-instruct");
		expect(result.stopReason).toBe("stop");
	});

	it("leaves upstreamModel undefined when the host echoes the requested id", async () => {
		const result = await streamWith([{ choices: [{ index: 0, delta: { content: "Hi" } }] }]);
		expect(result.upstreamModel).toBeUndefined();
	});

	it("prefers a signed reasoning_details id over a canonicalised echo", async () => {
		// The echo is unsigned host text; a gateway canonicalising it (dated slug) must
		// not hide the model its own forwarded Anthropic signature names.
		const result = await streamWith([
			{ model: "anthropic/claude-opus-5-20250915", choices: [{ index: 0, delta: { content: "Hi" } }] },
			{
				choices: [
					{
						index: 0,
						delta: {
							reasoning_details: [
								{ type: "reasoning.text", format: "anthropic-claude-v1", signature: OPUS_5_SIGNATURE },
							],
						},
					},
				],
			},
		]);
		expect(result.upstreamModel).toBe("claude-opus-5");
	});

	it("ignores an empty model echo", async () => {
		const result = await streamWith([{ model: "", choices: [{ index: 0, delta: { content: "Hi" } }] }]);
		expect(result.upstreamModel).toBeUndefined();
	});
});
