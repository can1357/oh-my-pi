import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	type FetchImpl,
	getCustomApi,
} from "@pk-nerdsaver-ai/pi-ai";
import { getOAuthProviders, unregisterOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/oauth";
import type { OAuthCredentials } from "@pk-nerdsaver-ai/pi-ai/oauth/types";
import { ModelRegistry, type ProviderConfigInput } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const sourceIds = ["ext://atomic", "ext://runtime", "ext://oauth"];

	// Stub transport: reject every request so refresh("online") drives the full
	// online discovery path with deterministic, instant failures instead of real
	// network. Provider fetches (dynamic + models.dev) are caught and swallowed,
	// leaving the registry with its bundled catalog plus runtime overlays.
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in model-registry runtime test"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		clearCustomApis();
		for (const sourceId of sourceIds) {
			unregisterOAuthProviders(sourceId);
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	function getProviderModels(registry: ModelRegistry, providerName: string) {
		return registry.getAll().filter(model => model.provider === providerName);
	}

	function expectProviderHeader(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): void {
		for (const model of getProviderModels(registry, providerName)) {
			expect(model.headers?.[headerName]).toBe(expectedValue);
		}
	}

	async function expectProviderHeaderAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		headerName: string,
		expectedValue: string | undefined,
	): Promise<void> {
		expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refresh("offline");
		expectProviderHeader(registry, providerName, headerName, expectedValue);
		await registry.refreshProvider(providerName, "offline");
		expectProviderHeader(registry, providerName, headerName, expectedValue);
	}

	async function expectModelTransportAcrossRefresh(
		registry: ModelRegistry,
		providerName: string,
		modelId: string,
		baseUrl: string,
		headerName: string,
		headerValue: string | undefined,
	): Promise<void> {
		const model = registry.find(providerName, modelId);
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe(baseUrl);
		expect(model?.headers?.[headerName]).toBe(headerValue);
		await registry.refresh("offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
		await registry.refreshProvider(providerName, "offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
	}

	test("validates provider config before mutating custom API state", () => {
		const beforeAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;

		const invalidConfig: ProviderConfigInput = {
			api: "custom-atomic-api",
			apiKey: "RUNTIME_KEY",
			streamSimple,
			models: [{ ...baseModel, id: "broken" }],
			// baseUrl intentionally missing to force validation failure
		};

		expect(() => registry.registerProvider("atomic-provider", invalidConfig, "ext://atomic")).toThrow(
			'Provider atomic-provider: "baseUrl" is required when defining custom models.',
		);
		expect(getCustomApi("custom-atomic-api")).toBeUndefined();

		const afterAnthropicCount = registry.getAll().filter(model => model.provider === "anthropic").length;
		expect(afterAnthropicCount).toBe(beforeAnthropicCount);
	});

	test("registerProvider applies headers-only overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";
		const runtimeHeader = "X-Runtime-Provider-Header";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { headers: { [runtimeHeader]: "runtime-header" } }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, runtimeHeader, "runtime-header");

		registry.clearSourceRegistrations("ext://runtime");
		expectProviderHeader(registry, providerName, runtimeHeader, undefined);
	});

	test("registerProvider applies authHeader overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(providerName, { apiKey: "RUNTIME_AUTH_KEY", authHeader: true }, "ext://runtime");
		await expectProviderHeaderAcrossRefresh(registry, providerName, "Authorization", "Bearer RUNTIME_AUTH_KEY");

		registry.clearSourceRegistrations("ext://runtime");
		expectProviderHeader(registry, providerName, "Authorization", undefined);
	});

	test("registerProvider applies remoteCompaction-only overrides to existing provider models across refresh", async () => {
		const providerName = "anthropic";
		const overrideEndpoint = "https://runtime.example.com/v1/compact";

		expect(getProviderModels(registry, providerName).length).toBeGreaterThan(1);
		registry.registerProvider(
			providerName,
			{ remoteCompaction: { enabled: false, endpoint: overrideEndpoint } },
			"ext://runtime",
		);

		const expectCompaction = () => {
			for (const model of getProviderModels(registry, providerName)) {
				expect(model.remoteCompaction?.enabled).toBe(false);
				expect(model.remoteCompaction?.endpoint).toBe(overrideEndpoint);
			}
		};
		expectCompaction();
		await registry.refresh("offline");
		expectCompaction();
		await registry.refreshProvider(providerName, "offline");
		expectCompaction();

		registry.clearSourceRegistrations("ext://runtime");
		for (const model of getProviderModels(registry, providerName)) {
			expect(model.remoteCompaction?.endpoint).not.toBe(overrideEndpoint);
		}
	});

	test("refreshRuntimeProviders preserves model-level remoteCompaction over provider defaults", async () => {
		const providerName = "dynamic-compact-provider";
		const providerEndpoint = "https://runtime.example.com/v1/responses/provider-compact";
		const modelEndpoint = "https://runtime.example.com/v1/responses/model-compact";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-responses",
				remoteCompaction: {
					enabled: true,
					api: "openai-responses",
					endpoint: providerEndpoint,
					model: "provider-compact",
				},
				fetchDynamicModels: async () => [
					{
						...baseModel,
						id: "dynamic-compact-model",
						remoteCompaction: {
							endpoint: modelEndpoint,
							model: "model-compact",
						},
					},
				],
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");
		const model = registry.find(providerName, "dynamic-compact-model");
		expect(model?.remoteCompaction).toEqual({
			enabled: true,
			api: "openai-responses",
			endpoint: modelEndpoint,
			model: "model-compact",
		});
	});

	test("registerProvider preserves explicit thinking and backfills wire facts", () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "anthropic-messages",
			models: [
				{
					...baseModel,
					id: "runtime-thinking-model",
					reasoning: true,
					thinking: {
						mode: "anthropic-adaptive",
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
					},
				},
			],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		const model = registry.find("runtime-provider", "runtime-thinking-model");

		expect(model?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			// Wire facts are backfilled from identity; non-claude ids get the
			// 4-tier adaptive map, filtered to the declared efforts (no xhigh).
			effortMap: { minimal: "low" },
			requiresEffort: true,
		});
	});

	test("extension-registered models survive refresh('offline') cycle", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();

		await registry.refresh("offline");

		const model = registry.find("runtime-provider", "runtime-model");
		expect(model).toBeDefined();
		expect(model?.baseUrl).toBe("https://runtime.example.com/v1");
		expect(model?.api).toBe("openai-completions");
	});

	test("extension-registered models survive refresh('online') cycle", async () => {
		// The shared registry uses a stub fetch that rejects every request, so
		// refresh("online") exercises the full online discovery path without real
		// network: each provider's fetch fails fast and is swallowed. The contract
		// under test is overlay survival across the online cycle, not discovery.
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "online-survivor" }],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.find("runtime-provider", "online-survivor")).toBeDefined();

		await registry.refresh("online");

		const model = registry.find("runtime-provider", "online-survivor");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
	});

	test("headers-only runtime override preserves existing baseUrl across refresh", async () => {
		const modelId = "runtime-headers-only-baseurl-survivor";
		const overrideBaseUrl = "https://runtime-baseurl.example.com/v1";
		const runtimeHeader = "X-Runtime-Headers-Only";

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", { baseUrl: overrideBaseUrl }, "ext://runtime");
		registry.registerProvider(
			"runtime-provider",
			{ headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);

		await expectModelTransportAcrossRefresh(
			registry,
			"runtime-provider",
			modelId,
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("runtime-provider", modelId)).toBeUndefined();
	});

	test("runtime headers override modelOverrides headers across refresh cycles", async () => {
		const targetModel = registry.getAll().find(model => model.provider === "anthropic");
		if (!targetModel) throw new Error("Expected bundled anthropic model");

		const modelId = targetModel.id;
		const sharedHeader = "X-Shared-Provider-Model-Header";
		const configHeaderValue = "config-header";
		const runtimeHeaderValue = "runtime-header";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					anthropic: { modelOverrides: { [modelId]: { headers: { [sharedHeader]: configHeaderValue } } } },
				},
			}),
		);

		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		expect(configuredRegistry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);

		configuredRegistry.registerProvider(
			"anthropic",
			{ headers: { [sharedHeader]: runtimeHeaderValue } },
			"ext://runtime",
		);
		await expectProviderHeaderAcrossRefresh(configuredRegistry, "anthropic", sharedHeader, runtimeHeaderValue);

		configuredRegistry.clearSourceRegistrations("ext://runtime");
		expect(configuredRegistry.find("anthropic", modelId)?.headers?.[sharedHeader]).toBe(configHeaderValue);
	});

	test("extension-registered API keys survive refresh cycle for auth resolution", async () => {
		// Set up the env var that the apiKey config references
		process.env.TEST_RUNTIME_KEY = "test-value";

		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "TEST_RUNTIME_KEY",
			api: "openai-completions",
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		await registry.refresh("offline");

		// The fallback resolver should still find the API key after refresh
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);

		delete process.env.TEST_RUNTIME_KEY;
	});

	test("extension-registered custom API handler survives model refresh", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, "ext://runtime");
		expect(getCustomApi("custom-runtime-api")).toBeDefined();

		// Custom API registry is separate from model registry — verify it persists
		// Note: refresh clears+re-registers source registrations via sdk.ts,
		// but the custom API registry itself is not cleared by refresh()
		await registry.refresh("offline");

		expect(getCustomApi("custom-runtime-api")).toBeDefined();
	});

	test("re-registering a provider replaces overlays and keeps transport overrides stable", async () => {
		const runtimeHeader = "X-ReRegister-Provider-Header";
		const overrideBaseUrl = "https://runtime-override.example.com/v1";
		const config1: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v1", name: "Model V1" }],
		};
		const config2: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v2",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [{ ...baseModel, id: "model-v2", name: "Model V2" }],
		};

		registry.registerProvider("runtime-provider", config1, "ext://runtime");
		registry.registerProvider(
			"runtime-provider",
			{ baseUrl: overrideBaseUrl, headers: { [runtimeHeader]: "runtime-header" } },
			"ext://runtime",
		);
		registry.registerProvider("runtime-provider", config2, "ext://runtime");

		expect(registry.find("runtime-provider", "model-v1")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			"runtime-provider",
			"model-v2",
			overrideBaseUrl,
			runtimeHeader,
			"runtime-header",
		);
	});

	test("provider source handoff does not retain previous source transport overrides", async () => {
		const providerName = "shared-runtime-provider";
		const leakedHeader = "X-Old-Source-Header";
		const sourceBBaseUrl = "https://source-b.example.com/v1";

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://source-a.example.com/v1",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{ baseUrl: "https://override-a.example.com/v1", headers: { [leakedHeader]: "from-source-a" } },
			"ext://a",
		);
		registry.registerProvider(
			providerName,
			{
				baseUrl: sourceBBaseUrl,
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find(providerName, "model-a")).toBeUndefined();
		await expectModelTransportAcrossRefresh(
			registry,
			providerName,
			"model-b",
			sourceBBaseUrl,
			leakedHeader,
			undefined,
		);
	});

	test("transport-only source handoff clears previous source headers immediately", async () => {
		const providerName = "anthropic";
		const sourceAHeader = "X-Source-A-Header";
		const sourceBHeader = "X-Source-B-Header";

		registry.registerProvider(providerName, { headers: { [sourceAHeader]: "from-source-a" } }, "ext://a");
		expectProviderHeader(registry, providerName, sourceAHeader, "from-source-a");

		registry.registerProvider(providerName, { headers: { [sourceBHeader]: "from-source-b" } }, "ext://b");
		await expectProviderHeaderAcrossRefresh(registry, providerName, sourceAHeader, undefined);
		expectProviderHeader(registry, providerName, sourceBHeader, "from-source-b");
	});

	test("multiple extension providers survive refresh independently", async () => {
		registry.registerProvider(
			"provider-a",
			{
				baseUrl: "https://a.example.com",
				apiKey: "KEY_A",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-a" }],
			},
			"ext://a",
		);
		registry.registerProvider(
			"provider-b",
			{
				baseUrl: "https://b.example.com",
				apiKey: "KEY_B",
				api: "openai-completions",
				models: [{ ...baseModel, id: "model-b" }],
			},
			"ext://b",
		);

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();

		await registry.refresh("offline");

		expect(registry.find("provider-a", "model-a")).toBeDefined();
		expect(registry.find("provider-b", "model-b")).toBeDefined();
	});

	test("clearSourceRegistrations and syncExtensionSources remove source-scoped API and OAuth providers", () => {
		const oauthCredentials: OAuthCredentials = {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};

		const config: ProviderConfigInput = {
			api: "custom-oauth-api",
			streamSimple,
			oauth: {
				name: "Custom OAuth",
				login: async () => oauthCredentials,
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
			},
		};

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.clearSourceRegistrations("ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);

		registry.registerProvider("oauth-provider", config, "ext://oauth");
		expect(getCustomApi("custom-oauth-api")).toBeDefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(true);

		registry.syncExtensionSources([]);
		expect(getCustomApi("custom-oauth-api")).toBeUndefined();
		expect(getOAuthProviders().some(provider => provider.id === "oauth-provider")).toBe(false);
	});
});
