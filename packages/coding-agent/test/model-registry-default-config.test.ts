import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { CacheWarmer, getPromptCacheTtlMs } from "../src/session/cache-warmer";

const originalAgentDir = getAgentDir();
const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

let tempDir: TempDir;
let authStorage: AuthStorage;

const BEDROCK_OPUS_MODEL = "us.anthropic.claude-opus-4-8";

describe("ModelRegistry default custom models config", () => {
	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-default-config-");
		setAgentDir(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		await tempDir.remove().catch(() => {});
	});

	test("loads custom provider models from default models.yaml when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "yaml-default-only",
			modelId: "yaml-model",
			modelName: "YAML default model",
			baseUrl: "https://yaml-default.example.com/v1",
		});

		const [model] = loadDefaultRegistryModels({
			provider: "yaml-default-only",
			modelId: "yaml-model",
		});

		expect(model?.name).toBe("YAML default model");
		expect(model?.baseUrl).toBe("https://yaml-default.example.com/v1");
	});

	test("retains STB decoder metadata on a renamed custom provider", () => {
		writeModelsYaml("models.yml", {
			provider: "managed-primary",
			modelId: "local-vision",
			modelName: "Local vision",
			baseUrl: "http://127.0.0.1:8080/v1",
			imageInputDecoder: "stb",
		});

		const [model] = loadDefaultRegistryModels({ provider: "managed-primary", modelId: "local-vision" });

		expect(model?.imageInputDecoder).toBe("stb");
	});

	test("loads Bedrock cache capabilities from a model override", () => {
		writeBedrockCacheOverride();

		const [model] = loadDefaultRegistryModels({
			provider: "amazon-bedrock",
			modelId: "us.anthropic.claude-opus-4-8",
		});

		expect(model?.compat).toEqual({
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: false,
			promptCacheMinimumTokens: 1024,
			promptCacheMaximumCheckpoints: 4,
			// Reasoning-tier Bedrock stream-stall watchdog widening applies to
			// overrides too (model compat generation).
			streamIdleTimeoutMs: 900000,
			streamRevision: "possible",
		});
	});

	test("prefers default models.yml over models.yaml when both exist", () => {
		writeModelsYaml("models.yml", {
			provider: "yaml-precedence",
			modelId: "from-yml",
			modelName: "YML winner",
			baseUrl: "https://yml-winner.example.com/v1",
		});
		writeModelsYaml("models.yaml", {
			provider: "yaml-precedence",
			modelId: "from-yaml",
			modelName: "YAML loser",
			baseUrl: "https://yaml-loser.example.com/v1",
		});

		const [ymlModel, yamlModel] = loadDefaultRegistryModels(
			{ provider: "yaml-precedence", modelId: "from-yml" },
			{ provider: "yaml-precedence", modelId: "from-yaml" },
		);

		expect(ymlModel?.baseUrl).toBe("https://yml-winner.example.com/v1");
		expect(yamlModel).toBeUndefined();
	});

	test("prefers default models.yaml over legacy models.json when models.yml is absent", () => {
		writeModelsYaml("models.yaml", {
			provider: "yaml-json-precedence",
			modelId: "from-yaml",
			modelName: "YAML winner over JSON",
			baseUrl: "https://yaml-over-json.example.com/v1",
		});
		writeModelsJson({
			provider: "yaml-json-precedence",
			modelId: "from-json",
			modelName: "JSON loser",
			baseUrl: "https://json-loser.example.com/v1",
		});

		const [yamlModel, jsonModel] = loadDefaultRegistryModels(
			{ provider: "yaml-json-precedence", modelId: "from-yaml" },
			{ provider: "yaml-json-precedence", modelId: "from-json" },
		);

		expect(yamlModel?.baseUrl).toBe("https://yaml-over-json.example.com/v1");
		expect(jsonModel).toBeUndefined();
	});
	describe("prompt cache lifetime configuration", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		test("an explicit empty model override prevents cache warming", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-empty.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    modelOverrides:",
					`      ${JSON.stringify(BEDROCK_OPUS_MODEL)}:`,
					"        promptCache: {}",
					"",
				].join("\n"),
			);
			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };

			expect(getPromptCacheTtlMs(model, options)).toBeUndefined();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("inactive");
				vi.advanceTimersByTime(270_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});

		test("a one-tier override schedules from its short lifetime without inheriting long", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-short-only.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    modelOverrides:",
					`      ${JSON.stringify(BEDROCK_OPUS_MODEL)}:`,
					"        promptCache:",
					"          short: 90",
					"        compat:",
					"          supportsLongPromptCacheRetention: true",
					"",
				].join("\n"),
			);
			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			const shortOptions: SimpleStreamOptions = { cacheRetention: "short" };
			const longOptions: SimpleStreamOptions = { cacheRetention: "long" };

			expect(model.promptCache).toEqual({ short: 90 });
			expect(getPromptCacheTtlMs(model, shortOptions)).toBe(90_000);
			expect(getPromptCacheTtlMs(model, longOptions)).toBeUndefined();

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, shortOptions);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 80_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});

		test("a default Bedrock model retains its catalog short and long lifetimes", () => {
			const registry = createPromptCacheRegistry("prompt-cache-default.yml", "providers: {}\n");
			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);

			expect(model.promptCache).toEqual({ short: 300, long: 3600 });
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
		});

		test("custom Bedrock lifetime survives an unrelated override and provider fields", async () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-provider-rebuild.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com",
					"    api: bedrock-converse-stream",
					"    apiKey: TEST_KEY",
					"    requestMetadata:",
					"      regression: configured-custom-lifetime",
					"    modelOverrides:",
					`      ${JSON.stringify(BEDROCK_OPUS_MODEL)}:`,
					"        maxTokens: 4321",
					"    models:",
					bedrockModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);

			expect(model.requestMetadata).toEqual({ regression: "configured-custom-lifetime" });
			expect(getPromptCacheTtlMs(model, options)).toBe(90_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBeUndefined();
			expect(model.maxTokens).toBe(4321);

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 80_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}

			await registry.refresh("offline");
			const rebuiltModel = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			expect(rebuiltModel.requestMetadata).toEqual({ regression: "configured-custom-lifetime" });
			expect(getPromptCacheTtlMs(rebuiltModel, options)).toBe(90_000);

			const rebuiltScheduledAt = Date.now();
			const rebuilt = armRegistryModel(rebuiltModel, options);
			try {
				expect(rebuilt.warmer.status.state).toBe("scheduled");
				expect(rebuilt.warmer.status.nextWarmAt).toBe(rebuiltScheduledAt + 80_000);
				expect(rebuilt.streamCalls()).toBe(0);
			} finally {
				rebuilt.warmer.cancel();
			}
		});

		test("runtime lifetime replacement outranks the matching YAML definition after offline rebuild", async () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-runtime-precedence.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com",
					"    api: bedrock-converse-stream",
					"    apiKey: TEST_KEY",
					"    models:",
					bedrockModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			expect(requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL).promptCache).toEqual({
				short: 90,
			});

			registry.registerProvider(
				"amazon-bedrock",
				runtimeBedrockProvider({ short: 180 }),
				"ext://runtime-cache-lifetime",
			);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			const expectRuntimeLifetime = (model: Model) => {
				expect(model.promptCache).toEqual({ short: 180 });
				expect(getPromptCacheTtlMs(model, options)).toBe(180_000);

				const scheduledAt = Date.now();
				const armed = armRegistryModel(model, options);
				try {
					expect(armed.warmer.status.state).toBe("scheduled");
					expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 162_000);
					expect(armed.streamCalls()).toBe(0);
				} finally {
					armed.warmer.cancel();
				}
			};

			expectRuntimeLifetime(requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL));
			await registry.refresh("offline");
			expectRuntimeLifetime(requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL));
		});

		test("empty runtime lifetime opts out, while absent runtime lifetime uses catalog defaults", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-runtime-opt-out.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com",
					"    api: bedrock-converse-stream",
					"    apiKey: TEST_KEY",
					"    models:",
					bedrockModelDefinition({ short: 90 }),
					"",
				].join("\n"),
			);
			registry.registerProvider("amazon-bedrock", runtimeBedrockProvider({}), "ext://runtime-cache-opt-out");

			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };
			expect(model.promptCache).toEqual({});
			expect(getPromptCacheTtlMs(model, options)).toBeUndefined();

			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("inactive");
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
			registry.clearSourceRegistrations("ext://runtime-cache-opt-out");
			registry.registerProvider("amazon-bedrock", runtimeBedrockProvider(), "ext://runtime-cache-absent");
			const catalogDefaultModel = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			expect(catalogDefaultModel.promptCache).toEqual({ short: 300, long: 3600 });
			expect(getPromptCacheTtlMs(catalogDefaultModel, options)).toBe(300_000);
		});

		test("model override lifetime remains highest priority over runtime and YAML definitions", () => {
			const registry = createPromptCacheRegistry(
				"prompt-cache-override-precedence.yml",
				[
					"providers:",
					"  amazon-bedrock:",
					"    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com",
					"    api: bedrock-converse-stream",
					"    apiKey: TEST_KEY",
					"    modelOverrides:",
					`      ${JSON.stringify(BEDROCK_OPUS_MODEL)}:`,
					"        promptCache:",
					"          short: 120",
					"    models:",
					bedrockModelDefinition({ short: 90, long: 3600 }),
					"",
				].join("\n"),
			);
			registry.registerProvider(
				"amazon-bedrock",
				runtimeBedrockProvider({ short: 180 }),
				"ext://runtime-cache-override",
			);
			const model = requireRegistryModel(registry, "amazon-bedrock", BEDROCK_OPUS_MODEL);
			const options: SimpleStreamOptions = { cacheRetention: "short" };

			expect(model.promptCache).toEqual({ short: 120 });
			expect(getPromptCacheTtlMs(model, options)).toBe(120_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBeUndefined();

			const scheduledAt = Date.now();
			const armed = armRegistryModel(model, options);
			try {
				expect(armed.warmer.status.state).toBe("scheduled");
				expect(armed.warmer.status.nextWarmAt).toBe(scheduledAt + 108_000);
				expect(armed.streamCalls()).toBe(0);
			} finally {
				armed.warmer.cancel();
			}
		});
	});
});

