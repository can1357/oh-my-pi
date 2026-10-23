import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { ServerSentEvent } from "@oh-my-pi/pi-utils";
import { AbortError } from "../error/abort";
import { getProxyForUrl } from "../utils/proxy";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { extractWebSocketHandshakeHeaders, toWebSocketHeaders, toWebSocketUrl } from "../utils/websocket";
import type { ResponseStreamEvent } from "./openai-responses-wire";

const IDLE_REUSE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MESSAGE_QUEUE_CAPACITY = 4096;

interface UpgradeInspectableWebSocket extends Bun.WebSocket {
	once(event: "upgrade", listener: (response: IncomingMessage) => void): this;
	once(event: "unexpected-response", listener: (request: unknown, response: IncomingMessage) => void): this;
}

const InspectableSocket = require("ws") as new (
	url: string,
	options: Bun.WebSocketOptions,
) => UpgradeInspectableWebSocket;

export class OpenAIResponsesWebSocketUpgradeError extends Error {
	constructor(readonly response: Response) {
		super(`OpenAI responses WebSocket upgrade rejected (HTTP ${response.status})`);
	}
}

/** One response.create at a time. A failed/cancelled request always retires its socket. */
export class OpenAIResponsesWebSocketConnection {
	readonly headers: Record<string, string>;
	#url: string;
	#provider: string;
	#socket?: Bun.WebSocket;
	#handshakeResponse?: IncomingMessage;
	#queue: Array<ResponseStreamEvent | Error> = [];
	#wake?: () => void;
	#rejectConnect?: (reason: Error) => void;
	#removeAbort?: () => void;
	#failure?: Error;
	#receiving = false;
	#completed = false;
	#lastResponseId?: string;
	#lastInboundAt?: number;
	handshakeHeaders?: Headers;

	constructor(
		url: string,
		headers: Record<string, string>,
		provider: string,
		readonly captureUpgradeResponse = false,
	) {
		this.#url = toWebSocketUrl(url);
		this.headers = headers;
		this.#provider = provider;
	}

	get reusable(): boolean {
		// Bun can keep silently evicted sockets OPEN; trust only recent peer activity.
		return (
			this.#completed &&
			!this.#failure &&
			this.#socket?.readyState === WebSocket.OPEN &&
			this.#lastInboundAt !== undefined &&
			Date.now() - this.#lastInboundAt <= IDLE_REUSE_MS
		);
	}

