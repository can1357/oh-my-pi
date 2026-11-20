import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { crusoeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { mergePreviousSnapshotModels } from "../scripts/generate-models";

const BASE_URL = "https://api.inference.crusoecloud.com/v1";

describe("Crusoe provider discovery", () => {
	test("authenticates discovery, prices live IDs, and excludes speech-only models", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({
				object: "list",
				data: [
					{ id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model" },
					{ id: "Qwen/Qwen3.8-27B", object: "model" },
					{ id: "nvidia/NVIDIA-Nemotron-3.5-Super-VL", object: "model" },
					{ id: "nvidia/Nemotron-3.5-Lightning-30B-A3B", object: "model" },
					{ id: "nvidia/Nemotron-3-VoiceChat", object: "model" },
				],
			});
		};

		const options = crusoeModelManagerOptions({ apiKey: "crusoe-test-key", fetch });
		const models = ((await options.fetchDynamicModels?.()) ?? []).map(model => buildModel(model));

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer crusoe-test-key" }]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(models).toHaveLength(4);
		expect(models.find(model => model.id === "deepseek-ai/DeepSeek-V4.1-Flash")).toMatchObject({
			provider: "crusoe",
			api: "openai-completions",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.29, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
			contextWindow: 1_048_576,
		});
		expect(models.find(model => model.id === "Qwen/Qwen3.8-27B")?.cost).toEqual({
			input: 0.25,
			output: 2,
			cacheRead: 0.15,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "nvidia/NVIDIA-Nemotron-3.5-Super-VL")?.cost).toEqual({
			input: 0.1,
			output: 0.4,
			cacheRead: 0.08,
			cacheWrite: 0,
		});
		expect(models.find(model => model.id === "nvidia/Nemotron-3.5-Lightning-30B-A3B")?.cost).toEqual({
			input: 0.05,
			output: 0.2,
			cacheRead: 0.03,
			cacheWrite: 0,
		});
	});

	test("bundles only the reviewed credential-independent fallback roster", () => {
		expect(getBundledModels("crusoe").map(model => model.id)).toEqual([
			"Qwen/Qwen3.8-27B",
			"deepseek-ai/DeepSeek-V4.1-Flash",
			"google/gemma-4-31b-it",
			"nvidia/NVIDIA-Nemotron-3.5-Super-VL",
			"nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B",
			"nvidia/Nemotron-3.5-Lightning-30B-A3B",
			"openai/gpt-oss-120b",
			"zai-org/GLM-5.3",
			"zai-org/GLM-5.3-Flash",
		]);
	});

	test("drops credential-scoped rows from previous generated snapshots", () => {
		const stale = buildModel({
			id: "retired-account-model",
			name: "Retired Account Model",
			api: "openai-completions",
			provider: "crusoe",
			baseUrl: BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_000,
		});

		expect(mergePreviousSnapshotModels([], { crusoe: { [stale.id]: stale } }, new Set())).toEqual([]);
	});

	test("does not probe the credential-protected roster without a key", () => {
		expect(crusoeModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
