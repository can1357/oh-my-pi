import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import { pageRpcMessages, type RpcMessageSnapshot } from "../src/modes/rpc/rpc-messages";

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

	it("walks the whole history newest-first with order desc", () => {
		const messages = Array.from({ length: snapshot.messageCount }, (_, index) => message(index, 1024));
		const collected: AgentMessage[] = [];
		let cursor: string | undefined;
		do {
			const page = pageRpcMessages(messages, snapshot, { order: "desc", cursor, limit: 7 });
			collected.push(...page.messages);
			cursor = page.nextCursor;
		} while (cursor);

		expect(collected).toEqual([...messages].reverse());
	});

	it("keeps a cursor's own walk direction regardless of a conflicting order option", () => {
		const messages = Array.from({ length: 10 }, (_, index) => message(index, 1024));
		const snap = { sessionId: "s", leafId: "l", messageCount: messages.length };
		const first = pageRpcMessages(messages, snap, { order: "desc", limit: 3 });
		expect(first.messages).toEqual([messages[9], messages[8], messages[7]]);

		// The desc cursor continues backwards even when the caller passes asc.
		const second = pageRpcMessages(messages, snap, { cursor: first.nextCursor, order: "asc", limit: 3 });
		expect(second.messages).toEqual([messages[6], messages[5], messages[4]]);
	});

	it("pages around an anchor cursor with before and after", () => {
		const messages = Array.from({ length: 20 }, (_, index) => message(index, 1024));
		const snap = { sessionId: "s", leafId: "l", messageCount: messages.length };
		const anchor = pageRpcMessages(messages, snap, { limit: 10 }).nextCursor!;

		const before = pageRpcMessages(messages, snap, { before: anchor, limit: 4 });
		expect(before.messages).toEqual([messages[9], messages[8], messages[7], messages[6]]);
		expect(before.nextCursor).toBeDefined();

		const after = pageRpcMessages(messages, snap, { after: anchor, limit: 4 });
		expect(after.messages).toEqual([messages[10], messages[11], messages[12], messages[13]]);
		expect(after.nextCursor).toBeDefined();
	});

	it("rejects combining before, after, and cursor anchors", () => {
		const messages = Array.from({ length: 10 }, (_, index) => message(index, 1024));
		const snap = { sessionId: "s", leafId: "l", messageCount: messages.length };
		const anchor = pageRpcMessages(messages, snap, { limit: 5 }).nextCursor!;

		expect(() => pageRpcMessages(messages, snap, { before: anchor, after: anchor })).toThrow("only one of");
		expect(() => pageRpcMessages(messages, snap, { before: anchor, cursor: anchor })).toThrow("either cursor or");
	});
});
