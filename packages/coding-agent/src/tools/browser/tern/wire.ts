/**
 * Client for the Tern session daemon's browser relay: a Unix socket speaking
 * Tern's wire frames (`u32` LE length + payload; payload = tag byte, LE
 * integers, `u32`-length UTF-8 strings). omp greets as a script client, then
 * sends `Request::Browser { id, json }` and receives `Reply::Browser { id, json }`
 * answers, correlated by `id`. The JSON is Tern's browser op protocol: a
 * request `{"op": …}` answers `{"ok": result}` or `{"error": {"kind", "message"}}`.
 */
import * as net from "node:net";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Tern wire protocol version omp speaks. */
export const TERN_WIRE_VERSION = 6;

/** Tag of the daemon's `Welcome` reply. */
const TAG_WELCOME = 0;
/** Tag of the daemon's `Refused` reply. */
const TAG_REFUSED = 1;
/** Tag of the daemon's `Browser` reply. */
const TAG_BROWSER_REPLY = 30;
/** Tag of the script's `Browser` request. */
const TAG_BROWSER_REQUEST = 40;
/** Tag of the script's `Hello` request. */
const TAG_HELLO = 0;
/** `ClientKind::Cli` on the wire. */
const CLIENT_KIND_CLI = 1;
/** Frames larger than this are a protocol error (the daemon's own cap). */
const MAX_FRAME_BYTES = 256 << 20;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Error kinds a Tern browser op answers with, plus the client's own failures. */
export type TernErrorKind =
	| "invalid"
	| "not_found"
	| "no_window"
	| "window_closed"
	| "unsupported"
	| "js"
	| "failed"
	| "refused"
	| "connect"
	| "closed"
	| "timeout"
	| "protocol";

/** A failed Tern browser op or connection, carrying the protocol's error kind. */
export class TernBrowserError extends ToolError {
	/** Why it failed (the protocol's `error.kind`, or the client's own). */
	readonly kind: TernErrorKind;

	constructor(kind: TernErrorKind, message: string) {
		super(message);
		this.name = "TernBrowserError";
		this.kind = kind;
	}
}

/** Error kinds meaning "this Tern cannot host a browser for omp right now". */
const UNAVAILABLE_KINDS: Partial<Record<TernErrorKind, true>> = {
	no_window: true,
	unsupported: true,
	refused: true,
	connect: true,
};

/** Whether `error` says Tern cannot host a browser at all (auto mode falls back to Chromium). */
export function isTernUnavailable(error: unknown): error is TernBrowserError {
	return error instanceof TernBrowserError && UNAVAILABLE_KINDS[error.kind] === true;
}

/** Frame `payload` for the wire: `u32` LE length then the payload. */
export function encodeTernFrame(payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + payload.length);
	new DataView(frame.buffer).setUint32(0, payload.length, true);
	frame.set(payload, 4);
	return frame;
}

