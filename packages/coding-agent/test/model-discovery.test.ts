import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { writeModelCache } from "@pk-nerdsaver-ai/pi-catalog/model-cache";
import type { OpenAICompat } from "@pk-nerdsaver-ai/pi-catalog/types";
import { kNoAuth, ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("ModelRegistry runtime discovery", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let cacheDbPath: string;
	let authStorage: AuthStorage;
	let originalOllamaBaseUrl: string | undefined;
	let originalOllamaHost: string | undefined;
	let originalOllamaContextLength: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalOllamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
		originalOllamaHost = Bun.env.OLLAMA_HOST;
		originalOllamaContextLength = Bun.env.OLLAMA_CONTEXT_LENGTH;
		delete Bun.env.OLLAMA_BASE_URL;
		delete Bun.env.OLLAMA_HOST;
		delete Bun.env.OLLAMA_CONTEXT_LENGTH;
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
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function writeCachedOllamaModels(models: Model<"openai-completions">[], updatedAt = Date.now()) {
		writeModelCache("ollama", updatedAt, models, true, "", cacheDbPath);
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function withEnv(name: "OLLAMA_BASE_URL" | "OLLAMA_CONTEXT_LENGTH" | "OLLAMA_HOST", value: string | undefined) {
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

	test("auto-discovers ollama models without provider config", async () => {
		const fetchMock = mockOllamaDiscovery(["phi4-mini"]);
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();
		const ollamaModels = getModelsForProvider(registry, "ollama");
		expect(ollamaModels.some(m => m.id === "phi4-mini")).toBe(true);
		expect(registry.getAvailable().some(m => m.provider === "ollama" && m.id === "phi4-mini")).toBe(true);
		expect(await registry.getApiKey(ollamaModels[0])).toBe(kNoAuth);
	});

	test("uses OLLAMA_HOST for implicit ollama discovery", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", undefined);
		using _host = withEnv("OLLAMA_HOST", "ollama.lan:12345");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://ollama.lan:12345");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://ollama.lan:12345/v1");
	});

	test("keeps OLLAMA_BASE_URL precedence over OLLAMA_HOST", async () => {
		using _baseUrl = withEnv("OLLAMA_BASE_URL", "http://omp-ollama.example:2222");
		using _host = withEnv("OLLAMA_HOST", "ollama-host.example:3333");
		const fetchMock = mockOllamaDiscovery(["phi4-mini"], "http://omp-ollama.example:2222");
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		const model = registry.find("ollama", "phi4-mini");
		expect(model?.baseUrl).toBe("http://omp-ollama.example:2222/v1");
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
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortMap: { [Effort.Minimal]: Effort.Low },
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
		expect(apiKey).not.toBe(kNoAuth);
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
	test("llama.cpp discovery reads context window from props n_ctx", async () => {
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
		expect(llama?.maxTokens).toBe(32_768);
		expect(llama?.input).toEqual(["text", "image"]);
	});
	test("llama.cpp discovery prefers per-model meta n_ctx over props", async () => {
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
		expect(registry.find("llama.cpp", "ctx-train")?.contextWindow).toBe(65536);
		expect(registry.find("llama.cpp", "unloaded")?.contextWindow).toBe(128000);
	});

	test("llama.cpp selected model refresh patches newly loaded meta n_ctx", async () => {
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
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		const stale = registry.find("llama.cpp", "sleeping-model");
		if (!stale) throw new Error("cached llama.cpp model missing");
		expect(stale.contextWindow).toBe(128000);
		const refreshed = await registry.refreshSelectedModelMetadata(stale);
		expect(refreshed.contextWindow).toBe(239104);
		expect(refreshed.maxTokens).toBe(32768);
		expect(registry.find("llama.cpp", "sleeping-model")?.contextWindow).toBe(239104);
	});

	test("llama.cpp selected model refresh does not resolve command api keys", async () => {
		const commandLogPath = path.join(tempDir, "llama-cpp-key-command.log");
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
				return Response.json({ data: [{ id: "default-litellm" }] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		};
		const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
		await registry.refresh();

		expect(registry.find("litellm-test", "default-litellm")?.baseUrl).toBe("http://localhost:4000/v1");
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
});
