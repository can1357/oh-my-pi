import type { MaybePromise } from "./protocol";
import type { Stream } from "./stream";

/** JSON-RPC request identifier. */
export type JsonRpcId = string | number | null;
/** JSON-RPC request. */
export interface AnyRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}
/** JSON-RPC notification. */
export interface AnyNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
/** JSON-RPC error payload. */
export interface ErrorResponse {
	code: number;
	message: string;
	data?: unknown;
}
/** JSON-RPC response. */
export type AnyResponse = { jsonrpc: "2.0"; id: JsonRpcId } & ({ result: unknown } | { error: ErrorResponse });
/** Any JSON-RPC wire message. */
export type AnyMessage = AnyRequest | AnyNotification | AnyResponse;

/** Error returned by a JSON-RPC peer or handler. */
export class RequestError extends Error {
	/** JSON-RPC error code. */
	readonly code: number;
	/** Optional protocol error data. */
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RequestError";
		this.code = code;
		this.data = data;
	}

	/** Creates a JSON parse error. */
	static parseError(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32700, "Parse error", data, additionalMessage);
	}
	/** Creates an invalid-request error. */
	static invalidRequest(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32600, "Invalid request", data, additionalMessage);
	}
	/** Creates a method-not-found error. */
	static methodNotFound(method: string): RequestError {
		return new RequestError(-32601, `"Method not found": ${method}`, { method });
	}
	/** Creates an invalid-parameters error. */
	static invalidParams(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32602, "Invalid params", data, additionalMessage);
	}
	/** Creates an internal error. */
	static internalError(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32603, "Internal error", data, additionalMessage);
	}
	/** Creates a cancellation error. */
	static requestCancelled(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32800, "Request cancelled", data, additionalMessage);
	}
	/** Creates an authentication-required error. */
	static authRequired(data?: unknown, additionalMessage?: string): RequestError {
		return createStandardError(-32000, "Authentication required", data, additionalMessage);
	}
	/** Creates a resource-not-found error. */
	static resourceNotFound(uri?: string): RequestError {
		return new RequestError(
			-32002,
			uri === undefined ? "Resource not found" : `Resource not found: ${uri}`,
			uri === undefined ? undefined : { uri },
		);
	}
	/**
	 * Creates a session-busy error: the agent/session is already processing, so the
	 * request can be retried once idle (steer/follow-up/wait) instead of treating it
	 * as a fault. `message` carries the caller's user-facing wording; `data` should
	 * keep the stable discriminator shape (`reason: "session_busy"`).
	 */
	static sessionBusy(message: string, data?: unknown): RequestError {
		return new RequestError(-32003, message, data);
	}
	/** Converts this error into a JSON-RPC result. */
	toResult(): { error: ErrorResponse } {
		return { error: this.toErrorResponse() };
	}
	/** Converts this error into a JSON-RPC error payload. */
	toErrorResponse(): ErrorResponse {
		return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
	}
}

function createStandardError(
	code: number,
	message: string,
	data: unknown,
	additionalMessage: string | undefined,
): RequestError {
	return new RequestError(code, additionalMessage ? `${message}: ${additionalMessage}` : message, data);
}

type Dispatcher = (
	method: string,
	params: unknown,
	notification: boolean,
	/** Abort signal for an inbound *request*: fires when the peer cancels it via `$/cancel_request`. */
	signal?: AbortSignal,
) => MaybePromise<unknown>;
type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };

/** Options for {@link RpcConnection}. */
export interface RpcConnectionOptions {
	/**
	 * The dispatcher honors the abort signal it receives for inbound requests.
	 * Only then does a peer `$/cancel_request` abort the handler and answer the
	 * request `-32800` immediately; otherwise the handler runs to completion and
	 * its real result is the response, since answering "cancelled" while the
	 * work keeps going would hide its outcome from the peer.
	 */
	honorsInboundCancellation?: boolean;
}

/** Bound on clean-EOF inbound drain so `closed` cannot hang if a handler never settles. */
const INBOUND_DRAIN_TIMEOUT_MS = 30_000;

/** Correlated bidirectional JSON-RPC connection. */
export class RpcConnection {
	#nextId = 0;
	#pending = new Map<JsonRpcId, Pending>();
	#inbound = new Set<Promise<void>>();
	#openInboundIds = new Set<JsonRpcId>();
	/** Abort controller per inbound request, fired by a peer `$/cancel_request` (opt-in). */
	#inboundCancellers: Map<JsonRpcId, AbortController> | undefined;
	#writable: WritableStream<AnyMessage>;
	#writeTail: Promise<void> = Promise.resolve();
	#abort = new AbortController();
	#closed = Promise.withResolvers<void>();
	#dispatcher: Dispatcher;

	constructor(stream: Stream, dispatcher: Dispatcher, options?: RpcConnectionOptions) {
		this.#writable = stream.writable;
		this.#dispatcher = dispatcher;
		this.#inboundCancellers = options?.honorsInboundCancellation ? new Map() : undefined;
		void this.#read(stream.readable);
	}

	/** Signal aborted when the stream closes. */
	get signal(): AbortSignal {
		return this.#abort.signal;
	}
	/** Promise resolved when the stream closes. */
	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	/** Sends a correlated JSON-RPC request. */
	request<Response>(method: string, params?: unknown): Promise<Response> {
		if (this.signal.aborted) return Promise.reject(new Error("Connection closed"));
		return this.#beginRequest(method, params).deferred.promise as Promise<Response>;
	}

