import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { fitOutputTokensToContextWindow, MIN_FITTED_OUTPUT_TOKENS } from "../src/output-budget";
import { Tokenizer } from "../src/tokenizer";

// Contract: prompt plus requested output never exceeds the model's context
// window, which Chat Completions-style providers enforce with a 400. Test-env
// token counts are bytes/4, so `tokens * 4` ASCII bytes is exactly `tokens`.
function promptOf(tokens: number): Context {
	return { messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 0 }] };
}

const deepseek = { contextWindow: 1_000_000, maxTokens: 384_000 };

describe("fitOutputTokensToContextWindow", () => {
	const tokenizer = new Tokenizer();

	test("leaves the cap alone while prompt plus requested output fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), undefined, tokenizer)).toBeUndefined();
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(100_000), 2_048, tokenizer)).toBe(2_048);
		expect(
			fitOutputTokensToContextWindow(
				{ contextWindow: 0, maxTokens: 384_000 },
				promptOf(900_000),
				undefined,
				tokenizer,
			),
		).toBeUndefined();
	});

	test("lowers the model default cap to the room the prompt leaves", () => {
		// The reported /btw request: 666,387 prompt tokens + 384,000 output > the window.
		const cap = fitOutputTokensToContextWindow(deepseek, promptOf(666_387), undefined, tokenizer);
		expect(cap).toBe(1_000_000 - (666_387 + Math.ceil(666_387 / 10)));
		expect(666_387 + (cap ?? 0)).toBeLessThanOrEqual(deepseek.contextWindow);
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
		expect(cap).toBeLessThanOrEqual(deepseek.contextWindow - 700_000);
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

	test("never requests less than the floor, leaving a full window to compaction", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(990_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});
});
