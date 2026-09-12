import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
});

describe("ToolCallLoopGuard multi-call turns", () => {
	let nextId = 0;

	function toolCall(name: string, args: Record<string, unknown>): ToolCall {
		return { type: "toolCall", id: `tc_${nextId++}`, name, arguments: args };
	}

	function turn(calls: ToolCall[], toolResults: ToolResultMessage[] = []) {
		const message = {
			role: "assistant",
			content: calls,
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		return { message, toolResults };
	}

	function observed(path: string, text: string) {
		const call = toolCall("read", { path });
		return turn(
			[call],
			[
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "read",
					content: [{ type: "text", text }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		);
	}

	test("warns once for alternating unchanged resources without suppressing execution", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const detections = [];
		for (let n = 0; n < 12; n++) {
			const detection = guard.recordTurn(observed(n % 2 ? "b.ts:1-20" : "a.ts:1-20", "unchanged"));
			if (detection) detections.push(detection);
		}
		expect(detections).toMatchObject([{ toolName: "read", count: 3 }]);
		expect(guard.recordTurn(observed("a.ts:21-40", "new selection"))).toBeNull();
		expect(guard.recordTurn(observed("a.ts:1-20", "fresh contents"))).toBeNull();
	});

	test("fresh outcomes prevent a false repetition warning", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		for (let n = 0; n < 8; n++) {
			expect(guard.recordTurn(observed("progress.log:1-20", `progress ${n}`))).toBeNull();
		}
	});

	test("productive intervening outcomes prevent stale resource visits accumulating into a loop", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		for (let n = 0; n < 8; n++) {
			expect(guard.recordTurn(observed("config.ts:1-20", "unchanged"))).toBeNull();
			expect(guard.recordTurn(observed("progress.log:1-20", `completed phase ${n}`))).toBeNull();
		}
	});

	test("a new episode must rebuild repetition after an intervening operation", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toBeNull();
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toBeNull();
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toMatchObject({ count: 3 });
		expect(guard.recordTurn(observed("y.ts:1-20", "new evidence"))).toBeNull();
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toBeNull();
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toBeNull();
		expect(guard.recordTurn(observed("x.ts:1-20", "unchanged"))).toMatchObject({ count: 3 });
	});

	test("counts consecutive identical multi-call batches toward the threshold", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toMatchObject({ toolName: "bash", count: 3 });
	});

	test("resets on a turn with no tool calls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(guard.recordTurn(turn([]))).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
	});

	test("resets when every call in a multi-call turn is exempt", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		const batch = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		expect(guard.recordTurn(turn(batch()))).toBeNull();
		expect(
			guard.recordTurn(turn([toolCall("read", { path: "x.ts" }), toolCall("read", { path: "y.ts" })])),
		).toBeNull();
		expect(guard.recordTurn(turn(batch()))).toBeNull();
	});

	test("counts a mixed batch and reports the first non-exempt call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["read"] });
		const mixed = () => [toolCall("read", { path: "a.ts" }), toolCall("bash", { command: "echo a" })];
		expect(guard.recordTurn(turn(mixed()))).toBeNull();

		const repeated = mixed();
		expect(
			guard.recordTurn(
				turn(repeated, [
					{
						role: "toolResult",
						toolCallId: repeated[0]!.id,
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: repeated[1]!.id,
						toolName: "bash",
						content: [{ type: "text", text: "command output" }],
						isError: false,
						timestamp: Date.now(),
					},
				]),
			),
		).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 2,
			resultSummary: "command output",
			argumentsSummary: '{"command":"echo a"}',
		});
	});

	test("treats reordered parallel calls as the same batch", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn(turn([toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })])),
		).toBeNull();
		expect(
			guard.recordTurn(turn([toolCall("read", { path: "a.ts" }), toolCall("bash", { command: "echo a" })])),
		).toMatchObject({ count: 2 });
	});

	test("does not count alternating distinct batches", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const a = () => [toolCall("bash", { command: "echo a" }), toolCall("read", { path: "a.ts" })];
		const b = () => [toolCall("bash", { command: "echo b" })];
		expect(guard.recordTurn(turn(a()))).toBeNull();
		expect(guard.recordTurn(turn(b()))).toBeNull();
		expect(guard.recordTurn(turn(a()))).toBeNull();
		expect(guard.recordTurn(turn(b()))).toBeNull();
	});
});
