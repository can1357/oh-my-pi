import { describe, expect, it } from "bun:test";
import { ANTHROPIC_THINKING, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const context: Context = {
	systemPrompt: ["Summarize the conversation."],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function anthropicModel(id: string, maxTokens: number): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens,
	} satisfies ModelSpec<"anthropic-messages">);
}

interface WirePayload {
	max_tokens?: number;
	thinking?: { type?: string; budget_tokens?: number };
}

/** The request `streamSimple` puts on the wire; the endpoint answers 400 so nothing streams. */
async function wirePayload(
	model: Model<"anthropic-messages">,
	options: { maxTokens?: number; reasoning: Effort; thinkingBudgets?: Partial<Record<Effort, number>> },
): Promise<WirePayload> {
	let payload: WirePayload | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		payload = JSON.parse(init?.body as string) as WirePayload;
		return new Response("{}", { status: 400 });
	};
	await streamSimple(model, context, { apiKey: "test-key", fetch, ...options }).result();
	if (!payload) throw new Error("streamSimple sent no request");
	return payload;
}

describe("Anthropic thinking leaves a capped request its output budget", () => {
	it("adds the effort's thinking budget to a capped adaptive request", async () => {
		// Adaptive thinking and the answer share max_tokens. A 13,107-token
		// compaction summary cap at max effort used to go entirely to thinking,
		// so on-demand compaction ended at max_tokens without a compaction block.
		const payload = await wirePayload(anthropicModel("claude-opus-5-5", 128_000), {
			maxTokens: 13_107,
			reasoning: Effort.Max,
		});
		expect(payload.thinking?.type).toBe("adaptive");
		expect(payload.max_tokens).toBe(13_107 + ANTHROPIC_THINKING.max);
	});

	it("adds the thinking budget on the interleaved budget path", async () => {
		// Budget thinking only guaranteed the provider's 4k fallback beyond the
		// budget, not the output the caller asked for.
		const payload = await wirePayload(anthropicModel("claude-sonnet-4-5", 64_000), {
			maxTokens: 13_107,
			reasoning: Effort.High,
		});
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: ANTHROPIC_THINKING.high });
		expect(payload.max_tokens).toBe(13_107 + ANTHROPIC_THINKING.high);
	});

	it("keeps a custom minimal thinking budget when the model can raise the total cap", async () => {
		const payload = await wirePayload(anthropicModel("claude-sonnet-4-5", 8_192), {
			maxTokens: 3_000,
			reasoning: Effort.High,
			thinkingBudgets: { high: ANTHROPIC_THINKING.minimal },
		});
		expect(payload.max_tokens).toBe(ANTHROPIC_THINKING.minimal + 4_000);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: ANTHROPIC_THINKING.minimal });
	});

	it("shrinks an interleaved thinking budget below a smaller model output ceiling", async () => {
		const payload = await wirePayload(anthropicModel("claude-sonnet-4-5", 6_000), {
			maxTokens: 3_000,
			reasoning: Effort.High,
		});
		expect(payload.max_tokens).toBe(6_000);
		expect(payload.thinking).toMatchObject({ type: "enabled", budget_tokens: 6_000 - 4_000 });
	});

	it("disables thinking when the output ceiling cannot fit its minimum budget", async () => {
		const payload = await wirePayload(anthropicModel("claude-sonnet-4-5", 5_000), {
			maxTokens: 3_000,
			reasoning: Effort.High,
		});
		expect(payload.max_tokens).toBe(3_000);
		expect(payload.thinking?.type).not.toBe("enabled");
	});

	it("never raises a capped request above the model's output ceiling", async () => {
		const payload = await wirePayload(anthropicModel("claude-opus-5-5", 32_000), {
			maxTokens: 13_107,
			reasoning: Effort.Max,
		});
		expect(payload.max_tokens).toBe(32_000);
	});

	it("keeps an uncapped request at the model's output ceiling", async () => {
		// Agent turns pass no cap; they must not fall to the finite fallback the
		// budget-only path uses when neither the caller nor the model sets one.
		const payload = await wirePayload(anthropicModel("claude-opus-5-5", 128_000), { reasoning: Effort.Max });
		expect(payload.max_tokens).toBe(128_000);
	});

	it("adds the thinking budget to a capped adaptive request on Bedrock", async () => {
		// Bedrock-hosted adaptive Claude shares maxTokens with thinking the same way.
		const model = buildModel({
			id: "anthropic.claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		} satisfies ModelSpec<"bedrock-converse-stream">);
		const controller = new AbortController();
		const { promise, resolve } = Promise.withResolvers<{ inferenceConfig?: { maxTokens?: number } }>();
		void streamSimple(model, context, {
			apiKey: "test-key",
			signal: controller.signal,
			maxTokens: 13_107,
			reasoning: Effort.High,
			onPayload: payload => {
				resolve(payload as { inferenceConfig?: { maxTokens?: number } });
				controller.abort();
				return undefined;
			},
		});
		// 16,384 is Bedrock's high-effort Claude thinking budget.
		expect((await promise).inferenceConfig?.maxTokens).toBe(13_107 + 16_384);
	});
});
