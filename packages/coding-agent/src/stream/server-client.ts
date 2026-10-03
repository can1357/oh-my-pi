import {
	STREAM_CLOSE_BAD_CHANNEL,
	STREAM_CLOSE_FORBIDDEN,
	STREAM_CLOSE_HOST_CONFLICT,
	STREAM_CLOSE_PROTO_MISMATCH,
	STREAM_CLOSE_UNAUTHORIZED,
	STREAM_PROTO,
	type StreamChatMessage,
	type StreamHostFrame,
	type StreamPaneFrame,
	type StreamServerToHost,
} from "@oh-my-pi/pi-wire";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export interface StreamServerFatalError {
	code: number;
	message: string;
}

export interface StreamServerClientOptions {
	url: string;
	title: string;
	/** Bearer token for the host socket, resolved before every dial; null aborts with an unauthorized fatal. */
	token: () => Promise<string | null>;
	/** Current pane snapshots, emitted immediately after every host hello. */
	replay: () => Iterable<StreamPaneFrame>;
	onFrame: (frame: StreamServerToHost) => void;
	onFatal: (error: StreamServerFatalError) => void;
	/** Non-fatal drop; `delayMs` is the wait before the next dial. */
	onDisconnect?: (delayMs: number) => void;
	/** Test seam; production uses capped exponential backoff with jitter. */
	reconnectDelay?: (attempt: number) => number;
}

/** Reconnecting host-side link to the public stream server. Live deltas are never queued. */
export class StreamServerClient {
	readonly #options: StreamServerClientOptions;
	#socket: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	#closed = false;
	#title: string;

	constructor(options: StreamServerClientOptions) {
		this.#options = options;
		this.#title = options.title;
	}

	start(): void {
		if (this.#closed || this.#socket || this.#retryTimer) return;
		void this.#connect();
	}

	/** Send only on the current open socket. Disconnected deltas are represented by the next replay. */
	send(frame: StreamHostFrame): boolean {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(frame));
		return true;
	}

	setTitle(title: string): void {
		this.#title = title;
		this.send({ t: "title", title });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
		const socket = this.#socket;
		this.#socket = null;
		if (!socket) return;
		try {
			socket.close(1000);
		} catch {
			// Already closing or closed.
		}
	}

	async #connect(): Promise<void> {
		if (this.#closed) return;
		let token: string | null;
		try {
			token = await this.#options.token();
		} catch (error) {
			this.#failUnauthorized(
				`could not read the stencil.so credential: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (this.#closed) return;
		if (!token) {
			this.#failUnauthorized("no stencil.so credential");
			return;
		}
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.#options.url, { headers: { Authorization: `Bearer ${token}` } });
		} catch {
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		socket.onopen = () => {
			if (this.#socket !== socket || this.#closed) return;
			socket.send(JSON.stringify({ t: "hello", proto: STREAM_PROTO, title: this.#title } satisfies StreamHostFrame));
			for (const frame of this.#options.replay()) socket.send(JSON.stringify(frame));
		};
		socket.onmessage = event => {
			if (this.#socket !== socket || this.#closed) return;
			const frame = parseServerFrame(event.data);
			if (!frame) return;
			if (frame.t === "welcome") this.#attempt = 0;
			this.#options.onFrame(frame);
		};
		socket.onerror = () => {
			// The close event owns retry and fatal-close handling.
		};
		socket.onclose = event => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			if (this.#closed) return;
			const fatalMessage = fatalCloseMessage(event.code, event.reason);
			if (fatalMessage) {
				this.#closed = true;
				this.#options.onFatal({ code: event.code, message: fatalMessage });
				return;
			}
			this.#scheduleReconnect(true);
		};
	}

	#failUnauthorized(message: string): void {
		this.#closed = true;
		this.#options.onFatal({ code: STREAM_CLOSE_UNAUTHORIZED, message });
	}

	#scheduleReconnect(dropped = false): void {
		if (this.#closed || this.#retryTimer) return;
		const attempt = this.#attempt++;
		const delay = this.#options.reconnectDelay?.(attempt) ?? reconnectDelay(attempt);
		if (dropped) this.#options.onDisconnect?.(delay);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			void this.#connect();
		}, delay);
	}
}

function reconnectDelay(attempt: number): number {
	const exponential = Math.min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2 ** Math.min(attempt, 30));
	return Math.min(MAX_RECONNECT_MS, Math.round(exponential * (0.75 + Math.random() * 0.5)));
}

function fatalCloseMessage(code: number, reason: string): string | undefined {
	if (code === STREAM_CLOSE_HOST_CONFLICT) return "channel already has a live host";
	if (code === STREAM_CLOSE_UNAUTHORIZED) return reason || "stream server rejected the stencil.so credential";
	if (code === STREAM_CLOSE_FORBIDDEN) return reason || "channel belongs to another stencil.so account";
	if (code === STREAM_CLOSE_BAD_CHANNEL || code === STREAM_CLOSE_PROTO_MISMATCH) {
		return reason || `stream server rejected the connection (${code})`;
	}
	return undefined;
}

function parseServerFrame(data: unknown): StreamServerToHost | undefined {
	let text: string;
	if (typeof data === "string") {
		text = data;
	} else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
		text = new TextDecoder().decode(data);
	} else {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") return undefined;
		const frame = value as Record<string, unknown>;
		switch (frame.t) {
			case "welcome":
				return typeof frame.proto === "number" && typeof frame.channel === "string" && typeof frame.url === "string"
					? (frame as StreamServerToHost)
					: undefined;
			case "viewers":
				return typeof frame.n === "number" ? (frame as StreamServerToHost) : undefined;
			case "chat":
				return isChatMessage(frame.msg) ? (frame as StreamServerToHost) : undefined;
			case "error":
				return typeof frame.message === "string" ? (frame as StreamServerToHost) : undefined;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

function isChatMessage(value: unknown): value is StreamChatMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "number" &&
		typeof message.name === "string" &&
		typeof message.text === "string" &&
		typeof message.ts === "number" &&
		(message.host === undefined || typeof message.host === "boolean")
	);
}
