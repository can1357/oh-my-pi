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
 * reported through `onError` rather than tearing the connection down.
 */
export class LineDecoder<T> {
	#buffer = "";

	constructor(private readonly onError: (line: string, error: unknown) => void) {}

	push(chunk: Uint8Array | string): T[] {
		this.#buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
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
