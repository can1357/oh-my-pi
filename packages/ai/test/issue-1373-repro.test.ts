import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
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

function budgetModel(id: string, requiresEffort = false): Model<"bedrock-converse-stream"> {
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
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			requiresEffort,
		},
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
		output_config?: { effort?: string };
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

async function captureSimpleBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options: SimpleStreamOptions = {},
): Promise<ThinkingPayload> {
	const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
	const stream = streamSimple(model, baseContext, {
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as ThinkingPayload);
			return undefined;
		},
	});
	await stream.result();
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

	it("preserves adaptive thinking mode without fabricating an effort", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"), {
			anthropicThinkingMode: "adaptive",
		});
		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
		expect(payload.additionalModelRequestFields?.output_config?.effort).toBeUndefined();
	});

	it("keeps default no-reasoning adaptive requests thinking-free", async () => {
		const payload = await captureBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"));
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("lets disableReasoning suppress a supplied effort", async () => {
		const { promise, resolve } = Promise.withResolvers<ThinkingPayload>();
		const stream = streamSimple(adaptiveModel("anthropic.claude-opus-4-7"), baseContext, {
			signal: abortedSignal(),
			reasoning: Effort.High,
			disableReasoning: true,
			onPayload: payload => {
				resolve(payload as ThinkingPayload);
				return undefined;
			},
		});
		await stream.result();
		const payload = await promise;
		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("maps neutral thinking modes before Bedrock option shaping", async () => {
		const adaptivePayload = await captureSimpleBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"), {
			thinkingMode: "adaptive",
		});
		expect(adaptivePayload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
		expect(adaptivePayload.additionalModelRequestFields?.output_config?.effort).toBeUndefined();
		const budgetAdaptivePayload = await captureSimpleBedrockPayload(
			budgetModel("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
			{
				thinkingMode: "adaptive",
			},
		);
		expect(budgetAdaptivePayload.additionalModelRequestFields).toBeUndefined();
		const offPayload = await captureSimpleBedrockPayload(adaptiveModel("anthropic.claude-opus-4-7"), {
			reasoning: Effort.High,
			thinkingMode: "off",
		});
		expect(offPayload.additionalModelRequestFields).toBeUndefined();
		const mandatoryOffPayload = await captureSimpleBedrockPayload(budgetModel("minimax.m2.1", true), {
			reasoning: Effort.High,
			thinkingMode: "off",
		});
		expect(mandatoryOffPayload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: 1024,
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
