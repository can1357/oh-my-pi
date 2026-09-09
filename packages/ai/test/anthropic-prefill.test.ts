import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression: some Anthropic-routed models reject "assistant prefill" requests
 * (messages ending with an assistant turn). We should automatically append a
 * synthetic user message to keep the request valid.
 */
describe("Anthropic assistant-prefill fallback", () => {
	const model: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});

	it("appends a user Continue. message when the last turn is assistant", () => {
		const user: UserMessage = {
			role: "user",
			content: "Output JSON",
			timestamp: Date.now(),
		};
		const assistantPrefill: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "{" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistantPrefill], model, false);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("Continue.");
	});

	it("repairs consecutive assistant turns left by dropped empty user messages", () => {
		const assistant = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		// An empty nudge submission is dropped by the converter, which would leave
		// the two assistant turns adjacent — Anthropic 400s on that shape.
		const emptyNudge: UserMessage = { role: "user", content: [{ type: "text", text: "" }], timestamp: Date.now() };

		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "answer me", timestamp: Date.now() },
				assistant("partial answer"),
				emptyNudge,
				assistant("full answer"),
				{ role: "user", content: "thanks", timestamp: Date.now() },
			],
			model,
			false,
		);

		expect(params.map(p => p.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(params[2]?.content).toBe("Continue.");
	});

	it("does not append Continue. when the last turn is already user", () => {
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
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
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "what now?", timestamp: Date.now() },
			],
			model,
			false,
		);
		expect(params.at(-1)?.role).toBe("user");
		expect(params.at(-1)?.content).toBe("what now?");
	});
});

it("preserves redacted thinking blocks in assistant replay payloads", () => {
	const model: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});
	const user: UserMessage = {
		role: "user",
		content: "continue",
		timestamp: Date.now(),
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
			{ type: "redactedThinking", data: "encrypted_payload" },
			{ type: "text", text: "Final answer" },
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
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const params = convertAnthropicMessages([user, assistant], model, false);
	const assistantParam = params.find(m => m.role === "assistant");
	expect(assistantParam).toBeDefined();
	expect(Array.isArray(assistantParam?.content)).toBe(true);
	const blocks = assistantParam?.content as unknown as Array<Record<string, unknown>>;
	expect(blocks.map(block => block.type)).toEqual(["thinking", "redacted_thinking", "text"]);
	expect(blocks[0]?.signature).toBe("sig_1");
	expect(blocks[1]?.data).toBe("encrypted_payload");
});

it("preserves latest Anthropic thinking blocks even when model id changes", () => {
	const model: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});
	const switchedModel: Model<"anthropic-messages"> = buildModel({
		...model,
		id: "claude-opus-4-6-20251201",
		compat: model.compatConfig,
	} as ModelSpec<"anthropic-messages">);
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal", thinkingSignature: "sig_2" },
			{ type: "redactedThinking", data: "encrypted_payload_2" },
			{ type: "text", text: "Answer" },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6-20251201",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		switchedModel,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;
	expect(transformedAssistant).toBeDefined();
	expect(transformedAssistant?.content[0]).toEqual(assistant.content[0]);
	expect(transformedAssistant?.content[1]).toEqual(assistant.content[1]);
});

it("preserves a completed thinking signature on an aborted turn interrupted during later output", () => {
	// When a turn is aborted, only the block that was streaming at the abort point can carry a
	// partial (invalid) signature. A thinking block followed by another block already completed
	// — Anthropic emits its signature at content_block_stop before the next block starts — so its
	// signature is whole and must survive transform. Interrupting during the visible text output
	// after thinking finished is the common case; dropping the valid signature and replaying it
	// empty makes Anthropic reject the request with 400 "Invalid `signature` in `thinking` block".
	const model: Model<"anthropic-messages"> = buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		maxTokens: 8192,
		contextWindow: 200000,
		reasoning: true,
	});
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "completed reasoning", thinkingSignature: "sig_complete" },
			{ type: "text", text: "partial answer" },
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
		stopReason: "aborted",
		timestamp: Date.now(),
	};

	const transformed = transformMessages(
		[{ role: "user", content: "continue", timestamp: Date.now() }, assistant],
		model,
	);
	const transformedAssistant = transformed.find(m => m.role === "assistant") as AssistantMessage | undefined;

	expect(transformedAssistant).toBeDefined();
	const thinkingBlock = transformedAssistant?.content[0];
	expect(thinkingBlock).toMatchObject({ type: "thinking", thinking: "completed reasoning" });
	expect(thinkingBlock && "thinkingSignature" in thinkingBlock ? thinkingBlock.thinkingSignature : undefined).toBe(
		"sig_complete",
	);
});
