/**
 * Contract: `normalizeEvent` folds the native `AgentSessionEvent` stream into
 * the small step vocabulary the conveyor renders, without leaking event shapes
 * (or crashing on unknown ones) into the rendering modules.
 *
 * The lifeos counterpart also normalized a `prompt_result` frame and rendered a
 * child-process exit notice; neither exists natively — an uninvoked prompt is
 * the `false` return of `prompt()` and topic sessions have no child process —
 * so those two behaviours are dropped rather than ported.
 */
import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { normalizeEvent } from "@oh-my-pi/pi-coding-agent/telegram/events";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const event = (value: object) => normalizeEvent(value as unknown as AgentSessionEvent);

describe("normalizeEvent", () => {
	it("folds the start, delta, tool, final and end steps of a turn", () => {
		expect(event({ type: "agent_start" })).toEqual({ kind: "start" });
		expect(
			event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing" } }),
		).toEqual({
			kind: "thinking",
			text: "weighing",
		});
		expect(event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } })).toEqual({
			kind: "text",
			text: "done",
		});
		expect(event({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } })).toEqual(
			{ kind: "other" },
		);
		expect(event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } })).toEqual({
			kind: "other",
		});
		expect(event({ type: "message_update" })).toEqual({ kind: "other" });
		expect(
			event({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "bash",
				args: { command: "echo hi" },
				intent: "Echo it",
			}),
		).toEqual({ kind: "tool", callId: "call_1", toolName: "bash", args: { command: "echo hi" }, intent: "Echo it" });
		expect(
			event({
				type: "tool_execution_end",
				toolCallId: "call_2",
				toolName: "bash",
				isError: true,
				result: { isError: true },
			}),
		).toEqual({
			kind: "toolEnd",
			callId: "call_2",
			toolName: "bash",
			ok: false,
			plan: null,
		});
		expect(event({ type: "agent_end", isTerminal: true })).toEqual({ kind: "end", terminal: true });
		expect(event({ type: "agent_end", isTerminal: false })).toEqual({ kind: "end", terminal: false });
		expect(event({ type: "agent_end" })).toEqual({ kind: "end", terminal: true });
	});

	it("reads token/cost totals and answer text off a settled assistant message", () => {
		expect(
			event({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "ready" },
						{ type: "text", text: "!" },
					],
					usage: { totalTokens: 20242, cost: { total: 0.0026 } },
				},
			}),
		).toEqual({ kind: "final", text: "ready!", usage: { tokens: 20242, cost: 0.0026 } });
	});

	it("reports a terminal prompt typed outside Telegram as a user prompt", () => {
		expect(event({ type: "message_end", message: { role: "user", content: "ship it" } })).toEqual({
			kind: "userPrompt",
			text: "ship it",
		});
		expect(
			event({
				type: "message_end",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "with " },
						{ type: "image", data: "x" },
						{ type: "text", text: "images" },
					],
				},
			}),
		).toEqual({ kind: "userPrompt", text: "with images" });
		// A custom (Telegram) prompt is not a terminal prompt and never echoes.
		expect(
			event({ type: "message_end", message: { role: "custom", customType: "telegram-prompt", content: "hi" } }),
		).toEqual({
			kind: "other",
		});
		expect(event({ type: "message_end", message: { role: "toolResult", content: [] } })).toEqual({ kind: "other" });
	});

	it("carries todo phases only for the todo tool", () => {
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "First", status: "completed" }] }];
		expect(
			event({ type: "tool_execution_end", toolCallId: "t1", toolName: "todo", result: { details: { phases } } }),
		).toEqual({ kind: "toolEnd", callId: "t1", toolName: "todo", ok: true, plan: phases });
		expect(
			event({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { details: { phases } } }),
		).toEqual({ kind: "toolEnd", callId: "t2", toolName: "bash", ok: true, plan: null });
		expect(event({ type: "tool_execution_end", toolCallId: "t3", toolName: "todo", result: undefined })).toEqual({
			kind: "toolEnd",
			callId: "t3",
			toolName: "todo",
			ok: true,
			plan: null,
		});
	});

	it("folds retry and compaction edges into notices", () => {
		expect(
			event({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 3000, errorMessage: " 502 " }),
		).toEqual({
			kind: "retry",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 3000,
			message: "502",
		});
		expect(event({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual({
			kind: "retryEnd",
			ok: true,
			attempt: 2,
		});
		expect(event({ type: "auto_compaction_start", reason: "overflow", action: "context-full" })).toEqual({
			kind: "compaction",
			reason: "overflow",
			action: "context-full",
		});
		expect(event({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false })).toEqual({
			kind: "compactionEnd",
			ok: true,
			aborted: false,
			willRetry: false,
			skipped: false,
		});
		expect(
			event({
				type: "auto_compaction_end",
				action: "context-full",
				aborted: true,
				willRetry: true,
				errorMessage: "nope",
			}),
		).toEqual({
			kind: "compactionEnd",
			ok: false,
			aborted: true,
			willRetry: true,
			skipped: false,
		});
	});

	it("keeps session-only events out of the renderer", () => {
		expect(event({ type: "a_type_this_renderer_never_met", detail: 1 })).toEqual({ kind: "other" });
		expect(event({ type: "notice", level: "info", message: "hi" })).toEqual({ kind: "other" });
	});
});
