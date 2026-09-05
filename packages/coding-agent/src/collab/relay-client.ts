/**
 * Client-side WebSocket wrapper for collab live-session sharing.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Room-gone and room-full closes and
 * decryption failures are terminal. A host conflict is terminal too, except
 * during a bounded reclaim period after an established host connection drops:
 * there it means the relay has not yet released our own stale registration.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { MIN_SEALED_BYTES, open, seal } from "./crypto";
import type { CollabFrame, RelayControlMessage } from "./protocol";
import { packEnvelope, unpackEnvelope } from "./protocol";

/** Relay close codes that must never trigger a reconnect. */
const FATAL_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * Frames buffered while a reconnect is pending, and the backpressure spill on a live leg.
 * Full means the arrival is refused, not that something queued is evicted: the queue stays
 * the ordered prefix the session emitted, which is what the reconnect case needs, since
 * every guest rejoins the leg that comes back and its snapshot re-derives the tail. A
 * refusal on a live accepted leg is not repaired by anything — sending resumes once the
 * socket drains, so the guest sees a gap — but there both choices leave a gap, and it
 * takes a socket that stops draining for 256 frames to get there.
 */
const MAX_PENDING_SENDS = 256;
/**
 * What relay control may hold while a leg has not settled. Sized in transitions: a
 * `peer-joined`/`peer-left` charges ~312 bytes, so this carries ~26,800 of them, against
 * the 18,528 the reference relay was measured minting into one settle window at its
 * fastest. Past it a transition is dropped, and only a lost `peer-left` costs anything —
 * the session keeps listing a guest that is gone. Nothing client-side can stop control
 * from crowding out control, so the number is the whole defence.
 */
const MAX_HELD_CONTROL_BYTES = 8 * 1024 * 1024;
/** What peers may hold. Control cannot spend it and it cannot spend control's. */
const MAX_HELD_PEER_BYTES = 8 * 1024 * 1024;
/**
 * Every message a leg holds is charged to one of the two budgets, so their sum is what a
 * hold can retain: no message is kept past it, whoever sent it. What a refusal costs is
 * never charged, so the per-leg latch set is memory beside this, bounded by the number of
 * distinct ids the relay mints and dropped with the leg.
 */
const MAX_HELD_INBOUND_BYTES = MAX_HELD_CONTROL_BYTES + MAX_HELD_PEER_BYTES;
/**
 * A stream's first bytes are judged against the whole peer budget rather than against what
 * the budget has left for competition, and this much of the budget is kept out of that
 * competition to make room for them. Without both, the budget is first-come and one guest
 * — the slot cost makes a few hundred KB of small frames enough — spends what the rest of
 * the room needs for its `hello`s, the one message nothing re-sends.
 *
 * What that buys, exactly: traffic past a stream's floor cannot take the last megabyte, so
 * a guest's handshake lands while thousands of them fit in the reserve. It is a reserve,
 * not a per-stream allocation — sixteen ids each holding a full floor spend it — and a
 * stream past its floor competes, so a guest's large frame is still held while the room is
 * quiet: the floor bounds what the room can lose to one stream, not what a guest may send.
 */
const HELD_STREAM_FLOOR_BYTES = 64 * 1024;
const HELD_FLOOR_RESERVE_BYTES = 1024 * 1024;
const HELD_INBOUND_SLOT_BYTES = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

/**
 * Host conflict. Fatal on a cold connect (another host really owns the room),
 * but transient right after our own established socket died: the relay has not
 * yet observed that close and still holds our stale registration. Measured
 * against the live relay, it frees the room immediately once it sees a close, so
 * this only happens on a half-open death, where the stale hold lasts until the
 * relay's own read/ping deadline.
 */
const HOST_CONFLICT_CODE = 4009;
const HOST_CONFLICT_REASON = "a host is already connected for this room";
/** How long a host that just lost an established socket may keep reclaiming its room. */
const HOST_RECLAIM_WINDOW_MS = 120_000;
/**
 * The relay upgrades a socket before it applies room policy, so a leg it is about to
 * reject with 4009 reaches onopen first. A host reconnect stays provisional for this
 * long: only a leg that survives it holds the room.
 */
