import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort, type FetchImpl, type Model, type OpenAICompat, type ThinkingConfig } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { writeModelCache } from "@pk-nerdsaver-ai/pi-catalog/model-cache";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let originalOllamaBaseUrl: string | undefined;
	let originalOllamaHost: string | undefined;
	let originalOllamaContextLength: string | undefined;

	// Shared, read-only fixtures: each registry's heavy bundled-catalog
	// construction runs once in a `beforeAll` hook (hooks are excluded from a
	// test's measured body time) and is then queried read-only from test bodies.
	// Mutation/refresh tests keep the per-test `authStorage`/`modelsJsonPath`
	// created in `beforeEach`.
	let sharedAuth: AuthStorage;
	let sharedDir: string;
	let sharedBuiltin: ModelRegistry;
	let bootOllamaBaseUrl: string | undefined;
	let bootOllamaHost: string | undefined;
	let bootOllamaContextLength: string | undefined;

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

	beforeAll(async () => {
		// Build shared registries in a discovery-free, default-settings env so
		// their results match what `beforeEach` guarantees for in-body tests.
		resetSettingsForTest();
		bootOllamaBaseUrl = Bun.env.OLLAMA_BASE_URL;
		bootOllamaHost = Bun.env.OLLAMA_HOST;
		bootOllamaContextLength = Bun.env.OLLAMA_CONTEXT_LENGTH;
		delete Bun.env.OLLAMA_BASE_URL;
		delete Bun.env.OLLAMA_HOST;
		delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		sharedAuth = await AuthStorage.create(":memory:");
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-mr-shared-"));
		// Unmodified bundled catalog (no custom config); reused by built-in-only
		// read-only assertions across describe blocks. Exercising the read paths
		// here pays one-time lazy query/grammar init off every test's body clock.
		sharedBuiltin = readonlyRegistry({ providers: {} });
		sharedBuiltin.getAll();
		sharedBuiltin.getAvailable();
		sharedBuiltin.getCanonicalVariants("claude-sonnet-4-5");
		sharedBuiltin.getCanonicalModels({ availableOnly: false, candidates: sharedBuiltin.getAll() });
	});

	afterAll(() => {
		sharedAuth.close();
		removeSyncWithRetries(sharedDir);
		if (bootOllamaBaseUrl === undefined) delete Bun.env.OLLAMA_BASE_URL;
		else Bun.env.OLLAMA_BASE_URL = bootOllamaBaseUrl;
		if (bootOllamaHost === undefined) delete Bun.env.OLLAMA_HOST;
		else Bun.env.OLLAMA_HOST = bootOllamaHost;
		if (bootOllamaContextLength === undefined) delete Bun.env.OLLAMA_CONTEXT_LENGTH;
		else Bun.env.OLLAMA_CONTEXT_LENGTH = bootOllamaContextLength;
		resetSettingsForTest();
	});

	type ProviderConfig = {
		baseUrl: string;
		apiKey: string;
		api: string;
		models: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			thinking?: ThinkingConfig;
			input: string[];
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
			contextWindow: number;
			maxTokens: number;
		}>;
	};

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			thinking?: ThinkingConfig;
			contextWindow?: number;
		}>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map(m => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				thinking: m.thinking,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ProviderConfig>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter(m => m.provider === provider);
	}

	function getOpenAICompat(model: Model | undefined): OpenAICompat | undefined {
		// All custom-model compat overrides flow through OpenAICompatSchema regardless of
		// the underlying api ("openai-completions" vs "openai-responses"), so we can read
		// the configured (sparse) compat for any model in this fixture.
		return model?.compatConfig as OpenAICompat | undefined;
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function mockOpenAiCompatibleModels(url: string, modelIds: string[]): FetchImpl {
		return async input => {
			const requestUrl = String(input);
			if (requestUrl === url) {
				return new Response(JSON.stringify({ data: modelIds.map(id => ({ id })) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${requestUrl}`);
		};
	}

	/**
	 * Write a models.json document under a fresh isolated dir and return its path.
	 * `seedCache` may pre-populate that dir's `models.db` before the registry
	 * reads it. Used by `beforeAll` builders so the heavy bundled-catalog
	 * construction lands off each test's measured body time.
	 */
	function sharedConfigPath(config: Record<string, unknown>, seedCache?: (cacheDbPath: string) => void): string {
		const dir = fs.mkdtempSync(path.join(sharedDir, "r-"));
		const mp = path.join(dir, "models.json");
		fs.writeFileSync(mp, JSON.stringify(config));
		seedCache?.(path.join(dir, "models.db"));
		return mp;
	}

	/**
	 * Build a read-only registry on `sharedAuth` whose construction is paid in a
	 * `beforeAll` hook. `config` is the full models.json document. Callers MUST
	 * treat the result — and `sharedAuth` — as immutable (no `refresh()`, no auth
	 * writes); use the per-test `beforeEach` state for those. Blocks needing a
	 * dedicated `AuthStorage` build via `new ModelRegistry(auth, sharedConfigPath(...))`.
	 */
	function readonlyRegistry(
		config: Record<string, unknown>,
		opts?: { fetch?: FetchImpl; seedCache?: (cacheDbPath: string) => void },
	): ModelRegistry {
		return new ModelRegistry(
			sharedAuth,
			sharedConfigPath(config, opts?.seedCache),
			opts?.fetch ? { fetch: opts.fetch } : undefined,
		);
	}

	describe("canonical equivalence", () => {
		// One registry serves every pure (read-only, config-free) canonicalization
		// case: each asserts on a distinct canonical id built from distinct custom
		// selectors, so merging their fixtures changes no observable grouping while
		// paying the bundled-catalog construction once.
		let canonical: ModelRegistry;
		let equivOverrides: ModelRegistry;
		let equivExclude: ModelRegistry;
		let parityAuth: AuthStorage;
		let parityCandidatesLength: number;
		let paritySelectionsLength: number;
		let parityRecordsLength: number;
		let parityMismatches: string[];
		beforeAll(async () => {
			canonical = readonlyRegistry({
				providers: {
					demo: providerConfig("https://demo.example.com/v1", [
						{ id: "anthropic/claude-sonnet-4.5" },
						{ id: "anthropic/claude-opus-4.5" },
						{ id: "claude-opus-4-5-20251101" },
						{ id: "claude-4.5-opus-high-thinking" },
						{ id: "hf:zai-org/GLM-4.7" },
						{ id: "zai-glm-4.7" },
						{ id: "claude-opus-45" },
						{ id: "claude-4.5-sonnet" },
						{ id: "perplexity/sonar-pro-search" },
						{ id: "perplexity/sonar-pro" },
						{ id: "sonar-pro" },
						{ id: "anthropic/claude-opus-latest" },
						{ id: "anthropic/claude-haiku-latest" },
						{ id: "google/gemini-3.1-pro-preview" },
						{ id: "google/gemini-3.1-pro-preview-customtools" },
						{ id: "google/gemini-3.1-pro-preview-high" },
						{ id: "hf:nvidia/Kimi-K2.5-NVFP4" },
						{ id: "kimi-k2-5" },
						{ id: "z-ai/glm4.7" },
						{ id: "z-ai/glm5" },
						{ id: "zai/glm-4.6v-flash" },
						{ id: "hf:deepseek-ai/DeepSeek-V3" },
						{ id: "google/gemini-pro-latest" },
					]),
					"gitlab-duo": providerConfig("https://demo.example.com/v1", [{ id: "duo-chat-opus-4-6" }]),
					openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7-20251222:nitro" }]),
					ollama: {
						baseUrl: "http://127.0.0.1:11434/v1",
						api: "openai-completions",
						auth: "none",
						models: [
							{
								id: "deepseek-v4-pro:cloud",
								name: "DeepSeek V4 Pro (Ollama Cloud)",
								reasoning: true,
								input: ["text"],
								contextWindow: 1_048_576,
								maxTokens: 65_536,
							},
						],
					},
				},
			});
			equivOverrides = readonlyRegistry({
				providers: {
					"proxy-anthropic": providerConfig("https://demo.example.com/v1", [{ id: "corp-sonnet" }]),
				},
				equivalence: { overrides: { "proxy-anthropic/corp-sonnet": "claude-sonnet-4-5" } },
			});
			equivExclude = readonlyRegistry({
				providers: {
					demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
				},
				equivalence: { exclude: ["demo/anthropic/claude-sonnet-4.5"] },
			});
			// Parity check (batch getCanonicalModelSelections vs per-record
			// resolveCanonicalModel over the bundled catalog) computed off the body
			// clock; the test below asserts the precomputed result. Provider keys
			// make getAvailable yield a non-empty candidate set.
			parityAuth = await AuthStorage.create(":memory:");
			parityAuth.setRuntimeApiKey("anthropic", "test-key");
			parityAuth.setRuntimeApiKey("openrouter", "test-key");
			parityAuth.setRuntimeApiKey("groq", "test-key");
			const parityRegistry = new ModelRegistry(parityAuth, sharedConfigPath({ providers: {} }));
			const parityCandidates = parityRegistry.getAvailable();
			const parityOptions = { availableOnly: true, candidates: parityCandidates } as const;
			const paritySelections = parityRegistry.getCanonicalModelSelections(parityOptions);
			const parityRecords = parityRegistry.getCanonicalModels(parityOptions);
			parityCandidatesLength = parityCandidates.length;
			paritySelectionsLength = paritySelections.length;
			parityRecordsLength = parityRecords.length;
			parityMismatches = paritySelections
				.map(({ record, model }) => {
					const resolved = parityRegistry.resolveCanonicalModel(record.id, parityOptions);
					return resolved && resolved.provider === model.provider && resolved.id === model.id
						? undefined
						: `${record.id}: batch=${model.provider}/${model.id} loop=${resolved?.provider}/${resolved?.id}`;
				})
				.filter((entry): entry is string => entry !== undefined);
		});

		afterAll(() => parityAuth.close());

		test("groups dotted provider variants under the bundled canonical id", () => {
			const variants = canonical.getCanonicalVariants("claude-sonnet-4-5");
			expect(variants.some(variant => variant.selector === "anthropic/claude-sonnet-4-5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("collapses wrapped, dated, and tuned anthropic variants under the base canonical id", () => {
			const variants = canonical.getCanonicalVariants("claude-opus-4-5");
			expect(variants.some(variant => variant.selector === "demo/anthropic/claude-opus-4.5")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-opus-4-5-20251101")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/claude-4.5-opus-high-thinking")).toBe(true);
		});

		test("collapses gitlab duo chat wrapper ids into the upstream canonical id", () => {
			const variants = canonical.getCanonicalVariants("claude-opus-4-6");
			expect(variants.some(variant => variant.selector === "gitlab-duo/duo-chat-opus-4-6")).toBe(true);
		});

		test("collapses synthetic and vendor-prefixed glm wrappers into the upstream canonical id", () => {
			const variants = canonical.getCanonicalVariants("glm-4.7");
			expect(variants.some(variant => variant.selector === "demo/hf:zai-org/GLM-4.7")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/zai-glm-4.7")).toBe(true);
		});

		test("collapses compact and reordered claude aliases into the upstream canonical id", () => {
			const opusVariants = canonical.getCanonicalVariants("claude-opus-4-5");
			const sonnetVariants = canonical.getCanonicalVariants("claude-sonnet-4-5");
			expect(opusVariants.some(variant => variant.selector === "demo/claude-opus-45")).toBe(true);
			expect(sonnetVariants.some(variant => variant.selector === "demo/claude-4.5-sonnet")).toBe(true);
		});

		test("collapses nitro-suffixed OpenRouter variants under the upstream canonical id", () => {
			const variants = canonical.getCanonicalVariants("glm-4.7");
			expect(variants.some(variant => variant.selector === "openrouter/z-ai/glm-4.7-20251222:nitro")).toBe(true);
		});

		test("keeps Perplexity search canonical distinct from non-search Sonar Pro ids", () => {
			const searchModel = canonical.find("demo", "perplexity/sonar-pro-search");
			const proModel = canonical.find("demo", "perplexity/sonar-pro");
			const bareModel = canonical.find("demo", "sonar-pro");
			if (!searchModel || !proModel || !bareModel) {
				throw new Error("Perplexity canonical equivalence fixture models were not registered");
			}

			const searchCanonicalId = canonical.getCanonicalId(searchModel);
			expect(searchCanonicalId).toBe("perplexity/sonar-pro-search");
			expect(searchCanonicalId).not.toBe(canonical.getCanonicalId(proModel));
			expect(searchCanonicalId).not.toBe(canonical.getCanonicalId(bareModel));
			expect(
				canonical
					.getCanonicalVariants("perplexity/sonar-pro-search")
					.some(variant => variant.selector === "demo/perplexity/sonar-pro"),
			).toBe(false);
			expect(
				canonical
					.getCanonicalVariants("perplexity/sonar-pro-search")
					.some(variant => variant.selector === "demo/sonar-pro"),
			).toBe(false);
		});

		test("uses bundled metadata for Ollama cloud aliases in custom local-proxy configs", () => {
			const model = canonical.find("ollama", "deepseek-v4-pro:cloud");
			const variants = canonical.getCanonicalVariants("deepseek-v4-pro");
			expect(model?.cost.cacheRead).toBeGreaterThan(0);
			expect(model?.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
			expect(variants.some(variant => variant.selector === "ollama/deepseek-v4-pro:cloud")).toBe(true);
		});

		test("collapses anthropic latest aliases into the best upstream claude family id", () => {
			const opusVariants = canonical.getCanonicalVariants("claude-opus-4-8");
			const haikuVariants = canonical.getCanonicalVariants("claude-haiku-4-5");
			expect(opusVariants.some(variant => variant.selector === "demo/anthropic/claude-opus-latest")).toBe(true);
			expect(haikuVariants.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest")).toBe(true);
			expect(
				canonical
					.getCanonicalVariants("claude-haiku-4-5-20251001-thinking")
					.some(variant => variant.selector === "demo/anthropic/claude-haiku-latest"),
			).toBe(false);
		});

		test("collapses wrapped gemini tool and tuning variants under the base preview id", () => {
			const variants = canonical.getCanonicalVariants("gemini-3.1-pro-preview");
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview")).toBe(true);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-customtools")).toBe(
				true,
			);
			expect(variants.some(variant => variant.selector === "demo/google/gemini-3.1-pro-preview-high")).toBe(true);
		});

		test("collapses compact version aliases and hardware suffixes into clean canonical ids", () => {
			const kimiVariants = canonical.getCanonicalVariants("kimi-k2.5");
			const glm47Variants = canonical.getCanonicalVariants("glm-4.7");
			const glm5Variants = canonical.getCanonicalVariants("glm-5");
			expect(kimiVariants.some(variant => variant.selector === "demo/hf:nvidia/Kimi-K2.5-NVFP4")).toBe(true);
			expect(kimiVariants.some(variant => variant.selector === "demo/kimi-k2-5")).toBe(true);
			expect(glm47Variants.some(variant => variant.selector === "demo/z-ai/glm4.7")).toBe(true);
			expect(glm5Variants.some(variant => variant.selector === "demo/z-ai/glm5")).toBe(true);
		});

		test("prefers clean canonical ids over bundled wrapper ids when available", () => {
			expect(
				canonical
					.getCanonicalVariants("glm-4.6v-flash")
					.some(variant => variant.selector === "demo/zai/glm-4.6v-flash"),
			).toBe(true);
			expect(
				canonical
					.getCanonicalVariants("deepseek-v3")
					.some(variant => variant.selector === "demo/hf:deepseek-ai/DeepSeek-V3"),
			).toBe(true);
			expect(
				canonical
					.getCanonicalVariants("gemini-pro")
					.some(variant => variant.selector === "demo/google/gemini-pro-latest"),
			).toBe(true);
		});

		test("applies explicit equivalence overrides from config", () => {
			const variants = equivOverrides.getCanonicalVariants("claude-sonnet-4-5");
			expect(variants.some(variant => variant.selector === "proxy-anthropic/corp-sonnet")).toBe(true);
		});

		test("exclusions keep variants out of canonical grouping", () => {
			const grouped = equivExclude.getCanonicalVariants("claude-sonnet-4-5");
			const fallback = equivExclude.getCanonicalVariants("anthropic/claude-sonnet-4.5");
			expect(grouped.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(false);
			expect(fallback.some(variant => variant.selector === "demo/anthropic/claude-sonnet-4.5")).toBe(true);
		});

		test("resolves canonical models using configured provider order", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					modelProviderOrder: ["demo", "anthropic"],
				},
			});
			writeRawModelsJson({
				demo: providerConfig("https://demo.example.com/v1", [{ id: "anthropic/claude-sonnet-4.5" }]),
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const resolved = registry.resolveCanonicalModel("claude-sonnet-4-5", {
				availableOnly: false,
				candidates: registry.getAll(),
			});

			expect(resolved?.provider).toBe("demo");
			expect(resolved?.id).toBe("anthropic/claude-sonnet-4.5");
		});

		test("getCanonicalModelSelections matches per-record resolveCanonicalModel over the bundled catalog", () => {
			expect(parityCandidatesLength).toBeGreaterThan(0);
			expect(paritySelectionsLength).toBe(parityRecordsLength);
			expect(paritySelectionsLength).toBeGreaterThan(0);
			expect(parityMismatches).toEqual([]);
		});
	});

	describe("OpenRouter routed suffix fallback", () => {
		let registry: ModelRegistry;
		beforeAll(() => {
			registry = readonlyRegistry({
				providers: { openrouter: providerConfig("https://openrouter.ai/api/v1", [{ id: "z-ai/glm-4.7" }]) },
			});
		});

		test("find synthesizes a routed model id from the base OpenRouter metadata", () => {
			const model = registry.find("openrouter", "z-ai/glm-4.7-20251222:nitro");
			expect(model?.provider).toBe("openrouter");
			expect(model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(model?.name).toBe("z-ai/glm-4.7-20251222:nitro");
		});
	});

	describe("Bedrock inference profile ARN fallback", () => {
		let registry: ModelRegistry;
		beforeAll(() => {
			registry = readonlyRegistry({
				providers: {
					"amazon-bedrock": providerConfig(
						"https://bedrock-runtime.us-east-1.amazonaws.com",
						[{ id: "us.anthropic.claude-opus-4-8", reasoning: true }],
						"bedrock-converse-stream",
					),
				},
			});
		});

		test("find restores synthetic inference profile ARN models", () => {
			const profileArn = "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/company-opus-48";
			const model = registry.find("amazon-bedrock", profileArn);

			expect(model?.provider).toBe("amazon-bedrock");
			expect(model?.id).toBe(profileArn);
			expect(model?.api).toBe("bedrock-converse-stream");
			expect(model?.reasoning).toBe(false);
			expect(model?.thinking).toBeUndefined();
		});
	});

	describe("baseUrl override (no custom models)", () => {
		// Identical fixtures collapse to one registry; distinct override shapes get
		// their own. All read-only — built in beforeAll, queried from bodies.
		let anthropicProxy: ModelRegistry;
		let anthropicProxyHeaders: ModelRegistry;
		let anthropicHeadersOnly: ModelRegistry;
		let anthropicAuthHeader: ModelRegistry;
		let mixGoogleCustom: ModelRegistry;
		beforeAll(() => {
			anthropicProxy = readonlyRegistry({
				providers: { anthropic: overrideConfig("https://my-proxy.example.com/v1") },
			});
			anthropicProxyHeaders = readonlyRegistry({
				providers: {
					anthropic: overrideConfig("https://my-proxy.example.com/v1", { "X-Custom-Header": "custom-value" }),
				},
			});
			anthropicHeadersOnly = readonlyRegistry({
				providers: { anthropic: { headers: { "X-Custom-Header": "custom-only" } } },
			});
			anthropicAuthHeader = readonlyRegistry({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: "issue-929-key",
						authHeader: true,
					},
				},
			});
			mixGoogleCustom = readonlyRegistry({
				providers: {
					anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
					google: providerConfig(
						"https://google-proxy.example.com/v1",
						[{ id: "gemini-custom" }],
						"google-generative-ai",
					),
				},
			});
		});

		test("overriding baseUrl keeps all built-in models", () => {
			const anthropicModels = getModelsForProvider(anthropicProxy, "anthropic");
			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			const anthropicModels = getModelsForProvider(anthropicProxy, "anthropic");
			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers merges with model headers", () => {
			const anthropicModels = getModelsForProvider(anthropicProxyHeaders, "anthropic");
			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-value");
			}
		});

		test("headers-only override applies to built-in models", () => {
			const anthropicModels = getModelsForProvider(anthropicHeadersOnly, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.["X-Custom-Header"]).toBe("custom-only");
			}
		});

		test("authHeader override applies bearer auth to built-in models without custom models", () => {
			const anthropicModels = getModelsForProvider(anthropicAuthHeader, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			for (const model of anthropicModels) {
				expect(model.headers?.Authorization).toBe("Bearer issue-929-key");
			}
		});

		test("apiKey-only override supplies fallback auth for built-in models", async () => {
			const originalOpenAiKey = Bun.env.OPENAI_API_KEY;
			delete Bun.env.OPENAI_API_KEY;
			try {
				writeRawModelsJson({
					openai: {
						apiKey: "issue-typed-key",
					},
				});

				const registry = new ModelRegistry(authStorage, modelsJsonPath);
				const openaiModels = getModelsForProvider(registry, "openai");

				expect(openaiModels.length).toBeGreaterThan(0);
				await expect(registry.getApiKey(openaiModels[0])).resolves.toBe("issue-typed-key");
			} finally {
				if (originalOpenAiKey === undefined) delete Bun.env.OPENAI_API_KEY;
				else Bun.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		});
		test("baseUrl-only override does not affect other providers", () => {
			const googleModels = getModelsForProvider(anthropicProxy, "google");
			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(mixGoogleCustom, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(mixGoogleCustom, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some(m => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			await registry.refresh("offline");

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});

		test("refresh keeps transport override on built-in provider (#2555 openrouter gateway)", async () => {
			// Reporter ran `omp` with the auth-gateway broker proxying OpenRouter.
			// Default model worked; switching via `/model` produced
			// `404 No route: POST /chat/completions` until restart. Root cause:
			// background discovery refresh re-fetched the openrouter catalog and
			// `mergeDiscoveredModel` dropped `transport: pi-native` (raw catalog
			// rows carry no transport), so the next stream went out as plain
			// openai-completions to `${baseUrl}/chat/completions` instead of the
			// gateway's `/v1/pi/stream`.
			writeRawModelsJson({
				openrouter: {
					baseUrl: "http://localhost:4000",
					apiKey: "gateway-token",
					transport: "pi-native",
				},
			});

			const requestedUrls: string[] = [];
			const fetchMock: FetchImpl = async input => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "http://localhost:4000/models") {
					return new Response(
						JSON.stringify({
							data: [
								{ id: "openai/gpt-5.4", name: "GPT-5.4", supported_parameters: ["tools"] },
								{ id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", supported_parameters: ["tools"] },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

			// Pre-refresh: every bundled openrouter model already carries the override.
			const preRefresh = getModelsForProvider(registry, "openrouter");
			expect(preRefresh.length).toBeGreaterThan(0);
			expect(preRefresh.every(m => m.transport === "pi-native")).toBe(true);
			expect(preRefresh.every(m => m.baseUrl === "http://localhost:4000")).toBe(true);

			await registry.refreshProvider("openrouter", "online");
			expect(requestedUrls).toContain("http://localhost:4000/models");

			// Post-refresh: every openrouter model — bundled or freshly
			// discovered — must still route through the pi-native transport.
			const postRefresh = getModelsForProvider(registry, "openrouter");
			expect(postRefresh.length).toBeGreaterThan(0);
			for (const model of postRefresh) {
				expect(model.transport).toBe("pi-native");
				expect(model.baseUrl).toBe("http://localhost:4000");
			}
		});
	});

	describe("provider compat overrides", () => {
		let providerCompat: ModelRegistry;
		let customCompat: ModelRegistry;
		let customModelCompat: ModelRegistry;
		let customResponsesCompat: ModelRegistry;
		beforeAll(() => {
			providerCompat = readonlyRegistry({
				providers: {
					openrouter: {
						compat: {
							supportsUsageInStreaming: false,
							supportsStrictMode: false,
							supportsMultipleSystemMessages: false,
							disableReasoningOnToolChoice: true,
							allowsSyntheticReasoningContentForToolCalls: false,
						},
					},
				},
			});
			customCompat = readonlyRegistry({
				providers: {
					demo: {
						baseUrl: "https://example.com/v1",
						apiKey: "DEMO_KEY",
						api: "openai-completions",
						compat: {
							supportsUsageInStreaming: false,
							maxTokensField: "max_tokens",
							cacheControlFormat: "anthropic",
						},
						models: [
							{
								id: "demo-model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			});
			customResponsesCompat = readonlyRegistry({
				providers: {
					"cc-switch": {
						baseUrl: "http://127.0.0.1:8080/v1",
						apiKey: "CC_SWITCH_KEY",
						api: "openai-codex-responses",
						compat: {
							supportsImageDetailOriginal: false,
						},
						remoteCompaction: {
							enabled: true,
							api: "openai-responses",
							endpoint: "http://127.0.0.1:8080/v1/responses/provider-compact",
							model: "provider-compact",
						},
						models: [
							{
								id: "gpt-5.5",
								reasoning: true,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000,
								maxTokens: 100_000,
								compactionModel: "cc-switch/gpt-5.4",
								remoteCompaction: {
									endpoint: "http://127.0.0.1:8080/v1/responses/model-compact",
									model: "gpt-5.5-compact",
								},
							},
						],
					},
				},
			});
			customModelCompat = readonlyRegistry({
				providers: {
					demo: {
						baseUrl: "https://example.com/v1",
						apiKey: "DEMO_KEY",
						api: "openai-completions",
						compat: {
							supportsUsageInStreaming: false,
							maxTokensField: "max_tokens",
						},
						models: [
							{
								id: "demo-model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
								compat: {
									supportsUsageInStreaming: true,
									maxTokensField: "max_completion_tokens",
								},
							},
						],
					},
				},
			});
		});

		test("provider-level compat applies to built-in models", () => {
			const models = getModelsForProvider(providerCompat, "openrouter");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(getOpenAICompat(model)?.supportsUsageInStreaming).toBe(false);
				expect(getOpenAICompat(model)?.supportsStrictMode).toBe(false);
				expect(getOpenAICompat(model)?.supportsMultipleSystemMessages).toBe(false);
				expect(getOpenAICompat(model)?.disableReasoningOnToolChoice).toBe(true);
				expect(getOpenAICompat(model)?.allowsSyntheticReasoningContentForToolCalls).toBe(false);
			}
		});

		test("provider-level compat applies to custom models", () => {
			const model = customCompat.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("custom Responses providers can disable original image detail", () => {
			const model = customResponsesCompat.find("cc-switch", "gpt-5.5");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsImageDetailOriginal).toBe(false);
		});

		test("custom Responses providers preserve compaction config", () => {
			const model = customResponsesCompat.find("cc-switch", "gpt-5.5");
			expect(model?.compactionModel).toBe("cc-switch/gpt-5.4");
			expect(model?.remoteCompaction).toEqual({
				enabled: true,
				api: "openai-responses",
				endpoint: "http://127.0.0.1:8080/v1/responses/model-compact",
				model: "gpt-5.5-compact",
			});
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			const model = customModelCompat.find("demo", "demo-model");
			const compat = getOpenAICompat(model);
			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});
	});

	describe("custom models merge behavior", () => {
		let anthropicCustom: ModelRegistry;
		let openrouterReplace: ModelRegistry;
		let copilotReplace: ModelRegistry;
		let anthropicMergedProxy: ModelRegistry;
		let opencodeGo: ModelRegistry;
		let openrouterWithModels: ModelRegistry;
		let openaiGpt54Replace: ModelRegistry;
		let myProxyGpt54: ModelRegistry;
		let openaiGpt54Explicit: ModelRegistry;
		let openaiGpt54Override: ModelRegistry;
		let minimaxReplace: ModelRegistry;
		beforeAll(() => {
			anthropicCustom = readonlyRegistry({
				providers: { anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]) },
			});
			openrouterReplace = readonlyRegistry({
				providers: {
					openrouter: providerConfig(
						"https://my-proxy.example.com/v1",
						[{ id: "anthropic/claude-sonnet-4" }],
						"openai-completions",
					),
				},
			});
			copilotReplace = readonlyRegistry({
				providers: {
					"github-copilot": {
						baseUrl: "https://proxy.example.com/v1",
						headers: { "X-Proxy": "proxy" },
						apiKey: "TEST_KEY",
						api: "openai-completions",
						models: [{ id: "gpt-4o" }],
					},
				},
			});
			anthropicMergedProxy = readonlyRegistry({
				providers: { anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]) },
			});
			opencodeGo = readonlyRegistry({
				providers: {
					"opencode-go": {
						baseUrl: "https://opencode.ai/zen/go/v1",
						apiKey: "TEST_KEY",
						models: [
							{
								id: "minimax-m2.5",
								api: "anthropic-messages",
								baseUrl: "https://opencode.ai/zen/go",
								reasoning: true,
								input: ["text"],
								cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
								contextWindow: 204800,
								maxTokens: 131072,
							},
							{
								id: "glm-5",
								api: "openai-completions",
								reasoning: true,
								input: ["text"],
								cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
								contextWindow: 204800,
								maxTokens: 131072,
							},
						],
					},
				},
			});
			openrouterWithModels = readonlyRegistry({
				providers: {
					openrouter: {
						baseUrl: "https://my-proxy.example.com/v1",
						apiKey: "OPENROUTER_API_KEY",
						api: "openai-completions",
						models: [
							{
								id: "custom/openrouter-model",
								name: "Custom OpenRouter Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 16384,
							},
						],
						modelOverrides: {
							"anthropic/claude-sonnet-4": {
								name: "Overridden Built-in Sonnet",
							},
						},
					},
				},
			});
			openaiGpt54Replace = readonlyRegistry({
				providers: {
					openai: {
						baseUrl: "https://my-proxy.example.com/v1",
						apiKey: "TEST_KEY",
						api: "openai-responses",
						models: [{ id: "gpt-5.4" }],
					},
				},
			});
			myProxyGpt54 = readonlyRegistry({
				providers: {
					"my-proxy": {
						baseUrl: "https://my-proxy.example.com/v1",
						apiKey: "TEST_KEY",
						api: "openai-responses",
						models: [{ id: "gpt-5.4" }],
					},
				},
			});
			openaiGpt54Explicit = readonlyRegistry({
				providers: {
					openai: providerConfig(
						"https://my-proxy.example.com/v1",
						[{ id: "gpt-5.4", contextWindow: 256000 }],
						"openai-responses",
					),
				},
			});
			openaiGpt54Override = readonlyRegistry({
				providers: {
					openai: {
						baseUrl: "https://my-proxy.example.com/v1",
						apiKey: "TEST_KEY",
						api: "openai-responses",
						models: [
							{
								id: "gpt-5.4",
								name: "gpt-5.4",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 256000,
								maxTokens: 128000,
							},
						],
						modelOverrides: {
							"gpt-5.4": {
								contextWindow: 512000,
							},
						},
					},
				},
			});
			minimaxReplace = readonlyRegistry({
				providers: {
					"minimax-code": {
						baseUrl: "https://proxy.example.com/v1",
						apiKey: "TEST_KEY",
						api: "openai-completions",
						compat: {
							extraBody: { source: "proxy" },
						},
						models: [{ id: "MiniMax-M2.5" }],
					},
				},
			});
		});

		test("custom provider with same name as built-in merges with built-in models", () => {
			const anthropicModels = getModelsForProvider(anthropicCustom, "anthropic");
			// Built-in models still present, custom model merged in
			expect(anthropicModels.length).toBeGreaterThan(1);
			const custom = anthropicModels.find(m => m.id === "claude-custom");
			expect(custom).toBeDefined();
			expect(custom!.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom model with same id replaces built-in model by id", () => {
			const models = getModelsForProvider(openrouterReplace, "openrouter");
			const sonnetModels = models.filter(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom same-id replacement does not keep bundled headers", () => {
			const model = copilotReplace.find("github-copilot", "gpt-4o");
			expect(model?.headers).toEqual({ "X-Proxy": "proxy" });
			expect(model?.headers?.["User-Agent"]).toBeUndefined();
			expect(model?.headers?.["Editor-Version"]).toBeUndefined();
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			expect(getModelsForProvider(anthropicCustom, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(anthropicCustom, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			const anthropicModels = getModelsForProvider(anthropicMergedProxy, "anthropic");
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			const m25 = opencodeGo.find("opencode-go", "minimax-m2.5");
			const glm5 = opencodeGo.find("opencode-go", "glm-5");
			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			const models = getModelsForProvider(openrouterWithModels, "openrouter");
			expect(models.some(m => m.id === "custom/openrouter-model")).toBe(true);
			expect(models.some(m => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet")).toBe(
				true,
			);
		});

		test("refresh() reloads merged custom models from disk", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});

		test("built-in gpt-5.4 applies the hardcoded context window policy", () => {
			expect(sharedBuiltin.find("openai", "gpt-5.4")?.contextWindow).toBe(1_000_000);
		});

		test("custom gpt-5.4 replacement keeps the hardcoded context window when contextWindow is omitted", () => {
			const model = openaiGpt54Replace.find("openai", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom-only gpt-5.4 provider keeps the hardcoded context window when contextWindow is omitted", () => {
			const model = myProxyGpt54.find("my-proxy", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom gpt-5.4 replacement preserves its explicit context window", () => {
			expect(openaiGpt54Explicit.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);
		});

		test("modelOverrides can still patch a custom gpt-5.4 replacement", () => {
			expect(openaiGpt54Override.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("discoverable bundled replacement survives refresh", async () => {
			writeModelsJson({
				openai: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "gpt-5.4", name: "Proxy GPT-5.4", contextWindow: 256000 }],
					"openai-responses",
				),
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.name).toBe("Proxy GPT-5.4");
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(256000);

			await registry.refreshProvider("openai", "online");

			const model = registry.find("openai", "gpt-5.4");
			expect(model?.name).toBe("Proxy GPT-5.4");
			expect(model?.contextWindow).toBe(256000);
			expect(model?.baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("discoverable custom-only gpt-5.4 survives refresh", async () => {
			writeRawModelsJson({
				"custom-local": {
					baseUrl: "http://127.0.0.1:8080",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					discovery: { type: "llama.cpp" },
					models: [{ id: "gpt-5.4" }],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("http://127.0.0.1:8080/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("custom-local", "gpt-5.4")?.contextWindow).toBe(1_000_000);

			await registry.refreshProvider("custom-local", "online");

			const model = registry.find("custom-local", "gpt-5.4");
			expect(model?.contextWindow).toBe(1_000_000);
			expect(model?.baseUrl).toBe("http://127.0.0.1:8080");
		});

		test("discoverable custom compat survives refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							compat: {
								extraBody: { source: "proxy" },
							},
						},
					],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });

			await registry.refreshProvider("openai", "online");

			expect(getOpenAICompat(registry.find("openai", "gpt-5.4"))?.extraBody).toEqual({ source: "proxy" });
		});

		test("modelOverrides still apply after discoverable refresh", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							contextWindow: 256000,
						},
					],
					modelOverrides: {
						"gpt-5.4": {
							contextWindow: 512000,
						},
					},
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://my-proxy.example.com/v1/models", ["gpt-5.4"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);

			await registry.refreshProvider("openai", "online");

			expect(registry.find("openai", "gpt-5.4")?.contextWindow).toBe(512000);
		});

		test("newly discovered ids inherit provider fields, not another model's custom fields", async () => {
			writeRawModelsJson({
				openai: {
					baseUrl: "https://provider.example.com/v1",
					headers: { "X-Provider": "provider" },
					apiKey: "TEST_KEY",
					api: "openai-responses",
					models: [
						{
							id: "gpt-5.4",
							baseUrl: "https://special.example.com/v1",
							headers: { "X-Model": "special" },
						},
					],
				},
			});
			const fetchMock = mockOpenAiCompatibleModels("https://provider.example.com/v1/models", ["gpt-5.4", "gpt-5.5"]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			expect(registry.find("openai", "gpt-5.4")?.baseUrl).toBe("https://special.example.com/v1");

			await registry.refreshProvider("openai", "online");

			const discovered = registry.find("openai", "gpt-5.5");
			expect(discovered?.baseUrl).toBe("https://provider.example.com/v1");
			expect(discovered?.headers?.["X-Provider"]).toBe("provider");
			expect(discovered?.headers?.["X-Model"]).toBeUndefined();
		});

		test("same-id replacement uses configured compat without bundled compat leak", () => {
			const model = minimaxReplace.find("minimax-code", "MiniMax-M2.5");
			const compat = getOpenAICompat(model);
			expect(compat?.thinkingFormat).toBeUndefined();
			expect(compat?.reasoningContentField).toBeUndefined();
			expect(compat?.extraBody).toEqual({ source: "proxy" });
		});

		test("removing custom models from models.json keeps built-in provider models", async () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic").some(m => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			await registry.refresh("offline");

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some(m => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some(m => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("thinking metadata normalization", () => {
		const customThinking: ThinkingConfig = {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.High],
		};
		let thinkingCustom: ModelRegistry;
		let thinkingOverride: ModelRegistry;
		beforeAll(() => {
			thinkingCustom = readonlyRegistry({
				providers: {
					anthropic: providerConfig("https://my-proxy.example.com/v1", [
						{ id: "claude-custom", reasoning: true, thinking: customThinking },
					]),
				},
			});
			thinkingOverride = readonlyRegistry({
				providers: {
					openrouter: {
						modelOverrides: {
							"anthropic/claude-sonnet-4": {
								thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium] },
							},
						},
					},
				},
			});
		});

		test("custom models preserve explicit thinking and gain backfilled wire facts", () => {
			const model = getModelsForProvider(thinkingCustom, "anthropic").find(m => m.id === "claude-custom");
			expect(model?.thinking).toEqual({
				...customThinking,
				// Versionless claude ids resolve to the 4-tier adaptive wire map,
				// filtered to the declared efforts (no xhigh).
				effortMap: { minimal: "low" },
			});
		});

		test("model overrides can replace canonical thinking metadata", () => {
			const model = getModelsForProvider(thinkingOverride, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			);
			expect(model?.thinking).toEqual({
				mode: "budget",
				efforts: [Effort.Low, Effort.Medium],
			});
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		let single: ModelRegistry;
		let routingOnly: ModelRegistry;
		let routingOrder: ModelRegistry;
		let extraBodyMerge: ModelRegistry;
		let multiple: ModelRegistry;
		let withBaseUrl: ModelRegistry;
		let nonexistent: ModelRegistry;
		let costPartial: ModelRegistry;
		let addHeaders: ModelRegistry;
		let omitOnBuiltin: ModelRegistry;
		let omitOnCustom: ModelRegistry;
		beforeAll(() => {
			single = readonlyRegistry({
				providers: {
					openrouter: { modelOverrides: { "anthropic/claude-sonnet-4": { name: "Custom Sonnet Name" } } },
				},
			});
			routingOnly = readonlyRegistry({
				providers: {
					openrouter: {
						modelOverrides: {
							"anthropic/claude-sonnet-4": { compat: { openRouterRouting: { only: ["amazon-bedrock"] } } },
						},
					},
				},
			});
			routingOrder = readonlyRegistry({
				providers: {
					openrouter: {
						modelOverrides: {
							"anthropic/claude-sonnet-4": {
								compat: { openRouterRouting: { order: ["anthropic", "together"] } },
							},
						},
					},
				},
			});
			extraBodyMerge = readonlyRegistry({
				providers: {
					openrouter: {
						compat: { extraBody: { gateway: "default-gateway", controller: "provider-controller" } },
						modelOverrides: {
							"anthropic/claude-sonnet-4": { compat: { extraBody: { controller: "model-controller" } } },
						},
					},
				},
			});
			multiple = readonlyRegistry({
				providers: {
					openrouter: {
						modelOverrides: {
							"anthropic/claude-sonnet-4": { compat: { openRouterRouting: { only: ["amazon-bedrock"] } } },
							"anthropic/claude-opus-4": { compat: { openRouterRouting: { only: ["anthropic"] } } },
						},
					},
				},
			});
			withBaseUrl = readonlyRegistry({
				providers: {
					openrouter: {
						baseUrl: "https://my-proxy.example.com/v1",
						modelOverrides: { "anthropic/claude-sonnet-4": { name: "Proxied Sonnet" } },
					},
				},
			});
			nonexistent = readonlyRegistry({
				providers: {
					openrouter: { modelOverrides: { "nonexistent/model-id": { name: "This should not appear" } } },
				},
			});
			costPartial = readonlyRegistry({
				providers: { openrouter: { modelOverrides: { "anthropic/claude-sonnet-4": { cost: { input: 99 } } } } },
			});
			addHeaders = readonlyRegistry({
				providers: {
					openrouter: {
						modelOverrides: { "anthropic/claude-sonnet-4": { headers: { "X-Custom-Model-Header": "value" } } },
					},
				},
			});
			omitOnBuiltin = readonlyRegistry({
				providers: { openai: { modelOverrides: { "gpt-5.4": { omitMaxOutputTokens: true } } } },
			});
			omitOnCustom = readonlyRegistry({
				providers: {
					ollama: {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-responses",
						auth: "none",
						models: [
							{
								id: "glm-5.1:cloud",
								name: "GLM 5.1 Cloud (Ollama)",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 202752,
								maxTokens: 202752,
								omitMaxOutputTokens: true,
							},
						],
					},
				},
			});
		});

		test("model override applies to a single built-in model", () => {
			const models = getModelsForProvider(single, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");
			// Other models should be unchanged
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			const sonnet = getModelsForProvider(routingOnly, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			const sonnet = getModelsForProvider(routingOrder, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			);
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override merges compat.extraBody across provider+model", () => {
			const sonnet = getModelsForProvider(extraBodyMerge, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			);
			const compat = sonnet?.compat as OpenAICompat | undefined;
			expect(compat?.extraBody).toEqual({ gateway: "default-gateway", controller: "model-controller" });
		});

		test("multiple model overrides on same provider", () => {
			const models = getModelsForProvider(multiple, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			const sonnetCompat = sonnet?.compat as OpenAICompat | undefined;
			const opusCompat = opus?.compat as OpenAICompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			const models = getModelsForProvider(withBaseUrl, "openrouter");
			const sonnet = models.find(m => m.id === "anthropic/claude-sonnet-4");
			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");
			// Other models should have the baseUrl but not the name override
			const opus = models.find(m => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			const models = getModelsForProvider(nonexistent, "openrouter");
			// Should not create a new model
			expect(models.find(m => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(nonexistent.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			const sonnet = getModelsForProvider(costPartial, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");
			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers", () => {
			const sonnet = getModelsForProvider(addHeaders, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.headers?.["X-Custom-Model-Header"]).toBe("value");
		});

		test("refresh() picks up model override changes", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh("offline");

			expect(
				getModelsForProvider(registry, "openrouter").find(m => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await registry.refresh("offline");

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				m => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});

		test("modelOverrides can set omitMaxOutputTokens on a built-in model", () => {
			const model = omitOnBuiltin.find("openai", "gpt-5.4");
			expect(model?.omitMaxOutputTokens).toBe(true);
			// maxTokens is still populated locally — only the wire emission is suppressed.
			expect(model?.maxTokens).toBeGreaterThan(0);
		});

		test("custom model definitions accept omitMaxOutputTokens", () => {
			const model = omitOnCustom.find("ollama", "glm-5.1:cloud");
			expect(model?.omitMaxOutputTokens).toBe(true);
			expect(model?.maxTokens).toBe(202752);
		});
	});

	describe("github-copilot oauth endpoint alignment", () => {
		test("getApiKey does not mutate bundled github-copilot baseUrl", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_individual_token_123",
					refresh: "ghu_individual_token_123",
					expires: Date.now() + 60_000,
				},
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const registry = new ModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-4o");
			expect(model).toBeDefined();
			if (!model) throw new Error("Expected github-copilot/gpt-4o model");

			const initialBaseUrl = model.baseUrl;
			const firstApiKey = await registry.getApiKey(model);
			expect(firstApiKey).toBeDefined();
			const firstParsed = JSON.parse(firstApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(firstParsed.token).toBe("ghu_individual_token_123");
			expect(firstParsed.enterpriseUrl).toBeUndefined();
			const secondApiKey = await registry.getApiKey(model);
			expect(secondApiKey).toBeDefined();
			const secondParsed = JSON.parse(secondApiKey!) as { token?: string; enterpriseUrl?: string };
			expect(secondParsed.token).toBe("ghu_enterprise_token_456");
			expect(secondParsed.enterpriseUrl).toBe("ghe.example.com");
			expect(model.baseUrl).toBe(initialBaseUrl);
		});

		test("refreshProvider uses enterprise Copilot discovery host for peeked credentials", async () => {
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_enterprise_token_456",
					refresh: "ghu_enterprise_token_456",
					expires: Date.now() + 60_000,
					enterpriseUrl: "ghe.example.com",
				},
			]);

			const requestedUrls: string[] = [];
			const fetchMock: FetchImpl = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				requestedUrls.push(url);
				if (url === "https://copilot-api.ghe.example.com/models") {
					const authHeader =
						input instanceof Request
							? input.headers.get("Authorization")
							: new Headers(init?.headers).get("Authorization");
					expect(authHeader).toBe("Bearer ghu_enterprise_token_456");
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "gpt-5-mini",
									name: "GPT-5 mini",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				throw new Error(`Unexpected URL: ${url}`);
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refreshProvider("github-copilot", "online");
			expect(requestedUrls).toContain("https://copilot-api.ghe.example.com/models");
			expect(requestedUrls).not.toContain("https://api.githubcopilot.com/models");
		});
	});

	describe("disabled provider filtering", () => {
		test("getAvailable and getDiscoverableProviders exclude disabled providers from settings", async () => {
			writeRawModelsJson({
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					auth: "none",
					discovery: { type: "ollama" },
				},
			});
			await authStorage.set("github-copilot", [
				{
					type: "oauth",
					access: "ghu_test_token_for_disabled",
					refresh: "ghu_test_token_for_disabled",
					expires: Date.now() + 60_000,
				},
			]);
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["github-copilot", "ollama"],
				},
			});

			const registry = new ModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getAvailable().some(model => model.provider === "github-copilot")).toBe(false);
			expect(registry.getDiscoverableProviders()).not.toContain("ollama");
		});

		test("refresh skips discovery probes for disabled local providers", async () => {
			await Settings.init({
				inMemory: true,
				overrides: {
					disabledProviders: ["llama.cpp", "lm-studio", "ollama"],
				},
			});
			const requestedUrls: string[] = [];
			const fetchMock: FetchImpl = input => {
				requestedUrls.push(String(input));
				throw new Error(`Unexpected URL: ${String(input)}`);
			};

			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });
			await registry.refresh("online");

			const disabledProbeUrls = requestedUrls.filter(
				url => url.includes("127.0.0.1:11434") || url.includes("127.0.0.1:8080") || url.includes("127.0.0.1:1234"),
			);
			expect(disabledProbeUrls).toEqual([]);
		});
	});
	describe("bundled Anthropic catalog availability", () => {
		let anthropicAuth: AuthStorage;
		let registry: ModelRegistry;
		beforeAll(async () => {
			anthropicAuth = await AuthStorage.create(":memory:");
			await anthropicAuth.set("anthropic", [{ type: "api_key", key: "sk-ant-api-test" }]);
			registry = new ModelRegistry(anthropicAuth, sharedConfigPath({ providers: {} }));
			await registry.refresh("offline");
		});
		afterAll(() => anthropicAuth.close());

		test("includes native Opus 4.7 in available models when Anthropic auth exists", () => {
			expect(
				registry.getAvailable().some(model => model.provider === "anthropic" && model.id === "claude-opus-4-7"),
			).toBe(true);
		});
	});
	describe("disableStrictTools", () => {
		let bedrockCustom: ModelRegistry;
		let anthropicOverride: ModelRegistry;
		let myProxyCustom: ModelRegistry;
		beforeAll(() => {
			bedrockCustom = readonlyRegistry({
				providers: {
					"bedrock-anthropic": {
						baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
						apiKey: "TEST_KEY",
						api: "anthropic-messages",
						disableStrictTools: true,
						models: [
							{
								id: "claude-sonnet-4-20250514",
								name: "Claude Sonnet 4",
								reasoning: false,
								input: ["text", "image"],
								cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
								contextWindow: 200000,
								maxTokens: 16384,
							},
						],
					},
				},
			});
			anthropicOverride = readonlyRegistry({ providers: { anthropic: { disableStrictTools: true } } });
			myProxyCustom = readonlyRegistry({
				providers: {
					"my-proxy": {
						baseUrl: "https://proxy.example.com/anthropic",
						apiKey: "TEST_KEY",
						api: "anthropic-messages",
						disableStrictTools: true,
						models: [
							{
								id: "claude-sonnet-4",
								name: "Sonnet",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 16384,
							},
						],
					},
				},
			});
		});

		test("custom provider with models gets disableStrictTools merged into compat", () => {
			const model = bedrockCustom.find("bedrock-anthropic", "claude-sonnet-4-20250514");
			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});

		test("disableStrictTools on override-only provider applies to built-in models", () => {
			const models = getModelsForProvider(anthropicOverride, "anthropic");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect((model.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
			}
		});

		test("disableStrictTools is absent on built-in models without override", () => {
			const models = getModelsForProvider(sharedBuiltin, "anthropic");
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(
					(model.compatConfig as { disableStrictTools?: boolean } | undefined)?.disableStrictTools,
				).toBeUndefined();
			}
		});

		test("disableStrictTools is merged with explicit compat on custom provider", () => {
			const model = myProxyCustom.find("my-proxy", "claude-sonnet-4");
			expect(model).toBeDefined();
			expect((model?.compat as { disableStrictTools?: boolean } | undefined)?.disableStrictTools).toBe(true);
		});
	});

	describe("provider auth: oauth", () => {
		// isOAuth is baked onto each model at construction/refresh, so building the
		// fixtures (and their offline refresh) in beforeAll on one dedicated auth
		// keeps every assertion read-only.
		let oauthAuth: AuthStorage;
		let explicitOAuth: ModelRegistry;
		let defaultOAuth: ModelRegistry;
		let apiKeyOptOut: ModelRegistry;
		let nonAnthropic: ModelRegistry;
		const proxyAnthropicModels = [
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8000,
			},
		];
		beforeAll(async () => {
			oauthAuth = await AuthStorage.create(":memory:");
			oauthAuth.setRuntimeApiKey("proxy-anthropic", "literal-key");
			oauthAuth.setRuntimeApiKey("proxy-openai", "literal-key");
			const build = async (config: Record<string, unknown>) => {
				const registry = new ModelRegistry(oauthAuth, sharedConfigPath(config));
				await registry.refresh("offline");
				return registry;
			};
			explicitOAuth = await build({
				providers: {
					"proxy-anthropic": {
						baseUrl: "https://proxy.example.com",
						apiKey: "literal-key",
						api: "anthropic-messages",
						auth: "oauth",
						models: proxyAnthropicModels,
					},
				},
			});
			defaultOAuth = await build({
				providers: {
					"proxy-anthropic": {
						baseUrl: "https://proxy.example.com",
						apiKey: "literal-key",
						api: "anthropic-messages",
						models: proxyAnthropicModels,
					},
				},
			});
			apiKeyOptOut = await build({
				providers: {
					"proxy-anthropic": {
						baseUrl: "https://proxy.example.com",
						apiKey: "literal-key",
						api: "anthropic-messages",
						auth: "apiKey",
						models: proxyAnthropicModels,
					},
				},
			});
			nonAnthropic = await build({
				providers: {
					"proxy-openai": {
						baseUrl: "https://proxy.example.com/v1",
						apiKey: "literal-key",
						api: "openai-completions",
						models: [
							{
								id: "gpt-5",
								name: "GPT-5",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8000,
							},
						],
					},
				},
			});
		});
		afterAll(() => oauthAuth.close());

		test("models from a provider with auth: oauth are marked isOAuth=true", () => {
			const model = explicitOAuth.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("anthropic-messages providers default to isOAuth=true even without explicit auth", () => {
			const model = defaultOAuth.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBe(true);
		});

		test("auth: apiKey opts out of the anthropic-messages default", () => {
			const model = apiKeyOptOut.find("proxy-anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});

		test("non-anthropic apis do not get the OAuth default", () => {
			const model = nonAnthropic.find("proxy-openai", "gpt-5");
			expect(model).toBeDefined();
			expect(model?.isOAuth).toBeUndefined();
		});
	});

	describe("cached discovery on startup", () => {
		let legacySentinels: ModelRegistry;
		let standardCache: ModelRegistry;
		let specialCache: ModelRegistry;
		let vertexAuthoritative: ModelRegistry;
		let syntheticCacheLoad: ModelRegistry;
		let cachedDiscoverableRemoteCompaction: ModelRegistry;
		let vertexNonAuthoritative: ModelRegistry;
		let vertexStale: ModelRegistry;
		const vertexProjectModel = () =>
			buildModel({
				id: "zai-org/glm-4.7-maas",
				name: "GLM-4.7",
				api: "openai-completions",
				provider: "google-vertex",
				baseUrl: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 222_222,
				maxTokens: 8_888,
			});
		beforeAll(() => {
			legacySentinels = readonlyRegistry(
				{
					providers: {
						openai: {
							baseUrl: "https://my-proxy.example.com/v1",
							apiKey: "TEST_KEY",
							api: "openai-completions",
							discovery: { type: "openai-models-list" },
							models: [],
						},
					},
				},
				{
					seedCache: dbPath => {
						// Legacy v5 cache row with retired sentinel limits; the schema bump
						// must ignore it rather than treat 222222/8888 as real limits.
						writeModelCache<"openai-completions">(
							"openai",
							Date.now(),
							[
								buildModel({
									id: "gpt-4o",
									name: "GPT-4o",
									api: "openai-completions",
									provider: "openai",
									baseUrl: "https://my-proxy.example.com/v1",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 222_222,
									maxTokens: 8_888,
								}),
							],
							true,
							"",
							dbPath,
						);
						const db = new Database(dbPath);
						try {
							db.run("UPDATE model_cache SET version = 5 WHERE provider_id = ?", ["openai"]);
						} finally {
							db.close();
						}
					},
				},
			);
			standardCache = readonlyRegistry(
				{ providers: {} },
				{
					seedCache: dbPath => {
						writeModelCache(
							"ollama-cloud",
							Date.now(),
							[
								buildModel({
									id: "deepseek-v4-pro",
									name: "DeepSeek V4 Pro",
									api: "ollama-chat",
									provider: "ollama-cloud",
									baseUrl: "https://ollama.com",
									reasoning: true,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 1_000_000,
									maxTokens: 384_000,
								}),
								buildModel({
									id: "future-cloud-only:999b",
									name: "Future Cloud Only 999B",
									api: "ollama-chat",
									provider: "ollama-cloud",
									baseUrl: "https://ollama.com",
									reasoning: true,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128_000,
									maxTokens: 64_000,
								}),
							],
							true,
							"",
							dbPath,
						);
					},
				},
			);
			specialCache = readonlyRegistry(
				{ providers: {} },
				{
					seedCache: dbPath => {
						const cachedModels: Model[] = [
							buildModel({
								id: "gemini-cache-only-flash",
								name: "Gemini Cache-Only Flash",
								api: "google-gemini-cli",
								provider: "google-antigravity",
								baseUrl: "https://cloudcode-pa.googleapis.com",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1_000_000,
								maxTokens: 8_192,
							}),
							buildModel({
								id: "gemini-3.5-flash",
								name: "Gemini 3.5 Flash",
								api: "google-gemini-cli",
								provider: "google-gemini-cli",
								baseUrl: "https://cloudcode-pa.googleapis.com",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1_000_000,
								maxTokens: 16_384,
							}),
							buildModel({
								id: "gpt-5.4-codex-pro",
								name: "GPT-5.4 Codex Pro",
								api: "openai-codex-responses",
								provider: "openai-codex",
								baseUrl: "https://chatgpt.com/backend-api/codex",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 400_000,
								maxTokens: 128_000,
							}),
						];
						for (const cachedModel of cachedModels) {
							writeModelCache(cachedModel.provider, Date.now(), [cachedModel], true, "", dbPath);
						}
					},
				},
			);
			vertexAuthoritative = readonlyRegistry(
				{ providers: {} },
				{
					seedCache: dbPath =>
						writeModelCache("google-vertex", Date.now(), [vertexProjectModel()], true, "", dbPath),
				},
			);
			syntheticCacheLoad = readonlyRegistry(
				{ providers: {} },
				{
					seedCache: dbPath =>
						writeModelCache(
							"synthetic",
							Date.now(),
							[
								buildModel({
									id: "hf:zai-org/GLM-5.1",
									name: "GLM 5.1",
									api: "openai-completions",
									provider: "synthetic",
									baseUrl: "https://api.synthetic.new/openai/v1",
									reasoning: true,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128_000,
									maxTokens: 8_192,
								}),
							],
							true,
							"authoritative:test",
							dbPath,
						),
				},
			);
			vertexNonAuthoritative = readonlyRegistry(
				{ providers: {} },
				{
					seedCache: dbPath =>
						writeModelCache("google-vertex", Date.now(), [vertexProjectModel()], false, "", dbPath),
				},
			);
			vertexStale = readonlyRegistry(
				{ providers: {} },
				{
					// 25h old > 24h TTL → cache.fresh === false even though authoritative === true.
					seedCache: dbPath =>
						writeModelCache(
							"google-vertex",
							Date.now() - 25 * 60 * 60 * 1000,
							[vertexProjectModel()],
							true,
							"",
							dbPath,
						),
				},
			);
			cachedDiscoverableRemoteCompaction = readonlyRegistry(
				{
					providers: {
						"cached-compact-proxy": {
							baseUrl: "https://compact-proxy.example.com/v1",
							apiKey: "TEST_KEY",
							api: "openai-responses",
							discovery: { type: "openai-models-list" },
							remoteCompaction: {
								enabled: true,
								api: "openai-responses",
								endpoint: "https://compact-proxy.example.com/v1/responses/provider-compact",
								model: "provider-compact",
							},
							models: [],
						},
					},
				},
				{
					seedCache: dbPath =>
						writeModelCache(
							"cached-compact-proxy:openai-models-list-context-v2",
							Date.now(),
							[
								buildModel({
									id: "cached-compact-model",
									name: "Cached Compact Model",
									api: "openai-responses",
									provider: "cached-compact-proxy",
									baseUrl: "https://compact-proxy.example.com/v1",
									reasoning: true,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128_000,
									maxTokens: 16_384,
								}),
							],
							true,
							"",
							dbPath,
						),
				},
			);
		});

		test("legacy cached discovery sentinels are ignored after nullable limit cutover", () => {
			const model = legacySentinels.find("openai", "gpt-4o");
			expect(model).toBeDefined();
			// The bundled gpt-4o has correct limits, not the retired sentinels.
			expect(model!.contextWindow).not.toBe(222_222);
			expect(model!.contextWindow).toBeGreaterThan(100_000);
			expect(model!.maxTokens).not.toBe(8_888);
			expect(model!.maxTokens).toBeGreaterThan(10_000);
		});

		test("loads cached standard provider discovery models on startup", () => {
			const model = standardCache.find("ollama-cloud", "deepseek-v4-pro");
			expect(model?.maxTokens).toBe(384_000);
			expect(model?.omitMaxOutputTokens).toBe(true);
			const cacheOnlyModel = standardCache.find("ollama-cloud", "future-cloud-only:999b");
			expect(cacheOnlyModel).toBeDefined();
			expect(cacheOnlyModel?.maxTokens).toBe(64_000);
			expect(cacheOnlyModel?.omitMaxOutputTokens).toBe(true);
		});

		test("loads cached special provider discovery models on startup", () => {
			expect(specialCache.find("google-antigravity", "gemini-cache-only-flash")?.maxTokens).toBe(8_192);
			expect(specialCache.find("google-gemini-cli", "gemini-3.5-flash")?.maxTokens).toBe(16_384);
			expect(specialCache.find("openai-codex", "gpt-5.4-codex-pro")?.maxTokens).toBe(128_000);
		});

		test("applies provider remoteCompaction to cached configured discovery models", () => {
			expect(
				cachedDiscoverableRemoteCompaction.find("cached-compact-proxy", "cached-compact-model")?.remoteCompaction,
			).toEqual({
				enabled: true,
				api: "openai-responses",
				endpoint: "https://compact-proxy.example.com/v1/responses/provider-compact",
				model: "provider-compact",
			});
		});

		test("replaces bundled google-vertex models with authoritative Vertex project discovery", () => {
			const vertexModels = getModelsForProvider(vertexAuthoritative, "google-vertex");
			expect(vertexModels.map(model => model.id)).toEqual(["zai-org/glm-4.7-maas"]);
			expect(vertexAuthoritative.find("google-vertex", "gemini-1.5-pro")).toBeUndefined();
		});

		test("does not re-add bundled synthetic models after authoritative cache load", () => {
			const syntheticModels = getModelsForProvider(syntheticCacheLoad, "synthetic");
			expect(syntheticModels.map(model => model.id)).toEqual(["hf:zai-org/GLM-5.1"]);
			expect(syntheticCacheLoad.find("synthetic", "hf:moonshotai/Kimi-K2.5")).toBeUndefined();
		});

		test("does not re-add bundled synthetic models after authoritative refresh", async () => {
			authStorage.setRuntimeApiKey("synthetic", "synthetic-test-key");
			const fetchMock = mockOpenAiCompatibleModels("https://api.synthetic.new/openai/v1/models", [
				"hf:zai-org/GLM-5.1",
			]);
			const registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: fetchMock });

			await registry.refresh("online");
			const syntheticModels = getModelsForProvider(registry, "synthetic");

			expect(syntheticModels.map(model => model.id)).toEqual(["hf:zai-org/GLM-5.1"]);
			expect(registry.find("synthetic", "hf:moonshotai/Kimi-K2.5")).toBeUndefined();
		});

		test("keeps bundled google-vertex fallback when cached project catalog is non-authoritative", () => {
			const vertexModels = getModelsForProvider(vertexNonAuthoritative, "google-vertex");
			expect(vertexModels.some(model => model.id === "zai-org/glm-4.7-maas")).toBe(true);
			expect(vertexModels.some(model => model.id.startsWith("gemini-"))).toBe(true);
		});

		test("keeps bundled google-vertex fallback when cached project catalog is stale", () => {
			const vertexModels = getModelsForProvider(vertexStale, "google-vertex");
			expect(vertexModels.some(model => model.id === "zai-org/glm-4.7-maas")).toBe(true);
			expect(vertexModels.some(model => model.id.startsWith("gemini-"))).toBe(true);
		});
	});

	describe("effort-tier variant collapsing", () => {
		let kiroTwins: ModelRegistry;
		let antigravityOverride: ModelRegistry;
		let suppressible: ModelRegistry;
		beforeAll(() => {
			kiroTwins = readonlyRegistry({
				providers: {
					newapi: providerConfig("https://newapi.example.com/v1", [
						{ id: "[Kiro] claude-opus-4-7" },
						{ id: "[Kiro] claude-opus-4-7-thinking" },
					]),
				},
			});
			antigravityOverride = readonlyRegistry({
				providers: {
					"google-antigravity": { modelOverrides: { "gemini-3-pro-high": { contextWindow: 222_222 } } },
				},
			});
			// Dedicated instance: the suppression test mutates it via suppressSelector.
			suppressible = readonlyRegistry({ providers: {} });
		});

		test("collapses X/X-thinking twins from custom providers", () => {
			const models = getModelsForProvider(kiroTwins, "newapi");
			expect(models.map(m => m.id)).toEqual(["[Kiro] claude-opus-4-7"]);
			// Effort routing to the consumed twin forces reasoning even though
			// the config never marked it.
			expect(models[0]?.reasoning).toBe(true);
			expect(models[0]?.thinking?.effortRouting?.[Effort.High]).toBe("[Kiro] claude-opus-4-7-thinking");
			expect(models[0]?.thinking?.effortRouting?.off).toBe("[Kiro] claude-opus-4-7");
			// Saved selectors for the consumed twin resolve via the grammar alias.
			expect(kiroTwins.find("newapi", "[Kiro] claude-opus-4-7-thinking")?.id).toBe("[Kiro] claude-opus-4-7");
		});

		test("modelOverrides keyed by retired variant ids re-key onto the collapsed model", () => {
			const collapsed = antigravityOverride.find("google-antigravity", "gemini-3-pro");
			expect(collapsed?.contextWindow).toBe(222_222);
			// The retired selector resolves to the same collapsed model.
			expect(antigravityOverride.find("google-antigravity", "gemini-3-pro-high")?.id).toBe("gemini-3-pro");
		});

		test("suppressed selectors keyed by retired variant ids bind to the collapsed id", () => {
			suppressible.suppressSelector("google-antigravity/gemini-3-pro-high", Date.now() + 60_000);
			expect(suppressible.isSelectorSuppressed("google-antigravity/gemini-3-pro")).toBe(true);
			expect(suppressible.isSelectorSuppressed("google-antigravity/gemini-3-pro-low")).toBe(true);
			expect(suppressible.isSelectorSuppressed("google-antigravity/gemini-2.5-pro")).toBe(false);
		});
	});
});
