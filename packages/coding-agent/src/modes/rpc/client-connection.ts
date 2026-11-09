import type {
	RpcExtensionUIRequest,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcResponse,
	RpcSubagentFrame,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

/** Any frame an RPC server can deliver to a client. */
export type RpcClientFrame =
	| RpcResponse
	| RpcExtensionUIRequest
	| RpcHostToolCallRequest
	| RpcHostToolCancelRequest
	| RpcHostUriRequest
	| RpcHostUriCancelRequest
	| object;

/**
 * One client attached to an RPC session. The stdio transport is the only
 * instance today; a socket transport attaches through the same interface.
 */
export interface RpcClientConn {
	readonly id: string;
	/** Whether this client can present extension UI dialogs. */
	readonly supportsUi: boolean;
	readonly isOpen: boolean;
	send(frame: RpcClientFrame): void;
	close(): void;
}

export interface RpcClientConnectionOptions {
	id?: string;
	/** Defaults to `true`: a transport that cannot draw dialogs opts out explicitly. */
	supportsUi?: boolean;
	send: (frame: RpcClientFrame) => void;
}

let clientSequence = 0;

export class RpcClientConnection implements RpcClientConn {
	readonly id: string;
	readonly supportsUi: boolean;
	#send: (frame: RpcClientFrame) => void;
	#open = true;

	constructor(options: RpcClientConnectionOptions) {
		if (typeof options?.send !== "function") {
			throw new TypeError("RpcClientConnection requires a send sink");
		}
		this.id = options.id ?? `client-${++clientSequence}`;
		this.supportsUi = options.supportsUi !== false;
		this.#send = options.send;
	}

	get isOpen(): boolean {
		return this.#open;
	}

	send(frame: RpcClientFrame): void {
		this.#send(frame);
	}

	close(): void {
		this.#open = false;
	}
}

const SUBAGENT_SUBSCRIPTION_RANK: Record<RpcSubagentSubscriptionLevel, number> = {
	off: 0,
	progress: 1,
	events: 2,
};

/** Attached clients in registration order; one of them owns extension UI. */
export class RpcClientRegistry {
	#connections: RpcClientConn[] = [];
	/**
	 * Subagent streaming is a view preference, never a session-wide switch: each
	 * attached view (stdio or a socket client) records its own level, and the
	 * registry's broadcast filters by it.
	 */
	#subagentSubscriptions = new WeakMap<RpcClientConn, RpcSubagentSubscriptionLevel>();

	register(conn: RpcClientConn): void {
		if (this.#connections.includes(conn)) return;
		this.#connections.push(conn);
	}

	unregister(conn: RpcClientConn): boolean {
		const index = this.#connections.indexOf(conn);
		if (index < 0) return false;
		this.#connections.splice(index, 1);
		return true;
	}

	setSubagentSubscription(conn: RpcClientConn, level: RpcSubagentSubscriptionLevel): void {
		this.#subagentSubscriptions.set(conn, level);
	}

	getSubagentSubscription(conn: RpcClientConn): RpcSubagentSubscriptionLevel {
		return this.#subagentSubscriptions.get(conn) ?? "off";
	}

	/** Whether at least one attached view is still open. */
	hasOpenClients(): boolean {
		return this.#connections.some(conn => conn.isOpen);
	}

	/** Highest level any open view asked for, so the shared bus emits for the union. */
	maxSubagentSubscription(): RpcSubagentSubscriptionLevel {
		let max: RpcSubagentSubscriptionLevel = "off";
		for (const conn of this.#connections) {
			if (!conn.isOpen) continue;
			const level = this.getSubagentSubscription(conn);
			if (SUBAGENT_SUBSCRIPTION_RANK[level] > SUBAGENT_SUBSCRIPTION_RANK[max]) max = level;
		}
		return max;
	}

	/** Deliver a subagent frame only to open views whose own level covers it. */
	broadcastSubagent(frame: RpcSubagentFrame): void {
		const required = SUBAGENT_SUBSCRIPTION_RANK[frame.type === "subagent_event" ? "events" : "progress"];
		for (const conn of this.#connections) {
			if (!conn.isOpen) continue;
			if (SUBAGENT_SUBSCRIPTION_RANK[this.getSubagentSubscription(conn)] < required) continue;
			conn.send(frame);
		}
	}

	/**
	 * The one client that owns extension UI: the oldest open UI-capable
	 * connection. When every UI-capable client has closed, the newest one stays
	 * the sink so the single-transport shutdown drain keeps writing exactly where
	 * it always did.
	 */
	activeUiConn(): RpcClientConn | undefined {
		for (const conn of this.#connections) {
			if (conn.supportsUi && conn.isOpen) return conn;
		}
		for (let index = this.#connections.length - 1; index >= 0; index--) {
			const conn = this.#connections[index]!;
			if (conn.supportsUi) return conn;
		}
		return undefined;
	}

	/** Every open client, in registration order. */
	broadcast(frame: RpcClientFrame): void {
		for (const conn of this.#connections) {
			if (conn.isOpen) conn.send(frame);
		}
	}

	sendUi(frame: RpcClientFrame): boolean {
		const conn = this.activeUiConn();
		if (!conn) return false;
		conn.send(frame);
		return true;
	}
}
