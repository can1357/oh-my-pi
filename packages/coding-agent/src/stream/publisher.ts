import * as net from "node:net";
import type { StreamChatMessage, StreamRow } from "@oh-my-pi/pi-wire";
import { STREAM_HISTORY_LIMIT } from "@oh-my-pi/pi-wire";
import type { TUI, TuiPaint } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { streamSocketEndpoint } from "./paths";
import { encodeStreamFrame, STREAM_LOCAL_PROTO, type StreamSessionFrame, type StreamStreamerFrame } from "./protocol";
import type { StreamRedactor } from "./redactor";

const CONNECT_TIMEOUT_MS = 500;
const FLUSH_INTERVAL_MS = 50;
const IMAGE_PLACEHOLDER = "\u{10eeee}";
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

/**
 * Convert one prepared terminal row into the stream-safe ANSI subset. Only SGR
 * and OSC 8 survive. Graphics placements become a visible text marker; OSC 66
 * contributes its visible payload without its terminal-specific scaling.
 */
export function normalizeStreamRow(row: string): string {
	if (row.includes(IMAGE_PLACEHOLDER)) return "[image]";
	let output = "";
	let image = false;
	for (let index = 0; index < row.length;) {
		if (row.charCodeAt(index) !== 0x1b) {
			const code = row.charCodeAt(index);
			if ((code >= 0x20 && (code < 0x7f || code > 0x9f)) || code === 0x09) output += row[index];
			index++;
			continue;
		}
		const kind = row[index + 1];
		if (kind === "[") {
			let end = index + 2;
			while (end < row.length && (row.charCodeAt(end) < 0x40 || row.charCodeAt(end) > 0x7e)) end++;
			if (end >= row.length) break;
			if (row[end] === "m") output += row.slice(index, end + 1);
			index = end + 1;
			continue;
		}
		if (kind === "]" || kind === "_" || kind === "P") {
			let end = index + 2;
			const tmuxDcs = kind === "P" && row.startsWith("tmux;", end);
			while (end < row.length) {
				const bell = row.charCodeAt(end) === 0x07;
				const escapedTmuxEsc = tmuxDcs && end > index + 2 && row[end - 1] === "\x1b";
				const st = row[end] === "\x1b" && row[end + 1] === "\\" && !escapedTmuxEsc;
				if (bell || st) break;
				end++;
			}
			const terminatedBySt = row[end] === "\x1b";
			const sequenceEnd = Math.min(row.length, end + (terminatedBySt ? 2 : 1));
			const payload = row.slice(index + 2, end);
			if (kind === "]" && payload.startsWith("8;")) {
				output += row.slice(index, sequenceEnd);
			} else if (kind === "]" && payload.startsWith("66;")) {
				const separator = payload.indexOf(";", 3);
				if (separator >= 0) output += payload.slice(separator + 1);
			} else if (kind === "]" && /(?:^|;)File=/.test(payload)) {
				image = true;
			} else if (kind === "_") {
				const graphics = payload.startsWith("G") ? payload.slice(1) : "";
				if (/(?:^|,)a=[pT](?:,|$)/.test(graphics) || /(?:^|,)U=1(?:,|$)/.test(graphics)) {
					image = true;
				}
			} else if (kind === "P" && /^[0-9;]*q/.test(payload)) {
				image = true;
			} else if (kind === "P" && payload.startsWith("tmux;")) {
				const nested = normalizeStreamRow(payload.slice(5).replaceAll("\x1b\x1b", "\x1b"));
				if (nested === "[image]") image = true;
				else output += nested;
			}
			index = sequenceEnd;
			continue;
		}
		// ESC controls are paint mechanics rather than row content. Consume any
		// intermediate bytes as well as the final byte (for example ESC ( 0).
		let end = index + 1;
		while (end < row.length && row.charCodeAt(end) >= 0x20 && row.charCodeAt(end) <= 0x2f) end++;
		index = Math.min(row.length, end + 1);
	}
	return image ? "[image]" : output;
}

