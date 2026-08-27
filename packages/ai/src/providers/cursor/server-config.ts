import {
	GetServerConfigRequestSchema,
	GetServerConfigResponseSchema,
	Http2Config,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { getProxyForUrl } from "../../utils/proxy";
import { CONNECT_FLAG_COMPRESSED, CONNECT_FLAG_END_STREAM, ConnectFrameDecoder } from "./connect-frame";
import { acquireCursorH2, type CursorH2Lease } from "./h2-pool";
import { buildCursorUnaryHeaders } from "./headers";

/**
 * Account-scoped transport policy for the Cursor provider, fetched from the
 * server's `GetServerConfig` unary RPC. This is the ONLY input that may
 * authorize the HTTP/1.1 fallback bridge: a client may downgrade to HTTP/1.1
 * only when the server explicitly reports `FORCE_BIDI_DISABLED` or
 * `FORCE_ALL_DISABLED`. Everything else — a missing/unknown directive, a
 * failed fetch, a timeout, an abort, a non-2xx status, a frame-protocol error,
 * or a backend that does not expose this RPC — maps to `"unspecified"`, which
 * keeps HTTP/2. That is the invariant that stops a network hiccup from ever
 * downgrading a healthy account.
 */

export type CursorBidiAvailability = "unspecified" | "bidi-disabled" | "all-disabled";

/** Unary RPC path, matching the Cursor `AgentService.GetServerConfig` endpoint. */
const GET_SERVER_CONFIG_PATH = "/agent.v1.AgentService/GetServerConfig";

/** Wall-clock budget for one config fetch. Exceeding it fails open to `"unspecified"`. */
const CURSOR_SERVER_CONFIG_TIMEOUT_MS = 5_000;

/** Per-key TTL (apiKey + baseUrl + caller headers); two calls within it make one wire request. */
const CURSOR_SERVER_CONFIG_TTL_MS = 30_000;

/** Maximum retained cache entries (LRU bound). */
const CURSOR_SERVER_CONFIG_CACHE_CAP = 8;

/** Cumulative response cap; a config RPC is a few hundred bytes. */
const MAX_SERVER_CONFIG_RESPONSE_BYTES = 1_048_576; // 1 MiB

/**
 * Per-key result cache (apiKey + baseUrl + caller headers). An `"unspecified"`
 * result is cached too — it is a valid answer, and the transport caller hits
 * this fetch on every ALPN failure, so a healthy account must not re-query on
 * every retry. The policy is per-ENDPOINT (the server's FORCE_* directives are
 * scoped to the backend, and `baseUrl` is independently configurable), so the
 * key composes both — same apiKey against endpoint A then B within the TTL
 * must not cross-contaminate. Caller headers are part of the key because one
 * endpoint can serve several routes distinguished only by those headers. The
 * map is bounded at `CURSOR_SERVER_CONFIG_CACHE_CAP` entries (LRU) so a
 * long-lived process with rotating keys does not hold them forever; expired
 * entries are pruned opportunistically on every write.
 */
const cache = new Map<string, { value: CursorBidiAvailability; expiresAt: number }>();
/**
 * Per-key in-flight fetch promise. Concurrent callers that miss the cache
 * coalesce onto the same fetch so only one wire request is made and every
 * caller receives the same published value. The shared operation carries NO
 * caller `AbortSignal`: each waiter races its own signal against the shared
 * promise, so a caller that cancels abandons only its own wait — it can
 * neither cancel the fetch the others await nor have its cancellation
 * published and cached as everyone's answer. A rejected entry is cleared so
 * later callers retry instead of awaiting a dead promise.
 */
const inflight = new Map<string, Promise<CursorBidiAvailability>>();
let serverConfigGeneration = 0;

/** Removes entries whose TTL has elapsed. Called on every cache write. */
function pruneExpiredCache(): void {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key);
	}
}

