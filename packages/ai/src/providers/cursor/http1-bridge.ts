import { randomUUID } from "node:crypto";
import type * as http2 from "node:http2";
import { getProxyForUrl } from "../../utils/proxy";
import {
	CONNECT_FLAG_COMPRESSED,
	CONNECT_FLAG_END_STREAM,
	CONNECT_FLAG_RESERVED_MASK,
	type ConnectFrame,
	ConnectFrameDecoder,
	ConnectProtocolError,
	encodeConnectFrame,
} from "./connect-frame";

export interface CursorHttp1BridgeAttempt {
	write(frame: Buffer): void;
	frames(): AsyncIterable<ConnectFrame>;
	trailers(): Promise<http2.IncomingHttpHeaders>;
	close(): void;
}

interface PollResponse {
	seqno: bigint;
	data: string;
	eof: boolean;
}
/**
 * The first poll response carries seqno `0n`: Cursor's bidi poll numbers server
 * messages from the initial request, the same numbering as the append sequence
 * that opens at `0n`. Pinned from the reference poll state machine
 * (`origin/refactor/cursor-devin-http2-oauth` `packages/ai/src/transport/http1-bridge.ts`,
 * whose append state opens with `nextSeqno: 0n`), and confirmed by the Cursor Run
 * fixtures that encode the first PollResponse as seqno 0. Unlike that reference,
 * which adopts whatever the first frame carries, every poll response — the first
 * included — is validated against this expected value.
 */
const FIRST_POLL_SEQNO = 0n;

/**
 * Bridge background poll tasks opened but not yet settled in this process.
 * Diagnostic only — production code never reads it; tests use it to prove
 * that settling a bridge before its first write() terminates the parked poll
 * task instead of leaking it on a never-settling latch.
 */
let livePollTasks = 0;

/** Diagnostic accessor for {@link livePollTasks}. */
export function pendingCursorHttp1BridgePolls(): number {
	return livePollTasks;
}

/** Per-append header deadline, independent of the caller signal. */
const APPEND_TIMEOUT_MS = 30_000;

let __appendTimeoutMs: number | undefined;

/** Test seam: override (or restore) the per-append header deadline. */
export function __setCursorHttp1AppendTimeoutMs(ms: number | undefined): void {
	__appendTimeoutMs = ms;
}

/**
 * Opens Cursor's HTTP/1.1 append/poll bridge. Not a public provider export —
 * only {@link openCursorTransport} may choose this after an authoritative
 * server directive permits the downgrade.
 */
