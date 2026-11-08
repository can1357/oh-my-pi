import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A gateway that translates Responses requests into chat completions fabricates
// `reasoning_content: "[reasoning unavailable]"` whenever a replayed turn
// carried no reasoning of its own. The model then echoes the placeholder back
// as its own thinking: recording it would display the text and pin every later
// turn to it.

const PLACEHOLDER = "[reasoning unavailable]";

const model = buildModel({
	id: "nvidia/mistral-large-4-1t-a52b",
	name: "Mistral Large (NVIDIA NIM via proxy)",
	api: "openai-completions",
	provider: "cliproxy",
	baseUrl: "http://127.0.0.1:8317/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 16384,
}) as Model<"openai-completions">;

function reasoningStream(deltas: string[]): FetchImpl {
	const chunk = (delta: Record<string, unknown>) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-gateway",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta }],
		})}\n\n`;
	const body = [...deltas.map(delta => chunk({ reasoning_content: delta })), "data: [DONE]\n\n"].join("");
	return Object.assign(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }), {
		preconnect: fetch.preconnect,
	});
}

describe("Gateway placeholder in chat-completions reasoning", () => {
	it("does not record a placeholder as the model's thinking", async () => {
		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: 0 }] },
			{ apiKey: "k", fetch: reasoningStream([PLACEHOLDER]) },
		).result();
		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : "").not.toContain(PLACEHOLDER);
	});

	it("drops a placeholder split across deltas", async () => {
		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: 0 }] },
			{ apiKey: "k", fetch: reasoningStream(["[reasoning ", "unavailable]"]) },
		).result();
		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : "").toBe("");
	});
});
