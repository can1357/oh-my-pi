import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	buildStepDigest,
	normalizeStepSummary,
	STEP_SUMMARY_CUSTOM_TYPE,
	stepSummariesFromEntries,
} from "@oh-my-pi/pi-coding-agent/step-summary/step-summarizer";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

function result(toolCallId: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

describe("buildStepDigest", () => {
	it("skips steps without tool calls: their reply already says what happened", () => {
		expect(buildStepDigest({ message: assistant([{ type: "text", text: "All done." }]), toolResults: [] })).toBe(
			undefined,
		);
	});

	it("pairs each call with its result, flags failures, and stays bounded for huge output", () => {
		const digest = buildStepDigest({
			request: "fix the build",
			message: assistant([
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "bun check" } },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "big.log" } },
				{ type: "toolCall", id: "c", name: "bash", arguments: { command: "sleep 1" } },
			]),
			toolResults: [result("b", "x".repeat(100_000)), result("a", "error TS2339", true)],
		});
		expect(digest).toContain("Request: fix the build");
		expect(digest).toContain("Result 1 (error): error TS2339");
		expect(digest).toContain("Result 3: (none)");
		expect(digest?.length).toBeLessThanOrEqual(6000);
	});
});

describe("normalizeStepSummary", () => {
	it("reduces a chatty reply to one plain caption line", () => {
		expect(normalizeStepSummary('\n- **Summary:** "Fixed the `add` operator in calc.py."\nMore detail')).toBe(
			"Fixed the add operator in calc.py",
		);
		expect(normalizeStepSummary("Raised max_tokens in the `_retry` helper.")).toBe(
			"Raised max_tokens in the _retry helper",
		);
		expect(normalizeStepSummary("  \n ** \n")).toBe(undefined);
		expect(normalizeStepSummary("word ".repeat(60))?.length).toBe(120);
	});
});

describe("stepSummariesFromEntries", () => {
	it("restores captions by message timestamp and ignores malformed or foreign entries", () => {
		const summaries = stepSummariesFromEntries([
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: 10, summary: "Ran the tests" },
			},
			{
				type: "custom",
				customType: STEP_SUMMARY_CUSTOM_TYPE,
				data: { messageTimestamp: "11", summary: "bad stamp" },
			},
			{ type: "custom", customType: STEP_SUMMARY_CUSTOM_TYPE, data: { messageTimestamp: 12, summary: "" } },
			{ type: "custom", customType: STEP_SUMMARY_CUSTOM_TYPE, data: null },
			{ type: "custom", customType: "other", data: { messageTimestamp: 13, summary: "not ours" } },
			{ type: "message", data: { messageTimestamp: 14, summary: "not custom" } },
		]);
		expect([...summaries]).toEqual([[10, "Ran the tests"]]);
	});
});