/** Evicts least-recently-used entries until the cap is respected. */
function evictOverflowCache(): void {
	while (cache.size > CURSOR_SERVER_CONFIG_CACHE_CAP) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}
export function resetCursorServerConfigCache(): void {
	serverConfigGeneration++;
	cache.clear();
	inflight.clear();
}

/** Test seam: current entry count, for LRU/pruning assertions. */
export function __cursorServerConfigCacheSize(): number {
	return cache.size;
}

/**
 * Returns the account's bidi availability, or `"unspecified"` when it cannot
 * be determined for any reason (fail open). The result is cached per
 * `apiKey` + `baseUrl` + caller headers for the TTL; the cache is LRU-bounded
 * and pruned on every write.
 */
export async function fetchCursorBidiAvailability(args: {
	apiKey: string;
	baseUrl: string;
	/**
	 * Sanitized caller headers (see `sanitizeCursorCallerHeaders`) forwarded to
	 * both config transports beneath the fixed unary set — a gateway may require
	 * a caller-supplied routing or auth field on `GetServerConfig` exactly as it
	 * does on Run. Part of the cache and in-flight key: one endpoint can serve
	 * several routes distinguished only by these headers, so a directive (or a
	 * coalesced wire request) must never cross header sets.
	 */
	callerHeaders?: Record<string, string>;
	/**
	 * Bounds only THIS caller's wait. It never reaches the shared wire fetch,
	 * so one coalesced caller cancelling cannot cancel or fail-open the answer
	 * the others still await.
	 */
	signal?: AbortSignal;
}): Promise<CursorBidiAvailability> {
	const key = serverConfigCacheKey(args.apiKey, args.baseUrl, args.callerHeaders);
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		// LRU: move to most-recently-used end.
		cache.delete(key);
		cache.set(key, cached);
		return cached.value;
	}
	// Coalesce concurrent misses onto one fetch so N callers make one wire
	// request and all receive the same published value.
	const existing = inflight.get(key);
	const shared = existing ?? beginSharedServerConfigFetch(key, args.apiKey, args.baseUrl, args.callerHeaders);
	return awaitSharedServerConfig(shared, args.signal);
}

/**
 * Cache and in-flight key: `apiKey` + `baseUrl` plus a canonical serialization
 * of the sanitized caller headers. A gateway can answer `GetServerConfig`
 * per caller header, so two callers that differ only in headers must not
 * share a cached or coalesced result. Header names are sorted so insertion
 * order cannot split one header set into two keys, and `JSON.stringify`
 * escaping keeps the encoding unambiguous. Undefined or empty headers keep
 * the bare `apiKey|baseUrl` shape so the no-header path keeps one key.
 */
function serverConfigCacheKey(
	apiKey: string,
	baseUrl: string,
	callerHeaders: Record<string, string> | undefined,
): string {
	const names = Object.keys(callerHeaders ?? {}).sort();
	if (names.length === 0) return `${apiKey}|${baseUrl}`;
	const entries = names.map(name => [name, callerHeaders?.[name] ?? ""]);
	return `${apiKey}|${baseUrl}|${JSON.stringify(entries)}`;
}

/**
 * Starts the shared wire fetch for `key` and registers it in `inflight`. The
 * returned promise publishes the result to the cache when the fetch settles —
 * the publication belongs to the shared operation, not to whichever caller
 * happens to have created it — and clears its own in-flight entry so later
 * callers retry rather than awaiting a dead promise.
 */
function beginSharedServerConfigFetch(
	key: string,
	apiKey: string,
	baseUrl: string,
	callerHeaders: Record<string, string> | undefined,
): Promise<CursorBidiAvailability> {
	const generation = serverConfigGeneration;
	const shared = fetchServerConfig(apiKey, baseUrl, callerHeaders).then(value => {
		if (generation !== serverConfigGeneration) return value;
		pruneExpiredCache();
		cache.set(key, { value, expiresAt: Date.now() + CURSOR_SERVER_CONFIG_TTL_MS });
		evictOverflowCache();
		return value;
	});
	inflight.set(key, shared);
	void shared
		.catch(() => undefined)
		.finally(() => {
			if (inflight.get(key) === shared) inflight.delete(key);
		});
	return shared;
}

