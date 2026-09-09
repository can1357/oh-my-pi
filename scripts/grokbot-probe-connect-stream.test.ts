import { describe, expect, test } from "bun:test";
import {
	CONNECT_END_STREAM_FLAG,
	encodeInferenceStreamResponse,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";
import {
	hasCompletedValidShell,
	parseConnectStreamFrames,
	upsertToolCall,
} from "./grokbot-probes/parse-connect-stream.mjs";

describe("grokbot probe Connect stream parsing", () => {
	test("upsertToolCall tracks by id and requires isComplete for Shell success", () => {
		const toolCalls = [];
		upsertToolCall(toolCalls, {
			toolCallId: "c1",
			toolName: "Shell",
			args: '{"command":"echo hi"}',
			isComplete: false,
		});
		expect(hasCompletedValidShell(toolCalls)).toBe(false);
		upsertToolCall(toolCalls, {
			toolCallId: "c1",
			toolName: "Shell",
			args: '{"command":"echo hi"}',
			isComplete: true,
		});
		expect(hasCompletedValidShell(toolCalls)).toBe(true);
		expect(toolCalls).toHaveLength(1);
	});

	test("incomplete Shell plus end trailer does not set completedShell", () => {
		const incomplete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "hang",
					toolName: "Shell",
					args: '{"command":"echo',
					isComplete: false,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.from("{}"), CONNECT_END_STREAM_FLAG);
		const parsed = parseConnectStreamFrames(Buffer.concat([incomplete, trailer]));
		expect(parsed.ok).toBe(true);
		expect(parsed.toolNames).toContain("Shell");
		expect(parsed.completedShell).toBe(false);
	});

	test("completed Shell with object args passes completedShell", () => {
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "Shell",
					args: '{"command":"echo opus-tools-matrix"}',
					isComplete: true,
				},
			}),
		);
		const trailer = frameConnectProto(Buffer.from("{}"), CONNECT_END_STREAM_FLAG);
		const parsed = parseConnectStreamFrames(Buffer.concat([complete, trailer]));
		expect(parsed.ok).toBe(true);
		expect(parsed.completedShell).toBe(true);
	});

	test("ok is false when the Connect end-stream trailer is missing", () => {
		const complete = frameConnectProto(
			encodeInferenceStreamResponse({
				toolCallPart: {
					toolCallId: "c1",
					toolName: "Shell",
					args: '{"command":"echo hi"}',
					isComplete: true,
				},
			}),
		);
		const parsed = parseConnectStreamFrames(complete);
		expect(parsed.ok).toBe(false);
		expect(parsed.completedShell).toBe(true);
	});
});
