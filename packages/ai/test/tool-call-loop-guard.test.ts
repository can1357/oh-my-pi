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

function textTurn(
	id: string,
	name: string,
	args: Record<string, unknown>,
	text: string,
): { message: AssistantMessage; toolResults: ToolResultMessage[] } {
	return {
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id, name, arguments: args },
			],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
		toolResults: [],
	};
}

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

	test("detects incrementing echo suffixes when assistant text repeats", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
		const text = "Merging the next live revision.";
		for (let iteration = 1; iteration <= 152; iteration++) {
			const detection = guard.recordTurn(
				textTurn(`call-${iteration}`, "bash", { command: `echo merge-live-${iteration}` }, text),
			);
			if (iteration < 5) expect(detection).toBeNull();
			if (iteration === 5) expect(detection).toMatchObject({ toolName: "bash", count: 5 });
		}
	});

	test("does not flag reads of distinct file paths", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
		for (let iteration = 1; iteration <= 152; iteration++) {
			expect(
				guard.recordTurn(
					textTurn(
						`call-${iteration}`,
						"read",
						{ path: `src/file-${iteration}.ts` },
						"Reading the next source file.",
					),
				),
			).toBeNull();
		}
	});

	test("does not flag grep pagination through skip", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
		const text = "Checking the next page of matches.";
		for (let page = 0; page < 6; page++) {
			expect(
				guard.recordTurn(
					textTurn(`call-${page}`, "grep", { pattern: "todo", path: "src", skip: page * 100 }, text),
				),
			).toBeNull();
		}
	});

	test("does not flag a shell sweep over distinct test files", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
		const text = "Testing the next file.";
		for (let file = 1; file <= 6; file++) {
			expect(
				guard.recordTurn(textTurn(`call-${file}`, "bash", { command: `bun test test/case-${file}.test.ts` }, text)),
			).toBeNull();
		}
	});

	test("does not count normalized calls when assistant text changes", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
		for (let iteration = 1; iteration <= 152; iteration++) {
			expect(
				guard.recordTurn(
					textTurn(
						`call-${iteration}`,
						"bash",
						{ command: `echo merge-live-${iteration}` },
						`Running merge iteration ${iteration}.`,
					),
				),
			).toBeNull();
		}
	});

	test("resets value-drift counts after a turn without tool calls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		const text = "Continue checking the merge status.";
		const driftTurn = (iteration: number) =>
			textTurn(`call-${iteration}`, "bash", { command: `echo merge-live-${iteration}` }, text);
		expect(guard.recordTurn(driftTurn(1))).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				} satisfies AssistantMessage,
				toolResults: [],
			}),
		).toBeNull();
		expect(guard.recordTurn(driftTurn(2))).toBeNull();
		expect(guard.recordTurn(driftTurn(3))).toBeNull();
		expect(guard.recordTurn(driftTurn(4))).toMatchObject({ toolName: "bash", count: 3 });
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

	test("re-detects continued identical calls past the threshold (issue #12564)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		const turn = (id: string) => ({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "todo", arguments: {} }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
			toolResults: [],
		});
		expect(guard.recordTurn(turn("a"))).toBeNull();
		expect(guard.recordTurn(turn("b"))).toMatchObject({ toolName: "todo", count: 2 });
		expect(guard.recordTurn(turn("c"))).toMatchObject({ toolName: "todo", count: 3 });
		expect(guard.recordTurn(turn("d"))).toMatchObject({ toolName: "todo", count: 4 });
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

	/** An exempt `wait` turn; `useless` marks a wait that elapsed with nothing new. */
	function waitTurn(text: string, useless: boolean) {
		const call = toolCall("wait", {});
		return turn(
			[call],
			[
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "wait",
					content: [{ type: "text", text }],
					isError: false,
					...(useless ? { useless: true } : {}),
					timestamp: Date.now(),
				},
			],
		);
	}

	test("keeps counting across an idle exempt poll between identical turns", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["wait"] });
		const pytest = () => turn([toolCall("bash", { command: "pytest" })]);
		expect(guard.recordTurn(pytest())).toBeNull();
		// The wait elapsed with nothing new, so it does not hide the loop.
		expect(guard.recordTurn(waitTurn("Wait limit reached.", true))).toBeNull();
		expect(guard.recordTurn(pytest())).toMatchObject({ toolName: "bash", count: 2 });
	});

	test("resets after an exempt poll that returned something, even repeated text", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["wait"] });
		const pytest = () => turn([toolCall("bash", { command: "pytest" })]);
		expect(guard.recordTurn(pytest())).toBeNull();
		// A finished service may have changed what the rerun sees.
		expect(guard.recordTurn(waitTurn("A service finished.", false))).toBeNull();
		expect(guard.recordTurn(pytest())).toBeNull();
		expect(guard.recordTurn(waitTurn("A service finished.", false))).toBeNull();
		expect(guard.recordTurn(pytest())).toBeNull();
	});

	test("resets after an idle exempt poll that arrived with injected context", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["wait"] });
		const pytest = () => turn([toolCall("bash", { command: "pytest" })]);
		expect(guard.recordTurn(pytest())).toBeNull();
		// An extension attached context to the timed-out wait: the rerun may see something new.
		expect(guard.recordTurn({ ...waitTurn("Wait limit reached.", true), injectedContext: true })).toBeNull();
		expect(guard.recordTurn(pytest())).toBeNull();
	});

	test("resets after an exempt call that failed", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["grep"] });
		const pytest = () => turn([toolCall("bash", { command: "pytest" })]);
		const call = toolCall("grep", { pattern: "x" });
		const failedGrep = turn(
			[call],
			[
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "grep",
					content: [{ type: "text", text: "Invalid regex." }],
					isError: true,
					timestamp: Date.now(),
				},
			],
		);
		expect(guard.recordTurn(pytest())).toBeNull();
		// Only a result its tool flagged useless is an idle poll; a failure may follow real work.
		expect(guard.recordTurn(failedGrep)).toBeNull();
		expect(guard.recordTurn(pytest())).toBeNull();
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

	test("reports the non-exempt call in a batch containing an exempt alias", () => {
		const guard = new ToolCallLoopGuard({
			threshold: 2,
			exemptTools: ["poll"],
			exemptionAlias: call => call.arguments.target as string,
		});
		const calls = [toolCall("dispatch", { target: "poll" }), toolCall("dispatch", { target: "edit" })];
		expect(guard.recordTurn(turn(calls))).toBeNull();
		expect(guard.recordTurn(turn(calls))).toMatchObject({
			toolName: "dispatch",
			count: 2,
			argumentsSummary: '{"target":"edit"}',
		});
	});

	test.each([true, false])("preserves idle-poll counting for an alias with useless=%s", useless => {
		const guard = new ToolCallLoopGuard({
			threshold: 2,
			exemptTools: ["poll"],
			exemptionAlias: call => (call.name === "dispatch" ? "poll" : undefined),
		});
		const repeated = turn([toolCall("bash", { command: "pytest" })]);
		const poll = toolCall("dispatch", {});
		expect(guard.recordTurn(repeated)).toBeNull();
		expect(
			guard.recordTurn(
				turn(
					[poll],
					[
						{
							role: "toolResult",
							toolCallId: poll.id,
							toolName: poll.name,
							content: [{ type: "text", text: "Poll completed" }],
							isError: false,
							useless,
							timestamp: Date.now(),
						},
					],
				),
			),
		).toBeNull();
		const detection = guard.recordTurn(repeated);
		if (useless) expect(detection).toMatchObject({ toolName: "bash", count: 2 });
		else expect(detection).toBeNull();
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

describe("ToolCallLoopGuard unresolved tool calls (issue #10876)", () => {
	let nextId = 0;

	/** A turn of calls; `resolved: false` marks every call as naming no tool, answered `Tool <name> not found`. */
	function turn(calls: Array<{ name: string; args: Record<string, unknown> }>, resolved: boolean) {
		const toolCalls: ToolCall[] = calls.map(({ name, args }) => ({
			type: "toolCall",
			id: `tc_${nextId++}`,
			name,
			arguments: args,
		}));
		const message = {
			role: "assistant",
			content: toolCalls,
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const toolResults: ToolResultMessage[] = toolCalls.map(call => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: resolved ? "ok" : `Tool ${call.name} not found` }],
			isError: !resolved,
			timestamp: Date.now(),
		}));
		return { message, toolResults, unresolvedToolCallIds: resolved ? [] : toolCalls.map(call => call.id) };
	}

	test("trips on a streak of unresolved calls that vary in name and arguments", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(guard.recordTurn(turn([{ name: "wri", args: { path: "a.txt" } }], false))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "wri", args: { path: "b.txt" } }], false))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "ed", args: { path: "c.txt" } }], false))).toEqual({
			kind: "unresolved_tool_call",
			toolName: "ed",
			count: 3,
			resultSummary: "Tool ed not found",
			argumentsSummary: '{"path":"c.txt"}',
		});
		// Still stuck: keeps reporting past the threshold, like the identical-call bound.
		expect(guard.recordTurn(turn([{ name: "ba", args: {} }], false))).toMatchObject({
			kind: "unresolved_tool_call",
			count: 4,
		});
	});

	test("reports identical unresolved calls as unresolved, not as an argument repeat", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([{ name: "wri", args: {} }], false))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "wri", args: {} }], false))).toMatchObject({
			kind: "unresolved_tool_call",
			toolName: "wri",
			count: 2,
		});
	});

	test("a resolved call breaks the streak, so a typo then a recovery never trips", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([{ name: "wri", args: { path: "a.txt" } }], false))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "write", args: { path: "a.txt" } }], true))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "ed", args: { path: "a.txt" } }], false))).toBeNull();
		expect(guard.recordTurn(turn([{ name: "edit", args: { path: "a.txt" } }], true))).toBeNull();
	});

	test("a turn mixing an unresolved call with a resolved one breaks the streak", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(guard.recordTurn(turn([{ name: "wri", args: {} }], false))).toBeNull();
		const mixed = turn([{ name: "read", args: { path: "a.ts" } }], true);
		const miss = turn([{ name: "ed", args: {} }], false);
		expect(
			guard.recordTurn({
				message: { ...mixed.message, content: [...mixed.message.content, ...miss.message.content] },
				toolResults: [...mixed.toolResults, ...miss.toolResults],
				unresolvedToolCallIds: miss.unresolvedToolCallIds,
			}),
		).toBeNull();
		expect(guard.recordTurn(turn([{ name: "ba", args: {} }], false))).toBeNull();
	});

	test("varied resolved calls never trip", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		for (let index = 0; index < 6; index++) {
			expect(guard.recordTurn(turn([{ name: index % 2 ? "read" : "bash", args: { n: index } }], true))).toBeNull();
		}
	});
});

