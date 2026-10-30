import { describe, expect, test } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function budgetModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-sonnet-4-5-v1",
		name: "Claude Sonnet 4.5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	});
}

function adaptiveModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
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
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
	});
}

const context: Context = {
	systemPrompt: ["be terse"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

interface ThinkingPayload {
	inferenceConfig?: { maxTokens?: number };
	additionalModelRequestFields?: {
		thinking?: { type?: string; budget_tokens?: number };
		reasoning?: { effort?: string };
	};
}

/** Every Converse request carries `messages` and `inferenceConfig`; reject anything else. */
function isThinkingPayload(payload: unknown): payload is ThinkingPayload {
	if (typeof payload !== "object" || payload === null) return false;
	const { messages, inferenceConfig } = payload as { messages?: unknown; inferenceConfig?: unknown };
	return Array.isArray(messages) && typeof inferenceConfig === "object" && inferenceConfig !== null;
}

/** Capture the mapped Bedrock wire payload through the public streamSimple path. */
async function capture(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions,
): Promise<ThinkingPayload> {
	const controller = new AbortController();
	const { promise, resolve, reject } = Promise.withResolvers<ThinkingPayload>();
	void streamSimple(model, context, {
		apiKey: "test-key",
		signal: controller.signal,
		...options,
		onPayload: payload => {
			if (!isThinkingPayload(payload)) {
				reject(new Error("expected a Bedrock request payload"));
				controller.abort();
				return undefined;
			}
			resolve(payload);
			controller.abort();
			return undefined;
		},
	});
	return promise;
}

describe("Bedrock explicit reasoning-off preserves caller output caps", () => {
	test("disableReasoning drops thinking instead of inflating a capped request", async () => {
		const payload = await capture(budgetModel(), {
			maxTokens: 32,
			reasoning: Effort.Medium,
			disableReasoning: true,
		});
		expect(payload.inferenceConfig?.maxTokens).toBe(32);
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
	});

	test("forceReasoningOff drops thinking instead of inflating a capped request", async () => {
		const payload = await capture(budgetModel(), {
			maxTokens: 32,
			reasoning: Effort.Medium,
			forceReasoningOff: true,
		});
		expect(payload.inferenceConfig?.maxTokens).toBe(32);
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
	});

	test("effort-routed models honor explicit off before the budget early-return", async () => {
		const payload = await capture(adaptiveModel(), {
			maxTokens: 32,
			reasoning: Effort.High,
			disableReasoning: true,
		});
		expect(payload.inferenceConfig?.maxTokens).toBe(32);
		expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
		expect(payload.additionalModelRequestFields?.reasoning).toBeUndefined();
	});

	test("requested reasoning still inflates the cap when nothing disabled it", async () => {
		const payload = await capture(budgetModel(), { maxTokens: 32, reasoning: Effort.Medium });
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({ type: "enabled" });
		expect(payload.inferenceConfig?.maxTokens).toBeGreaterThan(32);
	});
});
