import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression test for: "messages.X.content.Y: `thinking` or `redacted_thinking` blocks in
 * the latest assistant message cannot be modified."
 *
 * Reproduces the shape captured in `~/.omp/logs/http-400-requests/*.json` after Claude
 * returns `stop_reason: "max_tokens"` mid-thinking. The provider records an assistant
 * message containing only a signed `thinking` block (no `text`, no `tool_use`). When the
 * next assistant turn lands without a real user message between them (the user typed an
 * empty submission to nudge the agent, which `convertContentBlocks` drops), two
 * consecutive assistant messages must never reach Anthropic, each with its own signed
 * thinking block. Anthropic rejects that with the 400 above.
 *
 * A `length` turn whose reasoning replays survives so the next response continues it; the
 * encoder keeps `user` / `assistant` alternation. `error` / `aborted` thinking-only turns
 * are dropped.
 */
describe("transformMessages and thinking-only assistant turns", () => {
	const model: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		baseUrl: "https://api.anthropic.com",
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});

	const makeThinkingOnlyAssistant = (
		thinking: string,
		signature: string,
		stopReason: AssistantMessage["stopReason"],
	): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "thinking", thinking, thinkingSignature: signature }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	});

	const makeFullAssistant = (text: string, toolCallId: string): AssistantMessage => ({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "fresh reasoning", thinkingSignature: "sig_fresh" },
			{ type: "text", text },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "x" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
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
	});

	it("keeps a length-truncated signed thinking-only turn without adjacent assistants on the wire", () => {
		const user: UserMessage = { role: "user", content: "follow-up question", timestamp: 1 };
		const truncated = makeThinkingOnlyAssistant("partial reasoning", "sig_truncated", "length");
		// Empty user submission (e.g., user pressed Enter to retry). `convertContentBlocks`
		// already collapses this to "" and skips the message, so it cannot separate the
		// two assistant turns at the wire level.
		const emptyUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "" }],
			timestamp: 2,
		};
		const fresh = makeFullAssistant("here is the answer", "toolu_fresh");

		const messages: Message[] = [user, truncated, emptyUser, fresh];

		const transformed = transformMessages(messages, model);

		// The interrupted reasoning survives with its signature, ahead of the fresh turn.
		const signatures = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content.flatMap(b => (b.type === "thinking" ? [b.thinkingSignature] : [])));
		expect(signatures).toEqual(["sig_truncated", "sig_fresh"]);

		// End-to-end: the wire-level Anthropic params must NOT have two adjacent
		// `assistant` entries, which is the exact failure mode in the 400 dump.
		const params = convertAnthropicMessages(messages, model, false);
		for (let i = 1; i < params.length; i++) {
			expect(
				params[i].role === "assistant" && params[i - 1].role === "assistant",
				`adjacent assistant turns at index ${i - 1}/${i} would reproduce the 400`,
			).toBe(false);
		}

		// Each signed thinking block reaches the wire in its own assistant turn, unmodified.
		const wireThinkingSignatures = params
			.filter(p => p.role === "assistant")
			.map(p =>
				(Array.isArray(p.content) ? p.content : []).flatMap(block =>
					block.type === "thinking" ? [block.signature] : [],
				),
			);
		expect(wireThinkingSignatures).toEqual([["sig_truncated"], ["sig_fresh"]]);
	});

	it("demotes a length-truncated thinking-only turn whose signature the cap cut off", () => {
		// An unterminated thinking block carries no verifiable signature. Unsigned thinking
		// 400s on Anthropic, so the interrupted thought replays as demoted text instead.
		const user: UserMessage = { role: "user", content: "follow-up question", timestamp: 1 };
		const truncated = makeThinkingOnlyAssistant("partial reasoning", "", "length");

		const params = convertAnthropicMessages([user, truncated], model, false);
		const blocks = params
			.filter(p => p.role === "assistant")
			.flatMap(p => (Array.isArray(p.content) ? p.content : []));
		expect(blocks.some(b => b.type === "thinking")).toBe(false);
		expect(blocks.some(b => b.type === "text" && b.text.includes("partial reasoning"))).toBe(true);
	});

	it("drops error-stop thinking-only assistant turn without injecting any synthetic note", () => {
		const user: UserMessage = { role: "user", content: "do a thing", timestamp: 1 };
		const errored = makeThinkingOnlyAssistant("partial reasoning", "sig_errored", "error");
		const nextUser: UserMessage = { role: "user", content: "try again", timestamp: 3 };

		const messages: Message[] = [user, errored, nextUser];
		const transformed = transformMessages(messages, model);

		// Errored thinking-only assistant dropped.
		const erroredSurvivors = transformed.filter(
			m =>
				m.role === "assistant" &&
				(m as AssistantMessage).content.some(b => b.type === "thinking" && b.thinkingSignature === "sig_errored"),
		);
		expect(erroredSurvivors.length).toBe(0);

		// No synthetic developer note is injected for a dropped aborted/errored turn —
		// the abort lifecycle is conveyed by aborted tool results (when there are tool
		// calls), not by a separate marker message.
		expect(transformed.filter(m => m.role === "developer").length).toBe(0);
	});

	it("keeps assistant turns that have a `text` block even when stopped at length", () => {
		// A length-truncation mid-`text` is a recoverable continuation: the partial
		// answer carries real content, and providers can either continue or surface it
		// to the user. We must NOT drop those.
		const user: UserMessage = { role: "user", content: "answer me", timestamp: 1 };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thought", thinkingSignature: "sig_keep" },
				{ type: "text", text: "partial answer cut off mid-" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: 2,
		};
		const transformed = transformMessages([user, partial], model);
		const kept = transformed.find(
			m =>
				m.role === "assistant" &&
				(m as AssistantMessage).content.some(b => b.type === "thinking" && b.thinkingSignature === "sig_keep"),
		);
		expect(kept).toBeDefined();
	});
});
