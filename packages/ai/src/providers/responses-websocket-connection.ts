import type { IncomingMessage } from "node:http";
import type { RawSseEvent } from "../types";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { notifyRawSseEvent } from "../utils/sse-debug";
import {
	extractWebSocketHandshakeHeaders,
	isOpenAIResponsesProgressEvent,
	toWebSocketHeaders,
} from "../utils/websocket";

export type ResponsesWebSocketTransportErrorReason =
	| "closed"
	| "socket-error"
	| "timeout"
	| "ping-failed"
	| "pong-timeout"
	| "unavailable"
	| "aborted"
	| "busy"
	| "send"
	| "queue-overflow"
	| "protocol"
	| "upgrade";
export type ResponsesWebSocketTransportErrorPhase = "connect" | "stream" | "before-terminal" | "first-event" | "idle";

/** A physical-channel failure; providers retain ownership of recovery policy. */
export class ResponsesWebSocketTransportError extends Error {
	readonly status?: number;
	readonly headers?: Headers;

	constructor(
		readonly reason: ResponsesWebSocketTransportErrorReason,
		readonly phase: ResponsesWebSocketTransportErrorPhase,
		detail: string,
		options?: ErrorOptions & { status?: number; headers?: Headers },
	) {
		super(detail, options);
		this.name = "ResponsesWebSocketTransportError";
		this.status = options?.status;
		this.headers = options?.headers;
	}
}

export interface ResponsesWebSocketTimeouts {
	firstEventTimeoutMs?: number;
	idleTimeoutMs?: number;
}

export type ResponsesWebSocketExchange = { send: Record<string, unknown> } | { receive: true };

export interface ResponsesWebSocketControlFrames {
	consume(frame: Record<string, unknown>): boolean | Error;
	closed(error: Error): void;
}

export interface ResponsesWebSocketConnectionOptions {
	url: string;
	headers: Record<string, string>;
	proxy?: string;
	connectTimeoutMs: number;
	maxIdleReuseMs: number;
	messageQueueCapacity: number;
	heartbeat?: { intervalMs: number; pongTimeoutMs: number };
	inspectUpgradeResponse?: boolean;
	onHandshakeHeaders?: (headers: Headers) => void;
	controlFrames?: ResponsesWebSocketControlFrames;
}

interface UpgradeInspectableWebSocket extends Bun.WebSocket {
	once(event: "upgrade", listener: (response: IncomingMessage) => void): this;
	once(event: "unexpected-response", listener: (request: unknown, response: IncomingMessage) => void): this;
}

const InspectableSocket = require("ws") as new (
	url: string,
	options: Bun.WebSocketOptions,
) => UpgradeInspectableWebSocket;

export function isResponsesWebSocketProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	return typeof event === "object" && event !== null && "type" in event && event.type === "response.done";
}

function extractFrameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = frame.response;
	const id = response !== null && typeof response === "object" && "id" in response ? response.id : undefined;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractFrameSequenceNumber(frame: Record<string, unknown>): number | undefined {
	const raw = frame.sequence_number;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
}

