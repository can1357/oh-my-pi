import * as fs from "node:fs";
import * as net from "node:net";
import * as readline from "node:readline";
import {
	STREAM_CHAT_TEXT_MAX,
	STREAM_CLOSE_HOST_CONFLICT,
	STREAM_HISTORY_LIMIT,
	STREAM_PROTO,
	STREAM_ROUTES,
	STREAM_TITLE_MAX,
	type StreamChatMessage,
	type StreamPaneFrame,
	type StreamRow,
	type StreamServerToHost,
} from "@oh-my-pi/pi-wire";
import { encodeStreamFrame, STREAM_LOCAL_PROTO, type StreamSessionFrame, type StreamStreamerFrame } from "./protocol";
import { streamSocketEndpoint } from "./paths";
import { runStreamTui, type StreamTuiInfo } from "./console-tui";
import { StreamServerClient, type StreamServerFatalError } from "./server-client";

const MAX_LOCAL_LINE_BYTES = 4 * 1024 * 1024;

interface PaneState {
	id: number;
	title: string;
	cols: number;
	rows: number;
	history: StreamRow[];
	viewport: StreamRow[];
	paused: boolean;
}

interface LocalConnection {
	socket: net.Socket;
	pane?: PaneState;
	buffer: Buffer;
}

export interface StreamUrls {
	hostUrl: string;
}

export type StreamConsoleEvent =
	| {
			t: "link";
			state: "connecting" | "live" | "reconnecting" | "stopped";
			detail?: string;
			channel?: string;
			user?: string;
	  }
	| { t: "pane"; action: "attached" | "closed"; id: number; title: string; cols: number; rows: number }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| { t: "title"; title: string }
	| { t: "error"; message: string }
	| { t: "notice"; message: string };

interface StreamConnectionOptions {
	projectDir: string;
	title: string;
	hostUrl: string;
	/** Bearer token resolver for the host socket (see `StreamCredential`). */
	token: () => Promise<string | null>;
	/** Test seam; production uses the server client's normal retry policy. */
	reconnectDelay?: (attempt: number) => number;
}

export interface StreamMuxHostOptions extends StreamConnectionOptions {
	onEvent: (event: StreamConsoleEvent) => void;
}

export interface StreamConsoleOptions extends StreamConnectionOptions {
	noTui?: boolean;
}

/** Convert a public stream base URL into its identity-derived host WebSocket route. */
export function resolveStreamUrls(baseUrl: string): StreamUrls {
	let base: URL;
	try {
		base = new URL(baseUrl);
	} catch {
		throw new Error(`invalid stream server URL: ${baseUrl}`);
	}
	if (!(["http:", "https:", "ws:", "wss:"] as const).some(protocol => protocol === base.protocol)) {
		throw new Error(`stream server URL must use http, https, ws, or wss: ${baseUrl}`);
	}
	base.hash = "";
	base.search = "";
	base.pathname = base.pathname.replace(/\/+$/, "");
	const socketUrl = new URL(base.toString());
	if (socketUrl.protocol === "http:") socketUrl.protocol = "ws:";
	if (socketUrl.protocol === "https:") socketUrl.protocol = "wss:";
	const socketBase = socketUrl.toString().replace(/\/$/, "");
	return { hostUrl: `${socketBase}${STREAM_ROUTES.host}` };
}

/** Local session multiplexer and materialized-state owner for one live channel. */
export class StreamMuxHost {
	readonly #options: StreamMuxHostOptions;
	readonly #onEvent: (event: StreamConsoleEvent) => void;
	readonly #client: StreamServerClient;
	readonly #connections = new Set<LocalConnection>();
	readonly #panes = new Map<number, PaneState>();
	readonly #finished = Promise.withResolvers<number>();
	#server?: net.Server;
	#endpoint?: string;
	#nextPaneId = 1;
	#viewerCount?: number;
	#channel = "";
	#viewerUrl = "";
	#title: string;
	#started = false;
	#closing = false;

