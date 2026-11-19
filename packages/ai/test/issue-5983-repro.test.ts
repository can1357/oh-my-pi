import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";

const model = buildModel({
	id: "kimi-k3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "litellm",
	baseUrl: "http://127.0.0.1:4000/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

async function capturePayload(reasoning: Effort): Promise<unknown> {
	let payload: unknown;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
			return new Response(
				'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		{ preconnect: fetch.preconnect },
	);

	await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		reasoning,
	}).result();
	return payload;
}

describe("issue #5983 — Kimi K3 OpenAI-compatible effort contract", () => {
	it("derives K3's mandatory low/high/max ladder for a LiteLLM route", () => {
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.thinking).toMatchObject({
			mode: "effort",
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
		expect(model.compat.reasoningEffortMap).toEqual({
			minimal: "low",
			medium: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("folds every generic requested tier into K3's accepted wire values", async () => {
		const cases: readonly (readonly [Effort, string])[] = [
			[Effort.Minimal, "low"],
			[Effort.Low, "low"],
			[Effort.Medium, "high"],
			[Effort.High, "high"],
			[Effort.XHigh, "max"],
			[Effort.Max, "max"],
		];
		const payloads = await Promise.all(cases.map(([requested]) => capturePayload(requested)));
		for (let index = 0; index < cases.length; index++) {
			expect(payloads[index]).toMatchObject({ reasoning_effort: cases[index]?.[1] });
		}
	});
});
