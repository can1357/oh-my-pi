import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { fitOutputTokensToContextWindow, MIN_FITTED_OUTPUT_TOKENS } from "../src/output-budget";
import { Tokenizer } from "../src/tokenizer";

// Contract: prompt plus requested output never exceeds the model's context
// window, which Chat Completions-style providers enforce with a 400. Test-env
// token counts are bytes/4, so `tokens * 4` ASCII bytes is exactly `tokens`.
function promptOf(tokens: number): Context {
	return { messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 0 }] };
}

function userOf(tokens: number, timestamp: number): Message {
	return { role: "user", content: "x".repeat(tokens * 4), timestamp };
}

/** Settled assistant turn whose provider-reported prompt was `promptTokens`. */
function reported(promptTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: promptTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const deepseek: Model = {
	...getBundledModel("deepseek", "deepseek-v4-pro"),
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

describe("fitOutputTokensToContextWindow", () => {
	const tokenizer = new Tokenizer();

	test("leaves the cap alone while prompt plus requested output fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), undefined, tokenizer)).toBeUndefined();
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), 2_048, tokenizer)).toBe(2_048);
		expect(
			fitOutputTokensToContextWindow({ ...deepseek, contextWindow: 0 }, promptOf(900_000), undefined, tokenizer),
		).toBeUndefined();
	});

	test("lowers the model default cap to the room the prompt leaves", () => {
		// The reported /btw request: 666,387 prompt tokens + 384,000 output > the window.
		const cap = fitOutputTokensToContextWindow(deepseek, promptOf(666_387), undefined, tokenizer);
		expect(cap).toBe(1_000_000 - (666_387 + Math.ceil(666_387 / 10)));
		expect(666_387 + (cap ?? 0)).toBeLessThanOrEqual(1_000_000);
	});

	test("lowers an explicit caller cap that no longer fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(800_000), 200_000, tokenizer)).toBe(120_000);
	});

	test("counts system prompt, active and retired tool definitions, not just messages", () => {
		const tool = (description: string) => ({ name: "t", description, parameters: {} as never });
		const context: Context = {
			systemPrompt: ["s".repeat(200_000 * 4)],
			tools: [tool("d".repeat(100_000 * 4))],
			// Anthropic replays retired definitions on the wire.
			inactiveTools: [tool("r".repeat(100_000 * 4))],
			messages: promptOf(300_000).messages,
		};
		const cap = fitOutputTokensToContextWindow(deepseek, context, undefined, tokenizer) ?? 0;
		expect(cap).toBeLessThanOrEqual(1_000_000 - 700_000);
	});

	test("keeps an OpenRouter default cap omitted, but still fits an explicit one", () => {
		// The transport omits OpenRouter catalog defaults so upstreams self-cap;
		// a fitted default would become an explicit, upstream-filtering cap.
		const openrouter = { ...deepseek, compat: { isOpenRouterHost: true, alwaysSendMaxTokens: false } } as never;
		expect(fitOutputTokensToContextWindow(openrouter, promptOf(800_000), undefined, tokenizer)).toBeUndefined();
		expect(fitOutputTokensToContextWindow(openrouter, promptOf(800_000), 200_000, tokenizer)).toBe(120_000);
		const alwaysSends = { ...deepseek, compat: { isOpenRouterHost: true, alwaysSendMaxTokens: true } } as never;
		expect(fitOutputTokensToContextWindow(alwaysSends, promptOf(800_000), undefined, tokenizer)).toBe(120_000);
	});

	test("sizes the prompt from the provider's last report plus only the unreported tail", () => {
		// Local counting of the reported prefix would read 900k and floor the cap
		// (the Opus 1024-token `length` loop); the provider measured it at 500k.
		const context: Context = { messages: [userOf(900_000, 1), reported(500_000, 2), userOf(200_000, 3)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, undefined, tokenizer)).toBe(
			1_000_000 - (500_000 + 220_000),
		);
	});

	test("ignores reports made before a history rewrite", () => {
		// Compaction committed at 10 replaced the 950k prefix the kept turn (5)
		// measured. A natively replayed summary predates its thinking marker
		// before that tail; the tail's usage is stale either way.
		for (const historyRewriteAt of [10, 4]) {
			const summary: Message = { role: "user", content: "summary", historyRewriteAt, timestamp: 10 };
			const stale: Context = { messages: [summary, reported(950_000, 5), userOf(1_000, 11)] };
			expect(fitOutputTokensToContextWindow(deepseek, stale, undefined, tokenizer)).toBeUndefined();
		}

		const summary: Message = { role: "user", content: "summary", historyRewriteAt: 4, timestamp: 10 };
		const fresh: Context = {
			messages: [summary, reported(950_000, 5), userOf(1_000, 11), reported(700_000, 12), userOf(1_000, 13)],
		};
		expect(fitOutputTokensToContextWindow(deepseek, fresh, undefined, tokenizer)).toBe(1_000_000 - (700_000 + 1_100));
	});

	test("leaves the cap alone on hosts that stop generation at the window", () => {
		// Claude 4.5+ on the Claude API ends at the window with
		// `model_context_window_exceeded` instead of a 400, so fitting only
		// takes output room away; older Claude still 400s and is fitted.
		const opus = getBundledModel("anthropic", "claude-opus-5-5");
		expect(fitOutputTokensToContextWindow(opus, promptOf(990_000), undefined, tokenizer)).toBeUndefined();
		// Same model on an unverified host keeps the fit.
		const bedrockOpus = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		expect(fitOutputTokensToContextWindow(bedrockOpus, promptOf(990_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
		const opus41 = getBundledModel("anthropic", "claude-opus-4-1");
		// 199k of Opus 4.1's 200k window leaves less than its 32k default cap.
		expect(fitOutputTokensToContextWindow(opus41, promptOf(199_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});

	test("never requests less than the floor, leaving a full window to compaction", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(990_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});
});
