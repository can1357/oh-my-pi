import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { DiscoveryAuthRejectionError } from "@oh-my-pi/pi-catalog/discovery/auth-rejection";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import {
	OPENZOO_DEFAULT_BASE_URL,
	openzooModelManagerOptions,
	resolveOpenzooBaseUrl,
} from "@oh-my-pi/pi-catalog/provider-models/openzoo";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ENV_KEYS = ["OPENZOO_BASE_URL", "OPENZOO_API_KEY"] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = ORIGINAL_ENV.get(key);
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
});

/**
 * Shape of `GET /v1/models` as the proxy serves it: OpenRouter-style ids with
 * per-token USD `pricing`, the bind ceiling as `context_length` (128M — not
 * the attention window), the real window as `max_model_len`, plus the router
 * aliases and the harness-compat twins the local proxy adds for editors that
 * hard-code bland ids.
 */
const OPENZOO_MODELS_PAYLOAD = {
	object: "list",
	data: [
		{
			id: "anthropic/claude-sonnet-4",
			object: "model",
			owned_by: "openrouter",
			pricing: { prompt: 3e-6, completion: 1.5e-5, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			context_window: 128_000_000,
			max_model_len: 1_000_000,
			max_output_tokens: 64_000,
			top_provider: { context_length: 128_000_000, max_completion_tokens: 64_000, is_moderated: false },
			display_name: "claude-sonnet-4 (anthropic)",
		},
		{
			id: "example-lab/not-in-any-catalog",
			object: "model",
			owned_by: "openrouter",
			pricing: { prompt: "8.34e-7", completion: "2.501e-6", unit: "USD", markup: 1 },
			context_length: 128_000_000,
			max_model_len: 1_048_576,
			top_provider: { context_length: 128_000_000, max_completion_tokens: 64_000, is_moderated: false },
			display_name: "not-in-any-catalog (example-lab)",
		},
		{
			id: "openzoo/auto",
			object: "model",
			owned_by: "openzoo",
			// Prompt only: the completion price arrives on a LATER alias row.
			pricing: { prompt: 1e-7, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			max_model_len: 32_768,
			max_output_tokens: null,
			top_provider: { context_length: 128_000_000, max_completion_tokens: null, is_moderated: false },
			display_name: "auto (openzoo)",
		},
		// Each later alias row carries only the component the first row omitted,
		// pinning the field-by-field fold (a whole-object merge would drop these).
		{ id: "openzoo-auto", object: "model", owned_by: "openzoo", pricing: { completion: 2e-7 } },
		{
			id: "auto",
			object: "model",
			owned_by: "openzoo",
			pricing: { prompt: 1e-7, completion: 2e-7 },
			max_output_tokens: 8192,
		},
		{ id: "gpt-5.6-auto", object: "model", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
		{
			id: "gpt-4o",
			object: "model",
			owned_by: "openzoo-alias",
			served_by: "openai/gpt-4o-2024-11-20",
			pricing: { prompt: 2.5e-6, completion: 1e-5, unit: "USD", markup: 1 },
			context_length: 128_000_000,
			display_name: "gpt-4o",
		},
		{
			id: "example-lab/reports-capabilities",
			object: "model",
			owned_by: "openrouter",
			pricing: { prompt: 1e-6, completion: 3e-6, unit: "USD", markup: 1 },
			max_model_len: 32_768,
			max_output_tokens: 4_096,
			display_name: "reports-capabilities (example-lab)",
			supported_parameters: ["tools", "reasoning"],
			architecture: { modality: "text+image", input_modalities: ["text", "image"] },
		},
	],
};

function stubFetch(seen: { urls: string[]; authorization: (string | null)[] }): FetchImpl {
	return async (input, init) => {
		seen.urls.push(String(input));
		seen.authorization.push(new Headers(init?.headers).get("Authorization"));
		return new Response(JSON.stringify(OPENZOO_MODELS_PAYLOAD), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("openzoo built-in provider", () => {
	test("ships no bundled catalog — the proxy's live /v1/models is the model list", () => {
		const entry = providerEntry("openzoo");
		expect(entry).toBeDefined();
		expect(entry?.defaultModel).toBe("auto");
		expect(entry?.allowUnauthenticated).toBe(true);
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(entry?.discovery).toBeUndefined();
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "openzoo");
		expect(descriptor).toMatchObject({
			defaultModel: "auto",
			allowUnauthenticated: true,
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(DEFAULT_MODEL_PER_PROVIDER.openzoo).toBe("auto");
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "openzoo")).toBe(false);
		expect(getBundledProviders()).not.toContain("openzoo");
	});

	test("counts as authenticated without any env var; OPENZOO_API_KEY still wins", () => {
		delete Bun.env.OPENZOO_API_KEY;
		expect(getEnvApiKey("openzoo")).toBe("openzoo-local");
		Bun.env.OPENZOO_API_KEY = "oz_tunnel-bearer";
		expect(getEnvApiKey("openzoo")).toBe("oz_tunnel-bearer");
	});

	test("registers an optional login flow", () => {
		const provider = getOAuthProviders().find(item => item.id === "openzoo");
		expect(provider?.name).toBe("openzoo (local x402 pay-per-call proxy)");
		expect(provider?.available).toBe(true);
	});

	test("resolves the base URL from config, then OPENZOO_BASE_URL, then the proxy default", () => {
		delete Bun.env.OPENZOO_BASE_URL;
		expect(resolveOpenzooBaseUrl()).toBe(OPENZOO_DEFAULT_BASE_URL);
		expect(OPENZOO_DEFAULT_BASE_URL).toBe("http://localhost:8402/v1");
		Bun.env.OPENZOO_BASE_URL = "http://localhost:9402/v1";
		expect(resolveOpenzooBaseUrl()).toBe("http://localhost:9402/v1");
		expect(resolveOpenzooBaseUrl("https://tunnel.example/v1/")).toBe("https://tunnel.example/v1");
		// The whole trailing-slash suffix comes off in one pass. A second
		// normalize must not change the string: the cache id is hashed from it.
		expect(resolveOpenzooBaseUrl("https://tunnel.example/v1//")).toBe("https://tunnel.example/v1");
		const doubled = resolveOpenzooBaseUrl("https://tunnel.example/v1//");
		expect(resolveOpenzooBaseUrl(doubled)).toBe(doubled);
		// The env fallback is normalized exactly like the explicit path: the
		// resolved string keys the model cache, so a stray slash must not fork it.
		Bun.env.OPENZOO_BASE_URL = "https://tunnel.example/v1/";
		expect(resolveOpenzooBaseUrl()).toBe("https://tunnel.example/v1");
		Bun.env.OPENZOO_BASE_URL = "https://tunnel.example/v1//";
		expect(resolveOpenzooBaseUrl()).toBe("https://tunnel.example/v1");
		expect(resolveOpenzooBaseUrl(resolveOpenzooBaseUrl())).toBe("https://tunnel.example/v1");
	});

	test("namespaces the model cache per endpoint", () => {
		delete Bun.env.OPENZOO_BASE_URL;
		const local = resolveModelCacheProviderId("openzoo");
		const moved = resolveModelCacheProviderId("openzoo", { baseUrl: "http://localhost:9402/v1" });
		expect(local).toStartWith("openzoo:models-v1:");
		expect(moved).toStartWith("openzoo:models-v1:");
		expect(moved).not.toBe(local);
		expect(openzooModelManagerOptions().cacheProviderId).toBe(local);
		expect(openzooModelManagerOptions({ baseUrl: "http://localhost:9402/v1" }).cacheProviderId).toBe(moved);
		// One endpoint, one id: a configured trailing slash goes through the same
		// resolver the manager uses, so it cannot mint a second cache namespace.
		expect(resolveModelCacheProviderId("openzoo", { baseUrl: "https://tunnel.example/v1/" })).toBe(
			resolveModelCacheProviderId("openzoo", { baseUrl: "https://tunnel.example/v1" }),
		);
		// Normalizing twice must keep the same namespace. The manager hashes
		// the already-normalized URL, and a leftover slash used to miss the row.
		const doubled = "https://tunnel.example/v1//";
		const normalized = resolveOpenzooBaseUrl(doubled);
		expect(resolveModelCacheProviderId("openzoo", { baseUrl: doubled })).toBe(
			resolveModelCacheProviderId("openzoo", { baseUrl: normalized }),
		);
		expect(resolveModelCacheProviderId("openzoo", { baseUrl: normalized })).toBe(
			resolveModelCacheProviderId("openzoo", { baseUrl: "https://tunnel.example/v1" }),
		);
	});

	test("discovers the live catalog keylessly, pricing from the proxy and limits from the real window", async () => {
		// The default is passed in. Deleting OPENZOO_BASE_URL across this await
		// is process-global and can change what openzoo-session-restore reads.
		const seen = { urls: [] as string[], authorization: [] as (string | null)[] };
		const options = openzooModelManagerOptions({
			baseUrl: OPENZOO_DEFAULT_BASE_URL,
			fetch: stubFetch(seen),
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(seen.urls).toEqual(["http://localhost:8402/v1/models"]);
		expect(seen.authorization).toEqual([null]);

		// Router aliases collapse to one `auto` entry; harness-compat twins are dropped.
		expect((models ?? []).map(model => model.id)).toEqual([
			"anthropic/claude-sonnet-4",
			"auto",
			"example-lab/not-in-any-catalog",
			"example-lab/reports-capabilities",
		]);

		const sonnet = models?.find(model => model.id === "anthropic/claude-sonnet-4");
		expect(sonnet?.provider).toBe("openzoo");
		expect(sonnet?.api).toBe("openai-completions");
		expect(sonnet?.baseUrl).toBe("http://localhost:8402/v1");
		// USD per token → USD per million tokens.
		expect(sonnet?.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
		// `max_model_len` is the attention window; `context_length` is the 128M bind ceiling.
		expect(sonnet?.contextWindow).toBe(1_000_000);
		expect(sonnet?.maxTokens).toBe(64_000);
		// Display name may still come from a bundled reference. Reasoning and
		// image-input do not: a matching id from another provider is not a
		// capability signal (github-copilot / opencode-zen Claude Sonnet 4
		// both reason and accept images).
		const canonical = resolveModelReference("anthropic/claude-sonnet-4", getBundledModelReferenceIndex());
		expect(canonical).toBeDefined();
		expect(sonnet?.name).toBe(canonical?.name ?? "");
		expect(canonical?.reasoning).toBe(true);
		expect(canonical?.input).toContain("image");
		expect(sonnet?.reasoning).toBe(false);
		expect(sonnet?.input).toEqual(["text"]);
		// Image input is rule-owned (`providers/openzoo.kdl` input-modalities)
		// and corrected at build time.
		expect(sonnet && buildModel(sonnet).input).toEqual(["text", "image"]);
		expect(sonnet && buildModel(sonnet).reasoning).toBe(false);

		// Unknown ids keep the proxy's numbers (string prices parse too) and conservative capabilities.
		expect(resolveModelReference("example-lab/not-in-any-catalog", getBundledModelReferenceIndex())).toBeUndefined();
		const unknown = models?.find(model => model.id === "example-lab/not-in-any-catalog");
		expect(unknown?.cost.input).toBeCloseTo(0.834, 6);
		expect(unknown?.cost.output).toBeCloseTo(2.501, 6);
		expect(unknown?.contextWindow).toBe(1_048_576);
		expect(unknown?.maxTokens).toBe(64_000);
		expect(unknown?.name).toBe("not-in-any-catalog (example-lab)");
		expect(unknown?.reasoning).toBe(false);
		expect(unknown?.input).toEqual(["text"]);
		expect(unknown && buildModel(unknown).input).toEqual(["text"]);

		// Advertised live fields are authoritative even for an id with no
		// bundled reference — that is the only path that may light up
		// reasoning or image input on the discovery spec.
		const reported = models?.find(model => model.id === "example-lab/reports-capabilities");
		expect(
			resolveModelReference("example-lab/reports-capabilities", getBundledModelReferenceIndex()),
		).toBeUndefined();
		expect(reported?.reasoning).toBe(true);
		expect(reported?.input).toEqual(["text", "image"]);

		// The fold is field-by-field: the first alias row priced only the prompt
		// side and left maxTokens null; later alias rows filled in the rest.
		const auto = models?.find(model => model.id === "auto");
		expect(auto?.name).toBe("Auto");
		expect(auto?.cost.input).toBeCloseTo(0.1, 9);
		expect(auto?.cost.output).toBeCloseTo(0.2, 9);
		expect(auto?.cost.cacheRead).toBe(0);
		expect(auto?.cost.cacheWrite).toBe(0);
		expect(auto?.contextWindow).toBe(32_768);
		expect(auto?.maxTokens).toBe(8_192);
		// The alias spellings themselves never surface as separate rows.
		expect(models?.some(model => ["openzoo/auto", "openzoo-auto"].includes(model.id))).toBe(false);
		// The router rows in this fixture advertise neither reasoning nor image
		// input, so the folded auto model keeps the discovery defaults.
		expect(auto?.reasoning).toBe(false);
		expect(auto?.input).toEqual(["text"]);
	});

	test("sends the bearer and honours a configured base URL", async () => {
		const seen = { urls: [] as string[], authorization: [] as (string | null)[] };
		const options = openzooModelManagerOptions({
			apiKey: "oz_tunnel-bearer",
			baseUrl: "https://tunnel.example/v1",
			fetch: stubFetch(seen),
		});
		const models = await options.fetchDynamicModels?.();
		expect(seen.urls).toEqual(["https://tunnel.example/v1/models"]);
		expect(seen.authorization).toEqual(["Bearer oz_tunnel-bearer"]);
		expect(models?.every(model => model.baseUrl === "https://tunnel.example/v1")).toBe(true);
	});

	test("a parameter list that omits tools marks the model not tool-capable; a missing list stays tool-capable", async () => {
		// `supportsTools: undefined` is permission to send native tools, and a
		// discovery merge keeps a cached `false` when the new row leaves the
		// field unset. A roster that published `supported_parameters` and left
		// `tools` out must come back `false`. A list that includes `tools`
		// must come back `true`, so that refresh can clear the cached no. A
		// row with no list stays unset. Other advertised capabilities still
		// apply on the no-tools row.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "example-lab/no-tools",
							owned_by: "openrouter",
							supported_parameters: ["reasoning"],
							max_model_len: 8_192,
						},
						{
							id: "example-lab/with-tools",
							owned_by: "openrouter",
							supported_parameters: ["tools", "reasoning"],
						},
						{ id: "example-lab/silent", owned_by: "openrouter" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const noTools = models?.find(model => model.id === "example-lab/no-tools");
		const withTools = models?.find(model => model.id === "example-lab/with-tools");
		const silent = models?.find(model => model.id === "example-lab/silent");

		expect(noTools?.supportsTools).toBe(false);
		expect(noTools?.reasoning).toBe(true);
		expect(noTools && buildModel(noTools).supportsTools).toBe(false);
		expect(withTools?.reasoning).toBe(true);
		expect(withTools?.supportsTools).toBe(true);
		expect(withTools && buildModel(withTools).supportsTools).toBe(true);
		expect(silent?.supportsTools).toBeUndefined();
		expect(silent && buildModel(silent).supportsTools).toBeUndefined();
	});

	test("a folded router alias keeps reasoning and image input advertised on any alias row", async () => {
		// The family return used to keep reasoning:false and input:["text"]
		// even when an alias row reported them, and the fold kept the first
		// row's defaults, so openzoo/auto hid capabilities the proxy advertised.
		// Each alias contributes one field; a following alias that omits both
		// must not clear them.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "auto",
							owned_by: "openzoo",
							pricing: { prompt: 1e-7, completion: 2e-7 },
							supported_parameters: ["reasoning"],
						},
						{
							id: "openzoo/auto",
							owned_by: "openzoo",
							architecture: { input_modalities: ["text", "image"] },
						},
						{ id: "openzoo-auto", owned_by: "openzoo" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["auto"]);
		const auto = models?.[0];
		expect(auto?.reasoning).toBe(true);
		expect(auto?.input).toEqual(["text", "image"]);
		expect(auto && buildModel(auto).reasoning).toBe(true);
		expect(auto && buildModel(auto).input).toEqual(["text", "image"]);
	});

	test("a folded router alias whose parameter list omits tools is not tool-capable", async () => {
		// Alias spellings fold into one `auto`. The no-tools advertisement can
		// arrive on a later alias, and a following alias with no parameter list
		// must not clear it — otherwise the default router still receives native
		// tool definitions.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
						{ id: "openzoo/auto", owned_by: "openzoo", supported_parameters: ["temperature"] },
						{ id: "openzoo-auto", owned_by: "openzoo" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["auto"]);
		expect(models?.[0]?.supportsTools).toBe(false);
		expect(models?.[0] && buildModel(models[0]).supportsTools).toBe(false);
	});

	test("a later router alias that lists tools keeps the folded model tool-capable", async () => {
		// Alias spellings fold into one `auto`. The tools advertisement can
		// arrive after a row with no parameter list; dropping it would leave
		// supportsTools unset, and a cached `false` would survive the refresh.
		// An earlier alias that omitted tools still wins inside this roster.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo", pricing: { prompt: 1e-7, completion: 2e-7 } },
						{ id: "openzoo/auto", owned_by: "openzoo", supported_parameters: ["tools"] },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["auto"]);
		expect(models?.[0]?.supportsTools).toBe(true);
		expect(models?.[0] && buildModel(models[0]).supportsTools).toBe(true);

		const omittedFirst = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo", supported_parameters: ["temperature"] },
						{ id: "openzoo/auto", owned_by: "openzoo", supported_parameters: ["tools"] },
					],
				}),
		});
		const omitted = await omittedFirst.fetchDynamicModels?.();
		expect(omitted?.map(model => model.id)).toEqual(["auto"]);
		expect(omitted?.[0]?.supportsTools).toBe(false);
	});

	test("leaves omitted limits unknown even when another provider publishes the same model", async () => {
		const options = openzooModelManagerOptions({
			fetch: async () => Response.json({ data: [{ id: "anthropic/claude-sonnet-4" }] }),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(1);
		expect(models?.[0]?.contextWindow).toBeNull();
		expect(models?.[0]?.maxTokens).toBeNull();
	});

	test("an unreachable proxy yields no models rather than an error", async () => {
		const failingFetch: FetchImpl = async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:8402");
		};
		const options = openzooModelManagerOptions({ fetch: failingFetch });
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});

	test("a parameter list that omits sampling controls disables them; a missing list stays neutral", async () => {
		// The completions transport sends temperature/top_p whenever
		// supportsSamplingParams is on, and penalties plus stop whenever
		// supportsPenaltyAndStopParams is on. A present list that omits any
		// control in a group must turn that flag off or the request 400s. A
		// row with no list keeps the default (both on). Advertising the whole
		// group turns the flag on so a cached no does not survive the refresh.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "example-lab/no-sampling",
							supported_parameters: ["presence_penalty", "frequency_penalty", "repetition_penalty", "stop"],
						},
						{
							id: "example-lab/no-penalties",
							supported_parameters: ["temperature", "top_p", "tools"],
						},
						{
							id: "example-lab/samples",
							supported_parameters: [
								"temperature",
								"top_p",
								"presence_penalty",
								"frequency_penalty",
								"repetition_penalty",
								"stop",
							],
						},
						{ id: "example-lab/silent" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const noSampling = models?.find(model => model.id === "example-lab/no-sampling");
		const noPenalties = models?.find(model => model.id === "example-lab/no-penalties");
		const samples = models?.find(model => model.id === "example-lab/samples");
		const silent = models?.find(model => model.id === "example-lab/silent");

		expect(noSampling && buildModel(noSampling).compat.supportsSamplingParams).toBe(false);
		expect(noSampling && buildModel(noSampling).compat.supportsPenaltyAndStopParams).toBe(true);
		expect(noPenalties && buildModel(noPenalties).compat.supportsSamplingParams).toBe(true);
		expect(noPenalties && buildModel(noPenalties).compat.supportsPenaltyAndStopParams).toBe(false);
		expect(samples && buildModel(samples).compat.supportsSamplingParams).toBe(true);
		expect(samples && buildModel(samples).compat.supportsPenaltyAndStopParams).toBe(true);
		expect(silent?.compat?.supportsSamplingParams).toBeUndefined();
		expect(silent?.compat?.supportsPenaltyAndStopParams).toBeUndefined();
		expect(silent && buildModel(silent).compat.supportsSamplingParams).toBe(true);
		expect(silent && buildModel(silent).compat.supportsPenaltyAndStopParams).toBe(true);
	});

	test("a folded router alias that omits sampling controls keeps them off", async () => {
		// Alias spellings fold into one auto. An omit on any alias sticks,
		// including over a later alias that lists the controls. An alias with
		// no parameter list does not clear an advertisement and does not
		// invent an omit.
		const omitted = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo", supported_parameters: ["temperature", "tools"] },
						{
							id: "openzoo/auto",
							owned_by: "openzoo",
							supported_parameters: [
								"temperature",
								"top_p",
								"presence_penalty",
								"frequency_penalty",
								"repetition_penalty",
								"stop",
							],
						},
					],
				}),
		});
		const omittedModels = await omitted.fetchDynamicModels?.();
		expect(omittedModels?.map(model => model.id)).toEqual(["auto"]);
		expect(omittedModels?.[0] && buildModel(omittedModels[0]).compat.supportsSamplingParams).toBe(false);
		expect(omittedModels?.[0] && buildModel(omittedModels[0]).compat.supportsPenaltyAndStopParams).toBe(false);

		const advertised = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo" },
						{
							id: "openzoo/auto",
							owned_by: "openzoo",
							supported_parameters: [
								"temperature",
								"top_p",
								"presence_penalty",
								"frequency_penalty",
								"repetition_penalty",
								"stop",
							],
						},
					],
				}),
		});
		const advertisedModels = await advertised.fetchDynamicModels?.();
		expect(advertisedModels?.[0] && buildModel(advertisedModels[0]).compat.supportsSamplingParams).toBe(true);
		expect(advertisedModels?.[0] && buildModel(advertisedModels[0]).compat.supportsPenaltyAndStopParams).toBe(true);
	});

	test("a parameter list gates top_k and min_p on their own", async () => {
		// supportsSamplingParams stays on for temperature and top_p. Each
		// extension is its own flag: listing top_k must not send min_p, and a
		// row with no list keeps both at the default (on) so temperature-only
		// hosts are unchanged.
		const options = openzooModelManagerOptions({
			baseUrl: OPENZOO_DEFAULT_BASE_URL,
			fetch: async () =>
				Response.json({
					data: [
						{ id: "example-lab/core-only", supported_parameters: ["temperature", "top_p"] },
						{ id: "example-lab/top-k-only", supported_parameters: ["temperature", "top_p", "top_k"] },
						{ id: "example-lab/min-p-only", supported_parameters: ["temperature", "top_p", "min_p"] },
						{
							id: "example-lab/both-extensions",
							supported_parameters: ["temperature", "top_p", "top_k", "min_p"],
						},
						{ id: "example-lab/silent" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const built = (id: string) => {
			const model = models?.find(item => item.id === id);
			return model ? buildModel(model) : undefined;
		};

		expect(built("example-lab/core-only")?.compat.supportsSamplingParams).toBe(true);
		expect(built("example-lab/core-only")?.compat.supportsTopK).toBe(false);
		expect(built("example-lab/core-only")?.compat.supportsMinP).toBe(false);

		expect(built("example-lab/top-k-only")?.compat.supportsSamplingParams).toBe(true);
		expect(built("example-lab/top-k-only")?.compat.supportsTopK).toBe(true);
		expect(built("example-lab/top-k-only")?.compat.supportsMinP).toBe(false);

		expect(built("example-lab/min-p-only")?.compat.supportsTopK).toBe(false);
		expect(built("example-lab/min-p-only")?.compat.supportsMinP).toBe(true);

		expect(built("example-lab/both-extensions")?.compat.supportsTopK).toBe(true);
		expect(built("example-lab/both-extensions")?.compat.supportsMinP).toBe(true);

		const silent = models?.find(model => model.id === "example-lab/silent");
		expect(silent?.compat?.supportsTopK).toBeUndefined();
		expect(silent?.compat?.supportsMinP).toBeUndefined();
		expect(built("example-lab/silent")?.compat.supportsTopK).toBe(true);
		expect(built("example-lab/silent")?.compat.supportsMinP).toBe(true);
	});

	test("an advertised top_k, min_p, or penalty set stays on when temperature or top_p is omitted", async () => {
		// supportsSamplingParams is false because the core pair is incomplete.
		// The control that was listed must stay true, or the request drops it
		// under that flag and the route never sees the parameter it advertised.
		const options = openzooModelManagerOptions({
			baseUrl: OPENZOO_DEFAULT_BASE_URL,
			fetch: async () =>
				Response.json({
					data: [
						{ id: "example-lab/top-k-without-temperature", supported_parameters: ["top_p", "top_k"] },
						{ id: "example-lab/min-p-without-top-p", supported_parameters: ["temperature", "min_p"] },
						{
							id: "example-lab/penalties-only",
							supported_parameters: ["presence_penalty", "frequency_penalty", "repetition_penalty", "stop"],
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const built = (id: string) => {
			const model = models?.find(item => item.id === id);
			return model ? buildModel(model) : undefined;
		};
		const topK = built("example-lab/top-k-without-temperature");
		const minP = built("example-lab/min-p-without-top-p");
		const penalties = built("example-lab/penalties-only");

		expect(topK?.compat.supportsSamplingParams).toBe(false);
		expect(topK?.compat.supportsTopK).toBe(true);
		expect(topK?.compat.supportsMinP).toBe(false);
		expect(topK?.compatConfig?.supportsTopK).toBe(true);

		expect(minP?.compat.supportsSamplingParams).toBe(false);
		expect(minP?.compat.supportsMinP).toBe(true);
		expect(minP?.compat.supportsTopK).toBe(false);
		expect(minP?.compatConfig?.supportsMinP).toBe(true);

		expect(penalties?.compat.supportsSamplingParams).toBe(false);
		expect(penalties?.compat.supportsPenaltyAndStopParams).toBe(true);
		expect(penalties?.compatConfig?.supportsPenaltyAndStopParams).toBe(true);
	});

	test("a folded router alias keeps an omitted top_k or min_p off", async () => {
		// An omit on any alias sticks, including over a later alias that lists
		// the extension. An alias with no list does not invent an omit, and
		// listing only top_k does not turn min_p on.
		const omitted = openzooModelManagerOptions({
			baseUrl: OPENZOO_DEFAULT_BASE_URL,
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo", supported_parameters: ["temperature", "top_p"] },
						{
							id: "openzoo/auto",
							owned_by: "openzoo",
							supported_parameters: ["temperature", "top_p", "top_k", "min_p"],
						},
					],
				}),
		});
		const omittedModels = await omitted.fetchDynamicModels?.();
		expect(omittedModels?.map(model => model.id)).toEqual(["auto"]);
		const omittedAuto = omittedModels?.[0] ? buildModel(omittedModels[0]) : undefined;
		expect(omittedAuto?.compat.supportsSamplingParams).toBe(true);
		expect(omittedAuto?.compat.supportsTopK).toBe(false);
		expect(omittedAuto?.compat.supportsMinP).toBe(false);

		const partial = openzooModelManagerOptions({
			baseUrl: OPENZOO_DEFAULT_BASE_URL,
			fetch: async () =>
				Response.json({
					data: [
						{ id: "auto", owned_by: "openzoo" },
						{
							id: "openzoo/auto",
							owned_by: "openzoo",
							supported_parameters: ["temperature", "top_p", "top_k"],
						},
					],
				}),
		});
		const partialModels = await partial.fetchDynamicModels?.();
		const partialAuto = partialModels?.[0] ? buildModel(partialModels[0]) : undefined;
		expect(partialAuto?.compat.supportsSamplingParams).toBe(true);
		expect(partialAuto?.compat.supportsTopK).toBe(true);
		expect(partialAuto?.compat.supportsMinP).toBe(false);
	});

	test("an explicit false vision flag stays text-only when nothing else advertises image input", async () => {
		// supports_vision / supports_image / supports_image_in: false used to
		// look omitted, so inputModalitiesReported stayed unset and the OpenZoo
		// image correction put image back on Claude, Gemini, and vision-token
		// rows. A sibling that omits the flags still receives that correction.
		// A positive modality list still wins over the false flag.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "anthropic/claude-sonnet-4", supports_vision: false },
						{ id: "google/gemini-2.5-pro", supports_image: false },
						{ id: "example-lab/qwen2-vl", supports_image_in: false },
						{ id: "anthropic/claude-opus-4" },
						{ id: "google/gemini-2.5-flash" },
						{ id: "example-lab/minicpm-vl" },
						{
							id: "anthropic/claude-haiku-4",
							supports_vision: false,
							architecture: { input_modalities: ["text", "image"] },
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const builtInput = (id: string) => {
			const model = models?.find(item => item.id === id);
			return model ? buildModel(model).input : undefined;
		};

		expect(builtInput("anthropic/claude-sonnet-4")).toEqual(["text"]);
		expect(builtInput("google/gemini-2.5-pro")).toEqual(["text"]);
		expect(builtInput("example-lab/qwen2-vl")).toEqual(["text"]);
		expect(builtInput("anthropic/claude-opus-4")).toEqual(["text", "image"]);
		expect(builtInput("google/gemini-2.5-flash")).toEqual(["text", "image"]);
		expect(builtInput("example-lab/minicpm-vl")).toEqual(["text", "image"]);
		expect(builtInput("anthropic/claude-haiku-4")).toEqual(["text", "image"]);
	});

	test("an explicit false reasoning report is not turned on by a thinking suffix", async () => {
		// foo-thinking classifies as a thinking variant. That name is the
		// fallback only when the row omits reasoning metadata. supports_reasoning
		// or reasoning set to false stays off through buildModel, including
		// when the picker materializes thinking controls. A parameter list that
		// advertises reasoning still wins over the false flag.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "example-lab/foo-thinking", supports_reasoning: false },
						{ id: "example-lab/bar-thinking", reasoning: false },
						{ id: "example-lab/baz-thinking" },
						{
							id: "example-lab/qux-thinking",
							supports_reasoning: false,
							supported_parameters: ["reasoning"],
						},
						{ id: "example-lab/plain" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const builtReasoning = (id: string) => {
			const model = models?.find(item => item.id === id);
			return model ? buildModel(model).reasoning : undefined;
		};

		expect(builtReasoning("example-lab/foo-thinking")).toBe(false);
		expect(builtReasoning("example-lab/bar-thinking")).toBe(false);
		expect(builtReasoning("example-lab/baz-thinking")).toBe(true);
		expect(builtReasoning("example-lab/qux-thinking")).toBe(true);
		expect(builtReasoning("example-lab/plain")).toBe(false);
	});

	test("architecture.modality image output is not image input", async () => {
		// OpenRouter spells modality as input->output. `text->image` is an
		// image generator: a substring check used to mark that row image-capable,
		// and inputModalitiesReported then kept the image through the Claude
		// correction. Legacy `text+image` (no arrow) and `text+image->text`
		// still accept image input. The picture ids are outside the image
		// correction, so a pass there is the parser, not the KDL fill.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "anthropic/claude-sonnet-4",
							architecture: { modality: "text->image" },
						},
						{
							id: "example-lab/legacy-picture",
							architecture: { modality: "text+image" },
						},
						{
							id: "example-lab/arrow-picture",
							architecture: { modality: "text+image->text" },
						},
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const builtInput = (id: string) => {
			const model = models?.find(item => item.id === id);
			return model ? buildModel(model).input : undefined;
		};

		expect(builtInput("anthropic/claude-sonnet-4")).toEqual(["text"]);
		expect(builtInput("example-lab/legacy-picture")).toEqual(["text", "image"]);
		expect(builtInput("example-lab/arrow-picture")).toEqual(["text", "image"]);
	});

	test("an explicit text-only modality report survives the image correction", async () => {
		// providers/openzoo.kdl marks Claude and Gemini image-capable because
		// the roster often omits architecture. A row that does report
		// input_modalities: ["text"] must stay text-only after buildModel;
		// a sibling that omits the field still receives the correction.
		const options = openzooModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "anthropic/claude-sonnet-4",
							architecture: { input_modalities: ["text"] },
						},
						{
							id: "google/gemini-2.5-pro",
							architecture: { input_modalities: ["text"] },
						},
						{ id: "anthropic/claude-opus-4" },
					],
				}),
		});
		const models = await options.fetchDynamicModels?.();
		const sonnet = models?.find(model => model.id === "anthropic/claude-sonnet-4");
		const gemini = models?.find(model => model.id === "google/gemini-2.5-pro");
		const opus = models?.find(model => model.id === "anthropic/claude-opus-4");
		expect(sonnet?.input).toEqual(["text"]);
		expect(sonnet && buildModel(sonnet).input).toEqual(["text"]);
		expect(gemini?.input).toEqual(["text"]);
		expect(gemini && buildModel(gemini).input).toEqual(["text"]);
		expect(opus?.input).toEqual(["text"]);
		expect(opus && buildModel(opus).input).toEqual(["text", "image"]);
	});

	test("a public tunnel 401/403 is an auth rejection; a local 401 stays empty", async () => {
		// fetchOpenAICompatibleModels turns every non-OK /models response into
		// null. On a public tunnel that null never reached the registry's
		// authentication handling, so a bad bearer looked like a dead proxy.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openzoo-auth-"));
		try {
			const tunnel = openzooModelManagerOptions({
				baseUrl: "https://tunnel.example/v1",
				fetch: async () => new Response("unauthorized", { status: 401 }),
			});
			const rejected = await tunnel.fetchDynamicModels?.().then(
				() => null,
				(error: unknown) => error,
			);
			expect(rejected).toBeInstanceOf(DiscoveryAuthRejectionError);
			expect(rejected).toMatchObject({
				status: 401,
				message: "HTTP 401 from https://tunnel.example/v1/models",
			});

			const forbidden = openzooModelManagerOptions({
				baseUrl: "https://tunnel.example/v1/",
				fetch: async () => new Response("forbidden", { status: 403 }),
			});
			await expect(forbidden.fetchDynamicModels?.()).rejects.toMatchObject({ status: 403 });

			const manager = createModelManager({
				...openzooModelManagerOptions({
					baseUrl: "https://tunnel.example/v1",
					fetch: async () => new Response("unauthorized", { status: 401 }),
				}),
				staticModels: [],
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			await expect(manager.refresh("online")).rejects.toBeInstanceOf(DiscoveryAuthRejectionError);

			const local = openzooModelManagerOptions({
				baseUrl: "http://127.0.0.1:8402/v1",
				fetch: async () => new Response("unauthorized", { status: 401 }),
			});
			expect(await local.fetchDynamicModels?.()).toBeNull();

			const outage = openzooModelManagerOptions({
				baseUrl: "https://tunnel.example/v1",
				fetch: async () => new Response("unavailable", { status: 500 }),
			});
			expect(await outage.fetchDynamicModels?.()).toBeNull();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
