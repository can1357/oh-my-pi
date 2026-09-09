/**
 * Client-side WebSocket wrapper for collab live-session sharing.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Fatal relay close codes (room gone,
 * host conflict, room full) and decryption failures never reconnect.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { open, seal } from "./crypto";
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
/** Max enveloped frames buffered while a reconnect is pending; overflow is dropped. */
const MAX_PENDING_SENDS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

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
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array[] = [];

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
		this.#openSocket();
	}

	send(frame: CollabFrame, targetPeer = 0): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) {
					logger.debug("collab: dropping frame, socket closed", { t: frame.t });
					return;
				}
				const openWs = this.#ws;
				if (openWs && openWs.readyState === WebSocket.OPEN) this.#drainPendingSends(openWs);
				const sealed = await seal(this.#opts.key, frame);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					if (this.#pendingSends.length > 0) {
						this.#enqueuePendingSend(envelope, frame.t);
						if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
							this.#drainPendingSends(ws);
						} else {
							this.#scheduleBackpressureDrain(ws);
						}
						return;
					}
					if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
						this.#enqueuePendingSend(envelope, frame.t);
						this.#scheduleBackpressureDrain(ws);
						return;
					}
					ws.send(envelope);
					return;
				}
				this.#enqueuePendingSend(envelope, frame.t);
			})
			.catch((err: unknown) => {
				logger.debug("collab: send failed", { error: String(err) });
			});
	}

	#enqueuePendingSend(envelope: Uint8Array, frameType: CollabFrame["t"]): void {
		if (this.#pendingSends.length >= MAX_PENDING_SENDS) {
			logger.debug("collab: dropping frame, reconnect buffer full", { t: frameType });
			return;
		}
		this.#pendingSends.push(envelope);
	}

	#drainPendingSends(ws: WebSocket): void {
		while (
			this.#pendingSends.length > 0 &&
			ws.readyState === WebSocket.OPEN &&
			ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
		) {
			const envelope = this.#pendingSends.shift();
			if (!envelope) return;
			ws.send(envelope);
		}
	}

	#scheduleBackpressureDrain(ws: WebSocket): void {
		if (this.#backpressureDrainTimer !== undefined) return;
		this.#backpressureDrainTimer = setTimeout(() => {
			this.#backpressureDrainTimer = undefined;
			this.#sendChain = this.#sendChain
				.then(async () => {
					if (this.#closed || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
					this.#drainPendingSends(ws);
					if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
				})
				.catch((err: unknown) => {
					logger.debug("collab: backpressure drain failed", { error: String(err) });
				});
		}, WS_BACKPRESSURE_DRAIN_RETRY_MS);
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
		this.#pendingSends.length = 0;
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
			if (this.#pendingSends.length > 0) {
				this.#drainPendingSends(ws);
				if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
			}
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
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				logger.debug("collab: ignoring malformed control message");
			}
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
		this.#clearBackpressureDrain();
		const fatalReason = FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
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
