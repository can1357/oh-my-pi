import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { trustedRouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { normalizeTrustedRouterBaseUrl } from "@oh-my-pi/pi-catalog/wire/trustedrouter";

const MODELS_URL = "https://api.trustedrouter.com/v1/models";

function trustedRouterModelsPayload(): unknown {
	return {
		data: [
			{
				id: "trustedrouter/auto",
				name: "TrustedRouter Auto",
				context_length: 1_048_576,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: { prompt: "0.000000026375", completion: "0.00000007385" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: null },
				supported_parameters: ["tools", "tool_choice", "max_tokens", "structured_outputs", "response_format"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "auto_pool",
					aliases: ["nyte/auto", "trustedrouter/auto-routing", "nyte/auto-routing"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/zdr",
				name: "TrustedRouter ZDR",
				context_length: 1_048_576,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: { prompt: "0.00000003165", completion: "0.0000001266" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: null },
				supported_parameters: ["tools", "tool_choice", "max_tokens"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "zdr_pool",
					aliases: ["nyte/zdr"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/e2e",
				name: "TrustedRouter E2E",
				context_length: 1_048_576,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: { prompt: "0.00000001055", completion: "0.00000007385" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: null },
				supported_parameters: ["tools", "max_tokens"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "e2e_pool",
					aliases: ["nyte/e2e"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/confidential",
				name: "TrustedRouter Confidential",
				context_length: 1_048_576,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: { prompt: "0.00000001055", completion: "0.00000007385" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: null },
				supported_parameters: ["tools", "max_tokens"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "e2e_pool",
					aliases: ["nyte/confidential"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/fast",
				name: "TrustedRouter Fast",
				context_length: 131_072,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0.00000036925", completion: "0.00000079125" },
				top_provider: { context_length: 131_072, max_completion_tokens: null },
				supported_parameters: ["tools", "tool_choice", "max_tokens", "reasoning", "include_reasoning"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "fast_pool",
					aliases: ["nyte/fast"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/cheap",
				name: "TrustedRouter Cheap",
				context_length: 1_048_576,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0.00000001", completion: "0.00000001" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: null },
				supported_parameters: ["tools", "tool_choice", "max_tokens"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "cheap_pool",
					aliases: ["nyte/cheap"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "trustedrouter/free",
				name: "TrustedRouter Free",
				context_length: 128_000,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0", completion: "0" },
				top_provider: { context_length: 128_000, max_completion_tokens: null },
				supported_parameters: ["max_tokens"],
				trustedrouter: {
					provider: "trustedrouter",
					route_kind: "free_pool",
					aliases: ["nyte/free"],
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				id: "anthropic/claude-sonnet-4.6",
				name: "Anthropic: Claude Sonnet 4.6",
				context_length: 1_000_000,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: {
					prompt: "0.000003165",
					completion: "0.000015825",
					input_cache_read: "0.0000003165",
					input_cache_write: "0.00000395625",
				},
				top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
				supported_parameters: [
					"tools",
					"tool_choice",
					"max_tokens",
					"reasoning",
					"reasoning_effort",
					"include_reasoning",
				],
				reasoning: {
					mandatory: false,
					default_enabled: false,
					supported_efforts: ["max", "high", "medium", "low", "none"],
					default_effort: "medium",
				},
				trustedrouter: {
					provider: "anthropic",
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
					capabilities: {
						reasoning_effort: ["none", "low", "medium", "high", "max"],
						tools: true,
						vision: true,
					},
				},
			},
			{
				// Reasoning enabled by default, no effort ladder advertised.
				id: "qwen/qwen3-30b-a3b",
				name: "Qwen: Qwen3 30B A3B",
				context_length: 40_960,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0.0000001", completion: "0.0000003" },
				top_provider: { context_length: 40_960, max_completion_tokens: 16_384 },
				supported_parameters: ["tools", "tool_choice", "max_tokens", "reasoning", "include_reasoning"],
				reasoning: {
					mandatory: false,
					default_enabled: true,
					supported_efforts: [],
					default_effort: null,
				},
				trustedrouter: {
					provider: "deepinfra",
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				// Effort-only row without a `reasoning` object; verified ladder lives in `capabilities.reasoning_effort`.
				id: "google/gemini-2.5-flash-lite",
				name: "Google: Gemini 2.5 Flash Lite",
				context_length: 1_048_576,
				architecture: {
					modality: "text+image->text",
					input_modalities: ["text", "image"],
					output_modalities: ["text"],
				},
				pricing: { prompt: "0.0000001", completion: "0.0000004" },
				top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
				supported_parameters: ["tools", "max_tokens", "reasoning_effort", "seed"],
				trustedrouter: {
					provider: "google",
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
					capabilities: {
						reasoning_effort: ["none", "minimal", "low", "medium", "high"],
						tools: true,
						vision: true,
					},
				},
			},
			{
				// Filtered out: internal_only.
				id: "internal/debug-model",
				name: "Internal Debug",
				context_length: 8192,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0", completion: "0" },
				supported_parameters: ["max_tokens"],
				trustedrouter: {
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: true,
					supports_chat: true,
				},
			},
			{
				// Filtered out: configuration_hidden.
				id: "trustedrouter/athena",
				name: "TrustedRouter Athena",
				context_length: 128_000,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0", completion: "0" },
				supported_parameters: ["max_tokens"],
				trustedrouter: {
					configuration_hidden: true,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				// Filtered out: synthetic_monitor.
				id: "monitor/synthetic-probe",
				name: "Synthetic Monitor",
				context_length: 8192,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				pricing: { prompt: "0", completion: "0" },
				supported_parameters: ["max_tokens"],
				trustedrouter: {
					configuration_hidden: false,
					synthetic_monitor: true,
					internal_only: false,
					supports_chat: true,
				},
			},
			{
				// Filtered out: supports_chat: false (rerank/embeddings/video/decide/orchestration primitives).
				id: "voyage/rerank-2.5",
				name: "Voyage Rerank 2.5",
				context_length: 32_000,
				architecture: { modality: "text->scores", input_modalities: ["text"], output_modalities: ["scores"] },
				pricing: { prompt: "0.00000005", completion: "0" },
				supported_parameters: [],
				trustedrouter: {
					configuration_hidden: false,
					synthetic_monitor: false,
					internal_only: false,
					supports_chat: false,
				},
			},
		],
	};
}

function trustedRouterModelsFetch(payload: unknown = trustedRouterModelsPayload()): {
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

const originalBaseUrl = Bun.env.TRUSTEDROUTER_BASE_URL;

afterEach(() => {
	if (originalBaseUrl === undefined) delete Bun.env.TRUSTEDROUTER_BASE_URL;
	else Bun.env.TRUSTEDROUTER_BASE_URL = originalBaseUrl;
});

describe("TrustedRouter provider discovery", () => {
	test("discovers the public /v1/models catalog without an API key and maps pricing, limits, modalities, tools, and reasoning", async () => {
		const { calls, authorizations, fetch } = trustedRouterModelsFetch();
		const models = await trustedRouterModelManagerOptions({ fetch }).fetchDynamicModels?.();

		expect(calls).toEqual([MODELS_URL]);
		expect(authorizations).toEqual([null]);

		const claude = models?.find(model => model.id === "anthropic/claude-sonnet-4.6");
		expect(claude).toMatchObject({
			name: "Anthropic: Claude Sonnet 4.6",
			provider: "trustedrouter",
			api: "openai-completions",
			baseUrl: "https://api.trustedrouter.com/v1",
			reasoning: true,
			supportsTools: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
		expect(claude?.cost.input).toBeCloseTo(3.165, 6);
		expect(claude?.cost.output).toBeCloseTo(15.825, 6);
		expect(claude?.cost.cacheRead).toBeCloseTo(0.3165, 6);
		expect(claude?.cost.cacheWrite).toBeCloseTo(3.95625, 6);
		expect(claude?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
			defaultLevel: Effort.Medium,
			requiresEffort: false,
		});
		expect(claude?.compat?.supportsToolChoice).toBeUndefined();
	});

	test("filters internal_only, configuration_hidden, synthetic_monitor, and non-chat rows while preserving routing aliases", async () => {
		const { fetch } = trustedRouterModelsFetch();
		const models = await trustedRouterModelManagerOptions({ fetch }).fetchDynamicModels?.();
		const ids = models?.map(model => model.id) ?? [];

		for (const alias of [
			"trustedrouter/auto",
			"trustedrouter/zdr",
			"trustedrouter/e2e",
			"trustedrouter/confidential",
			"trustedrouter/fast",
			"trustedrouter/cheap",
			"trustedrouter/free",
		]) {
			expect(ids).toContain(alias);
		}
		expect(ids).not.toContain("internal/debug-model");
		expect(ids).not.toContain("trustedrouter/athena");
		expect(ids).not.toContain("monitor/synthetic-probe");
		expect(ids).not.toContain("voyage/rerank-2.5");

		const free = models?.find(model => model.id === "trustedrouter/free");
		expect(free).toMatchObject({
			reasoning: false,
			supportsTools: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: null,
		});

		const e2e = models?.find(model => model.id === "trustedrouter/e2e");
		expect(e2e?.supportsTools).toBe(true);
		expect(e2e?.compat?.supportsToolChoice).toBe(false);
	});

	test("keeps ladder-free reasoning models reasoning-capable without inventing efforts, and recovers capabilities.reasoning_effort", async () => {
		const { fetch } = trustedRouterModelsFetch();
		const models = await trustedRouterModelManagerOptions({ fetch }).fetchDynamicModels?.();

		const qwen = models?.find(model => model.id === "qwen/qwen3-30b-a3b");
		expect(qwen?.reasoning).toBe(true);
		// ThinkingConfig.efforts is never empty, so an empty supported_efforts list
		// leaves discovery ladder-free; wire-level enforcement is covered in
		// packages/ai/test/trustedrouter-reasoning-contract.test.ts.
		expect(qwen?.thinking).toBeUndefined();
		expect(qwen?.compat?.supportsReasoningEffort).toBe(false);

		const gemini = models?.find(model => model.id === "google/gemini-2.5-flash-lite");
		expect(gemini?.reasoning).toBe(true);
		expect(gemini?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: false,
		});
		expect(gemini?.compat?.reasoningDisableMode).toBe("none-effort");
	});

	test("normalizes the effort ladder to least -> most intensive and honors mandatory: true", async () => {
		const { fetch } = trustedRouterModelsFetch({
			data: [
				{
					id: "openai/gpt-5",
					name: "OpenAI: GPT-5",
					context_length: 400_000,
					architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
					pricing: { prompt: "0.00000125", completion: "0.00001" },
					top_provider: { max_completion_tokens: 128_000 },
					supported_parameters: ["tools", "tool_choice", "reasoning", "reasoning_effort"],
					reasoning: {
						mandatory: true,
						default_enabled: false,
						supported_efforts: ["high", "minimal", "medium", "low"],
						default_effort: "medium",
					},
					trustedrouter: { supports_chat: true },
				},
			],
		});
		const models = await trustedRouterModelManagerOptions({ fetch }).fetchDynamicModels?.();

		expect(models?.[0]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			defaultLevel: Effort.Medium,
			requiresEffort: true,
		});
		expect(models?.[0]?.compat?.reasoningDisableMode).toBe("lowest-effort");
		expect(models?.[0]?.compat?.whenThinking).toBeUndefined();
	});

	test("preserves authoritative mandatory/disableable state through buildModel for ladder-free rows", async () => {
		const { fetch } = trustedRouterModelsFetch({
			data: [
				{
					// `-thinking` id implies mandatory reasoning by identity, but the row
					// explicitly publishes `mandatory: false` without an effort ladder.
					id: "qwen/qwen3-235b-a22b-thinking-2507",
					name: "Qwen3 235B A22B Thinking 2507",
					context_length: 128_000,
					architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
					pricing: { prompt: "0.00000047475", completion: "0.0000036925" },
					top_provider: { max_completion_tokens: 16_384 },
					supported_parameters: ["tools", "tool_choice", "max_tokens", "reasoning", "include_reasoning"],
					reasoning: {
						mandatory: false,
						default_enabled: false,
						supported_efforts: [],
						default_effort: null,
					},
					trustedrouter: { supports_chat: true },
				},
				{
					// Non-`-thinking` id whose row publishes `mandatory: true` without an effort ladder.
					id: "deepseek/deepseek-r1-0528",
					name: "DeepSeek: R1 0528",
					context_length: 128_000,
					architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
					pricing: { prompt: "0.0000005275", completion: "0.00000226825" },
					top_provider: { max_completion_tokens: 32_000 },
					supported_parameters: ["tools", "max_tokens", "reasoning", "include_reasoning"],
					reasoning: {
						mandatory: true,
						default_enabled: false,
						supported_efforts: [],
						default_effort: null,
					},
					trustedrouter: { supports_chat: true },
				},
			],
		});
		const specs = await trustedRouterModelManagerOptions({ fetch }).fetchDynamicModels?.();
		const qwen = buildModel(
			specs?.find(model => model.id === "qwen/qwen3-235b-a22b-thinking-2507") as ModelSpec<"openai-completions">,
		);
		expect(qwen.reasoning).toBe(true);
		expect(qwen.thinking?.requiresEffort).toBe(false);
		expect(qwen.compat.supportsReasoningEffort).toBe(false);

		const r1 = buildModel(
			specs?.find(model => model.id === "deepseek/deepseek-r1-0528") as ModelSpec<"openai-completions">,
		);
		expect(r1.reasoning).toBe(true);
		expect(r1.thinking?.requiresEffort).toBe(true);
		expect(r1.compat.supportsReasoningEffort).toBe(false);
	});

	test("honors baseUrl and TRUSTEDROUTER_BASE_URL overrides and normalizes /v1", async () => {
		const { calls, authorizations, fetch } = trustedRouterModelsFetch();
		await trustedRouterModelManagerOptions({
			apiKey: "sk-tr-test",
			baseUrl: "https://api-europe-west4.quillrouter.com/",
			fetch,
		}).fetchDynamicModels?.();

		expect(calls).toEqual(["https://api-europe-west4.quillrouter.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-tr-test"]);

		Bun.env.TRUSTEDROUTER_BASE_URL = "https://api-europe-west4.quillrouter.com";
		const envFetch = trustedRouterModelsFetch();
		await trustedRouterModelManagerOptions({ fetch: envFetch.fetch }).fetchDynamicModels?.();
		expect(envFetch.calls).toEqual(["https://api-europe-west4.quillrouter.com/v1/models"]);

		expect(normalizeTrustedRouterBaseUrl("   ")).toBe("https://api.trustedrouter.com/v1");
		expect(
			resolveModelCacheProviderId("trustedrouter", { baseUrl: "https://api-europe-west4.quillrouter.com" }),
		).toBe(resolveModelCacheProviderId("trustedrouter", { baseUrl: "https://api-europe-west4.quillrouter.com/v1/" }));
	});

	test("retries /v1/models anonymously if a stale bearer key returns 401", async () => {
		const authorizations: (string | null)[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			const auth = new Headers(init?.headers).get("authorization");
			authorizations.push(auth);
			if (auth) {
				return Response.json({ error: { code: 401, message: "Invalid API key" } }, { status: 401 });
			}
			return Response.json(trustedRouterModelsPayload());
		};

		const models = await trustedRouterModelManagerOptions({ apiKey: "sk-tr-stale", fetch }).fetchDynamicModels?.();
		expect(authorizations).toEqual(["Bearer sk-tr-stale", null]);
		expect(models?.some(model => model.id === "trustedrouter/auto")).toBe(true);
	});

	test("caches discovered models per endpoint and serves them offline", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-trustedrouter-"));
		try {
			const cacheDbPath = path.join(dir, "catalog.db");
			const live = trustedRouterModelsFetch();
			const online = await resolveProviderModels(
				{ ...trustedRouterModelManagerOptions({ fetch: live.fetch }), cacheDbPath },
				"online",
			);
			expect(online.models.find(model => model.id === "anthropic/claude-sonnet-4.6")?.thinking?.efforts).toEqual([
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.Max,
			]);

			const offline = await resolveProviderModels(
				{ ...trustedRouterModelManagerOptions({ fetch: live.fetch }), cacheDbPath },
				"offline",
			);
			expect(offline.models.some(model => model.id === "trustedrouter/auto")).toBe(true);
			expect(live.calls).toHaveLength(1);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
