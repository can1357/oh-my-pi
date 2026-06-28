import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { createModelManager } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { githubCopilotModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";

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
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock, requestApiVersions };
}

describe("github copilot model limits mapping", () => {
	it("uses configured base URL for discovery", async () => {
		const { fetchMock } = await discoverCopilotModels(
			{ data: [] },
			"copilot-test-key",
			"https://api.githubcopilot.com",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
		const { models, fetchMock } = await discoverCopilotModels({
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
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(1_048_576);
		expect(model?.maxTokens).toBe(64_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
		expect(model).toBeDefined();
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
		expect(model).toBeDefined();
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(16_000);
	});

	it("keeps bundled Copilot fallback limits truthful offline", () => {
		expect(getBundledModel("github-copilot", "claude-opus-4.6")).toMatchObject({
			contextWindow: 168_000,
			maxTokens: 32_000,
		});
		expect(getBundledModel("github-copilot", "gpt-5.2")).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		expect(getBundledModel("github-copilot", "gpt-5.4-mini")).toMatchObject({
			contextWindow: 272_000,
			maxTokens: 128_000,
		});
		expect(getBundledModel("github-copilot", "grok-code-fast-1")).toMatchObject({
			contextWindow: 192_000,
			maxTokens: 64_000,
		});
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
		expect(model).toBeDefined();
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
		expect(model).toBeDefined();
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
			expect(model).toBeDefined();
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
		expect(model).toBeDefined();
		// Should use the Copilot-specific bundled reference (272k after models.json fix),
		// not the OpenAI global reference (1050k).
		expect(model?.contextWindow).toBe(272_000);
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
		expect(base).toBeDefined();
		expect(base?.api).toBe("anthropic-messages");
		expect(base?.contextWindow).toBe(264_000);
		expect(base?.maxTokens).toBe(64_000);
		expect(base?.contextPromotionTarget).toBe("github-copilot/claude-opus-4.7-1m");
		expect(base?.headers?.["X-GitHub-Api-Version"]).toBe("2026-06-01");

		const variant = models.find(candidate => candidate.id === "claude-opus-4.7-1m");
		expect(variant).toBeDefined();
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
		expect(variant).toBeDefined();
		expect(variant?.cost).toEqual({ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0 });
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

	it("strips vision when discovery resolves to the business endpoint, even though upstream reports it", async () => {
		// `api.business.githubcopilot.com` responds `400 vision is not supported`
		// on image inputs (issue #3387), so the catalog MUST ignore the upstream's
		// `supports.vision = true` flag for non-personal hosts.
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
		expect(model?.input).toEqual(["text"]);
	});

	it("strips vision when discovery resolves to an enterprise host", async () => {
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
		expect(model?.input).toEqual(["text"]);
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

	it("downgrades the merged Model to text-only when business discovery overrides a vision-capable bundled reference", async () => {
		// Bundled `claude-sonnet-4.6` ships with `input=['text','image']` and the
		// canonical baseUrl. Discovery against the business host hands back a
		// dynamic entry with the business baseUrl; the merge MUST honour the
		// dynamic side's text-only capability instead of OR-upgrading.
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
			expect(model?.input).toEqual(["text"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
