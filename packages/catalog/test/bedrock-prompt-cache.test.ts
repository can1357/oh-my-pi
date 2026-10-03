import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyModel, compareRevision, parseRevision } from "@oh-my-pi/pi-catalog/identity";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { buildGeneratedModel } from "../scripts/generate-models";

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

function bedrockMessagesSpec(provider: string, id: string): ModelSpec<"anthropic-messages"> {
	const baseUrl =
		provider === "bedrock-mantle"
			? "https://bedrock-mantle.{region}.api.aws/anthropic"
			: provider === "amazon-bedrock"
				? "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic"
				: "https://api.anthropic.com";
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function expectsAdaptiveDisplay(id: string): boolean {
	const identity = classifyModel("amazon-bedrock", id, { lenient: true });
	if (identity.class !== "anthropic" || identity.revision === undefined) return false;
	const revision = parseRevision(identity.revision);
	const floor = parseRevision(identity.family === "opus" ? "4.7" : "5");
	return (
		revision !== undefined &&
		floor !== undefined &&
		(identity.family === "opus" ||
			identity.family === "sonnet" ||
			identity.family === "fable" ||
			identity.family === "mythos") &&
		compareRevision(revision, floor) >= 0
	);
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
			const model = buildModel(bedrockSpec({ id }));
			expect(model.compat).toEqual({
				promptCacheMode: minimumTokens === 0 ? "none" : "explicit",
				supportsLongPromptCacheRetention: supportsLongRetention,
				promptCacheMinimumTokens: minimumTokens,
				promptCacheMaximumCheckpoints: minimumTokens === 0 ? 0 : 4,
				supportsForcedToolChoice: true,
				// bedrockSpec is reasoning:true → keepalive-free idle floor applies
				// (900s for the adaptive-thinking family, 600s otherwise).
				streamIdleTimeoutMs: expectsAdaptiveDisplay(id) ? 900_000 : 600_000,
				// Converse positions content blocks by wire index, so a block can land
				// above already-rendered text; the TUI must not retire streamed rows early.
				streamRevision: "possible",
			});
			if (minimumTokens === 0) {
				expect(model.promptCache).toBeUndefined();
			} else {
				expect(model.promptCache).toEqual(supportsLongRetention ? { short: 300, long: 3600 } : { short: 300 });
			}
		}
	});

	test("generation recomputes lifetimes from current policy instead of a previous snapshot row", () => {
		const stale = { short: 999, long: 9999 };
		const cached = buildGeneratedModel(bedrockSpec({ promptCache: stale, promptCacheConfig: stale }));
		expect(cached.promptCache).toEqual({ short: 300 });
		expect(cached.promptCacheConfig).toBeUndefined();

		const uncached = buildGeneratedModel({
			...bedrockSpec(),
			id: "gpt-5.2",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			promptCache: stale,
			promptCacheConfig: stale,
		});
		expect(uncached.promptCache).toBeUndefined();
		expect(uncached.promptCacheConfig).toBeUndefined();
	});

	test("keeps Bedrock Converse cache, pricing, and limit rules on Bedrock Runtime", () => {
		const cost = { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 8 };
		const model = buildModel(
			bedrockSpec({
				provider: "openrouter",
				cost,
				contextWindow: 512_000,
				maxTokens: 64_000,
			}),
		);
		expect(model.promptCache).toBeUndefined();
		expect(model.compat.promptCacheMode).toBe("none");
		expect(model.cost).toEqual(cost);
		expect(model.contextWindow).toBe(512_000);
		expect(model.maxTokens).toBe(64_000);
	});

	test("declares only the short lifetime for supported Bedrock Claude Messages families", () => {
		const supportedIds = [
			"us.anthropic.claude-opus-4-7",
			"us.anthropic.claude-sonnet-4-6",
			"anthropic.claude-haiku-4-5-20251001-v1:0",
			"anthropic.claude-fable-5",
			"anthropic.claude-mythos-5",
			"anthropic.claude-mythos-preview",
		] as const;
		for (const provider of ["amazon-bedrock", "bedrock-mantle"] as const) {
			for (const id of supportedIds) {
				expect(buildModel(bedrockMessagesSpec(provider, id)).promptCache).toEqual({ short: 300 });
			}
		}

		// Older AWS Messages revisions, non-Claude IDs, foreign providers, and
		// Claude IDs on another API do not acquire a Bedrock warming lifetime.
		for (const [provider, id] of [
			["amazon-bedrock", "us.anthropic.claude-opus-4-6"],
			["amazon-bedrock", "us.anthropic.claude-sonnet-4-5"],
			["amazon-bedrock", "us.amazon.nova-lite-v1:0"],
			["bedrock-mantle", "openai.gpt-5.6-terra"],
			["openrouter", "us.anthropic.claude-opus-4-7"],
		] as const) {
			expect(buildModel(bedrockMessagesSpec(provider, id)).promptCache).toBeUndefined();
		}
		expect(
			buildModel({
				...bedrockMessagesSpec("amazon-bedrock", "us.anthropic.claude-sonnet-5"),
				api: "openai-responses",
			}).promptCache,
		).toBeUndefined();

		// The direct provider keeps its established short/long policy.
		expect(buildModel(bedrockMessagesSpec("anthropic", "claude-opus-4-7")).promptCache).toEqual({
			short: 300,
			long: 3600,
		});
	});

	test("models exact cache-capable Nova IDs for explicit 5m checkpoints", () => {
		const expected = {
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: false,
			promptCacheMinimumTokens: 1024,
			promptCacheMaximumCheckpoints: 4,
			supportsForcedToolChoice: true,
			streamRevision: "possible",
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
			const model = buildModel(bedrockSpec({ id }));
			expect(model.compat).toEqual({ ...expected, streamIdleTimeoutMs: 600_000 });
			expect(model.promptCache).toBeUndefined();
		}
	});

	test("does not grant the Bedrock Mantle GPT catalog rows a cache lifetime", () => {
		expect(
			buildModel({
				id: "openai.gpt-5.6-terra",
				name: "GPT-5.6 Terra",
				api: "openai-responses",
				provider: "bedrock-mantle",
				baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 },
				contextWindow: 272_000,
				maxTokens: 128_000,
			}).promptCache,
		).toBeUndefined();
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