	async open(signal: AbortSignal): Promise<void> {
		this.#completed = false;
		const onAbort = () => this.close(new AbortError());
		if (signal.aborted) throw new AbortError();
		signal.addEventListener("abort", onAbort, { once: true });
		this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
		if (this.#socket?.readyState === WebSocket.OPEN && !this.#failure) return;
		if (this.#failure) throw this.#failure;
		const socketOptions: Bun.WebSocketOptions = {
			headers: this.headers,
			proxy: getProxyForUrl(this.#provider, new URL(this.#url)),
		};
		let socket: Bun.WebSocket;
		if (this.captureUpgradeResponse) {
			// Bun's built-in Node-WS interface exposes rejected upgrade responses;
			// the DOM interface only reports "Expected 101 status code".
			const inspectableSocket = new InspectableSocket(this.#url, socketOptions);
			inspectableSocket.once("upgrade", response => {
				this.handshakeHeaders = toWebSocketHeaders(response.headers);
			});
			inspectableSocket.once("unexpected-response", (_request, response) => {
				if (this.#failure) {
					response.destroy();
					return;
				}
				this.#handshakeResponse = response;
				try {
					const rejected = new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
						status: response.statusCode!,
						headers: toWebSocketHeaders(response.headers),
					});
					// The lease owns this response until release; keep its body alive
					// while the provider classifies a pre-request rejection.
					this.#rejectConnect?.(new OpenAIResponsesWebSocketUpgradeError(rejected));
				} catch (error) {
					this.close(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket = inspectableSocket;
		} else {
			socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
				this.#url,
				socketOptions,
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#rejectConnect = reject;
		this.#socket = socket;
		socket.binaryType = "nodebuffer";
		socket.onopen = event => {
			this.handshakeHeaders = extractWebSocketHandshakeHeaders(socket, event) ?? this.handshakeHeaders;
			this.#rejectConnect = undefined;
			resolve();
		};
		socket.onerror = () => this.close(new Error("OpenAI responses WebSocket connection error"));
		socket.onclose = event => this.close(new Error(`OpenAI responses WebSocket closed (${event.code})`));
		socket.onmessage = event => {
			this.#lastInboundAt = Date.now();
			if (!this.#receiving) return;
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				const parsed = JSON.parse(text) as ResponseStreamEvent;
				if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
					throw new Error("Invalid OpenAI responses WebSocket event");
				}
				// A late frame from the preceding response must not become this turn's output.
				const frame = parsed as unknown as { response_id?: string; response?: { id?: string } };
				if (this.#lastResponseId && (frame.response_id ?? frame.response?.id) === this.#lastResponseId) return;
				if (this.#queue.length >= MESSAGE_QUEUE_CAPACITY) {
					throw new Error("OpenAI responses WebSocket message queue overflow");
				}
				this.#queue.push(parsed);
				this.#wake?.();
			} catch (error) {
				this.close(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const timeout = setTimeout(
			() => this.close(new Error("OpenAI responses WebSocket connection timed out")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await promise;
		} finally {
			clearTimeout(timeout);
			this.#rejectConnect = undefined;
		}
	}

	async *events(body: object, observer?: (event: ServerSentEvent) => void): AsyncGenerator<ResponseStreamEvent> {
		let terminal = false;
		this.#queue.length = 0;
		this.#receiving = true;
		try {
			if (this.#failure) throw this.#failure;
			if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
				throw new Error("OpenAI responses WebSocket is not open");
			}
			const request: Record<string, unknown> = { ...body, type: "response.create" };
			delete request.stream;
			delete request.stream_options;
			delete request.background;
			this.#socket.send(JSON.stringify(request));
			for (;;) {
				while (this.#queue.length === 0) {
					if (this.#failure) throw this.#failure;
					const { promise, resolve } = Promise.withResolvers<void>();
					this.#wake = resolve;
					await promise;
					this.#wake = undefined;
				}
				const event = this.#queue.shift()!;
				if (event instanceof Error) throw event;
				if (observer) {
					const data = JSON.stringify(event);
					notifyRawSseEvent(observer, {
						event: event.type,
						data,
						raw: [`: ws ← ${event.type}`, `event: ${event.type}`, `data: ${data}`],
					});
				}
				const type: string = event.type;
				terminal = type === "response.completed" || type === "response.incomplete" || type === "response.done";
				if (terminal) {
					if (
						"response" in event &&
						event.response &&
						typeof event.response === "object" &&
						"id" in event.response
					) {
						this.#lastResponseId = typeof event.response.id === "string" ? event.response.id : undefined;
					}
					this.#completed = true;
				}
				yield event;
				if (terminal) return;
			}
		} finally {
			this.#receiving = false;
			this.#queue.length = 0;
			if (!terminal) this.close(new Error("OpenAI responses WebSocket request did not complete"));
		}
	}

	finish(): void {
		this.#removeAbort?.();
		this.#removeAbort = undefined;
	}

	close(error = new Error("OpenAI responses WebSocket released")): void {
		if (this.#failure) return;
		this.#failure = error;
		this.#handshakeResponse?.destroy();
		this.#handshakeResponse = undefined;
		this.#rejectConnect?.(error);
		// Preserve already-received frames, including a terminal event before an eager close.
		this.#queue.push(error);
		this.#wake?.();
		const socket = this.#socket;
		this.#socket = undefined;
		if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
			socket.close(1000, "request finished");
		}
	}
}

interface SessionConnection {
	sessionId?: string;
	connection: OpenAIResponsesWebSocketConnection;
	busy: boolean;
	timer?: NodeJS.Timeout;
}

export interface OpenAIResponsesWebSocketLease {
	connection: OpenAIResponsesWebSocketConnection;
	release(): void;
}

/** Session lifetime is owned by ProviderSessionState, never a process-global socket cache. */
export class OpenAIResponsesWebSocketPool {
	#sessions = new Map<string, SessionConnection>();
	#active = new Set<SessionConnection>();

	acquire(args: {
		url: string;
		headers: Record<string, string>;
		provider: string;
		modelId: string;
		sessionId?: string;
		captureUpgradeResponse?: boolean;
	}): OpenAIResponsesWebSocketLease {
		const key = args.sessionId ? `${args.url}\u0000${args.modelId}\u0000${args.sessionId}` : undefined;
		let entry = key ? this.#sessions.get(key) : undefined;
		const retained = key !== undefined && !entry?.busy;
		if (entry && !entry.busy) {
			clearTimeout(entry.timer);
			const previousHeaders = entry.connection.headers;
			const headerNames = Object.keys(args.headers);
			const sameHeaders =
				headerNames.length === Object.keys(previousHeaders).length &&
				headerNames.every(name => args.headers[name] === previousHeaders[name]);
			if (
				!entry.connection.reusable ||
				!sameHeaders ||
				entry.connection.captureUpgradeResponse !== (args.captureUpgradeResponse ?? false)
			) {
				entry.connection.close();
				this.#sessions.delete(key!);
				entry = undefined;
			}
		}
		if (!entry || entry.busy) {
			entry = {
				sessionId: args.sessionId,
				connection: new OpenAIResponsesWebSocketConnection(
					args.url,
					args.headers,
					args.provider,
					args.captureUpgradeResponse,
				),
				busy: false,
			};
			if (retained) this.#sessions.set(key!, entry);
		}
		const leased = entry;
		leased.busy = true;
		this.#active.add(leased);
		let released = false;
		return {
			connection: leased.connection,
			release: () => {
				if (released) return;
				released = true;
				leased.connection.finish();
				leased.busy = false;
				this.#active.delete(leased);
				if (retained && this.#sessions.get(key!) === leased && leased.connection.reusable) {
					leased.timer = setTimeout(() => {
						if (this.#sessions.get(key!) === leased) this.#sessions.delete(key!);
						leased.connection.close();
					}, IDLE_REUSE_MS);
					leased.timer.unref();
				} else {
					if (this.#sessions.get(key!) === leased) this.#sessions.delete(key!);
					leased.connection.close();
				}
			},
		};
	}

	releaseSession(sessionId?: string): void {
		for (const [key, entry] of this.#sessions) {
			if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
			clearTimeout(entry.timer);
			entry.connection.close();
			this.#sessions.delete(key);
		}
		for (const entry of this.#active) {
			if (sessionId === undefined || entry.sessionId === sessionId) entry.connection.close();
		}
	}
}
