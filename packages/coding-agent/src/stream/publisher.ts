import { IpcConnection } from "@oh-my-pi/pi-natives";
import type { StreamChatMessage } from "@oh-my-pi/pi-wire";
import type { TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { STREAM_FLUSH_INTERVAL_MS, StreamPaintEncoder } from "./paint-encoder";
import { streamSocketEndpoint } from "./paths";
import { STREAM_LOCAL_PROTO, type StreamSessionFrame, type StreamStreamerFrame } from "./protocol";
import type { StreamRedactor } from "./redactor";

const CONNECT_TIMEOUT_MS = 500;
const QUIET_CONNECT_ERRORS: Record<string, true> = {
	ENOENT: true,
	ECONNREFUSED: true,
	ENOTSOCK: true,
	ETIMEDOUT: true,
};

export interface StreamPublisherOptions {
	cwd: string;
	sessionId: string;
	title: string;
	tui: TUI;
	redactor: StreamRedactor;
	onStatus: (status: { viewers: number } | null) => void;
	onChat?: (message: StreamChatMessage) => void;
}

export interface LazyStreamPublisherOptions extends Omit<StreamPublisherOptions, "redactor"> {
	loadRedactor: () => Promise<StreamRedactor>;
}

interface OpenedStreamSocket {
	conn: IpcConnection;
	takeQueuedFrames(): StreamStreamerFrame[];
	setFrameHandler(handler: (frame: StreamStreamerFrame) => void): void;
	/** Fires once when the connection closes; replays immediately if it already did. */
	setCloseHandler(handler: (reason: string | null) => void): void;
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function logConnectFailure(error: unknown): void {
	const code = errorCode(error);
	if (code && QUIET_CONNECT_ERRORS[code]) {
		logger.debug("stream: local publisher unavailable", { code });
		return;
	}
	logger.debug("stream: local publisher connection failed", { error: String(error) });
}

function parseFrame(line: string): StreamStreamerFrame | null {
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") return null;
		return value as StreamStreamerFrame;
	} catch {
		logger.debug("stream: ignoring malformed local frame");
		return null;
	}
}

async function openStreamSocket(options: Omit<StreamPublisherOptions, "redactor">): Promise<OpenedStreamSocket | null> {
	let endpoint: string;
	try {
		endpoint = await streamSocketEndpoint(options.cwd);
	} catch (error) {
		logConnectFailure(error);
		return null;
	}

	let conn: IpcConnection;
	try {
		conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS });
	} catch (error) {
		logConnectFailure(error);
		return null;
	}

	let settled = false;
	let frameHandler: ((frame: StreamStreamerFrame) => void) | undefined;
	let closeHandler: ((reason: string | null) => void) | undefined;
	let closeReason: string | null | undefined;
	const queuedFrames: StreamStreamerFrame[] = [];
	const { promise, resolve } = Promise.withResolvers<OpenedStreamSocket | null>();
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		logger.debug("stream: local publisher connection timed out");
		conn.destroy();
		resolve(null);
	}, CONNECT_TIMEOUT_MS);
	timer.unref();

	const finishNull = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error !== undefined) logConnectFailure(error);
		conn.destroy();
		resolve(null);
	};

	const handleLine = (line: string): void => {
		const frame = parseFrame(line);
		if (!frame) return;
		if (!settled) {
			if (frame.t !== "welcome") {
				finishNull(new Error("streamer did not welcome session"));
				return;
			}
			if (frame.proto !== STREAM_LOCAL_PROTO) {
				finishNull(new Error(`streamer protocol mismatch: ${frame.proto}`));
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({
				conn,
				takeQueuedFrames: () => queuedFrames.splice(0),
				setFrameHandler: handler => {
					frameHandler = handler;
				},
				setCloseHandler: handler => {
					closeHandler = handler;
					if (closeReason !== undefined) handler(closeReason);
				},
			});
			return;
		}
		if (frameHandler) frameHandler(frame);
		else queuedFrames.push(frame);
	};
	conn.start(
		frame => {
			if (!conn.closed) handleLine(frame);
		},
		reason => {
			closeReason = reason;
			if (!settled) finishNull(reason === null ? undefined : new Error(reason));
			else closeHandler?.(reason);
		},
	);
	const hello: StreamSessionFrame = {
		t: "hello",
		proto: STREAM_LOCAL_PROTO,
		sessionId: options.sessionId,
		title: options.title,
		cols: options.tui.terminal.columns,
		rows: options.tui.terminal.rows,
	};
	conn.send(JSON.stringify(hello));
	return promise;
}

