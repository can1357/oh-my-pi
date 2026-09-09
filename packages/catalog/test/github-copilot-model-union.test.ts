import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { createModelManager } from "../src/model-manager";

const BASE_URL = "https://copilot.example.com";

// Account expansion, routing, deduplication, and pruning are exercised through
// ModelRegistry in coding-agent/test/model-discovery.test.ts.
describe("github-copilot multi-account discovery failures", () => {
	it.each([
		["HTTP rejection", async () => new Response("forbidden", { status: 403 })],
		[
			"transport failure",
			async () => {
				throw new Error("connection reset");
			},
		],
		["malformed payload", async () => Response.json({ unexpected: true })],
	] satisfies [string, () => Promise<Response>][])("aborts the partial union on %s", async (_name, failedFetch) => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [
				{ apiKey: "healthy", accountId: "healthy-account" },
				{ apiKey: "unavailable", accountId: "unavailable-account" },
			],
			fetch: async (_input, init) =>
				new Headers(init?.headers).get("Authorization") === "Bearer healthy"
					? Response.json({ data: [{ id: "healthy-model" }] })
					: failedFetch(),
		});

		// Null preserves the previous/bundled catalog instead of pruning models
		// available only to the account whose catalog could not be determined.
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});

	it("distinguishes successful empty grants from an unavailable catalog", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [{ apiKey: "account-a" }, { apiKey: "account-b" }],
			fetch: async () => Response.json({ data: [{ id: "disabled-model", policy: { state: "disabled" } }] }),
		});

		expect(await options.fetchDynamicModels?.()).toEqual([]);
	});

	it("aborts when account resolution is incomplete instead of using the peeked key", async () => {
		let requests = 0;
		const options = githubCopilotModelManagerOptions({
			apiKey: "peeked-token",
			baseUrl: BASE_URL,
			resolveAccounts: async () => null,
			fetch: async () => {
				requests++;
				return Response.json({ data: [] });
			},
		});

		expect(await options.fetchDynamicModels?.()).toBeNull();
		expect(requests).toBe(0);
	});

	it("reconciles capabilities conservatively when two accounts report different limits or modalities", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [
				{ apiKey: "account-1", accountId: "acc-1", credentialId: 101 },
				{ apiKey: "account-2", accountId: "acc-2", credentialId: 102 },
			],
			fetch: async (_input, init) => {
				const auth = new Headers(init?.headers).get("Authorization");
				if (auth === "Bearer account-1") {
					return Response.json({
						data: [
							{
								id: "shared-model",
								capabilities: {
									type: "chat",
									limits: {
										max_context_window_tokens: 128_000,
										max_output_tokens: 16_000,
									},
									supports: { vision: true },
								},
							},
						],
					});
				}
				return Response.json({
					data: [
						{
							id: "shared-model",
							capabilities: {
								type: "chat",
								limits: {
									max_context_window_tokens: 64_000,
									max_output_tokens: 8_000,
								},
								supports: { vision: false },
							},
						},
					],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(1);
		const model = models![0];
		expect(model.id).toBe("shared-model");
		expect(model.contextWindow).toBe(64_000);
		expect(model.maxTokens).toBe(8_000);
		expect(model.input).toEqual(["text"]);
		expect(model.oauthCredentialIds).toEqual([101, 102]);
	});

	it("preserves known numeric limits when a sibling omits them", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [
				{ apiKey: "account-1", accountId: "acc-1", credentialId: 101 },
				{ apiKey: "account-2", accountId: "acc-2", credentialId: 102 },
			],
			fetch: async (_input, init) => {
				const auth = new Headers(init?.headers).get("Authorization");
				if (auth === "Bearer account-1") {
					return Response.json({
						data: [
							{
								id: "reference-less-model",
								capabilities: {
									type: "chat",
									limits: {
										max_context_window_tokens: 32_000,
										max_output_tokens: 4_000,
									},
								},
							},
						],
					});
				}
				return Response.json({
					data: [
						{
							id: "reference-less-model",
							capabilities: {
								type: "chat",
								// limits omitted by sibling
							},
						},
					],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(1);
		const model = models![0];
		expect(model.id).toBe("reference-less-model");
		expect(model.contextWindow).toBe(32_000);
		expect(model.maxTokens).toBe(4_000);
		expect(model.oauthCredentialIds).toEqual([101, 102]);
	});

	it("updates cacheProviderId to match the refreshed primary account key after account resolution", async () => {
		const oldKey = JSON.stringify({ token: "old-token" });
		const refreshedKey = JSON.stringify({ token: "refreshed-token" });
		const options = githubCopilotModelManagerOptions({
			apiKey: oldKey,
			baseUrl: BASE_URL,
			resolveAccounts: async () => [{ apiKey: refreshedKey, accountId: "acc-refreshed", credentialId: 1 }],
			fetch: async () => Response.json({ data: [] }),
		});

		const initialCacheId = options.cacheProviderId;
		await options.fetchDynamicModels?.();
		expect(options.cacheProviderId).not.toBe(initialCacheId);
	});

	it("scopes cacheProviderId to the complete account set during discovery", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			accountIdentities: ["acc-1"],
			resolveAccounts: async () => [
				{ apiKey: "acc-1-key", accountId: "acc-1", credentialId: 101 },
				{ apiKey: "acc-2-key", accountId: "acc-2", credentialId: 102 },
			],
			fetch: async () => Response.json({ data: [] }),
		});

		const initialCacheId = options.cacheProviderId;
		await options.fetchDynamicModels?.();
		expect(options.cacheProviderId).not.toBe(initialCacheId);
		expect(options.cacheProviderId).toBe(
			resolveModelCacheProviderId("github-copilot", {
				baseUrl: BASE_URL,
				accountIdentities: ["acc-1:101", "acc-2:102"],
			}),
		);
		expect(options.cacheProviderId).not.toBe(
			resolveModelCacheProviderId("github-copilot", {
				baseUrl: BASE_URL,
				accountIdentities: ["acc-1:999", "acc-2:102"],
			}),
		);
	});

	it("preserves OAuth grants in a mixed union with non-OAuth accounts", async () => {
		const options = githubCopilotModelManagerOptions({
			baseUrl: BASE_URL,
			resolveAccounts: async () => [
				{ apiKey: "oauth-account", accountId: "acc-oauth", credentialId: 101 },
				{ apiKey: "env-account", accountId: "acc-env" }, // no credentialId
			],
			fetch: async (_input, init) => {
				const auth = new Headers(init?.headers).get("Authorization");
				if (auth === "Bearer oauth-account") {
					return Response.json({
						data: [
							{ id: "shared-model", capabilities: { type: "chat" } },
							{ id: "oauth-only-model", capabilities: { type: "chat" } },
						],
					});
				}
				return Response.json({
					data: [
						{ id: "shared-model", capabilities: { type: "chat" } },
						{ id: "env-only-model", capabilities: { type: "chat" } },
					],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();
		expect(models).toBeDefined();
		const byId = new Map(models!.map(m => [m.id, m]));

		// Shared model has credentialId from the OAuth account
		expect(byId.get("shared-model")?.oauthCredentialIds).toEqual([101]);
		// OAuth-only model has credentialId from the OAuth account
		expect(byId.get("oauth-only-model")?.oauthCredentialIds).toEqual([101]);
		// Env-only model cannot subsequently resolve credentials in an OAuth-enabled environment and is omitted
		expect(byId.get("env-only-model")).toBeUndefined();
	});

	it("reports retained authoritative cache as source cache even when models.dev succeeds", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-copilot-cache-"));
		try {
			const cacheDbPath = path.join(tempDir, "models.db");
			let failFetch = false;
			const options = githubCopilotModelManagerOptions({
				baseUrl: BASE_URL,
				apiKey: "test-key",
				fetch: async () => {
					if (failFetch) return new Response(null, { status: 503 });
					return Response.json({
						data: [{ id: "cached-copilot-model", capabilities: { type: "chat" } }],
					});
				},
			});
			const manager = createModelManager({
				...options,
				dynamicModelsAuthoritative: true,
				cacheDbPath,
				modelsDev: {
					fetch: async () => [{ id: "models-dev-model" }],
					map: payload =>
						(payload as { id: string }[]).map(p => ({
							id: p.id,
							name: p.id,
							provider: "github-copilot",
							api: "openai-responses",
							baseUrl: BASE_URL,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 16_000,
						})),
				},
			});

			const initial = await manager.refresh("online");
			expect(initial.authoritative).toBe(true);
			expect(initial.models.map(m => m.id)).toEqual(["cached-copilot-model"]);

			failFetch = true;
			const result = await manager.refresh("online");
			expect(result.authoritative).toBe(true);
			expect(result.source).toBe("cache");
			expect(result.models.map(m => m.id)).toEqual(["cached-copilot-model"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reports retained empty authoritative cache as source cache rather than bundled", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-copilot-cache-empty-"));
		try {
			const cacheDbPath = path.join(tempDir, "models.db");
			let failFetch = false;
			const options = githubCopilotModelManagerOptions({
				baseUrl: BASE_URL,
				apiKey: "test-key",
				fetch: async () => {
					if (failFetch) return new Response(null, { status: 503 });
					return Response.json({
						data: [{ id: "disabled-model", policy: { state: "disabled" } }],
					});
				},
			});
			const manager = createModelManager({
				...options,
				dynamicModelsAuthoritative: true,
				cacheDbPath,
			});

			const initial = await manager.refresh("online");
			expect(initial.authoritative).toBe(true);
			expect(initial.models).toEqual([]);

			failFetch = true;
			const result = await manager.refresh("online");
			expect(result.authoritative).toBe(true);
			expect(result.source).toBe("cache");
			expect(result.models).toEqual([]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
