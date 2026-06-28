import { describe, expect, it } from "bun:test";
import { getDialectDefinition, renderDemotedThinking } from "@pk-nerdsaver-ai/pi-ai/dialect";
import { transformMessages } from "@pk-nerdsaver-ai/pi-ai/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";

/**
 * Cross-provider model switches (e.g. Anthropic → Gemini mid-session) cannot
 * replay a prior turn's `thinking` block natively: the target's reasoning slot
 * either rejects a foreign signature or — verified end-to-end against Gemini 3 —
 * silently discards unsigned thought content (a replayed `thought:true` part is
 * neither recalled nor influences generation). `transformMessages` therefore
 * demotes the reasoning to a `text` block so it survives as conversation
 * context, wrapping it in the TARGET model's own canonical thinking-block
 * dialect (e.g. a ```thinking fence for Gemini) so it reads as reasoning in
 * that model's idiom instead of bare prose the model might mimic.
 *
 * Same-model continuations keep the native `thinking` block untouched.
 */
const REASONING = "The user wants the Paris weather; I will call get_weather with city=Paris.";

function makeModel<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<T>);
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

/** A prior assistant turn authored by an Anthropic model: signed thinking + a text reply. */
function anthropicThinkingTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: REASONING, thinkingSignature: "anthropic-sig" },
			{ type: "text", text: "Checking the forecast." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function transformedAssistant(messages: Message[], target: Model<Api>): AssistantMessage {
	const out = transformMessages(messages, target);
	const assistant = out.find((m): m is AssistantMessage => m.role === "assistant");
	if (!assistant) throw new Error("expected an assistant message in the transformed output");
	return assistant;
}

describe("transformMessages cross-provider thinking demotion → canonical dialect", () => {
	it("renders Anthropic reasoning as a Gemini ```thinking fence when switching to a Gemini target", () => {
		const gemini = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const assistant = transformedAssistant([user("weather in Paris?"), anthropicThinkingTurn()], gemini);

		// No native thinking block survives the cross-provider hop.
		expect(assistant.content.some(b => b.type === "thinking")).toBe(false);

		// The reasoning is demoted in place to a text block wrapped in Gemini's
		// canonical thinking dialect, ahead of the original reply text.
		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		// Demoted reasoning is wrapped in Gemini's canonical thinking fence and
		// carries a trailing newline so it never glues to the reply text.
		expect(first && first.type === "text" ? first.text : "").toBe(
			`${getDialectDefinition("gemini").renderThinking(REASONING)}\n`,
		);
		expect(first && first.type === "text" ? first.text : "").toContain("```thinking");
		// The original reply text survives as its own block, after the fence.
		const reply = assistant.content[1];
		expect(reply?.type).toBe("text");
		expect(reply && reply.type === "text" ? reply.text : "").toBe("Checking the forecast.");
	});

	it("falls back to a neutral <think> block (no chat-template control tokens) for control-token dialects", () => {
		// A GPT (openai-responses) target resolves to the harmony dialect, whose
		// renderThinking emits `<|channel|>` control tokens. Those MUST NOT leak
		// into structured history — demotion falls back to a neutral `<think>`
		// block instead, while still preserving the reasoning.
		const gpt = makeModel("openai-responses", "openai", "gpt-5");
		const assistant = transformedAssistant([user("weather in Paris?"), anthropicThinkingTurn()], gpt);

		const first = assistant.content[0];
		expect(first?.type).toBe("text");
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toBe(renderDemotedThinking("gpt-5", REASONING));
		// No harmony chat-template control tokens leaked, and the unsafe native
		// renderThinking output was explicitly NOT used.
		expect(text).not.toContain("<|");
		expect(text).not.toBe(`${getDialectDefinition("harmony").renderThinking(REASONING)}\n`);
		// Reasoning is still preserved inside the neutral block.
		expect(text).toContain("<think>");
		expect(text).toContain(REASONING);
	});

	it("keeps the native thinking block for a same-provider/same-model continuation", () => {
		const gemini = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const sameModelTurn: AssistantMessage = {
			...anthropicThinkingTurn(),
			content: [{ type: "thinking", thinking: REASONING, thinkingSignature: "g-sig" }],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-3-pro-preview",
		};
		const assistant = transformedAssistant([user("weather in Paris?"), sameModelTurn], gemini);

		const first = assistant.content[0];
		expect(first?.type).toBe("thinking");
		expect(first && first.type === "thinking" ? first.thinking : "").toBe(REASONING);
	});
});
