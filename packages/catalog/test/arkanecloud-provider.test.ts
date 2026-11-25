import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { arkaneCloudModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MODELS_URL = "https://console.arkanecloud.com/api/v2/models";

function arkaneCloudModelsPayload(): unknown {
	return {
		object: "list",
		data: [
			{
				id: "deepseek-ai/DeepSeek-V4-Flash",
				object: "model",
				created: 1_766_534_400,
				owned_by: "arkanecloud",
				name: "DeepSeek-V4-Flash",
				description: "DeepSeek MoE model",
				type: "text",
				pricing: { input: 0.2, output: 0.4, cache_read: 0.05, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "deepseek-ai/DeepSeek-V4-Flash",
				context_length: 1_048_576,
				max_input_tokens: 655_360,
				max_output_tokens: 393_216,
				input_modalities: ["text"],
				reasoning: { can_disable: true, enabled_by_default: true, supported_efforts: ["high", "xhigh"] },
				capabilities: { tool_calling: true, image_input: false },
			},
			{
				id: "moonshotai/Kimi-K2.5",
				object: "model",
				created: 1_769_487_076,
				owned_by: "arkanecloud",
				name: "KIMI-K2.5",
				description: "Moonshot AI multimodal mixture-of-experts model",
				type: "text",
				pricing: { input: 0.6, output: 3, cache_read: 0.2, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "moonshotai/Kimi-K2.5",
				context_length: 262_144,
				max_input_tokens: 131_072,
				max_output_tokens: 131_072,
				input_modalities: ["text", "image"],
				// Reasons by default and can be switched off, but exposes no effort dial.
				reasoning: { can_disable: true, enabled_by_default: true, supported_efforts: [] },
				capabilities: { tool_calling: true, image_input: true },
			},
			{
				id: "meta-llama/Llama-3.3-70B-Instruct",
				object: "model",
				created: 1_728_400_000,
				owned_by: "arkanecloud",
				name: "Llama 3.3 70B Instruct",
				description: "Large language model from Meta",
				type: "text",
				pricing: { input: 0.7, output: 0.7, cache_read: 0.2, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "meta-llama/Llama-3.3-70B-Instruct",
				context_length: 128_000,
				max_input_tokens: 64_000,
				max_output_tokens: 64_000,
				input_modalities: ["text"],
				// No `reasoning` key at all — the documented shape for a non-reasoning model.
				capabilities: { tool_calling: false, image_input: false },
			},
			{
				// `type: "image"` rows are served by /api/v2/images/generations, not the
				// chat endpoint, and are priced per image rather than per token.
				id: "black-forest-labs/flux-dev",
				object: "model",
				created: 1_728_400_000,
				owned_by: "arkanecloud",
				name: "FLUX.1 dev",
				description: "Image generation model",
				type: "image",
				pricing: { image: 0.01, unit: "per image" },
				endpoint: "/api/v2/images/generations",
				huggingface_id: "black-forest-labs/flux-dev",
				context_length: 0,
				max_input_tokens: 0,
				max_output_tokens: 0,
				input_modalities: ["text"],
				capabilities: { tool_calling: false, image_input: false },
			},
		],
	};
}

function arkaneCloudModelsFetch(payload: unknown = arkaneCloudModelsPayload()): {
	calls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

describe("ArkaneCloud provider discovery", () => {
	test("bearer-authenticates GET /api/v2/models and maps the published metadata", async () => {
		const { calls, authorizations, fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual([MODELS_URL]);
		expect(authorizations).toEqual(["Bearer ak_test"]);

		const flash = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash).toMatchObject({
			name: "DeepSeek-V4-Flash",
			provider: "arkanecloud",
			api: "openai-completions",
			baseUrl: "https://console.arkanecloud.com/api/v2",
			reasoning: true,
			input: ["text"],
			// Prices are published per million tokens — omp's ModelCost unit.
			cost: { input: 0.2, output: 0.4, cacheRead: 0.05, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 393_216,
		});
		// `tool_calling: true` is the upstream default, so nothing is stamped.
		expect(flash?.supportsTools).toBeUndefined();
		expect(flash?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.XHigh],
			requiresEffort: false,
		});
	});

	test("keeps a reasoning model without an effort dial reasoning-capable and ladder-free", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		const kimi = models?.find(model => model.id === "moonshotai/Kimi-K2.5");
		expect(kimi?.reasoning).toBe(true);
		// ThinkingConfig.efforts is never empty, so an empty supported_efforts list
		// means "no controllable surface", not "no efforts". This asserts the
		// discovery spec only: `buildModel` may still derive a canonical ladder
		// from model identity, which the wire-level tests in
		// packages/ai/test/arkanecloud-reasoning-contract.test.ts cover.
		expect(kimi?.thinking).toBeUndefined();
		expect(kimi?.input).toEqual(["text", "image"]);
	});

	test("maps an absent reasoning block and an explicit tool-calling opt-out", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		const llama = models?.find(model => model.id === "meta-llama/Llama-3.3-70B-Instruct");
		expect(llama?.reasoning).toBe(false);
		expect(llama?.thinking).toBeUndefined();
		// Only an explicit `false` is a real signal; it must reach the model spec.
		expect(llama?.supportsTools).toBe(false);
		expect(llama?.contextWindow).toBe(128_000);
		expect(llama?.maxTokens).toBe(64_000);
	});

	test("drops image-generation rows, which are not served by chat completions", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual([
			"deepseek-ai/DeepSeek-V4-Flash",
			"meta-llama/Llama-3.3-70B-Instruct",
			"moonshotai/Kimi-K2.5",
		]);
	});

	test("normalizes the effort ladder to least → most intensive and honors can_disable: false", async () => {
		const { fetch } = arkaneCloudModelsFetch({
			object: "list",
			data: [
				{
					id: "arkane/mandatory-reasoner",
					object: "model",
					name: "Mandatory Reasoner",
					type: "text",
					pricing: { input: 1, output: 2, cache_read: 0.1, unit: "per million tokens" },
					context_length: 200_000,
					max_output_tokens: 100_000,
					input_modalities: ["text"],
					// Wire order is not guaranteed, and `none` is the thinking-off value
					// rather than a selectable level.
					reasoning: { can_disable: false, enabled_by_default: true, supported_efforts: ["max", "none", "low"] },
					capabilities: { tool_calling: true, image_input: false },
				},
			],
		});
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(models?.[0]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Max],
			requiresEffort: true,
		});
	});

	test("honors a configured baseUrl override", async () => {
		const { calls, fetch } = arkaneCloudModelsFetch();
		await arkaneCloudModelManagerOptions({
			apiKey: "ak_test",
			baseUrl: "https://preprod.arkanecloud.com/api/v2/",
			fetch,
		}).fetchDynamicModels?.();

		expect(calls).toEqual(["https://preprod.arkanecloud.com/api/v2/models"]);
	});

	test("returns null when /api/v2/models rejects the key", async () => {
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { code: "unauthorized", message: "..." } }), { status: 401 });
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_bogus", fetch }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});

	test("serves no dynamic models without an API key", () => {
		expect(arkaneCloudModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("switching credentials refreshes both model access and prices within the cache TTL", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-arkanecloud-"));
		try {
			const cacheDbPath = path.join(dir, "catalog.db");
			const shared = {
				id: "deepseek-ai/DeepSeek-V4-Flash",
				type: "text",
				reasoning: { can_disable: true, supported_efforts: ["high", "xhigh"] },
			};
			const team = arkaneCloudModelsFetch({
				data: [
					{ ...shared, pricing: { input: 0 } },
					{ id: "restricted", type: "text" },
				],
			});
			const personal = arkaneCloudModelsFetch({ data: [{ ...shared, pricing: { input: 2 } }] });
			const first = await resolveProviderModels(
				{ ...arkaneCloudModelManagerOptions({ apiKey: "team", fetch: team.fetch }), cacheDbPath },
				"online",
			);
			expect(first.models.find(m => m.id === shared.id)?.cost.input).toBe(0);
			expect(first.models.some(m => m.id === "restricted")).toBe(true);
			const second = await resolveProviderModels(
				{ ...arkaneCloudModelManagerOptions({ apiKey: "personal", fetch: personal.fetch }), cacheDbPath },
				"online-if-uncached",
			);
			const cached = await resolveProviderModels(
				{ ...arkaneCloudModelManagerOptions({ apiKey: "personal", fetch: personal.fetch }), cacheDbPath },
				"offline",
			);
			expect(cached.models[0]?.thinking?.efforts).toEqual([Effort.High, Effort.XHigh]);
			expect(personal.authorizations).toEqual(["Bearer personal"]);
			expect(second.models.map(m => [m.id, m.cost.input])).toEqual([[shared.id, 2]]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
