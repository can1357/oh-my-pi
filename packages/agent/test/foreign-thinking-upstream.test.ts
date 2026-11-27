import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Tokenizer } from "../src/tokenizer";

const THINKING = "FOREIGN_THINKING: inspect config before editing the parser. ".repeat(300);
const answer = { type: "text", text: "I will inspect config first." } as const;
const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } } as const;

function reader(api: Model["api"], provider: string, id: string, compat?: ModelSpec["compat"]): Model {
	return buildModel({
		api,
		provider,
		id,
		name: id,
		baseUrl: "https://llm.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...(compat && { compat }),
	});
}

function turn(api: AssistantMessage["api"], provider: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider,
		model,
		content: [{ type: "thinking", thinking: THINKING, thinkingSignature: "reasoning_content" }, answer, toolCall],
		usage: {
			input: 0,
			output: 3_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function answerAndToolCount(tokenizer: Tokenizer, source: AssistantMessage): number {
	return tokenizer.countMessage({ ...source, content: [answer, toolCall] });
}

describe("foreign thinking context estimate", () => {
	test("does not count another model's thinking for Claude", () => {
		const target = reader("anthropic-messages", "anthropic", "claude-opus-4-8");
		const foreign = turn("openai-completions", "vertex", "google/gemini-3.1-pro-preview");
		const tokenizer = new Tokenizer(target);

		expect(tokenizer.countMessage(foreign)).toBe(answerAndToolCount(tokenizer, foreign));
	});

	test("does not count another wire on the same provider", () => {
		const target = reader("anthropic-messages", "model-gateway", "claude-opus-5-5", {
			replayUnsignedThinking: false,
		});
		const foreign = turn("openai-completions", "model-gateway", "google/gemini-3.1-pro-preview");
		const tokenizer = new Tokenizer(target);

		expect(tokenizer.countMessage(foreign)).toBe(answerAndToolCount(tokenizer, foreign));
	});

	test("does not count another Claude model's signed thinking at a signing endpoint", () => {
		// Cloudflare AI Gateway's Anthropic route is a signing endpoint; the other Claude model's block drops.
		const target = buildModel({
			api: "anthropic-messages",
			provider: "cloudflare-ai-gateway",
			id: "cf-anthropic/claude-opus-4-8",
			name: "Claude Opus 4.8 via Cloudflare AI Gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gate/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const foreign = turn("anthropic-messages", "cloudflare-ai-gateway", "cf-anthropic/claude-sonnet-4-6");
		const tokenizer = new Tokenizer(target);

		expect(tokenizer.countMessage(foreign)).toBe(answerAndToolCount(tokenizer, foreign));
	});

	test("does not count another model's thinking for a router that may pick Claude", () => {
		const target = reader("devin-agent", "devin", "adaptive", { modelRouter: true });
		const foreign = turn("openai-completions", "vertex", "google/gemini-3.1-pro-preview");
		const own = turn("devin-agent", "devin", "adaptive");
		const tokenizer = new Tokenizer(target);
		const withoutThinking = answerAndToolCount(tokenizer, foreign);

		expect(tokenizer.countMessage(foreign)).toBe(withoutThinking);
		expect(tokenizer.countMessage(own)).toBeGreaterThan(withoutThinking + 1000);
	});

	test("judges each part of a server-side fallback turn by the model that wrote it", () => {
		// The response named the requested Fable for the whole turn; Opus wrote everything after the boundary.
		const declined = { type: "thinking", thinking: THINKING, thinkingSignature: "sig-primary" } as const;
		const handoff = {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
		} as const;
		const served = { type: "thinking", thinking: THINKING, thinkingSignature: "sig-fallback" } as const;
		const fallbackTurn: AssistantMessage = {
			...turn("anthropic-messages", "anthropic", "claude-fable-5"),
			content: [declined, handoff, served, answer, toolCall],
		};
		const fable = new Tokenizer(reader("anthropic-messages", "anthropic", "claude-fable-5"));
		const opus = new Tokenizer(reader("anthropic-messages", "anthropic", "claude-opus-4-8"));

		// Each model gets only its own reasoning: Fable's before the boundary, Opus's after it.
		for (const [tokenizer, ownOnly] of [
			[fable, [declined, handoff, answer, toolCall]],
			[opus, [handoff, served, answer, toolCall]],
		] as const) {
			const count = tokenizer.countMessage(fallbackTurn);
			expect(count).toBeGreaterThan(answerAndToolCount(tokenizer, fallbackTurn) + 1000);
			expect(count).toBe(tokenizer.countMessage({ ...fallbackTurn, content: [...ownOnly] }));
		}
	});

	test("does not count foreign thinking for Factory Droid's Claude inner route", () => {
		const target = reader("factory-droid-agent", "factory-droid", "claude-sonnet-4-5-20250929");
		const foreign = turn("openai-completions", "vertex", "google/gemini-3.1-pro-preview");
		const tokenizer = new Tokenizer(target);

		expect(tokenizer.countMessage(foreign)).toBe(answerAndToolCount(tokenizer, foreign));
	});

	test("does not count foreign thinking for GitLab Duo's Claude inner route", () => {
		const target = reader("gitlab-duo-agent", "gitlab-duo", "duo-chat-sonnet-4-5");
		const foreign = turn("openai-completions", "vertex", "google/gemini-3.1-pro-preview");
		const tokenizer = new Tokenizer(target);

		expect(tokenizer.countMessage(foreign)).toBe(answerAndToolCount(tokenizer, foreign));
	});

	test("does not reuse a tokenizer across a model-router policy change", () => {
		const fixed = reader("devin-agent", "devin", "adaptive", { modelRouter: false });
		const router = reader("devin-agent", "devin", "adaptive", { modelRouter: true });

		expect(new Tokenizer(fixed).countsAlike(router)).toBe(false);
	});
});
