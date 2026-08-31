import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";

const testContext: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

describe("ollama effort ladder normalization reaches the Responses wire", () => {
	it("resolves Ollama's provider ladder and sends native max on the wire", async () => {
		// Ollama's provider policy owns the low/medium/high/max wire vocabulary,
		// so requests at the top tier serialize `max` verbatim.
		const model = buildModel({
			id: "gemma4:e4b",
			name: "gemma4:e4b",
			api: "openai-responses",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});

		// The stale `minimal` tier is gone; selecting it clamps to the floor.
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Low);

		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		streamOpenAIResponses(model, testContext, {
			apiKey: "test-key",
			signal: abortedSignal(),
			reasoning: "max",
			reasoningSummary: "auto",
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});

		const payload = await promise;
		expect(payload.reasoning).toEqual({ effort: "max", summary: "auto" });
	});
});
