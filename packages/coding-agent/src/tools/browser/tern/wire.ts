/**
 * Client for the Tern session daemon: a Unix socket speaking Tern's JSON
 * script protocol (`crates/tern/src/daemon/json.rs` in the stencil
 * repository), frames of a `u32` LE length then one UTF-8 JSON object. omp
 * greets with `{"hello":{}}` and waits for `{"welcome":{"ops":[…]}}`, whose
 * `ops` list the request kinds this Tern answers (an older Tern lists none
 * and answers only `browser`). Requests are `{"id":N,KIND:REQUEST}`, answered
 * `{"id":N,KIND:ANSWER}` correlated by `id`, where ANSWER is `{"ok": result}`
 * or `{"error": {"kind", "message"}}`:
 * - `browser`: Tern's browser op protocol, REQUEST `{"op": …}`.
 * - `fork`: REQUEST `{"block":P,"dir":"right"|"down"}` opens `omp --fork` of
 *   pane P's session in a new pane beside it; result `{"block":M}`.
 *
 * Members and message kinds either side does not know are skipped, so the
 * protocol does not tie omp to a Tern build. A Tern from before it cannot read
 * the hello and hangs up.
 */
import * as net from "node:net";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Frames larger than this are a protocol error (the daemon's own cap). */
const MAX_FRAME_BYTES = 256 << 20;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Error kinds a Tern request answers with, plus the client's own failures. */
export type TernErrorKind =
	| "invalid"
	| "not_found"
	| "not_agent"
	| "no_window"
	| "window_closed"
	| "unsupported"
	| "js"
	| "failed"
	| "connect"
	| "closed"
	| "timeout"
	| "protocol";

/** A failed Tern request or connection, carrying the protocol's error kind. */
export class TernError extends ToolError {
	/** Why it failed (the protocol's `error.kind`, or the client's own). */
	readonly kind: TernErrorKind;

	constructor(kind: TernErrorKind, message: string) {
		super(message);
		this.name = "TernError";
		this.kind = kind;
	}
}

/** Error kinds meaning "this Tern cannot host a browser for omp right now". */
const UNAVAILABLE_KINDS: Partial<Record<TernErrorKind, true>> = {
	no_window: true,
	unsupported: true,
	connect: true,
};

/** Whether `error` says Tern cannot host a browser at all (auto mode falls back to Chromium). */
export function isTernUnavailable(error: unknown): error is TernError {
	return error instanceof TernError && UNAVAILABLE_KINDS[error.kind] === true;
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** `message` as a frame: `u32` LE length then its JSON. Throws what `JSON.stringify` throws (cycles, bigints). */
export function encodeTernFrame(message: object): Uint8Array {
	const text = JSON.stringify(message);
	const frame = new Uint8Array(4 + Buffer.byteLength(text, "utf8"));
	const { written } = UTF8_ENCODER.encodeInto(text, frame.subarray(4));
	new DataView(frame.buffer).setUint32(0, written, true);
	return frame;
}

/** Request kinds whose answers the client correlates by id. */
export type TernChannel = "browser" | "fork";

/** A reply the client understands; a kind it does not know (a newer Tern's) is `other`. */
export type TernReply =
	| { type: "welcome"; ops: string[] }
	| { type: TernChannel; id: number; answer: unknown }
	| { type: "other" };

/** Decode one reply payload. Throws a `protocol` error when it is not a JSON object or its answer has no id. */
export function decodeTernReply(payload: Uint8Array): TernReply {
	let reply: unknown;
	try {
		reply = JSON.parse(UTF8_DECODER.decode(payload));
	} catch (error) {
		throw new TernError(
			"protocol",
			`Tern sent a frame that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
		throw new TernError("protocol", "Tern sent a frame that is not a JSON object");
	}
	if ("welcome" in reply) {
		const welcome = reply.welcome;
		const ops =
			welcome && typeof welcome === "object" && "ops" in welcome && Array.isArray(welcome.ops)
				? welcome.ops.filter((op): op is string => typeof op === "string")
				: [];
		return { type: "welcome", ops };
	}
	const channel = "browser" in reply ? "browser" : "fork" in reply ? "fork" : undefined;
	if (!channel) return { type: "other" };
	const id = "id" in reply ? reply.id : undefined;
	if (typeof id !== "number") throw new TernError("protocol", `Tern sent a ${channel} answer without an id`);
	return { type: channel, id, answer: (reply as Record<string, unknown>)[channel] };
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
				throw new TernError("protocol", `Tern sent a ${length}-byte frame (limit ${MAX_FRAME_BYTES})`);
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

/** Options for one request. */
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

/** A `fork` request: open `omp --fork` of pane `block`'s session in a new pane beside it. */
export interface TernForkRequest {
	/** The pane whose omp session to fork (`TERN_PANE`). */
	block: number;
	/** Where the new pane goes (Tern's default: `right`). */
	dir?: "right" | "down";
}

interface PendingOp {
	channel: TernChannel;
	/** Names the request in errors, e.g. `browser open`. */
	label: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: NodeJS.Timeout;
	cleanup(): void;
	onLateAnswer?: (value: unknown) => void;
}

/** Abandoned ops whose late answers are still of interest, at most this many. */
const ABANDONED_LIMIT = 256;

/** The answer's `ok` result; its `error` (or a malformed answer) throws a {@link TernError}. */
function answerOf(label: string, answer: unknown): unknown {
	if (answer && typeof answer === "object") {
		if ("ok" in answer) return answer.ok;
		if ("error" in answer && answer.error && typeof answer.error === "object") {
			const error = answer.error;
			const kind = "kind" in error && typeof error.kind === "string" ? error.kind : "failed";
			const message = "message" in error && typeof error.message === "string" ? error.message : "failed";
			throw new TernError(PROTOCOL_ERROR_KINDS[kind] ?? "failed", `Tern ${label} failed (${kind}): ${message}`);
		}
	}
	throw new TernError("protocol", `Tern answered ${label} without "ok" or "error"`);
}

/** The protocol's `error.kind` values by name. */
const PROTOCOL_ERROR_KINDS: Record<string, TernErrorKind> = {
	invalid: "invalid",
	not_found: "not_found",
	not_agent: "not_agent",
	no_window: "no_window",
	window_closed: "window_closed",
	unsupported: "unsupported",
	js: "js",
	failed: "failed",
};

/**
 * One connection to the Tern daemon. `connect` greets and waits for the
 * welcome; `request` sends one browser op and `fork` one fork, each resolving
 * its `ok` result (rejecting with a {@link TernError}). Requests run
 * concurrently; closing rejects everything pending.
 */
export class TernSocketClient {
	readonly #socketPath: string;
	#socket: net.Socket | undefined;
	#connecting: Promise<void> | undefined;
	#welcomed = false;
	#ops: ReadonlySet<string> = new Set();
	#closed = false;
	#closeError: TernError | undefined;
	#nextId = 1;
	readonly #pending = new Map<number, PendingOp>();
	readonly #abandoned = new Map<number, { label: string; onLateAnswer: (value: unknown) => void }>();
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

	/** Whether the welcome listed request kind `op` (an older Tern lists none, yet answers `browser`). */
	supports(op: string): boolean {
		return this.#ops.has(op);
	}

	/** Open the socket and greet; resolves once the daemon welcomed omp. */
	async connect(): Promise<void> {
		if (this.#closed) throw this.#closeError ?? new TernError("closed", "Tern connection closed");
		if (this.#welcomed) return;
		this.#connecting ??= this.#open();
		try {
			await this.#connecting;
		} finally {
			this.#connecting = undefined;
		}
	}

	/** Send browser `op` (an object with an `op` field) and resolve its `ok` result. */
	async request(op: Record<string, unknown>, opts: TernRequestOptions = {}): Promise<unknown> {
		return await this.#send("browser", op, `browser ${typeof op.op === "string" ? op.op : "op"}`, opts);
	}

	/** Send a fork request and resolve the new pane's block. Only a Tern that {@link supports} `fork` answers it. */
	async fork(request: TernForkRequest, opts: TernRequestOptions = {}): Promise<number> {
		const result = await this.#send("fork", request, "fork", opts);
		const block = result && typeof result === "object" && "block" in result ? result.block : undefined;
		if (typeof block !== "number") throw new TernError("protocol", 'Tern answered fork without a "block"');
		return block;
	}

	async #send(channel: TernChannel, body: object, label: string, opts: TernRequestOptions): Promise<unknown> {
		opts.signal?.throwIfAborted();
		await this.connect();
		opts.signal?.throwIfAborted();
		const socket = this.#socket;
		if (!socket || this.#closed) throw this.#closeError ?? new TernError("closed", "Tern connection closed");
		const id = this.#nextId++;
		let frameBytes: Uint8Array;
		try {
			frameBytes = encodeTernFrame({ id, [channel]: body });
		} catch (error) {
			throw new TernError(
				"invalid",
				`Tern ${label} has arguments that are not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const onAbort = (): void => {
			this.#abandon(id, opts.signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			this.#abandon(id, new TernError("timeout", `Tern ${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		this.#pending.set(id, {
			channel,
			label,
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
				new TernError(
					"closed",
					`Tern connection failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
		return await promise;
	}

	/** Close the connection; every pending op rejects. */
	close(): void {
		this.#fail(new TernError("closed", "Tern connection closed"));
	}

	async #open(): Promise<void> {
		const socket = net.createConnection({ path: this.#socketPath });
		this.#socket = socket;
		const greeting = Promise.withResolvers<void>();
		this.#greeting = greeting;
		const timer = setTimeout(() => {
			this.#fail(new TernError("connect", `Tern daemon at ${this.#socketPath} did not answer the greeting in time`));
		}, CONNECT_TIMEOUT_MS);
		timer.unref();
		socket.on("connect", () => socket.write(encodeTernFrame({ hello: {} })));
		socket.on("data", chunk => this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
		socket.on("error", error => {
			this.#fail(
				this.#welcomed
					? new TernError("closed", `Tern connection failed: ${error.message}`)
					: new TernError("connect", `Cannot reach the Tern daemon at ${this.#socketPath}: ${error.message}`),
			);
		});
		socket.on("close", () => {
			this.#fail(
				this.#welcomed
					? new TernError("closed", "Tern daemon closed the connection")
					: new TernError(
							"connect",
							`Tern daemon at ${this.#socketPath} closed the connection before greeting: a Tern without omp's JSON protocol cannot read its hello (update Tern)`,
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
			this.#fail(error instanceof TernError ? error : new TernError("protocol", String(error)));
			return;
		}
		for (const payload of payloads) {
			let reply: TernReply;
			try {
				reply = decodeTernReply(payload);
			} catch (error) {
				this.#fail(error instanceof TernError ? error : new TernError("protocol", String(error)));
				return;
			}
			switch (reply.type) {
				case "welcome":
					this.#ops = new Set(reply.ops);
					this.#welcomed = true;
					this.#greeting?.resolve();
					break;
				case "browser":
				case "fork": {
					const pending = this.#pending.get(reply.id);
					if (!pending) {
						this.#lateAnswer(reply.id, reply.answer);
						break;
					}
					if (pending.channel !== reply.type) {
						this.#settle(
							reply.id,
							new TernError("protocol", `Tern answered ${pending.label} with a ${reply.type} answer`),
						);
						break;
					}
					let value: unknown;
					try {
						value = answerOf(pending.label, reply.answer);
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

	#take(id: number): PendingOp | undefined {
		const pending = this.#pending.get(id);
		if (!pending) return undefined;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.cleanup();
		return pending;
	}

	#settle(id: number, error: unknown): void {
		this.#take(id)?.reject(error);
	}

	/** Reject an op nobody waits for any more, remembering it when its late answer matters. */
	#abandon(id: number, error: unknown): void {
		const pending = this.#take(id);
		if (!pending) return;
		if (pending.onLateAnswer) {
			this.#abandoned.set(id, { label: pending.label, onLateAnswer: pending.onLateAnswer });
			if (this.#abandoned.size > ABANDONED_LIMIT) this.#abandoned.delete(this.#abandoned.keys().next().value!);
		}
		pending.reject(error);
	}

	#lateAnswer(id: number, answer: unknown): void {
		const abandoned = this.#abandoned.get(id);
		if (!abandoned) return;
		this.#abandoned.delete(id);
		let value: unknown;
		try {
			value = answerOf(abandoned.label, answer);
		} catch {
			return;
		}
		abandoned.onLateAnswer(value);
	}

	#fail(error: TernError): void {
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
