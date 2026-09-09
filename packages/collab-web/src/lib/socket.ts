/**
 * Browser WebSocket wrapper for collab live-session sharing (vendored mirror
 * of `@oh-my-pi/pi-coding-agent/src/collab/relay-client.ts` semantics).
 *
 * Connects to a relay room, seals/opens AES-GCM frames in strict order, and
 * reconnects with exponential backoff on transient drops. Fatal relay close
 * codes (room gone, host conflict, room full) and decryption failures never
 * reconnect.
 */

import type { GuestFrame, HostFrame, RelayControlMessage } from "@oh-my-pi/pi-wire";
import { open, seal } from "./codec";
import { packEnvelope, unpackEnvelope } from "./link";

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

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: HostFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires once per terminal close (intentional, fatal code, or bad key). willReconnect=true for transient drops that will retry. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];

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

	send(frame: GuestFrame, targetPeer = 0): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) return;
				const sealed = await seal(await this.#opts.key, frame);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(envelope);
					return;
				}
				if (this.#pendingSends.length >= MAX_PENDING_SENDS) return;
				this.#pendingSends.push(envelope);
			})
			.catch(() => {
				// dropped frame; the socket-level close path reports actionable failures
			});
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
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
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			for (const envelope of this.#pendingSends) ws.send(envelope);
			this.#pendingSends.length = 0;
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
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: HostFrame;
				try {
					frame = (await open(await this.#opts.key, envelope.payload)) as HostFrame;
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
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