interface ProviderFixture {
	provider: string;
	modelId: string;
	modelName: string;
	baseUrl: string;
	imageInputDecoder?: "stb";
}

interface ModelLookup {
	provider: string;
	modelId: string;
}

interface ModelSnapshot {
	provider: string;
	id: string;
	name: string;
	baseUrl: string | undefined;
	imageInputDecoder?: "stb";
	compat: {
		promptCacheMode: string;
		supportsLongPromptCacheRetention: boolean;
		promptCacheMinimumTokens: number;
		promptCacheMaximumCheckpoints: number;
		streamIdleTimeoutMs?: number;
		streamRevision?: "possible";
	};
}

function writeModelsYaml(file: "models.yml" | "models.yaml", fixture: ProviderFixture): void {
	const decoderLine = fixture.imageInputDecoder
		? `        imageInputDecoder: ${fixture.imageInputDecoder}`
		: undefined;
	fs.writeFileSync(
		path.join(tempDir.path(), file),
		[
			"providers:",
			`  ${fixture.provider}:`,
			`    baseUrl: ${fixture.baseUrl}`,
			"    apiKey: TEST_KEY",
			"    api: anthropic-messages",
			"    models:",
			`      - id: ${fixture.modelId}`,
			`        name: ${fixture.modelName}`,
			"        reasoning: false",
			fixture.imageInputDecoder ? "        input: [text, image]" : "        input: [text]",
			...(decoderLine ? [decoderLine] : []),
			"        cost:",
			"          input: 0",
			"          output: 0",
			"          cacheRead: 0",
			"          cacheWrite: 0",
			"        contextWindow: 100000",
			"        maxTokens: 8000",
			"",
		].join("\n"),
	);
}

