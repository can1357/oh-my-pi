import { describe, expect, it } from "bun:test";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";

describe("yield subprocess extraction", () => {
	const handler = subprocessToolRegistry.getHandler("yield");

	it("extracts valid yield payloads", () => {
		expect(handler?.extractData).toBeDefined();
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-1",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: {
					status: "success",
					data: { ok: true },
					type: ["notes"],
					useLastTurn: true,
				},
			},
			isError: false,
		});
		expect(data).toEqual({
			status: "success",
			data: { ok: true },
			error: undefined,
			type: ["notes"],
			useLastTurn: true,
		});
	});

	it("ignores malformed yield details without status", () => {
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-2",
			result: {
				content: [{ type: "text", text: "Tool execution was aborted." }],
				details: {},
			},
			isError: true,
		});
		expect(data).toBeUndefined();
	});

	it("classifies terminal and incremental yield completions", () => {
		expect(handler?.shouldTerminate).toBeDefined();
		expect(
			handler?.shouldTerminate?.({
				toolName: "yield",
				toolCallId: "call-terminal-untyped",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			}),
		).toBe(true);
		expect(
			handler?.shouldTerminate?.({
				toolName: "yield",
				toolCallId: "call-terminal-string",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", type: "summary", useLastTurn: true },
				},
				isError: false,
			}),
		).toBe(true);
		expect(
			handler?.shouldTerminate?.({
				toolName: "yield",
				toolCallId: "call-incremental",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true }, type: ["notes"] },
				},
				isError: false,
			}),
		).toBe(false);
		expect(
			handler?.shouldTerminate?.({
				toolName: "yield",
				toolCallId: "call-workpool-complete",
				result: {
					content: [{ type: "text", text: "All workpool items are complete." }],
					details: { status: "success", data: { ok: true }, type: ["review#2"], complete: true },
				},
				isError: false,
			}),
		).toBe(true);
		expect(
			handler?.shouldTerminate?.({
				toolName: "yield",
				toolCallId: "call-tool-error",
				isError: true,
			}),
		).toBe(false);
	});
});
