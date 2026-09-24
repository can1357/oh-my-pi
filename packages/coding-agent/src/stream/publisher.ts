import * as net from "node:net";
import type { StreamChatMessage } from "@oh-my-pi/pi-wire";
import type { TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { STREAM_FLUSH_INTERVAL_MS, StreamPaintEncoder } from "./paint-encoder";
import { streamSocketEndpoint } from "./paths";
import { encodeStreamFrame, STREAM_LOCAL_PROTO, type StreamSessionFrame, type StreamStreamerFrame } from "./protocol";
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
	socket: net.Socket;
	takeQueuedFrames(): StreamStreamerFrame[];
	setFrameHandler(handler: (frame: StreamStreamerFrame) => void): void;
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

	const socket = net.createConnection(endpoint);
	let input = "";
	let settled = false;
	let frameHandler: ((frame: StreamStreamerFrame) => void) | undefined;
	const queuedFrames: StreamStreamerFrame[] = [];
	const { promise, resolve } = Promise.withResolvers<OpenedStreamSocket | null>();
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		logger.debug("stream: local publisher connection timed out");
		socket.destroy();
		resolve(null);
	}, CONNECT_TIMEOUT_MS);
	timer.unref();

	const finishNull = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error !== undefined) logConnectFailure(error);
		socket.destroy();
		resolve(null);
	};

	socket.on("error", error => {
		if (!settled) finishNull(error);
	});
	socket.once("connect", () => {
		const hello: StreamSessionFrame = {
			t: "hello",
			proto: STREAM_LOCAL_PROTO,
			sessionId: options.sessionId,
			title: options.title,
			cols: options.tui.terminal.columns,
			rows: options.tui.terminal.rows,
		};
		socket.write(encodeStreamFrame(hello));
	});
	socket.on("data", chunk => {
		input += chunk.toString("utf8");
		for (;;) {
			const newline = input.indexOf("\n");
			if (newline < 0) break;
			const line = input.slice(0, newline);
			input = input.slice(newline + 1);
			if (!line) continue;
			const frame = parseFrame(line);
			if (!frame) continue;
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
					socket,
					takeQueuedFrames: () => queuedFrames.splice(0),
					setFrameHandler: handler => {
						frameHandler = handler;
					},
				});
				continue;
			}
			if (frameHandler) frameHandler(frame);
			else queuedFrames.push(frame);
		}
	});
	socket.once("close", () => {
		if (!settled) finishNull();
	});
	return promise;
}

/** Publishes one interactive session's already-redacted terminal rows. */
export class StreamPublisher {
	readonly #socket: net.Socket;
	readonly #tui: TUI;
	readonly #encoder: StreamPaintEncoder;
	readonly #onStatus: StreamPublisherOptions["onStatus"];
	readonly #onChat: StreamPublisherOptions["onChat"];
	#disposed = false;
	#flushTimer: NodeJS.Timeout | undefined;
	#backpressured = false;
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
			opened.socket.destroy();
			return null;
		}
		return StreamPublisher.#create(opened, options, redactor);
	}

	static #create(
		opened: OpenedStreamSocket,
		options: Omit<StreamPublisherOptions, "redactor">,
		redactor: StreamRedactor,
	): StreamPublisher | null {
		if (opened.socket.destroyed) return null;
		const publisher = new StreamPublisher(opened.socket, options, redactor);
		opened.setFrameHandler(frame => publisher.#handleFrame(frame));
		publisher.#onStatus({ viewers: 0 });
		publisher.#unsubscribePaint = publisher.#tui.addPaintListener(paint => {
			if (publisher.#disposed) return;
			publisher.#encoder.push(paint);
			publisher.#scheduleFlush();
		});
		for (const frame of opened.takeQueuedFrames()) publisher.#handleFrame(frame);
		return publisher;
	}

	constructor(socket: net.Socket, options: Omit<StreamPublisherOptions, "redactor">, redactor: StreamRedactor) {
		this.#socket = socket;
		this.#tui = options.tui;
		this.#encoder = new StreamPaintEncoder(
			{ columns: options.tui.terminal.columns, rows: options.tui.terminal.rows },
			redactor,
		);
		this.#onStatus = options.onStatus;
		this.#onChat = options.onChat;
		socket.on("drain", () => this.#handleDrain());
		socket.on("error", error => {
			logger.debug("stream: local publisher socket failed", { error: String(error) });
			this.#detach();
		});
		socket.on("close", () => this.#detach());
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
		try {
			if (!this.#socket.write(encodeStreamFrame(frame))) this.#backpressured = true;
		} catch (error) {
			logger.debug("stream: local publisher write failed", { error: String(error) });
			this.#detach();
		}
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
		this.#socket.destroy();
	}

	dispose(): void {
		if (!this.#release()) return;
		this.#socket.end();
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