function writeBedrockCacheOverride(): void {
	fs.writeFileSync(
		path.join(tempDir.path(), "models.yml"),
		[
			"providers:",
			"  amazon-bedrock:",
			"    modelOverrides:",
			"      us.anthropic.claude-opus-4-8:",
			"        compat:",
			"          promptCacheMode: explicit",
			"          supportsLongPromptCacheRetention: false",
			"          promptCacheMinimumTokens: 1024",
			"          promptCacheMaximumCheckpoints: 4",
			"",
		].join("\n"),
	);
}

function writeModelsJson(fixture: ProviderFixture): void {
	fs.writeFileSync(
		path.join(tempDir.path(), "models.json"),
		JSON.stringify({
			providers: {
				[fixture.provider]: {
					baseUrl: fixture.baseUrl,
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: fixture.modelId,
							name: fixture.modelName,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
						},
					],
				},
			},
		}),
	);
}

function loadDefaultRegistryModels(...lookups: ModelLookup[]): Array<ModelSnapshot | undefined> {
	const registry = new ModelRegistry(authStorage);
	return lookups.map(lookup => {
		const model = registry.find(lookup.provider, lookup.modelId);
		if (!model) return undefined;
		return {
			provider: model.provider,
			id: model.id,
			name: model.name,
			baseUrl: model.baseUrl,
			imageInputDecoder: model.imageInputDecoder,
			compat: model.compat as ModelSnapshot["compat"],
		};
	});
}
function createPromptCacheRegistry(filename: string, yaml: string): ModelRegistry {
	const modelsPath = path.join(tempDir.path(), filename);
	fs.writeFileSync(modelsPath, yaml);
	return new ModelRegistry(authStorage, modelsPath, {
		fetch: async () => {
			throw new Error("network disabled in prompt-cache configuration test");
		},
	});
}

