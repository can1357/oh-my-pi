import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	kiroManagementRequest,
	listKiroAvailableProfiles,
	sanitizeKiroModelCatalog,
} from "@oh-my-pi/pi-catalog/discovery/kiro";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
	resolveKiroModelCacheProviderId,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { decodeKiroCredential, encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { logger } from "@oh-my-pi/pi-utils";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-default";
const API_ENDPOINT = "https://runtime.us-east-1.kiro.dev/";
const EU_API_ENDPOINT = "https://runtime.eu-central-1.kiro.dev/";

/** An encoded `ksk_…` API-key credential, as `/login kiro` stores it. */
function apiKeyCredential(token: string, apiEndpoint: string = API_ENDPOINT): string {
	return encodeKiroCredential({ kind: "api_key", token: `ksk_${token}`, apiEndpoint });
}

/** An encoded OAuth credential, as peek and refresh project a stored login. */
function oauthCredential(
	token: string,
	options: { loginId?: string; profileArn?: string; apiEndpoint?: string } = {},
): string {
	return encodeKiroCredential({
		kind: "oauth",
		token,
		apiEndpoint: options.apiEndpoint ?? API_ENDPOINT,
		loginId: options.loginId ?? "login-default",
		...(options.profileArn ? { profileArn: options.profileArn } : {}),
	});
}

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
		apiKey: apiKeyCredential("test-token"),
		fetch: jsonFetch(payload),
	}).fetchDynamicModels?.();
}