const LEG_SETTLE_MS = 2_000;

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
	/** Fires when a reconnect produced a socket the relay kept, meaning guests must rejoin. */
	onReconnect?: () => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/**
	 * Envelopes sealed while disconnected, flushed on the next accepted leg. `peer` is the
	 * envelope's target: 0 is a broadcast, anything else is directed at one guest.
	 */
	#pendingSends: { envelope: Uint8Array; peer: number }[] = [];
	/**
	 * Inbound messages — frames and relay control alike, in one queue so they keep one
	 * order — that arrived on a leg which has not settled yet. Replayed once it does and
	 * dropped with the leg if it never does, so nothing the session acts on outlives the
	 * registration that minted the ids it names. Only messages the session could act on are
	 * held: text that is not relay control and bytes that could not open are dropped at
	 * intake rather than charged.
	 */
	#heldInbound: (string | ArrayBuffer | Uint8Array)[] = [];
	/** Charged against MAX_HELD_PEER_BYTES; the map totals this counter, one entry per stream. */
	#heldPeerBytes = 0;
	#heldStreamBytes = new Map<number, number>();
	/** Charged against MAX_HELD_CONTROL_BYTES, which peers cannot spend. */
	#heldControlBytes = 0;
	/**
	 * Peer ids the live leg has heard from. The relay is the only source of a peer id and
	 * it hands out fresh ones per room, so this set is exactly the set of ids that are
	 * addressable right now; anything else belongs to a registration that is gone.
	 */
	#legPeers = new Set<number>();
	/** Settle delay that promotes a provisional reconnect leg to the accepted one. */
	#legSettleTimer: NodeJS.Timeout | undefined;
	/** True once any leg survived relay policy; distinguishes a cold connect from a reconnect. */
	#everAccepted = false;
	/** True once the live leg survived relay policy; a provisional leg may still be rejected. */
	#legAccepted = false;
	/** Epoch ms until which a 4009 counts as a stale-registration retry, 0 = cold. */
	#reclaimUntil = 0;
	/** Backoff counter for conflict retries, kept separate because onopen fires before a 4009 close. */
	#conflictAttempt = 0;

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#everAccepted = false;
		this.#legAccepted = false;
		this.#reclaimUntil = 0;
		this.#conflictAttempt = 0;
		this.#openSocket();
	}

	send(frame: CollabFrame, targetPeer = 0): void {
		// The leg live when the caller issued this frame, captured before the chain can park
		// it behind a seal: a peer id names a guest only on its own relay registration, and
		// reading the field after the await would accept the leg that inherited the number.
		const issuedOn = this.#ws;
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) {
					logger.debug("collab: dropping frame, socket closed", { t: frame.t });
					return;
				}
				// A provisional leg counts as closed for sending: the relay may still
				// reject it, and anything handed to it would be lost with the leg.
				const openWs = this.#ws;
				if (openWs && this.#legAccepted && openWs.readyState === WebSocket.OPEN) {
					this.#drainPendingSends(openWs);
				}
				const sealed = await seal(this.#opts.key, frame);
				// Re-checked after the seal: close() ran while this link was parked, and the
				// buffer it emptied must not be refilled behind a terminal state.
				if (this.#closed) {
					logger.debug("collab: dropping frame sealed across a close", { t: frame.t });
					return;
				}
				// A peer id only means something on the leg that minted it. The relay frees
				// the room when it observes our close and hands ids out from 1 again, so an
				// envelope addressed to a peer this leg never saw — or issued on a leg that
				// has since been replaced — would land on whoever inherited that number.
				// Broadcasts stay valid: the relay fans them to whoever is in the room.
				if (targetPeer !== 0 && (this.#ws !== issuedOn || !this.#legPeers.has(targetPeer))) {
					// While a leg is provisional no id is introduced yet, so the same gate also
					// catches a reply the session offered before its guest was handed over.
					logger.debug("collab: dropping directed frame, its peer is not addressable", {
						t: frame.t,
						peer: targetPeer,
						held: this.#heldInbound.length,
						legAccepted: this.#legAccepted,
					});
					return;
				}
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && this.#legAccepted && ws.readyState === WebSocket.OPEN) {
					if (this.#pendingSends.length > 0) {
						this.#enqueuePendingSend(envelope, targetPeer);
						if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
							this.#drainPendingSends(ws);
						} else {
							this.#scheduleBackpressureDrain(ws);
						}
						return;
					}
					if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
						this.#enqueuePendingSend(envelope, targetPeer);
						this.#scheduleBackpressureDrain(ws);
						return;
					}
					ws.send(envelope);
					return;
				}
				this.#enqueuePendingSend(envelope, targetPeer);
			})
			.catch((err: unknown) => {
				logger.debug("collab: send failed", { error: String(err) });
			});
	}

	#enqueuePendingSend(envelope: Uint8Array, peer: number): void {
		if (this.#pendingSends.length >= MAX_PENDING_SENDS) {
			logger.debug("collab: reconnect buffer full, dropping frame", { peer, queued: this.#pendingSends.length });
			return;
		}
		this.#pendingSends.push({ envelope, peer });
	}

	#drainPendingSends(ws: WebSocket): void {
		while (
			this.#pendingSends.length > 0 &&
			ws.readyState === WebSocket.OPEN &&
			ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
		) {
			const pending = this.#pendingSends.shift();
			if (!pending) return;
			ws.send(pending.envelope);
		}
	}

	#scheduleBackpressureDrain(ws: WebSocket): void {
		if (this.#backpressureDrainTimer !== undefined) return;
		this.#backpressureDrainTimer = setTimeout(() => {
			this.#backpressureDrainTimer = undefined;
			this.#sendChain = this.#sendChain
				.then(async () => {
					if (this.#closed || this.#ws !== ws || !this.#legAccepted || ws.readyState !== WebSocket.OPEN) return;
					this.#drainPendingSends(ws);
					if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
					else this.#flushHeldInbound(ws);
				})
				.catch((err: unknown) => {
					logger.debug("collab: backpressure drain failed", { error: String(err) });
				});
		}, WS_BACKPRESSURE_DRAIN_RETRY_MS);
	}

	/** Drops both timers owned by the live socket: the drain retry and the leg settle. */
	#clearSocketTimers(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
		if (this.#legSettleTimer !== undefined) {
			clearTimeout(this.#legSettleTimer);
			this.#legSettleTimer = undefined;
		}
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearSocketTimers();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#pendingSends.length = 0;
		this.#legPeers.clear();
		this.#dropHeldInbound();
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
		this.#clearSocketTimers();
		this.#legAccepted = false;
		this.#legPeers.clear();
		this.#dropHeldInbound();
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			const reconnect = this.#everAccepted;
			logger.info("collab: relay socket open", { role: this.#opts.role, reconnect });
			// A host reconnect leg is the one the relay may still reject with 4009, and
			// onopen fires before that rejection. Until the leg survives LEG_SETTLE_MS it
			// stays provisional: no backlog drain (the rejected leg would swallow those
			// frames), no reclaim-state reset, and no callback claiming a live room.
			// #reclaimUntil deliberately survives onopen — clearing it here would hammer
			// the relay at the base backoff delay. A cold leg is exempt because it has
			// nothing to lose: no backlog, no room to reclaim, and its consumer needs the
			// open to finish `start()` inside the connect timeout.
			if (reconnect && this.#opts.role === "host") {
				this.#legSettleTimer = setTimeout(() => {
					this.#legSettleTimer = undefined;
					if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
					this.#acceptLeg(ws);
					this.onOpen?.();
					this.onReconnect?.();
				}, LEG_SETTLE_MS);
				return;
			}
			this.#acceptLeg(ws);
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
			this.#clearSocketTimers();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	/**
	 * Promotes the live leg to the one holding the room and flushes what queued while it
	 * was provisional. The reclaim deadline and the conflict ladder deliberately survive:
	 * the settle window is a send/notify heuristic, not an acknowledgement from the relay,
	 * so a 4009 that arrives late (packet loss on an already-degraded path) must still be
	 * reclaimable instead of tearing the room down. They are retired on the next drop of
	 * an accepted leg, which is where a fresh window genuinely starts.
	 */
	#acceptLeg(ws: WebSocket): void {
		this.#legAccepted = true;
		this.#everAccepted = true;
		this.#attempt = 0;
		if (this.#pendingSends.length > 0) {
			this.#drainPendingSends(ws);
			if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
		}
		this.#flushHeldInbound(ws);
	}

	/**
	 * Replays what the leg held, but not before the buffer is empty and the socket is
	 * writable: the session answers these messages with a rejoin handshake, and a handshake
	 * started behind a backlog — or into a congested socket — is the one thing the buffer
	 * bound cannot shed without truncating it. Not ready means the drain timer stays armed
	 * and brings us back here, at the same 25ms cadence the spill already uses.
	 *
	 * On this runtime the wait is normally zero: Bun's client keeps `bufferedAmount` at 0
	 * even under 200 MB of unflushed sends, so the drain above empties the buffer in one
	 * call and the replay runs inline. The check is what keeps the property true where
	 * backpressure is reported, which is the same reason the spill it rides on exists. The
	 * wait itself is bounded only by the buffer draining or the leg dying — a socket that
	 * cannot write cannot deliver a welcome either — and nothing on the guest side bounds
	 * it: `guest.ts` arms its welcome and snapshot timers only inside the first join, so a
	 * resyncing guest has no watchdog of its own. Deferring further would need one.
	 */
	#flushHeldInbound(ws: WebSocket): void {
		if (this.#heldInbound.length === 0) {
			// A refusal can land on an empty hold, so the latches it set have to be given back
			// here as well: the wait they belong to is over, and nothing else reaches them
			// until the leg dies.
			this.#dropHeldInbound();
			return;
		}
		if (this.#pendingSends.length > 0 || ws.bufferedAmount >= WS_BACKPRESSURE_DRAIN_THRESHOLD) {
			this.#scheduleBackpressureDrain(ws);
			return;
		}
		const held = this.#heldInbound;
		this.#dropHeldInbound();
		logger.debug("collab: replaying inbound the leg held", { messages: held.length });
		for (const data of held) this.#handleMessage(ws, data);
	}

	/**
	 * Empties the hold and gives back its budget. Used both when a leg dies — its ids name a
	 * registration the relay has already recycled — and after a replay, which is why it
	 * hands out a fresh array instead of truncating the one the caller is about to walk.
	 */
	#dropHeldInbound(): void {
		this.#heldInbound = [];
		this.#heldPeerBytes = 0;
		this.#heldStreamBytes.clear();
		this.#heldControlBytes = 0;
	}

	/**
	 * The relay control message this text carries, or null when it is not one. Validated all
	 * the way to the fields the consumers read: `null` parses fine and reading `t` off it
	 * throws, `[]` and untagged objects parse fine and would otherwise reach the session
	 * typed as control, and a `peer-left` without a numeric `peer` would have the session
	 * retire `undefined`.
	 */
	#parseControl(data: string): RelayControlMessage | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return null;
		}
		if (typeof parsed !== "object" || parsed === null || !("t" in parsed)) return null;
		if (parsed.t === "room-closed") return { t: "room-closed" };
		if (parsed.t !== "peer-joined" && parsed.t !== "peer-left") return null;
		if (!("peer" in parsed) || typeof parsed.peer !== "number") return null;
		return { t: parsed.t, peer: parsed.peer };
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		// A provisional leg is one the relay may still reject with 4009, and every peer id
		// the messages on it carry was minted for a registration that dies with the leg.
		// Handing them to the session now would have the host answer a guest across a leg
		// that never held the room: the reply is lost with the leg, and a snapshot already
		// promised to a guest cannot be promised again. So inbound is held until the leg
		// settles and dropped with the leg if it never does, so nothing the session acts on
		// outlives the ids it names. It is also what keeps the reconnect buffer free of
		// rejoin handshakes: a provisional leg answers nobody. A non-empty hold keeps
		// holding even on a settled leg, or a message arriving mid-wait would overtake the
		// prefix that is still waiting to be replayed.
		if (!this.#legAccepted || this.#heldInbound.length > 0) {
			const message =
				typeof data === "string" || data instanceof ArrayBuffer || data instanceof Uint8Array ? data : null;
			if (message === null) {
				logger.debug("collab: ignoring inbound of an unexpected type");
				return;
			}
			// Charged an upper bound on what holding it retains — a string is at most UTF-16 in
			// memory — plus a flat slot cost, so a flood of tiny messages spends the ceiling
			// too. Nothing enters the hold unvalidated: text that is not a control message and
			// bytes that are not an envelope are dropped here rather than carried to the
			// replay and discarded there, where they would have spent a budget the room's own
			// traffic needs.
			const bytes =
				(typeof message === "string" ? message.length * 2 : message.byteLength) + HELD_INBOUND_SLOT_BYTES;
			if (typeof message === "string") {
				if (this.#parseControl(message) === null) {
					logger.debug("collab: ignoring malformed control message");
					return;
				}
				// Control spends its own budget, which peers cannot touch, so a room's churn is
				// never turned away by peer traffic: a dropped `peer-left` is the one loss that
				// leaves state behind — a guest the session keeps listing, counting as writable
				// and addressing for the rest of the leg. Past that budget a transition is
				// dropped all the same, because a relay streaming text must not be able to grow
				// the hold; nothing client-side can keep control from crowding out control. A
				// refused control is not latched: relay ids only move forward, so a control
				// arriving after a refused one is never its successor, and latching would
				// refuse the `peer-left` that still fits.
				if (this.#heldControlBytes + bytes > MAX_HELD_CONTROL_BYTES) {
					logger.debug("collab: inbound hold is full of control, dropping message", {
						bytes,
						held: this.#heldInbound.length,
						controlBytes: this.#heldControlBytes,
					});
					return;
				}
				this.#heldInbound.push(message);
				this.#heldControlBytes += bytes;
				return;
			}
			// Held only if `open` could accept it at replay: a payload with no room for an IV
			// and a GCM tag can only fail, and failing there ends the session over bytes this
			// leg was never going to act on. Longer garbage still fails, which is the accepted
			// pre-existing behaviour of any frame that does not decrypt.
			const envelope = unpackEnvelope(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
			if (!envelope || envelope.payload.byteLength < MIN_SEALED_BYTES) {
				logger.debug("collab: ignoring inbound that could not be a sealed frame");
				return;
			}
			// A refusal is per message, and deliberately not sticky. Inbound carries no trains:
			// every guest→host frame is an independent request, and the only order that
			// matters is that a `hello` precedes the rest — which is exactly what a sticky
			// refusal would break. A guest reconnecting flushes what it queued during the
			// outage before its own onOpen sends that `hello`, so refusing the queued frame
			// and then holding its `hello` against it would leave that guest connected,
			// unwelcomed and with no watchdog to notice. Losing the queued prompt is visible
			// to whoever typed it; losing the `hello` is visible to nobody.
			const peer = envelope.peerId;
			// Within its own floor a stream is judged against the whole peer budget; past it,
			// against what the floor reserve leaves — so a loud guest can fill the hold with
			// real traffic and the next guest's handshake still gets in. Every id is accounted
			// the same way, including 0, the broadcast slot.
			const streamBytes = this.#heldStreamBytes.get(peer) ?? 0;
			const budget =
				streamBytes + bytes <= HELD_STREAM_FLOOR_BYTES
					? MAX_HELD_PEER_BYTES
					: MAX_HELD_PEER_BYTES - HELD_FLOOR_RESERVE_BYTES;
			if (this.#heldPeerBytes + bytes > budget) {
				logger.debug("collab: inbound hold is full, dropping message", {
					bytes,
					peer,
					held: this.#heldInbound.length,
					peerBytes: this.#heldPeerBytes,
					streamBytes,
				});
				return;
			}
			this.#heldInbound.push(message);
			this.#heldPeerBytes += bytes;
			this.#heldStreamBytes.set(peer, streamBytes + bytes);
			return;
		}
		if (typeof data === "string") {
			const msg = this.#parseControl(data);
			if (msg === null) {
				logger.debug("collab: ignoring malformed control message");
				return;
			}
			// The gate reads this synchronously, so a departed id stops being addressable at
			// once, while the session is told on the recv chain: control and frames share one
			// order, or a peer-left could land before the frame the relay routed ahead of it
			// and leave the session holding a guest it had already been told was gone. The
			// chain also means a control message can now be dropped on a leg change instead
			// of always firing — only ever a notice about a room the consumer is tearing down,
			// since onClose(willReconnect) already clears the peers it would name.
			if (msg.t === "peer-left") this.#legPeers.delete(msg.peer);
			this.#recvChain = this.#recvChain
				.then(() => {
					if (this.#ws !== ws) return;
					this.onControl?.(msg);
				})
				.catch((err: unknown) => {
					logger.debug("collab: control handler failed", { error: String(err) });
				});
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) return;
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		// Recorded before decryption: a peer becomes addressable as soon as the relay routes
		// its traffic to us, whether or not this particular frame opens.
		if (envelope.peerId !== 0) this.#legPeers.add(envelope.peerId);
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: CollabFrame;
				try {
					frame = await open(this.#opts.key, envelope.payload);
				} catch {
					// The same recheck the success arm makes: this frame may have finished
					// decrypting on a leg that has since died. The bytes are just as broken
					// either way — what depends on the leg is whether ending the session over
					// them is warranted, and killing a reconnect the client already promised,
					// for a frame nobody can act on, is not.
					if (this.#ws !== ws) {
						logger.debug("collab: dropping a frame that failed to open on a leg already gone", {
							peer: envelope.peerId,
						});
						return;
					}
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				logger.debug("collab: frame handler failed", { error: String(err) });
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#clearSocketTimers();
		// Only a leg that survived relay policy proves we held the room. A leg that died
		// before or during its settle window renews nothing, or alternating pre-open drops
		// and 4009 rejections would extend the reclaim deadline forever.
		const legAccepted = this.#legAccepted;
		this.#legAccepted = false;
		// The peers this leg knew died with it, so their ids are stale; the relay hands the
		// same numbers to whoever connects next. Buffered broadcasts survive; directed
		// frames and inbound the leg never got to answer cannot.
		this.#legPeers.clear();
		this.#dropHeldInbound();
		const dropped = this.#pendingSends.reduce((count, entry) => (entry.peer === 0 ? count : count + 1), 0);
		if (dropped > 0) {
			this.#pendingSends = this.#pendingSends.filter(entry => entry.peer === 0);
			logger.debug("collab: dropped buffered directed frames, their peers are gone", { dropped });
		}

		const reclaimMsLeft = this.#reclaimUntil - Date.now();
		const isConflict = code === HOST_CONFLICT_CODE && this.#opts.role === "host" && this.#everAccepted;
		if (isConflict && reclaimMsLeft > 0) {
			logger.debug("collab: relay still holds the previous host, retrying", {
				code,
				attempt: this.#conflictAttempt,
				reclaimMsLeft,
			});
			this.onClose?.("relay has not released the previous host yet", true);
			// Capped at the deadline, so the ladder always spends the window it advertises:
			// an unclamped 30s step from ~92s would open at 122s, where the leg is already
			// fatal on arrival and the tail of the window goes unprobed.
			this.#scheduleRetry(this.#conflictAttempt++, reclaimMsLeft);
			return;
		}

		const fatalReason = code === HOST_CONFLICT_CODE ? HOST_CONFLICT_REASON : FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			logger.info("collab: relay closed the socket permanently", {
				code,
				reason: fatalReason,
				role: this.#opts.role,
			});
			this.onClose?.(fatalReason, false);
			return;
		}

		// Only a leg the relay kept opens a fresh reclaim window and ladder; a provisional
		// or pre-open death keeps the previous deadline and attempt count.
		if (legAccepted) {
			if (this.#opts.role === "host") this.#reclaimUntil = Date.now() + HOST_RECLAIM_WINDOW_MS;
			this.#conflictAttempt = 0;
		}
		logger.info("collab: relay connection dropped, reconnecting", { code, reason, attempt: this.#attempt });
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		// Capped at the deadline like the conflict ladder: a 30s step from the tail of the
		// window would open the next leg past it and leave the last stretch of the reclaim
		// period — the part where the relay has usually released the room — unprobed.
		const reclaimLeftMs = this.#reclaimUntil - Date.now();
		this.#scheduleRetry(this.#attempt++, reclaimLeftMs > 0 ? reclaimLeftMs : Number.POSITIVE_INFINITY);
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
		this.#legPeers.clear();
		this.#dropHeldInbound();
		const ws = this.#ws;
		this.#ws = null;
		this.#clearSocketTimers();
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	/**
	 * Arms the single retry timer with the exponential step for `attempt`, jittered by ±25%
	 * so reconnecting clients do not align, and never longer than `capMs` — the reclaim
	 * deadline passes itself here so a conflict retry cannot be scheduled past the window
	 * it is trying to spend.
	 */
	#scheduleRetry(attempt: number, capMs = Number.POSITIVE_INFINITY): void {
		const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) * (0.75 + Math.random() * 0.5);
		const delayMs = Math.min(backoffMs, capMs);
		logger.debug("collab: reconnect scheduled", { attempt, delayMs: Math.round(delayMs) });
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delayMs);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
