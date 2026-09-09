/**
 * Client-side WebSocket wrapper for collab live-session sharing.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Fatal relay close codes (room gone,
 * host conflict, room full) and decryption failures never reconnect.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { open, sealSerialized } from "./crypto";
import type { CollabFrame, RelayControlMessage } from "./protocol";
import { packEnvelope, unpackEnvelope } from "./protocol";

const FATAL_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_PENDING_SENDS = 256;
/**
 * Ceiling on the charge the queue is carrying, levied once per entry when it is
 * admitted: a frame's serialized byte length, and for a lazy batch whatever the
 * caller declares its iterator keeps reachable. Declaring retention is the point
 * — a batch is one entry that can pin a whole session snapshot for as long as
 * the transport takes to drain it, and nothing else in the accounting would show
 * that.
 *
 * A bound on the declarations, not on the heap and not on cumulative work: for
 * finite non-negative declarations the queue carries at most this much charge, or
 * one oversized entry admitted with nothing ahead of it. A declaration is only a
 * proxy for the object graph, loose in both directions. Serialized chunk bytes
 * are transient by comparison — one chunk is materialized at a time — and are
 * not charged again as they pass through.
 */
const MAX_PENDING_SEND_BYTES = 16 * 1024 * 1024;
/**
 * Per-guest share of the queue. Legitimate targeted traffic for one peer is a
 * welcome, one lazy snapshot batch and a handful of ui-requests, so a peer that
 * holds this many entries is spamming or hopelessly behind. It loses its own
 * backlog; the room keeps running.
 */
const MAX_PEER_PENDING_SENDS = 32;
/**
 * Lazy batches one peer may hold. A batch is a single queue entry whose byte
 * charge covers only the chunk in flight, so the entry caps above put no bound
 * at all on how long it occupies the head of a queue shared with every other
 * peer.
 *
 * One, and `CollabHost` puts the welcome at the head of the same generator, so
 * this reads as one welcome-plus-snapshot per peer. That is what makes the pair
 * atomic: the newest one supersedes the previous whole unit, and there is no way
 * to express admitting a welcome without the chunks built with it — a guest
 * given one without the other finalizes a replica it believes is complete.
 */
const MAX_PEER_PENDING_BATCHES = 1;
/**
 * Settled retirement records kept, as a memory backstop only. Correctness is an
 * *ordering* obligation, not a count: a record must outlive the frames that were
 * already on {@link CollabSocket.#recvChain} when the departure arrived, and
 * connection churn can cross any count while an earlier frame is still being
 * decrypted. Eviction therefore skips records whose obligation is unmet, and this
 * bounds only the settled remainder — needed because relay ids climb for the
 * room's lifetime, so a client with the view link could otherwise add one
 * permanent entry per connect/disconnect cycle without ever sending `hello`.
 */
const MAX_RETIRED_PEERS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

