import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { straitlyModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { normalizeStraitlyBaseUrl } from "@oh-my-pi/pi-catalog/wire/straitly";

// Fixtures mirror the live `https://api.straitly.ai/v1/models` response shape
// with synthetic per-token rates so tests never pin live billing numbers.
const STRAITLY_ROWS: Record<string, unknown>[] = [
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		context_length: 1_000_000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { context_length: 1_000_000, max_completion_tokens: 32_768 },
		supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
		reasoning: { mandatory: false, default_enabled: true, default_effort: "high" },
		pricing: {
			prompt: "0.000001",
			completion: "0.000005",
			input_cache_read: "0.0000001",
			input_cache_write: "0.00000125",
		},
	},
	{
		id: "deepseek/deepseek-v4-1-flash-1017",
		name: "DeepSeek V4.1 Flash 1017",
		context_length: 1_048_576,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { context_length: 1_048_576, max_completion_tokens: 1_048_576 },
		catalog: { max_output_tokens: 1_048_576, vision: true, reasoning: true },
		supported_parameters: ["max_tokens", "tool_choice", "tools"],
		reasoning: null,
		pricing: {
			prompt: "0.0000002",
			completion: "0.0000008",
			input_cache_read: "0.00000002",
			input_cache_write: "0.0000002",
		},
	},
	{
		id: "text-only-no-tools",
		name: "Text Only Model",
		context_length: 65_536,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		top_provider: { context_length: 65_536, max_completion_tokens: 8_192 },
		supported_parameters: ["max_tokens", "temperature"],
		reasoning: null,
		pricing: { prompt: "0.0000005", completion: "0.0000015" },
	},
	{
		id: "mandatory-reasoner",
		name: "Mandatory Reasoner",
		context_length: 262_144,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		top_provider: { context_length: 262_144, max_completion_tokens: 32_768 },
		supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
		reasoning: { mandatory: true, default_enabled: true, default_effort: "high" },
		pricing: { prompt: "0.000001", completion: "0.000004" },
	},
	{
		id: "default-off-reasoner",
		name: "Default Off Reasoner",
		context_length: 200_000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { context_length: 200_000, max_completion_tokens: 16_384 },
		supported_parameters: ["max_tokens", "reasoning", "reasoning_effort", "tool_choice", "tools"],
		reasoning: { mandatory: false, default_enabled: false, default_effort: null },
		pricing: { prompt: "0.000001", completion: "0.000003" },
	},
];

function makeModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ object: "list", data: STRAITLY_ROWS }), {
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

async function discover(fetch: FetchImpl, baseUrl?: string) {
	const options = straitlyModelManagerOptions({ apiKey: "sk-straitly-test", fetch, baseUrl });
	const specs = (await options.fetchDynamicModels?.()) ?? [];
	return specs.map(spec => buildModel(spec));
}

describe("Straitly provider", () => {
	test("discovers models, modalities, tool flags, reasoning, and per-token pricing", async () => {
		const mock = makeModelsFetch();
		const models = await discover(mock.fetch);

		expect(mock.calls).toEqual(["https://api.straitly.ai/v1/models"]);
		expect(mock.authorizations).toEqual(["Bearer sk-straitly-test"]);

		const sonnet = models.find(model => model.id === "claude-sonnet-5-5");
		expect(sonnet?.name).toBe("Claude Sonnet 5.5");
		expect(sonnet?.provider).toBe("straitly");
		expect(sonnet?.baseUrl).toBe("https://api.straitly.ai/v1");
		expect(sonnet?.reasoning).toBe(true);
		expect(sonnet?.input).toEqual(["text", "image"]);
		expect(sonnet?.contextWindow).toBe(1_000_000);
		expect(sonnet?.maxTokens).toBe(32_768);
		expect(sonnet?.cost.input).toBeCloseTo(1, 6);
		expect(sonnet?.cost.output).toBeCloseTo(5, 6);
		expect(sonnet?.cost.cacheRead).toBeCloseTo(0.1, 6);
		expect(sonnet?.cost.cacheWrite).toBeCloseTo(1.25, 6);
		expect(sonnet?.thinking?.defaultLevel).toBe(Effort.High);
		expect(sonnet?.thinking?.requiresEffort).not.toBe(true);
		expect(sonnet?.compat?.reasoningDisableMode).toBe("cline-enabled-false");

		const deepseek = models.find(model => model.id === "deepseek/deepseek-v4-1-flash-1017");
		expect(deepseek?.reasoning).toBe(true);
		expect(deepseek?.input).toEqual(["text", "image"]);
		expect(deepseek?.contextWindow).toBe(1_048_576);
		expect(deepseek?.maxTokens).toBe(1_048_576);
		expect(deepseek?.supportsTools).not.toBe(false);
		expect(deepseek?.compat?.supportsReasoningEffort).toBe(false);

		const textOnly = models.find(model => model.id === "text-only-no-tools");
		expect(textOnly?.reasoning).toBe(false);
		expect(textOnly?.input).toEqual(["text"]);
		expect(textOnly?.supportsTools).toBe(false);
		expect(textOnly?.compat?.supportsToolChoice).toBe(false);

		const mandatory = models.find(model => model.id === "mandatory-reasoner");
		expect(mandatory?.reasoning).toBe(true);
		expect(mandatory?.thinking?.requiresEffort).toBe(true);
		expect(mandatory?.thinking?.defaultLevel).toBe(Effort.High);
		expect(mandatory?.compat?.reasoningDisableMode).toBe("lowest-effort");

		const defaultOff = models.find(model => model.id === "default-off-reasoner");
		expect(defaultOff?.reasoning).toBe(true);
		expect(defaultOff?.compat?.whenThinking?.extraBody).toEqual({ reasoning: { enabled: true } });
	});

	test("normalizes custom baseUrl overrides and scopes cache namespace by endpoint only", async () => {
		expect(normalizeStraitlyBaseUrl(undefined)).toBe("https://api.straitly.ai/v1");
		expect(normalizeStraitlyBaseUrl("   ")).toBe("https://api.straitly.ai/v1");
		expect(normalizeStraitlyBaseUrl("https://proxy.example")).toBe("https://proxy.example/v1");
		expect(normalizeStraitlyBaseUrl("https://proxy.example/v1/")).toBe("https://proxy.example/v1");

		const mock = makeModelsFetch();
		await discover(mock.fetch, "https://proxy.example");
		expect(mock.calls).toEqual(["https://proxy.example/v1/models"]);

		const canonical = resolveModelCacheProviderId("straitly", {});
		expect(straitlyModelManagerOptions().cacheProviderId).toBe(canonical);
		expect(resolveModelCacheProviderId("straitly", { baseUrl: "   " })).toBe(canonical);

		const proxyViaManager = straitlyModelManagerOptions({ baseUrl: "https://proxy.example" }).cacheProviderId;
		expect(proxyViaManager).not.toBe(canonical);
		expect(proxyViaManager).toBe(resolveModelCacheProviderId("straitly", { baseUrl: "https://proxy.example" }));
		expect(proxyViaManager).toBe(resolveModelCacheProviderId("straitly", { baseUrl: "https://proxy.example/v1/" }));
		expect(resolveModelCacheProviderId("straitly", { baseUrl: "https://proxy.example", apiKey: "sk-a" })).toBe(
			resolveModelCacheProviderId("straitly", { baseUrl: "https://proxy.example", apiKey: "sk-b" }),
		);
	});
});