describe("ToolCallLoopGuard cyclic polling detection", () => {
	let nextId = 0;

	function makeTurn(
		calls: Array<{ name: string; args: Record<string, unknown> }>,
		opts?: { useless?: boolean; injectedContext?: boolean; unresolved?: boolean; resultText?: string },
	) {
		const toolCalls: ToolCall[] = calls.map(({ name, args }) => ({
			type: "toolCall",
			id: `cyc_${nextId++}`,
			name,
			arguments: args,
		}));
		const message = {
			role: "assistant",
			content: toolCalls,
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		const toolResults: ToolResultMessage[] = toolCalls.map(call => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: opts?.resultText ?? "ok" }],
			isError: Boolean(opts?.unresolved),
			...(opts?.useless ? { useless: true } : {}),
			timestamp: Date.now(),
		}));
		return {
			message,
			toolResults,
			...(opts?.injectedContext ? { injectedContext: true } : {}),
			...(opts?.unresolved ? { unresolvedToolCallIds: toolCalls.map(c => c.id) } : {}),
		};
	}

	test("detects a 2-turn alternating polling cycle at threshold and keeps reporting until broken", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, maxCycleLength: 3, exemptTools: ["wait"] });
		const pollSleep = () => makeTurn([{ name: "bash", args: { command: "sleep 30" } }]);
		const pollChecks = () =>
			makeTurn([{ name: "bash", args: { command: "gh pr checks" } }], { resultText: "pending" });

		// Cycles 1 and 2: below threshold
		expect(guard.recordTurn(pollSleep())).toBeNull();
		expect(guard.recordTurn(pollChecks())).toBeNull();
		expect(guard.recordTurn(pollSleep())).toBeNull();
		expect(guard.recordTurn(pollChecks())).toBeNull();
		expect(guard.recordTurn(pollSleep())).toBeNull();

		// Cycle 3 completes on pollChecks
		const hit = guard.recordTurn(pollChecks());
		expect(hit).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 3,
			cycleLength: 2,
			resultSummary: "pending",
		});
		expect(hit!.cycleSummary).toContain("sleep 30");
		expect(hit!.cycleSummary).toContain("gh pr checks");

		// Continuing the cycle keeps steering (count increments on full cycle completion)
		expect(guard.recordTurn(pollSleep())).toMatchObject({ cycleLength: 2, count: 3 });
		expect(guard.recordTurn(pollChecks())).toMatchObject({ cycleLength: 2, count: 4 });

		// Breaking the cycle clears detection
		expect(guard.recordTurn(makeTurn([{ name: "read", args: { path: "README.md" } }]))).toBeNull();
		expect(guard.recordTurn(pollSleep())).toBeNull();
	});

	test("detects a 3-turn repeating cycle", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, maxCycleLength: 3, exemptTools: [] });
		const a = () => makeTurn([{ name: "bash", args: { command: "step-a" } }]);
		const b = () => makeTurn([{ name: "bash", args: { command: "step-b" } }]);
		const c = () => makeTurn([{ name: "bash", args: { command: "step-c" } }]);
		expect(guard.recordTurn(a())).toBeNull();
		expect(guard.recordTurn(b())).toBeNull();
		expect(guard.recordTurn(c())).toBeNull();
		expect(guard.recordTurn(a())).toBeNull();
		expect(guard.recordTurn(b())).toBeNull();
		expect(guard.recordTurn(c())).toMatchObject({
			kind: "repeated_tool_call",
			count: 2,
			cycleLength: 3,
		});
	});

	test("preserves cycle counting across idle exempt polls, but resets on productive exempt polls", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, maxCycleLength: 3, exemptTools: ["wait"] });
		const a = () => makeTurn([{ name: "bash", args: { command: "check-a" } }]);
		const b = () => makeTurn([{ name: "bash", args: { command: "check-b" } }]);
		const idleWait = () => makeTurn([{ name: "wait", args: {} }], { useless: true });
		const activeWait = () => makeTurn([{ name: "wait", args: {} }], { useless: false });

		expect(guard.recordTurn(a())).toBeNull();
		expect(guard.recordTurn(idleWait())).toBeNull();
		expect(guard.recordTurn(b())).toBeNull();
		expect(guard.recordTurn(a())).toBeNull();
		expect(guard.recordTurn(idleWait())).toBeNull();
		expect(guard.recordTurn(b())).toMatchObject({ cycleLength: 2, count: 2 });

		// Productive exempt poll resets the cycle completely
		expect(guard.recordTurn(activeWait())).toBeNull();
		expect(guard.recordTurn(a())).toBeNull();
		expect(guard.recordTurn(b())).toBeNull();
	});

	test("reports primitive period only (never classifies period 1 as 2 or period 2 as 4)", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, maxCycleLength: 4, exemptTools: [] });
		const a = () => makeTurn([{ name: "bash", args: { command: "same" } }]);
		expect(guard.recordTurn(a())).toBeNull();
		const hit1 = guard.recordTurn(a());
		expect(hit1?.count).toBe(2);
		expect(hit1?.cycleLength).toBeUndefined();
		const hit2 = guard.recordTurn(a());
		expect(hit2?.count).toBe(3);
		expect(hit2?.cycleLength).toBeUndefined();

		const guard2 = new ToolCallLoopGuard({ threshold: 2, maxCycleLength: 4, exemptTools: [] });
		const x = () => makeTurn([{ name: "bash", args: { command: "x" } }]);
		const y = () => makeTurn([{ name: "bash", args: { command: "y" } }]);
		expect(guard2.recordTurn(x())).toBeNull();
		expect(guard2.recordTurn(y())).toBeNull();
		expect(guard2.recordTurn(x())).toBeNull();
		expect(guard2.recordTurn(y())).toMatchObject({ cycleLength: 2, count: 2 });
		// Even after 8 alternating turns (which looks like [x,y,x,y] x 2), period stays 2.
		for (let i = 0; i < 4; i++) {
			const res = guard2.recordTurn(i % 2 === 0 ? x() : y());
			expect(res?.cycleLength).toBe(2);
		}
	});

	test("clamps pathological maxCycleLength values safely", () => {
		for (const badMax of [Number.NaN, -3, 0, 10_000]) {
			const guard = new ToolCallLoopGuard({ threshold: 2, maxCycleLength: badMax, exemptTools: [] });
			const a = () => makeTurn([{ name: "bash", args: { command: "a" } }]);
			const b = () => makeTurn([{ name: "bash", args: { command: "b" } }]);
			expect(guard.recordTurn(a())).toBeNull();
			expect(guard.recordTurn(b())).toBeNull();
			expect(guard.recordTurn(a())).toBeNull();
			const res = guard.recordTurn(b());
			if (badMax === 10_000) {
				expect(res).toMatchObject({ cycleLength: 2, count: 2 });
			} else {
				expect(res).toBeNull();
			}
		}
	});

	test("seeded property/fuzz pass: state-machine invariants across 300 randomized sequences", () => {
		let state = 0x9e3779b9;
		const nextInt = (max: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % max;
		};

		const started = performance.now();
		for (let trial = 0; trial < 300; trial++) {
			const threshold = 2 + nextInt(3); // 2..4
			const maxCycleLength = 1 + nextInt(4); // 1..4
			const guard = new ToolCallLoopGuard({ threshold, maxCycleLength, exemptTools: ["wait"] });
			const alphabet = ["a", "b", "c", "d"];
			const observed: string[] = [];

			const steps = 10 + nextInt(20);
			for (let s = 0; s < steps; s++) {
				const roll = nextInt(10);
				if (roll === 0) {
					// Idle exempt wait: skipped without resetting observed sequence
					expect(guard.recordTurn(makeTurn([{ name: "wait", args: {} }], { useless: true }))).toBeNull();
					continue;
				}
				if (roll === 1) {
					// Non-idle exempt wait: resets everything
					expect(guard.recordTurn(makeTurn([{ name: "wait", args: {} }], { useless: false }))).toBeNull();
					observed.length = 0;
					continue;
				}
				const sym = alphabet[nextInt(alphabet.length)]!;
				observed.push(sym);
				const det = guard.recordTurn(makeTurn([{ name: "bash", args: { command: sym } }]));

				// Independent oracle: check whether `observed` ends in a repeating cycle of period 1..maxCycleLength.
				let expectedPeriod: number | null = null;
				for (let p = 1; p <= maxCycleLength; p++) {
					const needed = p * threshold;
					if (observed.length < needed) continue;
					const tailStart = observed.length - p;
					let matches = true;
					for (let k = 0; k < needed; k++) {
						if (observed[observed.length - needed + k] !== observed[tailStart + (k % p)]) {
							matches = false;
							break;
						}
					}
					if (matches) {
						expectedPeriod = p;
						break;
					}
				}
				if (expectedPeriod !== null) {
					expect(det).not.toBeNull();
					expect(det!.cycleLength ?? 1).toBe(expectedPeriod);
				}

				if (det) {
					expect(det.kind).toBe("repeated_tool_call");
					expect(det.count).toBeGreaterThanOrEqual(threshold);
					const period = det.cycleLength ?? 1;
					expect(period).toBeGreaterThanOrEqual(1);
					expect(period).toBeLessThanOrEqual(maxCycleLength);
					const needed = period * threshold;
					expect(observed.length).toBeGreaterThanOrEqual(needed);
					// Verify the last `period * threshold` observed symbols truly repeat the last `period` symbols
					const tailStart = observed.length - period;
					for (let k = 0; k < needed; k++) {
						expect(observed[observed.length - needed + k]).toBe(observed[tailStart + (k % period)]);
					}
					// Verify primitivity for period > 1
					if (period > 1) {
						const tail = observed.slice(tailStart);
						let hasSmallerPeriod = false;
						for (let q = 1; q * 2 <= period; q++) {
							if (period % q !== 0) continue;
							if (tail.every((v, idx) => v === tail[idx % q])) hasSmallerPeriod = true;
						}
						expect(hasSmallerPeriod).toBe(false);
					}
				}
			}
		}
		expect(performance.now() - started).toBeLessThan(2000);
	});
});
