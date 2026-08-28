import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function getHeaderValue(headers: unknown, key: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) {
		return headers.get(key) ?? undefined;
	}
	if (Array.isArray(headers)) {
		for (const item of headers) {
			if (!Array.isArray(item) || item.length < 2) continue;
			const [name, value] = item;
			if (typeof name === "string" && name.toLowerCase() === key.toLowerCase() && typeof value === "string") {
				return value;
			}
		}
		return undefined;
	}
	if (typeof headers === "object") {
		for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
			if (name.toLowerCase() === key.toLowerCase() && typeof value === "string") {
				return value;
			}
		}
	}
	return undefined;
}

async function discoverCopilotModels(
	payload: unknown,
	apiKey = "copilot-test-key",
	expectedBaseUrl = "https://api.githubcopilot.com",
	expectedAuthorizationToken = apiKey,
) {
	const requestApiVersions: Array<string | undefined> = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/copilot_internal/user") {
			expect(getHeaderValue(init?.headers, "Authorization")).toBe(`token ${expectedAuthorizationToken}`);
			// The probe must be bounded by the shared discovery deadline so a
			// stalled endpoint cannot hang discovery (PR #8510 review).
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Response.json({ endpoints: { api: expectedBaseUrl } });
		}
		expect(url).toBe(`${expectedBaseUrl}/models`);
		expect(init?.method).toBe("GET");
		expect(getHeaderValue(init?.headers, "Authorization")).toBe(`Bearer ${expectedAuthorizationToken}`);
		requestApiVersions.push(getHeaderValue(init?.headers, "X-GitHub-Api-Version"));
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	const options = githubCopilotModelManagerOptions({ apiKey, fetch: fetchMock });
	const models = await options.fetchDynamicModels?.();
	return { models: models ?? [], fetchMock, requestApiVersions };
}

function cachedCopilotCompletionModel(id: string, name: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 128_000,
	};
}

