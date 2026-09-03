import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	clearCustomApis,
	Effort,
	type FetchImpl,
	getCustomApi,
	type Model,
} from "@oh-my-pi/pi-ai";
import { getOAuthProviders, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime provider registration", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let fetchRequests: string[];

	const sourceIds = ["ext://atomic", "ext://runtime", "ext://oauth"];

	// Stub transport: reject every request so refresh("online") drives the full
	// online discovery path with deterministic, instant failures instead of real
	// network. Provider fetches (dynamic + stencil.so) are caught and swallowed,
	// leaving the registry with its bundled catalog plus runtime overlays.
	const offlineFetch: FetchImpl = input => {
		fetchRequests.push(String(input));
		return Promise.reject(new Error("network disabled in model-registry runtime test"));
	};

	beforeEach(async () => {
		fetchRequests = [];
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-runtime-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(() => {
		vi.useRealTimers();
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

	async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
		for (let i = 0; i < 1000; i++) {
			if (predicate()) return;
			await Promise.resolve();
		}
		throw new Error(errorMessage);
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
		expect(model?.baseUrl).toBe(baseUrl);
		expect(model?.headers?.[headerName]).toBe(headerValue);
		await registry.refresh("offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
		await registry.refreshProvider(providerName, "offline");
		expect(registry.find(providerName, modelId)?.baseUrl).toBe(baseUrl);
		expect(registry.find(providerName, modelId)?.headers?.[headerName]).toBe(headerValue);
	}

	test("does not discover ClinePass without credentials", async () => {
		const peek = vi.spyOn(authStorage, "peekApiKey").mockResolvedValue(undefined);
		try {
			await registry.refresh("online");
		} finally {
			peek.mockRestore();
		}

		expect(fetchRequests).not.toContain("https://api.cline.bot/api/v1/ai/cline/recommended-models");
		expect(registry.find("cline-pass", "kimi-k3")).toBeDefined();
	});

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

	test("registerProvider rebuilds inferred computer capability after OpenAI runtime reroutes", async () => {
		const modelId = "gpt-5.4";
		const directModel = registry.find("openai", modelId);
		expect(directModel?.supportsComputerUse).toBe(true);

		registry.registerProvider("openai", { baseUrl: "https://runtime-proxy.example.com/v1" }, "ext://runtime");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);

		await registry.refresh("offline");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);
		await registry.refreshProvider("openai", "offline");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(false);

		registry.clearSourceRegistrations("ext://runtime");
		expect(registry.find("openai", modelId)?.supportsComputerUse).toBe(true);
	});

	test("config.models re-registration rebuilds inferred capability after a saved transport override", () => {
		const providerName = "openai";
		const modelId = "gpt-5.4";
		const proxyBaseUrl = "https://runtime-proxy.example.com/v1";

		registry.registerProvider(providerName, { baseUrl: proxyBaseUrl }, "ext://runtime");
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://api.openai.com/v1",
				api: "openai-responses",
				apiKey: "RUNTIME_KEY",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);

		const model = registry.find(providerName, modelId);
		expect(model?.baseUrl).toBe(proxyBaseUrl);
		expect(model?.supportsComputerUse).toBe(false);
		expect(model?.supportsComputerUseConfig).toBeUndefined();
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

	test("registerProvider keeps runtime header objects live for request-time reads", () => {
		const providerHeaders: Record<string, string> = { "X-Request-ID": "request-1" };
		const modelHeaders: Record<string, string> = { "X-Message-ID": "message-1" };

		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				headers: providerHeaders,
				models: [{ ...baseModel, headers: modelHeaders }],
			},
			"ext://runtime",
		);

		providerHeaders["X-Request-ID"] = "request-2";
		providerHeaders["X-Turn-ID"] = "turn-2";
		modelHeaders["X-Message-ID"] = "message-2";
		modelHeaders["X-Model-Turn-ID"] = "model-turn-2";

		const model = registry.find("runtime-provider", "runtime-model");
		expect({ ...model?.headers }).toEqual({
			"X-Request-ID": "request-2",
			"X-Turn-ID": "turn-2",
			"X-Message-ID": "message-2",
			"X-Model-Turn-ID": "model-turn-2",
		});
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
	test("combines static fallback models with dynamic provider discovery", async () => {
		const providerName = "combined-runtime-provider";
		let dynamicFetches = 0;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: "fallback-model" }],
				fetchDynamicModels: async () => {
					dynamicFetches++;
					return [{ ...baseModel, id: "dynamic-model" }];
				},
			},
			"ext://runtime",
		);

		await registry.refreshRuntimeProviders("online");

		expect(dynamicFetches).toBe(1);
		expect(registry.find(providerName, "dynamic-model")).toBeDefined();
		expect(registry.find(providerName, "fallback-model")).toBeDefined();
	});

	test("configured discovery suppresses extension fetchDynamicModels for the same provider", async () => {
		const providerName = "runtime-configured-provider";
		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "http://127.0.0.1:4893",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const configuredFetch: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4893/v1/models") {
				return Response.json({
					data: [{ id: "shared-runtime-model", context_length: 32_768 }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: configuredFetch });
		let runtimeFetchCalls = 0;
		configuredRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					runtimeFetchCalls++;
					return [{ ...baseModel, id: "shared-runtime-model", contextWindow: 999_999 }];
				},
			},
			"ext://runtime",
		);

		await configuredRegistry.refreshProvider(providerName, "online");

		expect(runtimeFetchCalls).toBe(0);
		expect(configuredRegistry.find(providerName, "shared-runtime-model")?.contextWindow).toBe(32_768);
	});

	test("runtime provider manager supersedes the built-in shared catalog manager", async () => {
		let catalogFetches = 0;
		const catalogFetch: FetchImpl = async input => {
			catalogFetches++;
			throw new Error(`Unexpected built-in catalog fetch: ${String(input)}`);
		};
		const overrideRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: catalogFetch });
		let runtimeFetches = 0;
		overrideRegistry.registerProvider(
			"anthropic",
			{
				baseUrl: "https://runtime.example.com/v1",
				api: "anthropic-messages",
				fetchDynamicModels: async () => {
					runtimeFetches++;
					return [{ ...baseModel, id: "runtime-anthropic-model" }];
				},
			},
			"ext://runtime",
		);

		await overrideRegistry.refreshProvider("anthropic", "online");

		expect(runtimeFetches).toBe(1);
		expect(catalogFetches).toBe(0);
		expect(getProviderModels(overrideRegistry, "anthropic").map(model => model.id)).toEqual([
			"runtime-anthropic-model",
		]);
	});

	test("refreshProvider aborts and retries inherited shared-catalog fetches", async () => {
		vi.useFakeTimers();
		// Pin the keyless premise: a host ANTHROPIC_API_KEY (dev machines, agent
		// harnesses) gives the anthropic manager a fetchDynamicModels hook whose
		// endpoint fetch starts only after the catalog abort — its deadline timer
		// arms after the last advanceTimersByTime and the refresh hangs forever.
		const peekSpy = vi.spyOn(authStorage, "peekApiKey").mockResolvedValue(undefined);
		let catalogFetches = 0;
		let abortedFetches = 0;
		const stalledFetch: FetchImpl = (_input, init) => {
			catalogFetches++;
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			if (!signal) {
				reject(new Error("catalog fetch did not receive an abort signal"));
				return promise;
			}
			const rejectAborted = () => {
				abortedFetches++;
				reject(signal.reason);
			};
			if (signal.aborted) {
				rejectAborted();
			} else {
				signal.addEventListener("abort", rejectAborted, { once: true });
			}
			return promise;
		};
		const stalledRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: stalledFetch });

		const firstRefresh = stalledRegistry.refreshProvider("anthropic", "online");
		await drainMicrotasksUntil(() => catalogFetches === 1, "first shared-catalog fetch did not start");
		vi.advanceTimersByTime(9_999);
		await Promise.resolve();
		expect(abortedFetches).toBe(0);
		vi.advanceTimersByTime(1);
		await firstRefresh;
		expect(abortedFetches).toBe(1);

		const secondRefresh = stalledRegistry.refreshProvider("anthropic", "online");
		await drainMicrotasksUntil(() => catalogFetches === 2, "second shared-catalog fetch did not start");
		vi.advanceTimersByTime(10_000);
		await secondRefresh;
		expect(abortedFetches).toBe(2);
		expect(catalogFetches).toBe(2);
		peekSpy.mockRestore();
	});

	test("refreshRuntimeProviders times out extension fetchDynamicModels that never resolves", async () => {
		vi.useFakeTimers();
		const hangingFetch = Promise.withResolvers<readonly NonNullable<ProviderConfigInput["models"]>[number][]>();
		registry.registerProvider(
			"hanging-runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: () => hangingFetch.promise,
			},
			"ext://runtime",
		);

		const baselineTimers = vi.getTimerCount();
		let outcome: "resolved" | "rejected" | undefined;
		const refresh = registry.refreshRuntimeProviders("online").then(
			() => {
				outcome = "resolved";
			},
			error => {
				outcome = "rejected";
				throw error;
			},
		);

		await drainMicrotasksUntil(
			() => vi.getTimerCount() > baselineTimers,
			"dynamic fetch timeout timer was not armed",
		);
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(14_999);
		await Promise.resolve();
		expect(outcome).toBeUndefined();
		vi.advanceTimersByTime(1);
		await refresh;
		expect(outcome).toBe("resolved");
		expect(registry.find("hanging-runtime-provider", "any-model")).toBeUndefined();
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
			// Adaptive ladders are wire-exact (no backfilled effortMap); only
			// requiresEffort is backfilled from identity.
			requiresEffort: true,
		});
	});

	test("registerProvider preserves a standalone Codex WebSocket opt-out across refresh", async () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://chatgpt.com/backend-api/codex",
			apiKey: "RUNTIME_KEY",
			api: "openai-codex-responses",
			models: [{ ...baseModel, id: "gpt-5.6-sol", preferWebsockets: false }],
		};

		registry.registerProvider("runtime-codex", config, "ext://runtime");
		expect(registry.find("runtime-codex", "gpt-5.6-sol")?.preferWebsockets).toBe(false);

		await registry.refresh("offline");
		expect(registry.find("runtime-codex", "gpt-5.6-sol")?.preferWebsockets).toBe(false);
	});

	test("registerProvider lets an extension disable WebSockets on a bundled Codex model", () => {
		const config: ProviderConfigInput = {
			baseUrl: "https://chatgpt.com/backend-api/codex",
			apiKey: "RUNTIME_KEY",
			api: "openai-codex-responses",
			models: [{ ...baseModel, id: "gpt-5.4", preferWebsockets: false }],
		};

		registry.registerProvider("openai-codex", config, "ext://runtime");

		expect(registry.find("openai-codex", "gpt-5.4")?.preferWebsockets).toBe(false);
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

	test("runtime-registered models inherit configured provider guardrails", () => {
		const providerName = "amazon-bedrock";
		const modelId = "runtime-bedrock-model";
		const guardrailIdentifier = "arn:aws:bedrock:eu-west-2:123456789012:guardrail/abcd1234";

		fs.writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						guardrailIdentifier,
						guardrailVersion: "1",
						guardrailTrace: "enabled",
					},
				},
			}),
		);
		const configuredRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });

		configuredRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				apiKey: "RUNTIME_KEY",
				api: "bedrock-converse-stream",
				models: [{ ...baseModel, id: modelId }],
			},
			"ext://runtime",
		);

		const model = configuredRegistry.find(providerName, modelId);
		expect(model?.guardrailIdentifier).toBe(guardrailIdentifier);
		expect(model?.guardrailVersion).toBe("1");
		expect(model?.guardrailTrace).toBe("enabled");
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

	test("oauth.modifyModels projection survives refresh and refreshProvider", async () => {
		await authStorage.set("projecting-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Mirrors a credential-aware provider: the registered `models` array is a
		// pre-discovery bootstrap, and modifyModels swaps in the catalog the
		// account actually has.
		const config: ProviderConfigInput = {
			api: "custom-projection-api",
			baseUrl: "https://example.invalid/",
			streamSimple,
			models: [baseModel],
			oauth: {
				name: "Projecting OAuth",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== "projecting-provider"),
					{
						...(models.find(model => model.provider === "projecting-provider") as Model<Api>),
						id: "projected-model",
						name: "Projected Model",
					},
				],
			},
		};

		registry.registerProvider("projecting-provider", config, "ext://oauth");

		const projectedIds = () => getProviderModels(registry, "projecting-provider").map(model => model.id);
		expect(projectedIds()).toEqual(["projected-model"]);

		// The model selector reloads the registry offline every time it opens; the
		// projection must not fall back to the bootstrap `models` array.
		await registry.refresh("offline");
		expect(projectedIds()).toEqual(["projected-model"]);

		await registry.refreshProvider("projecting-provider", "offline");
		expect(projectedIds()).toEqual(["projected-model"]);

		registry.clearSourceRegistrations("ext://oauth");
		expect(getProviderModels(registry, "projecting-provider")).toEqual([]);
	});

	test("a throwing modifyModels degrades to the unprojected catalog", async () => {
		await authStorage.set("throwing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		registry.registerProvider(
			"throwing-provider",
			{
				api: "custom-throwing-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Throwing OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: () => {
						throw new Error("boom");
					},
				},
			},
			"ext://oauth",
		);

		expect(getProviderModels(registry, "throwing-provider").map(model => model.id)).toEqual(["runtime-model"]);
		await registry.refresh("offline");
		expect(getProviderModels(registry, "throwing-provider").map(model => model.id)).toEqual(["runtime-model"]);
		// A broken extension must not take the rest of the catalog down with it.
		expect(registry.getAll().some(model => model.provider === "anthropic")).toBe(true);
	});

	test("a throwing modifyModels logs once per distinct failure", async () => {
		await authStorage.set("noisy-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			registry.registerProvider(
				"noisy-provider",
				{
					api: "custom-noisy-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Noisy OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: () => {
							throw new Error("boom");
						},
					},
				},
				"ext://oauth",
			);

			const modifierWarnings = () =>
				warn.mock.calls.filter(([message]) => String(message).includes("extension model projection failed"));
			expect(modifierWarnings()).toHaveLength(1);
			expect(modifierWarnings()[0]?.[1]).toMatchObject({ provider: "noisy-provider", error: "boom" });

			// Same failure on every later recomposition must not spam the log.
			await registry.refresh("offline");
			expect(modifierWarnings()).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("a non-idempotent modifyModels does not compound across refreshes", async () => {
		await authStorage.set("appending-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Deliberately append-only: the hook never strips its own prior output, so
		// feeding it an already-projected list would duplicate on every rebuild.
		let projectionCount = 0;
		registry.registerProvider(
			"appending-provider",
			{
				api: "custom-appending-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Appending OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						const seed = models.find(model => model.provider === "appending-provider") as Model<Api>;
						return [...models, { ...seed, id: `extra-${projectionCount}` }];
					},
				},
			},
			"ext://oauth",
		);

		const ids = () => getProviderModels(registry, "appending-provider").map(model => model.id);
		expect(ids()).toEqual(["runtime-model", "extra-1"]);

		await registry.refresh("offline");
		expect(ids()).toHaveLength(2);

		await registry.refresh("online");
		expect(ids()).toHaveLength(2);
	});

	test("a non-idempotent modifyModels does not compound when another provider registers", async () => {
		// The SDK and CLI loaders drain pending registrations one at a time, so an
		// earlier provider's projection is still in #models when the next arrives.
		const registerAppending = async (providerName: string, apiId: string) => {
			await authStorage.set(providerName, {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			});
			let projectionCount = 0;
			registry.registerProvider(
				providerName,
				{
					api: apiId,
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: `${providerName} OAuth`,
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: models => {
							projectionCount += 1;
							const seed = models.find(model => model.provider === providerName) as Model<Api>;
							return [...models, { ...seed, id: `extra-${projectionCount}` }];
						},
					},
				},
				"ext://oauth",
			);
		};

		await registerAppending("appending-first", "custom-appending-first-api");
		expect(getProviderModels(registry, "appending-first").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registerAppending("appending-second", "custom-appending-second-api");
		// Catalog changes rerun whole-catalog hooks, but each run must start from
		// the unprojected snapshot rather than accumulating prior output.
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second").map(model => model.id)).toEqual([
			"runtime-model",
			"extra-1",
		]);

		await registry.refresh("offline");
		expect(getProviderModels(registry, "appending-first")).toHaveLength(2);
		expect(getProviderModels(registry, "appending-second")).toHaveLength(2);
	});

	test("provider-scoped lookups preserve whole-catalog modifyModels projections", async () => {
		const hiddenModel = registry.getAll().find(model => model.provider === "anthropic");
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== hiddenModel?.provider || model.id !== hiddenModel.id),
				},
			},
			"ext://oauth",
		);

		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		const refreshPromise = registry.refresh("offline");
		// While refresh is awaiting discovery, lookup takes the provider-scoped composition path.
		expect(registry.find(hiddenModel!.provider, hiddenModel!.id)).toBeUndefined();
		await refreshPromise;
		expect(
			registry.getAll().find(model => model.provider === hiddenModel!.provider && model.id === hiddenModel!.id),
		).toBeUndefined();
	});

	test("provider-scoped lookups do not intern other providers' transient projections", async () => {
		const anthropicId = registry.getAll().find(model => model.provider === "anthropic")?.id;
		await authStorage.set("changing-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		let projectionCount = 0;
		registry.registerProvider(
			"changing-provider",
			{
				api: "custom-changing-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Changing OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						projectionCount += 1;
						return models.map(model =>
							model.provider === "changing-provider"
								? { ...model, name: `projection-${projectionCount}` }
								: model,
						);
					},
				},
			},
			"ext://oauth",
		);

		const refreshPromise = registry.refresh("offline");
		expect(registry.find("anthropic", anthropicId!)).toBeDefined();
		expect(registry.find("changing-provider", "runtime-model")?.name).toBe("projection-3");
		await refreshPromise;
	});

	test("registering another provider reapplies whole-catalog modifyModels projections", async () => {
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => models.filter(model => model.provider !== "later-provider"),
				},
			},
			"ext://oauth",
		);

		registry.registerProvider(
			"later-provider",
			{
				api: "custom-later-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				apiKey: "RUNTIME_KEY",
				models: [baseModel],
			},
			"ext://runtime",
		);

		expect(getProviderModels(registry, "later-provider")).toEqual([]);
	});

	test("runtime transport overrides reapply whole-catalog modifyModels projections", async () => {
		const proxyBaseUrl = "https://proxy.example.invalid/v1";
		await authStorage.set("filtering-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"filtering-provider",
			{
				api: "custom-filtering-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Filtering OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.filter(model => model.provider !== "anthropic" || model.baseUrl !== proxyBaseUrl),
				},
			},
			"ext://oauth",
		);
		expect(getProviderModels(registry, "anthropic").length).toBeGreaterThan(0);

		registry.registerProvider("anthropic", { baseUrl: proxyBaseUrl }, "ext://runtime");

		expect(getProviderModels(registry, "anthropic")).toEqual([]);
	});

	test("online discovery reapplies modifiers to an unprojected full catalog", async () => {
		const target = registry.getAll().find(model => model.provider === "anthropic");
		await authStorage.set("renaming-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		registry.registerProvider(
			"renaming-provider",
			{
				api: "custom-renaming-api",
				baseUrl: "https://example.invalid/",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Renaming OAuth",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.map(model =>
							model.provider === target?.provider && model.id === target.id
								? { ...model, name: `${model.name} projected` }
								: model,
						),
				},
			},
			"ext://oauth",
		);
		registry.registerProvider(
			"dynamic-provider",
			{
				api: "custom-dynamic-api",
				baseUrl: "https://example.invalid/",
				apiKey: "RUNTIME_KEY",
				streamSimple,
				fetchDynamicModels: async () => [{ ...baseModel, id: "dynamic-model" }],
			},
			"ext://runtime",
		);

		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(target!.provider, target!.id)?.name).toBe(`${target!.name} projected`);
	});

	test("a modifyModels that mutates in place then throws cannot corrupt the catalog", async () => {
		await authStorage.set("mutating-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		try {
			const targetBefore = registry.getAll()[0];
			const targetSnapshot = structuredClone(targetBefore!);
			const anthropicBefore = registry.getAll().filter(model => model.provider === "anthropic").length;
			expect(anthropicBefore).toBeGreaterThan(0);

			registry.registerProvider(
				"mutating-provider",
				{
					api: "custom-mutating-api",
					baseUrl: "https://example.invalid/",
					streamSimple,
					models: [baseModel],
					oauth: {
						name: "Mutating OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						// Corrupts a model record and its nested cost, wipes the array,
						// then fails. None of those mutations may reach the canonical
						// unprojected catalog used for fallback or later refreshes.
						modifyModels: models => {
							models[0]!.name = "Corrupted by failing hook";
							models[0]!.cost.input = -1;
							models.length = 0;
							throw new Error("mutated then failed");
						},
					},
				},
				"ext://oauth",
			);

			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "anthropic")).toHaveLength(anthropicBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);

			await registry.refresh("offline");
			expect(registry.find(targetBefore!.provider, targetBefore!.id)).toEqual(targetSnapshot);
			expect(registry.getAll().filter(model => model.provider === "anthropic")).toHaveLength(anthropicBefore);
			expect(getProviderModels(registry, "mutating-provider").map(model => model.id)).toEqual(["runtime-model"]);
		} finally {
			warn.mockRestore();
		}
	});
});
