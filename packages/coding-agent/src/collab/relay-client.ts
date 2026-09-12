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
const MAX_PENDING_SEND_BYTES = 16 * 1024 * 1024;
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

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Set while a transient drop is being retried; the next open is a new room. */
	#rejoining = false;
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
	#pendingSendBytes = 0;
	/**
	 * Peers the relay has retired. Sole authority for the queue invariant: **every
	 * entry in {@link #pendingSends} with a non-zero `targetPeer` is work for a
	 * peer absent from here.**
	 *
	 * Entered synchronously in {@link #handleMessage}, before any owner callback
	 * runs, so it changes atomically with respect to anything that can enqueue.
	 * Kept past the departure because decryption reorders dispatch: a frame that
	 * finishes opening after its sender's `peer-left` must still be recognised as
	 * stale.
	 *
	 * The value is whether that ordering obligation is met — whether the frames
	 * received before the departure have been dispatched. Only settled records may
	 * be evicted, so churn cannot retire a tombstone whose frame is still in the
	 * chain; {@link MAX_RETIRED_PEERS} then bounds the settled remainder.
	 */
	#retiredPeers = new Map<number, boolean>();
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
		return !this.#retiredPeers.has(peerId);
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
			this.#enqueueSend([serialized].values(), targetPeer, Buffer.byteLength(serialized));
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
		}
	}

	/** Keeps a snapshot contiguous with its welcome and ahead of subsequent live traffic. */
	sendBatch(frames: Iterable<CollabFrame>, targetPeer = 0): void {
		if (this.#closed) return;
		this.#enqueueSend(frames[Symbol.iterator](), targetPeer, 0);
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
	 * Targeted work is therefore undeliverable and must go. A batch is the
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
		this.#retiredPeers.clear();
		const discarded = this.#discardWhere(pending => pending.targetPeer !== 0);
		if (discarded > 0) logger.debug("collab: discarded targeted sends across a reconnect", { discarded });
	}

	#enqueueSend(frames: Iterator<CollabFrame | string>, targetPeer: number, bytes: number): void {
		// The queue invariant, enforced in one place: targeted work is only ever
		// admitted for a peer still being served. A batch queued for a peer that has
		// left would hold the head of a queue shared with everyone else, which is
		// the stall dropPeer exists to prevent, and reception order settles the
		// peer's lifetime even though decryption reorders dispatch.
		if (targetPeer !== 0 && this.#retiredPeers.has(targetPeer)) {
			logger.debug("collab: refusing frame for a peer that has left", { targetPeer });
			return;
		}
		if (this.#overCapacity(bytes)) {
			this.#failOverload();
			return;
		}
		this.#pendingSends.push({ frames, targetPeer, bytes, cancelled: false });
		this.#pendingSendBytes += bytes;
		this.#pumpSends();
	}

	#overCapacity(bytes: number): boolean {
		return this.#pendingSends.length >= MAX_PENDING_SENDS || this.#pendingSendBytes + bytes > MAX_PENDING_SEND_BYTES;
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
			const bytes = pending.bytes === 0 ? Buffer.byteLength(serialized) : 0;
			if (this.#pendingSendBytes + bytes > MAX_PENDING_SEND_BYTES) {
				this.#failOverload();
				return;
			}
			this.#pendingSendBytes += bytes;
			try {
				const sealed = await sealSerialized(this.#opts.key, serialized);
				if (this.#closed || generation !== this.#sendGeneration) return;
				if (pending.cancelled) continue;
				if ((await this.#sendEnvelope(pending, packEnvelope(pending.targetPeer, sealed), generation)) === "stop") {
					return;
				}
			} finally {
				// Every terminal path that flips the generation also zeroes the counter.
				if (generation === this.#sendGeneration) this.#pendingSendBytes -= bytes;
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
		this.#retiredPeers.clear();
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
		this.#retiredPeers.set(peer, false);
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
			if (this.#retiredPeers.has(peer)) this.#retiredPeers.set(peer, true);
			this.#trimRetired();
		});
	}

	/** Forget the oldest *settled* retirements past the cap; insertion order is Map order. */
	#trimRetired(): void {
		if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
		for (const [peer, settled] of this.#retiredPeers) {
			if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
			if (settled) this.#retiredPeers.delete(peer);
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