	constructor(options: StreamMuxHostOptions) {
		this.#options = options;
		this.#onEvent = options.onEvent;
		this.#title = options.title;
		this.#client = new StreamServerClient({
			url: options.hostUrl,
			title: options.title,
			token: options.token,
			replay: () => this.#replayFrames(),
			onFrame: frame => this.#handleServerFrame(frame),
			onFatal: error => void this.#handleFatal(error),
			onDisconnect: delayMs =>
				this.#onEvent({
					t: "link",
					state: "reconnecting",
					detail: `retrying in ${Math.round(delayMs / 1000)}s`,
				}),
			reconnectDelay: options.reconnectDelay,
		});
	}

	async start(): Promise<string> {
		if (this.#started) throw new Error("stream host is already started");
		this.#started = true;
		const endpoint = await streamSocketEndpoint(this.#options.projectDir, { create: true });
		this.#endpoint = endpoint;
		if (process.platform !== "win32") await clearStaleSocket(endpoint);

		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const listening = Promise.withResolvers<void>();
		const onError = (error: Error): void => listening.reject(error);
		server.once("error", onError);
		server.listen(endpoint, () => {
			server.off("error", onError);
			listening.resolve();
		});
		try {
			await listening.promise;
			if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		} catch (error) {
			server.close();
			if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
			throw error;
		}
		process.once("exit", this.#removeSocketSync);
		this.#onEvent({ t: "notice", message: "connecting your stencil.so channel" });
		this.#onEvent({ t: "title", title: this.#title });
		this.#onEvent({ t: "link", state: "connecting" });
		this.#client.start();
		return endpoint;
	}

	wait(): Promise<number> {
		return this.#finished.promise;
	}

	sendChat(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed.startsWith("/title ")) {
			const title = trimmed.slice(7).trim();
			if (!title) return;
			this.setTitle(title);
			return;
		}
		this.#client.send({ t: "chat", text: trimmed.slice(0, STREAM_CHAT_TEXT_MAX) });
	}

	setTitle(title: string): void {
		const trimmed = title.trim();
		if (!trimmed) return;
		if (trimmed.length > STREAM_TITLE_MAX) {
			this.#onEvent({ t: "error", message: `title must be at most ${STREAM_TITLE_MAX} characters` });
			return;
		}
		this.#title = trimmed;
		this.#client.setTitle(this.#title);
		this.#onEvent({ t: "title", title: this.#title });
	}

	async close(reason = "stream ended", exitCode = 0): Promise<void> {
		if (this.#closing) {
			await this.#finished.promise;
			return;
		}
		this.#closing = true;
		process.off("exit", this.#removeSocketSync);
		try {
			const byeLine = encodeStreamFrame({ t: "bye", reason });
			const connections = [...this.#connections];
			this.#connections.clear();
			this.#panes.clear();
			this.#client.close();
			this.#onEvent({ t: "link", state: "stopped", detail: reason });

			const server = this.#server;
			this.#server = undefined;
			if (server) {
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				// server.close() waits until every connection is gone. destroySoon()
				// waits for pending writes, so a peer that is already gone (or not
				// reading) leaves this await pending. Destroy immediately, matching
				// collab/tiny unix-server shutdown.
				for (const connection of connections) {
					if (connection.socket.destroyed) continue;
					connection.socket.end(byeLine);
					connection.socket.destroy();
				}
				await closed.promise;
			} else {
				for (const connection of connections) {
					if (!connection.socket.destroyed) connection.socket.destroy();
				}
			}
			if (process.platform !== "win32" && this.#endpoint) {
				await fs.promises.rm(this.#endpoint, { force: true });
			}
		} finally {
			this.#finished.resolve(exitCode);
		}
	}

	readonly #removeSocketSync = (): void => {
		if (process.platform !== "win32" && this.#endpoint) fs.rmSync(this.#endpoint, { force: true });
	};

	#accept(socket: net.Socket): void {
		if (this.#closing) {
			socket.destroy();
			return;
		}
		const connection: LocalConnection = { socket, buffer: Buffer.alloc(0) };
		this.#connections.add(connection);
		socket.setNoDelay(true);
		socket.on("data", chunk => this.#consume(connection, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		socket.on("error", () => {
			// The paired close event performs pane cleanup.
		});
		socket.once("close", () => this.#detach(connection));
	}

	#consume(connection: LocalConnection, chunk: Buffer): void {
		if (connection.socket.destroyed) return;
		const input = connection.buffer.length === 0 ? chunk : Buffer.concat([connection.buffer, chunk]);
		let offset = 0;
		while (offset < input.length) {
			const newline = input.indexOf(0x0a, offset);
			if (newline === -1) break;
			if (newline - offset > MAX_LOCAL_LINE_BYTES) {
				connection.socket.destroy();
				return;
			}
			const end = newline > offset && input[newline - 1] === 0x0d ? newline - 1 : newline;
			const line = input.toString("utf8", offset, end);
			offset = newline + 1;
			if (!this.#handleLocalLine(connection, line)) {
				connection.socket.destroy();
				return;
			}
		}
		const remaining = input.length - offset;
		if (remaining > MAX_LOCAL_LINE_BYTES) {
			connection.socket.destroy();
			return;
		}
		connection.buffer = remaining === 0 ? Buffer.alloc(0) : Buffer.from(input.subarray(offset));
	}

	#handleLocalLine(connection: LocalConnection, line: string): boolean {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return false;
		}
		if (!isSessionFrame(value)) return false;
		if (!connection.pane) return this.#attach(connection, value);
		if (value.t === "hello") return false;
		this.#applyFrame(connection.pane, value);
		return true;
	}

	#attach(connection: LocalConnection, frame: StreamSessionFrame): boolean {
		if (frame.t !== "hello" || frame.proto !== STREAM_LOCAL_PROTO) return false;
		const pane: PaneState = {
			id: this.#nextPaneId++,
			title: frame.title.slice(0, STREAM_TITLE_MAX),
			cols: frame.cols,
			rows: frame.rows,
			history: [],
			viewport: Array.from({ length: frame.rows }, () => ""),
			paused: false,
		};
		connection.pane = pane;
		this.#panes.set(pane.id, pane);
		connection.socket.write(encodeStreamFrame(this.#sessionWelcome()));
		if (this.#viewerCount !== undefined) {
			connection.socket.write(encodeStreamFrame({ t: "viewers", n: this.#viewerCount }));
		}
		this.#client.send({ t: "pane-open", pane: pane.id, title: pane.title, cols: pane.cols, rows: pane.rows });
		this.#onEvent({
			t: "pane",
			action: "attached",
			id: pane.id,
			title: pane.title,
			cols: pane.cols,
			rows: pane.rows,
		});
		return true;
	}

	#applyFrame(pane: PaneState, frame: Exclude<StreamSessionFrame, { t: "hello" }>): void {
		let wire: StreamPaneFrame;
		switch (frame.t) {
			case "resize":
				pane.cols = frame.cols;
				pane.rows = frame.rows;
				if (pane.viewport.length > frame.rows) pane.viewport.length = frame.rows;
				while (pane.viewport.length < frame.rows) pane.viewport.push("");
				wire = { ...frame, pane: pane.id };
				break;
			case "history": {
				const overflow = pane.history.length + frame.rows.length - STREAM_HISTORY_LIMIT;
				if (overflow >= pane.history.length) {
					pane.history = frame.rows.slice(-STREAM_HISTORY_LIMIT);
				} else {
					if (overflow > 0) pane.history.splice(0, overflow);
					pane.history.push(...frame.rows);
				}
				wire = { ...frame, pane: pane.id };
				break;
			}
			case "viewport":
				pane.viewport = frame.rows.slice();
				wire = { ...frame, pane: pane.id };
				break;
			case "patch":
				pane.rows = frame.rows;
				if (pane.viewport.length > frame.rows) pane.viewport.length = frame.rows;
				while (pane.viewport.length < frame.rows) pane.viewport.push("");
				for (const [index, row] of frame.ops) {
					if (index >= 0 && index < frame.rows) pane.viewport[index] = row;
				}
				wire = { ...frame, pane: pane.id };
				break;
			case "reset":
				pane.history = [];
				pane.viewport = [];
				wire = { ...frame, pane: pane.id };
				break;
			case "paused":
				pane.paused = frame.paused;
				wire = { ...frame, pane: pane.id };
				break;
		}
		this.#client.send(wire);
	}

	#detach(connection: LocalConnection): void {
		this.#connections.delete(connection);
		const pane = connection.pane;
		if (!pane || !this.#panes.delete(pane.id)) return;
		if (!this.#closing) {
			this.#client.send({ t: "pane-close", pane: pane.id });
			this.#onEvent({
				t: "pane",
				action: "closed",
				id: pane.id,
				title: pane.title,
				cols: pane.cols,
				rows: pane.rows,
			});
		}
	}

	*#replayFrames(): IterableIterator<StreamPaneFrame> {
		for (const pane of this.#panes.values()) {
			yield { t: "pane-open", pane: pane.id, title: pane.title, cols: pane.cols, rows: pane.rows };
			yield { t: "history", pane: pane.id, rows: pane.history };
			yield { t: "viewport", pane: pane.id, rows: pane.viewport };
			yield { t: "paused", pane: pane.id, paused: pane.paused };
		}
	}

	#handleServerFrame(frame: StreamServerToHost): void {
		switch (frame.t) {
			case "welcome":
				if (frame.proto !== STREAM_PROTO) {
					const message = `stream protocol mismatch (server ${frame.proto}, client ${STREAM_PROTO})`;
					this.#onEvent({ t: "error", message });
					void this.close(message, 1);
					return;
				}
				this.#channel = frame.channel;
				this.#viewerUrl = frame.url;
				this.#broadcast(this.#sessionWelcome());
				this.#onEvent({
					t: "link",
					state: "live",
					detail: frame.url,
					channel: frame.channel,
					user: frame.user,
				});
				break;
			case "viewers":
				this.#broadcast({ t: "viewers", n: frame.n });
				if (frame.n !== this.#viewerCount) {
					this.#viewerCount = frame.n;
					this.#onEvent({ t: "viewers", n: frame.n });
				}
				break;
			case "chat":
				this.#broadcast({ t: "chat", msg: frame.msg });
				this.#onEvent({ t: "chat", msg: frame.msg });
				break;
			case "error":
				this.#onEvent({ t: "error", message: `stream server: ${frame.message}` });
				break;
		}
	}

	#sessionWelcome(): StreamStreamerFrame {
		return { t: "welcome", proto: STREAM_LOCAL_PROTO, channel: this.#channel, url: this.#viewerUrl };
	}

	#broadcast(frame: StreamStreamerFrame): void {
		const line = encodeStreamFrame(frame);
		for (const connection of this.#connections) {
			if (connection.pane) connection.socket.write(line);
		}
	}

	async #handleFatal(error: StreamServerFatalError): Promise<void> {
		const message =
			error.code === STREAM_CLOSE_HOST_CONFLICT ? "your channel already has a live host" : error.message;
		this.#onEvent({ t: "error", message });
		await this.close(message, 1);
	}
}