/** The script hello payload: `Hello { version, identity: None, kind: Cli }`. */
export function ternHelloPayload(): Uint8Array {
	const payload = new Uint8Array(7);
	const view = new DataView(payload.buffer);
	payload[0] = TAG_HELLO;
	view.setUint32(1, TERN_WIRE_VERSION, true);
	payload[5] = 0;
	payload[6] = CLIENT_KIND_CLI;
	return payload;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** `Request::Browser { id, json }` as a payload. */
export function ternBrowserRequestPayload(id: bigint, json: string): Uint8Array {
	const text = UTF8_ENCODER.encode(json);
	const payload = new Uint8Array(1 + 8 + 4 + text.length);
	const view = new DataView(payload.buffer);
	payload[0] = TAG_BROWSER_REQUEST;
	view.setBigUint64(1, id, true);
	view.setUint32(9, text.length, true);
	payload.set(text, 13);
	return payload;
}

/** A reply payload the client understands; anything else is `other`. */
export type TernReply =
	| { type: "welcome" }
	| { type: "refused"; reason: string }
	| { type: "browser"; id: bigint; json: string }
	| { type: "other"; tag: number };

/** Decode one reply payload. Throws a `protocol` error on a truncated or malformed known reply. */
export function decodeTernReply(payload: Uint8Array): TernReply {
	if (payload.length === 0) throw new TernBrowserError("protocol", "Tern sent an empty frame");
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const tag = payload[0]!;
	const readString = (offset: number): string => {
		if (offset + 4 > payload.length) throw new TernBrowserError("protocol", `Tern reply ${tag} is truncated`);
		const length = view.getUint32(offset, true);
		if (offset + 4 + length > payload.length) {
			throw new TernBrowserError("protocol", `Tern reply ${tag} is truncated`);
		}
		try {
			return UTF8_DECODER.decode(payload.subarray(offset + 4, offset + 4 + length));
		} catch {
			throw new TernBrowserError("protocol", `Tern reply ${tag} carries invalid UTF-8`);
		}
	};
	switch (tag) {
		case TAG_WELCOME:
			return { type: "welcome" };
		case TAG_REFUSED:
			return { type: "refused", reason: readString(1) };
		case TAG_BROWSER_REPLY: {
			if (payload.length < 9) throw new TernBrowserError("protocol", "Tern browser reply is truncated");
			return { type: "browser", id: view.getBigUint64(1, true), json: readString(9) };
		}
		default:
			return { type: "other", tag };
	}
}

/**
 * Incremental splitter of the socket byte stream into frame payloads. Chunks
 * are queued as they arrive and each frame is assembled once when complete,
 * so a large frame arriving in many chunks costs linear, not quadratic, copying.
 */
export class TernFrameReader {
	readonly #chunks: Uint8Array[] = [];
	/** Bytes of `#chunks[0]` already consumed. */
	#head = 0;
	#buffered = 0;

	/** Append `chunk` and return every complete payload it finished. */
	push(chunk: Uint8Array): Uint8Array[] {
		if (chunk.length > 0) {
			this.#chunks.push(chunk);
			this.#buffered += chunk.length;
		}
		const payloads: Uint8Array[] = [];
		while (this.#buffered >= 4) {
			const header = this.#peek(4);
			const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
			if (length > MAX_FRAME_BYTES) {
				throw new TernBrowserError("protocol", `Tern sent a ${length}-byte frame (limit ${MAX_FRAME_BYTES})`);
			}
			if (this.#buffered < 4 + length) break;
			this.#take(4);
			payloads.push(this.#take(length));
		}
		return payloads;
	}

	/** The next `count` bytes without consuming them. */
	#peek(count: number): Uint8Array {
		const first = this.#chunks[0]!;
		if (first.length - this.#head >= count) return first.subarray(this.#head, this.#head + count);
		const out = new Uint8Array(count);
		let filled = 0;
		let head = this.#head;
		for (const chunk of this.#chunks) {
			const part = chunk.subarray(head, Math.min(chunk.length, head + count - filled));
			out.set(part, filled);
			filled += part.length;
			head = 0;
			if (filled === count) break;
		}
		return out;
	}

	/** Consume `count` bytes (copied into one array unless they sit in a single chunk). */
	#take(count: number): Uint8Array {
		const first = this.#chunks[0];
		let out: Uint8Array;
		if (first && first.length - this.#head >= count) {
			out = first.subarray(this.#head, this.#head + count);
			this.#head += count;
		} else {
			out = new Uint8Array(count);
			let filled = 0;
			while (filled < count) {
				const chunk = this.#chunks[0]!;
				const part = chunk.subarray(this.#head, Math.min(chunk.length, this.#head + count - filled));
				out.set(part, filled);
				filled += part.length;
				this.#head += part.length;
				if (this.#head === chunk.length) {
					this.#chunks.shift();
					this.#head = 0;
				}
			}
		}
		if (this.#chunks.length > 0 && this.#head === this.#chunks[0]!.length) {
			this.#chunks.shift();
			this.#head = 0;
		}
		this.#buffered -= count;
		return out;
	}
}

/** Options for one browser op. */
export interface TernRequestOptions {
	/** Give up after this long (default 30 s); the daemon never times out itself. */
	timeoutMs?: number;
	/** Abandon the op when this aborts. */
	signal?: AbortSignal;
	/**
	 * Called with the `ok` result when the answer arrives after the op was
	 * abandoned (timeout/abort): lets callers undo effects nobody awaited any
	 * more (e.g. close a PiP an abandoned `open` created).
	 */
	onLateAnswer?: (value: unknown) => void;
}

interface PendingOp {
	op: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: NodeJS.Timeout;
	cleanup(): void;
	onLateAnswer?: (value: unknown) => void;
}

/** Abandoned ops whose late answers are still of interest, at most this many. */
const ABANDONED_LIMIT = 256;

/** The browser op's `ok` result; its `error` (or a malformed answer) throws a {@link TernBrowserError}. */
function answerOf(op: string, json: string): unknown {
	let answer: unknown;
	try {
		answer = JSON.parse(json);
	} catch {
		throw new TernBrowserError("protocol", `Tern answered ${op} with invalid JSON`);
	}
	if (answer && typeof answer === "object") {
		if ("ok" in answer) return answer.ok;
		if ("error" in answer && answer.error && typeof answer.error === "object") {
			const error = answer.error;
			const kind = "kind" in error && typeof error.kind === "string" ? error.kind : "failed";
			const message = "message" in error && typeof error.message === "string" ? error.message : "failed";
			throw new TernBrowserError(
				PROTOCOL_ERROR_KINDS[kind] ?? "failed",
				`Tern browser ${op} failed (${kind}): ${message}`,
			);
		}
	}
	throw new TernBrowserError("protocol", `Tern answered ${op} without "ok" or "error"`);
}

/** The protocol's `error.kind` values by name. */
const PROTOCOL_ERROR_KINDS: Record<string, TernErrorKind> = {
	invalid: "invalid",
	not_found: "not_found",
	no_window: "no_window",
	window_closed: "window_closed",
	unsupported: "unsupported",
	js: "js",
	failed: "failed",
};

/**
 * One connection to the Tern daemon's browser relay. `connect` greets and
 * waits for the welcome; `request` sends one op and resolves its `ok`
 * result (rejecting with a {@link TernBrowserError}). Requests run
 * concurrently; closing rejects everything pending.
 */
export class TernSocketClient {
	readonly #socketPath: string;
	#socket: net.Socket | undefined;
	#connecting: Promise<void> | undefined;
	#welcomed = false;
	#closed = false;
	#closeError: TernBrowserError | undefined;
	#nextId = 1n;
	readonly #pending = new Map<bigint, PendingOp>();
	readonly #abandoned = new Map<bigint, { op: string; onLateAnswer: (value: unknown) => void }>();
	readonly #reader = new TernFrameReader();
	#greeting: { resolve(): void; reject(error: unknown): void } | undefined;

	constructor(opts: { socketPath: string }) {
		this.#socketPath = opts.socketPath;
	}

	/** The daemon socket this client talks to. */
	get socketPath(): string {
		return this.#socketPath;
	}

	/** Whether the connection is up and welcomed. */
	get connected(): boolean {
		return this.#welcomed && !this.#closed;
	}

	/** Open the socket and greet; resolves once the daemon welcomed omp. */
	async connect(): Promise<void> {
		if (this.#closed) throw this.#closeError ?? new TernBrowserError("closed", "Tern connection closed");
		if (this.#welcomed) return;
		this.#connecting ??= this.#open();
		try {
			await this.#connecting;
		} finally {
			this.#connecting = undefined;
		}
	}

	/** Send `op` (an object with an `op` field) and resolve its `ok` result. */
	async request(op: Record<string, unknown>, opts: TernRequestOptions = {}): Promise<unknown> {
		const name = typeof op.op === "string" ? op.op : "op";
		opts.signal?.throwIfAborted();
		await this.connect();
		opts.signal?.throwIfAborted();
		const socket = this.#socket;
		if (!socket || this.#closed) throw this.#closeError ?? new TernBrowserError("closed", "Tern connection closed");
		const id = this.#nextId++;
		let json: string;
		try {
			json = JSON.stringify(op);
		} catch (error) {
			throw new TernBrowserError(
				"invalid",
				`Tern browser ${name} has arguments that are not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const frameBytes = encodeTernFrame(ternBrowserRequestPayload(id, json));
		const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const onAbort = (): void => {
			this.#abandon(id, opts.signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			this.#abandon(id, new TernBrowserError("timeout", `Tern browser ${name} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		this.#pending.set(id, {
			op: name,
			resolve,
			reject,
			timer,
			cleanup: () => opts.signal?.removeEventListener("abort", onAbort),
			onLateAnswer: opts.onLateAnswer,
		});
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			socket.write(frameBytes);
		} catch (error) {
			this.#settle(
				id,
				new TernBrowserError(
					"closed",
					`Tern connection failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
		return await promise;
	}

	/** Close the connection; every pending op rejects. */
	close(): void {
		this.#fail(new TernBrowserError("closed", "Tern connection closed"));
	}

	async #open(): Promise<void> {
		const socket = net.createConnection({ path: this.#socketPath });
		this.#socket = socket;
		const greeting = Promise.withResolvers<void>();
		this.#greeting = greeting;
		const timer = setTimeout(() => {
			this.#fail(
				new TernBrowserError("connect", `Tern daemon at ${this.#socketPath} did not answer the greeting in time`),
			);
		}, CONNECT_TIMEOUT_MS);
		timer.unref();
		socket.on("connect", () => socket.write(encodeTernFrame(ternHelloPayload())));
		socket.on("data", chunk => this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
		socket.on("error", error => {
			this.#fail(
				this.#welcomed
					? new TernBrowserError("closed", `Tern connection failed: ${error.message}`)
					: new TernBrowserError(
							"connect",
							`Cannot reach the Tern daemon at ${this.#socketPath}: ${error.message}`,
						),
			);
		});
		socket.on("close", () => {
			this.#fail(
				this.#welcomed
					? new TernBrowserError("closed", "Tern daemon closed the connection")
					: new TernBrowserError(
							"connect",
							`Tern daemon at ${this.#socketPath} closed the connection before greeting`,
						),
			);
		});
		try {
			await greeting.promise;
		} finally {
			clearTimeout(timer);
			this.#greeting = undefined;
		}
	}

	#onData(chunk: Uint8Array): void {
		let payloads: Uint8Array[];
		try {
			payloads = this.#reader.push(chunk);
		} catch (error) {
			this.#fail(error instanceof TernBrowserError ? error : new TernBrowserError("protocol", String(error)));
			return;
		}
		for (const payload of payloads) {
			let reply: TernReply;
			try {
				reply = decodeTernReply(payload);
			} catch (error) {
				this.#fail(error instanceof TernBrowserError ? error : new TernBrowserError("protocol", String(error)));
				return;
			}
			switch (reply.type) {
				case "welcome":
					this.#welcomed = true;
					this.#greeting?.resolve();
					break;
				case "refused":
					this.#fail(
						new TernBrowserError(
							"refused",
							`Tern refused omp's browser connection: ${reply.reason} (omp speaks Tern protocol ${TERN_WIRE_VERSION})`,
						),
					);
					return;
				case "browser": {
					const pending = this.#pending.get(reply.id);
					if (!pending) {
						this.#lateAnswer(reply.id, reply.json);
						break;
					}
					let value: unknown;
					try {
						value = answerOf(pending.op, reply.json);
					} catch (error) {
						this.#settle(reply.id, error);
						break;
					}
					this.#take(reply.id)?.resolve(value);
					break;
				}
				case "other":
					break;
			}
		}
	}

	#take(id: bigint): PendingOp | undefined {
		const pending = this.#pending.get(id);
		if (!pending) return undefined;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.cleanup();
		return pending;
	}

	#settle(id: bigint, error: unknown): void {
		this.#take(id)?.reject(error);
	}

	/** Reject an op nobody waits for any more, remembering it when its late answer matters. */
	#abandon(id: bigint, error: unknown): void {
		const pending = this.#take(id);
		if (!pending) return;
		if (pending.onLateAnswer) {
			this.#abandoned.set(id, { op: pending.op, onLateAnswer: pending.onLateAnswer });
			if (this.#abandoned.size > ABANDONED_LIMIT) this.#abandoned.delete(this.#abandoned.keys().next().value!);
		}
		pending.reject(error);
	}

	#lateAnswer(id: bigint, json: string): void {
		const abandoned = this.#abandoned.get(id);
		if (!abandoned) return;
		this.#abandoned.delete(id);
		let value: unknown;
		try {
			value = answerOf(abandoned.op, json);
		} catch {
			return;
		}
		abandoned.onLateAnswer(value);
	}

	#fail(error: TernBrowserError): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeError = error;
		this.#abandoned.clear();
		this.#greeting?.reject(error);
		// Settling deletes the entry; a Map's iteration skips deleted entries safely.
		for (const id of this.#pending.keys()) this.#settle(id, error);
		this.#socket?.destroy();
		this.#socket = undefined;
	}
}
