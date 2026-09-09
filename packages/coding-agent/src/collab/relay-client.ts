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
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

interface PendingSend {
	frames: Iterator<CollabFrame | string>;
	targetPeer: number;
	bytes: number;
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
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
	#pendingSendBytes = 0;

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
		if (this.#closed) return;
		try {
			const serialized = JSON.stringify(frame);
			this.#enqueueSend([serialized].values(), targetPeer, Buffer.byteLength(serialized));
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
		}
	}

	/** Keeps a lazy snapshot contiguous with its welcome and ahead of subsequent live traffic. */
	sendBatch(frames: Iterable<CollabFrame>, targetPeer = 0): void {
		if (this.#closed) return;
		this.#enqueueSend(frames[Symbol.iterator](), targetPeer, 0);
	}

	#enqueueSend(frames: Iterator<CollabFrame | string>, targetPeer: number, bytes: number): void {
		if (this.#pendingSends.length >= MAX_PENDING_SENDS || this.#pendingSendBytes + bytes > MAX_PENDING_SEND_BYTES) {
			this.#failOverload();
			return;
		}
		this.#pendingSends.push({ frames, targetPeer, bytes });
		this.#pendingSendBytes += bytes;
		this.#pumpSends();
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
			const sealed = await sealSerialized(this.#opts.key, serialized);
			if (!(await this.#sendEnvelope(packEnvelope(pending.targetPeer, sealed), generation))) return;
			if (this.#closed || generation !== this.#sendGeneration) return;
			this.#pendingSendBytes -= bytes;
		}
	}

	async #sendEnvelope(envelope: Uint8Array, generation: number): Promise<boolean> {
		while (!this.#closed && generation === this.#sendGeneration) {
			const ws = await this.#waitForWritable(generation);
			if (!ws || this.#closed || generation !== this.#sendGeneration) return false;
			if (ws !== this.#ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD)
				continue;
			ws.send(envelope);
			return true;
		}
		return false;
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

	#discardPendingSends(): void {
		this.#sendGeneration++;
		this.#pendingSends.length = 0;
		this.#pendingSendBytes = 0;
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
			this.#discardPendingSends();
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