function timeoutMessage(
	reason: string,
	lastEventAt: number,
	lastEventType: string | undefined,
	lastProgressAt: number,
	lastProgressEventType: string | undefined,
): string {
	const now = Date.now();
	const lastEvent = lastEventType ? `${lastEventType} ${Math.max(0, now - lastEventAt)}ms ago` : "none";
	const lastProgress = lastProgressEventType
		? `${lastProgressEventType} ${Math.max(0, now - lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

function notifyFrame(
	observer: ((event: RawSseEvent) => void) | undefined,
	frame: Record<string, unknown>,
	payload: string,
	direction: "←" | "→",
): void {
	if (!observer) return;
	const type = typeof frame.type === "string" ? frame.type : null;
	const raw = [`: ws ${direction} ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

/** One physical socket, one reader, and no generation replay or provider policy. */
export class ResponsesWebSocketConnection {
	#options: ResponsesWebSocketConnectionOptions;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#rejectConnect?: (error: Error) => void;
	#clearConnect?: () => void;
	#closedError?: ResponsesWebSocketTransportError;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval?: NodeJS.Timeout;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;
	#lastInboundAt = 0;
	#lastPingAt = 0;
	#lastSeenResponseId?: string;

	constructor(options: ResponsesWebSocketConnectionOptions) {
		this.#options = options;
	}

	get handshakeHeaders(): Headers | undefined {
		return this.#handshakeHeaders;
	}

	get closedError(): ResponsesWebSocketTransportError | undefined {
		return this.#closedError;
	}

	isOpen(): boolean {
		return !this.#closedError && this.#socket?.readyState === WebSocket.OPEN;
	}

	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	hasActiveRequest(): boolean {
		return this.#activeRequest;
	}

	isBusy(): boolean {
		return this.#activeRequest || this.isConnecting();
	}

	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = this.#options.maxIdleReuseMs;
		if (maxIdleMs <= 0) return true;
		return this.#lastInboundAt !== 0 && Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	close(reason = "done"): void {
		this.#retire(
			new ResponsesWebSocketTransportError(
				"closed",
				this.#rejectConnect ? "connect" : "stream",
				`websocket closed (${reason})`,
			),
			reason,
		);
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new ResponsesWebSocketTransportError("aborted", "connect", "request was aborted", {
				cause: signal.reason,
			});
		}
		if (this.isOpen()) return;
		if (this.#closedError) throw this.#closedError;
		if (this.#connectPromise) {
			await this.#joinConnect(this.#connectPromise, signal);
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		this.#rejectConnect = reject;
		const onAbort = () =>
			this.#retire(
				new ResponsesWebSocketTransportError("aborted", "connect", "request was aborted", {
					cause: signal?.reason,
				}),
				"aborted",
			);
		this.#clearConnect = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			this.#clearConnect = undefined;
			this.#rejectConnect = undefined;
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() =>
				this.#retire(
					new ResponsesWebSocketTransportError("timeout", "connect", "connection timeout"),
					"connect-timeout",
				),
			this.#options.connectTimeoutMs,
		);
		try {
			const socketOptions: Bun.WebSocketOptions = { headers: this.#options.headers, proxy: this.#options.proxy };
			let socket: Bun.WebSocket;
			if (this.#options.inspectUpgradeResponse) {
				const inspectable = new InspectableSocket(this.#options.url, socketOptions);
				inspectable.once("upgrade", response => {
					this.#handshakeHeaders = toWebSocketHeaders(response.headers);
				});
				inspectable.once("unexpected-response", (_request, response) => {
					try {
						if (!this.#rejectConnect) return;
						const status = response.statusCode;
						const headers = toWebSocketHeaders(response.headers);
						this.#retire(
							new ResponsesWebSocketTransportError(
								"upgrade",
								"connect",
								status === undefined
									? "websocket upgrade rejected"
									: `websocket upgrade rejected (HTTP ${status})`,
								{ status, headers },
							),
							"upgrade",
						);
					} catch (error) {
						this.#retire(
							new ResponsesWebSocketTransportError("protocol", "connect", String(error), { cause: error }),
							"upgrade",
						);
					} finally {
						// Bun exposes a discarded handshake snapshot, not a live HTTP
						// body. Keep only actual status/headers and release it immediately.
						response.destroy();
					}
				});
				socket = inspectable;
			} else {
				socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
					this.#options.url,
					socketOptions,
				);
			}
			socket.binaryType = "nodebuffer";
			this.#socket = socket;
			socket.onopen = event => {
				if (!this.#rejectConnect) return;
				try {
					this.#lastInboundAt = Date.now();
					this.#handshakeHeaders = extractWebSocketHandshakeHeaders(socket, event) ?? this.#handshakeHeaders;
					this.#startHeartbeat(socket);
					if (this.#handshakeHeaders) this.#options.onHandshakeHeaders?.(this.#handshakeHeaders);
					this.#clearConnect?.();
					resolve();
				} catch (error) {
					this.#retire(
						new ResponsesWebSocketTransportError("protocol", "connect", String(error), { cause: error }),
						"handshake",
					);
				}
			};
			socket.onerror = event => {
				if (this.#closedError) return;
				const record = event as unknown as Record<string, unknown>;
				const detail =
					(typeof record.message === "string" && record.message) ||
					(record.error instanceof Error && record.error.message) ||
					String(event.type);
				const error = new ResponsesWebSocketTransportError(
					"socket-error",
					this.#rejectConnect ? "connect" : "stream",
					`websocket error: ${detail}`,
					{ cause: record.error ?? event },
				);
				if (this.#rejectConnect) this.#retire(error, "socket-error");
				else this.#push(error);
			};
			socket.onclose = event => {
				if (this.#closedError) {
					socket.onerror = null;
					socket.onclose = null;
					return;
				}
				const connecting = this.#rejectConnect !== undefined;
				this.#retire(
					new ResponsesWebSocketTransportError(
						"closed",
						connecting ? "connect" : "stream",
						connecting ? `websocket closed before open (${event.code})` : `websocket closed (${event.code})`,
						{ cause: event },
					),
					"closed",
				);
			};
			socket.onmessage = event => this.#handleMessage(event.data);
		} catch (error) {
			this.#retire(
				new ResponsesWebSocketTransportError(
					"socket-error",
					"connect",
					`websocket error: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				),
				"socket-error",
			);
		}
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #joinConnect(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
		if (!signal) return promise;
		const aborted = Promise.withResolvers<void>();
		const onAbort = () =>
			aborted.reject(
				new ResponsesWebSocketTransportError("aborted", "connect", "request was aborted", { cause: signal.reason }),
			);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal.aborted) onAbort();
			await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#handleMessage(data: unknown): void {
		this.#lastInboundAt = Date.now();
		this.#writeDebugFrame(data);
		let parsed: Record<string, unknown>;
		let text: string;
		try {
			text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf-8");
			if (!text) return;
			parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
				const inner = parsed.error as Record<string, unknown>;
				if (typeof parsed.code !== "string" && typeof inner.code === "string") parsed.code = inner.code;
				if (typeof parsed.message !== "string" && typeof inner.message === "string") parsed.message = inner.message;
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const payload = typeof data === "string" ? data : "";
			const raw = [`: ws ← (parse-error: ${reason})`];
			if (payload) raw.push(`data: ${payload}`);
			notifyRawSseEvent(this.#streamObserver, { event: "parse_error", data: payload, raw });
			this.#push(new ResponsesWebSocketTransportError("protocol", "stream", String(error), { cause: error }));
			return;
		}
		notifyFrame(this.#streamObserver, parsed, text, "←");
		const control = this.#options.controlFrames?.consume(parsed);
		if (control instanceof Error) {
			if (this.#activeRequest) this.#push(control);
			return;
		}
		if (!control) this.#push(parsed);
	}

	async *streamRequest(
		exchange: ResponsesWebSocketExchange,
		timeouts: ResponsesWebSocketTimeouts,
		signal?: AbortSignal,
		observer?: (event: RawSseEvent) => void,
		onOwned?: () => void,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.isOpen())
			throw new ResponsesWebSocketTransportError("unavailable", "stream", "websocket connection is unavailable");
		if (this.#activeRequest)
			throw new ResponsesWebSocketTransportError("busy", "stream", "websocket request already in progress");
		if (signal?.aborted)
			throw new ResponsesWebSocketTransportError("aborted", "stream", "request was aborted", {
				cause: signal.reason,
			});
		this.#activeRequest = true;
		const onAbort = () =>
			this.#retire(
				new ResponsesWebSocketTransportError("aborted", "stream", "request was aborted", { cause: signal?.reason }),
				"aborted",
			);
		try {
			onOwned?.();
			this.#streamObserver = observer;
			if ("send" in exchange) this.#dropStaleFrames();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			if ("send" in exchange) {
				const debugSession = isRequestDebugEnabled()
					? await createRequestDebugSession({
							protocol: "websocket",
							method: "POST",
							url: this.#options.url,
							headers: this.#options.headers,
							body: exchange.send,
						})
					: undefined;
				this.#debugResponseLog = debugSession
					? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
					: undefined;
				this.sendControl(exchange.send);
			}
			let sawFirstEvent = false;
			let lastProgressAt = Date.now();
			let lastProgressEventType: string | undefined;
			let lastEventAt = lastProgressAt;
			let lastEventType: string | undefined;
			let activeResponseId: string | undefined;
			let lastSequence: number | undefined;
			const priorResponseId = this.#lastSeenResponseId;
			while (true) {
				const phase = sawFirstEvent ? "idle" : "first-event";
				const reason = timeoutMessage(
					sawFirstEvent ? "idle timeout waiting for websocket" : "timeout waiting for first websocket event",
					lastEventAt,
					lastEventType,
					lastProgressAt,
					lastProgressEventType,
				);
				let timeoutMs: number | undefined;
				if (sawFirstEvent) {
					if (timeouts.idleTimeoutMs !== undefined && timeouts.idleTimeoutMs > 0) {
						timeoutMs = timeouts.idleTimeoutMs - (Date.now() - lastProgressAt);
						if (timeoutMs <= 0) throw new ResponsesWebSocketTransportError("timeout", phase, reason);
					}
				} else if (timeouts.firstEventTimeoutMs !== undefined && timeouts.firstEventTimeoutMs > 0) {
					timeoutMs = timeouts.firstEventTimeoutMs;
				}
				const next = await this.#nextMessage(timeoutMs, reason, phase);
				if (next instanceof Error) throw next;
				const eventType = typeof next.type === "string" ? next.type : "";
				const frameResponseId = extractFrameResponseId(next);
				const frameSequence = extractFrameSequenceNumber(next);
				if (frameResponseId !== undefined) {
					if (activeResponseId === undefined) {
						if (priorResponseId !== undefined && frameResponseId === priorResponseId) continue;
						activeResponseId = frameResponseId;
					} else if (frameResponseId !== activeResponseId) {
						this.close("stale-frame");
						throw new ResponsesWebSocketTransportError(
							"protocol",
							"stream",
							`websocket frame for response ${frameResponseId} interleaved into active response ${activeResponseId}`,
						);
					}
					this.#lastSeenResponseId = frameResponseId;
				}
				if (frameSequence !== undefined) {
					if (activeResponseId !== undefined && lastSequence !== undefined && frameSequence < lastSequence) {
						this.close("stale-frame");
						throw new ResponsesWebSocketTransportError(
							"protocol",
							"stream",
							`websocket sequence_number ${frameSequence} regressed below ${lastSequence} within response ${activeResponseId}`,
						);
					}
					lastSequence = frameSequence;
				}
				sawFirstEvent = true;
				lastEventAt = Date.now();
				lastEventType = eventType || undefined;
				if (isResponsesWebSocketProgressEvent(next)) {
					lastProgressAt = lastEventAt;
					lastProgressEventType = lastEventType;
				}
				// Record before yielding: processors commonly break at the terminal yield.
				const terminal =
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error";
				yield next;
				if (terminal) break;
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			signal?.removeEventListener("abort", onAbort);
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	sendControl(frame: Record<string, unknown>): void {
		const payload = JSON.stringify(frame);
		notifyFrame(this.#streamObserver, frame, payload, "→");
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN || this.#closedError) {
			throw new ResponsesWebSocketTransportError("unavailable", "stream", "websocket connection is unavailable", {
				cause: this.#closedError?.cause,
			});
		}
		try {
			socket.send(payload);
		} catch (error) {
			throw new ResponsesWebSocketTransportError(
				"send",
				"stream",
				`websocket send failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	#retire(error: ResponsesWebSocketTransportError, reason: string): void {
		if (this.#closedError) return;
		this.#closedError = error;
		const socket = this.#socket;
		this.#socket = null;
		const reject = this.#rejectConnect;
		this.#clearConnect?.();
		reject?.(error);
		this.#stopHeartbeat();
		this.#push(error);
		this.#options.controlFrames?.closed(error);
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		// Built-in ws emits an error when closing CONNECTING; own it until physical close.
		const state = socket.readyState;
		if (state === WebSocket.CLOSED) {
			socket.onerror = null;
			socket.onclose = null;
		} else if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
			try {
				socket.close(1000, reason);
			} catch {
				/* Already retired locally. */
			}
		}
	}

	#writeDebugFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string" || data instanceof Uint8Array) log.write(data);
		else if (data instanceof ArrayBuffer) log.write(new Uint8Array(data));
		else log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const heartbeat = this.#options.heartbeat;
		if (!heartbeat || heartbeat.intervalMs <= 0) return;
		const target = socket as EventTarget;
		const onPong = () => {
			this.#lastInboundAt = Date.now();
		};
		if (typeof target.addEventListener === "function" && typeof target.removeEventListener === "function") {
			target.addEventListener("pong", onPong);
			this.#removePongListener = () => target.removeEventListener("pong", onPong);
		}
		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			if (
				heartbeat.pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > heartbeat.pongTimeoutMs
			) {
				this.#failQueue(
					new ResponsesWebSocketTransportError("pong-timeout", "stream", "websocket pong timeout"),
					"pong-timeout",
				);
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					new ResponsesWebSocketTransportError(
						"ping-failed",
						"stream",
						`websocket ping failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
					"ping-failed",
				);
			}
		}, heartbeat.intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		clearInterval(this.#heartbeatInterval);
		this.#heartbeatInterval = undefined;
		this.#removePongListener?.();
		this.#removePongListener = undefined;
		this.#lastPingAt = 0;
	}

	#failQueue(error: ResponsesWebSocketTransportError, closeReason: string): void {
		this.#queue.length = 0;
		this.#retire(error, closeReason);
	}

	#dropStaleFrames(): void {
		let retained = 0;
		for (const item of this.#queue) {
			if (item instanceof Error) this.#queue[retained++] = item;
		}
		this.#queue.length = retained;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error): void {
		// Preserve terminal frames ahead of an eager close/error.
		if (!(item instanceof Error) && this.#queue.length >= this.#options.messageQueueCapacity) {
			this.#failQueue(
				new ResponsesWebSocketTransportError(
					"queue-overflow",
					"stream",
					`websocket message queue exceeded ${this.#options.messageQueueCapacity} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		this.#wakeWaiters();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		detail: string,
		phase: "first-event" | "idle",
	): Promise<Record<string, unknown> | Error> {
		while (this.#queue.length === 0) {
			if (this.#closedError) return this.#closedError;
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			const timeout =
				timeoutMs !== undefined && timeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							const index = this.#waiters.indexOf(resolve);
							if (index >= 0) this.#waiters.splice(index, 1);
							resolve();
						}, timeoutMs)
					: undefined;
			await promise;
			clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0)
				return new ResponsesWebSocketTransportError("timeout", phase, detail);
		}
		return this.#queue.shift()!;
	}
}
