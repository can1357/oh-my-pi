import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { kiroManagementRequest, sanitizeKiroModelCatalog } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
	parseKiroDiscoveryCredential,
	resolveKiroModelCacheProviderId,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-default";
const API_ENDPOINT = "https://management.us-east-1.kiro.dev/";

function catalogResponse(
	modelIds: readonly string[],
	options: { inputTypes?: unknown; defaultModel?: unknown; omitInputTypes?: boolean } = {},
): Record<string, unknown> {
	const inputTypes = "inputTypes" in options ? options.inputTypes : ["TEXT"];
	const defaultModel = "defaultModel" in options ? options.defaultModel : modelIds[0];
	return {
		defaultModel,
		models: modelIds.map(modelId => ({
			modelId,
			modelName: modelId,
			...(options.omitInputTypes ? {} : { supportedInputTypes: inputTypes }),
			tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
		})),
	};
}

function jsonFetch(payload: unknown, status = 200): FetchImpl {
	return async () =>
		new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function gptReasoningSchema(legacyMode = false): Record<string, unknown> {
	const effort = {
		type: "string",
		enum: ["none", "low", "medium", "high", "xhigh", "max"],
		default: "high",
	};
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			reasoning: {
				type: "object",
				properties: legacyMode
					? {
							mode: { type: "string", enum: ["standard", "pro"], default: "standard" },
							effort,
						}
					: { effort },
			},
		},
	};
}

function anthropicThinkingSchema(thinkingTypes: readonly string[]): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			thinking: {
				type: "object",
				properties: {
					type: { type: "string", enum: [...thinkingTypes] },
					display: { type: "string", enum: ["summarized", "omitted"] },
				},
				required: ["type"],
			},
			output_config: {
				type: "object",
				properties: {
					effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
				},
			},
			max_tokens: { type: "integer", minimum: 1024, maximum: 128_000 },
		},
	};
}

function fallbackSpec(): ModelSpec<"kiro-api"> {
	return {
		id: "bundled-fallback",
		name: "Bundled fallback",
		api: "kiro-api",
		provider: "kiro",
		baseUrl: API_ENDPOINT,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 50_000,
		maxTokens: 4_096,
	};
}

/** Captured live `claude-sonnet-5.5` thinking shape: closed `thinking` object and a `between_tools` mode. */
function sonnet55Schema(): Record<string, unknown> {
	const schema = anthropicThinkingSchema(["adaptive", "between_tools"]);
	const properties = schema.properties as Record<string, Record<string, unknown>>;
	properties.thinking!.additionalProperties = false;
	(properties.output_config!.properties as Record<string, Record<string, unknown>>).effort!.default = "high";
	return schema;
}

function payloadWithSchemas(entries: Array<[string, Record<string, unknown>]>): Record<string, unknown> {
	const payload = catalogResponse(entries.map(([id]) => id));
	(payload.models as Array<Record<string, unknown>>).forEach((model, index) => {
		model.additionalModelRequestFieldsSchema = entries[index]![1];
	});
	return payload;
}

function discover(payload: unknown) {
	return kiroModelManagerOptions({
		apiKey: JSON.stringify({ token: "test-token", apiEndpoint: API_ENDPOINT }),
		fetch: jsonFetch(payload),
	}).fetchDynamicModels?.();
}

