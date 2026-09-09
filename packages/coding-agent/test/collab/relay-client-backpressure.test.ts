import { afterEach, describe, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey, open, seal } from "../../src/collab/crypto";
import { type CollabFrame, packEnvelope, unpackEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HIGH_WATER_MARK = 64 * 1024;
const DRAIN_RETRY_MS = 25;
/** `MAX_RETIRED_PEERS` in relay-client.ts. */
const RETIREMENT_CAP = 256;

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(2);
	}
}

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

	it("discards a stale targeted batch across a transient reconnect", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		// Real sealing: the enveloped size has to cross the high-water mark for the
		// batch to still be queued when the transport drops.
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/rejoin", role: "host", key });
		let generated = 0;
		function* chunks(): Generator<CollabFrame> {
			for (let i = 0; i < 60; i++) {
				generated++;
				yield {
					t: "snapshot-chunk",
					entries: [
						{
							type: "message",
							id: `e${i}`,
							parentId: null,
							timestamp: "2026-09-08T00:00:00Z",
							message: { role: "user", content: "x".repeat(32 * 1024), timestamp: 0 },
						},
					],
					final: i === 59,
				};
			}
		}
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			socket.sendBatch(chunks(), 7);
			// Wait for the condition the test needs — the drain blocked above the
			// high-water mark, so the batch is still queued when the transport drops.
			// A sleep only guesses at how long real AES-GCM takes, and the first frame
			// alone is ~32 KiB, half of what it takes to block.
			await waitUntil(
				() => first.bufferedAmount >= HIGH_WATER_MARK,
				"the transport never blocked with the batch still queued",
			);
			expect(generated).toBeLessThan(60);

			// Transient drop: code 1000 is not fatal, so the socket retries and the
			// relay it comes back to is a new room with reissued peer ids.
			const generatedAtDrop = generated;
			first.close();
			const appeared = Date.now() + 3_000;
			while (BackpressuredWebSocket.instances.length < 2 && Date.now() < appeared) await Bun.sleep(20);
			const second = BackpressuredWebSocket.instances[1];
			if (!second) throw new Error("socket never retried after the transient drop");
			second.open();
			socket.send({ t: "error", message: "welcome stand-in for the new guest" }, 9);

			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && !second.sent.some(bytes => unpackEnvelope(bytes)?.peerId === 9)) {
				second.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			const targets = second.sent.map(bytes => unpackEnvelope(bytes)?.peerId);
			expect(targets).toContain(9);
			// The stale batch must not resume: it would sit ahead of peer 9 forever.
			expect(targets).not.toContain(7);
			expect(generated).toBe(generatedAtDrop);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("serves a reissued peer id after a reconnect", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/reissue", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			first.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);
			expect(socket.isServing(1)).toBe(false);

			first.close();
			const appeared = Date.now() + 3_000;
			while (BackpressuredWebSocket.instances.length < 2 && Date.now() < appeared) await Bun.sleep(20);
			const second = BackpressuredWebSocket.instances[1];
			if (!second) throw new Error("socket never retried after the transient drop");
			second.open();

			// The recreated room hands out ids from 1 again, so retiring an id must
			// not outlive the connection that retired it.
			expect(socket.isServing(1)).toBe(true);
			socket.send({ t: "error", message: "welcome stand-in" }, 1);
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && second.sent.length === 0) {
				second.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			expect(second.sent.map(bytes => unpackEnvelope(bytes)?.peerId)).toEqual([1]);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("keeps a retirement whose queued decryption has not settled", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const gate = Promise.withResolvers<void>();
		let gated = false;
		const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const decrypt = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
				if (!gated) {
					gated = true;
					await gate.promise;
				}
				return realDecrypt(...args);
			});
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/churn", role: "host", key });
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// Peer 1's hello arrives and is held mid-decryption, then peer 1 departs.
			const sealed = await seal(key, { t: "hello", proto: 1, name: "flake" } as CollabFrame);
			ws.onmessage?.({ data: packEnvelope(1, sealed).buffer } as MessageEvent);
			await waitUntil(() => decrypt.mock.calls.length > 0, "host never began opening the hello");
			ws.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);
			// Churn far past the retirement cap while that frame is still in the chain.
			for (let peer = 2; peer <= 301; peer++) {
				ws.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}
			await Bun.sleep(20);
			// Count is not the obligation. While that frame is still in the chain the
			// record must stand, or the host would act on the hello as a live peer and
			// register a ghost participant.
			expect(socket.isServing(1)).toBe(false);
		} finally {
			gate.resolve();
			socket.close();
		}
	}, 15_000);

	it("does not let an old room's retirement settle a record in the new one", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const gate = Promise.withResolvers<void>();
		let gated = false;
		const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const decrypt = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
				if (!gated) {
					gated = true;
					await gate.promise;
				}
				return realDecrypt(...args);
			});
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/rooms", role: "host", key });
		// What the owner would decide with: `CollabHost#handleFrame` rejects a frame
		// whose sender the socket no longer serves, so this is the authority the
		// dispatch carries.
		const dispatched: { peer: number; served: boolean }[] = [];
		socket.onFrame = (_frame, fromPeer) => dispatched.push({ peer: fromPeer, served: socket.isServing(fromPeer) });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();

			// Old room: peer 1's frame is held mid-decryption, so the settlement its
			// departure schedules is still queued behind it — and stays queued across
			// everything that follows, because the receive chain is one chain.
			const stale = await seal(key, { t: "hello", proto: 1, name: "old" } as CollabFrame);
			first.onmessage?.({ data: packEnvelope(1, stale).buffer } as MessageEvent);
			await waitUntil(() => decrypt.mock.calls.length > 0, "socket never began opening the old room's frame");
			first.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);

			// The room is recreated and hands out ids from 1 again.
			first.close();
			await waitUntil(
				() => BackpressuredWebSocket.instances.length > 1,
				"socket never retried after the transient drop",
			);
			const second = BackpressuredWebSocket.instances[1]!;
			second.open();

			// New room, same id, different client: it sends a frame and leaves. Its
			// record may not be settled until that frame has been dispatched, which is
			// the whole obligation the record exists for.
			const fresh = await seal(key, { t: "hello", proto: 1, name: "new" } as CollabFrame);
			second.onmessage?.({ data: packEnvelope(1, fresh).buffer } as MessageEvent);
			second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);
			// Past the cap, so a record settled early is a record evicted early. None
			// of these settle while the chain is held.
			for (let peer = 2; peer <= RETIREMENT_CAP + 45; peer++) {
				second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}

			gate.resolve();
			await waitUntil(() => dispatched.length > 0, "the new room's frame was never dispatched");
			// The old room's settlement runs first. It must not touch this record: the
			// new peer 1 has left, and a frame dispatched as though it had not is
			// authority the relay already withdrew.
			// Exactly one dispatch, and not served: the old room's frame is dropped at
			// the reconnect, and the new room's arrives with its departure known.
			// Nothing is claimed about the record past this point — once its own
			// settlement runs the obligation is discharged and the cap may age it out,
			// which is the backstop working rather than the hole reopening.
			expect(dispatched).toEqual([{ peer: 1, served: false }]);
		} finally {
			gate.resolve();
			socket.close();
		}
	}, 15_000);

	it("does not let a closed room's retirement settle a record in the reopened one", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const gate = Promise.withResolvers<void>();
		let gated = false;
		const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const decrypt = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
				if (!gated) {
					gated = true;
					await gate.promise;
				}
				return realDecrypt(...args);
			});
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/reuse", role: "host", key });
		const dispatched: { peer: number; served: boolean }[] = [];
		socket.onFrame = (_frame, fromPeer) => dispatched.push({ peer: fromPeer, served: socket.isServing(fromPeer) });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			const stale = await seal(key, { t: "hello", proto: 1, name: "old" } as CollabFrame);
			first.onmessage?.({ data: packEnvelope(1, stale).buffer } as MessageEvent);
			await waitUntil(() => decrypt.mock.calls.length > 0, "socket never began opening the old room's frame");
			first.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);

			// Not a transient drop this time: the owner closes the socket and connects
			// it again, which the API supports and which reaches a relay that hands out
			// ids from 1 exactly as a reconnect does.
			socket.close();
			socket.connect();
			const second = BackpressuredWebSocket.instances[1]!;
			second.open();

			const fresh = await seal(key, { t: "hello", proto: 1, name: "new" } as CollabFrame);
			second.onmessage?.({ data: packEnvelope(1, fresh).buffer } as MessageEvent);
			second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);
			for (let peer = 2; peer <= RETIREMENT_CAP + 45; peer++) {
				second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}

			gate.resolve();
			await waitUntil(() => dispatched.length > 0, "the reopened room's frame was never dispatched");
			expect(dispatched).toEqual([{ peer: 1, served: false }]);
		} finally {
			gate.resolve();
			socket.close();
		}
	}, 15_000);

	it("does not end a replacement connection over the previous one's bad frame", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const gate = Promise.withResolvers<void>();
		let gated = false;
		const decrypt = vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async () => {
			if (!gated) {
				gated = true;
				await gate.promise;
				throw new Error("bad key");
			}
			throw new Error("bad key");
		});
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/stale-key", role: "host", key });
		const closes: { reason: string; willReconnect: boolean }[] = [];
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			// A frame from this connection parks mid-decryption and will fail.
			const stale = await seal(key, { t: "hello", proto: 1, name: "old" } as CollabFrame);
			first.onmessage?.({ data: packEnvelope(1, stale).buffer } as MessageEvent);
			await waitUntil(() => decrypt.mock.calls.length > 0, "socket never began opening the frame");

			// The connection drops and is replaced before that decryption resolves.
			first.close();
			await waitUntil(
				() => BackpressuredWebSocket.instances.length > 1,
				"socket never retried after the transient drop",
			);
			const second = BackpressuredWebSocket.instances[1]!;
			second.open();
			expect(closes.map(close => close.willReconnect)).toEqual([true]);

			// Now it fails. A bad frame from a connection that is over says nothing
			// about the key of the one that is open, and this close would be fatal.
			gate.resolve();
			await Bun.sleep(20);
			expect(closes.filter(close => !close.willReconnect)).toEqual([]);
			expect(socket.isOpen).toBe(true);
		} finally {
			gate.resolve();
			socket.close();
		}
	}, 15_000);

	it("forgets the oldest retirements instead of growing for the room's lifetime", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/retire", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// A view-link client can connect and disconnect in a loop without ever
			// saying hello; the relay still issues an id and announces the departure.
			const churn = 300;
			for (let peer = 1; peer <= churn; peer++) {
				ws.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}
			// Eviction waits on each record's ordering obligation, which settles on the
			// receive chain, so let those callbacks run before reading the bound.
			await Bun.sleep(20);
			// Recent retirements still hold — that is the correctness property.
			expect(socket.isServing(churn)).toBe(false);
			expect(socket.isServing(churn - 10)).toBe(false);
			// The oldest are forgotten, so the record cannot grow with the room's age.
			expect(socket.isServing(1)).toBe(true);
			expect(socket.isServing(churn - 280)).toBe(true);
		} finally {
			socket.close();
		}
	}, 15_000);

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
