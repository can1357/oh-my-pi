import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	type CursorExecResolvedCarrier,
	isCursorExecResolved,
	kCursorExecResolved,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { createToolCallAuditEvent, detectToolCallAnomaly } from "@oh-my-pi/pi-ai/utils/tool-call-anomaly";

/** Minimal assistant message with the given content blocks. */
function assistant(
	content: AssistantMessage["content"],
	stopReason: "toolUse" | "stop" | "length" = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
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
	};
}

/** Build a `toolCall` block. When `cursorExecResolved` is true, the block is
 * marked as already executed by Cursor's exec channel (must be ignored). */
function toolCall(id: string, name: string, cursorExecResolved = false): ToolCall {
	const call: ToolCall & CursorExecResolvedCarrier = {
		type: "toolCall",
		id,
		name,
		arguments: {},
	} as ToolCall & CursorExecResolvedCarrier;
	if (cursorExecResolved) {
		call[kCursorExecResolved] = true;
	}
	return call;
}

/** A real (non-synthetic) tool result. */
function realResult(callId: string, toolName: string, text: string | null, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: text !== null ? [{ type: "text", text }] : [],
		isError,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

/** A synthetic placeholder result (as emitted when a call was never executed). */
function syntheticResult(
	callId: string,
	toolName: string,
	source:
		| "assistant_stop_aborted"
		| "assistant_stop_error"
		| "assistant_stop_skipped"
		| "assistant_stop_length"
		| "interrupt_skipped",
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: "(placeholder)" }],
		isError: false,
		details: { __synthetic: true, source },
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("detectToolCallAnomaly", () => {
	it("reports nothing for a healthy turn (substantive real results)", () => {
		const message = assistant([toolCall("call_1", "read")]);
		const results = [realResult("call_1", "read", "file contents...")];
		expect(detectToolCallAnomaly(message, results)).toBeUndefined();
	});

	it("reports nothing for multiple substantive real results", () => {
		const message = assistant([toolCall("call_1", "read"), toolCall("call_2", "bash")]);
		const results = [realResult("call_1", "read", "contents"), realResult("call_2", "bash", "exit 0; output\n")];
		expect(detectToolCallAnomaly(message, results)).toBeUndefined();
	});

	it("flags tool_failed for a real empty (non-error) result", () => {
		const message = assistant([toolCall("call_1", "read")]);
		const results = [realResult("call_1", "read", "")];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.details).toHaveLength(1);
		expect(anomaly!.details[0].toolName).toBe("read");
		expect(anomaly!.details[0].kind).toBe("tool_failed");
		expect(anomaly!.details[0].reason).toBe("empty_text");
	});

	it("flags tool_failed for a result with null content", () => {
		const message = assistant([toolCall("call_1", "read")]);
		const results = [realResult("call_1", "read", null)];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.details[0].kind).toBe("tool_failed");
	});

	it("flags tool_failed for an error result that carries no message", () => {
		const message = assistant([toolCall("call_1", "read")]);
		const results = [realResult("call_1", "read", "", true)];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.details[0].kind).toBe("tool_failed");
		expect(anomaly!.details[0].reason).toBe("error: (no message)");
	});

	it("does NOT flag a real error result that carries a message (model saw the failure)", () => {
		const message = assistant([toolCall("call_1", "read")]);
		const results = [realResult("call_1", "read", "Invalid arguments: missing path", true)];
		expect(detectToolCallAnomaly(message, results)).toBeUndefined();
	});

	it("flags never_run for a synthetic result (call emitted but never executed)", () => {
		const message = assistant([toolCall("call_1", "read")], "length");
		const results = [syntheticResult("call_1", "read", "assistant_stop_length")];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.details[0].kind).toBe("never_run");
	});

	it("flags never_run with the stop reason when the synthetic source is length", () => {
		const message = assistant([toolCall("call_1", "read")], "length");
		const results = [syntheticResult("call_1", "read", "assistant_stop_length")];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly!.details[0].kind).toBe("never_run");
		expect(anomaly!.details[0].stopReason).toBe("length");
	});

	it("flags never_run for each distinct synthetic source", () => {
		const message = assistant([toolCall("call_1", "read"), toolCall("call_2", "write")]);
		const results = [
			syntheticResult("call_1", "read", "assistant_stop_aborted"),
			syntheticResult("call_2", "write", "assistant_stop_skipped"),
		];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.kinds).toEqual(["never_run"]);
		expect(anomaly!.details).toHaveLength(2);
	});

	it("flags never_run when a call has no paired result at all", () => {
		// The assistant issued call_1 AND call_2, but only call_1 got a result.
		const message = assistant([toolCall("call_1", "read"), toolCall("call_2", "bash")]);
		const results = [realResult("call_1", "read", "ok")];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		// call_1 is healthy; only call_2 (no result) is flagged.
		expect(anomaly!.details).toHaveLength(1);
		expect(anomaly!.details[0].callId).toBe("call_2");
		expect(anomaly!.details[0].kind).toBe("never_run");
	});

	it("aggregates multiple anomaly kinds in one turn (failed + never_run)", () => {
		const message = assistant([toolCall("call_1", "read"), toolCall("call_2", "write")], "length");
		const results = [
			realResult("call_1", "read", ""), // empty -> tool_failed
			syntheticResult("call_2", "write", "assistant_stop_length"), // -> never_run
		];
		const anomaly = detectToolCallAnomaly(message, results);
		expect(anomaly).toBeDefined();
		expect(anomaly!.kinds).toEqual(["tool_failed", "never_run"]);
		expect(anomaly!.details).toHaveLength(2);
	});

	it("ignores Cursor-exec resolved tool calls (already executed server-side)", () => {
		const call = toolCall("call_exec", "bash", true);
		const message = assistant([call]);
		expect(isCursorExecResolved(call as CursorExecResolvedCarrier)).toBe(true);
		// Even though the result is empty, the call is Cursor-exec (already ran) so it
		// must not be flagged.
		const results = [realResult("call_exec", "bash", "")];
		expect(detectToolCallAnomaly(message, results)).toBeUndefined();
	});
});

describe("createToolCallAuditEvent", () => {
	it("captures kinds, truncation, model, and details", () => {
		const message = assistant([toolCall("call_1", "read")], "length");
		const results = [realResult("call_1", "read", "")];
		const anomaly = detectToolCallAnomaly(message, results)!;
		const event = createToolCallAuditEvent({
			anomaly,
			model: { provider: "openai-codex", id: "gpt-5.4" },
			timestamp: 123,
		});
		expect(event).toBeDefined();
		expect(event!.stopReason).toBe("length");
		expect(event!.truncated).toBe(true);
		expect(event!.kinds).toEqual(["tool_failed"]);
		expect(event!.model).toEqual({ provider: "openai-codex", id: "gpt-5.4" });
		expect(event!.timestamp).toBe(123);
		expect(event!.details).toHaveLength(1);
	});

	it("leaves model and timestamp optional", () => {
		const message = assistant([toolCall("call_1", "read")], "stop");
		const results = [syntheticResult("call_1", "read", "assistant_stop_aborted")];
		const anomaly = detectToolCallAnomaly(message, results)!;
		const event = createToolCallAuditEvent({ anomaly });
		expect(event!.model).toBeUndefined();
		expect(event!.timestamp).toBeUndefined();
		expect(event!.stopReason).toBe("stop");
		expect(event!.truncated).toBe(false);
	});
});
