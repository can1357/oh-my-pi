import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	fetchMergeGatewayModels,
	isCredentialScopedModelCacheProvider,
	mapMergeGatewayModel,
	mergeGatewayModelManagerOptions,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function route(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		context_window: 1_000_000,
		max_output_tokens: 128_000,
		availability_status: "available",
		zero_data_retention: true,
		capabilities: {
			input: ["text", "image"],
			output: ["text", "tool_use"],
			supports_tool_calling: true,
			supports_tool_choice: true,
			supports_structured_outputs: true,
			supports_reasoning: true,
			reasoning: {
				configurable: true,
				effort_values: ["none", "low", "high", "max"],
				disable_supported: false,
				output_style: "reasoning_content",
			},
			streaming: true,
		},
		pricing: {
			input_per_million: 1,
			output_per_million: 4,
			cache_read_per_million: 0.1,
			cache_write_per_million: 1.25,
		},
		service_tiers: ["standard"],
		...overrides,
	};
}

function model(id: string, vendors: Record<string, unknown>): Record<string, unknown> {
	return {
		model: id,
		provider: id.split("/")[0],
		display_name: `Display ${id}`,
		vendors,
		availability_status: "available",
	};
}

describe("Merge Gateway provider", () => {
	test("registers an authoritative first-class provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "merge-gateway");
		expect(descriptor).toMatchObject({
			defaultModel: "openai/gpt-5.6-sol",
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "Merge Gateway", envVars: ["MERGE_GATEWAY_API_KEY"] },
		});
		const manager = mergeGatewayModelManagerOptions();
		expect(manager).toMatchObject({
			providerId: "merge-gateway",
			dynamicModelsAuthoritative: true,
			dynamicModelsReplaceExisting: true,
		});
		expect(isCredentialScopedModelCacheProvider("merge-gateway")).toBe(true);
		expect(manager.cacheProviderId).toStartWith("merge-gateway:");
		expect(
			mergeGatewayModelManagerOptions({ baseUrl: "https://gateway.example/v1/openai" }).cacheProviderId,
		).not.toBe(manager.cacheProviderId);
		expect(mergeGatewayModelManagerOptions({ apiKey: "account-a" }).cacheProviderId).not.toBe(
			mergeGatewayModelManagerOptions({ apiKey: "account-b" }).cacheProviderId,
		);
	});

	test("links live OpenAI routes to their context-promotion sibling", async () => {
		const dynamic = await mergeGatewayModelManagerOptions({
			apiKey: "account-a",
			fetch: async () =>
				Response.json({
					object: "list",
					data: [model("openai/gpt-5.5", { openai: route() }), model("openai/gpt-5.4", { openai: route() })],
					has_more: false,
					next_cursor: null,
				}),
		}).fetchDynamicModels?.();
		expect(dynamic?.find(model => model.id === "openai/gpt-5.5")?.contextPromotionTarget).toBe(
			"merge-gateway/openai/gpt-5.4",
		);
	});

	test("replaces stale bundled fields with authoritative live metadata", async () => {
		const stale = mapMergeGatewayModel(
			model("example/replace-me", { vendor: route() }),
			"https://api-gateway.merge.dev/v1/openai",
		);
		const live = mapMergeGatewayModel(
			model("example/replace-me", {
				vendor: route({
					context_window: null,
					max_output_tokens: null,
					zero_data_retention: false,
					capabilities: {
						input: ["text"],
						output: ["text", "tool_use"],
						supports_tool_calling: true,
						supports_tool_choice: false,
						supports_structured_outputs: false,
						supports_reasoning: false,
						streaming: true,
					},
					pricing: {
						input_per_million: 0,
						output_per_million: 0,
						cache_read_per_million: null,
						cache_write_per_million: null,
					},
				}),
			}),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(stale).not.toBeNull();
		expect(live).not.toBeNull();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-gateway-model-manager-"));
		try {
			const result = await resolveProviderModels(
				{
					providerId: "merge-gateway",
					staticModels: [stale!],
					dynamicModelsAuthoritative: true,
					dynamicModelsReplaceExisting: true,
					fetchDynamicModels: async () => [live!],
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);
			expect(result.models).toHaveLength(1);
			expect(result.models[0]).toMatchObject({
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
				declaredCapabilities: {
					nativeToolCalling: true,
					nativeToolChoice: false,
					nativeStructuredOutputs: false,
					streaming: true,
					zeroDataRetention: false,
				},
			});
			const failedRefresh = await resolveProviderModels(
				{
					providerId: "merge-gateway",
					staticModels: [stale!],
					dynamicModelsAuthoritative: true,
					dynamicModelsReplaceExisting: true,
					fetchDynamicModels: async () => null,
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);
			expect(failedRefresh.models[0]).toMatchObject({
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
			});
			const offline = await resolveProviderModels(
				{
					providerId: "merge-gateway",
					staticModels: [stale!],
					dynamicModelsAuthoritative: true,
					dynamicModelsReplaceExisting: true,
					fetchDynamicModels: async () => null,
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"offline",
			);
			expect(offline.models[0]).toMatchObject({
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("maps conservative cross-vendor limits, capabilities, and highest published prices", () => {
		const mapped = mapMergeGatewayModel(
			model("example/coder", {
				primary: route(),
				fallback: route({
					context_window: 256_000,
					max_output_tokens: 32_000,
					capabilities: {
						input: ["text"],
						output: ["text", "tool_use"],
						supports_tool_calling: true,
						supports_tool_choice: false,
						supports_structured_outputs: false,
						supports_reasoning: false,
						streaming: true,
					},
					pricing: { input_per_million: 2, output_per_million: 8 },
				}),
			}),
			"https://api-gateway.merge.dev/v1/openai",
		);

		expect(mapped).toMatchObject({
			id: "example/coder",
			name: "Display example/coder",
			provider: "merge-gateway",
			api: "openai-completions",
			input: ["text"],
			reasoning: false,
			contextWindow: 256_000,
			supportsTools: true,
			declaredCapabilities: {
				nativeToolCalling: true,
				nativeToolChoice: false,
				nativeStructuredOutputs: false,
				streaming: true,
				zeroDataRetention: true,
			},
			maxTokens: 32_000,
			cost: { input: 2, output: 8, cacheRead: 0.1, cacheWrite: 1.25 },
			compat: {
				supportsReasoningEffort: false,
				supportsToolChoice: false,
				supportsForcedToolChoice: false,
				supportsNamedToolChoice: false,
			},
		});
		expect(mapped).not.toHaveProperty("capabilities");
	});

	test("exposes only the reasoning effort ladder shared by every eligible route", () => {
		const mapped = mapMergeGatewayModel(
			model("example/reasoner", {
				first: route(),
				second: route({
					capabilities: {
						input: ["text", "image"],
						output: ["text", "tool_use"],
						supports_tool_calling: true,
						supports_tool_choice: true,
						supports_structured_outputs: true,
						supports_reasoning: true,
						reasoning: {
							configurable: true,
							effort_values: ["minimal", "low", "high"],
							disable_supported: false,
							output_style: "reasoning_content",
						},
						streaming: true,
					},
				}),
			}),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(mapped).not.toBeNull();
		const built = buildModel(mapped!);
		expect(built.reasoning).toBe(true);
		expect(built.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
			requiresEffort: true,
			supportsDisplay: true,
		});
		expect(built.compat.supportsReasoningEffort).toBe(true);
	});

	test("uses reasoning_effort none when every eligible route advertises portable disable", () => {
		const capabilities = {
			input: ["text"],
			output: ["text", "tool_use"],
			supports_tool_calling: true,
			supports_tool_choice: true,
			supports_structured_outputs: true,
			supports_reasoning: true,
			reasoning: {
				configurable: true,
				effort_values: ["none", "low", "high"],
				disable_supported: true,
				output_style: "reasoning_content",
			},
			streaming: true,
		};
		const mapped = mapMergeGatewayModel(
			model("example/disablable-reasoner", {
				first: route({ capabilities }),
				second: route({ capabilities }),
			}),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(mapped).not.toBeNull();
		const built = buildModel(mapped!);
		expect(built.compat.reasoningDisableMode).toBe("none-effort");
		expect(built.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
			supportsDisplay: true,
		});
	});

	test("keeps reasoning visible without inventing an effort ladder when routes disagree", () => {
		const noPortableEffort = route({
			capabilities: {
				input: ["text"],
				output: ["text", "tool_use"],
				supports_tool_calling: true,
				supports_tool_choice: true,
				supports_structured_outputs: true,
				supports_reasoning: true,
				reasoning: { configurable: false, effort_values: [] },
				streaming: true,
			},
		});
		const mapped = mapMergeGatewayModel(
			model("example/fixed-reasoner", { vendor: noPortableEffort }),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(mapped).not.toBeNull();
		const built = buildModel(mapped!);
		expect(built.reasoning).toBe(true);
		expect(built.thinking).toBeUndefined();
		expect(built.compat.supportsReasoningEffort).toBe(false);
		expect(built.compat.omitReasoningEffort).toBe(true);
	});

	test("routes reasoning omission through the compatibility axis", () => {
		const mapped = mapMergeGatewayModel(
			model("example/reasoner", { vendor: route() }),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(mapped).not.toBeNull();
		const built = buildModel({
			...mapped!,
			compat: {
				...mapped!.compat,
				supportsReasoningEffort: false,
				omitReasoningEffort: false,
			},
		});
		expect(built.compat.supportsReasoningEffort).toBe(false);
		expect(built.compat.omitReasoningEffort).toBe(false);
		expect(built.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			requiresEffort: true,
			supportsDisplay: true,
		});
	});

	test("includes tool-capable text models without structured-output support and excludes non-agentic routes", () => {
		const unstructured = route({
			capabilities: {
				input: ["text"],
				output: ["text", "tool_use"],
				supports_tool_calling: true,
				supports_tool_choice: true,
				supports_structured_outputs: false,
				supports_reasoning: false,
				streaming: true,
			},
		});
		const noTools = route({
			capabilities: {
				input: ["text"],
				output: ["text"],
				supports_tool_calling: false,
				supports_tool_choice: false,
				supports_structured_outputs: true,
				supports_reasoning: false,
				streaming: true,
			},
		});
		const noStreaming = route({
			capabilities: {
				input: ["text"],
				output: ["text", "tool_use"],
				supports_tool_calling: true,
				supports_tool_choice: true,
				supports_structured_outputs: true,
				supports_reasoning: false,
				streaming: false,
			},
		});
		expect(
			mapMergeGatewayModel(model("example/unstructured", { vendor: unstructured }), "https://gateway/v1/openai"),
		).not.toBeNull();
		expect(
			mapMergeGatewayModel(model("example/no-tools", { vendor: noTools }), "https://gateway/v1/openai"),
		).toBeNull();
		expect(
			mapMergeGatewayModel(model("example/no-stream", { vendor: noStreaming }), "https://gateway/v1/openai"),
		).toBeNull();
	});

	test("keeps Merge declarations separate from KDL-owned provider policy", () => {
		const mapped = mapMergeGatewayModel(
			model("deepseek/deepseek-v3.2", { gateway: route() }),
			"https://api-gateway.merge.dev/v1/openai",
		);
		expect(mapped).toMatchObject({
			declaredCapabilities: {
				nativeToolCalling: true,
				nativeStructuredOutputs: true,
			},
		});
		expect(mapped?.compat).not.toHaveProperty("streamMarkupHealingPattern");
		const built = buildModel(mapped!);
		expect(built.compat.streamMarkupHealingPattern).toBe("dsml");
		expect(built.compat.trustExplicitThinkingOnly).toBe(true);
		expect(built.compat.requiresStructuredOutputHardening).toBe(true);
	});

	test("paginates the native model envelope and preserves provider-prefixed IDs", async () => {
		const calls: Array<{ url: URL; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
			calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
			const cursor = url.searchParams.get("cursor");
			return Response.json(
				cursor
					? {
							object: "list",
							data: [model("zai/glm-5.3-flash", { zai: route() })],
							has_more: false,
							next_cursor: null,
						}
					: {
							object: "list",
							data: [model("openai/gpt-5.6-sol", { openai: route() })],
							has_more: true,
							next_cursor: "openai/gpt-5.6-sol",
						},
			);
		};

		const models = await fetchMergeGatewayModels({ apiKey: "test-key", fetch: fetchMock });
		expect(models?.map(item => item.id)).toEqual(["openai/gpt-5.6-sol", "zai/glm-5.3-flash"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url.pathname).toBe("/v1/models");
		expect(calls[0]?.url.searchParams.get("limit")).toBe("500");
		expect(calls[1]?.url.searchParams.get("cursor")).toBe("openai/gpt-5.6-sol");
		expect(calls.every(call => call.authorization === "Bearer test-key")).toBe(true);
	});

	test("rejects a repeated pagination cursor instead of looping", async () => {
		const fetchMock: FetchImpl = async () => Response.json({ data: [], has_more: true, next_cursor: "same" });
		await expect(fetchMergeGatewayModels({ apiKey: "test-key", fetch: fetchMock })).resolves.toBeNull();
	});
});