/** Render stream events as the original line-oriented console output. */
export function logConsoleSink(): (event: StreamConsoleEvent) => void {
	return event => {
		switch (event.t) {
			case "link":
				if (event.state === "live") {
					process.stdout.write(`live: ${event.detail ?? ""}\n`);
				} else if (event.state === "reconnecting") {
					process.stderr.write(`stream server connection lost; ${event.detail ?? "reconnecting"}\n`);
				}
				break;
			case "pane":
				process.stdout.write(
					event.action === "attached"
						? `pane attached: #${event.id} ${event.title} ${event.cols}x${event.rows}\n`
						: `pane closed: #${event.id} ${event.title}\n`,
				);
				break;
			case "viewers":
				process.stdout.write(`viewers: ${event.n}\n`);
				break;
			case "chat":
				process.stdout.write(`${formatChat(event.msg)}\n`);
				break;
			case "title":
				process.stdout.write(`title: ${event.title}\n`);
				break;
			case "error":
				process.stderr.write(`${event.message}\n`);
				break;
			case "notice":
				process.stdout.write(`${event.message}\n`);
				break;
		}
	};
}

/** Run the foreground console UX until a signal or fatal server rejection. */
export async function runStreamConsole(options: StreamConsoleOptions): Promise<number> {
	const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true && !options.noTui;
	const events: StreamConsoleEvent[] = [];
	const listeners = new Set<(event: StreamConsoleEvent) => void>();
	const sink = interactive
		? (event: StreamConsoleEvent): void => {
				if (listeners.size === 0) events.push(event);
				for (const listener of listeners) listener(event);
			}
		: logConsoleSink();
	const host = new StreamMuxHost({ ...options, onEvent: sink });
	await host.start();

	const stop = (): void => {
		void host.close("stream stopped");
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	let input: readline.Interface | undefined;
	try {
		if (interactive) {
			const info: StreamTuiInfo = {
				title: options.title,
				initialEvents: events.slice(),
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			await runStreamTui(host, info);
		} else {
			input = readline.createInterface({ input: process.stdin, terminal: false });
			input.on("line", line => host.sendChat(line));
		}
		return await host.wait();
	} finally {
		input?.close();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

async function clearStaleSocket(endpoint: string): Promise<void> {
	const status = await probeSocket(endpoint);
	if (status === "live")
		throw new Error(`another omp stream process is already running for this directory (${endpoint})`);
	if (status === "stale") await fs.promises.unlink(endpoint);
}

function probeSocket(endpoint: string): Promise<"missing" | "stale" | "live"> {
	const result = Promise.withResolvers<"missing" | "stale" | "live">();
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => {
		socket.destroy();
		result.resolve("live");
	});
	socket.once("error", error => {
		socket.destroy();
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") result.resolve("missing");
		else if (code === "ECONNREFUSED") result.resolve("stale");
		else result.reject(error);
	});
	return result.promise;
}

function isSessionFrame(value: unknown): value is StreamSessionFrame {
	if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") return false;
	const frame = value as Record<string, unknown>;
	switch (frame.t) {
		case "hello":
			return (
				typeof frame.proto === "number" &&
				Number.isInteger(frame.proto) &&
				typeof frame.sessionId === "string" &&
				typeof frame.title === "string" &&
				isDimension(frame.cols) &&
				isDimension(frame.rows)
			);
		case "resize":
			return isDimension(frame.cols) && isDimension(frame.rows);
		case "history":
		case "viewport":
			return Array.isArray(frame.rows) && frame.rows.every(row => typeof row === "string");
		case "patch":
			return (
				isDimension(frame.rows) &&
				Array.isArray(frame.ops) &&
				frame.ops.every(
					op =>
						Array.isArray(op) &&
						op.length === 2 &&
						typeof op[0] === "number" &&
						Number.isInteger(op[0]) &&
						typeof op[1] === "string",
				)
			);
		case "reset":
			return true;
		case "paused":
			return typeof frame.paused === "boolean";
		default:
			return false;
	}
}

function isDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function formatChat(message: StreamChatMessage): string {
	const time = new Date(message.ts);
	const hours = String(time.getHours()).padStart(2, "0");
	const minutes = String(time.getMinutes()).padStart(2, "0");
	return `[${hours}:${minutes}] ${message.name}: ${message.text}`;
}
