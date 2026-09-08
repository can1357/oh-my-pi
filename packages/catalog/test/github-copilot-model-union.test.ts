import { describe, expect, it } from "bun:test";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

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
});
