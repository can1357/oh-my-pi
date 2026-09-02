import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions as buildCliSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;
	let fixtureDir: string;
	let fixtureAuthStorage: AuthStorage;
	let fixtureModelRegistry: ModelRegistry;
	const authStoragesToClose: AuthStorage[] = [];

	beforeAll(() => {
		fixtureDir = path.join(os.tmpdir(), `pi-sdk-model-selection-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		fixtureAuthStorage = createInMemoryAuthStorage();
		fixtureModelRegistry = new ModelRegistry(fixtureAuthStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		fixtureAuthStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
				{
					id: "runtime-fallback-model",
					name: "Runtime Fallback Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	const dynamicOnlyProviderConfig: ProviderConfigInput = {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "RUNTIME_KEY",
		api: "openai-completions",
		fetchDynamicModels: async () => [
			{
				id: "cached-runtime-model",
				name: "Cached Runtime Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	};

	const dynamicOnlyProviderExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", dynamicOnlyProviderConfig);
	};

	function buildSessionOptions(modelPattern: string | string[]) {
		// Reuse one empty registry across these model-only cases. Opening a fresh
		// AuthStorage runs the full SQLite schema setup, while every session here
		// registers and removes the same inline provider on its own lifecycle.
		const authStorage = fixtureAuthStorage;
		const modelRegistry = fixtureModelRegistry;
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern,
		};
	}

	test("resolves explicit modelPattern after extension providers register", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("runtime-provider/runtime-model"),
		);

		try {
			expect(session.model).toBeDefined();
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves explicit dynamic-only modelPattern from fresh runtime cache", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, "models.yml");
		const primerRegistry = new ModelRegistry(authStorage, modelsPath);
		primerRegistry.registerProvider("runtime-provider", dynamicOnlyProviderConfig, "ext://runtime");
		await primerRegistry.refreshRuntimeProviders("online");
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [dynamicOnlyProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "runtime-provider/cached-runtime-model",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("cached-runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("defers online runtime discovery until the UI starts it after first paint", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("missing bundled startup model");
		let fetches = 0;
		const extension: ExtensionFactory = pi => {
			pi.registerProvider("deferred-runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches += 1;
					return [
						{
							id: "deferred-runtime-model",
							name: "Deferred Runtime Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8192,
						},
					];
				},
			});
		};

		const result = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			model,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			hasUI: true,
		});

		try {
			expect(fetches).toBe(0);
			expect(result.startBackgroundModelDiscovery).toBeDefined();
			await result.startBackgroundModelDiscovery?.();
			expect(fetches).toBe(1);
			expect(modelRegistry.find("deferred-runtime-provider", "deferred-runtime-model")).toBeDefined();
		} finally {
			await result.session.dispose();
		}
	});

	test("preserves an explicit model when a reused registry already finished discovery", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		modelRegistry.refreshInBackground("offline");
		await modelRegistry.awaitInitialBackgroundRefresh();

		const catalogModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!catalogModel) throw new Error("missing bundled registry model");
		const explicitModel = buildModel({
			id: catalogModel.id,
			name: "Explicit Claude endpoint",
			api: catalogModel.api,
			provider: catalogModel.provider,
			baseUrl: "https://explicit-sdk-endpoint.example/v1",
			reasoning: catalogModel.reasoning,
			input: [...catalogModel.input],
			cost: catalogModel.cost,
			contextWindow: 321_000,
			maxTokens: 12_345,
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			model: explicitModel,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			// Flush a reconciler armed against the already-settled refresh; an
			// incorrect explicit-model opt-in would replace the model here.
			await Promise.resolve();
			expect(session.model?.baseUrl).toBe("https://explicit-sdk-endpoint.example/v1");
			expect(session.model?.contextWindow).toBe(321_000);
			expect(session.model?.maxTokens).toBe(12_345);
		} finally {
			await session.dispose();
		}
	});

	test("hydrates credential-scoped model caches before fallback validation", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const providers = [
			{ id: "opencode-go", apiKey: "go-test-key", baseUrl: "https://opencode.ai/zen/go/v1" },
			{ id: "opencode-zen", apiKey: "zen-test-key", baseUrl: "https://opencode.ai/zen/v1" },
			{ id: "github-copilot", apiKey: "copilot-test-key", baseUrl: "https://api.githubcopilot.com" },
		];
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelsPath = path.join(tempDir, "models.yml");
		const fallbackSelectors: string[] = [];
		for (const provider of providers) {
			authStorage.setRuntimeApiKey(provider.id, provider.apiKey);
			const cachedModel = buildModel({
				id: "discovered-only-model",
				name: "Discovered Only Model",
				api: "openai-responses",
				provider: provider.id,
				baseUrl: provider.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			});
			writeModelCache(
				resolveModelCacheProviderId(provider.id, { apiKey: provider.apiKey }),
				Date.now(),
				[cachedModel],
				true,
				"",
				path.join(tempDir, "models.db"),
			);
			fallbackSelectors.push(`${provider.id}/${cachedModel.id}`);
		}
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const settings = Settings.isolated({
			"retry.fallbackChains": { default: fallbackSelectors },
		});

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "openai/gpt-4o-mini",
		});

		try {
			expect(session.configWarnings.filter(warning => warning.includes("discovered-only-model"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	});

	test("rehydrates credential-scoped caches after credentials change", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const provider = "opencode-go";
		const baseUrl = "https://opencode.ai/zen/go/v1";
		const cacheDbPath = path.join(tempDir, "models.db");
		const firstModel = buildModel({
			id: "first-credential-model",
			name: "First Credential Model",
			api: "openai-responses",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		authStorage.setRuntimeApiKey(provider, "first-key");
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey: "first-key" }),
			Date.now(),
			[firstModel],
			true,
			"",
			cacheDbPath,
		);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		await modelRegistry.hydrateCredentialScopedModelCaches();
		expect(modelRegistry.find(provider, firstModel.id)).toBeDefined();

		const secondModel = buildModel({
			...firstModel,
			id: "second-credential-model",
			name: "Second Credential Model",
		});
		authStorage.setRuntimeApiKey(provider, "second-key");
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey: "second-key" }),
			Date.now(),
			[secondModel],
			true,
			"",
			cacheDbPath,
		);

		await modelRegistry.hydrateCredentialScopedModelCaches();
		expect(modelRegistry.find(provider, secondModel.id)).toBeDefined();
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			buildSessionOptions("missing-provider/missing-model"),
		);

		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toBe('Model "missing-provider/missing-model" not found');
		} finally {
			await session.dispose();
		}
	});

	test("uses auth fallback when deferred subagent modelPattern resolves without working credentials", async () => {
		const parentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!parentModel) {
			throw new Error("Expected bundled anthropic parent model");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(parentModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "fallback-models.yml"));
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async requested => {
			if (requested.provider === "runtime-provider") return undefined;
			if (requested.provider === parentModel.provider) return "test-key";
			return undefined;
		});
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "runtime-provider/runtime-model",
			modelPatternAuthFallback: `${parentModel.provider}/${parentModel.id}`,
		});

		try {
			expect(session.model?.provider).toBe(parentModel.provider);
			expect(session.model?.id).toBe(parentModel.id);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
			getApiKeySpy.mockRestore();
		}
	});

	test("resolves deferred role-alias modelPattern after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", "runtime-provider/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("@smol"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred bare configured role names after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("task"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("resolves deferred suffixed bare configured roles after extension providers register", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-fallback-model");
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-models.yml"));
		const parsed = parseArgs(["--model", "task:high"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("task:high");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-fallback-model");
				expect(session.thinkingLevel).toBe(Effort.High);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("defers bare role chains when an earlier candidate may be registered by extensions", async () => {
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!fallbackModel) {
			throw new Error("Expected bundled anthropic fallback model");
		}
		const settings = Settings.isolated();
		settings.setModelRole("task", `runtime-provider/runtime-model,${fallbackModel.provider}/${fallbackModel.id}`);
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "role-chain-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-model");
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("prefers authenticated providers for deferred bare role candidates", async () => {
		const settings = Settings.isolated({
			modelProviderOrder: ["aimlapi", "openai"],
		});
		settings.setModelRole("task", "missing-provider/missing-model,gpt-4o-mini");
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "ambiguous-role-models.yml"));
		const parsed = parseArgs(["--model", "task"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.model).toBeUndefined();
			expect(cliOptions.modelPattern).toBe("task");

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("openai");
				expect(session.model?.id).toBe("gpt-4o-mini");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("uses a configured suffixed role fallback when its primary model is unavailable", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				slow: ["missing-provider/missing-fallback", "runtime-provider/runtime-fallback-model"],
			},
		});
		settings.setModelRole("slow", "missing-provider/missing-model");
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("runtime-provider", "test-key");
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "missing-role-models.yml"));
		const parsed = parseArgs(["--model", "slow:low"]);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parsed,
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(cliOptions.modelPattern).toBe("slow:low");

			const { session, modelFallbackMessage } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-fallback-model");
				// `low` differs from the fallback model's default (`high`), so this
				// proves the suffix is inherited rather than the model default applied.
				expect(session.thinkingLevel).toBe(Effort.Low);
				expect(modelFallbackMessage).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("preserves deferred bare role fallback chains", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-fallback-model");

		const { session, modelFallbackMessage } = await createAgentSession({
			...buildSessionOptions("task"),
			modelPatternFallbackRole: "subagent:deferred",
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-fallback-model",
			]);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("skips a depleted coding-plan model before creating a noninteractive subagent session", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-fallback-model");
		const options = buildSessionOptions("task");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware",
			settings,
			hasUI: false,
		});
		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-fallback-model");
		} finally {
			await session.dispose();
		}
	});

	test("rejects a depleted terminal fallback after startup skips the primary", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-fallback-model");
		const options = buildSessionOptions("task");
		const usageHealth = vi.spyOn(options.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "depleted",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }],
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware-terminal",
			settings,
			hasUI: false,
		});
		try {
			expect(usageHealth).toHaveBeenCalledTimes(2);
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toContain("not found");
		} finally {
			await session.dispose();
		}
	});

	test("defers ACP reserve fallback until prompt-time capabilities are configured", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "runtime-provider/runtime-model,runtime-provider/runtime-fallback-model");
		const options = buildSessionOptions("task");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockImplementation(async (_provider, healthOptions) =>
			healthOptions.modelId === "runtime-model"
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const { session } = await createAgentSession({
			...options,
			modelPatternFallbackRole: "subagent:usage-aware-acp",
			settings,
			hasUI: false,
			deferUsageReserveConfirmation: true,
		});
		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("enforces fail-closed reserve policy without requiring a fallback candidate", async () => {
		const settings = Settings.isolated({
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		const options = buildSessionOptions("runtime-provider/runtime-model");
		vi.spyOn(options.authStorage, "getModelUsageHealth").mockResolvedValue({
			state: "reserve",
			accounts: [{ credentialId: 1, credentialType: "oauth", state: "reserve", remainingFraction: 0.05 }],
		});

		await expect(
			createAgentSession({
				...options,
				settings,
				hasUI: false,
			}),
		).rejects.toThrow("reserve policy is fail-closed");
	});

	test("installs fallback chain for remaining deferred subagent modelPattern candidates", async () => {
		const { session } = await createAgentSession({
			...buildSessionOptions(["runtime-provider/runtime-model", "runtime-provider/runtime-fallback-model"]),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("installs an inherited fallback chain for a deferred singleton modelPattern", async () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["runtime-provider/runtime-fallback-model"],
			},
		});
		settings.setModelRole("default", "runtime-provider/runtime-fallback-model");
		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-model"),
			settings,
			modelPatternFallbackRole: "subagent:deferred-default",
			modelPatternDefaultFallbackChain: ["runtime-provider/runtime-fallback-model"],
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred-default")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred-default"]).toEqual([
				"runtime-provider/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("splits deferred comma-delimited modelPattern and installs fallback chain", async () => {
		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-model,runtime-provider/runtime-fallback-model"),
			modelPatternFallbackRole: "subagent:deferred",
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
			expect(session.settings.getModelRole("subagent:deferred")).toBe("runtime-provider/runtime-model");
			expect(session.settings.get("retry.fallbackChains")["subagent:deferred"]).toEqual([
				"runtime-provider/runtime-fallback-model",
			]);
		} finally {
			await session.dispose();
		}
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "off" });
		settings.setModelRole("smol", "runtime-provider/runtime-fallback-model");
		settings.setModelRole("default", "@smol:high");

		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-fallback-model"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-fallback-model");
			expect(session.thinkingLevel).toBe("off");
		} finally {
			await session.dispose();
		}
	});

	test("clamps a max default thinking level to the model's ladder ceiling", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "max" });

		const { session } = await createAgentSession({
			...buildSessionOptions("runtime-provider/runtime-fallback-model"),
			settings,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-fallback-model");
			// The extension model has no explicit ladder; the inferred fallback tops
			// out at xhigh, so the real max level clamps down.
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
		}
	});

	test("selects the settings default model without synchronously validating auth", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("settings default model should not validate auth during startup"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe(defaultModel.provider);
				expect(session.model?.id).toBe(defaultModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
			authStorage.close();
		}
	});

	test("refreshes cached llama.cpp vision metadata for the startup default model", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelsPath = path.join(tempDir, "llama-vision-models.yml");
		const cacheDbPath = path.join(tempDir, "models.db");
		const cachedModel = buildModel({
			id: "vision-model",
			name: "vision-model",
			provider: "llama.cpp",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:8080",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32768,
		});
		writeModelCache("llama.cpp", Date.now(), [cachedModel], true, "", cacheDbPath);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({ data: [{ id: "vision-model", object: "model", meta: { n_ctx: 239104 } }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 239104,
							params: { max_tokens: -1, n_predict: -1 },
						},
						modalities: { vision: true },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });
		const settings = Settings.isolated();
		settings.setModelRole("default", "llama.cpp/vision-model");

		expect(modelRegistry.find("llama.cpp", "vision-model")?.input).toEqual(["text"]);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.input).toEqual(["text", "image"]);
			expect(modelRegistry.find("llama.cpp", "vision-model")?.input).toEqual(["text", "image"]);
		} finally {
			await session.dispose();
		}
	});

	test("restores the saved session model without resolving auth over the network", async () => {
		// Regression: `restoreSessionModel` probed each saved-model candidate with
		// the async `getApiKey`, which refreshes OAuth tokens and hits the auth
		// broker. When the broker was unreachable that blocked resume for the full
		// ~10s refresh timeout — the "Still starting … restoreSessionModel" hang.
		// Selection now uses the synchronous, side-effect-free `hasConfiguredAuth`
		// probe; the real key is resolved lazily per request via the resolver.
		const savedModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!savedModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(savedModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-saved-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-saved", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${savedModel.provider}/${savedModel.id}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "resume-saved-sessions"));

		// A rejecting getApiKey stands in for the unreachable broker / hanging
		// OAuth refresh: if startup awaits it to pick the restore model, it surfaces.
		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("startup model restore must not resolve auth over the network"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				sessionManager,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				expect(session.model?.provider).toBe(savedModel.provider);
				expect(session.model?.id).toBe(savedModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
		}
	});

	test("restores a discovery-backed session model instead of falling back to the default role", async () => {
		// Regression: on `omp --resume`, the session-model restore probed
		// candidates only against the static+cached catalog. A discovery-backed
		// provider (models.yml `discovery:`) hasn't been fetched at that point, so
		// the saved model failed to resolve and resume silently downgraded to
		// modelRoles.default. The restore path now triggers a cache-aware
		// discovery refresh when a saved candidate belongs to a discoverable
		// provider.
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// A resolvable default role gives the buggy path a concrete model to wrongly
		// fall back to (mirrors a real config with Claude as the default role).
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");

		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "http://127.0.0.1:9994",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
					// An unrelated discovery provider: the saved model does not belong
					// to it, so the scoped resume refresh must never fetch its endpoint.
					"other-gateway": {
						baseUrl: "http://127.0.0.1:9993",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);

		let modelListCalls = 0;
		let otherListCalls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9994/v1/models") {
				modelListCalls++;
				return Response.json({ data: [{ id: "dynamic-model", context_length: 65_536 }] });
			}
			if (url === "http://127.0.0.1:9993/v1/models") {
				otherListCalls++;
				return Response.json({ data: [{ id: "other-model", context_length: 65_536 }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });

		const targetSessionFile = path.join(tempDir, "resume-discovery-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-discovery", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "dynamic-model-change",
					parentId: null,
					timestamp,
					model: "gateway/dynamic-model",
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(
			targetSessionFile,
			path.join(tempDir, "resume-discovery-sessions"),
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ modelRoles: { default: `${defaultModel.provider}/${defaultModel.id}` } }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(modelListCalls).toBeGreaterThan(0);
			expect(otherListCalls).toBe(0);
			expect(session.model?.provider).toBe("gateway");
			expect(session.model?.id).toBe("dynamic-model");
		} finally {
			await session.dispose();
		}
	});

	test("prefers the provider default over catalog order in the startup fallback", async () => {
		// Regression: with an Anthropic key but no configured `default` role and no
		// session/CLI model, the step-4 startup fallback used to pick the first
		// anthropic model in models.json catalog order (claude-3-5-sonnet-20240620)
		// instead of the provider's configured default from DEFAULT_MODEL_PER_PROVIDER
		// (claude-opus-4-8).
		const providerDefault = getBundledModel("anthropic", "claude-opus-4-8");
		const catalogFirst = getBundledModel("anthropic", "claude-3-5-sonnet-20240620");
		if (!providerDefault || !catalogFirst) {
			throw new Error("Expected bundled anthropic models for fallback regression");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		// No `default` model role configured: forces the step-4 startup fallback.
		const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(providerDefault.id);
			expect(session.model?.id).not.toBe(catalogFirst.id);
		} finally {
			await session.dispose();
		}
	});

	test("prefers Codex OAuth over plain OpenAI for the shared startup default", async () => {
		const openaiDefault = getBundledModel("openai", "gpt-5.5");
		const codexDefault = getBundledModel("openai-codex", "gpt-5.5");
		if (!openaiDefault || !codexDefault) {
			throw new Error("Expected bundled OpenAI and Codex GPT-5.5 defaults");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "sk-or-v1-invalid-openai-key");
		authStorage.setRuntimeApiKey("openai-codex", "codex-oauth-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ enabledModels: ["openai/gpt-5.5", "openai-codex/gpt-5.5"] }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe(codexDefault.id);
			expect(session.model?.id).toBe(openaiDefault.id);
		} finally {
			await session.dispose();
		}
	});

	test("caps premium Codex context before a new session starts", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", "codex-oauth-token");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settings: Settings.isolated({ extendedContext: false }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "openai-codex/gpt-5.6-sol",
		});

		try {
			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.model?.contextWindow).toBe(272_000);
		} finally {
			await session.dispose();
		}
	});

	test("loads model overrides from the supplied agent directory", async () => {
		await Bun.write(
			path.join(tempDir, "models.yml"),
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextWindow: 123456",
			].join("\n"),
		);
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", "codex-oauth-token");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			settings: Settings.isolated({ extendedContext: true }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "openai-codex/gpt-5.6-sol",
		});

		try {
			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe("gpt-5.6-sol");
			expect(session.model?.contextWindow).toBe(123_456);
		} finally {
			await session.dispose();
		}
	});

	test("restores role model max selector from extension provider after startup resume", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-extension.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${defaultModel.provider}/${defaultModel.id}`,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-fallback-model:max",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-fallback-model");
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("restores extension role model when saved default cannot be restored before extensions load", async () => {
		const settingsDefaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!settingsDefaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey(settingsDefaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Saved default points at a provider that has no usable credentials. The
		// last active role (`smol`) is supplied by the inline extension and is
		// only resolvable once provider registrations are processed.
		const targetSessionFile = path.join(tempDir, "resume-extension-default-missing.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext-no-default", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "anthropic/not-available",
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-model",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions-no-default"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${settingsDefaultModel.provider}/${settingsDefaultModel.id}`);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("resolves the default role to an extension model in enabledModels instead of silently substituting an in-scope provider (issue #6694)", async () => {
		const configuredModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!configuredModel) {
			throw new Error("Expected bundled anthropic configured model");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// The extension provider carries an inline apiKey; the "normally
		// configured" provider needs credentials so it lands in the startup scope.
		authStorage.setRuntimeApiKey(configuredModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "scope-6694-models.yml"));

		const enabledModels = ["runtime-provider/runtime-model", `${configuredModel.provider}/${configuredModel.id}`];
		const settings = Settings.isolated({ enabledModels });
		settings.setModelRole("default", "runtime-provider/runtime-model");

		// main.ts resolves the model scope BEFORE extensions register providers,
		// so the extension-registered model is dropped and only the configured
		// provider survives into the startup scope.
		const scopedModels = await resolveModelScope(
			enabledModels,
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${configuredModel.provider}/${configuredModel.id}`,
		]);

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});
		try {
			const cliOptions = await buildCliSessionOptions(
				parseArgs([]),
				scopedModels,
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);

			const { session } = await createAgentSession({
				...cliOptions,
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read"],
			});

			try {
				// The configured default role names the extension model, which is
				// itself listed in enabledModels. Once extensions register their
				// providers it must win — not be silently replaced by the other
				// in-scope provider's model.
				expect(session.model?.provider).toBe("runtime-provider");
				expect(session.model?.id).toBe("runtime-model");
			} finally {
				await session.dispose();
			}
		} finally {
			exitSpy.mockRestore();
		}
	});
	test("pins the first CLI --models scoped model even when the saved default role is out of scope", async () => {
		const scopedTarget = getBundledModel("openai", "gpt-4o-mini");
		const savedDefault = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!scopedTarget || !savedDefault) {
			throw new Error("Expected bundled openai and anthropic models");
		}
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(scopedTarget.provider, "test-key");
		authStorage.setRuntimeApiKey(savedDefault.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "cli-scope-models.yml"));
		const settings = Settings.isolated({});
		settings.setModelRole("default", `${savedDefault.provider}/${savedDefault.id}`);

		const parsed = parseArgs(["--models", `${scopedTarget.provider}/${scopedTarget.id}`]);
		const scopedModels = await resolveModelScope(
			parsed.models ?? [],
			modelRegistry,
			getModelMatchPreferences(settings),
			settings,
		);
		expect(scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${scopedTarget.provider}/${scopedTarget.id}`,
		]);

		const cliOptions = await buildCliSessionOptions(
			parsed,
			scopedModels,
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);
		// The issue #6694 deferral must NOT apply to an explicit CLI scope:
		// createAgentSession re-resolves the default role against
		// `settings.enabledModels` only and never sees `--models`, so leaving
		// `options.model` unset would let the saved out-of-scope default
		// silently escape the scope the user just asked for.
		expect(cliOptions.model?.provider).toBe(scopedTarget.provider);
		expect(cliOptions.model?.id).toBe(scopedTarget.id);
	});
});
