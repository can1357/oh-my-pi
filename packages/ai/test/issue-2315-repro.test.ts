import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CaptureOptions {
	disableReasoning?: boolean;
	reasoning?: Effort;
}

async function capturePayload(
	model: Model<"openai-completions">,
	options: CaptureOptions,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		fetch: fetchMock,
		disableReasoning: options.disableReasoning,
		reasoning: options.reasoning,
	}).result();
	if (!payload) throw new Error("Expected request payload");
	return payload;
}

describe("issue #2315 — MiniMax M2 / GPT-OSS catalog excludes unsupported reasoning_effort tiers", () => {
	it("declares only low/medium/high for fireworks/minimax-m2.7 and disables reasoning with low", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		const body = await capturePayload(model, { disableReasoning: true });
		// Pre-fix the catalog included `minimal`, so the Fireworks compat map turned
		// the auto-thinking classifier's disableReasoning request into `"none"`.
		expect(body.reasoning_effort).toBe("low");
	});

	it("declares only low/medium/high for fireworks/gpt-oss-120b and disables reasoning with low", async () => {
		const model = getBundledModel("fireworks", "gpt-oss-120b") as Model<"openai-completions">;
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("low");
	});

	it("resolves MiniMax M2 thinking metadata through the catalog engine before sending a request", async () => {
		const base = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const model = buildModel({
			id: base.id,
			name: base.name,
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: base.baseUrl,
			reasoning: true,
			input: base.input,
			cost: base.cost,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
		});

		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(model.thinking?.effortMap).toBeUndefined();
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("low");
	});

	it("preserves a custom compat.whenThinking reasoningEffortMap override at request time", async () => {
		const base = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		// Custom proxy: minimal stays clamped to low, xhigh is force-mapped to high
		// via a whenThinking variant — the swap was getting lost when this PR
		// moved effort maps onto `model.thinking.effortMap`.
		const model = buildModel({
			id: base.id,
			name: base.name,
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: base.baseUrl,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			compat: { whenThinking: { reasoningEffortMap: { high: "max" } } },
			input: base.input,
			cost: base.cost,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
		});

		const body = await capturePayload(model, { reasoning: Effort.High });
		expect(body.reasoning_effort).toBe("max");
	});

	it("preserves low/medium/high passthrough on fireworks/minimax-m2.7", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const lowBody = await capturePayload(model, { reasoning: Effort.Low });
		expect(lowBody.reasoning_effort).toBe("low");
		const medBody = await capturePayload(model, { reasoning: Effort.Medium });
		expect(medBody.reasoning_effort).toBe("medium");
		const highBody = await capturePayload(model, { reasoning: Effort.High });
		expect(highBody.reasoning_effort).toBe("high");
	});

	it("keeps the Fireworks-wide minimal→none mapping for non-restricted models (glm-5.1)", async () => {
		const model = getBundledModel("fireworks", "glm-5.1") as Model<"openai-completions">;
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("none");
	});
});
