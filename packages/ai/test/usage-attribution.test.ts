import { describe, expect, it } from "bun:test";
import { applyAnthropicUsageExtras } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic";
import { parseChunkUsage } from "@pk-nerdsaver-ai/pi-ai/providers/openai-completions";
import {
	calculateOpenAIUsageAccounting,
	populateResponsesUsageFromResponse,
} from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, Usage } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";

const OPENAI_MODEL: Model<"openai-completions"> = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function blankUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("openai-completions parseChunkUsage", () => {
	it("does not double-count reasoning_tokens (subset of completion_tokens)", () => {
		// OpenAI spec: reasoning_tokens is a subset of completion_tokens (the total billed output).
		// A 100-token completion that included 40 reasoning tokens should report output=100, not 140.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 1_000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: 200 },
				completion_tokens_details: { reasoning_tokens: 40 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.output).toBe(100);
		expect(usage.input).toBe(800);
		expect(usage.cacheRead).toBe(200);
		expect(usage.totalTokens).toBe(1_100);
		expect(usage.reasoningTokens).toBe(40);
	});

	it("omits reasoningTokens when no reasoning_tokens are reported", () => {
		const usage = parseChunkUsage({ prompt_tokens: 50, completion_tokens: 25 }, OPENAI_MODEL, undefined);

		expect(usage.reasoningTokens).toBeUndefined();
		expect(usage.output).toBe(25);
	});

	it("attributes OpenRouter cache_write_tokens to cacheWrite, not input", () => {
		// OpenRouter (https://openrouter.ai/docs/guides/best-practices/prompt-caching)
		// reports cache writes via prompt_tokens_details.cache_write_tokens and
		// INCLUDES them in prompt_tokens. Naively subtracting only cached_tokens
		// leaves cache-write tokens stuck in `input`.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 5_500 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(500);
		expect(usage.cacheWrite).toBe(5_500);
		expect(usage.cacheRead).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("attributes OpenRouter cache_read_tokens correctly when cache is warm", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_tokens_details: { cached_tokens: 5_800, cache_write_tokens: 0 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(200);
		expect(usage.cacheRead).toBe(5_800);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("maps DeepSeek prompt_cache_hit_tokens + prompt_cache_miss_tokens correctly", () => {
		// DeepSeek (https://api-docs.deepseek.com/api/create-chat-completion)
		// exposes cache hit/miss at the top level where prompt_tokens = hit + miss.
		// The miss portion IS the billed input.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 150,
				completion_tokens: 200,
				prompt_cache_hit_tokens: 100,
				prompt_cache_miss_tokens: 50,
			},
			OPENAI_MODEL,
			undefined,
		);

		// input = prompt_tokens - hit_tokens = 150 - 100 = 50 (miss = billed input)
		expect(usage.input).toBe(50);
		expect(usage.output).toBe(200);
		expect(usage.cacheRead).toBe(100);
		// DeepSeek does not expose cache creation data; cacheWrite must be 0
		// to avoid downstream double-counting (input already equals miss).
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(350); // 50 + 200 + 100 + 0
	});

	it("handles DeepSeek with only cache hits (miss=0)", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 100,
				completion_tokens: 200,
				prompt_cache_hit_tokens: 100,
				prompt_cache_miss_tokens: 0,
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(0);
		expect(usage.cacheRead).toBe(100);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(300);
	});

	it("handles DeepSeek with only cache misses (hit=0)", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 100,
				completion_tokens: 200,
				prompt_cache_hit_tokens: 0,
				prompt_cache_miss_tokens: 100,
			},
			OPENAI_MODEL,
			undefined,
		);

		// input = prompt_tokens - hit_tokens = 100 - 0 = 100 (all billed)
		expect(usage.input).toBe(100);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(300); // 100 + 200 + 0 + 0
	});

	it("does not confuse OpenRouter responses with DeepSeek format", () => {
		// OpenRouter response where prompt_tokens_details exists but
		// no top-level prompt_cache_* fields — must NOT trigger DeepSeek path.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 5_000 },
			},
			OPENAI_MODEL,
			undefined,
		);

		expect(usage.input).toBe(800); // 6000 - 200 - 5000
		expect(usage.cacheRead).toBe(200);
		expect(usage.cacheWrite).toBe(5_000);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("uses OpenRouter path when DeepSeek routes through OpenRouter with both field sets", () => {
		// Hypothetical: DeepSeek model via OpenRouter where OpenRouter passes
		// through native prompt_cache_* fields AND adds its own
		// prompt_tokens_details.cache_write_tokens.
		// Must NOT trigger DeepSeek path — cacheWrite came from OpenRouter,
		// which bills it on top of prompt_tokens.
		const usage = parseChunkUsage(
			{
				prompt_tokens: 6_000,
				completion_tokens: 250,
				prompt_cache_hit_tokens: 200,
				prompt_cache_miss_tokens: 50,
				prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 5_000 },
			},
			OPENAI_MODEL,
			undefined,
		);

		// cacheWrite from OpenRouter (5000), not DeepSeek miss (50).
		// input = 6000 - 200 - 5000 = 800 (OpenRouter formula).
		expect(usage.input).toBe(800);
		expect(usage.cacheRead).toBe(200);
		expect(usage.cacheWrite).toBe(5_000);
		expect(usage.totalTokens).toBe(6_250);
	});
});