export function openCursorHttp1Bridge(args: {
	baseUrl: string;
	requestPath: string;
	runHeaders: http2.OutgoingHttpHeaders;
	gzipRequest: boolean;
	signal?: AbortSignal;
}): CursorHttp1BridgeAttempt {
	const requestId = randomUUID();
	const abort = new AbortController();
	const signal = args.signal ? AbortSignal.any([args.signal, abort.signal]) : abort.signal;
	const queue = new FrameQueue();
	const trailerResult = Promise.withResolvers<http2.IncomingHttpHeaders>();
	void trailerResult.promise.catch(() => {});
	let terminal = false;
	let nextAppendSeqno = 0n;
	let appendTail = Promise.resolve();
	let admitting = true;
	let firstWrite = true;
	const initialAppendReady = Promise.withResolvers<void>();

	const baseHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(args.runHeaders)) {
		if (name.startsWith(":") || value === undefined) continue;
		baseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
	}

	// The bridge's poll and append fetches must honor the provider proxy the
	// same way the config probe does (`fetchServerConfigOverHttp1`): a proxied
	// deployment that cannot reach the origin directly would otherwise open the
	// bridge on the probe's downgrade permit and then fail every bridge
	// request. Resolved once per bridge from `args.baseUrl`.
	const proxy = getProxyForUrl("cursor", new URL(args.baseUrl));

	const settleSuccess = (): void => {
		if (terminal) return;
		terminal = true;
		queue.end();
		trailerResult.resolve({});
		const closedReason = new Error("Cursor HTTP/1 bridge closed");
		if (!abort.signal.aborted) abort.abort(closedReason);
		// Settling before the first write() leaves the poll task parked on the
		// initial-append latch, which no write will ever settle. Reject it with
		// the terminal reason so the task terminates instead of lingering on a
		// retained promise; the rejection flows through the task's catch into
		// settleFailure, which is a no-op now that `terminal` is set.
		if (firstWrite) initialAppendReady.reject(closedReason);
	};
	const settleFailure = (cause: unknown): void => {
		if (terminal) return;
		terminal = true;
		const error = cause instanceof Error ? cause : new Error(String(cause));
		queue.fail(error);
		trailerResult.reject(error);
		if (!abort.signal.aborted) abort.abort(error);
		// Same pre-first-write park as settleSuccess: unblock the poll task.
		if (firstWrite) initialAppendReady.reject(error);
	};

	const onAbort = (): void => {
		if (terminal) return;
		settleFailure(signal.reason instanceof Error ? signal.reason : new Error("Cursor HTTP/1 bridge aborted"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	livePollTasks++;
	void (async () => {
		// Sequence the first poll behind the initial append's settlement: the poll
		// stream exists only to return server messages for a request body that must
		// first be accepted. The gate is an explicit initial-append readiness latch,
		// NOT a bare `await appendTail`: `appendTail` starts already-resolved, so that
		// form would let the poll outrun the first append request. The first `write`
		// resolves/rejects the latch with its own settlement; a failed initial append
		// settles the attempt through the shared terminal path before the poll can
		// run — it cannot be masked. close() or an abort before the first write
		// settles the latch through that same terminal path (both settle functions
		// reject it), so the poll task terminates rather than parking forever.
		await initialAppendReady.promise;
		const headers = {
			...baseHeaders,
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
		};
		const response = await Bun.fetch(new URL(`${args.requestPath}Poll`, args.baseUrl), {
			method: "POST",
			headers,
			body: encodeConnectFrame(encodePollRequest(requestId), args.gzipRequest),
			signal,
			...(proxy ? { proxy } : {}),
		});
		if (!response.ok) throw new Error(`Cursor HTTP/1 poll failed with HTTP ${response.status}`);
		if (!response.body) throw new Error("Cursor HTTP/1 poll response had no body");

		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const reader = response.body.getReader();
		let expectedSeqno = FIRST_POLL_SEQNO;
		let sawPollEof = false;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			for (const frame of decoder.push(Buffer.from(result.value))) {
				if (frame.kind === "end") {
					if (frame.error) throw frame.error;
					// EOF is legal only once BOTH the poll eof flag and the Connect
					// end-of-stream envelope have been observed. Await the append
					// chain so a fast EOF cannot settle success before every queued
					// write() has been accepted (or failed).
					if (!sawPollEof) {
						throw new ConnectProtocolError(
							"Cursor HTTP/1 poll ended without its eof flag before the terminal envelope",
							{ kind: "envelope" },
						);
					}
					// A complete terminal envelope must also be the stream's final
					// bytes: push() emits the end frame while a truncated following
					// envelope or stray trailing bytes can still sit in its buffer.
					// finish() throws when any survive — the same completion check
					// the server-config probe applies before trusting an end-of-stream
					// walk — so a malformed poll body settles as a protocol failure,
					// never a clean turn.
					decoder.finish();
					// Close append admission ATOMICALLY before draining: write() is
					// synchronous, so flipping this flag here guarantees no further
					// write() can extend the chain while the drain's `await appendTail`
					// is pending — a late write surfaces an error to ITS caller instead
					// of being silently orphaned by the abort that follows settle.
					admitting = false;
					await appendTail;
					if (terminal) return;
					queue.push({ kind: "end", error: null });
					settleSuccess();
					return;
				}
				// The eof flag terminates the poll's data sequence. Any data
				// envelope after it is a protocol violation, not a stale
				// continuation to decode and queue — accepting one would let a
				// malformed server append payloads after it already declared the
				// end of the response. The Connect end envelope above remains the
				// only frame legal after eof, so a clean eof+end pair still settles.
				if (sawPollEof) {
					throw new ConnectProtocolError("Cursor HTTP/1 poll received data after its eof flag", {
						kind: "envelope",
					});
				}
				const pollResponse = decodePollResponse(frame.payload);
				if (pollResponse.seqno !== expectedSeqno) {
					const detail =
						pollResponse.seqno === expectedSeqno - 1n
							? `duplicate at ${pollResponse.seqno}`
							: pollResponse.seqno > expectedSeqno
								? `gap: expected ${expectedSeqno}, received ${pollResponse.seqno}`
								: `regression: expected ${expectedSeqno}, received ${pollResponse.seqno}`;
					throw new ConnectProtocolError(`Cursor HTTP/1 poll sequence violation: ${detail}`, {
						kind: "envelope",
					});
				}
				expectedSeqno = pollResponse.seqno + 1n;
				if (pollResponse.data) {
					queue.push({ kind: "data", payload: decodeCanonicalBase64PollData(pollResponse.data) });
				}
				if (pollResponse.eof) sawPollEof = true;
			}
		}
		// The shared decoder enforces that the Connect end-of-stream envelope
		// arrived before the stream ended; it throws when it did not.
		decoder.finish();
		throw new ConnectProtocolError("Cursor HTTP/1 poll stream ended without reaching a settled terminal state", {
			kind: "envelope",
		});
	})()
		.catch(settleFailure)
		.finally(() => {
			livePollTasks--;
		});

	return {
		write(frame: Buffer): void {
			if (terminal) throw new Error("Cannot write after Cursor HTTP/1 bridge close");
			if (!admitting) {
				throw new Error("Cannot write after Cursor HTTP/1 bridge append admission closed");
			}
			const payload = decodeOutboundFrame(frame);
			const seqno = nextAppendSeqno++;
			const isInitial = firstWrite;
			if (isInitial) firstWrite = false;
			appendTail = appendTail.then(async () => {
				const headers: Record<string, string> = { ...baseHeaders, "content-type": "application/proto" };
				delete headers["connect-content-encoding"];
				delete headers["connect-accept-encoding"];
				delete headers["connect-protocol-version"];
				const timeoutAbort = new AbortController();
				const onCallerAbort = (): void => {
					timeoutAbort.abort(
						signal.reason instanceof Error ? signal.reason : new Error("Cursor HTTP/1 append aborted"),
					);
				};
				if (signal.aborted) onCallerAbort();
				else signal.addEventListener("abort", onCallerAbort, { once: true });
				const timer = setTimeout(() => {
					timeoutAbort.abort(new Error("Cursor HTTP/1 append timed out"));
				}, __appendTimeoutMs ?? APPEND_TIMEOUT_MS);
				timer.unref();
				try {
					const response = await Bun.fetch(new URL("/aiserver.v1.BidiService/BidiAppend", args.baseUrl), {
						method: "POST",
						headers,
						body: encodeAppendRequest(requestId, seqno, payload),
						signal: timeoutAbort.signal,
						...(proxy ? { proxy } : {}),
					});
					if (!response.ok) throw new Error(`Cursor HTTP/1 append failed with HTTP ${response.status}`);
				} finally {
					clearTimeout(timer);
					signal.removeEventListener("abort", onCallerAbort);
				}
			});
			if (isInitial) {
				// Gate the poll behind the initial append's settlement. The latch settles
				// exactly once, so later writes leave it untouched.
				void appendTail.then(
					() => initialAppendReady.resolve(),
					(cause: unknown) => initialAppendReady.reject(cause),
				);
			}
			void appendTail.catch(settleFailure);
		},
		frames: () => queue,
		trailers: () => trailerResult.promise,
		close(): void {
			settleSuccess();
		},
	};
}

/** Fail the poll queue if retained frames outrun the consumer this far.
 * The poll reader keeps pulling while frames sit unconsumed, so retention
 * needs a byte budget, not just the response stream's own framing. Each
 * frame is charged its payload plus a fixed retained cost so object/array
 * overhead cannot hide behind tiny (or zero-length) payloads. */
const POLL_QUEUE_BYTE_LIMIT = 64 * 1024 * 1024;

/** Fixed retained cost per queued ConnectFrame, mirroring the H2 pump's
 * estimate: object and array overhead a payload-only tally would not count. */
const POLL_FRAME_RETAINED_BYTES = 64;

function frameRetainedBytes(frame: ConnectFrame): number {
	return POLL_FRAME_RETAINED_BYTES + ("payload" in frame ? frame.payload.length : 0);
}

let __pollQueueByteLimit: number | undefined;

/** Test seam: override (or restore) the poll frame-queue byte budget. */
export function __setCursorPollQueueByteLimit(bytes: number | undefined): void {
	__pollQueueByteLimit = bytes;
}

class FrameQueue implements AsyncIterable<ConnectFrame> {
	readonly #values: ConnectFrame[] = [];
	readonly #waiters: Array<() => void> = [];
	#error: Error | undefined;
	#done = false;
	#head = 0;
	#bytes = 0;

	push(frame: ConnectFrame): void {
		if (this.#done || this.#error) return;
		const size = frameRetainedBytes(frame);
		const byteLimit = __pollQueueByteLimit ?? POLL_QUEUE_BYTE_LIMIT;
		if (this.#bytes + size > byteLimit) {
			const error = new Error(`Cursor HTTP/1 poll frame queue exceeded ${byteLimit} queued bytes`);
			this.fail(error);
			throw error;
		}
		this.#values.push(frame);
		this.#bytes += size;
		this.#wake();
	}

	end(): void {
		if (this.#done || this.#error) return;
		this.#done = true;
		this.#wake();
	}

	fail(error: Error): void {
		if (this.#done || this.#error) return;
		this.#error = error;
		this.#wake();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<ConnectFrame> {
		for (;;) {
			const value = this.#dequeue();
			if (value) {
				yield value;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#done) return;
			const waiter = Promise.withResolvers<void>();
			this.#waiters.push(waiter.resolve);
			await waiter.promise;
		}
	}

	/**
	 * Head-index dequeue — O(1) per frame where Array#shift() would relocate
	 * the whole tail. The backing array is compacted when the queue drains
	 * and, so a never-fully-drained backlog cannot pin dequeued frames, again
	 * once the head index crosses a small threshold.
	 */
	#dequeue(): ConnectFrame | undefined {
		const values = this.#values;
		if (this.#head >= values.length) {
			if (this.#head > 0) {
				values.length = 0;
				this.#head = 0;
			}
			return undefined;
		}
		const value = values[this.#head++];
		this.#bytes -= frameRetainedBytes(value);
		if (this.#head === values.length) {
			values.length = 0;
			this.#head = 0;
		} else if (this.#head > 64) {
			values.copyWithin(0, this.#head);
			values.length -= this.#head;
			this.#head = 0;
		}
		return value;
	}

	#wake(): void {
		for (const resolve of this.#waiters.splice(0)) resolve();
	}
}

function decodeOutboundFrame(frame: Buffer): Uint8Array {
	if (frame.length < 5) {
		throw new ConnectProtocolError("Cursor HTTP/1 append received a truncated Connect frame", { kind: "envelope" });
	}
	const flags = frame[0];
	if ((flags & CONNECT_FLAG_RESERVED_MASK) !== 0 || (flags & CONNECT_FLAG_END_STREAM) !== 0) {
		throw new ConnectProtocolError(`Cursor HTTP/1 append received invalid envelope flags ${flags}`, {
			kind: "envelope",
		});
	}
	const length = frame.readUInt32BE(1);
	if (frame.length !== length + 5) {
		throw new ConnectProtocolError("Cursor HTTP/1 append received an invalid Connect frame length", {
			kind: "envelope",
		});
	}
	const payload = frame.subarray(5);
	if ((flags & CONNECT_FLAG_COMPRESSED) === 0) return payload;
	try {
		return Bun.gunzipSync(payload as Uint8Array<ArrayBuffer>);
	} catch (cause) {
		throw new ConnectProtocolError("Cursor HTTP/1 append could not decompress the Connect frame", {
			kind: "envelope",
			cause,
		});
	}
}

function encodeAppendRequest(requestId: string, seqno: bigint, data: Uint8Array): Uint8Array {
	return concatBytes([
		lengthDelimited(2, lengthDelimited(1, Buffer.from(requestId))),
		fieldVarint(3, seqno),
		lengthDelimited(4, data),
	]);
}

function encodePollRequest(requestId: string): Uint8Array {
	return concatBytes([lengthDelimited(1, lengthDelimited(1, Buffer.from(requestId))), fieldVarint(2, 1n)]);
}

function decodePollResponse(bytes: Uint8Array): PollResponse {
	let offset = 0;
	let seqno = 0n;
	let data = "";
	let eof = false;
	try {
		while (offset < bytes.length) {
			const tag = readVarint(bytes, offset);
			offset = tag.offset;
			const field = Number(tag.value >> 3n);
			const wireType = Number(tag.value & 7n);
			if (field === 1 && wireType === 0) {
				const value = readVarint(bytes, offset);
				seqno = value.value;
				offset = value.offset;
			} else if (field === 2 && wireType === 2) {
				const value = readBytes(bytes, offset);
				data = new TextDecoder().decode(value.value);
				offset = value.offset;
			} else if (field === 3 && wireType === 0) {
				const value = readVarint(bytes, offset);
				eof = value.value !== 0n;
				offset = value.offset;
			} else {
				offset = skipField(bytes, offset, wireType);
			}
		}
	} catch (cause) {
		throw new ConnectProtocolError("Cursor HTTP/1 poll carried malformed protobuf", { kind: "envelope", cause });
	}
	return { seqno, data, eof };
}

function decodeCanonicalBase64PollData(value: string): Buffer {
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new ConnectProtocolError("Cursor HTTP/1 poll carried malformed base64 data", { kind: "envelope" });
	}
	return decoded;
}

function fieldVarint(field: number, value: bigint): Uint8Array {
	return concatBytes([encodeVarint(BigInt(field << 3)), encodeVarint(value)]);
}

function lengthDelimited(field: number, value: Uint8Array): Uint8Array {
	return concatBytes([encodeVarint(BigInt((field << 3) | 2)), encodeVarint(BigInt(value.length)), value]);
}

function encodeVarint(value: bigint): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining !== 0n);
	return Uint8Array.from(bytes);
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; offset: number } {
	let value = 0n;
	let shift = 0n;
	let offset = start;
	while (offset < bytes.length && shift <= 63n) {
		const byte = bytes[offset++];
		value |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value, offset };
		shift += 7n;
	}
	throw new Error("invalid varint");
}

function readBytes(bytes: Uint8Array, start: number): { value: Uint8Array; offset: number } {
	const length = readVarint(bytes, start);
	const end = length.offset + Number(length.value);
	if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error("invalid length-delimited field");
	return { value: bytes.subarray(length.offset, end), offset: end };
}

function skipField(bytes: Uint8Array, start: number, wireType: number): number {
	switch (wireType) {
		case 0:
			return readVarint(bytes, start).offset;
		case 1:
			if (start + 8 > bytes.length) throw new Error("truncated fixed64");
			return start + 8;
		case 2:
			return readBytes(bytes, start).offset;
		case 5:
			if (start + 4 > bytes.length) throw new Error("truncated fixed32");
			return start + 4;
		default:
			throw new Error(`unsupported wire type ${wireType}`);
	}
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
