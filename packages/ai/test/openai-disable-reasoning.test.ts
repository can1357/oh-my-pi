import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

interface CapturedPayload {
	reasoning?: { effort?: string; enabled?: boolean };
	reasoning_effort?: string;
}

type RouteApi = "openai-completions" | "openrouter";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function fixture<TApi extends RouteApi>(api: TApi, provider: string, baseUrl: string, id: string): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	} as ModelSpec<TApi>);
}

async function capturePayload<TApi extends RouteApi>(
	model: Model<TApi>,
	options: SimpleStreamOptions,
): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	const fetchMock: FetchImpl = async () =>
		new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });

	await streamSimple(model, context, {
		...options,
		apiKey: "test-key",
		fetch: fetchMock,
		onPayload: payload => {
			captured = payload as CapturedPayload;
		},
	}).result();

	if (!captured) throw new Error("request payload was not captured");
	return captured;
}

const chatCompletions = fixture("openai-completions", "openai", "https://api.openai.com/v1", "gpt-5.1");
const openRouter = fixture("openrouter", "openrouter", "https://openrouter.ai/api/v1", "openai/gpt-5.1");

describe("OpenAI route reasoning disablement", () => {
	it("drops reasoning effort on a forced-off chat-completions request", async () => {
		const active = await capturePayload(chatCompletions, { reasoning: Effort.Medium });
		expect(active.reasoning_effort).toBe(Effort.Medium);

		// `OpenAICompletionsOptions` has no forceReasoningOff field, so the mapping
		// folds it into disableReasoning — otherwise a forced-off side turn still
		// pays for reasoning.
		const forcedOff = await capturePayload(chatCompletions, { reasoning: Effort.Medium, forceReasoningOff: true });
		expect(forcedOff.reasoning_effort).toBeUndefined();
	});

	it("sends effort none for a forced-off OpenRouter responses request", async () => {
		const active = await capturePayload(openRouter, { reasoning: Effort.Medium });
		expect(active.reasoning?.effort).toBe(Effort.Medium);

		const forcedOff = await capturePayload(openRouter, { reasoning: Effort.Medium, forceReasoningOff: true });
		expect(forcedOff.reasoning).toEqual({ effort: "none" });
	});
});
