/**
 * Test totalTokens field across all providers.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI Completions: Uses native total_tokens field
 * - OpenAI Responses: Uses native total_tokens field
 * - Google: Uses native totalTokenCount field
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - Other OpenAI-compatible providers: Uses native total_tokens field
 */

import { describe, expect, it } from "bun:test";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi, Usage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: OptionsForApi<TApi> = {} as OptionsForApi<TApi>,
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Context = {
		systemPrompt: [LONG_SYSTEM_PROMPT],
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Context = {
		systemPrompt: [LONG_SYSTEM_PROMPT],
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

describe("totalTokens field", () => {
	// =========================================================================
	// Anthropic
	// =========================================================================

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic (API Key)", () => {
		it(
			"claude-haiku-4-5 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

				console.log(`\nAnthropic / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.ANTHROPIC_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	describe("Anthropic (OAuth)", () => {
		it.skipIf(!anthropicOAuthToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("anthropic", "claude-sonnet-4-20250514");

				console.log(`\nAnthropic OAuth / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: anthropicOAuthToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// OpenAI
	// =========================================================================

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions", () => {
		it(
			"gpt-4o-mini - should return totalTokens equal to sum of components",
			async () => {
				const llm: Model<"openai-completions"> = {
					...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">)!,
					api: "openai-completions",
				};

				console.log(`\nOpenAI Completions / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses", () => {
		it(
			"gpt-4o - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openai", "gpt-4o");

				console.log(`\nOpenAI Responses / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Google
	// =========================================================================

	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google", () => {
		it(
			"gemini-2.0-flash - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("google", "gemini-2.0-flash");

				console.log(`\nGoogle / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// xAI
	// =========================================================================

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI", () => {
		it(
			"grok-3-fast - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("xai", "grok-3-fast");

				console.log(`\nxAI / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.XAI_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Groq
	// =========================================================================

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq", () => {
		it(
			"openai/gpt-oss-120b - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("groq", "openai/gpt-oss-120b");

				console.log(`\nGroq / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.GROQ_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Cerebras
	// =========================================================================

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras", () => {
		it(
			"gpt-oss-120b - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("cerebras", "gpt-oss-120b");

				console.log(`\nCerebras / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.CEREBRAS_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// z.ai
	// =========================================================================

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("z.ai", () => {
		it(
			"glm-4.5-flash - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("zai", "glm-4.5-flash");

				console.log(`\nz.ai / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.ZAI_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Mistral
	// =========================================================================

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral", () => {
		it(
			"devstral-medium-latest - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("mistral", "devstral-medium-latest");

				console.log(`\nMistral / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.MISTRAL_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// OpenRouter - Multiple backend providers
	// =========================================================================

	describe.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))("OpenRouter", () => {
		it(
			"anthropic/claude-sonnet-4 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openrouter", "anthropic/claude-sonnet-4");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it(
			"deepseek/deepseek-chat - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openrouter", "deepseek/deepseek-chat");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it(
			"mistralai/mistral-small-3.1-24b-instruct - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openrouter", "mistralai/mistral-small-3.1-24b-instruct");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it(
			"google/gemini-2.0-flash-001 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openrouter", "google/gemini-2.0-flash-001");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it(
			"meta-llama/llama-4-maverick - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openrouter", "meta-llama/llama-4-maverick");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: Bun.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// GitHub Copilot (OAuth)
	// =========================================================================

	describe("GitHub Copilot (OAuth)", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Google Gemini CLI (OAuth)
	// =========================================================================

	describe("Google Gemini CLI (OAuth)", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");

				console.log(`\nGoogle Gemini CLI / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: geminiCliToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// Google Antigravity (OAuth)
	// =========================================================================

	describe("Google Antigravity (OAuth)", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("google-antigravity", "gemini-3-flash");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("google-antigravity", "gpt-oss-120b-medium");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});

	// =========================================================================
	// OpenAI Codex (OAuth)
	// =========================================================================

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should return totalTokens equal to sum of components",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");

				console.log(`\nOpenAI Codex / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: openaiCodexToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
			{ retry: 3, timeout: 60000 },
		);
	});
});
