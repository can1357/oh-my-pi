import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { openaiCodexModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { resolveProviderModelReference } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("Codex model discovery", () => {
	it("normalizes optional maximum context windows separately from the default window", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn: async () =>
				Response.json({
					models: [
						{ slug: "gpt-6-astra", context_window: 272_000, max_context_window: 872_000 },
						{ slug: "gpt-5.5", context_window: 272_000 },
						{ slug: "invalid-maximum", context_window: 64_000, max_context_window: -1 },
					],
				}),
		});
		const astra = result?.models.find(model => model.id === "gpt-6-astra");
		expect(astra).toMatchObject({ contextWindow: 272_000, maxContextWindow: 872_000 });
		expect(result?.models.find(model => model.id === "gpt-5.5")).not.toHaveProperty("maxContextWindow");
		expect(result?.models.find(model => model.id === "invalid-maximum")).not.toHaveProperty("maxContextWindow");
	});

	it("marks discovered models for provider-native V2 compaction", async () => {
		let capturedHeaders: Headers | undefined;
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = new Headers(init?.headers);
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
					{ headers: { etag: "models-v1" } },
				);
			},
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		expect(capturedHeaders?.get("version")).toBe("0.99.0");
		expect(result?.etag).toBe("models-v1");
		expect(result?.models).toHaveLength(1);
		expect(result?.models[0]).toMatchObject({
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses",
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		});
	});

	it("carries use_responses_lite and prefer_websockets onto the model spec", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-terra",
								display_name: "GPT-5.6-Terra",
								context_window: 372_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
								prefer_websockets: true,
								use_responses_lite: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const terra = result?.models.find(model => model.id === "gpt-5.6-terra");
		expect(terra).toMatchObject({ preferWebsockets: true, useResponsesLite: true });
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.useResponsesLite).toBeUndefined();
	});

	it("floors GPT-5.6 luna/sol/terra at the 1M window when upstream omits context_window (#5705)", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								display_name: "GPT-5.6-Sol",
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const sol = result?.models.find(model => model.id === "gpt-5.6-sol");
		expect(sol?.contextWindow).toBe(1_000_000);
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.contextWindow).toBe(272_000);
	});

	it("normalizes Codex Daybreak aliases to GPT-5.6 capabilities and pricing", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-daybreak-blue-latest",
								display_name: "Daybreak Blue",
								default_reasoning_level: "high",
								supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-daybreak-red-latest",
								display_name: "Daybreak Red",
								context_window: 400_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});
		const blue = result?.models.find(model => model.id === "gpt-daybreak-blue-latest");
		if (!blue) throw new Error("Expected discovered Daybreak Blue model");
		const red = result?.models.find(model => model.id === "gpt-daybreak-red-latest");
		if (!red) throw new Error("Expected discovered Daybreak Red model");

		expect(blue.contextWindow).toBe(372_000);
		expect(getSupportedEfforts(buildModel(blue))).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		// Standard API pricing is rule-owned (`providers/openai-codex.kdl`
		// cost-patch) and corrected at build time.
		expect(buildModel(blue).cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
		expect(red.contextWindow).toBe(400_000);
		expect(buildModel(red).cost).toEqual({ input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 });
	});

	it("normalizes plain and worker Codex GPT-6 Astra metadata", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				Response.json({
					models: [
						{
							slug: "gpt-6-astra-wm",
							display_name: "GPT-6-Astra",
							context_window: 272_000,
							default_reasoning_level: "medium",
							supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
							input_modalities: ["text", "image"],
							supported_in_api: true,
						},
					],
				}),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.153.0",
			fetchFn,
		});
		const astra = result?.models.find(model => model.id === "gpt-6-astra");
		const workerAstra = result?.models.find(model => model.id === "gpt-6-astra-wm");
		if (!astra || !workerAstra) throw new Error("Expected plain and worker GPT-6 Astra routes");

		for (const model of [astra, workerAstra]) {
			// `/models` omits prices, so discovery stays neutral and the KDL
			// catalog rule remains the single authority for billed metadata.
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(model.contextWindow).toBe(272_000);
			const builtModel = buildModel(model);
			// Codex credits keep this base rate and do not charge for cache
			// writes; unlike the API card, there is no long-context tier. The
			// default window stays at the deployment-advertised 272K; the
			// 1.05M documented window is the `/extended-context` maximum.
			expect(builtModel.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 0 });
			expect(builtModel.serviceTierCost).toEqual({ flex: 0.5, priority: 2.5 });
			expect(builtModel).toMatchObject({
				contextWindow: 272_000,
				maxTokens: 128_000,
			});
		}
	});

	it("floors stale reported windows for GPT-5.6 luna/sol/terra and honors reports above the floor", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								display_name: "GPT-5.6-Sol",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.6-terra",
								display_name: "GPT-5.6-Terra",
								context_window: 1_050_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.144.1",
			fetchFn,
		});

		// Registry still reports the pre-1M 272000 for sol; the floor must win.
		const sol = result?.models.find(model => model.id === "gpt-5.6-sol");
		expect(sol?.contextWindow).toBe(1_000_000);
		// Reports above the floor are honored as-is.
		const terra = result?.models.find(model => model.id === "gpt-5.6-terra");
		expect(terra?.contextWindow).toBe(1_050_000);
		// Non-floored SKUs keep the actively reported value.
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.contextWindow).toBe(272_000);
	});

	it("keeps account-listed API-unsupported models while pruning hidden and absent models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-authoritative-"));
		const staticOnlyModel: ModelSpec<"openai-codex-responses"> = {
			id: "unsupported-static",
			name: "Unsupported static model",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const sparkModel: ModelSpec<"openai-codex-responses"> = {
			...staticOnlyModel,
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			contextWindow: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex-spark",
								display_name: "GPT-5.3-Codex-Spark",
								visibility: "list",
								supported_in_api: false,
								context_window: 128_000,
								default_reasoning_level: "high",
								input_modalities: ["text"],
							},
							{
								slug: "hidden-model",
								display_name: "Hidden model",
								visibility: "hidden",
								supported_in_api: true,
							},
							{
								slug: "hide-model",
								display_name: "Hide model",
								visibility: "hide",
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		try {
			const result = await resolveProviderModels(
				{
					...openaiCodexModelManagerOptions({
						resolveAccounts: async () => [{ accessToken: "test-token" }],
						fetch: fetchFn,
					}),
					staticModels: [staticOnlyModel, sparkModel],
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-5.3-codex-spark"]);
			expect(result.models[0]).toMatchObject({
				contextWindow: 128_000,
				maxTokens: 128_000,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("unions models across every configured Codex OAuth account (#6265)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-"));
		// Codex `/models` is account-scoped: account 1 lacks gpt-5.6-sol, account 2
		// exposes it. Keyed off the chatgpt-account-id header the discovery flow
		// sends per account.
		const catalogs: Record<string, readonly string[]> = {
			"account-1": ["gpt-5.6-terra", "gpt-5.6-luna"],
			"account-2": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
		};
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
				const slugs = catalogs[accountId] ?? [];
				return new Response(
					JSON.stringify({
						models: slugs.map(slug => ({
							slug,
							display_name: slug,
							default_reasoning_level: "medium",
							supported_reasoning_levels: ["low", "medium", "high"],
							input_modalities: ["text", "image"],
							supported_in_api: true,
						})),
					}),
				);
			},
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-1", accountId: "account-1" },
					{ accessToken: "token-2", accountId: "account-2" },
				],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps bundled Codex models when any account catalog fetch fails (#6265)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-fail-"));
		const bundled: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372_000,
			maxTokens: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const accountId = new Headers(init?.headers).get("chatgpt-account-id");
				if (accountId === "account-1") {
					return Response.json({
						models: [
							{
								slug: "partial-account-model",
								display_name: "Partial Account Model",
								supported_in_api: true,
								input_modalities: ["text"],
							},
						],
					});
				}
				return new Response("nope", { status: 500 });
			},
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-1", accountId: "account-1" },
					{ accessToken: "token-2", accountId: "account-2" },
				],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, staticModels: [bundled], cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-5.6-terra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("skips an account whose credential the backend rejects and unions the rest", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-revoked-"));
		const bundled: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372_000,
			maxTokens: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const accountId = new Headers(init?.headers).get("chatgpt-account-id");
				if (accountId === "revoked") {
					return Response.json(
						{ error: { message: "Encountered invalidated oauth token for user", code: "token_revoked" } },
						{ status: 401 },
					);
				}
				return Response.json({
					models: [
						{
							slug: "gpt-6-astra",
							display_name: "GPT-6-Astra",
							default_reasoning_level: "medium",
							supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }],
							input_modalities: ["text", "image"],
							supported_in_api: true,
						},
					],
				});
			},
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [
					{ accessToken: "token-revoked", accountId: "revoked" },
					{ accessToken: "token-live", accountId: "live" },
				],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, staticModels: [bundled], cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-6-astra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps bundled Codex models when every account credential is rejected", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-union-all-revoked-"));
		const bundled: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372_000,
			maxTokens: 128_000,
		};
		const fetchFn: typeof fetch = Object.assign(async () => new Response("forbidden", { status: 403 }), {
			preconnect() {},
		});
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [{ accessToken: "token-1", accountId: "account-1" }],
				fetch: fetchFn,
			});
			const result = await resolveProviderModels(
				{ ...options, staticModels: [bundled], cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["gpt-5.6-terra"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores pre-V2 Codex discovery cache rows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v7-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const cachedModel: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const refreshedModel: ModelSpec<"openai-codex-responses"> = {
			...cachedModel,
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
			},
		};
		try {
			writeModelCache(
				"openai-codex",
				Date.now(),
				[buildModel(cachedModel)],
				true,
				"merge-v3:authoritative:merge-v3:empty",
				dbPath,
			);
			const db = new Database(dbPath);
			try {
				db.run("UPDATE model_cache SET version = 7 WHERE provider_id = ?", ["openai-codex"]);
			} finally {
				db.close();
			}

			let fetched = false;
			const result = await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [refreshedModel];
				},
			});

			expect(fetched).toBe(true);
			expect(result.models.find(model => model.id === "gpt-5.5")?.remoteCompaction).toEqual(
				refreshedModel.remoteCompaction,
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not silently promote legacy v2 Codex cache rows to the current schema", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v2-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			// Seed a v2 row directly, mirroring the shape written by very old
			// installs before schema versioning stabilized. The migration must NOT
			// resurrect it as the current version — that would keep the pre-V2
			// compaction metadata alive across cache-schema bumps.
			const seed = new Database(dbPath, { create: true });
			try {
				seed.run(`
					CREATE TABLE model_cache (
						provider_id TEXT PRIMARY KEY,
						version INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						authoritative INTEGER NOT NULL DEFAULT 0,
						static_fingerprint TEXT NOT NULL DEFAULT '',
						models TEXT NOT NULL
					)
				`);
				seed.run(
					"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, 2, ?, 1, '', '[]')",
					["openai-codex", Date.now()],
				);
			} finally {
				seed.close();
			}

			let fetched = false;
			await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [];
				},
			});
			expect(fetched).toBe(true);

			const inspect = new Database(dbPath, { readonly: true });
			try {
				const row = inspect
					.query<{ version: number }, [string]>("SELECT version FROM model_cache WHERE provider_id = ?")
					.get("openai-codex");
				expect(row?.version).not.toBe(2);
			} finally {
				inspect.close();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("registers a plain route when the backend advertises only the worker `-wm` slug", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-luna-wm",
								display_name: "GPT-5.6 Luna",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		// The authoritative `-wm` row stays surfaced verbatim…
		const workerModel = result?.models.find(model => model.id === "gpt-5.6-luna-wm");
		expect(workerModel).toBeDefined();
		// …and the configured plain slug must also resolve to a real route.
		const plainModel = result?.models.find(model => model.id === "gpt-5.6-luna");
		expect(plainModel).toBeDefined();
		expect(plainModel?.provider).toBe("openai-codex");
		// Both rows are the same model: the worker variant shares the plain
		// SKU's base metadata, so the 1M window floor applies to both.
		expect(workerModel?.contextWindow).toBe(1_000_000);
		expect(plainModel?.contextWindow).toBe(1_000_000);
	});

	it("keeps the plain route through authoritative discovery that advertises only the `-wm` slug", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-luna-wm-"));
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-luna-wm",
								display_name: "GPT-5.6 Luna",
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		try {
			const options = openaiCodexModelManagerOptions({
				resolveAccounts: async () => [{ accessToken: "test-token" }],
				fetch: fetchFn,
			});
			// No artificial static input: the bundled Codex catalog is the real
			// gate that licenses the plain-route synthesis.
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);

			const ids = result.models.map(model => model.id);
			expect(ids).toContain("gpt-5.6-luna");
			expect(ids).toContain("gpt-5.6-luna-wm");

			// Same engine the runtime uses: resolving the configured
			// `openai-codex/gpt-5.6-luna` must bind to the plain route by exact
			// id, not fall through to the `-wm` fuzzy match.
			const resolved = resolveProviderModelReference("openai-codex", "gpt-5.6-luna", result.models);
			expect(resolved?.id).toBe("gpt-5.6-luna");
			expect(resolved?.provider).toBe("openai-codex");
			// An explicitly configured worker slug still resolves verbatim.
			const resolvedWm = resolveProviderModelReference("openai-codex", "gpt-5.6-luna-wm", result.models);
			expect(resolvedWm?.id).toBe("gpt-5.6-luna-wm");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a `-wm` slug verbatim when it has no bundled plain counterpart", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-9.9-mystery-wm",
								display_name: "GPT-9.9 Mystery (worker)",
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});
		// No bundled `gpt-9.9-mystery` entry, so no phantom plain route is made up.
		expect(result?.models.map(model => model.id)).toEqual(["gpt-9.9-mystery-wm"]);
	});

	it("leaves a non-worker slug untouched by the worker-mapping rule", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-luna",
								display_name: "GPT-5.6 Luna",
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});
		expect(result?.models.map(model => model.id)).toEqual(["gpt-5.6-luna"]);
	});
});
