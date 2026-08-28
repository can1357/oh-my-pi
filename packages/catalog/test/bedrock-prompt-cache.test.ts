import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { supportsAdaptiveThinkingDisplay } from "@oh-my-pi/pi-catalog/identity";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function bedrockSpec(
	overrides: Partial<ModelSpec<"bedrock-converse-stream">> = {},
): ModelSpec<"bedrock-converse-stream"> {
	return {
		id: "anthropic.claude-opus-4-6-v1",
		name: "Claude Opus 4.6",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		...overrides,
	};
}

describe("Bedrock prompt-cache compat", () => {
	test("resolves the AWS-documented capability for every cache-priced bundled Claude family", () => {
		const cases = [
			{
				id: "anthropic.claude-3-5-haiku-20241022-v1:0",
				minimumTokens: 2048,
				supportsLongRetention: false,
			},
			// Current AWS docs do not advertise Converse cache checkpoints for this
			// legacy v1 model, so catalog cache pricing alone must not enable them.
			{
				id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
				minimumTokens: 0,
				supportsLongRetention: false,
			},
			{
				id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
				minimumTokens: 1024,
				supportsLongRetention: false,
			},
			{
				id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
				minimumTokens: 1024,
				supportsLongRetention: false,
			},
			{ id: "anthropic.claude-fable-5", minimumTokens: 1024, supportsLongRetention: true },
			{
				id: "anthropic.claude-haiku-4-5-20251001-v1:0",
				minimumTokens: 4096,
				supportsLongRetention: true,
			},
			{
				id: "anthropic.claude-opus-4-1-20250805-v1:0",
				minimumTokens: 1024,
				supportsLongRetention: false,
			},
			{
				id: "anthropic.claude-opus-4-20250514-v1:0",
				minimumTokens: 1024,
				supportsLongRetention: false,
			},
			{
				id: "anthropic.claude-opus-4-5-20251101-v1:0",
				minimumTokens: 4096,
				supportsLongRetention: true,
			},
			{ id: "anthropic.claude-opus-4-6-v1", minimumTokens: 4096, supportsLongRetention: false },
			{ id: "global.anthropic.claude-opus-4-7", minimumTokens: 4096, supportsLongRetention: true },
			{ id: "us.anthropic.claude-opus-4-8", minimumTokens: 4096, supportsLongRetention: true },
			{
				id: "anthropic.claude-sonnet-4-20250514-v1:0",
				minimumTokens: 1024,
				supportsLongRetention: false,
			},
			{
				id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
				minimumTokens: 4096,
				supportsLongRetention: true,
			},
			{ id: "anthropic.claude-sonnet-4-6", minimumTokens: 1024, supportsLongRetention: false },
			{ id: "us.anthropic.claude-sonnet-5", minimumTokens: 4096, supportsLongRetention: true },
		] as const;

		for (const { id, minimumTokens, supportsLongRetention } of cases) {
			expect(buildModel(bedrockSpec({ id })).compat).toEqual({
				promptCacheMode: minimumTokens === 0 ? "none" : "explicit",
				supportsLongPromptCacheRetention: supportsLongRetention,
				promptCacheMinimumTokens: minimumTokens,
				promptCacheMaximumCheckpoints: minimumTokens === 0 ? 0 : 4,
				// bedrockSpec is reasoning:true → keepalive-free idle floor applies
				// (900s for the adaptive-thinking family, 600s otherwise).
				streamIdleTimeoutMs: supportsAdaptiveThinkingDisplay(id) ? 900_000 : 600_000,
			});
		}
	});

	test("models exact cache-capable Nova IDs for explicit 5m checkpoints", () => {
		const expected = {
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: false,
			promptCacheMinimumTokens: 1024,
			promptCacheMaximumCheckpoints: 4,
		} as const;

		for (const id of [
			"us.amazon.nova-lite-v1:0",
			"us.amazon.nova-micro-v1:0",
			"us.amazon.nova-pro-v1:0",
			"us.amazon.nova-premier-v1:0",
			"global.amazon.nova-2-lite-v1:0",
		] as const) {
			const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
			expect(model?.compat).toEqual({
				...expected,
				streamIdleTimeoutMs: model?.reasoning ? 600_000 : undefined,
			});
		}

		// AWS documents in-region model IDs plus geo/global inference-profile IDs.
		for (const id of [
			"amazon.nova-lite-v1:0",
			"amazon.nova-micro-v1:0",
			"amazon.nova-pro-v1:0",
			"amazon.nova-premier-v1:0",
			"us.amazon.nova-premier-v1:0",
			"amazon.nova-2-lite-v1:0",
			"us.amazon.nova-2-lite-v1:0",
			"eu.amazon.nova-2-lite-v1:0",
			"jp.amazon.nova-2-lite-v1:0",
			"global.amazon.nova-2-lite-v1:0",
		] as const) {
			expect(buildModel(bedrockSpec({ id })).compat).toEqual({ ...expected, streamIdleTimeoutMs: 600_000 });
		}
	});

	test("keeps unknown routes conservative and honors sparse profile overrides", () => {
		const opaqueProfileId = "arn:aws:bedrock:us-east-1:123:application-inference-profile/opaque";
		const unknown = buildModel(bedrockSpec({ id: opaqueProfileId }));
		expect(unknown.compat.promptCacheMode).toBe("none");

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
		]) {
			expect(buildModel(bedrockSpec({ id })).compat.promptCacheMode).toBe("none");
		}
		const sparse = {
			promptCacheMode: "explicit" as const,
			promptCacheMinimumTokens: 1024,
			promptCacheMaximumCheckpoints: 4,
		};
		const configured = buildModel(
			bedrockSpec({ id: "arn:aws:bedrock:us-east-1:123:application-inference-profile/opaque", compat: sparse }),
		);
		expect(configured.compat).toEqual({ ...unknown.compat, ...sparse });
		expect(configured.compatConfig).toBe(sparse);
	});

	test("keeps bundled models memoized while materializing resolved compat", () => {
		const first = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "anthropic.claude-opus-4-6-v1");
		const second = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "anthropic.claude-opus-4-6-v1");
		expect(first).toBe(second);
		expect(first?.compat.promptCacheMode).toBe("explicit");
	});
});
