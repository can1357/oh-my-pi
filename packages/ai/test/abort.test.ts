import { describe, expect, it } from "bun:test";
import { complete, stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const [geminiCliToken, openaiCodexToken] = await Promise.all([
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("openai-codex"),
]);

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const controller = new AbortController();

	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

describe("AI Providers Abort Tests", () => {
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google Provider Abort", () => {
		const llm = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should abort mid-stream",
			async () => {
				await testAbortSignal(llm, { thinking: { enabled: true } });
			},
			{ retry: 3 },
		);

		it(
			"should handle immediate abort",
			async () => {
				await testImmediateAbort(llm, { thinking: { enabled: true } });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider Abort", () => {
		const llm: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini")!,
			api: "openai-completions",
		};

		it(
			"should abort mid-stream",
			async () => {
				await testAbortSignal(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle immediate abort",
			async () => {
				await testImmediateAbort(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider Abort", () => {
		const llm = getBundledModel("openai", "gpt-5-mini");

		it(
			"should abort mid-stream",
			async () => {
				await testAbortSignal(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle immediate abort",
			async () => {
				await testImmediateAbort(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider Abort", () => {
		const llm = getBundledModel("anthropic", "claude-opus-4-1-20250805");

		it(
			"should abort mid-stream",
			async () => {
				await testAbortSignal(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			},
			{ retry: 3 },
		);

		it(
			"should handle immediate abort",
			async () => {
				await testImmediateAbort(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider Abort", () => {
		const llm = getBundledModel("mistral", "devstral-medium-latest");

		it(
			"should abort mid-stream",
			async () => {
				await testAbortSignal(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle immediate abort",
			async () => {
				await testImmediateAbort(llm);
			},
			{ retry: 3 },
		);
	});

	// Google Gemini CLI / Antigravity share the same provider, so one test covers both
	describe("Google Gemini CLI Provider Abort", () => {
		it.skipIf(!geminiCliToken)(
			"should abort mid-stream",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testAbortSignal(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle immediate abort",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testImmediateAbort(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);
	});

	describe("OpenAI Codex Provider Abort", () => {
		it.skipIf(!openaiCodexToken)(
			"should abort mid-stream",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testAbortSignal(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle immediate abort",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testImmediateAbort(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);
	});
});