function requireRegistryModel(registry: ModelRegistry, provider: string, modelId: string): Model {
	const configError = registry.getError();
	if (configError) throw configError;
	const model = registry.find(provider, modelId);
	if (!model) throw new Error(`Missing model ${provider}/${modelId}`);
	return model;
}

function bedrockModelDefinition(promptCache: { short: number; long?: number }): string {
	return [
		`      - id: ${BEDROCK_OPUS_MODEL}`,
		"        name: Configured Claude Opus cache fixture",
		"        api: bedrock-converse-stream",
		"        reasoning: false",
		"        input: [text]",
		"        cost:",
		"          input: 3",
		"          output: 15",
		"          cacheRead: 0.3",
		"          cacheWrite: 3.75",
		"        promptCache:",
		`          short: ${promptCache.short}`,
		...(promptCache.long === undefined ? [] : [`          long: ${promptCache.long}`]),
		"        compat:",
		"          promptCacheMode: explicit",
		"          supportsLongPromptCacheRetention: true",
		"        contextWindow: 200000",
		"        maxTokens: 8000",
	].join("\n");
}

function runtimeBedrockProvider(promptCache?: Model["promptCache"]): ProviderConfigInput {
	return {
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		apiKey: "TEST_KEY",
		api: "bedrock-converse-stream",
		models: [
			{
				id: BEDROCK_OPUS_MODEL,
				name: "Runtime Claude Opus cache fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 8000,
				...(promptCache !== undefined ? { promptCache } : {}),
				compat: {
					promptCacheMode: "explicit",
					supportsLongPromptCacheRetention: true,
					promptCacheMinimumTokens: 0,
					promptCacheMaximumCheckpoints: 2,
				},
			},
		],
	};
}

function armRegistryModel(
	model: Model,
	options: SimpleStreamOptions,
): {
	warmer: CacheWarmer;
	streamCalls: () => number;
} {
	let streamCalls = 0;
	const warmer = new CacheWarmer({
		stream: () => {
			streamCalls++;
			throw new Error("unexpected paid cache refresh in schedule-only test");
		},
		getPromptTokens: () => 100_000,
		getMode: () => "streaming",
	});
	warmer.start({ model, context: { messages: [] }, options }, () => true);
	return { warmer, streamCalls: () => streamCalls };
}
