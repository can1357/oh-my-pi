import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { tokenrhythmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://tokenrhythm.studio/v1";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

/** Mirrors a discovered row: `/v1/models` carries no capability metadata, so `reasoning` starts false. */
function buildTokenRhythm(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "tokenrhythm",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

describe("TokenRhythm discovery", () => {
	test("maps limits from the authenticated roster and leaves CNY prices unpriced", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = tokenrhythmModelManagerOptions({
			apiKey: "tokenrhythm-test-key",
			fetch: rosterFetch(
				[
					{
						id: "deepseek-v4-pro-0813",
						object: "model",
						owned_by: "tokenrhythm",
						context_length: 1_000_000,
						max_completion_tokens: 384_000,
						pricing: { currency: "CNY", unit: "per_1m_tokens", prompt: "4.5", completion: "13.5" },
					},
					{ id: "glm-5.3", object: "model", context_length: 1_048_576, max_completion_tokens: 131_072 },
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer tokenrhythm-test-key" }]);
		expect(models.map(model => model.id)).toEqual(["deepseek-v4-pro-0813", "glm-5.3"]);
		expect(models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens: 384_000 });
		expect(models[1]).toMatchObject({ contextWindow: 1_048_576, maxTokens: 131_072 });
		// A CNY card must never be read as a USD rate.
		expect(getModelPricingStatus(models[0])).not.toBe("fixed");
	});

	test("the seed shows without a key and the live roster replaces it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-tokenrhythm-"));
		try {
			// Supply the KDL-authored seed so the test targets the rule/descriptor
			// contract rather than a volatile generated bundle slice.
			const withoutKey = await resolveProviderModels(
				{
					...tokenrhythmModelManagerOptions({}),
					staticModels: seedModels<"openai-completions">("tokenrhythm"),
					cacheDbPath: path.join(tempDir, "keyless.db"),
				},
				"online-if-uncached",
			);
			expect(withoutKey.models.map(model => model.id)).toEqual(["deepseek-v4-pro-0813"]);

			const withLive = await resolveProviderModels(
				{
					...tokenrhythmModelManagerOptions({
						apiKey: "test-key",
						fetch: rosterFetch([{ id: "glm-5.3", context_length: 1_048_576, max_completion_tokens: 131_072 }]),
					}),
					cacheDbPath: path.join(tempDir, "live.db"),
				},
				"online",
			);
			expect(withLive.models.map(model => model.id)).toEqual(["glm-5.3"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("TokenRhythm capability rules", () => {
	test("DeepSeek V4 offers off plus low/high/max", () => {
		for (const id of ["deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "deepseek-flash"]) {
			const model = buildTokenRhythm(id);
			expect(model.reasoning).toBe(true);
			expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.requiresEffort).toBeFalsy();
			expect(model.compat?.thinkingFormat).toBe("zai");
			expect(model.compat?.supportsReasoningEffort).toBe(true);
		}
	});

	test("Qwen 3.7/3.8 and Seed 2.1 offer only the toggle", () => {
		for (const id of [
			"qwen3.7-flash",
			"qwen3.7-max",
			"qwen3.8-27b",
			"qwen3.8-flash",
			"qwen3.8-max",
			"seed-2.1-pro",
			"seed-2.1-turbo",
		]) {
			const model = buildTokenRhythm(id);
			expect(model.reasoning).toBe(true);
			expect(getSupportedEfforts(model)).toEqual([Effort.High]);
			expect(model.thinking?.requiresEffort).toBeFalsy();
			expect(model.compat?.supportsReasoningEffort).toBe(false);
			expect(model.compat?.reasoningDisableMode).toBe("zai-thinking-disabled");
		}
	});

	test("always-on families cannot be switched off and send no disable field", () => {
		for (const id of [
			"glm-5.1",
			"glm-5.2",
			"glm-5.3",
			"glm-5.3-flash",
			"kimi-k2.6",
			"kimi-k2.7-code",
			"longcat-2.0",
			"minimax-m2.7",
			"mimo-v2.5-pro",
		]) {
			const model = buildTokenRhythm(id);
			expect(model.reasoning).toBe(true);
			expect(getSupportedEfforts(model)).toEqual([Effort.High]);
			expect(model.thinking?.requiresEffort).toBe(true);
			expect(model.compat?.supportsReasoningEffort).toBe(false);
			expect(model.compat?.reasoningDisableMode).toBe("omit");
		}
	});
});