/**
 * Waits for the shared config fetch, abandoning only this caller's wait when
 * its own `AbortSignal` fires. An abandoned wait fails open to
 * `"unspecified"` without aborting the shared fetch: a caller that cancelled
 * mid-flight must not decide the answer the other waiters receive, nor poison
 * the cache the shared result will publish.
 */
async function awaitSharedServerConfig(
	shared: Promise<CursorBidiAvailability>,
	signal: AbortSignal | undefined,
): Promise<CursorBidiAvailability> {
	if (!signal) return shared;
	if (signal.aborted) return "unspecified";
	const abandoned = Promise.withResolvers<never>();
	const onAbort = (): void => {
		abandoned.reject(new Error("caller abandoned the shared server-config wait"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([shared, abandoned.promise]);
	} catch {
		// This caller abandoned its wait (or the shared fetch rejected, which
		// `fetchServerConfig` never does in practice): fail open.
		return "unspecified";
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Fixed unary header set with the sanitized caller headers spread beneath it —
 * the same merge shape as `buildCursorRunHeaders`. A gateway that requires a
 * caller-supplied routing or auth field on Run requires it here too; without
 * the field the probe is rejected and availability collapses to
 * `"unspecified"`, blocking the HTTP/1 bridge.
 */
function cursorUnaryHeaders(apiKey: string, callerHeaders: Record<string, string> | undefined): Record<string, string> {
	return { ...(callerHeaders ?? {}), ...buildCursorUnaryHeaders({ apiKey }) };
}

async function fetchServerConfig(
	apiKey: string,
	baseUrl: string,
	callerHeaders: Record<string, string> | undefined,
): Promise<CursorBidiAvailability> {
	// The shared operation's own wall-clock budget. Caller signals are
	// deliberately not composed in: this fetch is shared by every coalesced
	// waiter, so one caller's cancellation must not cancel the answer the
	// others still await (the same rule the h2 pool applies to its shared
	// session establishment).
	const timeout = AbortSignal.timeout(CURSOR_SERVER_CONFIG_TIMEOUT_MS);
	try {
		const acquisition = await acquireCursorH2({
			baseUrl,
			requestPath: GET_SERVER_CONFIG_PATH,
			headers: cursorUnaryHeaders(apiKey, callerHeaders),
			provider: "cursor",
			signal: timeout,
		});
		if (!acquisition.ok) {
			// The same origin that failed Run ALPN will fail this unary over h2 too.
			// Probe GetServerConfig with a unary HTTP/1 fetch so FORCE_BIDI_DISABLED /
			// FORCE_ALL_DISABLED remain discoverable; do not treat ALPN failure itself
			// as a downgrade permit.
			if (acquisition.unavailable.reason === "alpn") {
				return await fetchServerConfigOverHttp1(apiKey, baseUrl, callerHeaders, timeout);
			}
			return "unspecified";
		}
		return await readServerConfigResponse(acquisition.lease);
	} catch {
		// Acquisition rejection, timeout, or abort: fail open.
		return "unspecified";
	}
}

async function fetchServerConfigOverHttp1(
	apiKey: string,
	baseUrl: string,
	callerHeaders: Record<string, string> | undefined,
	signal?: AbortSignal,
): Promise<CursorBidiAvailability> {
	try {
		const url = new URL(GET_SERVER_CONFIG_PATH, baseUrl);
		// Resolve the provider proxy the same way the h2 acquisition does: the
		// fallback probe must not silently bypass `PI_PROXY_CURSOR` /
		// `PI_PROXY`, or proxied deployments probe direct, observe
		// `"unspecified"`, and lose the HTTP/1 bridge exactly where an
		// ALPN-stripping proxy forces the downgrade.
		const proxy = getProxyForUrl("cursor", url);
		const response = await Bun.fetch(url, {
			method: "POST",
			headers: cursorUnaryHeaders(apiKey, callerHeaders),
			// Unary Connect over `application/proto` carries the raw serialized
			// message, not a streaming envelope (the catalog GetUsableModels
			// transport is the in-repo precedent).
			body: toBinary(GetServerConfigRequestSchema, create(GetServerConfigRequestSchema, {})),
			signal,
			...(proxy ? { proxy } : {}),
		});
		if (!response.ok) return "unspecified";
		// Read the body incrementally and cancel once the cumulative cap is
		// exceeded, matching the H2 path's streaming behavior instead of
		// buffering the entire body before checking the limit.
		const reader = response.body?.getReader();
		if (!reader) return "unspecified";
		const bodyChunks: Uint8Array[] = [];
		let cumulativeBytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			cumulativeBytes += value.byteLength;
			if (cumulativeBytes > MAX_SERVER_CONFIG_RESPONSE_BYTES) {
				await reader.cancel();
				return "unspecified";
			}
			bodyChunks.push(value);
		}
		return decodeUnaryServerConfigBody(concatBytes(bodyChunks));
	} catch {
		return "unspecified";
	}
}

/**
 * Decodes one complete `GetServerConfig` response body. The real Cursor
 * backend envelopes unary responses (`[flags][len][message]`, optionally an
 * end-of-stream envelope), while a plain Connect unary peer sends the raw
 * protobuf message — so the decoder is envelope-first with a raw fallback,
 * mirroring `decodeGetUsableModelsResponse` in catalog discovery. Dispatch on
 * the first byte is unambiguous: a legal envelope flag byte (`0x00`–`0x03`)
 * is an illegal protobuf tag (field number 0), and every legal protobuf tag
 * (`>= 0x08`) sets reserved envelope flag bits. Once the body claims envelope
 * shape, the WHOLE body must be well-formed envelopes — a truncated trailing
 * frame or a malformed envelope fails open and is never reinterpreted as a
 * raw message.
 */
function decodeUnaryServerConfigBody(bytes: Uint8Array): CursorBidiAvailability {
	if (bytes.byteLength === 0) return "unspecified";
	const first = bytes[0];
	if (first === undefined || first > (CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM)) {
		return decodeServerConfig([bytes]);
	}
	const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
	const chunks: Uint8Array[] = [];
	try {
		for (const frame of decoder.push(Buffer.from(bytes))) {
			if (frame.kind === "data") {
				chunks.push(frame.payload);
			} else if (frame.error) {
				// End-of-stream carrying a Connect error (e.g. unimplemented):
				// the backend may not expose this RPC on this generation. Fail open.
				return "unspecified";
			}
		}
		if (decoder.sawEndStream) {
			// Throws on trailing bytes after the end-of-stream envelope.
			decoder.finish();
		} else {
			// Unary responses may omit the end-of-stream envelope, but bytes
			// that never form a complete envelope must not be authoritative.
			rejectTrailingEnvelopeBytes(bytes);
		}
	} catch {
		return "unspecified";
	}
	if (chunks.length !== 1) return "unspecified";
	return decodeServerConfig(chunks);
}

/** Throws when `bytes` does not end exactly on an envelope boundary. */
function rejectTrailingEnvelopeBytes(bytes: Uint8Array): void {
	let offset = 0;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	while (offset + 5 <= bytes.byteLength) {
		const msgLen = view.getUint32(offset + 1);
		if (offset + 5 + msgLen > bytes.byteLength) break;
		offset += 5 + msgLen;
	}
	if (offset < bytes.byteLength) {
		throw new Error("unary server-config body ended mid-envelope");
	}
}

/**
 * Drives one `GetServerConfig` unary response over the leased stream. The
 * request is the raw serialized `GetServerConfigRequest` — Connect unary
 * sends the message itself, not a streaming envelope — and the completed
 * response body is decoded by the shared unary decoder (envelope-shaped or
 * raw). Every failure path — non-2xx status, a truncated or unparseable
 * body, an aborted/destroyed stream, or a close without a clean end — yields
 * `"unspecified"`. Exported as a test seam so a suite can hand the reader a
 * lease whose stream was already closed when the reader began — the
 * deterministic way to exercise the closed-at-entry branch.
 */
export async function readServerConfigResponse(lease: CursorH2Lease): Promise<CursorBidiAvailability> {
	const { request, release } = lease;
	// An abort that fired during acquisition (before this function ran) already
	// destroyed the stream through the lease's own abort listener; its terminal
	// events were not observable here, so fail open immediately.
	if (request.closed || request.destroyed) {
		// The stream died between acquisition and handler installation. The
		// lease is still outstanding (no abort to auto-release it) — release it
		// here or the pool's draining entry leaks forever. `release` is
		// idempotent (h2-pool's `releaseLease`), so a concurrent abort that
		// already released is a no-op.
		lease.release();
		return "unspecified";
	}
	const chunks: Uint8Array[] = [];
	let cumulativeBytes = 0;
	const { promise, resolve } = Promise.withResolvers<CursorBidiAvailability>();
	let settled = false;
	let ended = false;
	const finish = (value: CursorBidiAvailability): void => {
		if (settled) return;
		settled = true;
		release();
		resolve(value);
	};

	request.on("response", headers => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status > 299) finish("unspecified");
	});
	request.on("data", chunk => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		cumulativeBytes += bytes.byteLength;
		if (cumulativeBytes > MAX_SERVER_CONFIG_RESPONSE_BYTES) {
			// Cumulative response cap: a config RPC is a few hundred bytes;
			// > 1 MiB of body is a misbehaving or hostile backend. Stop
			// consuming (destroy the stream) and fail open through the same
			// `finish` path as every other failure mode.
			request.destroy();
			finish("unspecified");
			return;
		}
		chunks.push(bytes);
	});
	request.on("end", () => {
		// Clean end of the response body: decode whatever arrived.
		ended = true;
		finish(decodeUnaryServerConfigBody(concatBytes(chunks)));
	});
	request.on("error", () => finish("unspecified"));
	request.on("close", () => {
		// Always fires once the stream is done. A clean end already settled
		// through the "end" handler; reaching close without it means the
		// stream was destroyed or aborted mid-body — fail open rather than
		// decoding a partial answer.
		if (!ended) finish("unspecified");
	});

	try {
		const body = toBinary(GetServerConfigRequestSchema, create(GetServerConfigRequestSchema, {}));
		if (body.length > 0) request.end(Buffer.from(body));
		else request.end();
	} catch {
		// A synchronous write/end failure (the stream closed between the
		// handler-install above and the write) would otherwise unwind past
		// `return promise` and skip `finish` — the same lease-leak shape as the
		// closed-at-entry branch. Settle through `finish` so the lease is
		// released and the failure fails open.
		finish("unspecified");
	}

	return promise;
}

function decodeServerConfig(chunks: Uint8Array[]): CursorBidiAvailability {
	try {
		const message = fromBinary(GetServerConfigResponseSchema, concatBytes(chunks));
		return mapHttp2Config(message.http2Config);
	} catch {
		return "unspecified";
	}
}

function mapHttp2Config(value: number | undefined): CursorBidiAvailability {
	switch (value) {
		case Http2Config.FORCE_BIDI_DISABLED:
			return "bidi-disabled";
		case Http2Config.FORCE_ALL_DISABLED:
			return "all-disabled";
		default:
			return "unspecified";
	}
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
