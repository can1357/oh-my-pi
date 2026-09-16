/**
 * Cerebras hosts Qwen (`qwen-3.8-27b`) behind an OpenAI-dialect endpoint. Its
 * reasoning guide (inference-docs.cerebras.ai/capabilities/reasoning) drives
 * effort through `reasoning_effort` (none|low|medium|high) and explicitly
 * rejects the Qwen-native `enable_thinking` / `preserve_thinking` /
 * `thinking_budget` parameters. The `qwen-*` id family would otherwise select
 * `thinkingFormat: "qwen"`, so the host must win over the id — the same rule
 * Fireworks already relies on.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import type { Context } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildOpenAICompat } from "@pk-nerdsaver-ai/pi-catalog/compat/openai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import type { FetchImpl, Model, ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";

function sseDoneResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("cerebras qwen-3.8-27b reasoning effort", () => {
	it("routes Cerebras-hosted qwen to the openai reasoning_effort format", () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "qwen-3.8-27b",
			name: "Qwen 3.8 27B",
			api: "openai-completions",
			provider: "cerebras",
			baseUrl: "https://api.cerebras.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536,
			maxTokens: 32_768,
		};
		expect(buildOpenAICompat(spec).thinkingFormat).toBe("openai");
	});

	it("sends reasoning_effort and no Qwen-native thinking fields on the wire", async () => {
		const model = getBundledModel<"openai-completions">("cerebras", "qwen-3.8-27b");
		expect(model.baseUrl).toBe("https://api.cerebras.ai/v1");
		expect(model.reasoning).toBe(true);

		const captured: { body: string | null } = { body: null };
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.body = typeof init?.body === "string" ? init.body : null;
			return sseDoneResponse();
		};
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey: "csk-test",
			reasoning: "medium",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(captured.body).not.toBeNull();
		const parsed = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
		expect(parsed.model).toBe("qwen-3.8-27b");
		expect(parsed.reasoning_effort).toBe("medium");
		expect(parsed.enable_thinking).toBeUndefined();
		expect(parsed.thinking_budget).toBeUndefined();
		expect(parsed.preserve_thinking).toBeUndefined();
		expect(parsed.chat_template_kwargs).toBeUndefined();
	});
});
