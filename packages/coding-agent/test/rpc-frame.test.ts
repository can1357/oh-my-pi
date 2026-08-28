import { describe, expect, it } from "bun:test";
import {
	encodeRpcFrame,
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	RpcFrameDecoder,
	RpcFrameEncoder,
} from "../src/modes/rpc/rpc-frame";

function decode(frame: string): Record<string, unknown> {
	return JSON.parse(frame) as Record<string, unknown>;
}

function oversizedMessageHistory(prefix: string) {
	const payload = "x".repeat(64 * 1024);
	return Array.from({ length: 20 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `${prefix}-${index}-${payload}` }],
	}));
}

describe("RPC frame encoding", () => {
	it("preserves fitting frames and serializes stateful message frames once", () => {
		const frame = { id: "request-1", type: "response", command: "get_state", success: true, data: { ok: true } };
		expect(encodeRpcFrame(frame)).toBe(`${JSON.stringify(frame)}\n`);

		for (const version of [1, 2] as const) {
			let messageReads = 0;
			const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
			const event = {
				type: "message_end",
				get message() {
					messageReads++;
					return message;
				},
			};
			const encoder = new RpcFrameEncoder();
			encoder.setProtocolVersion(version);

			expect(decode(encoder.encode(event))).toEqual({ type: "message_end", message });
			expect(messageReads).toBe(1);
		}
	});

	it("compacts agent_end after message events have streamed", () => {
		const messages = Array.from({ length: 32 }, (_, index) => ({
			role: "assistant",
			content: [{ type: "text", text: `message-${index}-${"x".repeat(40 * 1024)}` }],
		}));
		const encoded = encodeRpcFrame({ type: "agent_end", messages, telemetry: { stepCount: 42 } }, messages.length);
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded).toEqual({ type: "agent_end", messages: [], messageCount: 32, telemetry: { stepCount: 42 } });
	});

	it("retains a terminal error emitted only by agent_end after earlier message events", () => {
		const streamed = { role: "assistant", content: [{ type: "text", text: "done" }] };
		const aborted = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		};
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		encoder.encode({ type: "message_end", message: streamed });
		const decoded = decode(encoder.encode({ type: "agent_end", messages: [aborted] }));

		expect(decoded).toEqual({
			type: "agent_end",
			messages: [aborted],
		});
	});

	it("preserves terminal histories that fit for clients reading agent_end messages", () => {
		const streamed = { role: "assistant", content: [{ type: "text", text: "done" }] };
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		encoder.encode({ type: "message_end", message: streamed });
		const frame = { type: "agent_end", messages: [streamed] };

		expect(encoder.encode(frame)).toBe(`${JSON.stringify(frame)}\n`);
	});

	it("matches oversized terminal messages in the JSON shape sent by message_end", () => {
		const messages = oversizedMessageHistory("wire-shape");
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of messages) {
			encoder.encode({
				type: "message_end",
				message: {
					...message,
					disabledFeatures: undefined,
					toolCallAbortMessages: undefined,
				},
			});
		}
		const encoded = encoder.encode({ type: "agent_end", messages });

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decode(encoded)).toEqual({
			type: "agent_end",
			messages: [],
			messageCount: messages.length,
		});
	});

	it("does not let later mutation rewrite the message_end snapshot", () => {
		const messages = oversizedMessageHistory("before");
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of messages) encoder.encode({ type: "message_end", message });
		messages[0].content[0].text = "after";
		const decoded = decode(encoder.encode({ type: "agent_end", messages }));

		expect(decoded.messageCount).toBe(messages.length);
		expect(Array.isArray(decoded.messages)).toBe(true);
		expect((decoded.messages as unknown[]).length).toBeGreaterThan(0);
	});

	it("keeps the active run snapshot when a continuing agent_end arrives late", () => {
		const active = oversizedMessageHistory("active");
		const stale = { role: "assistant", content: [{ type: "text", text: "stale" }] };
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of active) encoder.encode({ type: "message_end", message });

		expect(decode(encoder.encode({ type: "agent_end", messages: [stale], willContinue: true }))).toEqual({
			type: "agent_end",
			messages: [stale],
			willContinue: true,
		});
		expect(decode(encoder.encode({ type: "agent_end", messages: active }))).toEqual({
			type: "agent_end",
			messages: [],
			messageCount: active.length,
		});
		const replayed = decode(encoder.encode({ type: "agent_end", messages: active }));
		expect(replayed.messageCount).toBe(active.length);
		expect(Array.isArray(replayed.messages)).toBe(true);
		expect((replayed.messages as unknown[]).length).toBeGreaterThan(0);
	});

	it("bounds a single multi-byte message without losing its event discriminator", () => {
		const encoded = encodeRpcFrame({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "😀".repeat(300_000) }] },
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.type).toBe("message_end");
		expect(encoded).toContain("chars elided for RPC frame");
	});

	it("bounds objects with many small fields", () => {
		const details = Object.fromEntries(
			Array.from({ length: 12_000 }, (_, index) => [`field-${index}`, `value-${index}-${"x".repeat(64)}`]),
		);
		const encoded = encodeRpcFrame({ type: "tool_execution_end", toolCallId: "tool-1", details });
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.type).toBe("tool_execution_end");
		expect(encoded).toContain("rpcFrameElidedKeys");
	});

	it("fails oversized responses instead of returning partial success data", () => {
		const encoded = encodeRpcFrame({
			id: "request-2",
			type: "response",
			command: "get_state",
			success: true,
			data: { transcript: "x".repeat(MAX_RPC_FRAME_BYTES) },
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded).toEqual({
			id: "request-2",
			type: "response",
			command: "get_state",
			success: false,
			error: "RPC response exceeded the transport limit",
		});
	});

	it("keeps overflow response metadata within the hard byte ceiling", () => {
		const encoded = encodeRpcFrame({
			id: "😀".repeat(Math.ceil(MAX_RPC_FRAME_BYTES / 4)),
			type: "response",
			command: "get_state",
			success: true,
			data: {},
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.success).toBe(false);
		expect(decoded.id).toContain("chars elided for RPC frame");
	});

	it("losslessly chunks oversized protocol v2 responses into bounded JSONL frames", () => {
		const frame = {
			id: "request-v2",
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [{ role: "assistant", content: "😀".repeat(300_000) }] },
		};
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const encoded = encoder.encode(frame);
		const lines = encoded.trimEnd().split("\n");
		const decoder = new RpcFrameDecoder();
		let decoded: object | undefined;

		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(Buffer.byteLength(`${line}\n`, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			decoded = decoder.push(JSON.parse(line));
		}
		expect(decoded).toEqual(frame);
	});

	it("accepts a chunked logical frame at the exact physical-frame boundary", () => {
		const frame = {
			id: "request-boundary",
			type: "response",
			command: "get_state",
			success: true,
			data: { payload: "" },
		};
		const emptyBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		frame.data.payload = "x".repeat(MAX_RPC_FRAME_BYTES - emptyBytes);
		expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBe(MAX_RPC_FRAME_BYTES);

		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const decoder = new RpcFrameDecoder();
		let decoded: object | undefined;
		for (const line of encoder.encode(frame).trimEnd().split("\n")) decoded = decoder.push(JSON.parse(line));

		expect(decoded).toEqual(frame);
	});

	it("preserves terminal message counts above the protocol v2 ceiling", () => {
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const encoded = encoder.encode({
			type: "agent_end",
			messages: [{ role: "assistant", content: "😀".repeat(Math.ceil(MAX_RPC_REASSEMBLED_BYTES / 4)) }],
		});

		expect(decode(encoded)).toEqual({
			type: "agent_end",
			messages: [],
			messageCount: 1,
		});
	});

	it("rejects protocol v2 logical frames above the advertised reassembly ceiling", () => {
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const encoded = encoder.encode({
			id: "request-too-large",
			type: "response",
			command: "get_messages",
			success: true,
			data: { transcript: "😀".repeat(Math.ceil(MAX_RPC_REASSEMBLED_BYTES / 4)) },
		});

		expect(decode(encoded)).toEqual({
			id: "request-too-large",
			type: "response",
			command: "get_messages",
			success: false,
			error: "RPC response exceeded the transport limit",
		});
	});

	it("rejects interrupted protocol v2 chunk sequences", () => {
		const decoder = new RpcFrameDecoder();
		decoder.push({
			type: "rpc_chunk",
			chunkId: "chunk-1",
			index: 0,
			count: 2,
			byteLength: MAX_RPC_FRAME_BYTES + 1,
			data: "ew==",
		});

		expect(() =>
			decoder.push({
				type: "rpc_chunk",
				chunkId: "chunk-2",
				index: 1,
				count: 2,
				byteLength: MAX_RPC_FRAME_BYTES + 1,
				data: "fQ==",
			}),
		).toThrow("rpc chunk sequence mismatch");
	});
});
