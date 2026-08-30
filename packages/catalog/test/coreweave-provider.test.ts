import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	coreWeaveModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const COREWEAVE_ENV_KEYS = ["COREWEAVE_PROJECT", "WANDB_INFERENCE_PROJECT", "WANDB_ENTITY", "WANDB_PROJECT"] as const;
const ORIGINAL_ENV = new Map(COREWEAVE_ENV_KEYS.map(key => [key, Bun.env[key]]));

function restoreCoreWeaveEnv(): void {
	for (const key of COREWEAVE_ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
}

afterEach(() => {
	restoreCoreWeaveEnv();
	vi.restoreAllMocks();
});

describe("CoreWeave Serverless Inference provider support", () => {
	test("registers descriptor, default model, environment key, and bundled models", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "coreweave");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("openai/gpt-oss-120b");
		expect(descriptor?.catalogDiscovery?.label).toBe("CoreWeave Serverless Inference");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["COREWEAVE_API_KEY", "WANDB_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.coreweave).toBe("openai/gpt-oss-120b");

		const bundled = getBundledModels("coreweave");
		expect(bundled.find(model => model.id === "openai/gpt-oss-120b")).toMatchObject({
			api: "openai-completions",
			provider: "coreweave",
			baseUrl: "https://api.inference.wandb.ai/v1",
		});
	});

	test("discovers dynamic models with the CoreWeave project header", async () => {
		Bun.env.COREWEAVE_PROJECT = "team/project";
		delete Bun.env.WANDB_INFERENCE_PROJECT;
		delete Bun.env.WANDB_ENTITY;
		delete Bun.env.WANDB_PROJECT;

		const calls: Array<{ url: string; authorization: string | null; project: string | null }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: input.toString(),
				authorization: headers.get("authorization"),
				project: headers.get("openai-project"),
			});
			return new Response(
				JSON.stringify({
					data: [{ id: "openai/gpt-oss-120b", name: "GPT OSS 120B" }, { id: "meta-llama/Llama-3.1-8B-Instruct" }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as FetchImpl;

		const options = coreWeaveModelManagerOptions({ apiKey: "coreweave-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("coreweave");
		expect(calls).toEqual([
			{
				url: "https://api.inference.wandb.ai/v1/models",
				authorization: "Bearer coreweave-test-key",
				project: "team/project",
			},
		]);
		expect(models?.find(model => model.id === "openai/gpt-oss-120b")).toMatchObject({
			id: "openai/gpt-oss-120b",
			name: "GPT OSS 120B",
			api: "openai-completions",
			provider: "coreweave",
			baseUrl: "https://api.inference.wandb.ai/v1",
		});
	});

	test("maps stencil.so wandb metadata into OpenAI chat completions models", () => {
		const mapped = mapModelsDevToModels(
			{
				wandb: {
					models: {
						"openai/gpt-oss-120b": {
							id: "openai/gpt-oss-120b",
							name: "GPT OSS 120B",
							tool_call: true,
							reasoning: false,
							modalities: { input: ["text"] },
							limit: { context: 131072, output: 32768 },
							cost: { input: 0.15, output: 0.6 },
						},
					},
				},
			},
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		);

		const spec = mapped.find(model => model.provider === "coreweave");
		expect(spec).toMatchObject({
			id: "openai/gpt-oss-120b",
			name: "GPT OSS 120B",
			api: "openai-completions",
			provider: "coreweave",
			baseUrl: "https://api.inference.wandb.ai/v1",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 32768,
			cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		});
		// The effort ladder is rule-owned (classes/gpt-oss.kdl), not authored by
		// the discovery mapper; buildModel derives it from the flagged spec.
		if (!spec) throw new Error("coreweave row missing");
		expect(buildModel(spec).thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] });
	});
});
