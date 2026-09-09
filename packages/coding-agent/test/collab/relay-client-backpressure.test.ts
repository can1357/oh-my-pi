import { afterEach, describe, expect, it, vi } from "bun:test";
import { generateRoomKey, importRoomKey, open, seal } from "../../src/collab/crypto";
import { type CollabFrame, packEnvelope, unpackEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HIGH_WATER_MARK = 64 * 1024;
const DRAIN_RETRY_MS = 25;
/** `MAX_RETIRED_PEERS` in relay-client.ts. */
const RETIREMENT_CAP = 256;
/** `MAX_PEER_PENDING_SENDS` in relay-client.ts. */
const PEER_SHARE = 32;
const BYSTANDER = 2;
const GREEDY = 1;

/** A one-frame welcome batch: what the newcomer reservation is actually reserved for. */
function welcomeBatch(message: string): Iterable<CollabFrame> {
	return [{ t: "error", message }] as CollabFrame[];
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(2);
	}
}

/**
 * Flush microtasks until {@link done} holds. Fake timers make a real wait
 * impossible, and a fixed number of turns is a guess at how deep the sealing
 * pipeline happens to be.
 */
async function flushUntil(done: () => boolean, message: string): Promise<void> {
	for (let turn = 0; turn < 200; turn++) {
		if (done()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

/** Turns to let a frame appear that should not; a negative can only be bounded. */
const SETTLE_TURNS = 20;

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

	it("sheds targeted backlog before a broadcast is allowed to kill the socket", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/shed", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// 16 guests × 32 frames fills the 256-frame queue with targeted work.
			for (let peer = 1; peer <= 16; peer++) {
				for (let i = 0; i < 32; i++) socket.send({ t: "error", message: `p${peer}-${i}` }, peer);
			}
			for (let i = 0; i < 8; i++) socket.send({ t: "bye", reason: `broadcast ${i}` });
			const ws = BackpressuredWebSocket.instances[0]!;
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && !ws.sent.some(bytes => unpackEnvelope(bytes)?.peerId === 0)) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			expect(closeReason).toBeUndefined();
			expect(socket.isOpen).toBe(true);
			// Peers 1-8 never exceeded their own share, so shedding them is the
			// heaviest-backlog fallback making room for the broadcast.
			expect(shed.some(peer => peer <= 8)).toBe(true);
			expect(ws.sent.some(bytes => unpackEnvelope(bytes)?.peerId === 0)).toBe(true);
		} finally {
			socket.close();
		}
	});

	it("keeps the event loop alive when broadcasts own the whole queue and a targeted frame arrives", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/spin", role: "host", key: {} as CryptoKey });
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		let timerFired = false;
		let overloads = 0;
		let timerFiredInsideLoop: boolean | undefined;
		// Mirrors CollabHost#handlePeerOverload: the owner answers by sending the
		// peer a targeted resync error. Bounded so a live-lock fails an assertion
		// instead of hanging the runner.
		const LOOP_BOUND = 2_000;
		socket.onPeerOverload = peer => {
			overloads++;
			if (overloads >= LOOP_BOUND) {
				timerFiredInsideLoop ??= timerFired;
				return;
			}
			socket.send({ t: "error", message: "rejoin to resync" }, peer);
		};
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			for (let i = 0; i < 256; i++) socket.send({ t: "bye", reason: `broadcast ${i}` });
			expect(socket.isOpen).toBe(true);

			setTimeout(() => {
				timerFired = true;
			}, 0);
			socket.send({ t: "error", message: "targeted while the queue is broadcast-owned" }, 7);
			await Bun.sleep(50);

			// A peer with nothing queued has no backlog to discard, so nothing is
			// reported and nothing re-enters the queue.
			expect(overloads).toBe(0);
			expect(timerFiredInsideLoop).toBeUndefined();
			expect(timerFired).toBe(true);
			expect(closeReason).toBeUndefined();
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
			socket.sendBatch(chunks(), 7, 0);
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

	it("admits a newcomer by shedding the heaviest holder when peers own the queue", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/fair", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// Eight peers, each inside its allowed share, together filling the queue.
			for (let peer = 1; peer <= 8; peer++) {
				for (let i = 0; i < 32; i++) socket.send({ t: "error", message: `p${peer}-${i}` }, peer);
			}
			socket.sendBatch(welcomeBatch("welcome stand-in for the ninth guest"), 9, 0);

			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && !ws.sent.some(bytes => unpackEnvelope(bytes)?.peerId === 9)) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			// The newcomer breaks no rule and must not be locked out by peers that
			// break none either.
			expect(ws.sent.map(bytes => unpackEnvelope(bytes)?.peerId)).toContain(9);
			expect(shed.some(peer => peer >= 1 && peer <= 8)).toBe(true);
			expect(shed).not.toContain(9);
			expect(closeReason).toBeUndefined();
		} finally {
			socket.close();
		}
	}, 15_000);

	it("never sheds the peer whose own frame is asking for room", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/self", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// Peer 1 is the heaviest targeted holder but is still inside its share,
			// and it is the one asking: shedding it would discard its backlog to make
			// room for its own frame and report it as overloaded.
			for (let i = 0; i < 250; i++) socket.send({ t: "bye", reason: `broadcast ${i}` });
			for (let i = 0; i < 5; i++) socket.send({ t: "error", message: `p1-${i}` }, 1);
			socket.send({ t: "error", message: "p2-0" }, 2);
			socket.sendBatch(welcomeBatch("p1-next"), 1, 0);

			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && ws.sent.filter(b => unpackEnvelope(b)?.peerId === 1).length < 6) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			expect(shed).not.toContain(1);
			expect(shed).toContain(2);
			expect(ws.sent.filter(bytes => unpackEnvelope(bytes)?.peerId === 1).length).toBe(6);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not shed a quota-abiding peer while reporting another peer's overload", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/notice", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		// Mirrors CollabHost#handlePeerOverload: a targeted resync error, then a
		// warning notice. AgentSession#emit dispatches listeners synchronously and
		// `notice` is in the host's wire allowlist, so the notice reaches the queue
		// as a broadcast frame from inside this callback.
		socket.onPeerOverload = peer => {
			shed.push(peer);
			socket.send({ t: "error", message: "the host discarded your backlog; rejoin to resync" }, peer);
			socket.send({ t: "event", event: { type: "notice", level: "warning", message: `peer ${peer} dropped` } });
		};
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// The finding's state: 250 broadcasts, five entries for peer 1, one for
			// peer 2 — a full queue in which peer 1 is well inside its own share.
			for (let i = 0; i < 250; i++) socket.send({ t: "bye", reason: `broadcast ${i}` });
			for (let i = 0; i < 5; i++) socket.send({ t: "error", message: `p1-${i}` }, 1);
			socket.send({ t: "error", message: "p2-0" }, 2);
			socket.sendBatch(welcomeBatch("p1-next"), 1, 0);
			await Bun.sleep(30);

			// Peer 1 broke no rule and asked for the room; reporting peer 2's overload
			// must not cost peer 1 its backlog.
			expect(shed).toContain(2);
			expect(shed).not.toContain(1);
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && ws.sent.filter(b => unpackEnvelope(b)?.peerId === 1).length < 6) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			expect(ws.sent.filter(bytes => unpackEnvelope(bytes)?.peerId === 1).length).toBe(6);
			expect(closeReason).toBeUndefined();
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not shed a bystander the settlement of a report is addressed to", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/settle", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		// The whole of what a report causes, which is more than a reply to the peer
		// being reported. `CollabHost#handlePeerOverload` also settles the asks that
		// peer was holding, and a settle fans `ui-request-end` out to every other
		// writable guest — so a report puts targeted frames on bystanders' queues.
		socket.onPeerOverload = peer => {
			shed.push(peer);
			socket.send({ t: "error", message: "the host discarded your backlog; rejoin to resync" }, peer);
			socket.send({ t: "ui-request-end", reqId: 1 }, BYSTANDER);
			socket.send({ t: "event", event: { type: "notice", level: "warning", message: `peer ${peer} dropped` } });
		};
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// The bystander sits at exactly its share, having broken no rule: the next
			// targeted frame for it is the one that would shed it. Nothing here is
			// near the global budget or the entry cap, so only the per-peer branch can
			// evict — which is the branch the reporting mask did not cover.
			for (let i = 0; i < PEER_SHARE; i++) socket.send({ t: "error", message: `bystander-${i}` }, BYSTANDER);
			for (let i = 0; i <= PEER_SHARE; i++) socket.send({ t: "error", message: `greedy-${i}` }, GREEDY);
			await Bun.sleep(30);

			expect(shed).toEqual([GREEDY]);
			const deadline = Date.now() + 3_000;
			while (
				Date.now() < deadline &&
				ws.sent.filter(b => unpackEnvelope(b)?.peerId === BYSTANDER).length < PEER_SHARE
			) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			// Its backlog is intact: a report may not spend somebody else's share.
			expect(ws.sent.filter(bytes => unpackEnvelope(bytes)?.peerId === BYSTANDER).length).toBe(PEER_SHARE);
			expect(closeReason).toBeUndefined();
		} finally {
			socket.close();
		}
	}, 15_000);

	it("drops an advisory broadcast rather than ending a room full of replica state", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/advisory", role: "host", key: {} as CryptoKey });
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// A full queue of replica state, with no targeted work to shed: the one
			// state in which a broadcast is genuinely the host's own overload.
			for (let i = 0; i < 256; i++) socket.send({ t: "bye", reason: `state ${i}` });
			expect(closeReason).toBeUndefined();

			socket.broadcastAdvisory({ t: "event", event: { type: "notice", level: "info", message: "advisory" } });
			await Bun.sleep(20);
			// The advisory frame is discarded; it must not be what ends the room.
			expect(closeReason).toBeUndefined();
			expect(socket.isOpen).toBe(true);

			// A non-advisory broadcast in the same state still reports the overload.
			socket.send({ t: "bye", reason: "replica state that cannot be dropped" });
			await Bun.sleep(20);
			expect(closeReason).toContain("backlog exceeded");
		} finally {
			socket.close();
		}
	}, 15_000);

	it("never pairs a welcome with chunks built from a different snapshot", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/pair", role: "host", key });
		const welcome = (generation: number, entryCount: number): CollabFrame => ({
			t: "welcome",
			proto: 1,
			header: { type: "session", id: `sess-${generation}`, timestamp: "2026-09-09T00:00:00Z", cwd: "/tmp" },
			state: {} as never,
			agents: [],
			entryCount,
		});
		// One generator per hello, welcome first, exactly as CollabHost enqueues it.
		const pair = (generation: number, chunks: number) =>
			function* (): Generator<CollabFrame> {
				yield welcome(generation, chunks);
				for (let i = 0; i < chunks; i++) {
					yield {
						t: "snapshot-chunk",
						entries: [
							{
								type: "message",
								id: `s${generation}-${i}`,
								parentId: null,
								timestamp: "2026-09-09T00:00:00Z",
								message: { role: "user", content: "x", timestamp: 0 },
							},
						],
						final: i === chunks - 1,
					};
				}
			};
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// First hello, then a saturated queue of advisory broadcasts, then a second
			// hello whose snapshot is longer than the first announced.
			socket.sendBatch(pair(1, 3)(), 7, 0);
			for (let i = 0; i < 254; i++) {
				socket.broadcastAdvisory({
					t: "event",
					event: { type: "notice", level: "info", message: `notice ${i}` },
				} as CollabFrame);
			}
			socket.sendBatch(pair(2, 5)(), 7, 0);

			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && ws.sent.length < 260) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			const toPeer: CollabFrame[] = [];
			for (const bytes of ws.sent) {
				const envelope = unpackEnvelope(bytes);
				if (envelope?.peerId !== 7) continue;
				toPeer.push(await open(key, envelope.payload));
			}
			// Whichever generation wins, the guest must see one welcome followed only
			// by chunks built with it, and exactly as many entries as it promised.
			const welcomes = toPeer.filter(frame => frame.t === "welcome");
			expect(welcomes.length).toBeLessThanOrEqual(1);
			if (welcomes.length === 1) {
				const header = welcomes[0]!;
				if (header.t !== "welcome") throw new Error("expected a welcome frame");
				const generation = header.header.id.replace("sess-", "");
				expect(toPeer[0]).toBe(header);
				const delivered = toPeer
					.filter(frame => frame.t === "snapshot-chunk")
					.flatMap(frame => frame.entries.map(entry => entry.id));
				expect(delivered.every(id => id.startsWith(`s${generation}-`))).toBe(true);
				expect(delivered.length).toBe(header.entryCount);
			}
		} finally {
			socket.close();
		}
	}, 20_000);

	it("drops an incoming advisory rather than evicting a quota-abiding peer", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/cheap", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// Eight peers inside their share, filling the queue with replica work and
			// leaving no advisory backlog to reclaim.
			for (let peer = 1; peer <= 8; peer++) {
				for (let i = 0; i < 32; i++) socket.send({ t: "error", message: `p${peer}-${i}` }, peer);
			}
			socket.broadcastAdvisory({
				t: "event",
				event: { type: "notice", level: "info", message: "someone said hello again" },
			} as CollabFrame);
			await Bun.sleep(30);
			// The notice is classified as safe to lose; it must not buy its admission
			// with somebody else's backlog.
			expect(shed).toEqual([]);
			expect(socket.isOpen).toBe(true);
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline && ws.sent.length < 8 * 32) {
				ws.bufferedAmount = 0;
				await Bun.sleep(20);
			}
			// Every peer's work is still on the wire.
			for (let peer = 1; peer <= 8; peer++) {
				expect(ws.sent.filter(bytes => unpackEnvelope(bytes)?.peerId === peer).length).toBe(32);
			}
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

	it("refunds a discarded batch's whole charge", async () => {
		const gate = Promise.withResolvers<ArrayBuffer>();
		let gated = false;
		vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async () => {
			if (!gated) {
				gated = true;
				return gate.promise;
			}
			return new Uint8Array([1, 2, 3, 4]).buffer;
		});
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/refund", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		const blob = (bytes: number) => "z".repeat(bytes);
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// Head of the queue: a batch holding 4 MiB of snapshot, with its first
			// chunk parked mid-encryption so the discard has to cancel a live entry.
			function* chunks(): Generator<CollabFrame> {
				for (let i = 0; i < 4; i++) yield { t: "error", message: blob(900 * 1024) } as CollabFrame;
			}
			socket.sendBatch(chunks(), 2, 4 * 1024 * 1024);
			for (let flush = 0; flush < 8; flush++) await Promise.resolve();
			// 11 MiB of at-rest work for a peer that is doing nothing wrong.
			for (let i = 0; i < 11; i++) socket.send({ t: "error", message: blob(1024 * 1024) } as CollabFrame, 1);
			await Bun.sleep(10);

			expect(socket.dropPeer(2)).toBe(1);
			// Real free capacity is now ~5 MiB, so this fits. Leaving the discarded
			// batch's charge on the books would read as over budget and either drop
			// this frame or cost peer 1 its backlog.
			socket.send({ t: "error", message: blob(4 * 1024 * 1024) } as CollabFrame, 3);
			// Admission already happened; releasing the parked chunk only lets the
			// queue drain so the admitted frame can be observed on the wire.
			gate.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
			await waitUntil(
				() => BackpressuredWebSocket.instances[0]!.sent.some(bytes => unpackEnvelope(bytes)?.peerId === 3),
				"the frame admitted against the refunded capacity never reached the wire",
			);
			expect(shed).toEqual([]);
			expect(closeReason).toBeUndefined();
		} finally {
			gate.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
			socket.close();
		}
	}, 15_000);

	it("does not let a peer's own responses evict a quota-abiding peer", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/spam", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// Eight peers inside their share own the whole queue.
			for (let peer = 1; peer <= 8; peer++) {
				for (let i = 0; i < 32; i++) socket.send({ t: "error", message: `p${peer}-${i}` }, peer);
			}
			// A ninth peer spams requests. Each reply is an ordinary targeted response
			// it asked for, not a join, so it must not buy room with anyone's backlog.
			// Repeating the cycle is what would otherwise walk the whole room.
			for (let round = 0; round < 40; round++) {
				socket.send({ t: "error", message: `reply ${round}` }, 9);
				await Bun.sleep(1);
			}
			expect(shed.filter(peer => peer >= 1 && peer <= 8)).toEqual([]);
			for (let peer = 1; peer <= 8; peer++) {
				expect(ws.sent.filter(bytes => unpackEnvelope(bytes)?.peerId === peer).length).toBe(0);
			}
			// The reservation still exists for the frame it is for.
			socket.sendBatch(welcomeBatch("a real newcomer"), 10, 0);
			await Bun.sleep(20);
			expect(shed.some(peer => peer >= 1 && peer <= 8)).toBe(true);
		} finally {
			socket.close();
		}
	}, 20_000);

	it("does not starve the event loop while shedding to admit newcomers", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/fairspin", role: "host", key: {} as CryptoKey });
		let closeReason: string | undefined;
		socket.onClose = reason => {
			closeReason = reason;
		};
		let timerFired = false;
		let overloads = 0;
		let timerFiredInsideLoop: boolean | undefined;
		// Mirrors CollabHost#handlePeerOverload, whose reply is the frame that could
		// make reports feed sheds feed reports.
		const LOOP_BOUND = 2_000;
		socket.onPeerOverload = peer => {
			overloads++;
			if (overloads >= LOOP_BOUND) {
				timerFiredInsideLoop ??= timerFired;
				return;
			}
			socket.send({ t: "error", message: "rejoin to resync" }, peer);
		};
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// Many peers holding one entry each: every shed frees a single slot, the
			// shape that would let a report chain into the next shed.
			for (let peer = 1; peer <= 256; peer++) socket.send({ t: "error", message: `p${peer}` }, peer);
			setTimeout(() => {
				timerFired = true;
			}, 0);
			for (let peer = 300; peer < 320; peer++) socket.send({ t: "error", message: `new ${peer}` }, peer);
			await Bun.sleep(50);

			expect(overloads).toBeLessThan(LOOP_BOUND);
			expect(timerFiredInsideLoop).toBeUndefined();
			expect(timerFired).toBe(true);
			expect(closeReason).toBeUndefined();
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

	it("does not report a reply captured before the relay recreated the room", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/capture", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			const stillTheAsker = socket.addressee(4);
			expect(socket.isServing(4)).toBe(true);

			// A transient drop destroys the room and the next one issues ids from 1
			// again, so peer 4 is a different client and no record says so.
			first.close();
			await waitUntil(
				() => BackpressuredWebSocket.instances.length > 1,
				"socket never retried after the transient drop",
			);
			BackpressuredWebSocket.instances[1]!.open();

			expect(socket.isServing(4)).toBe(true);
			expect(stillTheAsker()).toBe(false);
			// Captures taken in the room that is actually open still resolve.
			expect(socket.addressee(4)()).toBe(true);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not report a reply for a peer whose retirement its own release evicted", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/evict", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// One reply outstanding per departed peer, one past the cap, so every
			// record is protected and the trim cannot get the map back under it.
			const captures: (() => boolean)[] = [];
			for (let peer = 1; peer <= RETIREMENT_CAP + 1; peer++) captures.push(socket.addressee(peer));
			for (let peer = 1; peer <= RETIREMENT_CAP + 1; peer++) {
				ws.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}
			await Bun.sleep(20);

			// The socket knows peer 1 is gone, so releasing the capture that was
			// holding its record must not be what makes the reply admissible: the
			// release is what unprotects the record the answer turns on.
			expect(socket.isServing(1)).toBe(false);
			expect(captures[0]!()).toBe(false);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not let an old room's release unprotect the new room's capture", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/rooms", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			const first = BackpressuredWebSocket.instances[0]!;
			first.open();
			const stale = socket.addressee(1);

			// The room is recreated and peer 1 is reissued to somebody else, who asks
			// for a transcript of their own.
			first.close();
			await waitUntil(
				() => BackpressuredWebSocket.instances.length > 1,
				"socket never retried after the transient drop",
			);
			const second = BackpressuredWebSocket.instances[1]!;
			second.open();
			const fresh = socket.addressee(1);

			// Releasing the old room's capture is correct to refuse, but it must not
			// spend the new capture's protection doing it.
			expect(stale()).toBe(false);

			second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 1 }) } as MessageEvent);
			for (let peer = 2; peer <= RETIREMENT_CAP + 44; peer++) {
				second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}
			await Bun.sleep(20);

			expect(socket.isServing(1)).toBe(false);
			expect(fresh()).toBe(false);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not report a reply captured before the socket was closed and reopened", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/reopen", role: "host", key: {} as CryptoKey });
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			const leased = socket.addressee(4);
			const bestEffort = socket.bestEffortAddressee(4);

			// Explicit reuse rather than a transient drop. The relay this comes back
			// to hands out ids from 1 the same way, so peer 4 is a different client.
			socket.close();
			socket.connect();
			BackpressuredWebSocket.instances[1]!.open();

			expect(leased()).toBe(false);
			expect(bestEffort()).toBe(false);

			// And the closed room's lease is gone rather than left holding an id in
			// the reopened one. A lease makes `#trimRetired` skip its record, so a
			// leaked one pins that record for the socket's lifetime — and while it
			// stands, the peer the relay reissued the id to is never served at all.
			const second = BackpressuredWebSocket.instances[1]!;
			second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: 4 }) } as MessageEvent);
			for (let peer = 5; peer <= RETIREMENT_CAP + 50; peer++) {
				second.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer }) } as MessageEvent);
			}
			await Bun.sleep(20);
			expect(socket.isServing(4)).toBe(true);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("does not report an overload into a room the socket reopened first", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/late", role: "host", key: {} as CryptoKey });
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// Shed a peer, then reopen before the deferred report can run: everything
			// here is synchronous, so the microtask lands in the new room.
			for (let i = 0; i <= PEER_SHARE; i++) socket.send({ t: "error", message: `p1-${i}` }, 1);
			socket.close();
			socket.connect();
			BackpressuredWebSocket.instances[1]!.open();
			await Bun.sleep(20);

			// Reporting it now would tell the owner to drop peer 1 — an id the relay
			// has just reissued to somebody who has done nothing wrong.
			expect(shed).toEqual([]);
			expect(socket.isServing(1)).toBe(true);
		} finally {
			socket.close();
		}
	}, 15_000);

	it("charges a lazy batch for the snapshot it keeps reachable", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/retained", role: "host", key: {} as CryptoKey });
		let reason: string | undefined;
		socket.onClose = message => {
			reason = message;
		};
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		let generated = 0;
		function* chunks(): Generator<CollabFrame> {
			generated++;
			yield { t: "snapshot-chunk", entries: [], final: true };
		}
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// Each batch declares 8 MB of snapshot held behind its iterator. Two fit
			// the budget; the third cannot, and nothing has been serialized yet, so
			// only what the queue is keeping alive can account for the shed that
			// makes room for it.
			socket.sendBatch(chunks(), 7, 8 * 1024 * 1024);
			socket.sendBatch(chunks(), 8, 8 * 1024 * 1024);
			expect(shed).toEqual([]);
			socket.sendBatch(chunks(), 9, 8 * 1024 * 1024);
			// The shed itself is synchronous; its report is deferred so the owner
			// cannot refill the queue mid-shed.
			for (let flush = 0; flush < 4; flush++) await Promise.resolve();
			expect(shed).toEqual([7]);
			expect(reason).toBeUndefined();
			expect(generated).toBe(0);
		} finally {
			socket.close();
		}
	});

	it("delivers a snapshot larger than the whole send budget", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = 0;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/oversized", role: "host", key });
		let reason: string | undefined;
		socket.onClose = message => {
			reason = message;
		};
		function* chunks(): Generator<CollabFrame> {
			for (let i = 0; i < 3; i++) yield { t: "snapshot-chunk", entries: [], final: i === 2 };
		}
		try {
			socket.connect();
			const ws = BackpressuredWebSocket.instances[0]!;
			ws.open();
			// A session bigger than the budget still has to be shareable: with an
			// empty queue there is nothing to protect, and admitting it is the only
			// way the guest ever gets a replica.
			socket.sendBatch(chunks(), 7, 64 * 1024 * 1024);
			const deadline = Date.now() + 3_000;
			while (ws.sent.length < 3 && Date.now() < deadline) {
				ws.bufferedAmount = 0;
				await Bun.sleep(10);
			}
			expect(ws.sent).toHaveLength(3);
			expect(reason).toBeUndefined();
		} finally {
			socket.close();
		}
	});

	it("keeps admitting live traffic behind an oversized snapshot, and still sheds its peer for a flood", async () => {
		BackpressuredWebSocket.instances = [];
		BackpressuredWebSocket.initialBufferedAmount = HIGH_WATER_MARK;
		globalThis.WebSocket = BackpressuredWebSocket as unknown as typeof WebSocket;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/oversized-live",
			role: "host",
			key: {} as CryptoKey,
		});
		let reason: string | undefined;
		socket.onClose = message => {
			reason = message;
		};
		const shed: number[] = [];
		socket.onPeerOverload = peer => shed.push(peer);
		try {
			socket.connect();
			BackpressuredWebSocket.instances[0]!.open();
			// Past the whole budget with nothing ahead of it, so only the floor admits
			// it — and its charge is then excluded, or the queue reads as over capacity
			// for the entire drain and the next replica-bearing broadcast evicts the
			// peer the floor just admitted it for.
			socket.sendBatch(welcomeBatch("oversized snapshot"), GREEDY, 64 * 1024 * 1024);
			expect(socket.send({ t: "entry", entry: { id: "live" } } as unknown as CollabFrame)).toBe(true);
			expect(shed).toEqual([]);

			// The exclusion is on bytes alone. A peer's share is an entry count and the
			// batch is one of its entries, so its own flood still reaches the cap.
			for (let i = 0; i < PEER_SHARE - 1; i++) {
				expect(socket.send({ t: "error", message: `reply ${i}` }, GREEDY)).toBe(true);
			}
			expect(shed).toEqual([]);
			expect(socket.send({ t: "error", message: "one past the share" }, GREEDY)).toBe(false);
			for (let flush = 0; flush < 4; flush++) await Promise.resolve();
			expect(shed).toEqual([GREEDY]);
			expect(reason).toBeUndefined();
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
			socket.sendBatch(chunks(), 7, 0);
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
			for (let flush = 0; flush < SETTLE_TURNS; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			for (let flush = 0; flush < SETTLE_TURNS; flush++) await Promise.resolve();
			expect(ws.sent).toHaveLength(0);

			ws.bufferedAmount = 0;
			vi.advanceTimersByTime(DRAIN_RETRY_MS);
			// Positive condition rather than a turn count: the send only has to happen,
			// and how many microtasks the pipeline takes to get there is not the point.
			await flushUntil(() => ws.sent.length === 1, "the queued frame never reached the drained transport");
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
