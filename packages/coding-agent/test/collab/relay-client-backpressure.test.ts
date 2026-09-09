import { afterEach, describe, expect, it, vi } from "bun:test";
import { CollabSocket } from "../../src/collab/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HIGH_WATER_MARK = 64 * 1024;
const DRAIN_RETRY_MS = 25;

class BackpressuredWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static initialBufferedAmount = 0;
	static instances: BackpressuredWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount: number;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = BackpressuredWebSocket.CONNECTING;
	sent: Uint8Array[] = [];

	constructor(url: string) {
		this.url = url;
		this.bufferedAmount = BackpressuredWebSocket.initialBufferedAmount;
		BackpressuredWebSocket.instances.push(this);
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
		this.bufferedAmount += data.byteLength;
	}

	open(): void {
		this.readyState = BackpressuredWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	close(): void {
		if (this.readyState === BackpressuredWebSocket.CLOSED) return;
		this.readyState = BackpressuredWebSocket.CLOSED;
		this.onclose?.({ code: 1000, reason: "closed" } as CloseEvent);
	}
}

describe("CollabSocket send backpressure", () => {
	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("queues open-socket sends while bufferedAmount is above the high-water mark", async () => {
		vi.useFakeTimers();
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/backpressure",
			role: "host",
			key: {} as CryptoKey,
		});

		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0];
			if (!ws) throw new Error("CollabSocket did not construct a WebSocket");
			ws.open();
			socket.send({ t: "bye", reason: "slow relay" });
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			ws.bufferedAmount = 0;
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("drains reconnect backlog through the same backpressure gate", async () => {
		vi.useFakeTimers();
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/backpressure",
			role: "host",
			key: {} as CryptoKey,
		});

		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0];
			if (!ws) throw new Error("CollabSocket did not construct a WebSocket");
			socket.send({ t: "bye", reason: "queued while disconnected" });
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			ws.open();
			expect(ws.sent).toHaveLength(0);
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			ws.bufferedAmount = 0;
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});
});