describe("shared OpenAI usage accounting", () => {
	it("uses provider cache-write details ahead of native DeepSeek passthrough fields", () => {
		const usage = calculateOpenAIUsageAccounting({
			promptTokens: 6_000,
			outputTokens: 250,
			cachedTokens: 200,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 5_000,
			cacheWriteDeepSeek: 50,
			hasDeepSeekCacheHitAndMiss: true,
		});

		expect(usage.input).toBe(800);
		expect(usage.cacheRead).toBe(200);
		expect(usage.cacheWrite).toBe(5_000);
		expect(usage.totalTokens).toBe(6_250);
	});

	it("does not emit DeepSeek cache misses as cache writes", () => {
		const usage = calculateOpenAIUsageAccounting({
			promptTokens: 150,
			outputTokens: 200,
			cachedTokens: 100,
			reasoningTokens: 0,
			cacheWriteOpenRouter: undefined,
			cacheWriteDeepSeek: 50,
			hasDeepSeekCacheHitAndMiss: true,
		});

		expect(usage.input).toBe(50);
		expect(usage.cacheRead).toBe(100);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(350);
	});

	it("treats zero provider cache-write as present when native fields pass through", () => {
		const usage = calculateOpenAIUsageAccounting({
			promptTokens: 150,
			outputTokens: 25,
			cachedTokens: 100,
			reasoningTokens: 0,
			cacheWriteOpenRouter: 0,
			cacheWriteDeepSeek: 50,
			hasDeepSeekCacheHitAndMiss: true,
		});

		expect(usage.input).toBe(50);
		expect(usage.cacheRead).toBe(100);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(175);
	});
});

describe("openai-responses usage attribution", () => {
	it("folds Fugu Ultra orchestration token details into billable usage", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "sakana",
			model: "fugu-ultra",
			usage: blankUsage(),
			stopReason: "stop",
			timestamp: 0,
		};

		populateResponsesUsageFromResponse(output, {
			input_tokens: 120,
			output_tokens: 80,
			total_tokens: 270,
			input_tokens_details: {
				cached_tokens: 10,
				orchestration_input_tokens: 30,
				orchestration_input_cached_tokens: 5,
			},
			output_tokens_details: {
				orchestration_output_tokens: 40,
			},
		});

		expect(output.usage.input).toBe(135);
		expect(output.usage.cacheRead).toBe(15);
		expect(output.usage.output).toBe(120);
		expect(output.usage.totalTokens).toBe(270);
	});
});

describe("anthropic applyAnthropicUsageExtras", () => {
	it("captures cache TTL breakdown when both buckets are non-zero", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: {
				ephemeral_5m_input_tokens: 1_200,
				ephemeral_1h_input_tokens: 800,
			},
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 1_200, ephemeral1h: 800 });
	});

	it("only sets the bucket the provider populated", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 50 });
		expect(usage.cttl?.ephemeral1h).toBeUndefined();
	});

	it("captures server tool requests", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
		});

		expect(usage.server).toEqual({ webSearch: 3, webFetch: 1 });
	});

	it("leaves serverToolUse undefined when both counters are zero", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
		});

		expect(usage.server).toBeUndefined();
	});

	it("does not clobber a previously-populated breakdown when called with no cache_creation field (message_delta case)", () => {
		// message_start populated the 5m/1h split; message_delta lacks cache_creation
		// but reports cumulative server_tool_use. The helper must not erase the breakdown
		// already on the usage object.
		const usage = blankUsage();
		usage.cttl = { ephemeral5m: 100, ephemeral1h: 200 };

		applyAnthropicUsageExtras(usage, {
			server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
		});

		expect(usage.cttl).toEqual({ ephemeral5m: 100, ephemeral1h: 200 });
		expect(usage.server).toEqual({ webSearch: 2 });
	});

	it("treats null SDK fields as absent (cache_creation: null skips breakdown)", () => {
		const usage = blankUsage();
		applyAnthropicUsageExtras(usage, {
			cache_creation: null,
			server_tool_use: null,
		});

		expect(usage.cttl).toBeUndefined();
		expect(usage.server).toBeUndefined();
	});
});
