import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES } from "../src/modes/rpc/rpc-frame";
import {
	pageRpcMessages,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagePageSessionState,
	type RpcMessageSnapshot,
	resolveRpcMessagePageSource,
} from "../src/modes/rpc/rpc-messages";

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
});

describe("RPC message pagination during streaming", () => {
	function liveSession(
		initialCount: number,
		streaming = true,
		leafId = "leaf-live",
	): RpcMessagePageSessionState & {
		messages: AgentMessage[];
		append(): void;
	} {
		const messages = Array.from({ length: initialCount }, (_, index) => message(index, 1024));
		return {
			isStreaming: streaming,
			sessionId: "session-live",
			messages,
			getLeafId: () => leafId,
			append() {
				messages.push(message(messages.length, 1024));
			},
		};
	}

	it("pages one frozen snapshot while streaming without stale cursors within the epoch", () => {
		const live = liveSession(10);
		const source = resolveRpcMessagePageSource(undefined, live);
		const page1 = pageRpcMessages(source.messages, source.snapshot, { limit: 5 });
		expect(page1.messages).toHaveLength(5);
		expect(page1.nextCursor).toBeDefined();

		// The live array keeps growing, but the walk stays bound to the frozen length.
		live.append();
		live.append();
		live.append();
		// Re-resolving inside the same streaming epoch must reuse the same frozen source.
		const reused = resolveRpcMessagePageSource(source, live);
		expect(reused).toBe(source);

		let cursor: string | undefined = page1.nextCursor;
		const pages: AgentMessage[][] = [page1.messages];
		do {
			const page = pageRpcMessages(reused.messages, reused.snapshot, { cursor, limit: 5 });
			pages.push(page.messages);
			cursor = page.nextCursor;
		} while (cursor);

		expect(pages.flat()).toHaveLength(10);
		expect(pages.flat()).toEqual(live.messages.slice(0, 10));
		expect(reused.snapshot.messageCount).toBe(10);
	});

	it("re-freezes once the session settles, so a cursor that outlived the epoch goes stale", () => {
		const live = liveSession(10, true);
		let source = resolveRpcMessagePageSource(undefined, live);
		const page1 = pageRpcMessages(source.messages, source.snapshot, { limit: 5 });

		// The turn completes and more messages arrive before the client pages on.
		live.append();
		live.isStreaming = false;
		source = resolveRpcMessagePageSource(source, live);

		expect(() => pageRpcMessages(source.messages, source.snapshot, { cursor: page1.nextCursor, limit: 5 })).toThrow(
			RPC_MESSAGES_PAGE_STALE_ERROR,
		);
	});

	it("re-freezes when the session identity changes even mid-stream", () => {
		const live = liveSession(5, true, "leaf-a");
		const source = resolveRpcMessagePageSource(undefined, live);
		const page1 = pageRpcMessages(source.messages, source.snapshot, { limit: 5 });
		expect(page1.nextCursor).toBeUndefined();
		expect(page1.totalMessages).toBe(5);

		// Branch/switch lands on a different session while still streaming.
		live.sessionId = "session-other";
		const rebased = resolveRpcMessagePageSource(source, live);
		expect(rebased).not.toBe(source);
		expect(rebased.snapshot.sessionId).toBe("session-other");
		expect(rebased.snapshot.messageCount).toBe(5);
	});
});
