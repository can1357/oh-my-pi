import { afterEach, describe, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey, open } from "../../src/collab/crypto";
import { type CollabFrame, unpackEnvelope } from "../../src/collab/protocol";
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

	it("ends an overloaded connection explicitly instead of silently losing pending prompts", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/overload", role: "guest", key: {} as CryptoKey });
		const closed = Promise.withResolvers<{ reason: string; reconnect: boolean }>();
		socket.onClose = (reason, reconnect) => closed.resolve({ reason, reconnect });
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			for (let i = 0; i < 300; i++) socket.send({ t: "prompt", text: `effect ${i}` });
			const result = await Promise.race([closed.promise, Bun.sleep(250).then(() => undefined)]);
			expect(result).toMatchObject({ reconnect: false });
			expect(result?.reason).toContain("resync");
			expect(result?.reason).toContain("before retrying");
			expect(ws.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("bounds pending bytes even when the frame count is small", () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/bytes", role: "guest", key: {} as CryptoKey });
		let reason: string | undefined;
		socket.onClose = message => {
			reason = message;
		};
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			const text = "x".repeat(9 * 1024 * 1024);
			socket.send({ t: "prompt", text });
			socket.send({ t: "prompt", text });
			expect(reason).toContain("backlog exceeded");
			expect(socket.isOpen).toBe(false);
		} finally {
			socket.close();
		}
	});

	it("delivers more than 256 lazy snapshot chunks in order before live traffic through a slow transport", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/batch", role: "host", key });
		let generated = 0;
		function* chunks(): Generator<CollabFrame> {
			for (let i = 0; i < 300; i++) {
				generated++;
				yield {
					t: "snapshot-chunk",
					entries: [
						{
							type: "message",
							id: `e${i}`,
							parentId: null,
							timestamp: "2026-09-07T00:00:00Z",
							message: { role: "user", content: "x".repeat(1024), timestamp: 0 },
						},
					],
					final: i === 299,
				};
			}
		}
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			socket.sendBatch(chunks(), 7);
			socket.send({ t: "bye", reason: "after snapshot" }, 7);
			await Bun.sleep(30);
			expect(generated).toBe(0);
			const deadline = Date.now() + 3000;
			while (ws.sent.length < 301 && Date.now() < deadline) {
				ws.bufferedAmount = 0;
				await Bun.sleep(30);
			}
			const received: CollabFrame[] = [];
			for (const bytes of ws.sent) {
				const envelope = unpackEnvelope(bytes)!;
				expect(envelope.peerId).toBe(7);
				received.push(await open(key, envelope.payload));
			}
			const snapshot = received.filter(frame => frame.t === "snapshot-chunk");
			expect(snapshot.flatMap(frame => frame.entries.map(entry => entry.id))).toEqual(
				Array.from({ length: 300 }, (_, i) => `e${i}`),
			);
			expect(snapshot.filter(frame => frame.final)).toEqual([snapshot[299]!]);
			expect(received.at(-1)).toEqual({ t: "bye", reason: "after snapshot" });
		} finally {
			socket.close();
		}
	});

	it("does not send a previous connection's frame after close during encryption", async () => {
		const release = Promise.withResolvers<ArrayBuffer>();
		const encrypt = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockResolvedValue(new Uint8Array([5, 6, 7, 8]).buffer)
			.mockImplementationOnce(() => release.promise);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/generation",
			role: "guest",
			key: {} as CryptoKey,
		});
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			socket.send({ t: "prompt", text: "old command" });
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(encrypt).toHaveBeenCalledTimes(1);
			socket.close();
			socket.connect();
			const second = BackpressuredWebSocket.instances[1]!;
			second.open();
			socket.send({ t: "prompt", text: "new command" });
			release.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
			await Bun.sleep(30);
			expect(first.sent).toEqual([]);
			expect(second.sent.map(bytes => Array.from(bytes.slice(-4)))).toEqual([[5, 6, 7, 8]]);
		} finally {
			release.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
			socket.close();
		}
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
