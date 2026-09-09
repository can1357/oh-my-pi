// Regression for #3458: GLM-5.2 (and other models) occasionally emit a
// `toolCall` with an empty `name`. The agent loop rejects it at execution time
// (`Tool  not found`), but the malformed block + its error tool-result remain
// in `currentContext.messages` and every subsequent request replays them,
// 400'ing the session until the user runs `/clear`.
//
// `transformMessages` is the canonical sanitize boundary every provider passes
// through, so the defensive filter lives there.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: true,
});

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp: number, toolName = "read"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function getToolCalls(messages: Message[]): ToolCall[] {
	return messages.flatMap(msg =>
		msg.role === "assistant" ? msg.content.filter((block): block is ToolCall => block.type === "toolCall") : [],
	);
}

describe("transformMessages drops malformed (empty-name) tool calls", () => {
	it("removes the empty-name toolCall block, its matched toolResult, and keeps surviving content", () => {
		const messages: Message[] = [
			{ role: "user", content: "Help me out", timestamp: 1 },
			assistant(
				[
					{ type: "text", text: "Working on it." },
					{ type: "toolCall", id: "call_empty", name: "", arguments: {} },
				],
				2,
			),
			{
				role: "toolResult",
				toolCallId: "call_empty",
				toolName: "",
				content: [{ type: "text", text: "Tool  not found" }],
				isError: true,
				timestamp: 3,
			},
			{ role: "user", content: "continue", timestamp: 4 },
		];

		const transformed = transformMessages(messages, model);

		// Wire payload must NOT carry name="" — every provider rejects it.
		const empties = getToolCalls(transformed).filter(tc => !tc.name || tc.name.trim() === "");
		expect(empties).toHaveLength(0);

		// Orphan tool_result must be gone too (Anthropic 400s on
		// `tool_result without matching tool_use`).
		const orphan = transformed.find(m => m.role === "toolResult" && m.toolCallId === "call_empty");
		expect(orphan).toBeUndefined();

		// Surviving prose on the assistant turn must remain.
		const assistantOut = transformed.find((m): m is AssistantMessage => m.role === "assistant");
		expect(assistantOut?.content).toEqual([{ type: "text", text: "Working on it." }]);

		// Continuation user message must be preserved verbatim.
		const continuation = transformed.findLast(m => m.role === "user");
		expect(continuation).toMatchObject({ role: "user", content: "continue" });
	});

	it("treats an empty tool-call id as malformed and preserves surrounding replayable content", () => {
		const messages: Message[] = [
			{ role: "user", content: "Read both files", timestamp: 1 },
			assistant(
				[
					{ type: "text", text: "Reading the files." },
					{ type: "toolCall", id: "", name: "read", arguments: { path: "bad.ts" } },
					{ type: "toolCall", id: "call_keep", name: "read", arguments: { path: "good.ts" } },
				],
				2,
			),
			toolResult("", "empty-id result that Anthropic cannot match", 3),
			toolResult("call_keep", "good file contents", 4),
			{ role: "user", content: "continue", timestamp: 5 },
		];

		const transformed = transformMessages(messages, model);

		const survivingCalls = getToolCalls(transformed);
		expect(survivingCalls).toHaveLength(1);
		expect(survivingCalls[0]).toMatchObject({
			id: "call_keep",
			name: "read",
			arguments: { path: "good.ts" },
		});

		const assistantOut = transformed.find((m): m is AssistantMessage => m.role === "assistant");
		expect(assistantOut?.content).toEqual([
			{ type: "text", text: "Reading the files." },
			{ type: "toolCall", id: "call_keep", name: "read", arguments: { path: "good.ts" } },
		]);

		const toolResults = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: "call_keep", toolName: "read" });
		expect(toolResults[0]?.content).toEqual([{ type: "text", text: "good file contents" }]);
		expect(transformed.find(m => m.role === "toolResult" && m.toolCallId === "")).toBeUndefined();
		expect(transformed.findLast(m => m.role === "user")).toMatchObject({ role: "user", content: "continue" });
	});

	it("drops the whole assistant turn when only the malformed tool call was emitted", () => {
		const messages: Message[] = [
			{ role: "user", content: "Help me out", timestamp: 1 },
			assistant([{ type: "toolCall", id: "call_only_bad", name: "   ", arguments: {} }], 2),
			toolResult("call_only_bad", "Tool  not found", 3, ""),
			{ role: "user", content: "继续", timestamp: 4 },
		];

		const transformed = transformMessages(messages, model);

		expect(transformed.find(m => m.role === "assistant")).toBeUndefined();
		expect(transformed.find(m => m.role === "toolResult")).toBeUndefined();
		expect(transformed.map(m => m.role)).toEqual(["user", "user"]);
	});

	it("leaves valid tool calls (and unrelated tool results) untouched", () => {
		const messages: Message[] = [
			{ role: "user", content: "read file foo", timestamp: 1 },
			assistant(
				[
					{ type: "toolCall", id: "call_real", name: "read", arguments: { path: "foo" } },
					{ type: "toolCall", id: "call_empty", name: "", arguments: {} },
				],
				2,
			),
			toolResult("call_real", "file contents", 3),
			{
				role: "toolResult",
				toolCallId: "call_empty",
				toolName: "",
				content: [{ type: "text", text: "Tool  not found" }],
				isError: true,
				timestamp: 4,
			},
			{ role: "user", content: "thanks", timestamp: 5 },
		];

		const transformed = transformMessages(messages, model);

		const survivingCalls = getToolCalls(transformed);
		expect(survivingCalls).toHaveLength(1);
		expect(survivingCalls[0]).toMatchObject({ id: "call_real", name: "read" });

		const toolResults = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({ toolCallId: "call_real" });
	});

	it("is a no-op when no tool call has an empty name (identity returns same array reference)", () => {
		const messages: Message[] = [
			{ role: "user", content: "ping", timestamp: 1 },
			assistant([{ type: "toolCall", id: "call_ok", name: "read", arguments: { path: "a" } }], 2),
			toolResult("call_ok", "ok", 3),
		];

		const transformed = transformMessages(messages, model);

		expect(getToolCalls(transformed)).toHaveLength(1);
		expect(transformed.filter(m => m.role === "toolResult")).toHaveLength(1);
	});

	// Regression for PR #3459 review feedback: a tool-call id can legitimately
	// repeat across history when an OpenAI-Responses composite id
	// (`callId|itemId`) collapses on the wire — `deduplicateToolCallIds` exists
	// specifically to support that shape (see `transform-messages-dedup.test.ts`).
	// If one duplicate occurrence is malformed, only ITS tool result must be
	// dropped — the valid sibling's real result must reach the wire.
	it("only drops the toolResult tied to the malformed occurrence when the id repeats", () => {
		const sharedId = "toolu_dup";
		const messages: Message[] = [
			{ role: "user", content: "first read", timestamp: 1 },
			assistant([{ type: "toolCall", id: sharedId, name: "", arguments: {} }], 2),
			{
				role: "toolResult",
				toolCallId: sharedId,
				toolName: "",
				content: [{ type: "text", text: "Tool  not found" }],
				isError: true,
				timestamp: 3,
			},
			{ role: "user", content: "second read", timestamp: 4 },
			assistant([{ type: "toolCall", id: sharedId, name: "read", arguments: { path: "foo" } }], 5),
			toolResult(sharedId, "real file contents", 6),
			{ role: "user", content: "thanks", timestamp: 7 },
		];

		const transformed = transformMessages(messages, model);

		// The malformed call is gone; the valid call survives.
		const survivingCalls = getToolCalls(transformed);
		expect(survivingCalls).toHaveLength(1);
		expect(survivingCalls[0]).toMatchObject({ name: "read" });

		// The real "real file contents" result MUST reach the wire — only the
		// "Tool  not found" result tied to the malformed occurrence is dropped.
		const toolResults = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		// Assert by surviving content, not by id — `deduplicateToolCallIds`
		// renames repeats AFTER our sanitize, so the surviving result's id may
		// be the renamed form. What matters is the BYTES reach the wire.
		expect(toolResults[0]?.content).toEqual([{ type: "text", text: "real file contents" }]);
		expect(toolResults[0]?.toolName).toBe("read");
	});

	it("does not let a missing malformed-result consume a later valid call with the same id", () => {
		const sharedId = "toolu_reused";
		const messages: Message[] = [
			{ role: "user", content: "first read", timestamp: 1 },
			assistant([{ type: "toolCall", id: sharedId, name: "", arguments: {} }], 2),
			// No `Tool  not found` result arrived for the malformed call before the
			// conversation moved on. That stale malformed occurrence must not drop
			// the next valid call's real output when the id is reused.
			{ role: "user", content: "second read", timestamp: 3 },
			assistant([{ type: "toolCall", id: sharedId, name: "read", arguments: { path: "foo" } }], 4),
			toolResult(sharedId, "real file contents", 5),
		];

		const transformed = transformMessages(messages, model);

		const survivingCalls = getToolCalls(transformed);
		expect(survivingCalls).toHaveLength(1);
		expect(survivingCalls[0]).toMatchObject({ name: "read" });

		const toolResults = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.content).toEqual([{ type: "text", text: "real file contents" }]);
		expect(toolResults[0]?.toolName).toBe("read");
	});
});

describe("transformMessages drops assistant images from provider replay", () => {
	it("preserves replayable text while removing native image artifacts", () => {
		const messages: Message[] = [
			{ role: "user", content: "Draw a dot", timestamp: 1 },
			assistant(
				[
					{ type: "text", text: "Here it is." },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				2,
			),
		];

		const transformed = transformMessages(messages, model);

		expect(transformed[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Here it is." }],
		});
	});
});
