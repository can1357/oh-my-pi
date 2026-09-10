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
import { describeThrown, packEnvelope, unpackEnvelope } from "./protocol";

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
 * finite non-negative declarations the queue carries at most this much charge,
 * plus at most one entry the empty-queue floor admitted past it — see
 * {@link CollabSocket.#chargedBytes}. A declaration is only a proxy for the
 * object graph, loose in both directions. Serialized chunk bytes are transient by
 * comparison — one chunk is materialized at a time — and are not charged again as
 * they pass through.
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
 * Lazy batches one peer may hold. A batch is a single queue entry that
 * materializes a chunk at a time, so the entry caps above put no bound at all on
 * how long it occupies the head of a queue shared with every other peer — its
 * byte charge bounds the memory it pins, not its residency.
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
/**
 * Ceiling on a thrown value quoted into a close reason or a log line here, in
 * UTF-16 code units.
 *
 * Every conversion in this file goes through {@link describeThrown} at this
 * bound, not only the ones whose value looks guest-derived. The argument is about
 * the conversion and not the sender: `String` throws on a hostile `toString`, on
 * a `toString` returning an object over a hostile `valueOf`, and on a deeply
 * nested value. All four sites are `catch` handlers, and two of them — the drain
 * and the receive chain — are asynchronous, where throwing while rendering turns
 * a diagnostic into an unhandled rejection instead of a message anyone reads.
 */
const THROWN_VALUE_MAX = 512;

interface PendingSend {
	frames: Iterator<CollabFrame | string>;
	targetPeer: number;
	bytes: number;
	/**
	 * One entry that materializes its chunks as the transport drains and holds the
	 * snapshot they come from until it does. Declared once, at admission, for what
	 * it keeps reachable, and the declaration lives here rather than in a running
	 * total — so dropping the entry is the refund, exact by construction.
	 */
	lazy: boolean;
	/** Carries no replica state, so it may be discarded instead of ending the room. */
	advisory: boolean;
	/**
	 * Admitted past the whole budget by the empty-queue floor, so its charge is
	 * excluded from every later capacity decision. See {@link CollabSocket.#chargedBytes}.
	 */
	exempt: boolean;
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
	 * advisory line. Remedy traffic fits in the queue, in the global budget and in
	 * the recipient's own share, or it is dropped.
	 */
	#reporting = false;
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
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
	 *   with no reply outstanding may be evicted, so neither connection churn nor
	 *   the cap can retire a record whose frame is still in the chain or whose
	 *   reply is still being computed, and {@link MAX_RETIRED_PEERS} bounds the
	 *   remainder.
	 * - `shed`: {@link #shedPeer} discarded the peer's backlog and has not
	 *   reported it yet. Lives one microtask turn, so the cap never evicts it. A
	 *   shed peer is still owed a resync error, so the mask lifts before the
	 *   report; `left` overwrites it, because departure wins.
	 */
	#notServing = new Map<number, { reason: "left" | "shed"; settled: boolean }>();
	/** Replies captured by {@link addressee} and not yet delivered, per peer. */
	#peerOps = new Map<number, number>();
	/**
	 * Bumped when the relay recreates the room, and the ownership token for
	 * everything deferred across one. The ids are reissued and the records cleared,
	 * so the same id is a different peer: a settlement queued behind a held
	 * decryption must not mark the new occupant's record, and a capture taken in
	 * the old room must not report the new room's peer as the one that asked.
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

	/**
	 * Captures who a not-yet-computed reply is for. Call the returned function at
	 * the reply site: it reports whether that reply still goes to the peer that
	 * asked, and releases the capture.
	 *
	 * Needed because {@link isServing} at the reply site is not enough on its own.
	 * A retirement record is a *bounded* structure, so it can be evicted while an
	 * asynchronous handler is still running, and a recreated room clears every
	 * record and reissues the ids — either way the id reads as served again and
	 * the reply is admitted for a peer that never asked for it. A capture holds
	 * the record against eviction and remembers which room it belongs to.
	 *
	 * Only for work that finishes in bounded time: retention is why this is safe,
	 * and a capture held across something as long as a model turn would let a
	 * departed peer pin a record for the length of it. Use
	 * {@link bestEffortAddressee} for work that cannot be bounded.
	 */
	addressee(peerId: number): () => boolean {
		const generation = this.#roomGeneration;
		this.#peerOps.set(peerId, (this.#peerOps.get(peerId) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return false;
			released = true;
			const sameRoom = generation === this.#roomGeneration;
			// Read before releasing. The release drops this capture's own protection
			// against eviction, and the trim it runs would then forget the very
			// retirement the answer turns on — reporting a departed peer as the asker.
			const stillTheAsker = sameRoom && this.isServing(peerId);
			// And release only into this capture's own room: #resetForRecreatedRoom
			// already cleared the map, so an old-room capture has nothing of its own
			// left here, while the id it held may now carry a live capture for the
			// new room's occupant. Decrementing that one would unprotect a record
			// somebody is still owed a reply against.
			if (sameRoom) {
				const outstanding = (this.#peerOps.get(peerId) ?? 1) - 1;
				if (outstanding > 0) this.#peerOps.set(peerId, outstanding);
				else this.#peerOps.delete(peerId);
				this.#trimRetired();
			}
			return stillTheAsker;
		};
	}

	/**
	 * Room-scoped addressee check for a reply whose latency has no bound. The
	 * returned predicate reads the room, holds nothing, and may be called
	 * whenever the answer finally exists.
	 *
	 * {@link addressee} is the exact one and the one to prefer: it pins the
	 * retirement record, which is what makes its answer exact — and also why it
	 * is only for bounded work. This keeps the room instead, so a departure the
	 * record still remembers is suppressed and a room boundary always is. Past
	 * eviction, in the same room, a retired id reads as served again; a relay
	 * never reissues an id inside one room, so the residual cost is one stale
	 * line the relay drops on arrival rather than a reply to the wrong peer.
	 */
	bestEffortAddressee(peerId: number): () => boolean {
		const generation = this.#roomGeneration;
		return () => generation === this.#roomGeneration && this.isServing(peerId);
	}

	/** Fires on every reconnect: the relay recreated the room and reissues peer ids from 1. */
	onRoomRecreated?: () => void;

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	/** @returns whether the frame was admitted to the queue; a caller awaiting a reply to it has to settle when it was not. */
	send(frame: CollabFrame, targetPeer = 0): boolean {
		if (this.#closed) return false;
		try {
			const serialized = JSON.stringify(frame);
			return this.#enqueueSend([serialized].values(), targetPeer, Buffer.byteLength(serialized), false, false);
		} catch (err) {
			this.#failFatal(
				`could not serialize collab frame: ${describeThrown(err, THROWN_VALUE_MAX)}; rejoin to resync`,
			);
			return false;
		}
	}

	/**
	 * Keeps a lazy snapshot contiguous with its welcome and ahead of subsequent live traffic.
	 *
	 * @param retainedBytes size of the data {@link frames} keeps reachable until the
	 * batch drains, as a finite non-negative number. Charged against the send budget
	 * at admission, since a lazy batch is one queue entry that can hold a whole
	 * snapshot. A serialized size is the expected measure; it is a proxy for the
	 * object graph, within a small factor in either direction, so pass an upper bound
	 * where one is cheap. Anything outside that domain is treated as oversized rather
	 * than trusted — see below.
	 *
	 * @returns whether the batch was admitted. A welcome lives inside its batch, so
	 * a caller that registers the peer on the strength of sending one has to undo
	 * that when it was not: the guest ignores everything until a welcome arrives, so
	 * a host that counts it as joined is describing a participant that is not there.
	 */
	sendBatch(frames: Iterable<CollabFrame>, targetPeer: number, retainedBytes: number): boolean {
		if (this.#closed) return false;
		// The budget is a sum of declarations, so the domain has to hold at the one
		// place a declaration enters. `NaN` fails every comparison, which makes the
		// queue read as never full and bounds nothing at all; a negative one
		// subtracts from the charge of every other entry. Neither is a legitimate
		// measurement, so neither is trusted with a number of its own: they take the
		// oversized path instead, which is the one case the policy already bounds
		// without believing a figure — one entry, admitted by the empty-queue floor,
		// excluded from the sum. Deliberately not zero, which is the under-charge the
		// charge exists to prevent, and deliberately not a refusal, because a caller
		// bug should not silently cost a guest its only route to a replica.
		//
		// Signed zero passes: `-0` is a declaration of zero, not a malformed one, and
		// it sums as zero wherever the charge is read. Rejecting it would refuse a
		// legitimate empty batch to no purpose.
		const declared =
			Number.isFinite(retainedBytes) && retainedBytes >= 0 ? retainedBytes : MAX_PENDING_SEND_BYTES + 1;
		if (declared !== retainedBytes) {
			logger.warn("collab: batch declared a size outside the budget's domain; charging it as oversized", {
				targetPeer,
				retainedBytes,
			});
		}
		return this.#enqueueSend(frames[Symbol.iterator](), targetPeer, declared, true, false);
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
			this.#failFatal(
				`could not serialize collab frame: ${describeThrown(err, THROWN_VALUE_MAX)}; rejoin to resync`,
			);
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
	 * pressing case: its charge bounds the snapshot it pins but says nothing about
	 * how long it iterates, so nothing stops it running to the end of a whole
	 * session at a retired id while every new guest's welcome waits behind it. Retirement records go too —
	 * keeping them would permanently refuse a reissued id, and so does the owner's
	 * view of who is in the room — see {@link onRoomRecreated}, because an id is
	 * also what the owner keys write permission off. Broadcast work is addressed to
	 * whoever is in the room and survives, which is the reconnect backlog contract
	 * the drain tests pin.
	 */
	#resetForRecreatedRoom(): void {
		this.#roomGeneration++;
		this.#peerOps.clear();
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
		// Enforced once here rather than per capacity branch: while a report is on
		// the stack a frame is admitted only if nothing has to be evicted to fit it,
		// whoever it is addressed to. Both eviction paths count. The global budget
		// sheds and then goes terminal, which the notice mirror reaches; and a peer
		// already at its share is shed by the next frame for it, which the report
		// reaches because what a report causes is not addressed only to the peer
		// being reported — settling the asks that peer was holding fans
		// `ui-request-end` out to every other writable guest.
		if (this.#reporting && this.#wouldEvict(targetPeer, bytes)) {
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
			//
			// Preflight before the first shed, never during it. Shedding peer by peer
			// and stopping when it stops helping destroys a viable guest's snapshot to
			// buy nothing: a broadcast the shed cannot touch is enough to keep the
			// floor out of reach, so an oversized batch fails anyway and the peer it
			// evicted on the way out is a second casualty of a join that never
			// happened.
			if (lazy && this.#shedCouldAdmit(bytes, targetPeer)) {
				while (this.#overCapacity(bytes)) {
					if (!this.#shedHeaviestPeer(targetPeer)) break;
				}
			}
			if (this.#overCapacity(bytes)) {
				logger.debug("collab: dropping targeted frame, no shed can make room", { targetPeer, lazy });
				return false;
			}
		}
		// The floor below admits an entry with nothing ahead of it whatever it costs.
		// Record when that is the only reason it fits, because its charge must not
		// read as pressure afterwards — see #chargedBytes.
		const exempt = this.#pendingSends.length === 0 && bytes > MAX_PENDING_SEND_BYTES;
		this.#pendingSends.push({ frames, targetPeer, bytes, lazy, advisory, exempt, cancelled: false });
		this.#pumpSends();
		return true;
	}

	#overCapacity(bytes: number): boolean {
		if (this.#pendingSends.length >= MAX_PENDING_SENDS) return true;
		// An entry with nothing ahead of it is admitted whatever it costs: a session
		// larger than the whole budget still has to be shareable, and the queue can
		// only shrink from here. The ceiling is therefore the budget plus one entry.
		if (this.#pendingSends.length === 0) return false;
		return this.#chargedBytes() + bytes > MAX_PENDING_SEND_BYTES;
	}

	/**
	 * The charge the budget is measured against: everything except an entry the
	 * empty-queue floor admitted past the budget on its own.
	 *
	 * Counting that one holds the queue over capacity for its entire drain, and
	 * over capacity is what every eviction path keys on — so the first
	 * replica-bearing broadcast after it sheds the peer the floor just admitted it
	 * for, which for a snapshot is the joining guest losing a half-delivered
	 * replica. `CollabHost` broadcasts an `entry` per appended entry and an `event`
	 * per agent event, so on a busy session that is the next few milliseconds, and
	 * the rejoin it asks for is admitted by the same floor and shed the same way.
	 * Excluding it makes the ceiling the budget *plus* that one entry, which is what
	 * the floor always meant: live traffic queues behind the oversized snapshot in
	 * order rather than evicting it.
	 *
	 * Summed rather than subtracted from a running total, because a declaration is
	 * a caller's number and floating-point addition is lossy at scale: against an
	 * accumulator holding a declared 1e30, every later frame's bytes vanish into
	 * rounding and subtracting the exemption returns zero forever, admitting an
	 * unbounded backlog. Summed, an exempt declaration is never added in the first
	 * place, and what remains is exact — every entry over the budget is exempt by
	 * construction, so this adds at most {@link MAX_PENDING_SENDS} terms of at most
	 * {@link MAX_PENDING_SEND_BYTES} each, three orders of magnitude inside the
	 * range where integer addition is exact.
	 */
	#chargedBytes(): number {
		let charged = 0;
		for (const pending of this.#pendingSends) {
			if (!pending.exempt) charged += pending.bytes;
		}
		return charged;
	}

	/**
	 * Whether shedding every peer's queued work but {@link exclude}'s would leave
	 * room for {@link bytes} — the fixed point of the shed loop, evaluated before it
	 * takes anything.
	 *
	 * Modelled on exactly what {@link #shedHeaviestPeer} can reach, so the two
	 * cannot disagree: it skips broadcasts and the requester, and a shed takes a
	 * peer's entries whole. What survives is therefore what this counts, including
	 * the empty-queue floor when nothing survives at all.
	 */
	#shedCouldAdmit(bytes: number, exclude: number): boolean {
		let count = 0;
		let charged = 0;
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer !== 0 && pending.targetPeer !== exclude) continue;
			count++;
			if (!pending.exempt) charged += pending.bytes;
		}
		if (count >= MAX_PENDING_SENDS) return false;
		if (count === 0) return true;
		return charged + bytes <= MAX_PENDING_SEND_BYTES;
	}

	/** Whether admitting {@link bytes} for {@link targetPeer} would have to evict something first. */
	#wouldEvict(targetPeer: number, bytes: number): boolean {
		if (targetPeer !== 0 && this.#pendingForPeer(targetPeer) >= MAX_PEER_PENDING_SENDS) return true;
		return this.#overCapacity(bytes);
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
		const generation = this.#roomGeneration;
		this.#notServing.set(peerId, { reason: "shed", settled: true });
		queueMicrotask(() => {
			// Same ownership rule as every other deferral here. A transient reconnect
			// lands a task later so this is protected by timing alone, but `close()`
			// and `connect()` are synchronous and can both run before the microtask:
			// the mask would then be lifted off a record in the reopened room, and the
			// owner told to drop a peer id that now belongs to somebody else.
			if (generation !== this.#roomGeneration) return;
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
					this.#failFatal(`collab send failed: ${describeThrown(err, THROWN_VALUE_MAX)}; rejoin to resync`);
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
			if (!pending) return;
			// Advance before the writability gate, never behind it. Advancing is what
			// resumes a batch's generator, and resuming past the last frame is what
			// lets go of the snapshot it held — so gating it on the transport keeps a
			// whole session clone reachable, and keeps the entry queued, charged,
			// inside its peer's share and out of the empty-queue floor's way, for as
			// long as the socket buffer takes to drain. The next admission then sheds
			// that peer over a snapshot whose bytes are already in the buffer and
			// cannot be retracted, and tells a guest with a complete replica to rejoin.
			//
			// The head is never a cancelled entry: `#discardWhere` marks and removes in
			// one synchronous pass, so anything still in the array is live.
			const next = pending.frames.next();
			if (next.done) {
				this.#pendingSends.shift();
				continue;
			}
			if (!(await this.#waitForWritable(generation))) return;
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
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
		this.#notServing.clear();
		// With the records. A lease only exists to hold one against eviction, so
		// leaving them behind protects nothing and, across a `connect()` that reopens
		// this socket, would have the reopened room's trim skipping records for
		// replies the closed room was owed.
		this.#peerOps.clear();
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
				// The only way in is an owner frame handler throwing, and `String` on a
				// thrown value is not itself safe — a nested one `RangeError`s, inside a
				// `catch`, which is an unhandled rejection rather than a log line. That
				// holds whether or not the value carries anything a guest sent, so it is
				// not worth deciding: Bun's own parse failures quote fixed prose and no
				// input, and the handlers upstream bound what they raise, but neither of
				// those is a property this catch can enforce.
				logger.debug("collab: frame handler failed", { error: describeThrown(err, THROWN_VALUE_MAX) });
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
			if (record.reason === "left" && record.settled && !this.#peerOps.has(peer)) this.#notServing.delete(peer);
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