interface PendingSend {
	frames: Iterator<CollabFrame | string>;
	targetPeer: number;
	bytes: number;
	/**
	 * One entry that materializes its chunks as the transport drains and holds the
	 * snapshot they come from until it does. Charged once, at admission, for what
	 * it keeps reachable — so a discard refunds exactly what was levied.
	 */
	lazy: boolean;
	/** Carries no replica state, so it may be discarded instead of ending the room. */
	advisory: boolean;
	cancelled: boolean;
}

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	key: CryptoKey;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires once per terminal close (intentional, fatal code, or bad key). willReconnect=true for transient drops that will retry. */
	onClose?: (reason: string, willReconnect: boolean) => void;
	/** A targeted backlog was discarded to keep the room alive; the peer must resync. Always deferred to a microtask. */
	onPeerOverload?: (peerId: number) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Set while a transient drop is being retried; the next open is a new room. */
	#rejoining = false;
	/**
	 * Set for the dynamic extent of an overload report. Nothing a report causes
	 * may cause another shed: the owner answers with a targeted resync error, and
	 * mirrors a warning notice that `AgentSession#emit` dispatches to listeners
	 * synchronously, so `CollabHost`'s own subscription turns it into a broadcast
	 * from inside this scope. Letting either evict somebody would cost a
	 * quota-abiding peer its backlog as a side effect of another peer's report,
	 * and letting the broadcast reach the terminal path would end the room over an
	 * advisory line. Remedy traffic fits in the queue or is dropped.
	 */
	#reporting = false;
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
	#pendingSendBytes = 0;
	/**
	 * Why a peer is currently not being served; absence means it is. Sole
	 * authority for the queue invariant: **every entry in {@link #pendingSends}
	 * with a non-zero `targetPeer` is work for a peer absent from here.**
	 *
	 * Entered synchronously in {@link #handleMessage}, before any owner callback
	 * runs, so it changes atomically with respect to anything that can enqueue.
	 * Kept past the departure because decryption reorders dispatch: a frame that
	 * finishes opening after its sender's `peer-left` must still be recognised as
	 * stale. Stored as the exceptions rather than as the served set because a
	 * socket cannot enumerate who it serves — `peer-joined` is advisory and an
	 * owner may legitimately address a peer it learned of out of band — but it
	 * always knows who it has written off.
	 *
	 * - `left`: the relay retired the id. `settled` records whether the frames
	 *   received before the departure have been dispatched; only settled records
	 *   may be evicted, so connection churn cannot retire a record whose frame is
	 *   still in the chain, and {@link MAX_RETIRED_PEERS} bounds the settled
	 *   remainder.
	 * - `shed`: {@link #shedPeer} discarded the peer's backlog and has not
	 *   reported it yet. Lives one microtask turn, so the cap never evicts it. A
	 *   shed peer is still owed a resync error, so the mask lifts before the
	 *   report; `left` overwrites it, because departure wins.
	 */
	#notServing = new Map<number, { reason: "left" | "shed"; settled: boolean }>();
	/**
	 * Bumped when the relay recreates the room. Bookkeeping deferred from one room
	 * may not be applied in the next: the ids are reissued and the records cleared,
	 * so the same id is a different peer and a callback that acts on it by id alone
	 * is acting on somebody else's record.
	 */
	#roomGeneration = 0;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	/**
	 * False once the relay has retired this peer. Owners read this instead of
	 * keeping their own departure bookkeeping: a frame that finishes decrypting
	 * after its sender's `peer-left` sees `false` here, because reception order is
	 * exact even though dispatch order is not.
	 */
	isServing(peerId: number): boolean {
		return this.#notServing.get(peerId)?.reason !== "left";
	}

	/** Fires on every reconnect: the relay recreated the room and reissues peer ids from 1. */
	onRoomRecreated?: () => void;

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	send(frame: CollabFrame, targetPeer = 0): void {
		if (this.#closed) return;
		try {
			const serialized = JSON.stringify(frame);
			this.#enqueueSend([serialized].values(), targetPeer, Buffer.byteLength(serialized), false, false);
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
		}
	}

	/**
	 * Keeps a lazy snapshot contiguous with its welcome and ahead of subsequent live traffic.
	 *
	 * @param retainedBytes size of the data {@link frames} keeps reachable until the
	 * batch drains. Charged against the send budget at admission, since a lazy batch
	 * is one queue entry that can hold a whole snapshot. A serialized size is the
	 * expected measure; it is a proxy for the object graph, within a small factor in
	 * either direction, so pass an upper bound where one is cheap.
	 */
	sendBatch(frames: Iterable<CollabFrame>, targetPeer: number, retainedBytes: number): void {
		if (this.#closed) return;
		this.#enqueueSend(frames[Symbol.iterator](), targetPeer, retainedBytes, true, false);
	}

	/**
	 * Broadcast that carries no replica state, so a full queue may discard it
	 * rather than end the room. Guests can cause this traffic without it being
	 * addressed to them — one notice per `hello` — and a peer-caused pile-up must
	 * never reach the terminal path, so it is shed ahead of everything else.
	 */
	broadcastAdvisory(frame: CollabFrame): boolean {
		if (this.#closed) return false;
		try {
			const serialized = JSON.stringify(frame);
			return this.#enqueueSend([serialized].values(), 0, Buffer.byteLength(serialized), false, true);
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
			return false;
		}
	}

	/**
	 * Discard everything still queued for a peer that left. The queue is shared
	 * and strictly FIFO, so a half-delivered snapshot would otherwise hold its
	 * head and stall every later frame — including the next guest's welcome —
	 * behind a retransmission the relay drops on arrival.
	 *
	 * @returns how many queued entries were discarded.
	 */
	dropPeer(peerId: number): number {
		if (peerId === 0) return 0;
		return this.#discardWhere(pending => pending.targetPeer === peerId);
	}

	/** Single eviction path: cancels an in-flight head cleanly and refunds its accounting. */
	#discardWhere(match: (pending: PendingSend) => boolean): number {
		if (this.#pendingSends.length === 0) return 0;
		const keep: PendingSend[] = [];
		for (const pending of this.#pendingSends) {
			if (!match(pending)) {
				keep.push(pending);
				continue;
			}
			pending.cancelled = true;
			this.#pendingSendBytes -= pending.bytes;
			pending.frames.return?.(undefined);
		}
		const discarded = this.#pendingSends.length - keep.length;
		this.#pendingSends = keep;
		return discarded;
	}

	/**
	 * A reconnect lands in a room the relay recreated: `local-relay.ts` deletes the
	 * room when the host socket closes, closes every guest with 4001, and hands
	 * out peer ids from 1 again. No `peer-left` announces any of it, so every id
	 * this socket knew is meaningless and may already have been reissued.
	 *
	 * Targeted work is therefore undeliverable and must go. A lazy batch is the
	 * pressing case: it is one queue entry whose accounting covers only the chunk
	 * in flight, so nothing bounds how long it keeps iterating at a retired id
	 * while every new guest's welcome waits behind it. Retirement records go too —
	 * keeping them would permanently refuse a reissued id, and so does the owner's
	 * view of who is in the room — see {@link onRoomRecreated}, because an id is
	 * also what the owner keys write permission off. Broadcast work is addressed to
	 * whoever is in the room and survives, which is the reconnect backlog contract
	 * the drain tests pin.
	 */
	#resetForRecreatedRoom(): void {
		this.#roomGeneration++;
		this.#notServing.clear();
		const discarded = this.#discardWhere(pending => pending.targetPeer !== 0);
		if (discarded > 0) logger.debug("collab: discarded targeted sends across a reconnect", { discarded });
	}

	#enqueueSend(
		frames: Iterator<CollabFrame | string>,
		targetPeer: number,
		bytes: number,
		lazy: boolean,
		advisory: boolean,
	): boolean {
		// The queue invariant, enforced in one place: targeted work is only ever
		// admitted for a peer still being served. Covers a peer that left — its
		// queued batch would hold the head of a queue shared with everyone else —
		// and the window between a shed and its report, since CollabHost#handleHello
		// queues a snapshot batch on the line after the welcome that shed the peer.
		if (targetPeer !== 0 && this.#notServing.has(targetPeer)) {
			logger.debug("collab: refusing frame for a peer that is not being served", {
				targetPeer,
				reason: this.#notServing.get(targetPeer)?.reason,
			});
			return false;
		}
		// Enforced once here rather than per capacity branch: a saturated queue plus
		// remedy traffic is always a drop, whoever it is addressed to. Reading the
		// flag inside the branches instead left the broadcast path — which the
		// notice mirror reaches — able to shed and able to go terminal.
		if (this.#reporting && this.#overCapacity(bytes)) {
			logger.debug("collab: dropping frame emitted while reporting a shed", { targetPeer });
			return false;
		}
		// Newest-wins supersede, not a shed: a second welcome re-primes the guest's
		// accumulator, so only the newest welcome/batch pair is self-consistent.
		// Keeping the older batch and refusing this one would let the older train's
		// `final` terminate a replica that is missing everything the reset dropped.
		// Nothing is reported, because superseding is the ordinary consequence of a
		// second hello rather than a peer falling behind.
		if (lazy && targetPeer !== 0 && this.#pendingBatchesFor(targetPeer) >= MAX_PEER_PENDING_BATCHES) {
			const superseded = this.#discardWhere(pending => pending.targetPeer === targetPeer && pending.lazy);
			logger.debug("collab: superseded queued snapshot batches", { targetPeer, superseded });
		}
		if (targetPeer === 0) {
			// Broadcasts and every guest-role send land here. Shed guest-attributable
			// backlog first so only a genuinely host-generated pile-up is fatal.
			// Advisory first: a transcript line is the cheapest thing to lose, and it
			// is the one kind of broadcast a guest can cause at will.
			while (this.#overCapacity(bytes)) {
				if (this.#discardWhere(pending => pending.advisory) > 0) continue;
				// Before shedding anyone: a frame classified as safe to lose must never
				// buy its own admission with a quota-abiding peer's backlog. Guests can
				// cause advisory traffic at will, so the cheapest frame in the system
				// would otherwise evict the most expensive.
				if (advisory) {
					logger.debug("collab: dropping advisory broadcast, only replica state is left to shed");
					return false;
				}
				if (this.#shedHeaviestPeer()) continue;
				this.#failOverload();
				return false;
			}
		} else if (this.#pendingForPeer(targetPeer) >= MAX_PEER_PENDING_SENDS) {
			this.#shedPeer(targetPeer);
			return false;
		} else if (this.#overCapacity(bytes)) {
			// A welcome-plus-snapshot is the one frame a newcomer cannot obtain any
			// other way, and without a reservation a handful of peers at their full
			// share lock out every later join for as long as the uplink stays
			// backpressured. So shed the heaviest holder for that, and never the
			// requester itself: that would discard its backlog to make room for its
			// own frame and report it as overloaded.
			//
			// Only for that. Ordinary targeted responses — read-only errors,
			// transcript replies, ui-requests — answer something the peer asked for,
			// and the host sends them without requiring a registered peer, so letting
			// them evict would let a guest spam requests, be shed, resume once the
			// mask lifts, and walk through everyone else's backlog. Those drop
			// instead: the cost of a peer's own requests stays with that peer.
			while (lazy && this.#overCapacity(bytes)) {
				if (!this.#shedHeaviestPeer(targetPeer)) break;
			}
			if (this.#overCapacity(bytes)) {
				logger.debug("collab: dropping targeted frame, no shed can make room", { targetPeer, lazy });
				return false;
			}
		}
		this.#pendingSends.push({ frames, targetPeer, bytes, lazy, advisory, cancelled: false });
		this.#pendingSendBytes += bytes;
		this.#pumpSends();
		return true;
	}

	#overCapacity(bytes: number): boolean {
		if (this.#pendingSends.length >= MAX_PENDING_SENDS) return true;
		// An entry with nothing ahead of it is admitted whatever it costs: a session
		// larger than the whole budget still has to be shareable, and the queue can
		// only shrink from here. The ceiling is therefore the budget plus one entry.
		if (this.#pendingSends.length === 0) return false;
		return this.#pendingSendBytes + bytes > MAX_PENDING_SEND_BYTES;
	}

	#pendingForPeer(peerId: number): number {
		let count = 0;
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer === peerId) count++;
		}
		return count;
	}

	#pendingBatchesFor(peerId: number): number {
		let count = 0;
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer === peerId && pending.lazy) count++;
		}
		return count;
	}

	/**
	 * Drop the queued work of the peer holding the most of it, skipping
	 * {@link exclude}. False when no other peer holds any, which is the only case
	 * that means the queue is genuinely broadcast-owned.
	 */
	#shedHeaviestPeer(exclude = 0): boolean {
		const counts = new Map<number, number>();
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer === 0 || pending.targetPeer === exclude) continue;
			counts.set(pending.targetPeer, (counts.get(pending.targetPeer) ?? 0) + 1);
		}
		let worst = 0;
		let worstCount = 0;
		for (const [peerId, count] of counts) {
			if (count > worstCount) {
				worst = peerId;
				worstCount = count;
			}
		}
		if (worst === 0) return false;
		this.#shedPeer(worst);
		return true;
	}

	#shedPeer(peerId: number): void {
		// Reporting a shed that freed nothing invites the owner to answer with a
		// send that cannot be admitted, which schedules another report: an
		// unbounded microtask cascade that starves the drain timer.
		if (this.dropPeer(peerId) === 0) return;
		// Deferred: the owner reacts by sending, and re-entering the queue mid-shed
		// would let a callback refill what the shedding loop is trying to free. The
		// mask closes the window that deferral opens; it lifts before the report so
		// the owner's resync error is admitted. A departure inside the window
		// overwrites the mask, and lifting it then would un-retire the peer.
		if (this.#notServing.has(peerId)) return;
		this.#notServing.set(peerId, { reason: "shed", settled: true });
		queueMicrotask(() => {
			if (this.#notServing.get(peerId)?.reason === "shed") this.#notServing.delete(peerId);
			this.#reporting = true;
			try {
				this.onPeerOverload?.(peerId);
			} finally {
				this.#reporting = false;
			}
		});
	}

	#failOverload(): void {
		const recovery = this.#opts.role === "host" ? "restart sharing and rejoin" : "rejoin";
		this.#failFatal(
			`collab send backlog exceeded its limit; ${recovery} to resync and check whether pending commands ran before retrying`,
		);
	}

	#pumpSends(): void {
		if (this.#sending || this.#closed) return;
		this.#sending = true;
		const generation = this.#sendGeneration;
		void this.#sendPending(generation)
			.catch((err: unknown) => {
				if (generation === this.#sendGeneration) {
					this.#failFatal(`collab send failed: ${String(err)}; rejoin to resync`);
				}
			})
			.finally(() => {
				if (generation !== this.#sendGeneration) return;
				this.#sending = false;
				if (this.#pendingSends.length > 0) this.#pumpSends();
			});
	}

	async #sendPending(generation: number): Promise<void> {
		while (!this.#closed && generation === this.#sendGeneration) {
			const pending = this.#pendingSends[0];
			if (!pending || !(await this.#waitForWritable(generation))) return;
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
			const next = pending.frames.next();
			if (next.done) {
				this.#pendingSends.shift();
				this.#pendingSendBytes -= pending.bytes;
				continue;
			}
			const serialized = typeof next.value === "string" ? next.value : JSON.stringify(next.value);
			const sealed = await sealSerialized(this.#opts.key, serialized);
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
			if ((await this.#sendEnvelope(pending, packEnvelope(pending.targetPeer, sealed), generation)) === "stop") {
				return;
			}
		}
	}

	async #sendEnvelope(
		pending: PendingSend,
		envelope: Uint8Array,
		generation: number,
	): Promise<"sent" | "cancelled" | "stop"> {
		while (!this.#closed && generation === this.#sendGeneration) {
			if (pending.cancelled) return "cancelled";
			const ws = await this.#waitForWritable(generation);
			if (!ws || this.#closed || generation !== this.#sendGeneration) return "stop";
			if (pending.cancelled) return "cancelled";
			if (ws !== this.#ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD)
				continue;
			ws.send(envelope);
			return "sent";
		}
		return "stop";
	}

	async #waitForWritable(generation: number): Promise<WebSocket | undefined> {
		let threshold = WS_BACKPRESSURE_THRESHOLD;
		while (!this.#closed && generation === this.#sendGeneration) {
			const ws = this.#ws;
			if (ws?.readyState === WebSocket.OPEN && !(ws.bufferedAmount >= threshold)) return ws;
			const wake = Promise.withResolvers<void>();
			this.#wakeSender = wake.resolve;
			let timer: NodeJS.Timeout | undefined;
			if (ws?.readyState === WebSocket.OPEN) {
				threshold = WS_BACKPRESSURE_DRAIN_THRESHOLD;
				timer = setTimeout(wake.resolve, WS_BACKPRESSURE_DRAIN_RETRY_MS);
				this.#backpressureDrainTimer = timer;
			}
			await wake.promise;
			if (this.#backpressureDrainTimer === timer) this.#clearBackpressureDrain();
			if (this.#wakeSender === wake.resolve) this.#wakeSender = undefined;
		}
		return undefined;
	}

	/** Terminal-only: every caller is closing for good, so no peer is served any more. */
	#discardPendingSends(): void {
		this.#sendGeneration++;
		// The room ends here as surely as it does on a reconnect, and `connect()` may
		// reopen this same socket onto a new one — a documented, tested reuse. Advance
		// the generation with the records it clears, or bookkeeping deferred from the
		// closed room applies to the reopened one, which is the reconnect hole with a
		// synchronous trigger instead of a timer.
		this.#roomGeneration++;
		this.#pendingSends.length = 0;
		this.#pendingSendBytes = 0;
		this.#notServing.clear();
		this.#sending = false;
		this.#wakeSender?.();
	}

	#clearBackpressureDrain(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearBackpressureDrain();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#discardPendingSends();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		this.#clearBackpressureDrain();
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			// Before waking the sender, or it resumes a stale targeted iterator.
			if (this.#rejoining) {
				this.#rejoining = false;
				this.#resetForRecreatedRoom();
				// Before onOpen, and before onmessage can dispatch anything: the owner
				// keys permissions off peer ids the relay is about to reissue.
				this.onRoomRecreated?.();
			}
			this.#wakeSender?.();
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearBackpressureDrain();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			let msg: RelayControlMessage;
			try {
				msg = JSON.parse(data) as RelayControlMessage;
			} catch {
				logger.debug("collab: ignoring malformed control message");
				return;
			}
			this.#applyPeerLifecycle(msg);
			this.onControl?.(msg);
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) return;
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: CollabFrame;
				try {
					frame = await open(this.#opts.key, envelope.payload);
				} catch {
					// The same identity check the success path makes below, for the same
					// reason: decryption is awaited, so the connection that received this
					// frame can be gone by now. A frame from a connection that is over
					// says nothing about the key of the one that is open, and ending that
					// one is fatal and does not reconnect — a corrupt tail from a dropped
					// socket would take the healthy room it was replaced by with it.
					if (this.#ws === ws) this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				logger.debug("collab: frame handler failed", { error: String(err) });
			});
	}

	/**
	 * Peer lifetime, applied synchronously so no owner callback can enqueue for a
	 * peer whose departure this socket has already seen. Dropping the backlog here
	 * rather than in the owner keeps the invariant with the set that defines it.
	 */
	#applyPeerLifecycle(msg: RelayControlMessage): void {
		if (msg.t !== "peer-left") return;
		const peer = msg.peer;
		const generation = this.#roomGeneration;
		this.#notServing.set(peer, { reason: "left", settled: false });
		this.dropPeer(peer);
		// The obligation is discharged once everything received before this control
		// message has been dispatched; nothing can arrive from the id afterwards.
		//
		// In this room only. The chain outlives a reconnect, so a settlement queued
		// behind a held decryption can run after the room was recreated — and by
		// then the id has been reissued and the records cleared, so marking "peer"
		// settled marks the *new* occupant's record instead. That record is then
		// evictable before the frames received ahead of its departure have been
		// dispatched, and once it is gone the id reads as served again: a departed
		// peer's frame reaches the owner with authority the relay already withdrew.
		void this.#recvChain.then(() => {
			if (generation !== this.#roomGeneration) return;
			const record = this.#notServing.get(peer);
			if (record?.reason === "left") record.settled = true;
			this.#trimRetired();
		});
	}

	/** Forget the oldest *settled* retirements past the cap; insertion order is Map order. */
	#trimRetired(): void {
		if (this.#notServing.size <= MAX_RETIRED_PEERS) return;
		for (const [peer, record] of this.#notServing) {
			if (this.#notServing.size <= MAX_RETIRED_PEERS) return;
			if (record.reason === "left" && record.settled) this.#notServing.delete(peer);
		}
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#clearBackpressureDrain();
		const fatalReason = FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#discardPendingSends();
			this.onClose?.(fatalReason, false);
			return;
		}
		this.#rejoining = true;
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#discardPendingSends();
		const ws = this.#ws;
		this.#ws = null;
		this.#clearBackpressureDrain();
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt++;
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
