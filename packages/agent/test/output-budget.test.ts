import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	fitOutputTokensToContextWindow,
	MESSAGE_FRAMING_TOKENS,
	MIN_FITTED_OUTPUT_TOKENS,
	OUTPUT_FIT_HEADWAY_TOKENS,
} from "../src/output-budget";
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
		expect(cap).toBe(
			1_000_000 - (666_387 + Math.ceil(666_387 / 10) + MESSAGE_FRAMING_TOKENS) - OUTPUT_FIT_HEADWAY_TOKENS,
		);
		expect(666_387 + (cap ?? 0)).toBeLessThanOrEqual(1_000_000);
	});

	test("lowers an explicit caller cap that no longer fits", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(800_000), 200_000, tokenizer)).toBe(
			120_000 - MESSAGE_FRAMING_TOKENS - OUTPUT_FIT_HEADWAY_TOKENS,
		);
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
		expect(fitOutputTokensToContextWindow(openrouter, promptOf(800_000), 200_000, tokenizer)).toBe(
			120_000 - MESSAGE_FRAMING_TOKENS - OUTPUT_FIT_HEADWAY_TOKENS,
		);
		const alwaysSends = { ...deepseek, compat: { isOpenRouterHost: true, alwaysSendMaxTokens: true } } as never;
		expect(fitOutputTokensToContextWindow(alwaysSends, promptOf(800_000), undefined, tokenizer)).toBe(
			120_000 - MESSAGE_FRAMING_TOKENS - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("sizes the prompt from the provider's last report plus only the unreported tail", () => {
		// Local counting of the reported prefix would read 900k and floor the cap
		// (the Opus 1024-token `length` loop); the provider measured it at 500k.
		const context: Context = { messages: [userOf(900_000, 1), reported(500_000, 2), userOf(200_000, 3)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, undefined, tokenizer)).toBe(
			1_000_000 - (500_000 + 220_000 + MESSAGE_FRAMING_TOKENS) - OUTPUT_FIT_HEADWAY_TOKENS,
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
		expect(fitOutputTokensToContextWindow(deepseek, fresh, undefined, tokenizer)).toBe(
			1_000_000 - (700_000 + 1_100 + MESSAGE_FRAMING_TOKENS) - OUTPUT_FIT_HEADWAY_TOKENS,
		);
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
		// Anthropic no longer serves Opus 4.1, so the catalog omits it; keep the
		// pre-4.5 contrast with a first-party spec. 199k of its 200k window leaves
		// less than its 32k default cap.
		const opus41 = buildModel({
			id: "claude-opus-4-1-20250805",
			name: "Claude Opus 4.1",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});
		expect(fitOutputTokensToContextWindow(opus41, promptOf(199_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});

	test.each([
		// Summarized display shows one line of the reasoning.
		["summarized", "Checked the call sites."],
		// Omitted display shows none of it.
		["omitted", ""],
	] as const)("charges a kept Claude turn's %s reasoning at the size it billed as output", (_display, thinking) => {
		// Compaction at 10 kept a turn from 5, so its usage report is stale and the
		// whole context is counted locally. The turn billed 12,000 reasoning tokens
		// as output and the replay bills all of them, whatever the display showed:
		// counting the visible text, or the signature's 2,000 byte-tokens, leaves
		// the 32k cap in place and overflows the window.
		const model: Model = {
			...getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5"),
			contextWindow: 40_000,
		};
		const signature = "s".repeat(8_000);
		const kept: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature: signature },
				{ type: "text", text: "Done." },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 12_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 5,
		};
		const summary: Message = { role: "user", content: "summary", historyRewriteAt: 10, timestamp: 10 };
		const messages = transformMessages([summary, kept, userOf(4_000, 11)], model);
		// The provider still receives the signed reasoning it rebuilds and bills.
		expect(messages[1]).toMatchObject({
			content: [{ type: "thinking", thinkingSignature: signature }, { type: "text" }],
		});
		// The summary, the kept turn at its output size, and the tail.
		const prompt = 2 + 12_000 + 4_000;
		expect(fitOutputTokensToContextWindow(model, { messages }, 32_000, new Tokenizer(model))).toBe(
			40_000 - (prompt + Math.ceil(prompt / 10) + 3 * MESSAGE_FRAMING_TOKENS) - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("never requests less than the floor, leaving a full window to compaction", () => {
		expect(fitOutputTokensToContextWindow(deepseek, promptOf(990_000), undefined, tokenizer)).toBe(
			MIN_FITTED_OUTPUT_TOKENS,
		);
	});

	test("keeps anchored small tails inside the window via the absolute headway", () => {
		// The anchor is exact at 990,000 and the 1,000-token unreported tail gets only a
		// 100-token proportional margin. A host that counts ~64 tokens more (template
		// framing the local count cannot see) would 400 on the old cap of 8,900. This
		// is the path the measured +11..+42 token overshoots came from.
		const context: Context = { messages: [reported(990_000, 1), userOf(1_000, 2)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, 384_000, tokenizer)).toBe(
			1_000_000 - 991_100 - MESSAGE_FRAMING_TOKENS - OUTPUT_FIT_HEADWAY_TOKENS,
		);
	});

	test("charges template framing for every message in a long unreported tail", () => {
		// A turn's 40 parallel tool results, 10 tokens each, after an exact 132k anchor
		// on a 262,144 window (#15699). Content plus its 10% margin is 440 tokens, but a
		// Qwen3 host also renders ~5 framing tokens per result; with only the flat
		// headway the cap overflowed the window by 96 tokens.
		const results: Message[] = Array.from({ length: 40 }, (_, i) => userOf(10, 2 + i));
		const context: Context = { messages: [reported(132_000, 1), ...results] };
		const hostPrompt = 132_000 + 40 * (10 + 5);
		const cap = fitOutputTokensToContextWindow(
			{ ...deepseek, contextWindow: 262_144 },
			context,
			undefined,
			tokenizer,
		);
		expect(hostPrompt + (cap ?? 0)).toBeLessThanOrEqual(262_144);
	});

	test("clamps when room lands between requested and requested + headway", () => {
		// room = 200,050 >= requested 200,000, so the old code returned the full cap —
		// but room - headway = 199,986 < 200,000, and a host counting the headway's
		// worth of framing would 400. The headway applies on this branch too.
		const context: Context = { messages: [reported(799_950, 1)] };
		expect(fitOutputTokensToContextWindow(deepseek, context, 200_000, tokenizer)).toBe(199_986);
	});
});
