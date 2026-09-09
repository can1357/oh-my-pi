import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = {
	systemPrompt: ["stable instructions", "cacheable policy"],
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning: "high",
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return await promise;
}

describe("issue #955 — MiniMax coding-plan plan mode payload", () => {
	it.each([
		["minimax-code", "MiniMax-M2.5"],
		["minimax-code-cn", "MiniMax-M2.5"],
	] as const)("omits unsupported thinking fields for %s/%s", async (provider, modelId) => {
		const model = getBundledModel(provider, modelId) as Model<"openai-completions">;
		const body = await capturePayload(model);

		expect(body.model).toBe(modelId);
		expect(body.messages).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
		expect(body.thinking).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});
});
