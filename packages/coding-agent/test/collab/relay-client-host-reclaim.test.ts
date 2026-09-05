import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { COLLAB_PROTO, ENVELOPE_HEADER_LENGTH, packEnvelope, unpackEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HOST_CONFLICT_REASON = "a host is already connected for this room";
const RECLAIM_RETRY_REASON = "relay has not released the previous host yet";
const RECLAIM_WINDOW_MS = 120_000;
const LEG_SETTLE_MS = 2_000;
/** Backoff jitter is `0.75 + Math.random() * 0.5`: 0 pins the shortest ladder, 0.5 the base, 1 the longest. */
const JITTER_SHORTEST = 0;
const JITTER_NEUTRAL = 0.5;
const JITTER_LONGEST = 1;
/** Mirrors MAX_PENDING_SENDS in the client. */
const PENDING_SEND_LIMIT = 256;
/** Mirrors MAX_HELD_CONTROL_BYTES in the client. */
const HOLD_CONTROL_LIMIT = 8 * 1024 * 1024;
/** Mirrors MAX_HELD_PEER_BYTES in the client. */
const HOLD_PEER_BYTES_LIMIT = 8 * 1024 * 1024;
/** Mirrors HELD_STREAM_FLOOR_BYTES: what a stream may hold whatever the room is doing. */
const HOLD_STREAM_FLOOR = 64 * 1024;
/** What a stream past its floor competes for: the peer budget less HELD_FLOOR_RESERVE_BYTES. */
const HOLD_COMPETE_LIMIT = HOLD_PEER_BYTES_LIMIT - 1024 * 1024;
/** Payload size that makes a handful of held frames exceed what a stream competes for. */
const FAT_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Mirrors HELD_INBOUND_SLOT_BYTES in the client. */
const HOLD_SLOT_BYTES = 256;
/** Mirrors WS_BACKPRESSURE_DRAIN_RETRY_MS in the client. */
const BACKPRESSURE_RETRY_MS = 25;
/** Target peer of the frame standing in for a rejoining guest's welcome. */
const REJOIN_PEER = 7;
/** A guest that speaks after the hold already refused a message. */
const LATE_GUEST = 9;
/** A peer that spends its whole share of the hold on small frames. */
const FLOOD_PEER = 30;

/** Stand-in plaintext for an inbound guest frame; `open()` only needs valid frame JSON. */
const HELLO_PAYLOAD = new TextEncoder().encode(JSON.stringify({ t: "bye", reason: "hello stand-in" })).buffer;

/** Relay leg the tests drive by hand; InMemoryRelay models no host conflict, so it cannot be reused. */
class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	/** Newest leg the client opened: the one the relay would answer. */
	static get latest(): ScriptedWebSocket {
		const leg = ScriptedWebSocket.instances.at(-1);
		if (!leg) throw new Error("CollabSocket did not construct a WebSocket");
		return leg;
	}

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount = 0;
	sent: Uint8Array[] = [];
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string) {
		this.url = url;
		ScriptedWebSocket.instances.push(this);
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	/** Real Bun passes through CLOSING: the close frame is seen a task before onclose dispatches. */
	beginClosing(): void {
		this.readyState = ScriptedWebSocket.CLOSING;
	}

	/**
	 * The relay routing a guest's frame to us is the only way a peer id becomes
	 * addressable, so a test that sends to one has to let it speak first.
	 */
	introducePeer(peer: number): void {
		this.onmessage?.({ data: packEnvelope(peer, new Uint8Array(32)).buffer } as MessageEvent);
	}

	closeWith(code: number, reason: string): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.({ code, reason } as CloseEvent);
	}

	/** Relay leg that still holds the previous registration: it upgrades first, then closes 4009. */
	rejectAsHostConflict(): void {
		this.open();
		this.closeWith(4009, HOST_CONFLICT_REASON);
	}

	close(code = 1000): void {
		this.closeWith(code, "closed");
	}
}

interface SocketHarness {
	socket: CollabSocket;
	closes: { reason: string; willReconnect: boolean }[];
	opens: string[];
	reconnects: string[];
}

function startSocket(role: "host" | "guest"): SocketHarness {
	const closes: { reason: string; willReconnect: boolean }[] = [];
	const opens: string[] = [];
	const reconnects: string[] = [];
	const socket = new CollabSocket({
		wsUrl: "ws://localhost:8788/r/reclaim",
		role,
		key: {} as CryptoKey,
	});
	socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
	socket.onOpen = () => opens.push("open");
	socket.onReconnect = () => reconnects.push("reconnected");
	socket.connect();
	return { socket, closes, opens, reconnects };
}

/** Models a relay that never releases the room: reject every reconnect until the client gives up. */
function rejectUntilFatal(closes: { willReconnect: boolean }[]): { attempts: number; elapsedMs: number } {
	const startInstances = ScriptedWebSocket.instances.length;
	let attempts = 0;
	let elapsedMs = 0;
	while (elapsedMs < 600_000 && !closes.some(close => !close.willReconnect)) {
		vi.advanceTimersByTime(50);
		elapsedMs += 50;
		const created = ScriptedWebSocket.instances.length - startInstances;
		if (created > attempts) {
			attempts = created;
			ScriptedWebSocket.latest.rejectAsHostConflict();
		}
	}
	return { attempts, elapsedMs };
}

