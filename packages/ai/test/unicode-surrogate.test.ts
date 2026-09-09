import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Empty schema for test tools - must be proper OBJECT type for Cloud Code Assist
const emptySchema = type({});

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

/**
 * Test for Unicode surrogate pair handling in tool results.
 *
 * Issue: When tool results contain emoji or other characters outside the Basic Multilingual Plane,
 * they may be incorrectly serialized as unpaired surrogates, causing "no low surrogate in string"
 * errors when sent to the API provider.
 *
 * Example error from Anthropic:
 * "The request body is not valid JSON: no low surrogate in string: line 1 column 197667"
 */

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Simulate a tool that returns emoji
	const context: Context = {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "test_1",
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Add tool result with various problematic Unicode characters
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "test_1",
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Add follow-up user message
	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "linkedin_1",
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	// Real-world tool result from LinkedIn with emoji
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "linkedin_1",
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some(b => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "test_2",
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Construct a string with an intentionally unpaired high surrogate
	// This simulates what might happen if text processing corrupts emoji
	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "test_2",
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	// The unpaired surrogate should be sanitized before sending to API
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google Provider Unicode Handling", () => {
		const llm = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider Unicode Handling", () => {
		const llm = getBundledModel("openai", "gpt-4o-mini");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider Unicode Handling", () => {
		const llm = getBundledModel("openai", "gpt-5-mini");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider Unicode Handling", () => {
		const llm = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Anthropic OAuth Provider Unicode Handling", () => {
		const llm = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it.skipIf(!anthropicOAuthToken)(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("GitHub Copilot Provider Unicode Handling", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Gemini CLI Provider Unicode Handling", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testEmojiInToolResults(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testRealWorldLinkedInData(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testUnpairedHighSurrogate(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Antigravity Provider Unicode Handling", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "gemini-3-flash");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("google-antigravity", "gemini-3-flash");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "gemini-3-flash");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "gpt-oss-120b-medium");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("google-antigravity", "gpt-oss-120b-medium");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("google-antigravity", "gpt-oss-120b-medium");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI Provider Unicode Handling", () => {
		const llm = getBundledModel("xai", "grok-3");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq Provider Unicode Handling", () => {
		const llm = getBundledModel("groq", "openai/gpt-oss-20b");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras Provider Unicode Handling", () => {
		const llm = getBundledModel("cerebras", "gpt-oss-120b");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider Unicode Handling", () => {
		const llm = getBundledModel("zai", "glm-4.5-air");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider Unicode Handling", () => {
		const llm = getBundledModel("mistral", "devstral-medium-latest");

		it(
			"should handle emoji in tool results",
			async () => {
				await testEmojiInToolResults(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle real-world LinkedIn comment data with emoji",
			async () => {
				await testRealWorldLinkedInData(llm);
			},
			{ retry: 3, timeout: 30000 },
		);

		it(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				await testUnpairedHighSurrogate(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("OpenAI Codex Provider Unicode Handling", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle emoji in tool results",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testEmojiInToolResults(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle real-world LinkedIn comment data with emoji",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testRealWorldLinkedInData(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle unpaired high surrogate (0xD83D) in tool results",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testUnpairedHighSurrogate(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
