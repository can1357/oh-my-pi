import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi, Tool } from "@oh-my-pi/pi-ai/types";
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

// Simple calculate tool
const calculateSchema = type({
	expression: "string",
});

const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

async function testToolCallWithoutResult<TApi extends Api>(
	model: Model<TApi>,
	options: OptionsForApi<TApi> = {} as OptionsForApi<TApi>,
) {
	// Step 1: Create context with the calculate tool
	const context: Context = {
		systemPrompt: ["You are a helpful assistant. Use the calculate tool when asked to perform calculations."],
		messages: [],
		tools: [calculateTool],
	};

	// Step 2: Ask the LLM to make a tool call
	context.messages.push({
		role: "user",
		content: "Please calculate 25 * 18 using the calculate tool.",
		timestamp: Date.now(),
	});

	// Step 3: Get the assistant's response (should contain a tool call)
	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);

	console.log("First response:", JSON.stringify(firstResponse, null, 2));

	// Verify the response contains a tool call
	const hasToolCall = firstResponse.content.some(block => block.type === "toolCall");
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	// Step 4: Send a user message WITHOUT providing tool result
	// This simulates the scenario where a tool call was aborted/cancelled
	context.messages.push({
		role: "user",
		content: "Never mind, just tell me what is 2+2?",
		timestamp: Date.now(),
	});

	// Step 5: The fix should filter out the orphaned tool call, and the request should succeed
	const secondResponse = await complete(model, context, options);
	console.log("Second response:", JSON.stringify(secondResponse, null, 2));

	// The request should succeed (not error) - that's the main thing we're testing
	expect(secondResponse.stopReason).not.toBe("error");

	// Should have some content in the response
	expect(secondResponse.content.length).toBeGreaterThan(0);

	// The LLM may choose to answer directly or make a new tool call - either is fine
	// The important thing is it didn't fail with the orphaned tool call error
	const textContent = secondResponse.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join(" ");
	const toolCalls = secondResponse.content.filter(block => block.type === "toolCall").length;
	expect(toolCalls || textContent.length).toBeGreaterThan(0);
	console.log("Answer:", textContent);

	// Verify the stop reason is either "stop" or "toolUse" (new tool call)
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

describe("Tool Call Without Result Tests", () => {
	// =========================================================================
	// API Key-based providers
	// =========================================================================

	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google Provider", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider", () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">)!,
			api: "openai-completions",
		};

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider", () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider", () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI Provider", () => {
		const model = getBundledModel("xai", "grok-3-fast");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq Provider", () => {
		const model = getBundledModel("groq", "openai/gpt-oss-20b");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras Provider", () => {
		const model = getBundledModel("cerebras", "gpt-oss-120b");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider", () => {
		const model = getBundledModel("zai", "glm-4.5-flash");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider", () => {
		const model = getBundledModel("mistral", "devstral-medium-latest");

		it(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Anthropic OAuth Provider", () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it.skipIf(!anthropicOAuthToken)(
			"should filter out tool calls without corresponding tool results",
			async () => {
				await testToolCallWithoutResult(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("github-copilot", "gpt-4o");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("github-copilot", "claude-sonnet-4");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Gemini CLI Provider", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testToolCallWithoutResult(model, { apiKey: geminiCliToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Antigravity Provider", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("google-antigravity", "gemini-3-flash");
				await testToolCallWithoutResult(model, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				await testToolCallWithoutResult(model, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("google-antigravity", "gpt-oss-120b-medium");
				await testToolCallWithoutResult(model, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should filter out tool calls without corresponding tool results",
			async () => {
				const model = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testToolCallWithoutResult(model, { apiKey: openaiCodexToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
