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

	it("records a checkpoint-path echo verbatim for the classifier to judge", async () => {
		const result = await streamWith([
			{ model: "/models/GPT-4o-Mini", choices: [{ index: 0, delta: { content: "Hi" } }] },
		]);
		expect(result.upstreamModel).toBe("/models/GPT-4o-Mini");
	});

	it("ignores an empty model echo", async () => {
		const result = await streamWith([{ model: "", choices: [{ index: 0, delta: { content: "Hi" } }] }]);
		expect(result.upstreamModel).toBeUndefined();
	});
});
