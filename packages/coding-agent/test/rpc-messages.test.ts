import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { pageRpcMessages, type RpcMessageSnapshot } from "../src/modes/rpc/rpc-messages";
import { nestedChain } from "../../ai/test/helpers/deep-nesting";

function message(index: number, bytes = 32 * 1024): AgentMessage {
	return { role: "user", content: `${index}:${"x".repeat(bytes)}`, timestamp: index };
}

const snapshot: RpcMessageSnapshot = {
	sessionId: "session-1",
	leafId: "leaf-1",
	messageCount: 40,
};

describe("RPC message pagination", () => {
	it("reconstructs a large history from v1-safe pages without loss or overlap", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index));
		const reconstructed: AgentMessage[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			const page = pageRpcMessages(messages, snapshot, { cursor, limit: 256 });
			const encoded = encodeRpcFrame({
				id: `page-${pageCount}`,
				type: "response",
				command: "get_messages_page",
				success: true,
				data: page,
			});
			expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
			expect(JSON.parse(encoded).success).toBe(true);
			reconstructed.push(...page.messages);
			cursor = page.nextCursor;
			pageCount++;
		} while (cursor);

		expect(pageCount).toBeGreaterThan(1);
		expect(reconstructed).toEqual(messages);
	});

	it("rejects a cursor after the session snapshot changes", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const first = pageRpcMessages(messages, snapshot, { limit: 5 });
		expect(first.nextCursor).toBeDefined();

		expect(() =>
			pageRpcMessages(messages, { ...snapshot, leafId: "leaf-2" }, { cursor: first.nextCursor, limit: 5 }),
		).toThrow("RPC message cursor is stale");
	});

	it("returns one individually oversized message so negotiated v2 can carry it losslessly", () => {
		const messages = [message(0, 2 * 1024 * 1024), message(1, 128)];
		const first = pageRpcMessages(
			messages,
			{ sessionId: "session-2", leafId: "leaf-2", messageCount: messages.length },
			{ limit: 10 },
		);

		expect(first.messages).toEqual([messages[0]]);
		expect(first.nextCursor).toBeDefined();
	});

	// A tool result's details nest as deep as JSON.parse reads (millions of levels); JSON.stringify gives out at 40,000.
	it("pages past a message nested deeper than JSON.stringify recurses, counting its bytes", () => {
		const details = nestedChain({ leaf: "bottom" });
		const deep: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "inspect",
			content: [{ type: "text", text: "inspected" }],
			details,
			isError: false,
			timestamp: 1,
		};
		// About 410 KB, then about 450 KB for `deep`: the two together pass the 768 KB a page holds.
		const messages = [message(0, 400 * 1024), deep, message(2, 128)];
		const deepSnapshot = { sessionId: "session-3", leafId: "leaf-3", messageCount: messages.length };

		const first = pageRpcMessages(messages, deepSnapshot);
		const second = pageRpcMessages(messages, deepSnapshot, { cursor: first.nextCursor });

		expect(first.messages).toEqual([messages[0]]);
		expect(second.messages).toHaveLength(2);
		expect(second.messages[0]).toBe(deep);
		expect(second.messages[1]).toEqual(messages[2]);
		expect(second.nextCursor).toBeUndefined();
	});
});
