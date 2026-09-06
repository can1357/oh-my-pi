import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// GLM-5.3 replaces GLM-5.2's host-specific reasoning_effort dialects with a
// single uniform wire-exact low/high/max ladder on every host, and thinking can
// no longer be disabled (thinking.type must always be "enabled"). These tests
// pin both contracts so a future change cannot regress to the GLM-5.2 shape.
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function glm53OnFireworks(): Model<"openai-completions"> {
	return buildModel({
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} satisfies ModelSpec<"openai-completions">);
}

function glm53OnZaiAnthropic(): Model<"anthropic-messages"> {
	return buildModel({
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "anthropic-messages",
		provider: "zai",
		baseUrl: "https://api.z.ai/api/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} satisfies ModelSpec<"anthropic-messages">);
}

async function captureChatBody(
	model: Model<"openai-completions">,
	options: { reasoning?: Effort; disableReasoning?: boolean },
): Promise<{ reasoning_effort?: string; thinking?: { type?: string } }> {
	let requestBody: string | undefined;
	const fetchMock: FetchImpl = (_input, init) => {
		requestBody = typeof init?.body === "string" ? init.body : undefined;
		return Promise.resolve(
			new Response(
				'data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
	};
	const stream = streamSimple(model, context, { apiKey: "k", fetch: fetchMock, ...options });
	await stream.result();
	if (!requestBody) throw new Error("request body was not captured");
	return JSON.parse(requestBody);
}

describe("GLM-5.3 reasoning effort wire mapping", () => {
	it("derives the uniform low/high/max ladder on a direct GLM host (not the GLM-5.2 host-specific shape)", () => {
		const model = glm53OnFireworks();
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
	});

	it("sends wire-exact low/high/max reasoning_effort on a direct GLM host", async () => {
		const model = glm53OnFireworks();
		expect((await captureChatBody(model, { reasoning: Effort.Low })).reasoning_effort).toBe("low");
		expect((await captureChatBody(model, { reasoning: Effort.High })).reasoning_effort).toBe("high");
		expect((await captureChatBody(model, { reasoning: Effort.Max })).reasoning_effort).toBe("max");
	});

	it("clamps thinking-off to the lowest effort instead of disabling (GLM-5.3 cannot disable thinking)", async () => {
		const model = glm53OnFireworks();
		const body = await captureChatBody(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("low");
		expect(body.thinking).toBeUndefined();
	});

	it("clamps omitted reasoning to the lowest effort", async () => {
		const model = glm53OnFireworks();
		const body = await captureChatBody(model, {});
		expect(body.reasoning_effort).toBe("low");
	});

	it("derives mandatory reasoning on the zai Anthropic endpoint too", () => {
		const model = glm53OnZaiAnthropic();
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		expect(model.thinking?.mode).toBe("anthropic-budget-effort");
	});
});
