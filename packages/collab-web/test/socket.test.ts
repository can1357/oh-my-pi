import { afterEach, describe, expect, test, vi } from "bun:test";
import { CollabSocket } from "../src/lib/socket";

class FakeWebSocket {
	static readonly instances: FakeWebSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;

	binaryType = "blob";
	readyState: number = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;

	constructor() {
		FakeWebSocket.instances.push(this);
	}

	send(): void {}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	serverClose(code: number, reason: string): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
}

afterEach(() => {
	vi.useRealTimers();
	FakeWebSocket.instances.length = 0;
});

describe("CollabSocket close handling", () => {
	test("a replaced host connection stays closed instead of reconnecting", async () => {
		const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
		vi.useFakeTimers();
		const realWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		try {
			const socket = new CollabSocket({ wsUrl: "wss://relay.example/r/roomroomroom", role: "host", key });
			const onClose = vi.fn();
			socket.onClose = onClose;

			socket.connect();
			const first = FakeWebSocket.instances[0];
			expect(first).toBeDefined();
			first!.open();
			first!.serverClose(4010, "replaced by a newer host connection");

			expect(onClose).toHaveBeenCalledWith("host connection replaced", false);
			vi.advanceTimersByTime(60_000);
			expect(FakeWebSocket.instances).toHaveLength(1);
		} finally {
			globalThis.WebSocket = realWebSocket;
		}
	});
});
