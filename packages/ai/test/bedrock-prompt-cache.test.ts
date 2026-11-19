import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv } from "./helpers";

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "1h" };
}
interface Payload {
	system?: Array<{ text: string } | CachePoint>;
	messages: Array<{ role: string; content: Array<{ text: string } | CachePoint> }>;
	inferenceConfig: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: unknown;
	additionalModelRequestFields?: Record<string, unknown>;
}

const context: Context = {
	systemPrompt: ["Use concise answers."],
	messages: [{ role: "user", content: "What is the answer?", timestamp: 0 }],
};

function model(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(
	bedrockModel: Model<"bedrock-converse-stream">,
	cacheRetention: "none" | "short" | "long",
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	void streamBedrock(bedrockModel, context, {
		bearerToken: "test-token",
		signal: abortedSignal(),
		cacheRetention,
		onPayload: payload => {
			resolve(payload as Payload);
		},
	});
	return promise;
}

function checkpoints(payload: Payload): CachePoint[] {
	return [...(payload.system ?? []), ...payload.messages.flatMap(message => message.content)].filter(
		(block): block is CachePoint => "cachePoint" in block,
	);
}

describe("Bedrock prompt cache checkpoints", () => {
	test("downgrades unsupported long retention to default 5m at the existing two checkpoint locations", async () => {
		const payload = await capturePayload(model("anthropic.claude-opus-4-6-v1"), "long");
		expect(payload.system).toEqual([{ text: "Use concise answers." }, { cachePoint: { type: "default" } }]);
		expect(payload.messages).toEqual([
			{ role: "user", content: [{ text: "What is the answer?" }, { cachePoint: { type: "default" } }] },
		]);
		expect(checkpoints(payload)).toHaveLength(2);
	});

	test("uses 1h only for catalog-confirmed long-retention models", async () => {
		const payload = await capturePayload(model("anthropic.claude-haiku-4-5-20251001-v1:0"), "long");
		expect(checkpoints(payload)).toEqual([
			{ cachePoint: { type: "default", ttl: "1h" } },
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
	});

	test("emits checkpoints for the default bundled Opus 4.8 inference profile", async () => {
		const payload = await capturePayload(model("us.anthropic.claude-opus-4-8"), "long");
		expect(checkpoints(payload)).toEqual([
			{ cachePoint: { type: "default", ttl: "1h" } },
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
	});

	test("uses Bedrock's default 5m TTL for short retention", async () => {
		const payload = await capturePayload(model("anthropic.claude-haiku-4-5-20251001-v1:0"), "short");
		expect(checkpoints(payload)).toEqual([{ cachePoint: { type: "default" } }, { cachePoint: { type: "default" } }]);
	});

	test("emits default-5m checkpoints for every bundled Nova cache-capable payload", async () => {
		for (const id of [
			"us.amazon.nova-lite-v1:0",
			"us.amazon.nova-micro-v1:0",
			"us.amazon.nova-pro-v1:0",
			"us.amazon.nova-premier-v1:0",
		] as const) {
			const nova = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
			expect(nova).toBeDefined();
			const payload = await capturePayload(nova!, "long");
			expect(payload).toEqual({
				system: [{ text: "Use concise answers." }, { cachePoint: { type: "default" } }],
				messages: [
					{
						role: "user",
						content: [{ text: "What is the answer?" }, { cachePoint: { type: "default" } }],
					},
				],
				inferenceConfig: { maxTokens: undefined, temperature: undefined, topP: undefined },
				toolConfig: undefined,
				additionalModelRequestFields: undefined,
			});
		}
	});

	test("emits default-5m system and message checkpoints for Nova Premier's in-region ID", async () => {
		const payload = await capturePayload(model("amazon.nova-premier-v1:0"), "long");
		expect(payload.system).toEqual([{ text: "Use concise answers." }, { cachePoint: { type: "default" } }]);
		expect(payload.messages).toEqual([
			{ role: "user", content: [{ text: "What is the answer?" }, { cachePoint: { type: "default" } }] },
		]);
	});

	test("emits default-5m checkpoints for every AWS-documented Nova 2 Lite ID", async () => {
		const expected: Payload = {
			system: [{ text: "Use concise answers." }, { cachePoint: { type: "default" } }],
			messages: [
				{
					role: "user",
					content: [{ text: "What is the answer?" }, { cachePoint: { type: "default" } }],
				},
			],
			inferenceConfig: { maxTokens: undefined, temperature: undefined, topP: undefined },
			toolConfig: undefined,
			additionalModelRequestFields: undefined,
		};

		const bundled = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "global.amazon.nova-2-lite-v1:0");
		expect(bundled).toBeDefined();
		expect(await capturePayload(bundled!, "long")).toEqual(expected);

		for (const id of [
			"amazon.nova-2-lite-v1:0",
			"us.amazon.nova-2-lite-v1:0",
			"eu.amazon.nova-2-lite-v1:0",
			"jp.amazon.nova-2-lite-v1:0",
			"global.amazon.nova-2-lite-v1:0",
		] as const) {
			expect(await capturePayload(model(id), "long")).toEqual(expected);
		}
	});

	test("does not emit checkpoints for unknown Nova IDs", async () => {
		for (const id of [
			"amazon.nova-lite-v1:1",
			"amazon.nova-micro-v1:1",
			"amazon.nova-pro-v1:1",
			"amazon.nova-premier-v1:1",
			"amazon.nova-2-lite-v1:1",
			"global.amazon.nova-2-lite-v1:1",
			"global.amazon.nova-2-lite-v2:0",
			"us.amazon.nova-2-lite-v1:0-preview",
			"us.amazon.nova-unknown-v1:0",
		] as const) {
			const payload = await capturePayload(model(id), "long");
			expect(payload.system).toEqual([{ text: "Use concise answers." }]);
			expect(payload.messages).toEqual([{ role: "user", content: [{ text: "What is the answer?" }] }]);
			expect(checkpoints(payload)).toHaveLength(0);
		}
	});

	test("does not exceed a configured checkpoint maximum", async () => {
		const base = model("anthropic.claude-haiku-4-5-20251001-v1:0");
		const disabled: Model<"bedrock-converse-stream"> = {
			...base,
			compat: { ...base.compat, promptCacheMaximumCheckpoints: 0 },
		};
		const single: Model<"bedrock-converse-stream"> = {
			...base,
			compat: { ...base.compat, promptCacheMaximumCheckpoints: 1 },
		};

		const disabledPayload = await capturePayload(disabled, "long");
		expect(checkpoints(disabledPayload)).toHaveLength(0);

		const singlePayload = await capturePayload(single, "long");
		expect(checkpoints(singlePayload)).toEqual([{ cachePoint: { type: "default", ttl: "1h" } }]);
		expect(singlePayload.messages[0]?.content).toEqual([
			{ text: "What is the answer?" },
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
		expect(singlePayload.system).toEqual([{ text: "Use concise answers." }]);
	});

	test("forces opaque profiles to default checkpoints without granting 1h retention", async () => {
		await withEnv({ AWS_BEDROCK_FORCE_CACHE: "1" }, async () => {
			const payload = await capturePayload(
				model("arn:aws:bedrock:us-east-1:1234567890:application-inference-profile/opaque-profile"),
				"long",
			);
			expect(checkpoints(payload)).toEqual([
				{ cachePoint: { type: "default" } },
				{ cachePoint: { type: "default" } },
			]);
		});
	});
});
