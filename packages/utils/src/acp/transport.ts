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

type Dispatcher = (method: string, params: unknown, notification: boolean) => MaybePromise<unknown>;
type Pending = { resolve(value: unknown): void; reject(reason: unknown): void };

/** Correlated bidirectional JSON-RPC connection. */
export class RpcConnection {
	#nextId = 0;
	#pending = new Map<JsonRpcId, Pending>();
	#writable: WritableStream<AnyMessage>;
	#writeTail: Promise<void> = Promise.resolve();
	#abort = new AbortController();
	#closed = Promise.withResolvers<void>();
	#dispatcher: Dispatcher;

	constructor(stream: Stream, dispatcher: Dispatcher) {
		this.#writable = stream.writable;
		this.#dispatcher = dispatcher;
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
		const id = this.#nextId++;
		const deferred = Promise.withResolvers<unknown>();
		this.#pending.set(id, deferred);
		void this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
			this.#pending.delete(id);
			deferred.reject(error);
		});
		return deferred.promise as Promise<Response>;
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
				void this.#handle(next.value).catch(error => this.close(error));
			}
			this.close();
		} catch (error) {
			this.close(error);
		} finally {
			reader.releaseLock();
		}
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
			try {
				await this.#dispatcher(message.method, message.params, true);
			} catch {
				/* Notifications have no error channel. */
			}
			return;
		}
		try {
			const result = await this.#dispatcher(message.method, message.params, false);
			await this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
		} catch (error) {
			const protocolError =
				error instanceof RequestError
					? error
					: RequestError.internalError({ details: error instanceof Error ? error.message : String(error) });
			await this.#write({ jsonrpc: "2.0", id: message.id, error: protocolError.toErrorResponse() });
		}
	}
}