describe("Kiro provider discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is authoritative with a fallback default and Kiro discovery wiring", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "kiro");

		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("auto");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["kiro"]).toBe("auto");
		expect(descriptor?.catalogDiscovery).toEqual({ label: "Kiro", envVars: ["KIRO_API_KEY"], oauthProvider: "kiro" });
	});

	test("opts out of cross-provider same-id reference fills for authoritative discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "kiro");

		// The same-id overlay would overwrite Kiro's deployment-specific tokenizer
		// and context values with another host's rows (Kiro serves claude/gpt ids
		// that collide with upstream seed rows).
		expect(descriptor?.skipCrossProviderReferenceFills).toBe(true);
	});

	test("ignores missing, malformed, unknown, and known defaultModel metadata", () => {
		const modelIds = ["kiro-model-one", "kiro-model-two"];
		const withoutDefault = catalogResponse(modelIds);
		delete withoutDefault.defaultModel;
		const payloads: Record<string, unknown>[] = [
			withoutDefault,
			catalogResponse(modelIds),
			{ ...catalogResponse(modelIds), defaultModel: "not-an-advertised-model" },
			{ ...catalogResponse(modelIds), defaultModel: 42 },
			{ ...catalogResponse(modelIds), defaultModel: { modelId: "auto" } },
		];

		for (const payload of payloads) {
			const catalog = sanitizeKiroModelCatalog(payload);
			expect(catalog.models.map(model => model.modelId)).toEqual(modelIds);
			expect("defaultModel" in catalog).toBe(false);
		}
	});

	test("preserves every exact live model ID and authoritative order", async () => {
		const modelIds = ["auto", "provider/model-z", "provider/model-a", "provider/model-zeta"];
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "catalog-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(catalogResponse(modelIds, { defaultModel: { modelId: "auto" } })),
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(modelIds);
	});

	test("maps TEXT and IMAGE supportedInputTypes in order without output metadata", async () => {
		const textOptions = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "text-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(catalogResponse(["text-model"], { inputTypes: ["TEXT"] })),
		});
		const multimodalOptions = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "image-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(catalogResponse(["image-model"], { inputTypes: ["TEXT", "IMAGE"] })),
		});

		expect((await textOptions.fetchDynamicModels?.())?.[0]?.input).toEqual(["text"]);
		expect((await multimodalOptions.fetchDynamicModels?.())?.[0]?.input).toEqual(["text", "image"]);
	});

	test("rejects missing, null, non-array, empty, unknown, non-string, and duplicate input types", () => {
		const invalidInputTypes: unknown[] = [undefined, null, "TEXT", [], ["VIDEO"], [1], ["TEXT", "TEXT"]];
		for (const inputTypes of invalidInputTypes) {
			expect(() => sanitizeKiroModelCatalog(catalogResponse(["invalid-model"], { inputTypes }))).toThrow(
				"Unsafe ListAvailableModels response",
			);
		}
		expect(() => sanitizeKiroModelCatalog(catalogResponse(["missing-model"], { omitInputTypes: true }))).toThrow(
			"Unsafe ListAvailableModels response",
		);
	});

	test("rejects duplicate model IDs and malformed recognized schemas", () => {
		expect(() => sanitizeKiroModelCatalog(catalogResponse(["duplicate-model", "duplicate-model"]))).toThrow(
			"models.duplicate-id",
		);

		const malformedLimits = catalogResponse(["malformed-model"]);
		const malformedModel = (malformedLimits.models as Array<Record<string, unknown>>)[0]!;
		malformedModel.tokenLimits = { maxInputTokens: 0, maxOutputTokens: 8_192 };
		expect(() => sanitizeKiroModelCatalog(malformedLimits)).toThrow("model.max-input");

		const malformedSchema = catalogResponse(["malformed-schema-model"]);
		const schemaModel = (malformedSchema.models as Array<Record<string, unknown>>)[0]!;
		schemaModel.additionalModelRequestFieldsSchema = null;
		expect(() => sanitizeKiroModelCatalog(malformedSchema)).toThrow("schema.object");
	});

	test("preserves prompt caching, request schema, token limits, and rate metadata", () => {
		const payload = catalogResponse(["metadata-model"], { inputTypes: ["TEXT"] });
		const model = (payload.models as Array<Record<string, unknown>>)[0]!;
		model.description = "Synthetic metadata";
		model.promptCaching = {
			supportsPromptCaching: true,
			maximumCacheCheckpointsPerRequest: 2,
			minimumTokensPerCacheCheckpoint: 1_024,
		};
		model.additionalModelRequestFieldsSchema = {
			type: "object",
			properties: { reasoning: { type: "string" } },
		};
		model.rateMultiplier = 1.5;
		model.rateUnit = "Credit";

		const sanitized = sanitizeKiroModelCatalog(payload).models[0]!;
		expect(sanitized).toMatchObject({
			supportedInputTypes: ["TEXT"],
			description: "Synthetic metadata",
			tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
			promptCaching: {
				supportsPromptCaching: true,
				maximumCacheCheckpointsPerRequest: 2,
				minimumTokensPerCacheCheckpoint: 1_024,
			},
			rateMultiplier: 1.5,
			rateUnit: "Credit",
		});
		expect(sanitized.additionalModelRequestFieldsSchema?.properties?.reasoning?.type).toBe("string");
	});

	test("maps the live effort-only GPT reasoning schema for the full model catalog", async () => {
		const modelIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
		const payload = catalogResponse(modelIds);
		for (const model of payload.models as Array<Record<string, unknown>>) {
			model.additionalModelRequestFieldsSchema = gptReasoningSchema();
		}
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "gpt-catalog-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(payload),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(modelIds);
		expect(models?.map(model => model.thinking?.efforts)).toEqual(
			modelIds.map(() => [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]),
		);
		expect(models?.map(model => model.thinking?.defaultLevel)).toEqual(modelIds.map(() => Effort.High));
		expect(models?.every(model => model.thinking?.mode === "effort")).toBe(true);
		expect(models?.every(model => model.thinking?.effortMap?.[Effort.Minimal] === "none")).toBe(true);
	});

	test("accepts an Anthropic thinking enum that advertises adaptive without disabled", async () => {
		// Kiro advertises `["adaptive"]` alone on models whose thinking cannot be
		// turned off. Requiring both values dropped the whole catalog, which left
		// the provider absent from the model list rather than just one model.
		const payload = catalogResponse(["claude-opus-5.5"]);
		const model = (payload.models as Array<Record<string, unknown>>)[0]!;
		model.additionalModelRequestFieldsSchema = anthropicThinkingSchema(["adaptive"]);
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "adaptive-only-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(payload),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["claude-opus-5.5"]);
		expect(models?.[0]?.thinking).toMatchObject({ mode: "anthropic-adaptive", defaultLevel: Effort.Medium });
	});

	test("maps the live claude-sonnet-5.5 schema with thinking metadata", async () => {
		// Failure mode: the new closed-`thinking` / `between_tools` shape threw and the whole Kiro roster vanished.
		const models = await discover(payloadWithSchemas([["claude-sonnet-5.5", sonnet55Schema()]]));

		expect(models?.map(model => model.id)).toEqual(["claude-sonnet-5.5"]);
		expect(models?.[0]).toMatchObject({ reasoning: true, maxTokens: 128_000 });
		expect(models?.[0]?.thinking).toMatchObject({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultLevel: Effort.High,
		});
	});

	test("keeps the roster when one model has an unrecognised schema and warns about it", async () => {
		// Failure mode: a single unrecognised model dropped every Kiro model from /model.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const models = await discover(
			payloadWithSchemas([
				["claude-good-a", anthropicThinkingSchema(["adaptive", "disabled"])],
				["claude-garbage", anthropicThinkingSchema(["surprise"])],
				["claude-sonnet-5.5", sonnet55Schema()],
			]),
		);

		expect(models?.map(model => model.id)).toEqual(["claude-good-a", "claude-garbage", "claude-sonnet-5.5"]);
		expect(models?.[0]?.thinking?.mode).toBe("anthropic-adaptive");
		expect(models?.[1]?.reasoning).toBe(false);
		expect(models?.[1]?.thinking).toBeUndefined();
		expect(models?.[2]?.thinking?.mode).toBe("anthropic-adaptive");
		const degraded = warn.mock.calls.filter(
			([, context]) => (context as { modelId?: string })?.modelId === "claude-garbage",
		);
		expect(degraded).toHaveLength(1);
		expect(typeof (degraded[0]![1] as { reason: unknown }).reason).toBe("string");
	});

	test("does not accept thinking enums without adaptive or unknown thinking keywords as thinking metadata", async () => {
		const unknownKeyword = anthropicThinkingSchema(["adaptive"]);
		(unknownKeyword.properties as Record<string, Record<string, unknown>>).thinking!.additionalProperties = true;
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const models = await discover(
			payloadWithSchemas([
				["claude-no-adaptive", anthropicThinkingSchema(["disabled"])],
				["claude-open-thinking", unknownKeyword],
				["claude-ok", anthropicThinkingSchema(["adaptive"])],
			]),
		);

		expect(models?.map(model => [model.id, model.thinking?.mode])).toEqual([
			["claude-no-adaptive", undefined],
			["claude-open-thinking", undefined],
			["claude-ok", "anthropic-adaptive"],
		]);
	});

	test("returns null and logs an error when no model can be represented", async () => {
		// Failure mode: an unusable catalog replaced the cached roster with an empty one.
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const payload = catalogResponse(["claude-bad-rate"]);
		Object.assign((payload.models as Array<Record<string, unknown>>)[0]!, { rateMultiplier: 1, rateUnit: "Bogus" });

		expect(await discover(payload)).toBeNull();
		expect(error).toHaveBeenCalledTimes(1);
	});

	test("accepts legacy GPT mode+effort reasoning schemas", async () => {
		const payload = catalogResponse(["gpt-legacy"]);
		const model = (payload.models as Array<Record<string, unknown>>)[0]!;
		model.additionalModelRequestFieldsSchema = gptReasoningSchema(true);
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "legacy-gpt-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(payload),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.thinking).toMatchObject({ mode: "effort", defaultLevel: Effort.High });
	});

	test("rejects unknown GPT reasoning properties", async () => {
		const payload = catalogResponse(["gpt-invalid"]);
		const model = (payload.models as Array<Record<string, unknown>>)[0]!;
		const schema = gptReasoningSchema();
		const properties = schema.properties as Record<string, unknown>;
		const reasoning = properties.reasoning as Record<string, unknown>;
		(reasoning.properties as Record<string, unknown>).verbosity = { type: "string" };
		model.additionalModelRequestFieldsSchema = schema;
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "invalid-gpt-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(payload),
		});

		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(item => [item.id, item.reasoning, item.thinking])).toEqual([
			["gpt-invalid", false, undefined],
		]);
	});

	test("sends the selected OAuth profile ARN in the ListAvailableModels body", async () => {
		let requestBody: unknown;
		const fetch: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return Response.json(catalogResponse(["kiro-oauth-model"]));
		};
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "oauth-bearer", profileArn: PROFILE_ARN }),
			fetch,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["kiro-oauth-model"]);
		expect(requestBody).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE_ARN });
	});

	test("uses the legacy service for model discovery", async () => {
		let target = "";
		const fetch: FetchImpl = async (_input, init) => {
			target = new Headers(init?.headers).get("x-amz-target") ?? "";
			return Response.json({});
		};

		await kiroManagementRequest({
			apiRegion: "us-east-1",
			token: "discovery-token",
			target: "ListAvailableModels",
			body: { origin: "KIRO_CLI" },
			fetch,
		});

		expect(target).toBe("AmazonCodeWhispererService.ListAvailableModels");
	});

	test("uses a credential-scoped cache namespace without raw credential identity", () => {
		const token = "kiro-api-key-with-sensitive-value";
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token, apiEndpoint: API_ENDPOINT }),
		});
		const namespace = options.cacheProviderId ?? "";

		expect(namespace).toMatch(/^kiro:models-v1:/);
		expect(namespace).not.toContain(token);
		expect(namespace).not.toContain(PROFILE_ARN);
	});

	test("keeps cache identity profile-scoped and agrees with the lightweight resolver", () => {
		const oauthProfileA = JSON.stringify({ token: "rotated-access-a", profileArn: PROFILE_ARN });
		const oauthProfileARotated = JSON.stringify({ token: "new-access-a", profileArn: PROFILE_ARN });
		const oauthProfileB = JSON.stringify({
			token: "rotated-access-b",
			profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/other",
		});
		const apiKeyEndpointA = JSON.stringify({ token: "api-key-a", apiEndpoint: API_ENDPOINT });
		const apiKeyEndpointB = JSON.stringify({
			token: "api-key-a",
			apiEndpoint: "https://management.eu-west-1.kiro.dev/",
		});

		expect(resolveKiroModelCacheProviderId(oauthProfileA)).toBe(
			resolveKiroModelCacheProviderId(oauthProfileARotated),
		);
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toBe(resolveKiroModelCacheProviderId(oauthProfileB));
		expect(resolveKiroModelCacheProviderId(apiKeyEndpointA)).not.toBe(
			resolveKiroModelCacheProviderId(apiKeyEndpointB),
		);
		expect(resolveModelCacheProviderId("kiro", { apiKey: oauthProfileA })).toBe(
			resolveKiroModelCacheProviderId(oauthProfileA),
		);
		expect(resolveModelCacheProviderId("kiro")).toBe("kiro");
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toContain(PROFILE_ARN);
		expect(resolveKiroModelCacheProviderId(oauthProfileA)).not.toContain("rotated-access-a");
	});

	test("treats a profile-less OAuth bearer as OAuth, not as an API key", async () => {
		// Builder ID signs in without an organization, so the credential carries no
		// profileArn and `ksk_…` is the only thing that separates the two kinds.
		// The classification decides the cache identity: an `api_key` identity embeds
		// the raw token, so it would churn on every access-token refresh.
		const builderCredential = JSON.stringify({ token: "builder-bearer-token", apiEndpoint: API_ENDPOINT });

		expect(parseKiroDiscoveryCredential(builderCredential)).toEqual({
			type: "oauth",
			token: "builder-bearer-token",
			apiEndpoint: API_ENDPOINT,
		});
		expect(parseKiroDiscoveryCredential(JSON.stringify({ token: "ksk_key", apiEndpoint: API_ENDPOINT }))).toEqual({
			type: "api_key",
			token: "ksk_key",
			apiEndpoint: API_ENDPOINT,
		});

		// Discovery must still route and populate models without a profile ARN.
		const payload = catalogResponse(["claude-sonnet-4-5"]);
		const options = kiroModelManagerOptions({ apiKey: builderCredential, fetch: jsonFetch(payload) });
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["claude-sonnet-4-5"]);
	});

	test("keeps a profile-less OAuth cache namespace stable across token rotation", () => {
		const builderA = JSON.stringify({ token: "builder-a", apiEndpoint: API_ENDPOINT });
		const builderARotated = JSON.stringify({ token: "builder-a-rotated", apiEndpoint: API_ENDPOINT });
		const builderB = JSON.stringify({
			token: "builder-a",
			apiEndpoint: "https://management.eu-west-1.kiro.dev/",
		});

		expect(resolveKiroModelCacheProviderId(builderA)).toBe(resolveKiroModelCacheProviderId(builderARotated));
		expect(resolveKiroModelCacheProviderId(builderA)).not.toBe(resolveKiroModelCacheProviderId(builderB));
		expect(resolveKiroModelCacheProviderId(builderA)).not.toContain("builder-a");
	});

	test("separates two logins that share an endpoint and keeps one across rotation", () => {
		// Builder ID bearers carry no profile and two accounts on the same region
		// resolve the same endpoint, so the endpoint alone cannot scope the cache.
		const builderLoginA = JSON.stringify({ token: "builder-a", loginId: "login-a", apiEndpoint: API_ENDPOINT });
		const builderLoginARotated = JSON.stringify({
			token: "builder-a-rotated",
			loginId: "login-a",
			apiEndpoint: API_ENDPOINT,
		});
		const builderLoginB = JSON.stringify({ token: "builder-b", loginId: "login-b", apiEndpoint: API_ENDPOINT });

		expect(resolveKiroModelCacheProviderId(builderLoginA)).not.toBe(resolveKiroModelCacheProviderId(builderLoginB));
		expect(resolveKiroModelCacheProviderId(builderLoginA)).toBe(
			resolveKiroModelCacheProviderId(builderLoginARotated),
		);
		expect(resolveKiroModelCacheProviderId(builderLoginA)).not.toContain("login-a");
		expect(resolveKiroModelCacheProviderId(builderLoginA)).not.toContain("builder-a");
	});

	test("prunes static fallback models after a successful live catalog refresh", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-live-"));
		try {
			const options = kiroModelManagerOptions({
				apiKey: JSON.stringify({ token: "live-token", apiEndpoint: API_ENDPOINT }),
				fetch: jsonFetch(catalogResponse(["kiro-live-model"])),
			});
			const result = await resolveProviderModels(
				{
					...options,
					staticModels: [fallbackSpec()],
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);

			expect(result.stale).toBe(false);
			expect(result.models.map(model => model.id)).toEqual(["kiro-live-model"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("retains cached live models and reports stale after discovery failure", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-failure-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		try {
			const credential = JSON.stringify({ token: "cached-token", apiEndpoint: API_ENDPOINT });
			const online = kiroModelManagerOptions({
				apiKey: credential,
				fetch: jsonFetch(catalogResponse(["kiro-cached-model"])),
			});
			const populated = await resolveProviderModels(
				{ ...online, staticModels: [fallbackSpec()], cacheDbPath },
				"online",
			);
			expect(populated.models.map(model => model.id)).toEqual(["kiro-cached-model"]);

			const failed = kiroModelManagerOptions({
				apiKey: credential,
				fetch: jsonFetch({}, 503),
			});
			const result = await resolveProviderModels(
				{ ...failed, staticModels: [fallbackSpec()], cacheDbPath },
				"online",
			);

			expect(result.stale).toBe(true);
			expect(result.models.some(model => model.id === "kiro-cached-model")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	test("resolves exact tokenizers from model identity while keeping API context limits", async () => {
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "tokenizer-token", apiEndpoint: API_ENDPOINT }),
			fetch: jsonFetch(catalogResponse(["claude-opus-4-5", "gpt-5.6-luna"])),
		});

		const result = await resolveProviderModels(options, "online");
		const claude = result.models.find(model => model.id === "claude-opus-4-5");
		const gpt = result.models.find(model => model.id === "gpt-5.6-luna");

		expect(claude?.tokenizer).toBe("claude-v3");
		expect(gpt?.tokenizer).toBeUndefined();
		expect(claude?.contextWindow).toBe(100_000);
		expect(gpt?.contextWindow).toBe(100_000);
	});
});