describe("Kiro provider discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("is authoritative with a fallback default and stays out of catalog generation", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "kiro");

		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("auto");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["kiro"]).toBe("auto");
		// The roster is credential-scoped: a catalog discovery entry would let
		// `generate-models.ts` freeze one account's models into models.json.
		expect(descriptor?.catalogDiscovery).toBeUndefined();
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
			apiKey: apiKeyCredential("catalog-token"),
			fetch: jsonFetch(catalogResponse(modelIds, { defaultModel: { modelId: "auto" } })),
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(modelIds);
	});

	test("maps TEXT and IMAGE supportedInputTypes in order without output metadata", async () => {
		const textOptions = kiroModelManagerOptions({
			apiKey: apiKeyCredential("text-token"),
			fetch: jsonFetch(catalogResponse(["text-model"], { inputTypes: ["TEXT"] })),
		});
		const multimodalOptions = kiroModelManagerOptions({
			apiKey: apiKeyCredential("image-token"),
			fetch: jsonFetch(catalogResponse(["image-model"], { inputTypes: ["TEXT", "IMAGE"] })),
		});

		expect((await textOptions.fetchDynamicModels?.())?.[0]?.input).toEqual(["text"]);
		expect((await multimodalOptions.fetchDynamicModels?.())?.[0]?.input).toEqual(["text", "image"]);
	});

	test("falls back to text-only input when supportedInputTypes is missing or invalid", () => {
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const invalidInputTypes: unknown[] = [null, "TEXT", [], ["VIDEO"], [1], ["TEXT", "TEXT"], ["IMAGE"]];
		for (const inputTypes of invalidInputTypes) {
			const catalog = sanitizeKiroModelCatalog(catalogResponse(["invalid-input-model"], { inputTypes }));
			expect(catalog.models.map(model => model.supportedInputTypes)).toEqual([["TEXT"]]);
		}
		const missing = sanitizeKiroModelCatalog(catalogResponse(["missing-input-model"], { omitInputTypes: true }));
		expect(missing.models.map(model => model.supportedInputTypes)).toEqual([["TEXT"]]);
	});

	test("skips an invalid model, keeps the rest, and rejects only a malformed envelope", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "debug").mockImplementation(() => {});
		const payload = catalogResponse(["model-one", "bad-limits", "model-two", "model-one", "bad-schema"]);
		const models = payload.models as Array<Record<string, unknown>>;
		models[1]!.tokenLimits = { maxInputTokens: 0, maxOutputTokens: 8_192 };
		models[3]!.modelName = "Duplicate of model-one";
		models[4]!.additionalModelRequestFieldsSchema = null;

		const discovered = await discover(payload);

		// The invalid-limit model is skipped, the repeated id keeps its first entry,
		// and the malformed schema drops only that model's thinking controls.
		expect(discovered?.map(model => [model.id, model.name, model.reasoning])).toEqual([
			["model-one", "model-one", false],
			["model-two", "model-two", false],
			["bad-schema", "bad-schema", false],
		]);
		for (const envelope of [null, { models: "none" }, { models: [], nextToken: 7 }]) {
			expect(() => sanitizeKiroModelCatalog(envelope)).toThrow("Unsafe ListAvailableModels response");
		}
	});

	test("keeps request schema, token limits, and credit rates, and drops a non-credit rate", () => {
		const payload = catalogResponse(["credit-model", "bogus-rate-model"], { inputTypes: ["TEXT"] });
		const [credit, bogus] = payload.models as Array<Record<string, unknown>>;
		credit!.additionalModelRequestFieldsSchema = {
			type: "object",
			properties: { reasoning: { type: "string" } },
		};
		Object.assign(credit!, { rateMultiplier: 1.5, rateUnit: "Credit" });
		Object.assign(bogus!, { rateMultiplier: 1, rateUnit: "Bogus" });

		const [sanitized, dropped] = sanitizeKiroModelCatalog(payload).models;
		expect(sanitized).toMatchObject({
			supportedInputTypes: ["TEXT"],
			tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
			rateMultiplier: 1.5,
			rateUnit: "Credit",
		});
		expect(sanitized?.additionalModelRequestFieldsSchema?.properties?.reasoning?.type).toBe("string");
		expect(dropped?.rateMultiplier).toBeUndefined();
	});

	test("maps the live effort-only GPT reasoning schema for the full model catalog", async () => {
		const modelIds = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
		const payload = catalogResponse(modelIds);
		for (const model of payload.models as Array<Record<string, unknown>>) {
			model.additionalModelRequestFieldsSchema = gptReasoningSchema();
		}
		const options = kiroModelManagerOptions({
			apiKey: apiKeyCredential("gpt-catalog-token"),
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
			apiKey: apiKeyCredential("adaptive-only-token"),
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
		const payload = catalogResponse(["claude-bad-limits"]);
		(payload.models as Array<Record<string, unknown>>)[0]!.tokenLimits = { maxInputTokens: -1 };

		expect(await discover(payload)).toBeNull();
		expect(error).toHaveBeenCalledTimes(1);
	});

	test("accepts legacy GPT mode+effort reasoning schemas", async () => {
		const payload = catalogResponse(["gpt-legacy"]);
		const model = (payload.models as Array<Record<string, unknown>>)[0]!;
		model.additionalModelRequestFieldsSchema = gptReasoningSchema(true);
		const options = kiroModelManagerOptions({
			apiKey: apiKeyCredential("legacy-gpt-token"),
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
			apiKey: apiKeyCredential("invalid-gpt-token"),
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
			apiKey: oauthCredential("oauth-bearer", { profileArn: PROFILE_ARN }),
			fetch,
		});

		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["kiro-oauth-model"]);
		expect(requestBody).toEqual({ origin: "KIRO_CLI", profileArn: PROFILE_ARN });
	});

	test("follows nextToken through every page of models and profiles", async () => {
		const modelBodies: unknown[] = [];
		const modelFetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { nextToken?: string };
			modelBodies.push(body);
			return Response.json(
				body.nextToken === "models-2"
					? catalogResponse(["page-two-model"])
					: { ...catalogResponse(["page-one-model"]), nextToken: "models-2" },
			);
		};
		const models = await kiroModelManagerOptions({
			apiKey: apiKeyCredential("paged-token"),
			fetch: modelFetch,
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["page-one-model", "page-two-model"]);
		expect(modelBodies).toEqual([{ origin: "KIRO_CLI" }, { origin: "KIRO_CLI", nextToken: "models-2" }]);

		const profileTwo = "arn:aws:codewhisperer:us-east-1:123456789012:profile/second";
		const profileFetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { nextToken?: string };
			return Response.json(
				body.nextToken === "profiles-2"
					? { profiles: [{ arn: profileTwo }] }
					: { profiles: [{ arn: PROFILE_ARN, profileName: "First" }], nextToken: "profiles-2" },
			);
		};
		const profiles = await listKiroAvailableProfiles({ apiRegion: "us-east-1", token: "t", fetch: profileFetch });
		expect(profiles).toEqual([{ arn: PROFILE_ARN, profileName: "First" }, { arn: profileTwo }]);
	});

	test("routes an env API key to KIRO_API_REGION without probing other regions", async () => {
		const requested: string[] = [];
		const fetch: FetchImpl = async input => {
			requested.push(String(input));
			return Response.json(catalogResponse(["eu-model"]));
		};
		const previous = Bun.env.KIRO_API_REGION;
		Bun.env.KIRO_API_REGION = "eu-central-1";
		try {
			const models = await kiroModelManagerOptions({ apiKey: "ksk_env-key", fetch }).fetchDynamicModels?.();
			expect(models?.map(model => [model.id, model.baseUrl])).toEqual([["eu-model", EU_API_ENDPOINT]]);
			expect(requested).toEqual(["https://management.eu-central-1.kiro.dev/"]);
		} finally {
			if (previous === undefined) delete Bun.env.KIRO_API_REGION;
			else Bun.env.KIRO_API_REGION = previous;
		}
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
			apiKey: apiKeyCredential(token),
		});
		const namespace = options.cacheProviderId ?? "";

		expect(namespace).toMatch(/^kiro:models-v2:/);
		expect(namespace).not.toContain(token);
		expect(namespace).not.toContain(PROFILE_ARN);
	});

	test("scopes the OAuth cache to the login and agrees with the lightweight resolver", () => {
		// Identity Center profiles are shared org-wide and Builder ID logins have
		// none, so two logins on one profile or endpoint must still get separate
		// caches, while one login keeps its cache across access-token rotation.
		const loginA = oauthCredential("access-a", { loginId: "login-a", profileArn: PROFILE_ARN });
		const loginARotated = oauthCredential("access-a-rotated", { loginId: "login-a", profileArn: PROFILE_ARN });
		const loginBSameProfile = oauthCredential("access-b", { loginId: "login-b", profileArn: PROFILE_ARN });
		const builderA = oauthCredential("builder-a", { loginId: "builder-login-a" });
		const builderB = oauthCredential("builder-b", { loginId: "builder-login-b" });

		expect(resolveKiroModelCacheProviderId(loginA)).toBe(resolveKiroModelCacheProviderId(loginARotated));
		expect(resolveKiroModelCacheProviderId(loginA)).not.toBe(resolveKiroModelCacheProviderId(loginBSameProfile));
		expect(resolveKiroModelCacheProviderId(builderA)).not.toBe(resolveKiroModelCacheProviderId(builderB));
		expect(resolveModelCacheProviderId("kiro", { apiKey: loginA })).toBe(resolveKiroModelCacheProviderId(loginA));
		expect(resolveModelCacheProviderId("kiro")).toBe("kiro");
		for (const secret of [PROFILE_ARN, "login-a", "access-a"]) {
			expect(resolveKiroModelCacheProviderId(loginA)).not.toContain(secret);
		}
	});

	test("scopes the API-key cache to the key and its endpoint", () => {
		expect(resolveKiroModelCacheProviderId(apiKeyCredential("key-a"))).not.toBe(
			resolveKiroModelCacheProviderId(apiKeyCredential("key-a", EU_API_ENDPOINT)),
		);
		expect(resolveKiroModelCacheProviderId(apiKeyCredential("key-a"))).not.toBe(
			resolveKiroModelCacheProviderId(apiKeyCredential("key-b")),
		);
	});

	test("routes a profile-less Builder ID login by its endpoint", async () => {
		const builderCredential = oauthCredential("builder-bearer-token", { loginId: "builder-login" });
		let requestUrl = "";
		let requestBody: unknown;
		const fetch: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body));
			return Response.json(catalogResponse(["claude-sonnet-4-5"]));
		};

		const models = await kiroModelManagerOptions({ apiKey: builderCredential, fetch }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual(["claude-sonnet-4-5"]);
		expect(requestUrl).toBe("https://management.us-east-1.kiro.dev/");
		expect(requestBody).toEqual({ origin: "KIRO_CLI" });
	});

	test("decodes only the encoded form or a raw ksk_ key", () => {
		expect(decodeKiroCredential("ksk_raw", {})).toEqual({ kind: "api_key", token: "ksk_raw" });
		// A bearer is never mistaken for an API key: it must arrive encoded.
		expect(() => decodeKiroCredential("raw-bearer", {})).toThrow("ksk_");
		expect(() =>
			decodeKiroCredential(JSON.stringify({ kind: "api_key", token: "not-a-key", apiEndpoint: API_ENDPOINT }), {}),
		).toThrow("ksk_");
		expect(() =>
			decodeKiroCredential(JSON.stringify({ kind: "oauth", token: "bearer", apiEndpoint: API_ENDPOINT }), {}),
		).toThrow("login id");
		expect(() =>
			decodeKiroCredential(
				JSON.stringify({ kind: "api_key", token: "ksk_a", apiEndpoint: "https://evil.example/" }),
				{},
			),
		).toThrow("endpoint");
	});

	test("prunes static fallback models after a successful live catalog refresh", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-live-"));
		try {
			const options = kiroModelManagerOptions({
				apiKey: apiKeyCredential("live-token"),
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
			const credential = apiKeyCredential("cached-token");
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
			apiKey: apiKeyCredential("tokenizer-token"),
			fetch: jsonFetch(catalogResponse(["claude-opus-4-5", "gpt-5.6-luna"])),
		});

		const result = await resolveProviderModels(options, "online");
		const claude = result.models.find(model => model.id === "claude-opus-4-5");
		const gpt = result.models.find(model => model.id === "gpt-5.6-luna");

		expect(claude?.tokenizer).toBe("claude-v3");
		expect(gpt?.tokenizer).toBe("o200k");
		expect(claude?.contextWindow).toBe(100_000);
		expect(gpt?.contextWindow).toBe(100_000);
	});
});
