/**
 * Contract: a relay peer id is only addressable on the leg that minted it.
 *
 * The relay is the sole source of peer ids and it hands them out per room, restarting at
 * 1 when it frees a room. So an envelope addressed to a peer the live leg never heard from
 * belongs to a registration that is gone, and delivering it would hand one guest's frame
 * to whoever inherited that number. These cases pin that scoping, the terminal close codes
 * that must never reconnect, and the single-leg invariant — all of which the reclaim suite
 * exercises only incidentally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { packEnvelope, unpackEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;
const HOST_CONFLICT_REASON = "a host is already connected for this room";
const RECLAIM_WINDOW_MS = 120_000;
const LEG_SETTLE_MS = 2_000;
/** Backoff jitter is `0.75 + Math.random() * 0.5`; 0.5 pins the base delay. */
const JITTER_NEUTRAL = 0.5;
/** Guests a settle replay introduces at once in the bulk case below. */
const ROOM_GUESTS = 40;
/** Mirrors MAX_PENDING_SENDS in the client. */
const PENDING_SEND_LIMIT = 256;
/** Mirrors WS_BACKPRESSURE_DRAIN_RETRY_MS in the client. */
const BACKPRESSURE_RETRY_MS = 25;
const REJOIN_PEER = 7;
/** A second guest that speaks after the leg settled but before the hold replayed. */
const LATE_GUEST = 9;
/** Stand-in plaintext for an inbound guest frame; `open()` only needs valid frame JSON. */
const GUEST_PAYLOAD = new TextEncoder().encode(JSON.stringify({ t: "bye", reason: "guest frame" })).buffer;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

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

	/** The relay routing a guest's frame to us is what makes its id addressable. */
	introducePeer(peer: number): void {
		this.onmessage?.({ data: packEnvelope(peer, new Uint8Array(32)).buffer } as MessageEvent);
	}

	closeWith(code: number, reason: string): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.({ code, reason } as CloseEvent);
	}

	/**
	 * Real Bun moves to CLOSING and dispatches the close event a task later, so frames the
	 * relay already queued still arrive on a leg the client has detached.
	 */
	close(code = 1000): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.readyState = ScriptedWebSocket.CLOSING;
		queueMicrotask(() => this.closeWith(code, "closed"));
	}
}

function startHost(): CollabSocket {
	const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/scope", role: "host", key: {} as CryptoKey });
	socket.connect();
	return socket;
}

