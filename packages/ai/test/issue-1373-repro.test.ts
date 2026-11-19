import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;

beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});

afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

function adaptiveModel(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
	});
}

function budgetModel(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	});
}

const baseContext: Context = {
	systemPrompt: ["You are concise."],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

interface ThinkingPayload {
	additionalModelRequestFields?: {
		thinking?: { type?: string; display?: string; budget_tokens?: number };
	};
}

function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: Parameters<typeof streamBedrock>[2] = {},
): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	void streamBedrock(model, baseContext, {
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	return promise;
}

describe("issue #1373: Bedrock Claude thinkingDisplay", () => {
	it("defaults adaptive thinking to display=summarized on Opus 4.7+", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"), {
			reasoning: Effort.High,
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
	});

	it("defaults adaptive thinking to display=summarized on Fable/Mythos 5", async () => {
		for (const id of ["global.anthropic.claude-fable-5", "global.anthropic.claude-mythos-5"] as const) {
			const payload = await captureBedrockPayload(adaptiveModel(id), {
				reasoning: Effort.High,
			});
			expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
				type: "adaptive",
				display: "summarized",
			});
		}
	});

	it("respects explicit thinkingDisplay='omitted' on Opus 4.7+", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("eu.anthropic.claude-opus-4-7"), {
			reasoning: Effort.High,
			thinkingDisplay: "omitted",
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "omitted",
		});
	});

	it("omits display on adaptive Opus 4.6 (older models reject the field)", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("global.anthropic.claude-opus-4-6-v1"), {
			reasoning: Effort.High,
		});
		const thinking = payload.additionalModelRequestFields?.thinking;
		expect(thinking?.type).toBe("adaptive");
		expect(thinking?.display).toBeUndefined();
	});

	it("sends display=summarized by default on budget-based thinking models", async () => {
		const payload = await captureBedrockPayload(budgetModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"), {
			reasoning: Effort.High,
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			display: "summarized",
		});
		expect(typeof payload.additionalModelRequestFields?.thinking?.budget_tokens).toBe("number");
	});
});
