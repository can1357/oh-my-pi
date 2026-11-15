/**
 * Wire protocol shared by `extension.ts` (inside omp) and `peer-cli.ts` (the stand-in for a mesh
 * of remote agents): newline-delimited JSON over a Unix domain socket. The peer side listens; the
 * bridge connects. One connection per omp root session.
 */
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-coding-agent";

/** Written by the peer CLI before it listens; read by the bridge at `session_start`. */
export interface Roster {
	/** Namespace the bridge claims; remote ids are `@<namespace>/<peer>`. */
	namespace: string;
	/** Unix socket path the peer CLI listens on. */
	socket: string;
	/** Bare peer names registered as `remote` agents. */
	peers: string[];
}

/** Bridge → peer. */
export type BridgeMessage =
	| { type: "hello"; agentId: string; namespace: string }
	| { type: "outbound"; id: string; from: string; to: string; toName: string; body: string; expectsReply: boolean }
	| { type: "receipt"; id: string; receipt: IrcDeliveryReceipt; ompId?: string };

/** Peer → bridge. */
export type PeerMessage =
	| { type: "inbound"; id: string; from: string; to: string; body: string; expectsReply: boolean }
	| { type: "ack"; id: string; receipt: IrcDeliveryReceipt };

export function encodeLine(message: BridgeMessage | PeerMessage): string {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Accumulates socket chunks and yields complete JSON lines. A malformed line is skipped and
 * reported through `onError` rather than tearing the connection down. One decoder per connection:
 * UTF-8 is decoded in streaming mode so a multi-byte character split across two chunks survives.
 */
export class LineDecoder<T> {
	#buffer = "";
	readonly #utf8 = new TextDecoder();

	constructor(private readonly onError: (line: string, error: unknown) => void) {}

	push(chunk: Uint8Array | string): T[] {
		this.#buffer += typeof chunk === "string" ? chunk : this.#utf8.decode(chunk, { stream: true });
		const messages: T[] = [];
		let newline = this.#buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim().length > 0) {
				try {
					messages.push(JSON.parse(line) as T);
				} catch (error) {
					this.onError(line, error);
				}
			}
			newline = this.#buffer.indexOf("\n");
		}
		return messages;
	}
}

/**
 * Writes JSON lines to a Bun socket without assuming a write completes. `Bun.Socket.write()` may
 * accept fewer bytes than offered once the kernel buffer is full — an IRC body has no short-line
 * bound, and a backed-up peer stalls the buffer — so the unwritten suffix is kept at the head of a
 * backlog and flushed from the socket's `drain` callback. Records are written whole and in order,
 * so a long line never truncates (acks would time out) or interleaves with the next record. One
 * writer per connection: `attach` drops the backlog of a replaced socket, whose records nobody
 * would ack.
 */
export class LineWriter {
	readonly #backlog: Uint8Array[] = [];
	#socket: Bun.Socket | undefined;

	attach(socket: Bun.Socket): void {
		this.#socket = socket;
		this.#backlog.length = 0;
	}

	detach(): void {
		this.#socket = undefined;
		this.#backlog.length = 0;
	}

	get connected(): boolean {
		return this.#socket !== undefined;
	}

	/** Queue one record and write as much as the socket accepts. False when no socket is attached. */
	write(message: BridgeMessage | PeerMessage): boolean {
		if (!this.#socket) return false;
		this.#backlog.push(new TextEncoder().encode(encodeLine(message)));
		this.flush();
		return true;
	}

	/** Write the backlog head-first until the socket stops accepting; the `drain` callback calls this. */
	flush(): void {
		const socket = this.#socket;
		if (!socket) return;
		while (this.#backlog.length > 0) {
			const head = this.#backlog[0];
			const written = socket.write(head);
			if (written < head.byteLength) {
				if (written > 0) this.#backlog[0] = head.subarray(written);
				return;
			}
			this.#backlog.shift();
		}
	}
}

/** Minimal structural validation of a roster file. Throws a message naming the offending field. */
export function parseRoster(value: unknown): Roster {
	if (typeof value !== "object" || value === null) throw new Error("roster must be a JSON object");
	const namespace = "namespace" in value ? value.namespace : undefined;
	const socket = "socket" in value ? value.socket : undefined;
	const peers = "peers" in value ? value.peers : undefined;
	if (typeof namespace !== "string" || namespace.length === 0) throw new Error("roster.namespace must be a string");
	if (typeof socket !== "string" || socket.length === 0) throw new Error("roster.socket must be a string");
	if (!Array.isArray(peers) || !peers.every(peer => typeof peer === "string" && peer.length > 0)) {
		throw new Error("roster.peers must be an array of non-empty strings");
	}
	return { namespace, socket, peers };
}
