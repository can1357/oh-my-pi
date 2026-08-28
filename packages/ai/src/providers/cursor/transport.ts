import type * as http2 from "node:http2";
import * as AIError from "../../error";
import { type ConnectFrame, ConnectFrameDecoder } from "./connect-frame";
import * as h2Pool from "./h2-pool";
import { sanitizeCursorCallerHeaders } from "./headers";
import { openCursorHttp1Bridge } from "./http1-bridge";
import * as serverConfig from "./server-config";

export interface CursorTransportAttempt {
	write(frame: Buffer): void;
	frames(): AsyncIterable<ConnectFrame>;
	trailers(): Promise<http2.IncomingHttpHeaders>;
	close(): void;
	/**
	 * Response headers once the peer sends them; resolves `{}` when the stream
	 * ends without any. Optional: the HTTP/1.1 bridge does not surface them.
	 * The request-debug response log consumes this to preserve the pre-pool
	 * `request.on("response")` behavior without re-owning the stream.
	 */
	responseHeaders?(): Promise<http2.IncomingHttpHeaders>;
}

/**
 * Minimal outbound frame sink the provider hands to the exec/kv/interaction
 * helpers below the transport region (`handleServerMessage`,
 * `sendExecClientMessage`, `handleInteractionQuery`, ...). The single heartbeat
 * timer is rearmed inside the sink so every client frame — heartbeat, tool
 * result, interaction reply — satisfies the "server sees a client frame within
 * 5 s" invariant without a second timer. Implemented by the transport attempt
 * owner in cursor.ts; the helpers only ever call `write`.
 */
export interface CursorFrameSink {
	write(frame: Buffer): unknown;
}

/**
 * Maps an opaque HTTP/2 negotiation failure into an actionable error.
 *
 * bun only opens an HTTP/2 session when TLS-ALPN negotiates `h2`. Behind a
 * TLS-intercepting proxy that strips ALPN (e.g. Zscaler), the handshake yields
 * no `h2` protocol and bun throws `ERR_HTTP2_ERROR: h2 is not supported`. The
 * Cursor run RPC is HTTP/2-only (the ALB rejects HTTP/1.1 with 464), so there
 * is no h1 fallback the way model discovery has one — the run simply cannot
 * proceed. Replace the opaque message with one that names the cause and points
 * at the `providers.cursor.baseUrl` workaround.
 *
 * Non-ALPN errors pass through untouched.
 */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new AIError.ProviderResponseError(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
				"h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy (e.g. Zscaler). " +
				"Front the provider with a local HTTP/2 bridge and set providers.cursor.baseUrl to it.",
			{ provider: "cursor", kind: "runtime", cause: error },
		);
	}
	return error;
}

/**
 * Opens the Cursor Run transport. HTTP/2 is preferred; the HTTP/1.1 bridge is
 * reachable only when acquisition reports a typed ALPN failure AND
 * GetServerConfig authoritatively disables bidi (or all HTTP/2). The fallback
 * decision is made entirely before this function returns — once an attempt is
 * handed to the caller, no later error can reopen the other protocol.
 */
export async function openCursorTransport(args: {
	baseUrl: string;
	apiKey: string;
	requestPath: string;
	runHeaders: http2.OutgoingHttpHeaders;
	gzipRequest: boolean;
	signal?: AbortSignal;
	provider: string;
}): Promise<CursorTransportAttempt> {
	const headers = args.runHeaders;
	const acquisition = await h2Pool.acquireCursorH2({
		baseUrl: args.baseUrl,
		requestPath: args.requestPath,
		headers,
		provider: args.provider,
		signal: args.signal,
	});
	if (acquisition.ok) return wrapH2Lease(acquisition.lease);

	if (acquisition.unavailable.reason === "alpn") {
		// fetchCursorBidiAvailability probes GetServerConfig over HTTP/1 when this
		// origin cannot negotiate h2, so ALPN failure can still discover
		// bidi-disabled / all-disabled rather than collapsing to "unspecified".
		// The probe must carry the caller headers embedded in the Run header set:
		// a gateway that required one on Run rejects GetServerConfig otherwise,
		// collapsing availability to "unspecified" and blocking the bridge even
		// when the backend authoritatively disables bidi. Flattening plus
		// sanitizeCursorCallerHeaders strips every fixed Run field (all reserved
		// names), leaving exactly the caller-supplied extras.
		const availability = await serverConfig.fetchCursorBidiAvailability({
			apiKey: args.apiKey,
			baseUrl: args.baseUrl,
			callerHeaders: sanitizeCursorCallerHeaders(flattenRunCallerHeaders(headers)),
			signal: args.signal,
		});
		if (availability === "bidi-disabled" || availability === "all-disabled") {
			return openCursorHttp1Bridge({
				baseUrl: args.baseUrl,
				requestPath: args.requestPath,
				runHeaders: headers,
				gzipRequest: args.gzipRequest,
				signal: args.signal,
			});
		}
	}

	throw mapH2TransportError(acquisition.unavailable.cause, args.baseUrl);
}

/**
 * Flattens the built Run headers (`http2.OutgoingHttpHeaders` values may be
 * arrays, numbers, or undefined) into the plain record the sanitizing header
 * helpers accept. Pseudo-headers are dropped here; every remaining field is
 * left for `sanitizeCursorCallerHeaders` to filter.
 */
function flattenRunCallerHeaders(headers: http2.OutgoingHttpHeaders): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(":") || value === undefined) continue;
		flat[name] = Array.isArray(value) ? value.join(", ") : String(value);
	}
	return flat;
}