describe("CollabSocket host room reclaim", () => {
	beforeEach(() => {
		ScriptedWebSocket.instances = [];
		vi.useFakeTimers();
		globalThis.WebSocket = ScriptedWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("treats a cold-connect 4009 as fatal", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes } = startSocket("host");
		try {
			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(closes).toEqual([{ reason: HOST_CONFLICT_REASON, willReconnect: false }]);
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			expect(ScriptedWebSocket.instances).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("retries 4009 after an established socket died, then announces the reclaimed room", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			expect(closes).toEqual([{ reason: "Connection ended", willReconnect: true }]);

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);

			for (const delayMs of [1_000, 2_000, 4_000]) {
				ScriptedWebSocket.latest.rejectAsHostConflict();
				vi.advanceTimersByTime(delayMs);
			}
			expect(ScriptedWebSocket.instances).toHaveLength(5);
			expect(closes.filter(close => !close.willReconnect)).toEqual([]);
			expect(closes.slice(1).map(close => close.reason)).toEqual([
				RECLAIM_RETRY_REASON,
				RECLAIM_RETRY_REASON,
				RECLAIM_RETRY_REASON,
			]);
			// Each rejected socket fired onopen; none of them may announce a reconnect.
			expect(reconnects).toEqual([]);

			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS - 1);
			expect(reconnects).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(reconnects).toEqual(["reconnected"]);
		} finally {
			socket.close();
		}
	});

	it("backs off exponentially across 4009 rejections even though each one fires onopen", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);

			let expectedSockets = 2;
			for (const delayMs of [1_000, 2_000, 4_000]) {
				ScriptedWebSocket.latest.rejectAsHostConflict();
				vi.advanceTimersByTime(delayMs - 1);
				expect(ScriptedWebSocket.instances).toHaveLength(expectedSockets);
				vi.advanceTimersByTime(1);
				expectedSockets++;
				expect(ScriptedWebSocket.instances).toHaveLength(expectedSockets);
			}
		} finally {
			socket.close();
		}
	});

	it("gives up on 4009 once the reclaim window is spent, without hammering the relay", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_LONGEST);
		const expired = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			// Relay silent for longer than the window, so the next 4009 is a real host conflict.
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS + 1);
			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(expired.closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
		} finally {
			expired.socket.close();
		}

		const stuck = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");

			// A relay that keeps rejecting must exhaust the window, not retry forever. Retries
			// are clamped to the deadline, so the last one lands on it rather than past it.
			const { attempts, elapsedMs } = rejectUntilFatal(stuck.closes);
			expect(attempts).toBeLessThan(10);
			expect(elapsedMs).toBeGreaterThanOrEqual(RECLAIM_WINDOW_MS);
			expect(stuck.closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });

			const socketsAtGiveUp = ScriptedWebSocket.instances.length;
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			expect(ScriptedWebSocket.instances).toHaveLength(socketsAtGiveUp);
		} finally {
			stuck.socket.close();
		}
	});

	it("fails a guest immediately on 4009 even after an established socket died", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes } = startSocket("guest");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);

			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(closes).toEqual([
				{ reason: "Connection ended", willReconnect: true },
				{ reason: HOST_CONFLICT_REASON, willReconnect: false },
			]);
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
		} finally {
			socket.close();
		}
	});

	it("holds queued frames until the reclaim leg survives the relay's policy window", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			socket.send({ t: "bye", reason: "queued while reconnecting" });
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const rejected = ScriptedWebSocket.latest;
			rejected.rejectAsHostConflict();
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			// The rejected leg opened, so draining into it would have consumed the backlog
			// and left the reclaimed room with nothing to replay.
			expect(rejected.sent).toEqual([]);

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(reclaimed.sent).toEqual([]);

			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			expect(reclaimed.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("renews the reclaim window only from a leg the relay kept", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const preOpen = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS + 1);
			// A retry leg that dies before onopen never held the room: it must not push the
			// deadline forward, or alternating drops and 4009s would reclaim forever.
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(2_000);
			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(preOpen.closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });
		} finally {
			preOpen.socket.close();
		}

		const provisional = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			// Same for a leg that reached onopen but died before its settle window closed.
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS - 1);
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			expect(provisional.reconnects).toEqual([]);

			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(provisional.closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });
		} finally {
			provisional.socket.close();
		}
	});

	it("keeps retrying to the deadline on the shortest jitter without hammering the relay", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_SHORTEST);
		const { socket, closes } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");

			const legTimes: number[] = [];
			let elapsedMs = 0;
			let seen = ScriptedWebSocket.instances.length;
			while (elapsedMs <= RECLAIM_WINDOW_MS && !closes.some(close => !close.willReconnect)) {
				if (ScriptedWebSocket.instances.length > seen) {
					seen = ScriptedWebSocket.instances.length;
					legTimes.push(elapsedMs);
					ScriptedWebSocket.latest.rejectAsHostConflict();
					continue;
				}
				vi.advanceTimersByTime(50);
				elapsedMs += 50;
			}

			// Shortest jitter is the densest ladder the window can produce: it still fits in
			// ten attempts, the last retry lands exactly on the deadline, and the 4009 that
			// comes back from it is fatal because the window is spent.
			expect(legTimes.filter(at => at < RECLAIM_WINDOW_MS).length).toBeLessThanOrEqual(10);
			expect(legTimes.at(-1)).toBe(RECLAIM_WINDOW_MS);
			expect(closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });
		} finally {
			socket.close();
		}
	});

	it("clamps a conflict retry that would overshoot the reclaim deadline", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");

			const legTimes: number[] = [];
			let elapsedMs = 0;
			let seen = ScriptedWebSocket.instances.length;
			while (elapsedMs <= RECLAIM_WINDOW_MS && !closes.some(close => !close.willReconnect)) {
				if (ScriptedWebSocket.instances.length > seen) {
					seen = ScriptedWebSocket.instances.length;
					legTimes.push(elapsedMs);
					ScriptedWebSocket.latest.rejectAsHostConflict();
					continue;
				}
				vi.advanceTimersByTime(50);
				elapsedMs += 50;
			}

			// On neutral jitter the eighth conflict lands at 92s and the next 30s step would
			// open at 122s, past the deadline, leaving the last 28s of the window unprobed.
			expect(legTimes.filter(at => at < RECLAIM_WINDOW_MS)).toEqual([
				1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 62_000, 92_000,
			]);
			expect(legTimes.at(-1)).toBe(RECLAIM_WINDOW_MS);
			expect(closes.at(-1)).toEqual({ reason: HOST_CONFLICT_REASON, willReconnect: false });
		} finally {
			socket.close();
		}
	});

	it("keeps reclaiming when the relay's 4009 lands after the settle window", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);

			const late = ScriptedWebSocket.latest;
			late.open();
			// Surviving the settle window is a send/notify heuristic, not an acknowledgement:
			// on a degraded path the rejection can still be in flight.
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			expect(reconnects).toEqual(["reconnected"]);

			late.closeWith(4009, HOST_CONFLICT_REASON);

			expect(closes.at(-1)).toEqual({ reason: RECLAIM_RETRY_REASON, willReconnect: true });
			const legsBefore = ScriptedWebSocket.instances.length;
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(legsBefore + 1);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			expect(reconnects).toEqual(["reconnected", "reconnected"]);
		} finally {
			socket.close();
		}
	});

	it("answers nobody while the leg is provisional, then replies once it is real", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			socket.send({ t: "bye", reason: "entry appended during the outage" });
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// The relay routes a rejoining guest's hello onto the provisional leg. Nothing
			// answers it there: the leg can still be rejected with 4009, and a welcome sent
			// across it would die with the leg while promising the guest a snapshot.
			reclaimed.introducePeer(REJOIN_PEER);
			socket.send({ t: "bye", reason: "reply nobody asked for yet" }, REJOIN_PEER);
			for (let tick = 0; tick < 200; tick++) await Promise.resolve();
			expect(reclaimed.sent).toEqual([]);

			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 200; tick++) await Promise.resolve();

			// The outage backlog flushes, and the held hello reaches the session only now —
			// so this is where the id becomes addressable and the reply goes out.
			socket.send({ t: "bye", reason: "welcome on a leg that holds the room" }, REJOIN_PEER);
			for (let tick = 0; tick < 200; tick++) await Promise.resolve();

			const peers = reclaimed.sent.map(envelope => unpackEnvelope(envelope)?.peerId);
			expect(peers).toEqual([0, REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});

	it("drops the inbound a rejected leg held instead of replaying it onto the next one", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const rejected = ScriptedWebSocket.latest;
			rejected.open();
			rejected.introducePeer(REJOIN_PEER);
			// Nothing reaches the session while the leg is provisional, not even once the
			// chain has had every chance to run.
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);
			// 4009: this leg never held the room, so every id it heard from belongs to a
			// registration the relay is about to hand out again from 1.
			rejected.rejectAsHostConflict();
			vi.advanceTimersByTime(1_000);
			const next = ScriptedWebSocket.latest;
			next.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 200; tick++) await Promise.resolve();

			expect(next).not.toBe(rejected);
			expect(inbound).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("never sends a directed frame on a leg that did not mint its peer id", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			// A reply to a guest of this room generation loses its race with the drop: the
			// relay frees the room and hands the same peer id to whoever connects next, so
			// this envelope must never reach the wire.
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			socket.send({ t: "bye", reason: "reply to a guest of the dead room" }, REJOIN_PEER);
			socket.send({ t: "bye", reason: "session event" });
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			const peers = reclaimed.sent.map(envelope => unpackEnvelope(envelope)?.peerId);
			expect(peers).toEqual([0]);
		} finally {
			socket.close();
		}
	});

	it("refuses inbound past the hold's byte ceiling and replays the prefix it kept", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// The ceiling is on bytes, not messages, so what it turns away is a peer pushing
			// megabytes into the settle window — never the handful of small frames a whole
			// room's rejoin costs. What it keeps stays an ordered prefix: a message delivered
			// after a dropped predecessor is what has the session act on a guest it was never
			// introduced to.
			const envelopes = Array.from({ length: 8 }, (_, index) =>
				packEnvelope(index + 1, new Uint8Array(FAT_PAYLOAD_BYTES)),
			);
			const charge = (envelopes[0]?.buffer.byteLength ?? 0) + HOLD_SLOT_BYTES;
			const fits = Math.floor(HOLD_COMPETE_LIMIT / charge);
			for (const envelope of envelopes) reclaimed.onmessage?.({ data: envelope.buffer } as MessageEvent);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(fits).toBeLessThan(envelopes.length);
			expect(inbound).toEqual(Array.from({ length: fits }, (_, index) => index + 1));
		} finally {
			socket.close();
		}
	});

	it("keeps holding a whole room's rejoin, far short of the ceiling", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const controls: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		socket.onControl = msg => controls.push(msg.t === "peer-left" ? -1 : 1);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// The traffic a reclaim really produces: the relay 4001'd the room, so every guest
			// rejoins at once with a peer-joined and a hello. None of it may be refused — a
			// dropped hello leaves that guest waiting on a welcome nothing will re-request.
			const guests = 400;
			for (let peer = 1; peer <= guests; peer++) {
				reclaimed.onmessage?.({ data: JSON.stringify({ t: "peer-joined", peer }) } as MessageEvent);
				reclaimed.introducePeer(peer);
			}
			// Held, not answered: the leg can still be rejected, and the room is what the hold
			// has to carry across the settle without refusing any of it.
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);
			expect(controls).toEqual([]);

			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			expect(inbound).toEqual(Array.from({ length: guests }, (_, index) => index + 1));
			expect(controls).toHaveLength(guests);
		} finally {
			socket.close();
		}
	});

	it("refuses a frame that overruns the send buffer instead of leaving a gap", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const { socket } = startSocket("host");
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			for (let peer = 1; peer <= PENDING_SEND_LIMIT + 4; peer++) leg.introducePeer(peer);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			// A guest that stopped reading: everything spills into the buffer. Past its bound
			// the arrival is refused rather than evicting from the queue, so what ships stays
			// the ordered prefix the session emitted — a hole in a replicated entry stream
			// leaves every replica silently wrong, a missing tail is refilled by the next
			// rejoin snapshot.
			leg.bufferedAmount = 1_000_000;
			for (let peer = 1; peer <= PENDING_SEND_LIMIT + 4; peer++) {
				socket.send({ t: "bye", reason: `reply ${peer}` }, peer);
			}
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();
			expect(leg.sent).toEqual([]);

			leg.bufferedAmount = 0;
			vi.advanceTimersByTime(BACKPRESSURE_RETRY_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			const peers = leg.sent.map(envelope => unpackEnvelope(envelope)?.peerId);
			expect(peers).toHaveLength(PENDING_SEND_LIMIT);
			expect(peers[0]).toBe(1);
			expect(peers.at(-1)).toBe(PENDING_SEND_LIMIT);
		} finally {
			socket.close();
		}
	});

	it("refuses a broadcast that overruns the send buffer too", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		let tag = 0;
		vi.spyOn(crypto.subtle, "encrypt").mockImplementation(() =>
			Promise.resolve(new Uint8Array([tag++, 0, 0, 0]).buffer),
		);
		const { socket } = startSocket("host");
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			// Session entries are broadcasts, and they are what actually fills the buffer when
			// the relay stops reading. The bound is on the buffer, not on who a frame is for,
			// and it refuses the arrival: evicting instead would ship a queue that starts
			// after the entry the guest last saw.
			leg.bufferedAmount = 1_000_000;
			for (let entry = 0; entry < PENDING_SEND_LIMIT + 4; entry++) {
				socket.send({ t: "bye", reason: `entry ${entry}` });
			}
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();
			expect(leg.sent).toEqual([]);

			leg.bufferedAmount = 0;
			vi.advanceTimersByTime(BACKPRESSURE_RETRY_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			expect(leg.sent).toHaveLength(PENDING_SEND_LIMIT);
			const tags = leg.sent.map(envelope => unpackEnvelope(envelope)?.payload.at(-4));
			expect(tags[0]).toBe(0);
			expect(tags.at(-1)).toBe(PENDING_SEND_LIMIT - 1);
		} finally {
			socket.close();
		}
	});

	it("renews the reclaim window on every accepted drop, not just the first", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, closes, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			expect(reconnects).toEqual(["reconnected"]);

			// The reclaimed leg serves the session until just before the first window would
			// have expired, then dies half-open: its own window has to start from there, or
			// every outage after the first two minutes is unreclaimable.
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS - LEG_SETTLE_MS - 2_000);
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.rejectAsHostConflict();

			expect(closes.at(-1)).toEqual({ reason: RECLAIM_RETRY_REASON, willReconnect: true });
		} finally {
			socket.close();
		}
	});

	it("restarts the conflict ladder after a reclaimed leg drops again", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.rejectAsHostConflict();
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			expect(reconnects).toEqual(["reconnected"]);

			// A fresh outage must probe at the base step again instead of inheriting the
			// ladder the previous reclaim had climbed.
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.rejectAsHostConflict();
			const legs = ScriptedWebSocket.instances.length;
			vi.advanceTimersByTime(999);
			expect(ScriptedWebSocket.instances).toHaveLength(legs);
			vi.advanceTimersByTime(1);
			expect(ScriptedWebSocket.instances).toHaveLength(legs + 1);
		} finally {
			socket.close();
		}
	});

	it("restarts the transient ladder once a leg is accepted", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");

			const legs = ScriptedWebSocket.instances.length;
			vi.advanceTimersByTime(999);
			expect(ScriptedWebSocket.instances).toHaveLength(legs);
			vi.advanceTimersByTime(1);
			expect(ScriptedWebSocket.instances).toHaveLength(legs + 1);
		} finally {
			socket.close();
		}
	});

	it("keeps growing the conflict ladder across accepted legs", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			// Late rejection: the leg settled, so acceptance must not refill the ladder, or
			// an accept → late-4009 loop reconnects on a fixed short cycle for the whole window.
			ScriptedWebSocket.latest.closeWith(4009, HOST_CONFLICT_REASON);
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			expect(reconnects).toEqual(["reconnected", "reconnected"]);
			ScriptedWebSocket.latest.closeWith(4009, HOST_CONFLICT_REASON);

			const legs = ScriptedWebSocket.instances.length;
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(legs);
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(legs + 1);
		} finally {
			socket.close();
		}
	});

	it("withholds onOpen until the provisional leg settles", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket, opens } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			expect(opens).toHaveLength(1);
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			ScriptedWebSocket.latest.open();

			vi.advanceTimersByTime(LEG_SETTLE_MS - 1);
			expect(opens).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(opens).toHaveLength(2);
		} finally {
			socket.close();
		}
	});

	it("accepts a guest reconnect leg immediately", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const { socket, opens } = startSocket("guest");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const leg = ScriptedWebSocket.latest;
			leg.open();

			// A guest can never be rejected with 4009, so deferring its hello by the settle
			// window would only delay the rejoin.
			expect(opens).toHaveLength(2);
			socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
			expect(leg.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("does not promote a leg that entered CLOSING before its settle window ended", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const { socket, reconnects } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			socket.send({ t: "bye", reason: "queued while reconnecting" });
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const leg = ScriptedWebSocket.latest;
			leg.open();
			// The relay's close frame lands before onclose dispatches, which is the window
			// where Bun reports CLOSING and a send would buffer without ever flushing.
			leg.beginClosing();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();

			expect(reconnects).toEqual([]);
			expect(leg.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("holds a provisional leg's inbound until it settles, in one arrival order", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(
			new TextEncoder().encode(JSON.stringify({ t: "hello", proto: COLLAB_PROTO, name: "guest" })).buffer,
		);
		const events: string[] = [];
		const { socket, reconnects } = startSocket("host");
		socket.onFrame = (frame, fromPeer) => events.push(`frame:${frame.t}:${fromPeer}`);
		socket.onControl = msg => events.push(`control:${msg.t}`);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const leg = ScriptedWebSocket.latest;
			leg.open();
			expect(reconnects).toEqual([]);

			leg.onmessage?.({ data: packEnvelope(REJOIN_PEER, new Uint8Array(32)).buffer } as MessageEvent);
			leg.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();
			expect(events).toEqual([]);

			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();

			// Frames decrypt on a chain while control messages parse synchronously, so the
			// two share one order: told that a guest left before hearing from it, the session
			// would put it back in the participant list and address an id that is gone.
			expect(events).toEqual([`frame:hello:${REJOIN_PEER}`, "control:peer-left"]);
			socket.send({ t: "bye", reason: "after the guest left" }, REJOIN_PEER);
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();
			expect(leg.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("arms no timer past close() during a provisional leg", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket } = startSocket("host");
		ScriptedWebSocket.latest.open();
		ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
		vi.advanceTimersByTime(1_000);
		ScriptedWebSocket.latest.open();

		socket.close();

		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops a frame sealed across a close instead of refilling the buffer", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const seal = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "encrypt").mockReturnValue(seal.promise);
		const { socket } = startSocket("host");
		ScriptedWebSocket.latest.open();
		socket.send({ t: "bye", reason: "sealed across the close" });
		// The send is parked inside seal(), so it resumes after close() emptied the buffer.
		for (let tick = 0; tick < 5; tick++) await Promise.resolve();
		socket.close();
		seal.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();

		socket.connect();
		const revived = ScriptedWebSocket.latest;
		revived.open();
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();

		expect(revived.sent).toEqual([]);
		socket.close();
	});

	it("caps a transient retry at the reclaim deadline too", () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const { socket } = startSocket("host");
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");

			// A flapping path: every retry leg dies before it opens, so the transient ladder
			// climbs while the window runs. Its last step must land on the deadline, not past
			// it, or the stretch where the relay has usually released the room goes unprobed.
			const legTimes: number[] = [];
			let elapsedMs = 0;
			let seen = ScriptedWebSocket.instances.length;
			while (elapsedMs <= RECLAIM_WINDOW_MS) {
				if (ScriptedWebSocket.instances.length > seen) {
					seen = ScriptedWebSocket.instances.length;
					legTimes.push(elapsedMs);
					ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
					continue;
				}
				vi.advanceTimersByTime(50);
				elapsedMs += 50;
			}

			expect(legTimes).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000, RECLAIM_WINDOW_MS]);
		} finally {
			socket.close();
		}
	});

	it("stops addressing a peer the relay reports as gone", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const { socket } = startSocket("host");
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			leg.introducePeer(REJOIN_PEER);
			socket.send({ t: "bye", reason: "while the guest is here" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
			expect(leg.sent).toHaveLength(1);

			leg.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			socket.send({ t: "bye", reason: "after the guest left" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(leg.sent).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("retires a departed peer id even while an earlier frame is still decrypting", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const pendingOpen = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(pendingOpen.promise);
		const { socket } = startSocket("host");
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			leg.introducePeer(REJOIN_PEER);
			// The relay reports the guest gone while its first frame is still inside open().
			// Addressability is a send-time gate, so the id has to stop being addressable now,
			// not whenever the decryption queued ahead of it finishes.
			leg.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			socket.send({ t: "bye", reason: "reply to a guest that already left" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(leg.sent).toEqual([]);
		} finally {
			pendingOpen.resolve(HELLO_PAYLOAD);
			socket.close();
		}
	});

	it("starts the next leg's hold with a fresh byte budget", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const rejected = ScriptedWebSocket.latest;
			rejected.open();
			// A peer fills the provisional leg's hold, then the relay rejects the leg. What
			// that registration spent is gone with it: charging it against the next leg would
			// refuse the rejoin arriving there a welcome nobody will ask for again.
			for (let message = 1; message <= 8; message++) {
				rejected.onmessage?.({
					data: packEnvelope(message, new Uint8Array(FAT_PAYLOAD_BYTES)).buffer,
				} as MessageEvent);
			}
			rejected.rejectAsHostConflict();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			for (let message = 1; message <= 8; message++) {
				reclaimed.onmessage?.({
					data: packEnvelope(message, new Uint8Array(FAT_PAYLOAD_BYTES)).buffer,
				} as MessageEvent);
			}
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			const charge = FAT_PAYLOAD_BYTES + ENVELOPE_HEADER_LENGTH + HOLD_SLOT_BYTES;
			const fits = Math.floor(HOLD_COMPETE_LIMIT / charge);
			expect(fits).toBeLessThan(8);
			expect(inbound).toEqual(Array.from({ length: fits }, (_, index) => index + 1));
		} finally {
			socket.close();
		}
	});

	it("lets one peer fill the hold and still admits another guest's handshake", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// One peer spends everything a stream past its floor may compete for. What it holds
			// is bounded — the flat slot cost is what makes even small frames spend a budget —
			// and the floor the peer budget keeps back is what gets the next guest's `hello`
			// in, which is the one message nothing re-sends.
			const loud = packEnvelope(FLOOD_PEER, new Uint8Array(32));
			const charge = loud.buffer.byteLength + HOLD_SLOT_BYTES;
			const competes = Math.floor(HOLD_COMPETE_LIMIT / charge);
			for (let message = 0; message < competes + 8; message++) {
				reclaimed.onmessage?.({ data: loud.buffer } as MessageEvent);
			}
			reclaimed.introducePeer(LATE_GUEST);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 120_000; tick++) await Promise.resolve();

			expect(inbound.filter(peer => peer === FLOOD_PEER)).toHaveLength(competes);
			expect(inbound.at(-1)).toBe(LATE_GUEST);
		} finally {
			socket.close();
		}
	});

	it("spends each budget to its last byte, and not one message further", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const controls: string[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		socket.onControl = msg => controls.push(msg.t);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Both budgets are priced to divide exactly, so the message that lands on the last
			// byte is held and the one after it is refused. A guest turned away with a budget
			// byte to spare loses a `hello` nothing re-sends, so the boundary is a contract.
			const empty = JSON.stringify({ t: "peer-joined", peer: 1, pad: "" });
			const control = JSON.stringify({
				t: "peer-joined",
				peer: 1,
				pad: "x".repeat(4_096 / 2 - HOLD_SLOT_BYTES / 2 - empty.length),
			});
			const controlFits = HOLD_CONTROL_LIMIT / (control.length * 2 + HOLD_SLOT_BYTES);
			for (let message = 0; message < controlFits + 1; message++) {
				reclaimed.onmessage?.({ data: control } as MessageEvent);
			}
			const frame = packEnvelope(
				REJOIN_PEER,
				new Uint8Array(1024 * 1024 - ENVELOPE_HEADER_LENGTH - HOLD_SLOT_BYTES),
			);
			const frameFits = HOLD_COMPETE_LIMIT / (1024 * 1024);
			for (let message = 0; message < frameFits + 1; message++) {
				reclaimed.onmessage?.({ data: frame.buffer } as MessageEvent);
			}
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 40_000; tick++) await Promise.resolve();

			expect(controlFits % 1).toBe(0);
			expect(frameFits % 1).toBe(0);
			expect(controls).toHaveLength(controlFits);
			expect(inbound).toHaveLength(frameFits);
		} finally {
			socket.close();
		}
	});

	it("charges the broadcast slot like any stream, reserve included", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Exempting id 0 from the latch is not the same as exempting it from accounting:
			// judged inside its floor forever, it would spend the reserve a guest's handshake
			// needs, one floor-sized frame at a time.
			const floorFrame = packEnvelope(
				0,
				new Uint8Array(HOLD_STREAM_FLOOR - ENVELOPE_HEADER_LENGTH - HOLD_SLOT_BYTES),
			);
			for (let message = 0; message < HOLD_PEER_BYTES_LIMIT / HOLD_STREAM_FLOOR; message++) {
				reclaimed.onmessage?.({ data: floorFrame.buffer } as MessageEvent);
			}
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			expect(inbound.filter(peer => peer === 0)).toHaveLength(HOLD_COMPETE_LIMIT / HOLD_STREAM_FLOOR);
			expect(inbound.at(-1)).toBe(REJOIN_PEER);
		} finally {
			socket.close();
		}
	});

	it("holds a guest's large frame while the room is quiet", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Nothing caps what a guest may send: a prompt carrying an image runs to megabytes.
			// A stream's floor bounds what the room can lose to it, not what it may send, so a
			// frame far past the floor is still held while the budget has room — and the guest
			// is not silenced for the window either.
			reclaimed.introducePeer(REJOIN_PEER);
			reclaimed.onmessage?.({
				data: packEnvelope(REJOIN_PEER, new Uint8Array(HOLD_STREAM_FLOOR * 40)).buffer,
			} as MessageEvent);
			reclaimed.onmessage?.({ data: packEnvelope(REJOIN_PEER, new Uint8Array(64)).buffer } as MessageEvent);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER, REJOIN_PEER, REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});

	it("never silences the broadcast slot, whatever it was refused for", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Peer 0 is the broadcast slot, not a guest. Latching it the way a guest's stream
			// is latched would silence everything the room is told for the rest of the hold,
			// because it is every guest's predecessor rather than one guest's.
			reclaimed.onmessage?.({ data: packEnvelope(0, new Uint8Array(HOLD_PEER_BYTES_LIMIT)).buffer } as MessageEvent);
			reclaimed.onmessage?.({ data: packEnvelope(0, new Uint8Array(64)).buffer } as MessageEvent);
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(inbound).toEqual([0, REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});

	it("ignores control that carries no peer the session could act on", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const controls: string[] = [];
		const { socket } = startSocket("host");
		socket.onControl = msg => controls.push(msg.t);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A transition names a peer, and the session retires that id when it hears one.
			// Forwarding a departure with no id has it retire `undefined`, which is a silent
			// no-op that looks like a departure was handled.
			for (const text of ['{"t":"peer-left"}', '{"t":"peer-joined","peer":"7"}', '{"t":"made-up","peer":7}', "[]"]) {
				reclaimed.onmessage?.({ data: text } as MessageEvent);
			}
			reclaimed.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(controls).toEqual(["peer-left"]);
		} finally {
			socket.close();
		}
	});

	it("does not hold an envelope whose payload could never be opened", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket, closes } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A payload with no room for an IV and a GCM tag can only fail authentication, and
			// failing at replay ends the session as a bad key, taking the rest of the replay
			// with it. Every length below the structural floor is dropped here instead — the
			for (const payload of [0, 1, 12, 13, 27]) {
				reclaimed.onmessage?.({
					data: packEnvelope(FLOOD_PEER, new Uint8Array(payload)).buffer,
				} as MessageEvent);
			}
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER]);
			expect(closes).toEqual([{ reason: "Connection ended", willReconnect: true }]);
		} finally {
			socket.close();
		}
	});

	it("does not let bytes that are no envelope occupy the hold", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket, closes } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Bytes too short to carry a peer id are not traffic of any stream. Charged and
			// held, the flat slot cost turns a few hundred KB of them into the whole budget,
			// and the first one to reach `open` at replay ends the session — so they are
			// dropped here, where they cost nothing and take nothing with them.
			const stub = new Uint8Array([1, 2]);
			for (let message = 0; message <= HOLD_PEER_BYTES_LIMIT / HOLD_SLOT_BYTES; message++) {
				reclaimed.onmessage?.({ data: stub.buffer } as MessageEvent);
			}
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER]);
			expect(closes).toEqual([{ reason: "Connection ended", willReconnect: true }]);
		} finally {
			socket.close();
		}
	});

	it("keeps the hold's ceiling intact when the relay delivers something unexpected", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Something the wire grammar has no room for. Held, it would be charged bytes it
			// does not have and take the ceiling with it: the messages behind it are then
			// admitted without a bound, and the leg holds whatever the room can push.
			reclaimed.onmessage?.({ data: 42 } as unknown as MessageEvent);
			for (let message = 1; message <= 8; message++) {
				reclaimed.onmessage?.({
					data: packEnvelope(message, new Uint8Array(FAT_PAYLOAD_BYTES)).buffer,
				} as MessageEvent);
			}
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			const charge = FAT_PAYLOAD_BYTES + ENVELOPE_HEADER_LENGTH + HOLD_SLOT_BYTES;
			const fits = Math.floor(HOLD_COMPETE_LIMIT / charge);
			expect(fits).toBeLessThan(8);
			expect(inbound).toEqual(Array.from({ length: fits }, (_, index) => index + 1));
		} finally {
			socket.close();
		}
	});

	it("keeps a message whose charge exactly fills a stream's share", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Two messages from one guest, priced at exactly half its share each. The bound is
			// on what would overrun it, so the arrival that lands on it to the byte is still
			// held: a rejoin must not be turned away by a rounding choice.
			const halfPayload = HOLD_STREAM_FLOOR / 2 - HOLD_SLOT_BYTES - ENVELOPE_HEADER_LENGTH;
			for (let message = 0; message < 2; message++) {
				reclaimed.onmessage?.({
					data: packEnvelope(REJOIN_PEER, new Uint8Array(halfPayload)).buffer,
				} as MessageEvent);
			}
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER, REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});

	it("delivers a rejoin hello that arrives behind a refused frame", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A guest reconnecting flushes what it queued during the outage before its own
			// onOpen sends the `hello`, so the host meets a large prompt first and the
			// handshake behind it. Holding the prompt's refusal against the `hello` would
			// leave that guest connected, unwelcomed, and with no watchdog to notice: a lost
			// prompt is visible to whoever typed it, a lost `hello` to nobody.
			const chatty = REJOIN_PEER;
			reclaimed.onmessage?.({
				data: packEnvelope(chatty, new Uint8Array(HOLD_COMPETE_LIMIT - 2 * 1024 * 1024)).buffer,
			} as MessageEvent);
			reclaimed.onmessage?.({
				data: packEnvelope(chatty, new Uint8Array(2 * 1024 * 1024)).buffer,
			} as MessageEvent);
			reclaimed.onmessage?.({ data: packEnvelope(chatty, new Uint8Array(300)).buffer } as MessageEvent);
			reclaimed.introducePeer(LATE_GUEST);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 400; tick++) await Promise.resolve();

			// The frame that did not fit is gone; everything else from that guest still lands.
			expect(inbound).toEqual([chatty, chatty, LATE_GUEST]);
		} finally {
			socket.close();
		}
	});

	it("holds a whole room that rejoins behind a frame too big to hold", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A guest prompt larger than the whole ceiling arrives first — guests have no
			// send-side size cap, so this is legal traffic. It cannot be held, but refusing it
			// must not spend the budget the rejoining room needs: every one of those hellos is
			// that guest's only one, and nothing re-requests a welcome.
			reclaimed.onmessage?.({
				data: packEnvelope(REJOIN_PEER, new Uint8Array(HOLD_PEER_BYTES_LIMIT)).buffer,
			} as MessageEvent);
			const guests = 100;
			for (let peer = 1; peer <= guests; peer++) reclaimed.introducePeer(peer);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			// Nobody is latched by the refusal, so every guest including that one is served.
			expect(inbound).toEqual(Array.from({ length: guests }, (_, index) => index + 1));
		} finally {
			socket.close();
		}
	});

	it("still hears a guest leave once the ceiling is full", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const controls: string[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		socket.onControl = msg => controls.push(msg.t);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// The guest rejoins, then a roomful of peers spends every byte peers are allowed to
			// spend, and only after that does the guest leave. The departure has to land
			// anyway: refusing it would leave the session listing that guest and counting it as
			// one that can answer a ui-request for the rest of the leg — the one refusal that
			// leaves state behind. Control has a budget of its own for exactly this.
			reclaimed.introducePeer(REJOIN_PEER);
			for (let peer = 40; peer < 48; peer++) {
				for (let message = 0; message < 4; message++) {
					reclaimed.onmessage?.({
						data: packEnvelope(peer, new Uint8Array(1024 * 1024)).buffer,
					} as MessageEvent);
				}
			}
			reclaimed.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			expect(inbound[0]).toBe(REJOIN_PEER);
			expect(controls).toEqual(["peer-left"]);
		} finally {
			socket.close();
		}
	});

	it("bounds held control as well, once it has spent its own budget", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const controls: string[] = [];
		const { socket } = startSocket("host");
		socket.onControl = msg => controls.push(msg.t);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A relay streaming text instead of a room's transitions cannot grow the hold: its
			// budget is spent to the message. And because a refused control is not latched, the
			// departure behind the refusals still lands — it is what the budget exists for, and
			// the only transition whose loss leaves the session listing a guest that is gone.
			const padded = JSON.stringify({ t: "peer-joined", peer: 1, pad: "x".repeat(64 * 1024) });
			const charge = padded.length * 2 + HOLD_SLOT_BYTES;
			const fits = Math.floor(HOLD_CONTROL_LIMIT / charge);
			for (let message = 0; message < fits + 8; message++) {
				reclaimed.onmessage?.({ data: padded } as MessageEvent);
			}
			reclaimed.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			expect(controls.filter(t => t === "peer-joined")).toHaveLength(fits);
			expect(controls.at(-1)).toBe("peer-left");
		} finally {
			socket.close();
		}
	});

	it("does not let text that is no control message occupy the hold", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(HELLO_PAYLOAD);
		const inbound: number[] = [];
		const controls: string[] = [];
		const { socket } = startSocket("host");
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		socket.onControl = msg => controls.push(msg.t);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// Junk is rejected at intake, not carried to the replay and discarded there. Held,
			// it spends the budget a room's transitions need — and it is priced by the slot
			// cost, so it takes only a few hundred KB of it to spend all of them.
			const junk = "{oops";
			for (let message = 0; message <= HOLD_CONTROL_LIMIT / HOLD_SLOT_BYTES; message++) {
				reclaimed.onmessage?.({ data: junk } as MessageEvent);
			}
			reclaimed.onmessage?.({ data: JSON.stringify({ t: "peer-joined", peer: REJOIN_PEER }) } as MessageEvent);
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			expect(controls).toEqual(["peer-joined"]);
			expect(inbound).toEqual([REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});
});