/** Publishes one interactive session's already-redacted terminal rows. */
export class StreamPublisher {
	readonly #socket: net.Socket;
	readonly #tui: TUI;
	readonly #redactor: StreamRedactor;
	readonly #onStatus: StreamPublisherOptions["onStatus"];
	readonly #onChat: StreamPublisherOptions["onChat"];
	#disposed = false;
	#flushTimer: NodeJS.Timeout | undefined;
	#pendingViewport: StreamRow[] | undefined;
	#pendingHistory: StreamRow[] = [];
	#pendingHistorySkipped = 0;
	#pendingReset = false;
	#pendingForceFull = false;
	#pendingColumns: number;
	#pendingRows: number;
	#lastColumns: number;
	#lastRows: number;
	#lastViewport: StreamRow[] | undefined;
	#lastAlt: boolean | undefined;
	#pendingAlt = false;
	#backpressured = false;
	/** Raw → normalized+redacted rows of the previous paint; most rows repeat frame to frame. */
	#rowCache = new Map<string, StreamRow>();

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
		publisher.#tui.setPaintListener(paint => publisher.#handlePaint(paint));
		for (const frame of opened.takeQueuedFrames()) publisher.#handleFrame(frame);
		return publisher;
	}

	constructor(socket: net.Socket, options: Omit<StreamPublisherOptions, "redactor">, redactor: StreamRedactor) {
		this.#socket = socket;
		this.#tui = options.tui;
		this.#redactor = redactor;
		this.#onStatus = options.onStatus;
		this.#onChat = options.onChat;
		this.#pendingColumns = this.#lastColumns = options.tui.terminal.columns;
		this.#pendingRows = this.#lastRows = options.tui.terminal.rows;
		socket.on("drain", () => this.#handleDrain());
		socket.on("error", error => {
			logger.debug("stream: local publisher socket failed", { error: String(error) });
			this.#detach();
		});
		socket.on("close", () => this.#detach());
	}

	#normalizeRows(rows: readonly string[]): StreamRow[] {
		return rows.map(row => this.#redactor.redactRow(normalizeStreamRow(row)));
	}

	#normalizeViewport(rows: readonly string[]): StreamRow[] {
		const cache = new Map<string, StreamRow>();
		const out = rows.map(row => {
			let normalized = cache.get(row) ?? this.#rowCache.get(row);
			if (normalized === undefined) normalized = this.#redactor.redactRow(normalizeStreamRow(row));
			cache.set(row, normalized);
			return normalized;
		});
		this.#rowCache = cache;
		return out;
	}

	#handlePaint(paint: TuiPaint): void {
		if (this.#disposed) return;
		if (paint.reset) {
			this.#pendingReset = true;
			this.#pendingForceFull = true;
			this.#pendingHistory = [];
			this.#pendingHistorySkipped = 0;
		}
		if (paint.history.length > 0) {
			this.#pendingHistory.push(...this.#normalizeRows(paint.history));
			const capacity = this.#pendingHistorySkipped > 0 ? STREAM_HISTORY_LIMIT - 1 : STREAM_HISTORY_LIMIT;
			if (this.#pendingHistory.length > capacity) {
				this.#pendingHistorySkipped += this.#pendingHistory.length - (STREAM_HISTORY_LIMIT - 1);
				this.#pendingHistory = this.#pendingHistory.slice(-(STREAM_HISTORY_LIMIT - 1));
			}
		}
		if (paint.columns !== this.#pendingColumns || paint.rows !== this.#pendingRows) this.#pendingForceFull = true;
		if (this.#lastAlt !== undefined && paint.alt !== this.#lastAlt) this.#pendingForceFull = true;
		if (paint.alt) this.#pendingForceFull = true;
		this.#lastAlt = paint.alt;
		this.#pendingAlt = paint.alt;
		this.#pendingColumns = paint.columns;
		this.#pendingRows = paint.rows;
		this.#pendingViewport = this.#normalizeViewport(paint.viewport);
		this.#scheduleFlush();
	}

	#scheduleFlush(): void {
		if (this.#flushTimer || this.#disposed) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flush();
		}, FLUSH_INTERVAL_MS);
		this.#flushTimer.unref();
	}

	#write(frame: StreamSessionFrame, screenFrame = false): boolean {
		if (this.#disposed || (screenFrame && this.#backpressured)) return false;
		try {
			if (!this.#socket.write(encodeStreamFrame(frame))) this.#backpressured = true;
			return true;
		} catch (error) {
			logger.debug("stream: local publisher write failed", { error: String(error) });
			this.#detach();
			return false;
		}
	}

	#flush(): void {
		if (this.#disposed) return;
		if (this.#pendingReset) this.#write({ t: "reset" });
		if (this.#pendingHistory.length > 0 || this.#pendingHistorySkipped > 0) {
			const rows =
				this.#pendingHistorySkipped > 0
					? [`… (${this.#pendingHistorySkipped} rows skipped)`, ...this.#pendingHistory]
					: this.#pendingHistory;
			this.#write({ t: "history", rows });
		}
		const resized = this.#pendingColumns !== this.#lastColumns || this.#pendingRows !== this.#lastRows;
		if (resized) {
			this.#write({ t: "resize", cols: this.#pendingColumns, rows: this.#pendingRows });
			this.#lastColumns = this.#pendingColumns;
			this.#lastRows = this.#pendingRows;
		}

		const viewport = this.#pendingViewport;
		const forceFull = this.#pendingForceFull || this.#pendingReset || resized || this.#pendingAlt;
		this.#pendingReset = false;
		this.#pendingHistory = [];
		this.#pendingHistorySkipped = 0;
		this.#pendingForceFull = false;
		this.#pendingViewport = undefined;
		if (!viewport) return;
		if (this.#backpressured) {
			this.#pendingViewport = viewport;
			this.#pendingForceFull = true;
			return;
		}

		if (!this.#lastViewport || forceFull) {
			if (this.#write({ t: "viewport", rows: viewport }, true)) this.#lastViewport = viewport;
			return;
		}
		const ops: [number, StreamRow][] = [];
		for (let index = 0; index < viewport.length; index++) {
			if (viewport[index] !== this.#lastViewport[index]) ops.push([index, viewport[index]!]);
		}
		const changed = ops.length + Math.max(0, this.#lastViewport.length - viewport.length);
		if (changed === 0) return;
		if (changed > viewport.length / 2) {
			if (this.#write({ t: "viewport", rows: viewport }, true)) this.#lastViewport = viewport;
		} else if (this.#write({ t: "patch", ops, rows: viewport.length }, true)) {
			this.#lastViewport = viewport;
		}
	}

	#handleDrain(): void {
		if (this.#disposed || !this.#backpressured) return;
		this.#backpressured = false;
		if (
			this.#flushTimer ||
			this.#pendingReset ||
			this.#pendingHistory.length > 0 ||
			this.#pendingHistorySkipped > 0 ||
			this.#pendingViewport
		) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
			this.#pendingForceFull = true;
			this.#flush();
			return;
		}
		if (this.#lastViewport) this.#write({ t: "viewport", rows: this.#lastViewport }, true);
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
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#tui.setPaintListener(null);
		this.#onStatus(null);
		this.#socket.destroy();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		this.#tui.setPaintListener(null);
		this.#onStatus(null);
		this.#socket.end();
	}
}
