import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, Effort, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId, resolveOllamaModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import {
	applyLlamaCppQwenThinking,
	discoverOllamaModels,
	discoveryProbeTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/config/model-discovery";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ProviderDiscoverySchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	resolveGitHubCopilotAccountIdentities,
	resolveGitHubCopilotDiscoveryAccounts,
} from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let originalOllamaBaseUrl: string | undefined;
	let originalOllamaHost: string | undefined;
	let originalOllamaContextLength: string | undefined;
	let originalAnthropicApiKey: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalOllamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
		originalOllamaHost = Bun.env.OLLAMA_HOST;
		originalOllamaContextLength = Bun.env.OLLAMA_CONTEXT_LENGTH;
		originalAnthropicApiKey = Bun.env.ANTHROPIC_API_KEY;
		delete Bun.env.OLLAMA_BASE_URL;
		delete Bun.env.OLLAMA_HOST;
		delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		delete Bun.env.ANTHROPIC_API_KEY;
		tempDir = path.join(os.tmpdir(), `pi-test-model-registry-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		cacheDbPath = path.join(tempDir, "models.db");
		// In-memory auth DB: tests need a fresh, isolated credential store per case but
		// never reopen it from disk, so :memory: avoids the WAL/chmod disk-open cost
		// (~3ms/test) while preserving per-test isolation.
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetSettingsForTest();
		if (originalOllamaBaseUrl === undefined) {
			delete Bun.env.OLLAMA_BASE_URL;
		} else {
			Bun.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
		}
		if (originalOllamaHost === undefined) {
			delete Bun.env.OLLAMA_HOST;
		} else {
			Bun.env.OLLAMA_HOST = originalOllamaHost;
		}
		if (originalOllamaContextLength === undefined) {
			delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		} else {
			Bun.env.OLLAMA_CONTEXT_LENGTH = originalOllamaContextLength;
		}
		if (originalAnthropicApiKey === undefined) {
			delete Bun.env.ANTHROPIC_API_KEY;
		} else {
			Bun.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
		}
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function writeCachedOllamaModels(models: Model<"openai-completions">[], updatedAt = Date.now()) {
		writeModelCache(resolveOllamaModelCacheProviderId("ollama"), updatedAt, models, true, "", cacheDbPath);
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function withEnv(
		name: "LLAMA_CPP_BASE_URL" | "LM_STUDIO_BASE_URL" | "OLLAMA_BASE_URL" | "OLLAMA_CONTEXT_LENGTH" | "OLLAMA_HOST",
		value: string | undefined,
	) {
		const original = Bun.env[name];
		if (value === undefined) {
			delete Bun.env[name];
		} else {
			Bun.env[name] = value;
		}
		return {
			[Symbol.dispose]() {
				if (original === undefined) {
					delete Bun.env[name];
				} else {
					Bun.env[name] = original;
				}
			},
		};
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function mockOllamaDiscovery(
		modelNames: string[],
		endpoint = "http://127.0.0.1:11434",
		showPayload: Record<string, unknown> = { capabilities: ["completion"] },
	): FetchImpl {
		return async input => {
			const url = String(input);
			if (url === `${endpoint}/api/tags`) {
				return new Response(JSON.stringify({ models: modelNames.map(name => ({ name })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === `${endpoint}/api/show`) {
				return new Response(JSON.stringify(showPayload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	}

	async function useAuthStorageWithRefreshTracker() {
		authStorage.close();
		const refreshCalls: string[] = [];
		authStorage = await AuthStorage.create(":memory:", {
			refreshOAuthCredential: async (provider, _credentialId, credential): Promise<OAuthCredentials> => {
				refreshCalls.push(provider);
				return {
					...credential,
					access: provider === "anthropic" ? "sk-ant-oat-fresh-anthropic" : `fresh-${provider}`,
					expires: Date.now() + 3_600_000,
				};
			},
		});
		return { refreshCalls };
	}

	type AnthropicDiscoveryCapture = {
		modelListAuthorization?: string | null;
		modelListXApiKey?: string | null;
		modelListCalls: number;
	};

	function mockAnthropicModelsDiscovery(capture: AnthropicDiscoveryCapture): FetchImpl {
		const endpointPrefix = "https://api.anthropic.com/";
		return async (input, init) => {
			const url = String(input);
			if (url === "https://catalog.stencil.so/models.json.zstd") {
				return Response.json({});
			}
			if (url.startsWith(endpointPrefix) && url.endsWith("/models")) {
				const headers = new Headers(init?.headers);
				capture.modelListAuthorization = headers.get("authorization");
				capture.modelListXApiKey = headers.get("x-api-key");
				capture.modelListCalls++;
				return Response.json({
					data: [{ id: "claude-regression-4893", display_name: "Claude Regression 4893" }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	}

	type GeminiCliDiscoveryCapture = {
		loadCodeAssistCalls: number;
		urls: string[];
		quotaAuthorization?: string | null;
		quotaBody?: unknown;
	};

	function mockGeminiCliStandardDiscovery(capture: GeminiCliDiscoveryCapture): FetchImpl {
		return async (input, init) => {
			const url = String(input);
			capture.urls.push(url);
			if (url.includes("/manifest/latest-arm64-mac.yml")) {
				return new Response("", { status: 404 });
			}
			if (url.includes(":fetchAvailableModels")) {
				return new Response("Forbidden", { status: 403 });
			}
			if (url.includes(":loadCodeAssist")) {
				capture.loadCodeAssistCalls++;
				return new Response("Forbidden", { status: 403 });
			}
			if (url.includes(":retrieveUserQuota")) {
				capture.quotaAuthorization = new Headers(init?.headers).get("authorization");
				capture.quotaBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				return Response.json({ buckets: [{ modelId: "gemini-3.5-flash" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
	}

	test("scoped discovery coalesces with an in-flight background refresh", async () => {
		writeRawModelsJson({
			gateway: {
				baseUrl: "http://127.0.0.1:9992",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const { promise, resolve } = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		let modelListCalls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9992/v1/models") {
				modelListCalls++;
				started.resolve();
				return promise;
			}
			return new Response("", { status: 404 });
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		registry.refreshInBackground();
		await started.promise;
		expect(modelListCalls).toBe(1);

		const scopedRefresh = registry.refreshDiscoverableProviders(["gateway"], "online-if-uncached");
		expect(modelListCalls).toBe(1);

		resolve(Response.json({ data: [{ id: "dynamic-model", context_length: 65_536 }] }));
		await Promise.all([scopedRefresh, registry.awaitBackgroundRefresh()]);

		expect(modelListCalls).toBe(1);
		expect(registry.find("gateway", "dynamic-model")).toBeDefined();
	});

	test("does not coalesce or apply discovery across provider config changes", async () => {
		writeRawModelsJson({
			gateway: {
				baseUrl: "http://127.0.0.1:9992",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const oldResponse = Promise.withResolvers<Response>();
		const oldStarted = Promise.withResolvers<void>();
		let newModelListCalls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9992/v1/models") {
				oldStarted.resolve();
				return oldResponse.promise;
			}
			if (url === "http://127.0.0.1:9991/v1/models") {
				newModelListCalls++;
				return Response.json({ data: [{ id: "new-model", context_length: 65_536 }] });
			}
			return new Response("", { status: 404 });
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		registry.refreshInBackground();
		await oldStarted.promise;

		const previousMtime = fs.statSync(modelsJsonPath).mtimeMs;
		writeRawModelsJson({
			gateway: {
				baseUrl: "http://127.0.0.1:9991",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const changedTime = new Date(previousMtime + 1_000);
		fs.utimesSync(modelsJsonPath, changedTime, changedTime);
		const refreshed = registry.refresh("online-if-uncached");
		oldResponse.resolve(Response.json({ data: [{ id: "old-model", context_length: 65_536 }] }));
		await Promise.all([refreshed, registry.awaitBackgroundRefresh()]);

		expect(newModelListCalls).toBe(1);
		expect(registry.find("gateway", "new-model")).toBeDefined();
		expect(registry.find("gateway", "old-model")).toBeUndefined();
	});

	test("refreshProvider online refreshes expired anthropic OAuth before model discovery", async () => {
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat-expired-anthropic",
			refresh: "refresh-anthropic",
			expires: Date.now() - 60_000,
		});
		const capture: AnthropicDiscoveryCapture = { modelListCalls: 0 };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockAnthropicModelsDiscovery(capture),
		});

		await registry.refreshProvider("anthropic", "online");

		expect(refreshCalls).toEqual(["anthropic"]);
		expect(capture.modelListCalls).toBe(1);
		expect(capture.modelListAuthorization).toBe("Bearer sk-ant-oat-fresh-anthropic");
		expect(capture.modelListXApiKey).toBeNull();
		expect(registry.find("anthropic", "claude-regression-4893")).toBeDefined();
	});

	test("refreshProvider online does not refresh unrelated expired OAuth credentials", async () => {
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat-expired-anthropic",
			refresh: "refresh-anthropic",
			expires: Date.now() - 60_000,
		});
		await authStorage.set("openai", {
			type: "oauth",
			access: "expired-openai",
			refresh: "refresh-openai",
			expires: Date.now() - 60_000,
		});
		const capture: AnthropicDiscoveryCapture = { modelListCalls: 0 };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockAnthropicModelsDiscovery(capture),
		});

		await registry.refreshProvider("anthropic", "online");

		expect(refreshCalls).toEqual(["anthropic"]);
		expect(authStorage.getOAuthCredential("openai")?.access).toBe("expired-openai");
		expect(capture.modelListCalls).toBe(1);
	});

	test("refreshProvider offline does not touch expired OAuth credentials", async () => {
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat-expired-anthropic",
			refresh: "refresh-anthropic",
			expires: Date.now() - 60_000,
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async input => {
				throw new Error(`Offline discovery should not fetch ${String(input)}`);
			},
		});

		await registry.refreshProvider("anthropic", "offline");

		expect(refreshCalls).toEqual([]);
		expect(authStorage.getOAuthCredential("anthropic")?.access).toBe("sk-ant-oat-expired-anthropic");
	});
	test("online-if-uncached refreshes expired OAuth when the discovery cache is stale for the model manager", async () => {
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat-expired-anthropic",
			refresh: "refresh-anthropic",
			expires: Date.now() - 60_000,
		});
		// Older than the model manager's 2h default TTL: the manager WILL fetch,
		// so the preflight must mint a fresh bearer first.
		writeModelCache("anthropic", Date.now() - 3 * 60 * 60 * 1000, [], true, "", cacheDbPath);
		const capture: AnthropicDiscoveryCapture = { modelListCalls: 0 };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockAnthropicModelsDiscovery(capture),
		});

		await registry.refreshProvider("anthropic", "online-if-uncached");

		expect(refreshCalls).toEqual(["anthropic"]);
		expect(capture.modelListCalls).toBe(1);
		expect(capture.modelListAuthorization).toBe("Bearer sk-ant-oat-fresh-anthropic");
	});

	test("online-if-uncached leaves expired OAuth untouched when the discovery cache is fresh", async () => {
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("anthropic", {
			type: "oauth",
			access: "sk-ant-oat-expired-anthropic",
			refresh: "refresh-anthropic",
			expires: Date.now() - 60_000,
		});
		// Fresh authoritative cache: the manager will not fetch, so opening a
		// cached model selector must not rotate (or risk disabling) credentials.
		writeModelCache("anthropic", Date.now() - 60_000, [], true, "", cacheDbPath);
		const capture: AnthropicDiscoveryCapture = { modelListCalls: 0 };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockAnthropicModelsDiscovery(capture),
		});

		await registry.refreshProvider("anthropic", "online-if-uncached");

		expect(refreshCalls).toEqual([]);
		expect(capture.modelListCalls).toBe(0);
		expect(authStorage.getOAuthCredential("anthropic")?.access).toBe("sk-ant-oat-expired-anthropic");
	});

	test("online-if-uncached refreshes expired OAuth for authoritative providers even when the cache is fresh", async () => {
		// Regression for #5364: openai-codex is authoritative, so its bundled
		// models are pruned only when the manager is actually constructed — which
		// needs an authenticated key. With an expired OAuth token peekApiKey
		// returns undefined; the fresh-cache shortcut must NOT skip the refresh, or
		// the manager is never added and unsupported bundled ids (gpt-5.4-nano)
		// remain selectable for the whole cache TTL.
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("openai-codex", {
			type: "oauth",
			access: "expired-openai-codex",
			refresh: "refresh-openai-codex",
			expires: Date.now() - 60_000,
		});
		// Fresh + authoritative, but written against no static fingerprint so the
		// constructed manager still performs the account-scoped fetch.
		writeModelCache("openai-codex", Date.now() - 60_000, [], true, "", cacheDbPath);
		let modelListCalls = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.startsWith("https://chatgpt.com/backend-api") && url.includes("/models")) {
				modelListCalls++;
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-openai-codex");
				return Response.json({
					models: [
						{
							slug: "gpt-5.6-terra",
							display_name: "GPT-5.6 Terra",
							context_window: 372_000,
							supported_in_api: true,
							input_modalities: ["text", "image"],
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refreshProvider("openai-codex", "online-if-uncached");

		expect(refreshCalls).toEqual(["openai-codex"]);
		expect(modelListCalls).toBe(1);
		expect(registry.find("openai-codex", "gpt-5.6-terra")).toBeDefined();
		expect(registry.find("openai-codex", "gpt-5.4-nano")).toBeUndefined();
	});

	test("online-if-uncached refreshes expired OAuth for the descriptor-authoritative github-copilot provider even with a fresh cache", async () => {
		// Regression for #11144: github-copilot is authoritative only because its
		// provider descriptor sets dynamicModelsAuthoritative — the preflight reads
		// that flag from the descriptor (model-registry #resolveBuiltInDiscoveryApiKey
		// / model-patch AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS), not the manager
		// factory. Pruning the disabled bundled Copilot models happens only when the
		// github-copilot manager is actually constructed, which requires an
		// authenticated key. With an expired OAuth token, a fresh cache must NOT take
		// the no-refresh shortcut (which would leave the disabled models selectable
		// for the whole cache TTL); it must refresh, build the manager, and run the
		// account-scoped /models filter.
		const { refreshCalls } = await useAuthStorageWithRefreshTracker();
		await authStorage.set("github-copilot", {
			type: "oauth",
			access: "expired-github-copilot",
			refresh: "refresh-github-copilot",
			expires: Date.now() - 60_000,
		});
		writeModelCache(
			resolveModelCacheProviderId("github-copilot", {}),
			Date.now() - 60_000,
			[],
			true,
			"",
			cacheDbPath,
		);
		let modelListCalls = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "https://api.github.com/copilot_internal/user") {
				return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
			}
			if (url === "https://api.githubcopilot.com/models") {
				modelListCalls++;
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-github-copilot");
				return Response.json({
					data: [
						{
							id: "gpt-5.6-terra",
							name: "GPT-5.6 Terra",
							capabilities: { type: ["chat"] },
						},
						{
							id: "gpt-5.4-nano",
							name: "GPT-5.4 Nano",
							capabilities: { type: ["chat"] },
							policy: { state: "disabled" },
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refreshProvider("github-copilot", "online-if-uncached");

		expect(refreshCalls).toEqual(["github-copilot"]);
		expect(modelListCalls).toBe(1);
		expect(registry.find("github-copilot", "gpt-5.6-terra")).toBeDefined();
		expect(registry.find("github-copilot", "gpt-5.4-nano")).toBeUndefined();
	});

	test("github-copilot unions grants once per account using refreshed account-specific endpoints", async () => {
		authStorage.close();
		const refreshCalls: string[] = [];
		authStorage = await AuthStorage.create(":memory:", {
			refreshOAuthCredential: async (_provider, _credentialId, credential): Promise<OAuthCredentials> => {
				refreshCalls.push(credential.access);
				return {
					...credential,
					access: "copilot-business",
					apiEndpoint: "https://api.business.githubcopilot.com",
					expires: Date.now() + 3_600_000,
				};
			},
		});
		await authStorage.set("github-copilot", [
			// peekApiKey accepts this token, but the access resolver refreshes within its 60s skew.
			{ type: "oauth", access: "expiring-business", refresh: "refresh-b", expires: Date.now() + 30_000 },
			{ type: "oauth", access: "copilot-personal", refresh: "refresh-a", expires: Date.now() + 3_600_000 },
			{
				type: "oauth",
				access: "copilot-enterprise",
				refresh: "refresh-c",
				expires: Date.now() + 3_600_000,
				enterpriseUrl: "ghe.example.com",
			},
		]);
		const requests: string[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization) requests.push(`${authorization} ${url}`);
			if (url === "https://api.github.com/copilot_internal/user" && authorization === "token copilot-personal") {
				return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
			}
			const id =
				url === "https://api.githubcopilot.com/models" && authorization === "Bearer copilot-personal"
					? "personal-model"
					: url === "https://api.business.githubcopilot.com/models" && authorization === "Bearer copilot-business"
						? "business-model"
						: url === "https://copilot-api.ghe.example.com/models" &&
							  authorization === "Bearer copilot-enterprise"
							? "enterprise-model"
							: undefined;
			if (!id) throw new Error(`Unexpected account endpoint: ${authorization} ${url}`);
			return Response.json({
				data: [
					{ id },
					{ id: "shared-model" },
					{ id: "business-model", policy: { state: "disabled" } },
					{ id: "gpt-5.4-nano", policy: { state: "disabled" } },
				],
			});
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refreshProvider("github-copilot", "online");

		expect(
			getModelsForProvider(registry, "github-copilot")
				.map(model => model.id)
				.sort(),
		).toEqual(["business-model", "enterprise-model", "personal-model", "shared-model"]);
		expect(refreshCalls).toEqual(["expiring-business"]);
		expect(requests.sort()).toEqual([
			"Bearer copilot-business https://api.business.githubcopilot.com/models",
			"Bearer copilot-enterprise https://copilot-api.ghe.example.com/models",
			"Bearer copilot-personal https://api.githubcopilot.com/models",
			"token copilot-personal https://api.github.com/copilot_internal/user",
		]);
	});

	test("github-copilot routes live and cached union models only through granting OAuth accounts", async () => {
		const authPath = path.join(tempDir, "auth.db");
		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.set("github-copilot", [
			{ type: "api_key", key: "ungranted-static-key" },
			{ type: "oauth", access: "grant-a", refresh: "refresh-a", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: "grant-b", refresh: "refresh-b", expires: Date.now() + 3_600_000 },
		]);
		const oauthRows = authStorage
			.listStoredCredentials("github-copilot")
			.filter(row => row.credential.type === "oauth");
		const [accountA, accountB] = oauthRows;
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, init) => {
				const url = String(input);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url !== "https://api.githubcopilot.com/models") throw new Error(`Unexpected URL: ${url}`);
				const isA = new Headers(init?.headers).get("Authorization") === "Bearer grant-a";
				return Response.json({
					data: [
						{ id: isA ? "alpha" : "beta" },
						{ id: "shared-model" },
						...(isA ? [{ id: "beta", policy: { state: "disabled" } }] : []),
					].map(entry => ({
						...entry,
						capabilities: {
							type: "chat",
							limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
						},
					})),
				});
			},
		});
		await registry.refreshProvider("github-copilot", "online");
		const beta = registry.find("github-copilot", "beta")!;
		const shared = registry.find("github-copilot", "shared-model")!;

		// A warm pin to a non-granting account must not override model eligibility.
		authStorage.pinSessionOAuthAccount("github-copilot", "sticky", accountA.id);
		expect(JSON.parse((await registry.getApiKey(beta, "sticky"))!).token).toBe("grant-b");
		// Shared models remain eligible on both accounts, preserving healthy pins.
		expect(JSON.parse((await registry.getApiKey(shared, "sticky"))!).token).toBe("grant-b");
		authStorage.pinSessionOAuthAccount("github-copilot", "sticky", accountA.id);
		expect(JSON.parse((await registry.getApiKey(shared, "sticky"))!).token).toBe("grant-a");
		// Hash-selected sessions must obey the same grants as explicitly pinned sessions.
		expect(JSON.parse((await registry.getApiKey(beta, "new-session"))!).token).toBe("grant-b");

		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.reload();
		let networkRequests = 0;
		const restored = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () => {
				networkRequests++;
				throw new Error("Offline cache restore must not fetch");
			},
		});
		await restored.hydrateCredentialScopedModelCaches();
		const cachedBeta = restored.find("github-copilot", "beta")!;
		expect(cachedBeta).toBeDefined();
		authStorage.pinSessionOAuthAccount("github-copilot", "restored", accountA.id);
		expect(JSON.parse((await restored.getApiKey(cachedBeta, "restored"))!).token).toBe("grant-b");
		expect(networkRequests).toBe(0);

		// Removing the sole granting account must not leak to a sibling or static key.
		await authStorage.removeCredential("github-copilot", accountB.id);
		expect(await restored.getApiKey(cachedBeta, "restored")).toBeUndefined();
	});

	test("github-copilot denies models absent from an authoritative catalog", async () => {
		await authStorage.set("github-copilot", [
			{ type: "oauth", access: "token-a", refresh: "refresh-a", expires: Date.now() + 3_600_000 },
		]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "only-granted-model",
							policy: { state: "enabled" },
							capabilities: {
								type: "chat",
								limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
							},
						},
					],
				}),
		});

		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(false);

		await registry.refreshProvider("github-copilot", "online");

		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);
		expect(registry.find("github-copilot", "only-granted-model")).toBeDefined();
		expect(registry.find("github-copilot", "disabled-or-missing-model")).toBeUndefined();

		// Attempting to resolve an API key for the missing model must return undefined (denying all accounts)
		const missingModel = { provider: "github-copilot", id: "disabled-or-missing-model" } as Model<Api>;
		expect(await registry.getApiKey(missingModel, "session-1")).toBeUndefined();

		// Whereas the granted model resolves successfully
		const grantedModel = registry.find("github-copilot", "only-granted-model")!;
		expect(await registry.getApiKey(grantedModel, "session-1")).toBeDefined();
	});

	test("github-copilot persists an empty granted catalog as authoritative across cache hydration", async () => {
		const authPath = path.join(tempDir, "auth-empty.db");
		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.set("github-copilot", [
			{ type: "oauth", access: "token-a", refresh: "refresh-a", expires: Date.now() + 3_600_000 },
		]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "model-disabled",
							policy: { state: "disabled" },
							capabilities: {
								type: "chat",
								limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
							},
						},
					],
				}),
		});

		await registry.refreshProvider("github-copilot", "online");

		// All models are pruned
		expect(getModelsForProvider(registry, "github-copilot")).toHaveLength(0);
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);

		// Now simulate restart: open fresh auth storage and new ModelRegistry with the same cache
		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.reload();

		let networkRequests = 0;
		const restarted = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () => {
				networkRequests++;
				throw new Error("Offline cache restore must not fetch");
			},
		});
		await restarted.hydrateCredentialScopedModelCaches();

		// The empty catalog must stay authoritative and NOT restore bundled Copilot models
		expect(getModelsForProvider(restarted, "github-copilot")).toHaveLength(0);
		expect(restarted.isAuthoritativeProvider("github-copilot")).toBe(true);
		expect(networkRequests).toBe(0);
	});

	test("github-copilot retains the previous authoritative catalog when a subsequent refresh fails and does not renew cache TTL", async () => {
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-token",
				refresh: "account-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-user",
			},
		]);

		let failFetch = false;
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () => {
				if (failFetch) throw new Error("network down");
				return Response.json({
					data: [
						{
							id: "claude-sonnet-4.6",
							capabilities: {
								type: "chat",
								limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
							},
						},
					],
				});
			},
		});

		await registry.refreshProvider("github-copilot", "online");
		const initialModels = getModelsForProvider(registry, "github-copilot");
		expect(initialModels.map(m => m.id)).toEqual(["claude-sonnet-4.6"]);
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);

		const initialCache = readModelCache(
			resolveModelCacheProviderId("github-copilot", {
				accountIdentities: resolveGitHubCopilotAccountIdentities(authStorage),
			}),
			24 * 60 * 60 * 1000,
			Date.now,
			cacheDbPath,
		);
		expect(initialCache).not.toBeNull();
		const initialUpdatedAt = initialCache!.updatedAt;

		// Now sleep briefly and fail subsequent refresh
		await Bun.sleep(10);
		failFetch = true;
		await registry.refreshProvider("github-copilot", "online");

		// Must retain the previous authoritative models and NOT re-inject disabled/bundled models
		const modelsAfterFailure = getModelsForProvider(registry, "github-copilot");
		expect(modelsAfterFailure.map(m => m.id)).toEqual(["claude-sonnet-4.6"]);
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);

		// Cache must preserve prior updatedAt and NOT renew with current time
		const cacheAfterFailure = readModelCache(
			resolveModelCacheProviderId("github-copilot", {
				accountIdentities: resolveGitHubCopilotAccountIdentities(authStorage),
			}),
			24 * 60 * 60 * 1000,
			Date.now,
			cacheDbPath,
		);
		expect(cacheAfterFailure).not.toBeNull();
		expect(cacheAfterFailure!.updatedAt).toBe(initialUpdatedAt);
	});

	test("github-copilot preserves authoritative cache when /models fails but models.dev succeeds", async () => {
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-token",
				refresh: "account-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "account-user",
			},
		]);

		let failCopilotFetch = false;
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, _init) => {
				const url = String(input);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url.includes("models.dev")) {
					return Response.json([
						{
							id: "models-dev-supplementary-model",
							name: "Models Dev Model",
						},
					]);
				}
				if (url.endsWith("/models")) {
					if (failCopilotFetch) {
						return new Response(null, { status: 503 });
					}
					return Response.json({
						data: [
							{
								id: "claude-sonnet-4.6",
								capabilities: {
									type: "chat",
									limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
								},
							},
						],
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		await registry.refreshProvider("github-copilot", "online");
		const initialModels = getModelsForProvider(registry, "github-copilot");
		expect(initialModels.map(m => m.id)).toEqual(["claude-sonnet-4.6"]);
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);

		const initialCache = readModelCache(
			resolveModelCacheProviderId("github-copilot", {
				accountIdentities: resolveGitHubCopilotAccountIdentities(authStorage),
			}),
			24 * 60 * 60 * 1000,
			Date.now,
			cacheDbPath,
		);
		expect(initialCache).not.toBeNull();
		const initialUpdatedAt = initialCache!.updatedAt;

		// Sleep briefly and fail subsequent /models fetch, while models.dev still succeeds
		await Bun.sleep(10);
		failCopilotFetch = true;
		await registry.refreshProvider("github-copilot", "online");

		// Must retain previous authoritative models instead of overwriting cache with non-authoritative models.dev merge
		const modelsAfterFailure = getModelsForProvider(registry, "github-copilot");
		expect(modelsAfterFailure.map(m => m.id)).toEqual(["claude-sonnet-4.6"]);
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);

		// Cache must preserve prior updatedAt
		const cacheAfterFailure = readModelCache(
			resolveModelCacheProviderId("github-copilot", {
				accountIdentities: resolveGitHubCopilotAccountIdentities(authStorage),
			}),
			24 * 60 * 60 * 1000,
			Date.now,
			cacheDbPath,
		);
		expect(cacheAfterFailure).not.toBeNull();
		expect(cacheAfterFailure!.updatedAt).toBe(initialUpdatedAt);
	});

	test("resolveGitHubCopilotDiscoveryAccounts does not combine fallback key with refreshed OAuth accounts", async () => {
		authStorage.close();
		authStorage = await AuthStorage.create(":memory:", {
			refreshOAuthCredential: async (_provider, _credentialId, credential): Promise<OAuthCredentials> => {
				return {
					...credential,
					access: "refreshed-oauth-token",
					expires: Date.now() + 3_600_000,
				};
			},
		});
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "expired-oauth-token",
				refresh: "valid-oauth-refresh",
				expires: Date.now() - 60_000,
				accountId: "oauth-user",
			},
		]);

		const accounts = await resolveGitHubCopilotDiscoveryAccounts(authStorage, "env-copilot-token");
		expect(accounts).not.toBeNull();
		// Should only contain the refreshed OAuth account, NOT combining the fallback key
		expect(accounts).toHaveLength(1);
		expect(accounts![0].accountId).toBe("oauth-user");
		expect(JSON.parse(accounts![0].apiKey).token).toBe("refreshed-oauth-token");
	});

	test("github-copilot online-if-uncached invalidates cache when an account is added or removed", async () => {
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-1-token",
				refresh: "account-1-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-1",
			},
		]);

		let modelFetchCalls = 0;
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, init) => {
				const url = String(input);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url.includes("models.dev")) {
					return Response.json([]);
				}
				if (url.endsWith("/models")) {
					modelFetchCalls++;
					const auth = new Headers(init?.headers).get("Authorization");
					if (auth === "Bearer account-2-token") {
						return Response.json({
							data: [{ id: "model-account-2", capabilities: { type: "chat" } }],
						});
					}
					return Response.json({
						data: [{ id: "model-account-1", capabilities: { type: "chat" } }],
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		// Initial discovery with only account 1
		await registry.refreshProvider("github-copilot", "online-if-uncached");
		expect(modelFetchCalls).toBe(1);
		expect(getModelsForProvider(registry, "github-copilot").map(m => m.id)).toEqual(["model-account-1"]);

		// Second refresh with unchanged accounts uses fresh cache
		await registry.refreshProvider("github-copilot", "online-if-uncached");
		expect(modelFetchCalls).toBe(1);

		// Add account 2 (account 1 remains first)
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-1-token",
				refresh: "account-1-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-1",
			},
			{
				type: "oauth",
				access: "account-2-token",
				refresh: "account-2-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-2",
			},
		]);

		// online-if-uncached must NOT reuse the fresh cache for account 1 alone
		await registry.refreshProvider("github-copilot", "online-if-uncached");
		expect(modelFetchCalls).toBe(3); // +2 for querying both accounts
		const unionedIds = getModelsForProvider(registry, "github-copilot")
			.map(m => m.id)
			.sort();
		expect(unionedIds).toEqual(["model-account-1", "model-account-2"]);

		// Now remove account 2: the prior [user-1, user-2] cache cannot be reused
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-1-token",
				refresh: "account-1-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-1",
			},
		]);

		// online-if-uncached scopes to [user-1] and prunes model-account-2 immediately
		await registry.refreshProvider("github-copilot", "online-if-uncached");
		expect(getModelsForProvider(registry, "github-copilot").map(m => m.id)).toEqual(["model-account-1"]);

		// Add a previously unseen account 3 while account 1 remains first
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-1-token",
				refresh: "account-1-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-1",
			},
			{
				type: "oauth",
				access: "account-3-token",
				refresh: "account-3-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "user-3",
			},
		]);

		// Uncached namespace [user-1, user-3] forces endpoint fetch
		await registry.refreshProvider("github-copilot", "online-if-uncached");
		expect(modelFetchCalls).toBe(5); // +2 for querying account 1 and account 3
	});

	test("github-copilot invalidates cached grants when credential row IDs change", async () => {
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-token-1",
				refresh: "account-refresh-1",
				expires: Date.now() + 3_600_000,
				accountId: "user-42",
			},
		]);

		const [initialRow] = authStorage
			.listStoredCredentials("github-copilot")
			.filter(r => r.credential.type === "oauth");

		let failFetch = false;
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, _init) => {
				const url = String(input);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url.includes("models.dev")) {
					return Response.json([]);
				}
				if (url.endsWith("/models")) {
					if (failFetch) return new Response(null, { status: 503 });
					return Response.json({
						data: [
							{
								id: "copilot-model",
								capabilities: {
									type: "chat",
									limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
								},
							},
						],
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		// Initial discovery populates cache with initialRow.id in oauthCredentialIds
		await registry.refreshProvider("github-copilot", "online");
		const initialModel = registry.find("github-copilot", "copilot-model")!;
		expect(initialModel.oauthCredentialIds).toEqual([initialRow.id]);
		expect(JSON.parse((await registry.getApiKey(initialModel, "session-1"))!).token).toBe("account-token-1");

		// Account is removed and re-added with the same accountId but a new credentialId
		await authStorage.removeCredential("github-copilot", initialRow.id);
		await authStorage.set("github-copilot", [
			{
				type: "oauth",
				access: "account-token-2",
				refresh: "account-refresh-2",
				expires: Date.now() + 3_600_000,
				accountId: "user-42",
			},
		]);

		const [readdedRow] = authStorage
			.listStoredCredentials("github-copilot")
			.filter(r => r.credential.type === "oauth");
		expect(readdedRow.id).not.toBe(initialRow.id);

		// Subsequent discovery fetch fails (e.g. transient 503)
		failFetch = true;
		await registry.refreshProvider("github-copilot", "online");

		// The stale authoritative cache scoped to initialRow.id must NOT be reused.
		// If it were reused, copilot-model would still carry oauthCredentialIds: [initialRow.id],
		// which would reject readdedRow and fail API key resolution.
		// Instead, falling back to static/non-authoritative models removes the obsolete grant.
		const modelAfterFailedFetch = registry.find("github-copilot", "copilot-model");
		expect(modelAfterFailedFetch?.oauthCredentialIds).toBeUndefined();

		// When discovery recovers, fresh grants match readdedRow.id
		failFetch = false;
		await registry.refreshProvider("github-copilot", "online");
		const recoveredModel = registry.find("github-copilot", "copilot-model")!;
		expect(recoveredModel.oauthCredentialIds).toEqual([readdedRow.id]);
		expect(JSON.parse((await registry.getApiKey(recoveredModel, "session-1"))!).token).toBe("account-token-2");
	});

	test("github-copilot excludes ignored API keys from cache identity when coexisting with OAuth accounts", async () => {
		const authPath = path.join(tempDir, "auth-coexist.db");
		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.set("github-copilot", [
			{ type: "api_key", key: "coexisting-ignored-static-key" },
			{
				type: "oauth",
				access: "oauth-token",
				refresh: "oauth-refresh",
				expires: Date.now() + 3_600_000,
				accountId: "oauth-user",
			},
		]);

		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, _init) => {
				const url = String(input);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url.includes("models.dev")) {
					return Response.json([]);
				}
				if (url.endsWith("/models")) {
					return Response.json({
						data: [
							{
								id: "only-oauth-model",
								capabilities: {
									type: "chat",
									limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
								},
							},
						],
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			},
		});

		// Discover models: authoritative discovery only uses OAuth accounts
		await registry.refreshProvider("github-copilot", "online");
		expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);
		expect(registry.find("github-copilot", "only-oauth-model")).toBeDefined();

		// Startup cache scope must match the discovery cache scope (excluding the stored API key)
		const startupIdentities = resolveGitHubCopilotAccountIdentities(authStorage);
		const [oauthRow] = authStorage.listStoredCredentials("github-copilot").filter(r => r.credential.type === "oauth");
		expect(startupIdentities).toEqual([`oauth-user:${oauthRow.id}`]);

		// Now simulate restart: reload authStorage and open new ModelRegistry with offline hydration
		authStorage.close();
		authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
		await authStorage.reload();

		let networkCalls = 0;
		const restarted = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async () => {
				networkCalls++;
				throw new Error("Offline cache hydration must not fetch");
			},
		});
		await restarted.hydrateCredentialScopedModelCaches();

		// Hydration must hit the cache written during discovery:
		// remains authoritative, retains only-oauth-model, and does not restore bundled models
		expect(restarted.isAuthoritativeProvider("github-copilot")).toBe(true);
		expect(restarted.find("github-copilot", "only-oauth-model")).toBeDefined();
		expect(networkCalls).toBe(0);
	});

	test("github-copilot derives startup cache scope from COPILOT_GITHUB_TOKEN and hits cache on offline restart", async () => {
		const originalCopilotToken = Bun.env.COPILOT_GITHUB_TOKEN;
		try {
			Bun.env.COPILOT_GITHUB_TOKEN = "env-copilot-token";
			const authPath = path.join(tempDir, "auth-env-copilot.db");
			authStorage.close();
			authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
			// Save a lower-priority stored API key that should be superseded by the environment variable
			await authStorage.set("github-copilot", {
				type: "api_key",
				key: "stale-stored-key",
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async (input, init) => {
					const url = String(input);
					if (url.includes("models.dev")) {
						return Response.json([]);
					}
					if (url.endsWith("/models")) {
						expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer env-copilot-token");
						return Response.json({
							data: [
								{
									id: "env-token-model",
									capabilities: {
										type: "chat",
										limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
									},
								},
							],
						});
					}
					throw new Error(`Unexpected URL: ${url}`);
				},
			});

			// Discover models: authoritative discovery uses the higher-priority env token
			await registry.refreshProvider("github-copilot", "online");
			expect(registry.isAuthoritativeProvider("github-copilot")).toBe(true);
			expect(registry.find("github-copilot", "env-token-model")).toBeDefined();

			// Startup cache scope without resolvedApiKey must match discovery's env-token scope, not the stale stored key
			const startupIdentities = resolveGitHubCopilotAccountIdentities(authStorage);
			expect(startupIdentities).toEqual(["env-copilot-token"]);

			// Now simulate restart: reload authStorage and open new ModelRegistry with offline hydration
			authStorage.close();
			authStorage = await AuthStorage.create(authPath, { usageProviderResolver: () => undefined });
			await authStorage.reload();

			let networkCalls = 0;
			const restarted = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async () => {
					networkCalls++;
					throw new Error("Offline cache hydration must not fetch");
				},
			});
			await restarted.hydrateCredentialScopedModelCaches();

			// Hydration must hit the cache written during discovery:
			// remains authoritative, retains env-token-model, and does not restore bundled models
			expect(restarted.isAuthoritativeProvider("github-copilot")).toBe(true);
			expect(restarted.find("github-copilot", "env-token-model")).toBeDefined();
			expect(networkCalls).toBe(0);
		} finally {
			if (originalCopilotToken === undefined) {
				delete Bun.env.COPILOT_GITHUB_TOKEN;
			} else {
				Bun.env.COPILOT_GITHUB_TOKEN = originalCopilotToken;
			}
		}
	});

	test("github-copilot discovery honors a runtime key instead of stored OAuth accounts", async () => {
		await authStorage.set("github-copilot", {
			type: "oauth",
			access: "unused-account",
			refresh: "unused-refresh",
			expires: Date.now() - 60_000,
		});
		authStorage.setRuntimeApiKey(
			"github-copilot",
			JSON.stringify({
				token: "runtime-copilot",
				apiEndpoint: "https://api.business.githubcopilot.com",
			}),
		);
		const requests: string[] = [];
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async (input, init) => {
				const url = String(input);
				if (url !== "https://api.business.githubcopilot.com/models") throw new Error(`Unexpected URL: ${url}`);
				requests.push(new Headers(init?.headers).get("Authorization") ?? "");
				return Response.json({ data: [{ id: "runtime-model" }] });
			},
		});

		await registry.refreshProvider("github-copilot", "online");

		expect(requests).toEqual(["Bearer runtime-copilot"]);
		expect(getModelsForProvider(registry, "github-copilot").map(model => model.id)).toEqual(["runtime-model"]);
	});

	test("Codex discovery falls back to a resolved non-OAuth token when no OAuth accounts exist", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "runtime-openai-codex");
		let modelListCalls = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.startsWith("https://chatgpt.com/backend-api") && url.includes("/models")) {
				modelListCalls++;
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer runtime-openai-codex");
				return Response.json({
					models: [
						{
							slug: "runtime-codex-model",
							display_name: "Runtime Codex Model",
							context_window: 128_000,
							supported_in_api: true,
							input_modalities: ["text"],
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refreshProvider("openai-codex", "online");

		expect(modelListCalls).toBe(1);
		expect(registry.find("openai-codex", "runtime-codex-model")).toBeDefined();
	});

	test.each(["openai-codex", "github-copilot"])(
		"%s keeps bundled models when an account fails to refresh",
		async provider => {
			// A failed sibling refresh must not turn a partial union into the authoritative catalog.
			authStorage.close();
			authStorage = await AuthStorage.create(":memory:", {
				refreshOAuthCredential: async (_provider, _credentialId, credential): Promise<OAuthCredentials> => {
					if (credential.access.includes("expired")) {
						throw new Error("simulated transient refresh failure");
					}
					return { ...credential, expires: Date.now() + 3_600_000 };
				},
			});
			await authStorage.set(provider, [
				{ type: "oauth", access: "fresh-account", refresh: "refresh-fresh", expires: Date.now() + 3_600_000 },
				{ type: "oauth", access: "expired-account", refresh: "refresh-expired", expires: Date.now() - 60_000 },
			]);
			let modelListCalls = 0;
			const fetchMock: FetchImpl = async input => {
				const url = String(input);
				if (
					url.endsWith("/models") ||
					(url.startsWith("https://chatgpt.com/backend-api") && url.includes("/models"))
				) {
					modelListCalls++;
					return Response.json({ models: [] });
				}
				throw new Error(`Unexpected URL: ${url}`);
			};
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			const previousIds = getModelsForProvider(registry, provider)
				.map(model => model.id)
				.sort();

			await registry.refreshProvider(provider, "online");

			expect(modelListCalls).toBe(0);
			expect(
				getModelsForProvider(registry, provider)
					.map(model => model.id)
					.sort(),
			).toEqual(previousIds);
		},
	);

	test("Gemini CLI discovery forwards a stored OAuth project id to the quota fallback", async () => {
		await authStorage.set("google-gemini-cli", {
			type: "oauth",
			access: "stored-gemini-token",
			refresh: "stored-gemini-refresh",
			expires: Date.now() + 3_600_000,
			projectId: "stored-gcp-project",
		});
		const capture: GeminiCliDiscoveryCapture = { loadCodeAssistCalls: 0, urls: [] };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockGeminiCliStandardDiscovery(capture),
		});

		await registry.refreshProvider("google-gemini-cli", "online");

		expect(capture.loadCodeAssistCalls).toBe(0);
		expect(capture.urls).toContain("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
		expect(capture.quotaAuthorization).toBe("Bearer stored-gemini-token");
		expect(capture.quotaBody).toEqual({ project: "stored-gcp-project" });
		expect(registry.find("google-gemini-cli", "gemini-3.5-flash")).toBeDefined();
	});

	test("Gemini CLI discovery accepts project_id in a runtime credential override", async () => {
		authStorage.setRuntimeApiKey(
			"google-gemini-cli",
			JSON.stringify({ token: "runtime-gemini-token", project_id: "runtime-gcp-project" }),
		);
		const capture: GeminiCliDiscoveryCapture = { loadCodeAssistCalls: 0, urls: [] };
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: mockGeminiCliStandardDiscovery(capture),
		});

		await registry.refreshProvider("google-gemini-cli", "online");

		expect(capture.loadCodeAssistCalls).toBe(0);
		expect(capture.urls).toContain("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
		expect(capture.quotaAuthorization).toBe("Bearer runtime-gemini-token");
		expect(capture.quotaBody).toEqual({ project: "runtime-gcp-project" });
		expect(registry.find("google-gemini-cli", "gemini-3.5-flash")).toBeDefined();
	});

	test("configured discovery suppresses built-in special OAuth discovery", async () => {
		await authStorage.set("google-gemini-cli", {
			type: "oauth",
			access: "fresh-google-gemini-cli",
			refresh: "refresh-google-gemini-cli",
			expires: Date.now() + 3_600_000,
		});
		writeRawModelsJson({
			"google-gemini-cli": {
				baseUrl: "http://127.0.0.1:4893",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const unexpectedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4893/v1/models") {
				return Response.json({
					data: [{ id: "configured-gemini-cli-model", context_length: 65_536 }],
				});
			}
			unexpectedUrls.push(url);
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

		await registry.refreshProvider("google-gemini-cli", "online");

		expect(unexpectedUrls).toEqual([]);
		const configuredModel = registry.find("google-gemini-cli", "configured-gemini-cli-model");
		expect(configuredModel?.baseUrl).toBe("http://127.0.0.1:4893");
		expect(configuredModel?.contextWindow).toBe(65_536);
	});

	test("auto-discovers ollama models without provider config", async () => {
		const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const ollamaModels = getModelsForProvider(registry, "ollama");
		expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
		expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
		expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
	});

	test("auto-updates zenmux models keylessly and caches to models.db", async () => {
		const originalKey = Bun.env.ZENMUX_API_KEY;
		delete Bun.env.ZENMUX_API_KEY;
		try {
			// Phase 1: Online keyless discovery
			let capturedHeaders: RequestInit["headers"];
			const fetchMock: FetchImpl = async (input, init) => {
				const url = String(input);
				capturedHeaders = init?.headers;
				if (url === "https://zenmux.ai/api/v1/models" || url === "https://zenmux.ai/api/v1/models/") {
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "anthropic/claude-fable-5-free",
									name: "Claude Fable 5 Free",
									display_name: "Claude Fable 5 Free",
									object: "model",
									owned_by: "anthropic",
									input_modalities: ["text", "image"],
									capabilities: { reasoning: true, tool_call: true },
									context_length: 200000,
									max_completion_tokens: 128000,
									pricings: {
										prompt: [{ value: 0, unit: "perMTokens", currency: "USD" }],
										completion: [{ value: 0, unit: "perMTokens", currency: "USD" }],
									},
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			const registry1 = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry1.refreshProvider("zenmux", "online");

			// Assert Phase 1
			if (!capturedHeaders) {
				throw new Error("No headers captured");
			}
			const headers = new Headers(capturedHeaders);
			expect(headers.has("authorization")).toBe(false);

			const zenmuxModels = getModelsForProvider(registry1, "zenmux");
			const fable = zenmuxModels.find(m => m.id === "anthropic/claude-fable-5-free");
			expect(fable?.api).toBe("anthropic-messages");
			expect(fable?.baseUrl).toBe("https://zenmux.ai/api/anthropic");

			// Boundary: keyless discovery populates the cache and find(), but ZenMux is
			// a paid gateway (not in #keylessProviders), so without ZENMUX_API_KEY the
			// model must NOT appear in the selectable set — it would 401 at inference.
			expect(registry1.find("zenmux", "anthropic/claude-fable-5-free")).toBeDefined();
			expect(
				registry1.getAvailable().some(m => m.provider === "zenmux" && m.id === "anthropic/claude-fable-5-free"),
			).toBe(false);

			// Phase 2: Offline from models.db
			const fetchOffline: FetchImpl = async () => {
				throw new Error("Offline fetch should not be called");
			};
			const registry2 = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchOffline });
			await registry2.refreshProvider("zenmux", "offline");

			const offlineZenmuxModels = getModelsForProvider(registry2, "zenmux");
			const offlineFable = offlineZenmuxModels.find(m => m.id === "anthropic/claude-fable-5-free");
			expect(offlineFable?.api).toBe("anthropic-messages");
			expect(offlineFable?.baseUrl).toBe("https://zenmux.ai/api/anthropic");
		} finally {
			if (originalKey === undefined) {
				delete Bun.env.ZENMUX_API_KEY;
			} else {
				Bun.env.ZENMUX_API_KEY = originalKey;
			}
		}
	});

	test("only marks unconfigured implicit local endpoints as optional", async () => {
		{
			using _ollamaBaseUrl = withEnv("OLLAMA_BASE_URL", undefined);
			using _ollamaHost = withEnv("OLLAMA_HOST", undefined);
			using _llamaCpp = withEnv("LLAMA_CPP_BASE_URL", undefined);
			using _lmStudio = withEnv("LM_STUDIO_BASE_URL", undefined);
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			expect(
				["ollama", "llama.cpp", "lm-studio"].map(id => registry.getProviderDiscoveryState(id)?.optional),
			).toEqual([true, true, true]);
		}

		{
			using _ollama = withEnv("OLLAMA_BASE_URL", "http://ollama.example:11434");
			using _llamaCpp = withEnv("LLAMA_CPP_BASE_URL", "http://llama-cpp.example:8080");
			using _lmStudio = withEnv("LM_STUDIO_BASE_URL", "http://lm-studio.example:1234/v1");
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			await registry.refresh("offline");

			expect(
				["ollama", "llama.cpp", "lm-studio"].map(id => registry.getProviderDiscoveryState(id)?.optional),
			).toEqual([false, false, false]);
		}
	});

	test("uses OLLAMA_HOST for implicit ollama discovery", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", undefined);
		using _host = withEnv("OLLAMA_HOST", "ollama.lan:12345");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://ollama.lan:12345");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://ollama.lan:12345/v1");
		expect(registry.getProviderDiscoveryState("ollama")?.optional).toBe(false);
	});

	test("keeps OLLAMA_BASE_URL precedence over OLLAMA_HOST", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://omp-ollama.example:2222");
		using _host = withEnv("OLLAMA_HOST", "ollama-host.example:3333");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://omp-ollama.example:2222");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://omp-ollama.example:2222/v1");
		expect(registry.getProviderDiscoveryState("ollama")?.optional).toBe(false);
	});

	test("refreshes implicit Ollama discovery when the configured endpoint changes", async () => {
		const requested: string[] = [];
		{
			using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://old-ollama.example:11434/v1/");
			const fetchOld = mockOllamaDiscovery(["old-model"], "http://old-ollama.example:11434");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async (input, init) => {
					requested.push(String(input));
					return fetchOld(input, init);
				},
			});
			await registry.refresh();
			expect(registry.find("ollama", "old-model")).toBeDefined();
		}

		{
			using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://new-ollama.example:11434");
			const fetchNew = mockOllamaDiscovery(["new-model"], "http://new-ollama.example:11434");
			const registry = new ModelRegistry(authStorage, modelsJsonPath, {
				fetch: async (input, init) => {
					requested.push(String(input));
					return fetchNew(input, init);
				},
			});
			// The old endpoint has a fresh cache row, but default refresh must
			// miss that namespace and discover against the new endpoint.
			await registry.refresh();
			expect(registry.find("ollama", "old-model")).toBeUndefined();
			expect(registry.find("ollama", "new-model")?.baseUrl).toBe("http://new-ollama.example:11434/v1");
		}

		expect(requested).toContain("http://old-ollama.example:11434/api/tags");
		expect(requested).toContain("http://new-ollama.example:11434/api/tags");
	});

	test("uses OLLAMA_CONTEXT_LENGTH for implicit ollama context accounting", async () => {
		using _contextLength = withEnv("OLLAMA_CONTEXT_LENGTH", "16384");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.contextWindow).toBe(16384);
		expect(model?.maxTokens).toBe(16384);
	});

	test("lets OLLAMA_CONTEXT_LENGTH override ollama show metadata", async () => {
		using _contextLength = withEnv("OLLAMA_CONTEXT_LENGTH", "32768");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://127.0.0.1:11434", {
			model_info: {
				"phi4.context_length": 4096,
			},
			capabilities: ["completion"],
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.contextWindow).toBe(32768);
		expect(model?.maxTokens).toBe(32768);
	});

	test("prefers Ollama runtime num_ctx over training context metadata", async () => {
		const fetchMock = mockOllamaDiscovery(["qwen3:27b"], "http://127.0.0.1:11434", {
			parameters: "temperature 0.6\nnum_ctx 123904\n",
			model_info: {
				"qwen3.context_length": 262144,
			},
			capabilities: ["completion", "thinking"],
		});
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "qwen3:27b");
		expect(model?.contextWindow).toBe(123904);
		expect(model?.maxTokens).toBe(32_768);
	});

	test("discovers ollama-cloud through built-in descriptor flow without regressing local implicit ollama", async () => {
		authStorage.setRuntimeApiKey("ollama-cloud", "cloud-test-key");

		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/tags") {
				return new Response(JSON.stringify({ models: [{ name: "phi4-mini" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://ollama.com/api/tags") {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
				return new Response(JSON.stringify({ models: [{ name: "gpt-oss:120b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://ollama.com/api/show") {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer cloud-test-key");
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				expect(body.model).toBe("gpt-oss:120b");
				return new Response(
					JSON.stringify({
						capabilities: ["completion", "thinking"],
						model_info: { "gpt-oss.context_length": 262144 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const local = registry.find("ollama", "phi4-mini");
		const cloud = registry.find("ollama-cloud", "gpt-oss:120b");

		expect(local?.provider).toBe("ollama");
		expect(local?.api).toBe("openai-responses");
		expect(cloud?.provider).toBe("ollama-cloud");
		expect(cloud?.api).toBe("ollama-chat");
		expect(cloud?.baseUrl).toBe("https://ollama.com");
		expect(cloud?.reasoning).toBe(true);
		expect(cloud?.contextWindow).toBe(262144);
		expect(await registry.getApiKey(cloud!)).toBe("cloud-test-key");
		expect(registry.getAvailable().some(model => model.provider === "ollama" && model.id === "phi4-mini")).toBe(true);
		expect(
			registry.getAvailable().some(model => model.provider === "ollama-cloud" && model.id === "gpt-oss:120b"),
		).toBe(true);
	});
	test("discovers ollama models at runtime and treats auth:none providers as available", async () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "ollama" },
			},
		});

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "qwen2.5-coder:7b" }, { model: "llama3.2:3b", name: "llama3.2:3b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				return new Response(JSON.stringify({ capabilities: ["completion"] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const ollamaModels = getModelsForProvider(registry, "ollama");
		expect(ollamaModels.some(m => m.id === "qwen2.5-coder:7b")).toBe(true);
		expect(ollamaModels.some(m => m.id === "llama3.2:3b")).toBe(true);

		const available = registry.getAvailable().filter(m => m.provider === "ollama");
		expect(available.length).toBe(2);
		expect(await registry.getApiKey(available[0])).toBe(kNoAuth);
	});

	test("normalizes cached ollama completions rows to responses on load", () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-responses",
				auth: "none",
				discovery: { type: "ollama" },
			},
		});
		writeCachedOllamaModels([
			buildModel({
				id: "phi4-mini",
				name: "phi4-mini",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			}),
		]);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const ollama = registry.find("ollama", "phi4-mini");

		expect(ollama?.api).toBe("openai-responses");
		expect(ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(registry.getProviderDiscoveryState("ollama")?.status).toBe("cached");
	});

	test("refreshes cached discovery when models config is newer than the cache", async () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-responses",
				auth: "none",
				discovery: { type: "ollama" },
				modelOverrides: {
					"phi3:3.8b": { contextWindow: 8192, maxTokens: 4096 },
				},
			},
		});
		const configMtime = fs.statSync(modelsJsonPath).mtimeMs;
		writeCachedOllamaModels(
			[
				buildModel({
					id: "phi3:3.8b",
					name: "phi3:3.8b",
					api: "openai-completions",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			Math.floor(configMtime) - 1,
		);
		let tagCalls = 0;
		const fetchMock = mockOllamaDiscovery(["phi3:3.8b"], "http://127.0.0.1:11434", {
			capabilities: ["completion"],
			model_info: { "phi3.context_length": 8192 },
		});
		const countingFetch: FetchImpl = async (input, init) => {
			if (String(input) === "http://127.0.0.1:11434/api/tags") {
				tagCalls++;
			}
			return fetchMock(input, init);
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: countingFetch });
		await registry.refresh("online-if-uncached");

		const phi3 = registry.find("ollama", "phi3:3.8b");
		expect(tagCalls).toBe(1);
		expect(phi3?.contextWindow).toBe(8192);
		expect(phi3?.maxTokens).toBe(4096);
	});

	test("discovers ollama thinking capabilities from show metadata", async () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "ollama" },
			},
		});

		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/tags") {
				return new Response(
					JSON.stringify({
						models: [{ name: "qwen3.5:397b-cloud" }, { name: "llama3.2:3b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "qwen3.5:397b-cloud") {
					return new Response(JSON.stringify({ capabilities: ["completion", "thinking"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (body.model === "llama3.2:3b") {
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const qwen = registry.find("ollama", "qwen3.5:397b-cloud");
		expect(qwen?.reasoning).toBe(true);
		expect(qwen?.thinking).toEqual({
			mode: "effort",
			// Local Ollama's wire effort vocabulary is low/medium/high/max.
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});

		const llama = registry.find("ollama", "llama3.2:3b");
		expect(llama?.reasoning).toBe(false);
	});

	test("discovers ollama context window from show model_info", async () => {
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/tags") {
				return new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:11434/api/show") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
				if (body.model === "gemma3:4b") {
					return new Response(
						JSON.stringify({
							model_info: {
								"gemma3.context_length": 131072,
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			}
			throw new Error(`Unexpected request: ${url}`);
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const gemma = registry.find("ollama", "gemma3:4b");
		expect(gemma?.contextWindow).toBe(131072);
		expect(gemma?.maxTokens).toBe(32_768);
		expect(gemma?.input).toEqual(["text"]);
		expect(gemma?.reasoning).toBe(false);
	});

	test("discovery failure does not fail model registry refresh", async () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "ollama" },
			},
		});

		const fetchMock: FetchImpl = () => {
			throw new Error("connection refused");
		};

		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(getModelsForProvider(registry, "ollama")).toHaveLength(0);
		expect(registry.getError()).toBeUndefined();
	});
	test("loads cached local models before live refresh and preserves them on failure", async () => {
		writeRawModelsJson({
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "ollama" },
			},
		});

		{
			const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
			const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await primedRegistry.refresh();
		}

		const failingFetch: FetchImpl = () => {
			throw new Error("connection refused");
		};
		const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: failingFetch });
		expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
		expect(cachedRegistry.getProviderDiscoveryState("ollama")?.status).toBe("cached");

		await cachedRegistry.refreshProvider("ollama");

		expect(getModelsForProvider(cachedRegistry, "ollama").some(model => model.id === "phi4-mini")).toBe(true);
		const state = cachedRegistry.getProviderDiscoveryState("ollama");
		expect(state?.status).toBe("cached");
		expect(state?.error).toContain("connection refused");
	});

	test("reports unauthenticated discoverable providers without discarding cached models", async () => {
		writeRawModelsJson({
			"custom-local": {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				discovery: { type: "ollama" },
			},
		});
		authStorage.setRuntimeApiKey("custom-local", "test-key");

		{
			const fetchMock: FetchImpl = async input => {
				const url = String(input);
				if (url === "http://127.0.0.1:11434/api/tags") {
					return new Response(JSON.stringify({ models: [{ name: "local-coder" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "http://127.0.0.1:11434/api/show") {
					return new Response(JSON.stringify({ capabilities: ["completion"] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected URL: ${url}`);
			};
			const primedRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await primedRegistry.refreshProvider("custom-local");
		}

		authStorage.setRuntimeApiKey("custom-local", "");
		// Empty credentials must short-circuit discovery to "unauthenticated" *before*
		// any transport call; this guard fetch keeps the path provably network-free
		// (no real socket, no connect timeout) and makes a future regression that
		// reached the wire fail fast and loud instead of silently hanging.
		const noNetwork: FetchImpl = input => {
			throw new Error(`Unexpected network call during unauthenticated discovery: ${String(input)}`);
		};
		const cachedRegistry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: noNetwork });
		await cachedRegistry.refreshProvider("custom-local");

		expect(getModelsForProvider(cachedRegistry, "custom-local").some(model => model.id === "local-coder")).toBe(true);
		const state = cachedRegistry.getProviderDiscoveryState("custom-local");
		expect(state?.status).toBe("unauthenticated");
		expect(state?.models).toContain("local-coder");
	});
	test("llama.cpp discovery honors configured API key", async () => {
		authStorage.setRuntimeApiKey("llama.cpp", "test-llama-key");
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				let authHeader: string | null = null;
				if (headers instanceof Headers) {
					authHeader = headers.get("Authorization");
				} else if (typeof headers === "object") {
					authHeader = headers.Authorization;
				}
				expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
				return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }, { id: "mistral:7b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				let authHeader: string | null = null;
				if (headers instanceof Headers) {
					authHeader = headers.get("Authorization");
				} else if (typeof headers === "object") {
					authHeader = headers.Authorization;
				}
				expect(String(authHeader ?? "")).toBe("Bearer test-llama-key");
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const llamaModels = getModelsForProvider(registry, "llama.cpp");
		expect(llamaModels.some(m => m.id === "llama-3.2:3b")).toBe(true);
		const apiKey = await registry.getApiKey(llamaModels[0]);
		expect(apiKey).toBe("test-llama-key");
	});
	test("llama.cpp discovery without API key is treated as keyless", async () => {
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				let authHeader: string | null = null;
				if (headers instanceof Headers) {
					authHeader = headers.get("Authorization");
				} else if (typeof headers === "object") {
					authHeader = headers.Authorization;
				}
				// When no API key, headers should be empty object or undefined
				expect(authHeader).toBeUndefined();
				return new Response(JSON.stringify({ data: [{ id: "llama-3.2:3b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				let authHeader: string | null = null;
				if (headers instanceof Headers) {
					authHeader = headers.get("Authorization");
				} else if (typeof headers === "object") {
					authHeader = headers.Authorization;
				}
				expect(authHeader).toBeUndefined();
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 262144 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const state = registry.getProviderDiscoveryState("llama.cpp");
		if (state?.status !== "ok") {
			throw new Error(`Discovery failed with status ${state?.status}: ${state?.error}`);
		}
		const llamaModels = getModelsForProvider(registry, "llama.cpp");
		const apiKey = await registry.getApiKey(llamaModels[0]);
		expect(apiKey).toBe(kNoAuth);
	});
	test("llama.cpp discovery maps unlimited output limits to the context window", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "qwen35-35b-a3b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 262144,
							params: { max_tokens: -1, n_predict: -1 },
						},
						modalities: {
							vision: true,
							audio: false,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const llama = registry.find("llama.cpp", "qwen35-35b-a3b");
		expect(llama?.contextWindow).toBe(262144);
		expect(llama?.maxTokens).toBe(262144);
		expect(llama?.input).toEqual(["text", "image"]);
	});

	test("llama.cpp discovery routes Qwen models to chat-completions with the chat-template disable dialect", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [{ id: "qwen3-8b" }, { id: "ternary-bonsai-27b-q2_0" }, { id: "llama-3.1-8b" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: { n_ctx: 32768, params: { max_tokens: -1, n_predict: -1 } },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		type DialectFields = { thinkingFormat?: string; reasoningDisableMode?: string; qwenPreserveThinking?: boolean };
		for (const id of ["qwen3-8b", "ternary-bonsai-27b-q2_0"]) {
			const qwen = registry.find("llama.cpp", id);
			expect(qwen?.reasoning).toBe(true);
			expect(qwen?.api).toBe("openai-completions");
			expect(qwen?.baseUrl).toBe("http://127.0.0.1:8080/v1");
			const compat = qwen?.compat as DialectFields | undefined;
			expect(compat?.thinkingFormat).toBe("qwen-chat-template");
			expect(compat?.reasoningDisableMode).toBe("qwen-template-false");
			expect(compat?.qwenPreserveThinking).toBe(true);
		}

		const plain = registry.find("llama.cpp", "llama-3.1-8b");
		expect(plain?.reasoning).toBe(false);
		expect(plain?.api).toBe("openai-responses");
		expect(plain?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		expect((plain?.compat as DialectFields | undefined)?.reasoningDisableMode).not.toBe("qwen-template-false");
	});

	test("discovery timeout rejects even when fetch ignores abort", async () => {
		vi.useFakeTimers();
		try {
			const pending = Promise.withResolvers<Response>();
			let outcome: string | undefined;
			void discoverOllamaModels(
				{
					provider: "ollama",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:11434",
					discovery: { type: "ollama", timeoutMs: 25 },
					optional: true,
				},
				{
					fetch: () => pending.promise,
					getBearerApiKeyResolver: async () => undefined,
				},
			).then(
				() => {
					outcome = "resolved";
				},
				error => {
					outcome = error instanceof DOMException ? error.name : String(error);
				},
			);

			vi.advanceTimersByTime(25);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();

			expect(outcome).toBe("TimeoutError");
		} finally {
			vi.useRealTimers();
		}
	});

	test("configured provider discovery accepts timeoutMs and passes it to probes", async () => {
		const customConfigPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			customConfigPath,
			`
providers:
  custom-remote:
    baseUrl: "http://127.0.0.1:8080"
    api: "openai-completions"
    auth: "none"
    discovery:
      type: "llama.cpp"
      timeoutMs: 45000
`,
			"utf-8",
		);

		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "remote-model-1" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const registry = new ModelRegistry(authStorage, customConfigPath, { fetch: fetchMock });
		await registry.refresh();
		const state = registry.getProviderDiscoveryState("custom-remote");
		expect(state?.status).toBe("ok");
		const models = getModelsForProvider(registry, "custom-remote");
		expect(models.map(m => m.id)).toEqual(["remote-model-1"]);
	});
	test("configured llama.cpp Qwen model keeps its /v1 runtime URL despite a native-root baseUrl override", async () => {
		writeRawModelsJson({
			"llama.cpp": {
				baseUrl: "http://127.0.0.1:8080",
				api: "openai-responses",
				auth: "none",
				discovery: { type: "llama.cpp" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return Response.json({ data: [{ id: "qwen3-8b" }] });
			}
			if (url === "http://127.0.0.1:8080/props") {
				return Response.json({ default_generation_settings: { n_ctx: 32768 } });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		// The configured provider's native-root baseUrl wins in mergeDiscoveredModel,
		// so without the outermost re-application the routed completions model would
		// revert to `http://127.0.0.1:8080` and POST to `/chat/completions`.
		const qwen = registry.find("llama.cpp", "qwen3-8b");
		expect(qwen?.api).toBe("openai-completions");
		expect(qwen?.baseUrl).toBe("http://127.0.0.1:8080/v1");
	});

	test("applyLlamaCppQwenThinking keeps a pi-native gateway base URL without doubling /v1", () => {
		const upgraded = applyLlamaCppQwenThinking(
			buildModel({
				id: "qwen3-8b",
				name: "qwen3-8b",
				api: "openai-responses",
				provider: "llama.cpp",
				baseUrl: "http://gw:4000",
				transport: "pi-native",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_768,
				maxTokens: 4096,
			}),
		);
		// streamPiNative appends `/v1/pi/stream`, so the gateway URL must stay bare
		// rather than gaining a `/v1` that would double to `.../v1/v1/pi/stream`.
		expect(upgraded.baseUrl).toBe("http://gw:4000");
		expect(upgraded.transport).toBe("pi-native");
		expect(upgraded.reasoning).toBe(true);
		expect((upgraded.compat as { reasoningDisableMode?: string }).reasoningDisableMode).toBe("qwen-template-false");
	});

	test("runtime metadata refresh probes native /models for a /v1-routed Qwen model", async () => {
		const requested: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requested.push(url);
			if (url === "http://127.0.0.1:8080/models") {
				return Response.json({ data: [{ id: "qwen3-8b" }] });
			}
			if (url === "http://127.0.0.1:8080/props") {
				return Response.json({ default_generation_settings: { n_ctx: 32_768 } });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const qwen = registry.find("llama.cpp", "qwen3-8b");
		expect(qwen?.baseUrl).toBe("http://127.0.0.1:8080/v1");

		await registry.refreshSelectedModelMetadata(qwen!);
		// The routed model carries a /v1 base URL, but the native metadata probe
		// (meta/status.args/architecture.input_modalities) must stay on /models.
		expect(requested).toContain("http://127.0.0.1:8080/models");
		expect(requested).not.toContain("http://127.0.0.1:8080/v1/models");
	});

	test("discoveryProbeTimeoutMs keeps loopback fast but gives non-loopback hosts a larger budget", () => {
		// Regression: the loopback-tuned probe timeout was applied to every host,
		// so a remote/LAN LLAMA_CPP_BASE_URL with normal round-trip latency timed
		// out and the model list came back empty (#7087). Loopback keeps the tight
		// budget; anything reached over the network gets a strictly larger one.
		const loopbackMs = 250;
		for (const host of [
			"http://127.0.0.1:8080",
			"http://127.5.6.7:8080",
			"http://localhost:8080",
			"http://[::1]:8080",
			"http://0.0.0.0:8080",
		]) {
			expect(discoveryProbeTimeoutMs(host, loopbackMs)).toBe(loopbackMs);
		}
		const remoteBudgets = [
			"http://remote-llama.test:8080",
			"http://192.168.1.50:8080",
			"http://172.18.0.3:8080",
			"http://10.0.0.4:8080",
			"http://box.local:8080",
		].map(host => discoveryProbeTimeoutMs(host, loopbackMs));
		for (const budget of remoteBudgets) {
			expect(budget).toBeGreaterThan(loopbackMs);
		}
		// A consistent budget for every non-loopback host, independent of the tight cap.
		expect(new Set(remoteBudgets).size).toBe(1);
		expect(discoveryProbeTimeoutMs("http://remote-llama.test:8080", 150)).toBe(remoteBudgets[0]);
	});

	test("discoveryProbeTimeoutMs uses explicit customTimeoutMs when provided", () => {
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 30_000)).toBe(30_000);
		expect(discoveryProbeTimeoutMs("http://remote-llama.test:8080", 250, 30_000)).toBe(30_000);
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 5_000)).toBe(5_000);
		// Invalid custom timeouts fall back to standard loopback/remote resolution
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, -100)).toBe(250);
		expect(discoveryProbeTimeoutMs("http://127.0.0.1:8080", 250, 0)).toBe(250);
	});

	test("ProviderDiscoverySchema validates timeoutMs", () => {
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: 30_000 })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "ollama", timeoutMs: 5_000 })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: -500 })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: 0 })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: Number.NaN })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "llama.cpp", timeoutMs: "30000" as any })).toBe(false);
	});
	test("ProviderDiscoverySchema restricts injectV1 to openai-models-list", () => {
		expect(ProviderDiscoverySchema.allows({ type: "openai-models-list", injectV1: false })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "openai-models-list", injectV1: true })).toBe(true);
		expect(ProviderDiscoverySchema.allows({ type: "lm-studio", injectV1: false })).toBe(false);
		expect(ProviderDiscoverySchema.allows({ type: "proxy", injectV1: false })).toBe(false);
	});
	test("llama.cpp discovery marks per-model architecture image modalities as vision-capable", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "q51q41_mtp_30tps_120k",
								architecture: {
									input_modalities: ["text", "image"],
									output_modalities: ["text"],
								},
								meta: { n_ctx: 123904 },
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 123904 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const llama = registry.find("llama.cpp", "q51q41_mtp_30tps_120k");
		expect(llama?.contextWindow).toBe(123904);
		expect(llama?.input).toEqual(["text", "image"]);
	});

	test("llama.cpp discovery ignores positive props defaults as per-request limits, not hard caps", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "bounded-output" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 262144,
							params: { max_tokens: 65536, n_predict: 65536 },
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const llama = registry.find("llama.cpp", "bounded-output");
		expect(llama?.contextWindow).toBe(262144);
		expect(llama?.maxTokens).toBe(32_768);
	});
	test("llama.cpp discovery prefers runtime n_ctx over training context metadata", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "ctx-88k", meta: { n_ctx: 88832, n_ctx_train: 131072 } },
							{ id: "ctx-train", meta: { n_ctx_train: 65536 } },
							{ id: "unloaded" },
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 128000 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("llama.cpp", "ctx-88k")?.contextWindow).toBe(88832);
		expect(registry.find("llama.cpp", "ctx-train")?.contextWindow).toBe(128000);
		expect(registry.find("llama.cpp", "unloaded")?.contextWindow).toBe(128000);
	});

	test("llama.cpp discovery falls back to n_ctx_train before the global default", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [{ id: "ctx-train", meta: { n_ctx_train: 65536 } }, { id: "unloaded" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: {} }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("llama.cpp", "ctx-train")?.contextWindow).toBe(65536);
		expect(registry.find("llama.cpp", "unloaded")?.contextWindow).toBe(128000);
	});
	test("llama.cpp router discovery reads --ctx-size from each preset's status.args and status.preset", async () => {
		// llama-server in router mode advertises each preset via /v1/models but
		// meta.n_ctx / n_ctx_train are only populated after the child instance
		// loads. Router-level /props returns a dummy n_ctx: 0. Without the
		// status.args / status.preset fallbacks every preset would collapse to
		// the 128k global default (issue #4190).
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "long-preset",
								object: "model",
								status: {
									value: "unloaded",
									args: ["--model", "/models/l.gguf", "--ctx-size", "65536"],
									preset: "[long-preset]\nmodel = /models/l.gguf\nctx-size = 65536\n\n",
								},
								source: "preset",
							},
							{
								id: "short-preset",
								object: "model",
								status: {
									value: "unloaded",
									args: ["--model", "/models/s.gguf", "-c", "8192"],
								},
								source: "preset",
							},
							{
								id: "ini-only-preset",
								object: "model",
								status: {
									value: "unloaded",
									preset: "[ini-only-preset]\nmodel = /models/i.gguf\nctx-size = 32768\n\n",
								},
								source: "preset",
							},
							{
								id: "explicit-model-default",
								object: "model",
								// --ctx-size 0 means "loaded from model"; must NOT surface as 0.
								status: {
									value: "unloaded",
									args: ["--model", "/models/d.gguf", "--ctx-size", "0"],
								},
								source: "preset",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				// Verbatim shape of get_router_props() — n_ctx: 0 dummy.
				return new Response(
					JSON.stringify({
						role: "router",
						max_instances: 4,
						models_autoload: true,
						model_alias: "llama-server",
						model_path: "none",
						default_generation_settings: { params: {}, n_ctx: 0 },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("llama.cpp", "long-preset")?.contextWindow).toBe(65536);
		expect(registry.find("llama.cpp", "short-preset")?.contextWindow).toBe(8192);
		expect(registry.find("llama.cpp", "ini-only-preset")?.contextWindow).toBe(32768);
		// `--ctx-size 0` falls through past the configured hint to the global default.
		expect(registry.find("llama.cpp", "explicit-model-default")?.contextWindow).toBe(128000);
	});

	test("llama.cpp router preset refresh honors --ctx-size when the child hasn't been loaded yet", async () => {
		// Reporter's workflow: `/model` picks a preset. On its very first switch
		// the child hasn't been spawned yet (meta.n_ctx absent), but the
		// configured window is still what the user wants surfaced.
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "cold-preset",
					name: "cold-preset",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "cold-preset",
								status: {
									value: "unloaded",
									args: ["--model", "/models/c.gguf", "--ctx-size", "16384"],
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: { params: {}, n_ctx: 0 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "cold-preset");
		if (!stale) throw new Error("cached llama.cpp model missing");
		expect(stale.contextWindow).toBe(128000);
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.contextWindow).toBe(16384);
		expect(refreshed.maxTokens).toBe(16384);
		expect(registry.find("llama.cpp", "cold-preset")?.contextWindow).toBe(16384);

		await authStorage.set("projection-provider", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		try {
			registry.registerProvider(
				"projection-provider",
				{
					api: "anthropic-messages",
					baseUrl: "https://example.invalid/",
					models: [
						{
							id: "projection-model",
							name: "Projection Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
						},
					],
					oauth: {
						name: "Projection OAuth",
						login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
						refreshToken: async credentials => credentials,
						getApiKey: credentials => credentials.access,
						modifyModels: models => models,
					},
				},
				"ext://metadata-projection",
			);
			expect(registry.find("llama.cpp", "cold-preset")?.contextWindow).toBe(16384);
		} finally {
			registry.clearSourceRegistrations("ext://metadata-projection");
		}
	});

	test("llama.cpp selected model refresh patches newly loaded meta n_ctx and unlimited output limit", async () => {
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "sleeping-model",
					name: "sleeping-model",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "sleeping-model", meta: { n_ctx: 239104 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 239104,
							params: { max_tokens: -1, n_predict: -1 },
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "sleeping-model");
		if (!stale) throw new Error("cached llama.cpp model missing");
		expect(stale.contextWindow).toBe(128000);
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.contextWindow).toBe(239104);
		expect(refreshed.maxTokens).toBe(239104);
		expect(registry.find("llama.cpp", "sleeping-model")?.contextWindow).toBe(239104);
	});

	test("llama.cpp selected model refresh marks cached text-only models image-capable from /props vision modality", async () => {
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
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
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "vision-model", meta: { n_ctx: 239104 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 239104,
							params: { max_tokens: -1, n_predict: -1 },
						},
						modalities: { vision: true, audio: false, video: false },
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "vision-model");
		if (!stale) throw new Error("cached llama.cpp model missing");
		expect(stale.input).toEqual(["text"]);
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.input).toEqual(["text", "image"]);
		expect(registry.find("llama.cpp", "vision-model")?.input).toEqual(["text", "image"]);
	});

	test("llama.cpp selected model refresh reads image capability from per-model architecture", async () => {
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "router-vision-model",
					name: "router-vision-model",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "router-vision-model",
								architecture: {
									input_modalities: ["text", "image"],
									output_modalities: ["text"],
								},
								meta: { n_ctx: 239104 },
							},
						],
					}),
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
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "router-vision-model");
		if (!stale) throw new Error("cached llama.cpp model missing");
		expect(stale.input).toEqual(["text"]);
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.contextWindow).toBe(239104);
		expect(refreshed.input).toEqual(["text", "image"]);
		expect(registry.find("llama.cpp", "router-vision-model")?.input).toEqual(["text", "image"]);
	});

	test("llama.cpp selected model refresh leaves the cached model untouched when /models no longer lists it", async () => {
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "swapped-out-model",
					name: "swapped-out-model",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "another-model", meta: { n_ctx: 524288 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 524288,
							params: { max_tokens: -1, n_predict: -1 },
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "swapped-out-model");
		if (!stale) throw new Error("cached llama.cpp model missing");
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.contextWindow).toBe(128000);
		expect(refreshed.maxTokens).toBe(32768);
	});

	test("llama.cpp selected model refresh clamps unlimited output to overridden context", async () => {
		writeRawModelsJson({
			"llama.cpp": {
				baseUrl: "http://127.0.0.1:8080",
				api: "openai-responses",
				auth: "none",
				discovery: { type: "llama.cpp" },
				modelOverrides: {
					"bounded-context-model": { contextWindow: 128000 },
				},
			},
		});
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "bounded-context-model",
					name: "bounded-context-model",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262144,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "bounded-context-model", meta: { n_ctx: 262144 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(
					JSON.stringify({
						default_generation_settings: {
							n_ctx: 262144,
							params: { max_tokens: -1, n_predict: -1 },
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const bounded = registry.find("llama.cpp", "bounded-context-model");
		if (!bounded) throw new Error("cached llama.cpp model missing");
		expect(bounded.contextWindow).toBe(128000);
		const refreshed = await registry.refreshSelectedModelMetadata(bounded);
		expect(refreshed.contextWindow).toBe(128000);
		expect(refreshed.maxTokens).toBe(128000);
	});

	test("llama.cpp selected model refresh does not resolve command api keys", async () => {
		const commandLogPath = path.join(tempDir, "llama-cpp-key-command.log");
		// Pre-create so the before/after comparison works whether or not
		// registry construction happens to invoke the key command itself.
		fs.writeFileSync(commandLogPath, "");
		writeRawModelsJson({
			"llama.cpp": {
				baseUrl: "http://127.0.0.1:8080",
				apiKey: `!"${process.execPath}" -e 'require("node:fs").appendFileSync(${JSON.stringify(commandLogPath)}, "x"); process.exit(1);'`,
				api: "openai-responses",
				discovery: { type: "llama.cpp" },
				models: [{ id: "protected-model", reasoning: false, input: ["text"] }],
			},
		});
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				const headers = init?.headers as Headers | Record<string, string> | undefined;
				const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
				expect(authHeader).toBeUndefined();
				return new Response(JSON.stringify({ data: [{ id: "protected-model", meta: { n_ctx: 239104 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const commandOutputBeforeRefresh = fs.readFileSync(commandLogPath, "utf8");
		const model = registry.find("llama.cpp", "protected-model");
		if (!model) throw new Error("custom llama.cpp model missing");
		const refreshed = await registry.refreshSelectedModelMetadata(model);
		expect(refreshed.contextWindow).toBe(239104);
		expect(fs.readFileSync(commandLogPath, "utf8")).toBe(commandOutputBeforeRefresh);
	});

	test("llama.cpp selected model refresh preserves same-id custom limits", async () => {
		writeRawModelsJson({
			"llama.cpp": {
				baseUrl: "http://127.0.0.1:8080",
				api: "openai-responses",
				auth: "none",
				discovery: { type: "llama.cpp" },
				models: [
					{
						id: "pinned-model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 88832,
						maxTokens: 4096,
					},
				],
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				return new Response(JSON.stringify({ data: [{ id: "pinned-model", meta: { n_ctx: 239104 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const pinned = registry.find("llama.cpp", "pinned-model");
		if (!pinned) throw new Error("custom llama.cpp model missing");
		const refreshed = await registry.refreshSelectedModelMetadata(pinned);
		expect(refreshed.contextWindow).toBe(88832);
		expect(refreshed.maxTokens).toBe(4096);
		const registryModel = registry.find("llama.cpp", "pinned-model");
		expect(registryModel?.contextWindow).toBe(88832);
		expect(registryModel?.maxTokens).toBe(4096);
	});

	test("llama.cpp refresh bypasses fresh cache so server restarts update n_ctx", async () => {
		writeModelCache(
			"llama.cpp",
			Date.now(),
			[
				buildModel({
					id: "restarted-model",
					name: "restarted-model",
					provider: "llama.cpp",
					api: "openai-responses",
					baseUrl: "http://127.0.0.1:8080",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 32768,
				}),
			],
			true,
			"",
			cacheDbPath,
		);
		let modelListCalls = 0;
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:8080/models") {
				modelListCalls++;
				return new Response(JSON.stringify({ data: [{ id: "restarted-model", meta: { n_ctx: 88832 } }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:8080/props") {
				return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 0 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(modelListCalls).toBe(1);
		expect(registry.find("llama.cpp", "restarted-model")?.contextWindow).toBe(88832);
	});
	test("openai-models-list discovery honors API-reported context_length over fallback", async () => {
		writeRawModelsJson({
			"openai-test": {
				baseUrl: "http://127.0.0.1:9999",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9999/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "openai-test/contextual-model", context_length: 16385 },
							{ id: "openai-test/no-context-model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const contextual = registry
			.getAll()
			.find(m => m.provider === "openai-test" && m.id === "openai-test/contextual-model");
		expect(contextual?.contextWindow).toBe(16385);
		const fallback = registry
			.getAll()
			.find(m => m.provider === "openai-test" && m.id === "openai-test/no-context-model");
		expect(fallback?.contextWindow).toBe(128000);
	});

	test("openai-models-list discovery enriches thin /v1/models payloads from the bundled reference catalog", async () => {
		writeRawModelsJson({
			"openai-test": {
				baseUrl: "http://127.0.0.1:9997",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9997/v1/models") {
				// Thin gateway payload: `{id, object, owned_by}` with no
				// `context_length` / `max_model_len`. Without reference lookup
				// every discovered model falls back to the 128K/33K default,
				// even when the id matches a bundled model with a much larger
				// intrinsic context window.
				return new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-5", object: "model", owned_by: "gateway" },
							{ id: "unknown-proxy-model", object: "model", owned_by: "gateway" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const proxied = registry.find("openai-test", "gpt-5");
		expect(proxied?.name).toBe("GPT-5");
		expect(proxied?.contextWindow).toBe(400_000);
		expect(proxied?.maxTokens).toBe(128_000);
		expect(proxied?.reasoning).toBe(true);
		expect(proxied?.thinking?.mode).toBe("effort");
		expect(proxied?.input).toEqual(["text", "image"]);
		const proxiedCompat = proxied?.compat as OpenAICompat | undefined;
		expect(proxiedCompat?.supportsReasoningEffort).toBe(true);
		expect(proxiedCompat?.omitReasoningEffort).toBe(false);
		// Proxy pricing is untrusted even when the identity resolves.
		expect(proxied?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// Unknown model ids stay on the default fallback path.
		const unknown = registry.find("openai-test", "unknown-proxy-model");
		expect(unknown?.contextWindow).toBe(128000);
		expect(unknown?.reasoning).toBe(false);
	});

	test("openai-models-list discovery reads server-advertised input modalities for ids absent from the catalog", async () => {
		writeRawModelsJson({
			"openai-test": {
				baseUrl: "http://127.0.0.1:9996",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9996/v1/models") {
				// Custom virtual tier ids that are absent from the bundled
				// catalog: their vision support can only come from the server row.
				return new Response(
					JSON.stringify({
						data: [
							{ id: "high", object: "model", input: ["text", "image"] },
							{ id: "leftover", object: "model", architecture: { input_modalities: ["text", "image"] } },
							{ id: "synthetic-tier", object: "model", input_modalities: ["text", "image"] },
							{ id: "low", object: "model", input: ["text"] },
							{ id: "medium", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		// Direct `input`, top-level `input_modalities`, and OpenRouter-style
		// `architecture.input_modalities` all surface vision support.
		expect(registry.find("openai-test", "high")?.input).toEqual(["text", "image"]);
		expect(registry.find("openai-test", "leftover")?.input).toEqual(["text", "image"]);
		expect(registry.find("openai-test", "synthetic-tier")?.input).toEqual(["text", "image"]);
		// Server explicitly reports text-only; no image support invented.
		expect(registry.find("openai-test", "low")?.input).toEqual(["text"]);
		// Silent server → default text-only fallback.
		expect(registry.find("openai-test", "medium")?.input).toEqual(["text"]);
	});

	test("openai-models-list with injectV1: false hits {baseUrl}/models verbatim", async () => {
		// Gateways like opper.ai root their OpenAI-compatible surface at a
		// versioned path (`https://api.opper.ai/v3/compat`); the default
		// normalizer would force `/v1/models` onto that root and land on a
		// different (much smaller) model list than chat uses.
		writeRawModelsJson({
			"opper-test": {
				baseUrl: "https://api.opper.ai/v3/compat",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list", injectV1: false },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "https://api.opper.ai/v3/compat/models") {
				return new Response(JSON.stringify({ data: [{ id: "opper-full-a" }, { id: "opper-full-b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		// Discovered models carry the configured URL as their chat base —
		// discovery and chat share the same endpoint root.
		expect(registry.find("opper-test", "opper-full-a")?.baseUrl).toBe("https://api.opper.ai/v3/compat");
		expect(registry.find("opper-test", "opper-full-b")?.baseUrl).toBe("https://api.opper.ai/v3/compat");
	});

	test("openai-models-list with injectV1: false strips query strings from the base URL", async () => {
		// Chat builds the inference URL by appending `/chat/completions` to the
		// base string, so a query in `baseUrl` would corrupt it
		// (`?token=x/chat/completions`). The bare normalizer drops queries and
		// hashes, matching the default mode's normalizer.
		writeRawModelsJson({
			"opper-test": {
				baseUrl: "https://api.opper.ai/v3/compat?token=gateway",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "openai-models-list", injectV1: false },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "https://api.opper.ai/v3/compat/models") {
				return new Response(JSON.stringify({ data: [{ id: "opper-full-a" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("opper-test", "opper-full-a")?.baseUrl).toBe("https://api.opper.ai/v3/compat");
	});

	test("lm-studio discovery keeps native VLM modalities over a thin OpenAI row", async () => {
		writeRawModelsJson({
			"lm-studio-test": {
				baseUrl: "http://127.0.0.1:9995",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "lm-studio" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9995/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "local-vlm", object: "model", input: ["text"] }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "http://127.0.0.1:9995/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [{ id: "local-vlm", type: "vlm", capabilities: ["vision"], state: "loaded" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		expect(registry.find("lm-studio-test", "local-vlm")?.input).toEqual(["text", "image"]);
	});

	test("proxy discovery honors API-reported context_length and endpoint routing", async () => {
		writeRawModelsJson({
			"proxy-test": {
				baseUrl: "http://127.0.0.1:9998",
				auth: "none",
				discovery: { type: "proxy" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9998/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "anthropic-model", supported_endpoint_types: ["anthropic"], context_length: 200000 },
							{ id: "openai-model", supported_endpoint_types: ["openai"], context_length: 65536 },
							{ id: "zero-context-model", supported_endpoint_types: ["openai"], context_length: 0 },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const anthropic = registry.getAll().find(m => m.provider === "proxy-test" && m.id === "anthropic-model");
		expect(anthropic?.api).toBe("anthropic-messages");
		expect(anthropic?.contextWindow).toBe(200000);
		const openai = registry.getAll().find(m => m.provider === "proxy-test" && m.id === "openai-model");
		expect(openai?.api).toBe("openai-completions");
		expect(openai?.contextWindow).toBe(65536);
		// A non-positive upstream context_length must be rejected by the guard and
		// fall through to the bundled reference (absent here) then the default,
		// never pinning the model at a broken `0` window.
		const zeroCtx = registry.getAll().find(m => m.provider === "proxy-test" && m.id === "zero-context-model");
		expect(zeroCtx?.contextWindow).toBe(128000);
	});

	test("proxy discovery uses proxy-reported name over bundled placeholder", async () => {
		writeRawModelsJson({
			"proxy-test": {
				baseUrl: "http://127.0.0.1:9998",
				auth: "none",
				discovery: { type: "proxy" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9998/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "act_two",
								name: "Act Two",
								supported_endpoint_types: ["openai"],
								context_length: 65536,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("proxy-test", "act_two");
		expect(model?.name).toBe("Act Two");
	});

	test("proxy discovery falls back to bundled name when proxy reports none", async () => {
		writeRawModelsJson({
			"proxy-test": {
				baseUrl: "http://127.0.0.1:9998",
				auth: "none",
				discovery: { type: "proxy" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:9998/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "gpt-5",
								supported_endpoint_types: ["openai"],
								context_length: 128000,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("proxy-test", "gpt-5");
		expect(model?.name).toBe("GPT-5");
	});

	test("litellm discovery maps rich model metadata and keeps runtime /v1 baseUrl", async () => {
		writeRawModelsJson({
			"litellm-test": {
				baseUrl: "http://127.0.0.1:4000",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "litellm" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4000/model_group/info") {
				return Response.json({
					data: [
						{
							model_group: "gpt-big",
							providers: ["openai"],
							max_input_tokens: 262_144,
							max_output_tokens: 16_384,
							supports_vision: true,
							supports_reasoning: true,
							supported_openai_params: ["reasoning_effort"],
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("litellm-test", "gpt-big");

		expect(model?.baseUrl).toBe("http://127.0.0.1:4000/v1");
		expect(model?.contextWindow).toBe(262_144);
		expect(model?.maxTokens).toBe(16_384);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.reasoning).toBe(true);
		expect(model?.api).toBe("openai-responses");
	});

	test("litellm discovery enriches configured proxy models with bundled references", async () => {
		writeRawModelsJson({
			"litellm-test": {
				baseUrl: "http://127.0.0.1:4000/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "litellm" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4000/model_group/info") {
				return Response.json({ data: [{ model_group: "gpt-5", supports_reasoning: true }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("litellm-test", "gpt-5");

		expect(model?.name).toBe("GPT-5");
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(model?.thinking?.mode).toBe("effort");
		expect((model?.compat as OpenAICompat | undefined)?.supportsReasoningEffort).toBe(true);
	});

	test("litellm discovery defaults to LiteLLM local proxy when baseUrl is omitted", async () => {
		writeRawModelsJson({
			"litellm-test": {
				api: "openai-completions",
				auth: "none",
				discovery: { type: "litellm" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://localhost:4000/model_group/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://localhost:4000/v2/model/info" || url === "http://localhost:4000/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://localhost:4000/v1/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://localhost:4000/v1/models") {
				return Response.json({ data: [{ id: "default-litellm" }, { id: "openai/gpt-5" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		expect(registry.find("litellm-test", "default-litellm")?.baseUrl).toBe("http://localhost:4000/v1");
		expect(registry.find("litellm-test", "openai/gpt-5")?.api).toBe("openai-responses");
	});

	test("litellm discovery reuses configured bearer on rich and fallback requests", async () => {
		writeRawModelsJson({
			"litellm-test": {
				baseUrl: "http://127.0.0.1:4001",
				apiKey: "sk-1234",
				api: "openai-completions",
				auth: "apiKey",
				discovery: { type: "litellm" },
			},
		});
		const authByUrl = new Map<string, string | undefined>();
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			const headers = init?.headers as Record<string, string> | undefined;
			authByUrl.set(url, headers?.Authorization);
			if (url === "http://127.0.0.1:4001/model_group/info") {
				return new Response("{}", { status: 401 });
			}
			if (url === "http://127.0.0.1:4001/v2/model/info") {
				return new Response("{}", { status: 500 });
			}
			if (url === "http://127.0.0.1:4001/model/info" || url === "http://127.0.0.1:4001/v1/model/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://127.0.0.1:4001/v1/models") {
				return Response.json({ data: [{ id: "fallback-model" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		expect(authByUrl.get("http://127.0.0.1:4001/model_group/info")).toBe("Bearer sk-1234");
		expect(authByUrl.get("http://127.0.0.1:4001/v2/model/info")).toBe("Bearer sk-1234");
		expect(authByUrl.get("http://127.0.0.1:4001/model/info")).toBe("Bearer sk-1234");
		expect(authByUrl.get("http://127.0.0.1:4001/v1/model/info")).toBe("Bearer sk-1234");
		expect(authByUrl.get("http://127.0.0.1:4001/v1/models")).toBe("Bearer sk-1234");
		expect(registry.getProviderDiscoveryState("litellm-test")?.status).toBe("ok");
		expect(registry.find("litellm-test", "fallback-model")?.baseUrl).toBe("http://127.0.0.1:4001/v1");
	});

	test("litellm discovery rejects invalid rich limits and falls back safely", async () => {
		writeRawModelsJson({
			"litellm-test": {
				baseUrl: "http://127.0.0.1:4002/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "litellm" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4002/model_group/info") {
				return Response.json({
					data: [{ model_group: "bad-limits", max_input_tokens: 0, max_output_tokens: "nope" }],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const model = registry.find("litellm-test", "bad-limits");

		expect(model?.contextWindow).toBe(128000);
		expect(model?.maxTokens).toBe(32768);
	});

	test("litellm discovery accepts v2 model info when model_group info is absent", async () => {
		writeRawModelsJson({
			"litellm-test": {
				baseUrl: "http://127.0.0.1:4003/v1",
				api: "openai-completions",
				auth: "none",
				discovery: { type: "litellm" },
			},
		});
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:4003/model_group/info") {
				return new Response("{}", { status: 404 });
			}
			if (url === "http://127.0.0.1:4003/v2/model/info") {
				return Response.json({
					data: [
						{
							model_name: "team-gpt",
							model_info: { id: "deployment-id", max_input_tokens: 200_000, max_output_tokens: 12_000 },
						},
					],
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		expect(registry.find("litellm-test", "team-gpt")?.contextWindow).toBe(200_000);
		expect(registry.find("litellm-test", "deployment-id")).toBeUndefined();
	});

	test("startup restores a legacy stale-marked Copilot -1m variant via requestModelId", async () => {
		// Regression for #6037/#6284: a synthesized Copilot `-1m` long-context
		// variant keeps the base model's transport headers via `requestModelId`.
		// The v10 cache omits headers, and legacy rows written by the old id-only
		// writer flag the variant unrestorable (its base is a different id). The
		// startup loader must still recover the headers from the bundled base and
		// keep the model selectable instead of dropping it.
		const bundledBase = getBundledModel("github-copilot", "gpt-5.6-sol");
		if (!bundledBase?.headers) {
			throw new Error("Expected bundled Copilot base to carry transport headers");
		}
		const cachedVariant = buildModel({
			...(bundledBase as ModelSpec<"openai-responses">),
			id: "gpt-5.6-sol-1m",
			name: "GPT-5.6 Sol (1M)",
			requestModelId: "gpt-5.6-sol",
			contextWindow: 1_050_000,
		});
		// Emulate a legacy write: the variant has no same-id static header source,
		// so it is flagged unrestorable even though its base carries the headers.
		authStorage.setRuntimeApiKey("github-copilot", "ghp_test_token");
		const cacheProviderId = resolveModelCacheProviderId("github-copilot", { apiKey: "ghp_test_token" });
		writeModelCache(cacheProviderId, Date.now(), [cachedVariant], true, "", cacheDbPath);
		const db = new Database(cacheDbPath);
		db.run("UPDATE model_cache SET header_restore_version = 0 WHERE provider_id = ?", [cacheProviderId]);
		db.close();

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.hydrateCredentialScopedModelCaches();

		const restored = registry.find("github-copilot", "gpt-5.6-sol-1m");
		expect(restored?.headers).toEqual(bundledBase.headers);
	});

	test("startup drops a current Copilot alias whose headers differ from its bundled base", () => {
		const bundledBase = getBundledModel("github-copilot", "gpt-5.6-sol");
		if (!bundledBase?.headers) {
			throw new Error("Expected bundled Copilot base to carry transport headers");
		}
		const cachedAlias = buildModel({
			...(bundledBase as ModelSpec<"openai-responses">),
			id: "gpt-5.6-sol-custom",
			name: "GPT-5.6 Sol Custom Route",
			requestModelId: "gpt-5.6-sol",
			headers: { "X-Tenant-Route": "tenant-a" },
		});
		const cacheProviderId = resolveModelCacheProviderId("github-copilot");
		writeModelCache(cacheProviderId, Date.now(), [cachedAlias], true, "", cacheDbPath, [bundledBase]);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);

		expect(registry.find("github-copilot", cachedAlias.id)).toBeUndefined();
		expect(registry.find("github-copilot", bundledBase.id)?.headers).toEqual(bundledBase.headers);
	});
});