	/**
	 * Sends a JSON-RPC request whose pending entry can be cancelled locally:
	 * `cancel()` rejects the promise with a request-cancelled error, notifies
	 * the peer via `$/cancel_request`, and drops the pending entry so a late
	 * response is ignored. Used for agent→client requests a mid-turn event can
	 * supersede (e.g. a permission elicit cancelled when user steering arrives).
	 */
	requestCancellable<Response>(
		method: string,
		params?: unknown,
	): {
		promise: Promise<Response>;
		cancel(): void;
	} {
		if (this.signal.aborted) {
			return {
				promise: Promise.reject(new Error("Connection closed")),
				cancel: () => {},
			};
		}
		const { id, deferred } = this.#beginRequest(method, params);
		return {
			promise: deferred.promise as Promise<Response>,
			cancel: () => {
				if (!this.#pending.delete(id)) return;
				deferred.reject(RequestError.requestCancelled({ requestId: id, method }));
				void this.notify("$/cancel_request", { requestId: id }).catch(() => undefined);
			},
		};
	}

	/** Shared request plumbing: allocate an id, register the pending entry, write the frame. */
	#beginRequest(
		method: string,
		params: unknown,
	): {
		id: number;
		deferred: { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (reason?: unknown) => void };
	} {
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending.set(id, deferred);
		void this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
			this.#pending.delete(id);
			deferred.reject(error);
		});
		return { id, deferred };
	}

	/** Sends a JSON-RPC notification. */
	async notify(method: string, params?: unknown): Promise<void> {
		await this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	/** Closes the connection and rejects outstanding requests. */
	close(error?: unknown): void {
		if (this.signal.aborted) return;
		this.#abort.abort(error);
		for (const pending of this.#pending.values()) pending.reject(error ?? new Error("Connection closed"));
		this.#pending.clear();
		this.#closed.resolve();
	}

	#write(message: AnyMessage): Promise<void> {
		const write = this.#writeTail.then(async () => {
			const writer = this.#writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
		});
		this.#writeTail = write.catch(() => {});
		return write;
	}

	async #read(readable: ReadableStream<AnyMessage>): Promise<void> {
		const reader = readable.getReader();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				this.#dispatch(next.value);
			}
			await this.#drainInbound();
			this.close();
		} catch (error) {
			this.close(error);
		} finally {
			reader.releaseLock();
		}
	}

	#dispatch(message: AnyMessage): void {
		if ("method" in message && "id" in message) this.#openInboundIds.add(message.id);
		const task = this.#handle(message).catch(error => this.close(error));
		this.#inbound.add(task);
		void task.finally(() => this.#inbound.delete(task));
	}

	async #drainInbound(): Promise<void> {
		if (this.#inbound.size === 0) return;
		const drained = Promise.allSettled(this.#inbound).then(() => {});
		let timer: Timer | undefined;
		const timedOut = await Promise.race([
			drained.then(() => false),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(true), INBOUND_DRAIN_TIMEOUT_MS);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		if (!timedOut) return;
		const error = RequestError.internalError(undefined, "Inbound request drain timed out").toErrorResponse();
		await Promise.allSettled([...this.#openInboundIds].map(id => this.#respond(id, { error })));
	}

	#respond(id: JsonRpcId, body: { result: unknown } | { error: ErrorResponse }): Promise<void> {
		if (!this.#openInboundIds.delete(id)) return Promise.resolve();
		return this.#write({ jsonrpc: "2.0", id, ...body });
	}

	async #handle(message: AnyMessage): Promise<void> {
		if ("id" in message && !("method" in message)) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if ("error" in message)
				pending.reject(new RequestError(message.error.code, message.error.message, message.error.data));
			else pending.resolve(message.result);
			return;
		}
		if (!("method" in message)) return;
		if (!("id" in message)) {
			// ACP v1 names the cancelled request `requestId`. A cancelled
			// inbound request must still be answered (spec: result or
			// `-32800`): the handler is aborted and the error response is
			// written here, so a late-settling handler lands in `#respond`'s
			// closed-id no-op instead of answering a request the peer gave
			// up on.
			if (message.method === "$/cancel_request" && this.#inboundCancellers) {
				this.#cancelInbound(
					this.#inboundCancellers,
					(message.params as { requestId?: JsonRpcId } | undefined)?.requestId,
				);
			}
			try {
				await this.#dispatcher(message.method, message.params, true);
			} catch {
				/* Notifications have no error channel. */
			}
			return;
		}
		const cancellers = this.#inboundCancellers;
		const canceller = cancellers ? new AbortController() : undefined;
		if (canceller) cancellers?.set(message.id, canceller);
		try {
			const result = await this.#dispatcher(message.method, message.params, false, canceller?.signal);
			await this.#respond(message.id, { result: result ?? {} });
		} catch (error) {
			const protocolError =
				error instanceof RequestError
					? error
					: RequestError.internalError({ details: error instanceof Error ? error.message : String(error) });
			await this.#respond(message.id, { error: protocolError.toErrorResponse() });
		} finally {
			cancellers?.delete(message.id);
		}
	}

	#cancelInbound(cancellers: Map<JsonRpcId, AbortController>, id: JsonRpcId | undefined): void {
		if (id === undefined) return;
		const canceller = cancellers.get(id);
		if (canceller) {
			cancellers.delete(id);
			canceller.abort(RequestError.requestCancelled({ requestId: id }));
		}
		// Spec: a cancelled request still gets a response. Answer `-32800`
		// here — synchronously with the notification — so the peer is never
		// left waiting on a handler that may never settle. `#respond` closes
		// the id, so a late handler result (a handler that ignored its abort
		// signal) lands in the closed-id no-op instead of answering twice.
		void this.#respond(id, { error: RequestError.requestCancelled({ requestId: id }).toErrorResponse() }).catch(
			() => undefined,
		);
	}
}