describe("github copilot model limits mapping", () => {
	it("discovers the plan endpoint for a raw environment token before model discovery", async () => {
		const token = "ghu_valid_business_token";
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			token,
			"https://api.business.githubcopilot.com",
			token,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("falls back to the personal endpoint when the raw-token probe fails", async () => {
		const token = "ghu_valid_business_token";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/copilot_internal/user") {
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				throw new DOMException("The operation timed out.", "TimeoutError");
			}
			expect(url).toBe("https://api.githubcopilot.com/models");
			return Response.json({ data: [] });
		});
		const models = await githubCopilotModelManagerOptions({ apiKey: token, fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("does not reuse another token's authoritative cache after COPILOT_GITHUB_TOKEN switches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-token-switch-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		try {
			const personalFetch = vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.githubcopilot.com" } });
				}
				if (url === "https://api.githubcopilot.com/models") {
					return Response.json({ data: [{ id: "gpt-5.5", name: "GPT-5.5" }] });
				}
				throw new Error(`unexpected personal request: ${url}`);
			});
			const personalManager = createModelManager({
				...githubCopilotModelManagerOptions({ apiKey: "ghu_personal_token", fetch: personalFetch }),
				cacheDbPath,
			});
			// Personal token discovery writes a fresh authoritative cache.
			await personalManager.refresh("online");

			const businessSeen: string[] = [];
			const businessFetch = vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input.toString();
				businessSeen.push(url);
				if (url === "https://api.github.com/copilot_internal/user") {
					return Response.json({ endpoints: { api: "https://api.business.githubcopilot.com" } });
				}
				if (url === "https://api.business.githubcopilot.com/models") {
					return Response.json({ data: [{ id: "gpt-5.5", name: "GPT-5.5" }] });
				}
				throw new Error(`unexpected business request: ${url}`);
			});
			const businessManager = createModelManager({
				...githubCopilotModelManagerOptions({ apiKey: "ghu_business_token", fetch: businessFetch }),
				cacheDbPath,
			});
			// Default online-if-uncached must not satisfy the switched token from the
			// prior token's fresh authoritative personal-endpoint cache.
			const { models } = await businessManager.refresh("online-if-uncached");
			expect(businessSeen).toContain("https://api.github.com/copilot_internal/user");
			expect(businessSeen).toContain("https://api.business.githubcopilot.com/models");
			expect(models.some(model => model.baseUrl === "https://api.business.githubcopilot.com")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("unwraps structured OAuth keys for discovery and routes enterprise discovery to the enterprise host", async () => {
		const structuredApiKey = JSON.stringify({
			token: "ghu_test_copilot_token",
			enterpriseUrl: "ghe.example.com",
		});
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			structuredApiKey,
			"https://copilot-api.ghe.example.com",
			"ghu_test_copilot_token",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("unwraps structured OAuth keys for discovery and routes business discovery to the business host", async () => {
		const structuredApiKey = JSON.stringify({
			token: "ghu_test_copilot_token",
			apiEndpoint: "https://api.business.githubcopilot.com",
		});
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			structuredApiKey,
			"https://api.business.githubcopilot.com",
			"ghu_test_copilot_token",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses max_context_window_tokens as context window when Copilot reports a prompt budget", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gemini-2.5-pro",
					name: "Gemini 2.5 Pro",
					capabilities: {
						limits: {
							max_context_window_tokens: 1_048_576,
							max_prompt_tokens: 128_000,
							max_output_tokens: 64_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gemini-2.5-pro");
		expect(model?.contextWindow).toBe(1_048_576);
		expect(model?.maxTokens).toBe(64_000);
	});

	it("falls back to explicit context_length and derives max tokens from max_output_tokens", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.2-codex",
					name: "GPT-5.2 Codex",
					context_length: 250_000,
					max_completion_tokens: 120_000,
					capabilities: {
						limits: {
							max_prompt_tokens: 128_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.2-codex");
		expect(model?.api).toBe("openai-responses");
		expect(model?.contextWindow).toBe(250_000);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("falls back to max_prompt_tokens when total-window fields are absent", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "claude-opus-4.6",
					name: "Claude Opus 4.6",
					capabilities: {
						limits: {
							max_prompt_tokens: 128_000,
							max_non_streaming_output_tokens: 16_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "claude-opus-4.6");
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(16_000);
	});

	it("inherits bundled GPT-5.4 mini reasoning metadata during discovery", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4-mini",
					name: "GPT-5.4 mini",
					context_length: 400_000,
					max_completion_tokens: 128_000,
					capabilities: {
						limits: {
							max_context_window_tokens: 400_000,
							max_prompt_tokens: 272_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4-mini");
		expect(model?.api).toBe("openai-responses");
		expect(model?.reasoning).toBe(true);
		// max_context_window_tokens is the model window; max_prompt_tokens is only
		// Copilot's prompt/summarization budget.
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(model?.premiumMultiplier).toBe(0.33);
		expect(model?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	it("uses max_context_window_tokens before the bundled reference", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4",
					name: "GPT-5.4",
					capabilities: {
						limits: {
							max_context_window_tokens: 400_000,
							max_output_tokens: 128_000,
						},
					},
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4");
		expect(model?.contextWindow).toBe(400_000);
		expect(model?.maxTokens).toBe(128_000);
	});

	it("keeps discovered context window through full model resolution for bundled models", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-models-"));
		try {
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				expect(url).toBe("https://api.githubcopilot.com/models");
				expect(init?.method).toBe("GET");
				expect(getHeaderValue(init?.headers, "Authorization")).toBe("Bearer copilot-test-key");
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "gpt-5.4",
								name: "GPT-5.4",
								capabilities: {
									limits: {
										max_context_window_tokens: 400_000,
										max_prompt_tokens: 128_000,
										max_output_tokens: 128_000,
									},
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: fetchMock });
			const manager = createModelManager({
				...options,
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");
			const model = models.find(candidate => candidate.id === "gpt-5.4");

			expect(getBundledModel("github-copilot", "gpt-5.4")?.contextWindow).toBe(272_000);
			expect(model?.contextWindow).toBe(400_000);
			expect(model?.maxTokens).toBe(128_000);
			expect(model?.reasoning).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("prefers Copilot-specific bundled reference over global reference", async () => {
		// When the API returns no limits at all, the model should use the Copilot-specific
		// bundled reference, not a global reference from another provider (e.g. OpenAI at 1050k).
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "gpt-5.4",
					name: "GPT-5.4",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4");
		// Should use the Copilot-specific bundled reference (272k after models.json fix),
		// not the OpenAI global reference (1050k).
		expect(model?.contextWindow).toBe(272_000);
	});
	it("routes mai-code models to the openai-responses endpoint (#5612)", async () => {
		// Copilot's /chat/completions rejects mai-* models with
		// `unsupported_api_for_model` (400); they are served only via /responses.
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "mai-code-1-flash-picker",
					name: "MAI-Code-1-Flash",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "mai-code-1-flash-picker");
		expect(model?.api).toBe("openai-responses");
	});
	it("routes grok-4.5 to the openai-responses endpoint (#7096)", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "grok-4.5",
					name: "Grok 4.5",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "grok-4.5");
		expect(model?.api).toBe("openai-responses");
	});
	it("routes grok-4.6 to the openai-responses endpoint (#8807)", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "grok-4.6",
					name: "Grok 4.6",
				},
			],
		});

		const model = models.find(candidate => candidate.id === "grok-4.6");
		expect(model?.api).toBe("openai-responses");
	});
	for (const migration of [
		{ id: "mai-code-1-flash-picker", name: "MAI-Code-1-Flash" },
		{ id: "grok-4.5", name: "Grok 4.5" },
		{ id: "grok-4.6", name: "Grok 4.6" },
	]) {
		it(`refreshes a cached ${migration.name} completion route after the endpoint migration`, async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-ai-copilot-${migration.id}-cache-`));
			const cacheDbPath = path.join(tempDir, "models.db");
			const cacheProviderId = `github-copilot-${migration.id}-cache-test`;
			try {
				const oldManager = createModelManager({
					providerId: "github-copilot",
					cacheProviderId,
					cacheDbPath,
					fetchDynamicModels: async () => [cachedCopilotCompletionModel(migration.id, migration.name)],
				});
				await oldManager.refresh("online");

				const fetchMock = vi.fn(async () => {
					return new Response(
						JSON.stringify({
							data: [{ id: migration.id, name: migration.name }],
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				});
				const manager = createModelManager({
					...githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: fetchMock }),
					cacheProviderId,
					cacheDbPath,
				});
				const { models } = await manager.refresh("online-if-uncached");
				const model = models.find(candidate => candidate.id === migration.id);

				expect(fetchMock).toHaveBeenCalledTimes(2);
				expect(model?.api).toBe("openai-responses");
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});
	}
	it("drops cached Grok 4.5 context variants when the migration refresh fails", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-grok-variant-cache-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		const cacheProviderId = "github-copilot-grok-variant-cache-test";
		try {
			const oldManager = createModelManager({
				providerId: "github-copilot",
				cacheProviderId,
				cacheDbPath,
				fetchDynamicModels: async () => [
					cachedCopilotCompletionModel("grok-4.5", "Grok 4.5"),
					{
						...cachedCopilotCompletionModel("grok-4.5-1m", "Grok 4.5 (1M)"),
						requestModelId: "grok-4.5",
						contextWindow: 500_000,
					},
				],
			});
			await oldManager.refresh("online");

			const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
			const manager = createModelManager({
				...githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: fetchMock }),
				cacheProviderId,
				cacheDbPath,
			});
			const { models } = await manager.refresh("online-if-uncached");

			expect(fetchMock).toHaveBeenCalledTimes(2);
			// The bundled catalog now ships a responses-route grok-4.5, so the id
			// resurfaces from the bundle after the failed refresh. The migration
			// contract is that the stale cached COMPLETIONS route never comes
			// back — and the cached long-context variant has no bundled entry,
			// so it stays dropped.
			expect(models.find(candidate => candidate.id === "grok-4.5")?.api).toBe("openai-responses");
			expect(models.find(candidate => candidate.id === "grok-4.5-1m")).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

/**
 * Entry shaped like the `/models` response under `X-GitHub-Api-Version: 2026-06-01`:
 * `capabilities.limits` reports the long-context ceiling and
 * `billing.token_prices` carries per-tier prompt boundaries and prices
 * (hundredths of a dollar per 1M tokens).
 */
function tieredCopilotEntry(overrides: {
	id: string;
	name: string;
	window: number;
	maxOutput: number;
	defaultContextMax?: number;
	longContextMax?: number;
	defaultPrices?: { input: number; output: number; cache: number };
	longPrices?: { input: number; output: number; cache: number };
	vision?: boolean;
	type?: string;
}) {
	return {
		id: overrides.id,
		name: overrides.name,
		capabilities: {
			type: overrides.type ?? "chat",
			limits: {
				max_context_window_tokens: overrides.window,
				max_output_tokens: overrides.maxOutput,
			},
			...(overrides.vision !== undefined && { supports: { vision: overrides.vision } }),
		},
		billing: {
			token_prices: {
				default: {
					...(overrides.defaultContextMax !== undefined && { context_max: overrides.defaultContextMax }),
					...(overrides.defaultPrices && {
						input_price: overrides.defaultPrices.input,
						output_price: overrides.defaultPrices.output,
						cache_price: overrides.defaultPrices.cache,
					}),
				},
				...(overrides.longContextMax !== undefined && {
					long_context: {
						context_max: overrides.longContextMax,
						...(overrides.longPrices && {
							input_price: overrides.longPrices.input,
							output_price: overrides.longPrices.output,
							cache_price: overrides.longPrices.cache,
						}),
					},
				}),
			},
		},
	};
}

describe("github copilot tiered context windows", () => {
	it("sends the Copilot API version header on discovery", async () => {
		const { requestApiVersions } = await discoverCopilotModels({ data: [] });
		expect(requestApiVersions).toEqual(["2026-06-01"]);
	});

	it("caps the base entry to the default tier and synthesizes a 1M sibling", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "claude-opus-4.7",
					name: "Claude Opus 4.7",
					window: 1_000_000,
					maxOutput: 64_000,
					defaultContextMax: 200_000,
					longContextMax: 936_000,
					defaultPrices: { input: 500, output: 2500, cache: 50 },
					longPrices: { input: 500, output: 2500, cache: 50 },
					vision: true,
				}),
			],
		});

		const base = models.find(candidate => candidate.id === "claude-opus-4.7");
		expect(base?.api).toBe("anthropic-messages");
		expect(base?.contextWindow).toBe(264_000);
		expect(base?.maxTokens).toBe(64_000);
		expect(base?.contextPromotionTarget).toBe("github-copilot/claude-opus-4.7-1m");
		expect(base?.headers?.["X-GitHub-Api-Version"]).toBe("2026-06-01");

		const variant = models.find(candidate => candidate.id === "claude-opus-4.7-1m");
		expect(variant?.requestModelId).toBe("claude-opus-4.7");
		expect(variant?.name).toBe("Claude Opus 4.7 (1M)");
		expect(variant?.api).toBe("anthropic-messages");
		expect(variant?.contextWindow).toBe(1_000_000);
		expect(variant?.maxTokens).toBe(64_000);
		expect(variant?.contextPromotionTarget).toBeUndefined();
	});

	it("prices the long-context variant from its own tier", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "gemini-9.9-pro-preview",
					name: "Gemini 9.9 Pro",
					window: 1_000_000,
					maxOutput: 64_000,
					defaultContextMax: 200_000,
					longContextMax: 936_000,
					defaultPrices: { input: 200, output: 1200, cache: 20 },
					longPrices: { input: 400, output: 1800, cache: 40 },
				}),
			],
		});

		const variant = models.find(candidate => candidate.id === "gemini-9.9-pro-preview-1m");
		expect(variant?.cost).toEqual({ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 });
	});

	it("prices the base model from its default tier", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "gpt-5.6-luna",
					name: "GPT-5.6 Luna",
					window: 1_050_000,
					maxOutput: 50_000,
					defaultContextMax: 200_000,
					longContextMax: 1_000_000,
					defaultPrices: { input: 20, output: 120, cache: 2 },
					longPrices: { input: 40, output: 180, cache: 4 },
				}),
			],
		});

		const base = models.find(candidate => candidate.id === "gpt-5.6-luna");
		expect(base?.cost).toMatchObject({ input: 0.2, output: 1.2, cacheRead: 0.02 });
		const variant = models.find(candidate => candidate.id === "gpt-5.6-luna-1m");
		expect(variant?.cost).toMatchObject({ input: 0.4, output: 1.8, cacheRead: 0.04 });
	});

	it("keeps legacy tier-capped responses unchanged and synthesizes no variant", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				{
					id: "claude-haiku-4.5",
					name: "Claude Haiku 4.5",
					capabilities: {
						type: "chat",
						limits: {
							max_context_window_tokens: 144_000,
							max_output_tokens: 32_000,
						},
						supports: { vision: true },
					},
				},
			],
		});

		expect(models).toHaveLength(1);
		const model = models[0];
		expect(model?.id).toBe("claude-haiku-4.5");
		expect(model?.contextWindow).toBe(144_000);
		expect(model?.requestModelId).toBeUndefined();
		expect(model?.contextPromotionTarget).toBeUndefined();
	});

	it("maps vision capability for models without bundled references", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "claude-fable-9",
					name: "Claude Fable 9",
					window: 264_000,
					maxOutput: 64_000,
					vision: true,
				}),
				tieredCopilotEntry({
					id: "text-only-model",
					name: "Text Only",
					window: 128_000,
					maxOutput: 16_000,
				}),
			],
		});

		const fable = models.find(candidate => candidate.id === "claude-fable-9");
		expect(fable?.input).toEqual(["text", "image"]);
		expect(fable?.api).toBe("anthropic-messages");
		const textOnly = models.find(candidate => candidate.id === "text-only-model");
		expect(textOnly?.input).toEqual(["text"]);
	});

	it("drops non-chat catalog entries", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "text-embedding-3-small",
					name: "Embedding V3 small",
					window: 0,
					maxOutput: 0,
					type: "embeddings",
				}),
			],
		});

		expect(models).toHaveLength(0);
	});

	it("prefers a real upstream id over a synthesized variant", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "claude-opus-4.6",
					name: "Claude Opus 4.6",
					window: 1_000_000,
					maxOutput: 64_000,
					defaultContextMax: 200_000,
					longContextMax: 936_000,
				}),
				tieredCopilotEntry({
					id: "claude-opus-4.6-1m",
					name: "Claude Opus 4.6 1M (served)",
					window: 999_000,
					maxOutput: 64_000,
				}),
			],
		});

		const served = models.filter(candidate => candidate.id === "claude-opus-4.6-1m");
		expect(served).toHaveLength(1);
		expect(served[0]?.contextWindow).toBe(999_000);
		expect(served[0]?.requestModelId).toBeUndefined();
	});
});

describe("github copilot vision endpoint policy", () => {
	const businessApiKey = JSON.stringify({
		token: "ghu_business_token",
		apiEndpoint: "https://api.business.githubcopilot.com",
	});
	const enterpriseApiKey = JSON.stringify({
		token: "ghu_enterprise_token",
		enterpriseUrl: "ghe.example.com",
	});

	it("keeps vision when discovery resolves to the business endpoint and upstream reports it", async () => {
		const { models } = await discoverCopilotModels(
			{
				data: [
					tieredCopilotEntry({
						id: "claude-sonnet-4.6",
						name: "Claude Sonnet 4.6",
						window: 200_000,
						maxOutput: 32_000,
						vision: true,
					}),
				],
			},
			businessApiKey,
			"https://api.business.githubcopilot.com",
			"ghu_business_token",
		);
		const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
		expect(model?.baseUrl).toBe("https://api.business.githubcopilot.com");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("keeps vision when discovery resolves to an enterprise host and upstream reports it", async () => {
		const { models } = await discoverCopilotModels(
			{
				data: [
					tieredCopilotEntry({
						id: "claude-sonnet-4.6",
						name: "Claude Sonnet 4.6",
						window: 200_000,
						maxOutput: 32_000,
						vision: true,
					}),
				],
			},
			enterpriseApiKey,
			"https://copilot-api.ghe.example.com",
			"ghu_enterprise_token",
		);
		const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
		expect(model?.baseUrl).toBe("https://copilot-api.ghe.example.com");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("maps explicit upstream vision false to text-only on non-personal Copilot endpoints", async () => {
		for (const endpoint of [
			{
				apiKey: businessApiKey,
				baseUrl: "https://api.business.githubcopilot.com",
				token: "ghu_business_token",
			},
			{
				apiKey: enterpriseApiKey,
				baseUrl: "https://copilot-api.ghe.example.com",
				token: "ghu_enterprise_token",
			},
		]) {
			const { models } = await discoverCopilotModels(
				{
					data: [
						tieredCopilotEntry({
							id: "claude-sonnet-4.6",
							name: "Claude Sonnet 4.6",
							window: 200_000,
							maxOutput: 32_000,
							vision: false,
						}),
					],
				},
				endpoint.apiKey,
				endpoint.baseUrl,
				endpoint.token,
			);
			const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
			expect(model?.baseUrl).toBe(endpoint.baseUrl);
			expect(model?.input).toEqual(["text"]);
		}
	});

	it("maps omitted upstream vision to text-only on non-personal Copilot endpoints", async () => {
		for (const endpoint of [
			{
				apiKey: businessApiKey,
				baseUrl: "https://api.business.githubcopilot.com",
				token: "ghu_business_token",
			},
			{
				apiKey: enterpriseApiKey,
				baseUrl: "https://copilot-api.ghe.example.com",
				token: "ghu_enterprise_token",
			},
		]) {
			const { models } = await discoverCopilotModels(
				{
					data: [
						tieredCopilotEntry({
							id: "claude-sonnet-4.6",
							name: "Claude Sonnet 4.6",
							window: 200_000,
							maxOutput: 32_000,
						}),
					],
				},
				endpoint.apiKey,
				endpoint.baseUrl,
				endpoint.token,
			);
			const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
			expect(model?.baseUrl).toBe(endpoint.baseUrl);
			expect(model?.input).toEqual(["text"]);
		}
	});

	it("keeps vision on the canonical personal Copilot endpoint", async () => {
		const { models } = await discoverCopilotModels({
			data: [
				tieredCopilotEntry({
					id: "claude-sonnet-4.6",
					name: "Claude Sonnet 4.6",
					window: 200_000,
					maxOutput: 32_000,
					vision: true,
				}),
			],
		});
		const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
		expect(model?.baseUrl).toBe("https://api.githubcopilot.com");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("keeps explicit upstream vision false text-only through the personal endpoint manager merge", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-vision-"));
		try {
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				expect(url).toBe("https://api.githubcopilot.com/models");
				expect(init?.method).toBe("GET");
				expect(getHeaderValue(init?.headers, "Authorization")).toBe("Bearer copilot-test-key");
				return new Response(
					JSON.stringify({
						data: [
							tieredCopilotEntry({
								id: "claude-sonnet-4.6",
								name: "Claude Sonnet 4.6",
								window: 200_000,
								maxOutput: 32_000,
								vision: false,
							}),
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const bundled = getBundledModel("github-copilot", "claude-sonnet-4.6");
			expect(bundled?.input).toEqual(["text", "image"]);

			const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: fetchMock });
			const manager = createModelManager({
				...options,
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");
			const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
			expect(model?.baseUrl).toBe("https://api.githubcopilot.com");
			expect(model?.input).toEqual(["text"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps the merged Model image-capable when business discovery confirms a vision-capable bundled reference", async () => {
		// Bundled `claude-sonnet-4.6` ships with `input=['text','image']`.
		// Discovery against the business host confirms the same upstream vision
		// capability; the full manager merge must preserve image input instead
		// of downgrading solely because the baseUrl is non-personal.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-copilot-vision-"));
		try {
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				expect(url).toBe("https://api.business.githubcopilot.com/models");
				expect(getHeaderValue(init?.headers, "Authorization")).toBe("Bearer ghu_business_token");
				return new Response(
					JSON.stringify({
						data: [
							tieredCopilotEntry({
								id: "claude-sonnet-4.6",
								name: "Claude Sonnet 4.6",
								window: 200_000,
								maxOutput: 32_000,
								vision: true,
							}),
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const bundled = getBundledModel("github-copilot", "claude-sonnet-4.6");
			expect(bundled?.input).toEqual(["text", "image"]);
			expect(bundled?.baseUrl).toBe("https://api.githubcopilot.com");

			const options = githubCopilotModelManagerOptions({ apiKey: businessApiKey, fetch: fetchMock });
			const manager = createModelManager({
				...options,
				cacheDbPath: path.join(tempDir, "models.db"),
			});
			const { models } = await manager.refresh("online");
			const model = models.find(candidate => candidate.id === "claude-sonnet-4.6");
			expect(model?.baseUrl).toBe("https://api.business.githubcopilot.com");
			expect(model?.input).toEqual(["text", "image"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