describe("CollabSocket leg-scoped peer ids", () => {
	beforeEach(() => {
		ScriptedWebSocket.instances = [];
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		globalThis.WebSocket = ScriptedWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = ORIGINAL_WEBSOCKET;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("retires the peer ids of a leg that died, dropping a reply queued during the outage", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			const established = ScriptedWebSocket.latest;
			established.open();
			established.introducePeer(REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
			established.closeWith(1006, "Connection ended");

			// An async host handler finishes after the drop and answers the guest it was
			// serving. The relay has recycled the room and will hand that number to someone
			// else, so the reply must not survive; the broadcast still may.
			socket.send({ t: "bye", reason: "reply to a guest of the dead room" }, REJOIN_PEER);
			socket.send({ t: "bye", reason: "session event" });
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(reclaimed.sent.map(envelope => unpackEnvelope(envelope)?.peerId)).toEqual([0]);
		} finally {
			socket.close();
		}
	});

	it("purges buffered replies when their leg dies and keeps the buffered broadcasts", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const rejected = ScriptedWebSocket.latest;
			rejected.open();
			// The guest spoke on this very leg, so its reply is addressable and reaches the
			// buffer rather than the send-time drop.
			rejected.introducePeer(REJOIN_PEER);
			socket.send({ t: "bye", reason: "welcome for a guest of this leg" }, REJOIN_PEER);
			socket.send({ t: "bye", reason: "session event" });
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
			expect(rejected.sent).toEqual([]);

			// The relay rejects the leg and recycles the room, so the buffered reply now
			// names a number the next guest will inherit.
			rejected.closeWith(4009, HOST_CONFLICT_REASON);
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(reclaimed.sent.map(envelope => unpackEnvelope(envelope)?.peerId)).toEqual([0]);
		} finally {
			socket.close();
		}
	});

	it("drops a reply addressed to a peer id minted before close()", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			const first = ScriptedWebSocket.latest;
			first.open();
			first.introducePeer(REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			socket.close();
			socket.connect();
			const revived = ScriptedWebSocket.latest;
			revived.open();
			socket.send({ t: "bye", reason: "reply to a peer of the previous session" }, REJOIN_PEER);
			socket.send({ t: "bye", reason: "session event" });
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(revived.sent.map(envelope => unpackEnvelope(envelope)?.peerId)).toEqual([0]);
		} finally {
			socket.close();
		}
	});
	it("drops what a provisional leg held when close() ends the session", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const inbound: number[] = [];
		const socket = startHost();
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const provisional = ScriptedWebSocket.latest;
			provisional.open();
			provisional.introducePeer(REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);

			// The session ends while the leg is still provisional, then starts again. What
			// that leg held names peers of a room the relay has recycled since.
			socket.close();
			socket.connect();
			const revived = ScriptedWebSocket.latest;
			revived.open();
			socket.send({ t: "bye", reason: "reply to a peer of the previous session" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(inbound).toEqual([]);
			expect(revived.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("introduces every guest a provisional leg heard from when it settles", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// A whole room rejoins onto the provisional leg. None of them is addressable
			// there: the leg the relay may still reject would swallow the reply.
			for (let peer = 1; peer <= ROOM_GUESTS; peer++) reclaimed.introducePeer(peer);
			for (let peer = 1; peer <= ROOM_GUESTS; peer++) {
				socket.send({ t: "bye", reason: `too early for guest ${peer}` }, peer);
			}
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			expect(reclaimed.sent).toEqual([]);

			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			// The replay hands the session all of them, so every id is answerable at once.
			for (let peer = 1; peer <= ROOM_GUESTS; peer++) {
				socket.send({ t: "bye", reason: `welcome ${peer}` }, peer);
			}
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			const served = reclaimed.sent.map(envelope => unpackEnvelope(envelope)?.peerId);
			expect(served).toEqual(Array.from({ length: ROOM_GUESTS }, (_, index) => index + 1));
		} finally {
			socket.close();
		}
	});

	it("makes a peer addressable as soon as its traffic arrives, before the frame decrypts", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		const pendingOpen = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(pendingOpen.promise);
		const socket = startHost();
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			// The relay routing the frame is what makes the id real; a reply must not wait on
			// our own decryption of it.
			leg.introducePeer(REJOIN_PEER);
			socket.send({ t: "bye", reason: "reply while the inbound frame is still opening" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(leg.sent.map(envelope => unpackEnvelope(envelope)?.peerId)).toEqual([REJOIN_PEER]);
		} finally {
			pendingOpen.resolve(GUEST_PAYLOAD);
			socket.close();
		}
	});

	it("does not deliver a frame that finished decrypting after its leg died", async () => {
		const pendingOpen = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(pendingOpen.promise);
		const framesFrom: number[] = [];
		const socket = startHost();
		socket.onFrame = (_frame, fromPeer) => framesFrom.push(fromPeer);
		try {
			const established = ScriptedWebSocket.latest;
			established.open();
			established.introducePeer(REJOIN_PEER);
			// The leg dies while the frame is still inside open(). Delivering it afterwards
			// would re-register a peer of the dead room in the consumer that just cleared it.
			established.closeWith(1006, "Connection ended");
			pendingOpen.resolve(GUEST_PAYLOAD);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(framesFrom).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("does not end the session over a frame that failed to open on a leg already gone", async () => {
		vi.spyOn(Math, "random").mockReturnValue(JITTER_NEUTRAL);
		const pendingOpen = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(pendingOpen.promise);
		const closes: { reason: string; willReconnect: boolean }[] = [];
		const socket = startHost();
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });
		try {
			const established = ScriptedWebSocket.latest;
			established.open();
			established.introducePeer(REJOIN_PEER);
			// The frame is inside open() when its leg dies, and then it turns out to be
			// corrupt. A key is only proven wrong by traffic the live leg accepted: treating
			// this as fatal would tear the room down and cancel the reconnect the client has
			// already promised, over a frame nobody can act on.
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
			established.closeWith(1006, "Connection ended");
			pendingOpen.promise.catch(() => {});
			pendingOpen.reject(new Error("corrupted frame"));
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(closes).toEqual([{ reason: "Connection ended", willReconnect: true }]);
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.latest).not.toBe(established);
		} finally {
			socket.close();
		}
	});

	it("ignores control JSON that parses but carries no tag", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const controls: string[] = [];
		const socket = startHost();
		socket.onControl = msg => controls.push(msg.t);
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			// A custom or malfunctioning relay can send syntactically valid JSON that is not a
			// control object at all. Reading a field off it would throw out of the socket's
			// message handler, where nothing catches it, instead of being ignored the way a
			// syntax error is — and the leg would be left half-processed.
			for (const payload of ["null", "[]", "42", '"peer-left"', "{}", "{oops"]) {
				leg.onmessage?.({ data: payload } as MessageEvent);
			}
			leg.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(controls).toEqual(["peer-left"]);
			expect(socket.isOpen).toBe(true);
		} finally {
			socket.close();
		}
	});

	it("does not hand the session a control message from a leg that died", async () => {
		const pendingOpen = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "decrypt").mockReturnValue(pendingOpen.promise);
		const controls: string[] = [];
		const socket = startHost();
		socket.onControl = msg => controls.push(msg.t);
		try {
			const established = ScriptedWebSocket.latest;
			established.open();
			established.introducePeer(REJOIN_PEER);
			// Control rides the same chain as frames, so this peer-left is parked behind the
			// frame still inside open(); by the time the chain moves, the leg is gone and the
			// consumer has already retired the whole room.
			established.onmessage?.({ data: JSON.stringify({ t: "peer-left", peer: REJOIN_PEER }) } as MessageEvent);
			established.closeWith(1006, "Connection ended");
			pendingOpen.resolve(GUEST_PAYLOAD);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(controls).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("ignores a frame dispatched by a socket the client already abandoned", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			const abandoned = ScriptedWebSocket.latest;
			abandoned.open();
			socket.close();
			socket.connect();
			const revived = ScriptedWebSocket.latest;
			revived.open();
			// close() detaches the old socket while it is only CLOSING, so frames the relay
			// already queued still dispatch: their ids must not become addressable here.
			abandoned.introducePeer(REJOIN_PEER);
			socket.send({ t: "bye", reason: "reply to a peer of the abandoned leg" }, REJOIN_PEER);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(revived.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("keeps one leg when connect() is called again while a leg or a retry is live", () => {
		const socket = startHost();
		try {
			ScriptedWebSocket.latest.open();
			socket.connect();
			// A second leg would race the first for the room and lose one of them to 4009.
			expect(ScriptedWebSocket.instances).toHaveLength(1);

			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			socket.connect();
			expect(ScriptedWebSocket.instances).toHaveLength(1);
			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
		} finally {
			socket.close();
		}
	});

	it.each([
		[4001, "room closed"],
		[4004, "no such room"],
		[4029, "room is full"],
	])("ends the session on close code %i instead of reconnecting", (code, reason) => {
		const closes: { reason: string; willReconnect: boolean }[] = [];
		const socket = startHost();
		socket.onClose = (closeReason, willReconnect) => closes.push({ reason: closeReason, willReconnect });
		try {
			const leg = ScriptedWebSocket.latest;
			leg.open();
			// The relay's final word on the room: retrying only spins against a room that
			// keeps answering the same way.
			leg.closeWith(code, "relay policy");

			expect(closes).toEqual([{ reason, willReconnect: false }]);
			vi.advanceTimersByTime(RECLAIM_WINDOW_MS);
			expect(ScriptedWebSocket.instances).toHaveLength(1);
		} finally {
			socket.close();
		}
	});

	it("drops a reply whose seal straddled a leg change, even when the id was re-minted", async () => {
		const seal = Promise.withResolvers<ArrayBuffer>();
		vi.spyOn(crypto.subtle, "encrypt").mockReturnValue(seal.promise);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const socket = startHost();
		try {
			const established = ScriptedWebSocket.latest;
			established.open();
			established.introducePeer(REJOIN_PEER);
			// The host answers the guest it just heard from, but the reply parks inside its
			// seal behind the rest of the send chain.
			socket.send({ t: "bye", reason: "reply for a guest of the first leg" }, REJOIN_PEER);
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
			established.closeWith(1006, "Connection ended");

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.open();
			// The fresh room hands the same number to a different guest, so checking
			// addressability against the live leg alone would wave the parked reply through.
			reclaimed.introducePeer(REJOIN_PEER);
			seal.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();

			expect(established.sent).toEqual([]);
			expect(reclaimed.sent).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("replays the hold only once the backlog left the buffer and the socket is writable", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const inbound: number[] = [];
		const socket = startHost();
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			for (let frame = 0; frame < PENDING_SEND_LIMIT; frame++) {
				socket.send({ t: "bye", reason: `outage backlog ${frame}` });
			}
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			// The reclaimed leg opens congested, so the backlog cannot leave at settle.
			// Handing the guest's hello to the session here would have it answer with a
			// welcome that queues behind a full buffer, where a train cannot fit.
			reclaimed.bufferedAmount = 1_000_000;
			reclaimed.open();
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);
			expect(reclaimed.sent).toEqual([]);

			reclaimed.bufferedAmount = 0;
			vi.advanceTimersByTime(BACKPRESSURE_RETRY_MS);
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			// Backlog first, then the hello: the guest is answered by a leg whose buffer has
			// room for the handshake it is about to be promised.
			expect(reclaimed.sent).toHaveLength(PENDING_SEND_LIMIT);
			expect(inbound).toEqual([REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});

	it("keeps a fresh arrival behind the hold that is still waiting to replay", async () => {
		vi.spyOn(crypto.subtle, "encrypt").mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const inbound: number[] = [];
		const socket = startHost();
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			for (let frame = 0; frame < PENDING_SEND_LIMIT; frame++) {
				socket.send({ t: "bye", reason: `outage backlog ${frame}` });
			}
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			reclaimed.bufferedAmount = 1_000_000;
			reclaimed.open();
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);

			// The room keeps talking after the leg settled, while the replay is still waiting
			// on the backlog. This frame has to queue behind the hold: handed over first, the
			// session hears the room in an order the relay never sent.
			reclaimed.introducePeer(LATE_GUEST);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);

			reclaimed.bufferedAmount = 0;
			vi.advanceTimersByTime(BACKPRESSURE_RETRY_MS);
			for (let tick = 0; tick < 4_000; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER, LATE_GUEST]);
		} finally {
			socket.close();
		}
	});

	it("waits out a congested socket before replaying, with nothing queued to send", async () => {
		vi.spyOn(crypto.subtle, "decrypt").mockResolvedValue(GUEST_PAYLOAD);
		const inbound: number[] = [];
		const socket = startHost();
		socket.onFrame = (_frame, fromPeer) => inbound.push(fromPeer);
		try {
			ScriptedWebSocket.latest.open();
			ScriptedWebSocket.latest.closeWith(1006, "Connection ended");
			vi.advanceTimersByTime(1_000);
			const reclaimed = ScriptedWebSocket.latest;
			// No outage backlog: congestion alone has to hold the replay back, and the drain
			// timer the flush arms for itself is the only thing that can bring it back.
			reclaimed.bufferedAmount = 1_000_000;
			reclaimed.open();
			reclaimed.introducePeer(REJOIN_PEER);
			vi.advanceTimersByTime(LEG_SETTLE_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();
			expect(inbound).toEqual([]);

			reclaimed.bufferedAmount = 0;
			vi.advanceTimersByTime(BACKPRESSURE_RETRY_MS);
			for (let tick = 0; tick < 2_000; tick++) await Promise.resolve();

			expect(inbound).toEqual([REJOIN_PEER]);
		} finally {
			socket.close();
		}
	});
});