/** Publishes one interactive session's already-redacted terminal rows. */
export class StreamPublisher {
	readonly #conn: IpcConnection;
	readonly #tui: TUI;
	readonly #encoder: StreamPaintEncoder;
	readonly #onStatus: StreamPublisherOptions["onStatus"];
	readonly #onChat: StreamPublisherOptions["onChat"];
	#disposed = false;
	#flushTimer: NodeJS.Timeout | undefined;
	#backpressured = false;
	#awaitingDrain = false;
	#unsubscribePaint: (() => void) | undefined;

	static async connect(options: StreamPublisherOptions): Promise<StreamPublisher | null> {
		const opened = await openStreamSocket(options);
		if (!opened) return null;
		return StreamPublisher.#create(opened, options, options.redactor);
	}

	/** Connect and complete the protocol handshake before collecting local secrets. */
	static async connectLazy(options: LazyStreamPublisherOptions): Promise<StreamPublisher | null> {
		const opened = await openStreamSocket(options);
		if (!opened) return null;
		let redactor: StreamRedactor;
		try {
			redactor = await options.loadRedactor();
		} catch (error) {
			logger.debug("stream: could not initialize row redaction", { error: String(error) });
			opened.conn.destroy();
			return null;
		}
		return StreamPublisher.#create(opened, options, redactor);
	}

	static #create(
		opened: OpenedStreamSocket,
		options: Omit<StreamPublisherOptions, "redactor">,
		redactor: StreamRedactor,
	): StreamPublisher | null {
		if (opened.conn.closed) return null;
		const publisher = new StreamPublisher(opened.conn, options, redactor);
		opened.setFrameHandler(frame => publisher.#handleFrame(frame));
		opened.setCloseHandler(reason => {
			if (reason !== null) logger.debug("stream: local publisher connection failed", { reason });
			publisher.#detach();
		});
		publisher.#onStatus({ viewers: 0 });
		publisher.#unsubscribePaint = publisher.#tui.addPaintListener(paint => {
			if (publisher.#disposed) return;
			publisher.#encoder.push(paint);
			publisher.#scheduleFlush();
		});
		for (const frame of opened.takeQueuedFrames()) publisher.#handleFrame(frame);
		return publisher;
	}

	constructor(conn: IpcConnection, options: Omit<StreamPublisherOptions, "redactor">, redactor: StreamRedactor) {
		this.#conn = conn;
		this.#tui = options.tui;
		this.#encoder = new StreamPaintEncoder(
			{ columns: options.tui.terminal.columns, rows: options.tui.terminal.rows },
			redactor,
		);
		this.#onStatus = options.onStatus;
		this.#onChat = options.onChat;
	}

	/** Swap the row redactor and force a full repaint so the live viewport is re-redacted. */
	setRedactor(redactor: StreamRedactor): void {
		if (this.#disposed) return;
		this.#encoder.setRedactor(redactor);
		this.#tui.requestRender(true);
	}

	#scheduleFlush(): void {
		if (this.#flushTimer || this.#disposed) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flush();
		}, STREAM_FLUSH_INTERVAL_MS);
		this.#flushTimer.unref();
	}

	#write(frame: StreamSessionFrame): void {
		if (this.#disposed) return;
		if (this.#conn.send(JSON.stringify(frame))) return;
		this.#backpressured = true;
		if (this.#awaitingDrain) return;
		this.#awaitingDrain = true;
		void this.#conn.drained().then(() => {
			this.#awaitingDrain = false;
			this.#handleDrain();
		});
	}

	#flush(): void {
		if (this.#disposed) return;
		for (const frame of this.#encoder.drain({ screen: !this.#backpressured })) this.#write(frame);
	}

	#handleDrain(): void {
		if (this.#disposed || !this.#backpressured) return;
		this.#backpressured = false;
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#encoder.resync();
		this.#flush();
	}

	#handleFrame(frame: StreamStreamerFrame): void {
		if (this.#disposed) return;
		switch (frame.t) {
			case "welcome":
				break;
			case "viewers":
				this.#onStatus({ viewers: frame.n });
				break;
			case "chat":
				this.#onChat?.(frame.msg);
				break;
			case "bye":
				this.#detach();
				break;
		}
	}

	#detach(): void {
		if (!this.#release()) return;
		this.#conn.destroy();
	}

	dispose(): void {
		if (!this.#release()) return;
		this.#conn.end();
	}

	/** Stop observing paints; false when already released. */
	#release(): boolean {
		if (this.#disposed) return false;
		this.#disposed = true;
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#unsubscribePaint?.();
		this.#unsubscribePaint = undefined;
		this.#onStatus(null);
		return true;
	}
}
