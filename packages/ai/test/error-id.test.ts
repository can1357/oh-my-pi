import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("error-id classification", () => {
	it("composes timeout with transient", () => {
		const id = AIError.classify(new Error("provider stream stall timeout"), "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
	});

	it("keeps raw status fallback unclassified", () => {
		const id = 503;
		expect(AIError.is(id, AIError.Flag.Class)).toBe(false);
		expect(id).toBe(503);
	});

	it("gates stale Responses replay errors by API", () => {
		const text = "Item with id 'resp_123' not found";
		const anthropicId = AIError.classify(new Error(text), "anthropic-messages");
		const responsesId = AIError.classify(new Error(text), "openai-responses");
		expect(AIError.is(anthropicId, AIError.Flag.StaleResponsesItem)).toBe(false);
		expect(AIError.is(responsesId, AIError.Flag.StaleResponsesItem)).toBe(true);
	});

	it("walks causes and preserves carried ids", () => {
		const inner = AIError.attach(new Error("inner"), AIError.create(AIError.Flag.ThinkingLoop));
		const outer = new Error("outer", { cause: inner });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
	});

	it("combines wrapper text classification with cause ids", () => {
		const cause = AIError.attach(new Error("quota reached"), AIError.create(AIError.Flag.UsageLimit));
		const outer = new Error("network stream stall", { cause });
		const id = AIError.classify(outer, "anthropic-messages");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("upgrades a stamped status fallback after final error text exists", () => {
		const assistant = message({
			errorId: 503,
			errorStatus: 503,
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Class)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});

	it("merges existing cause-chain kinds with finalized error text kinds", () => {
		const assistant = message({
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			errorMessage: "usage limit reached",
		});
		const id = AIError.classifyMessage(assistant);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
		expect(assistant.errorId).toBe(id);
	});
});