function wrapH2Lease(lease: h2Pool.CursorH2Lease): CursorTransportAttempt {
	const { request, release } = lease;
	const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
	const trailersResult = Promise.withResolvers<http2.IncomingHttpHeaders>();
	void trailersResult.promise.catch(() => {});
	const responseResult = Promise.withResolvers<http2.IncomingHttpHeaders>();
	void responseResult.promise.catch(() => {});
	let trailersSettled = false;
	let responseSettled = false;
	let closed = false;

	const settleTrailers = (headers: http2.IncomingHttpHeaders): void => {
		if (trailersSettled) return;
		trailersSettled = true;
		trailersResult.resolve(headers);
	};
	const failTrailers = (cause: unknown): void => {
		if (trailersSettled) return;
		trailersSettled = true;
		trailersResult.reject(cause instanceof Error ? cause : new Error(String(cause)));
	};
	const settleResponse = (headers: http2.IncomingHttpHeaders): void => {
		if (responseSettled) return;
		responseSettled = true;
		responseResult.resolve(headers);
	};

	request.on("response", headers => settleResponse(headers));
	request.on("trailers", headers => settleTrailers(headers));
	request.on("end", () => {
		settleResponse({});
		settleTrailers({});
	});
	request.on("error", error => {
		settleResponse({});
		failTrailers(error);
	});
	request.on("close", () => {
		settleResponse({});
		settleTrailers({});
	});
	// Abort can race issueLease: terminal events fired before the listeners
	// above existed never reach them, so reconcile here or the promises hang.
	if (request.closed || request.destroyed) {
		settleResponse({});
		settleTrailers({});
	}

	const pump = startH2FramePump(request, decoder);

	return {
		write(frame: Buffer): void {
			request.write(frame);
		},
		frames(): AsyncIterable<ConnectFrame> {
			return iterateH2FramePump(pump);
		},
		trailers: () => trailersResult.promise,
		responseHeaders: () => responseResult.promise,
		close(): void {
			if (closed) return;
			closed = true;
			pump.stop();
			release();
		},
	};
}

interface H2FramePump {
	pending: ConnectFrame[];
	head: number;
	/** Estimated retained bytes currently queued and unconsumed. */
	queuedBytes: number;
	waiters: Array<() => void>;
	done: boolean;
	failure: Error | undefined;
	wake(): void;
	stop(): void;
}

/** Fail the pump if decoded frames outrun the consumer by this retained-byte estimate. */
const H2_FRAME_QUEUE_BYTES = 64 * 1024 * 1024;
const H2_FRAME_RETAINED_BYTES = 64;

let __frameQueueBytes: number | undefined;

/** Test seam: override (or restore) the H2 frame-queue byte budget. */
export function __setCursorH2FrameQueueBytes(bytes: number | undefined): void {
	__frameQueueBytes = bytes;
}

function frameRetainedBytes(frame: ConnectFrame): number {
	return H2_FRAME_RETAINED_BYTES + ("payload" in frame ? frame.payload.length : 0);
}

function framesRetainedBytes(frames: readonly ConnectFrame[]): number {
	let bytes = 0;
	for (const frame of frames) bytes += frameRetainedBytes(frame);
	return bytes;
}

function startH2FramePump(request: http2.ClientHttp2Stream, decoder: ConnectFrameDecoder): H2FramePump {
	const pump: H2FramePump = {
		pending: [],
		head: 0,
		queuedBytes: 0,
		waiters: [],
		done: false,
		failure: undefined,
		wake(): void {
			for (const resolve of pump.waiters.splice(0)) resolve();
		},
		stop(): void {
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", fail);
			pump.pending.length = 0;
			pump.head = 0;
			pump.queuedBytes = 0;
		},
	};

	const fail = (cause: unknown): void => {
		if (pump.done || pump.failure) return;
		pump.failure = cause instanceof Error ? cause : new Error(String(cause));
		pump.wake();
	};
	const onData = (chunk: Buffer | string): void => {
		if (pump.done || pump.failure) return;
		try {
			const frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			if (frames.length === 0) return;
			const incomingBytes = framesRetainedBytes(frames);
			const queueByteLimit = __frameQueueBytes ?? H2_FRAME_QUEUE_BYTES;
			if (pump.queuedBytes + incomingBytes > queueByteLimit) {
				fail(new Error(`Cursor HTTP/2 frame queue exceeded ${queueByteLimit} queued bytes`));
				return;
			}
			pump.pending.push(...frames);
			pump.queuedBytes += incomingBytes;
			pump.wake();
		} catch (cause) {
			fail(cause);
		}
	};
	const onEnd = (): void => {
		if (pump.done || pump.failure) return;
		try {
			decoder.finish();
			pump.done = true;
			pump.wake();
		} catch (cause) {
			fail(cause);
		}
	};

	request.on("data", onData);
	request.on("end", onEnd);
	request.on("error", fail);
	request.on("close", () => {
		if (!pump.done && !pump.failure) onEnd();
	});
	if (request.closed || request.destroyed) onEnd();
	return pump;
}

async function* iterateH2FramePump(pump: H2FramePump): AsyncGenerator<ConnectFrame> {
	try {
		for (;;) {
			const frame = pump.head < pump.pending.length ? pump.pending[pump.head++] : undefined;
			if (pump.head === pump.pending.length) {
				pump.pending.length = 0;
				pump.head = 0;
			} else if (pump.head > 64) {
				pump.pending.copyWithin(0, pump.head);
				pump.pending.length -= pump.head;
				pump.head = 0;
			}
			if (frame) {
				pump.queuedBytes -= frameRetainedBytes(frame);
				yield frame;
				continue;
			}
			if (pump.failure) throw pump.failure;
			if (pump.done) return;
			const waiter = Promise.withResolvers<void>();
			pump.waiters.push(waiter.resolve);
			await waiter.promise;
		}
	} finally {
		pump.stop();
	}
}
