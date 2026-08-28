import { randomUUID } from "node:crypto";
import type * as http2 from "node:http2";
import {
	buildCursorUnaryHeaders as buildCatalogCursorUnaryHeaders,
	CURSOR_CLIENT_VERSION,
} from "@oh-my-pi/pi-catalog/discovery/cursor-headers";

export { CURSOR_CLIENT_VERSION };
export const CURSOR_API_URL = "https://api2.cursor.sh";

/**
 * HTTP/1 connection-specific headers that HTTP/2 forbids. Node's `http2.request()`
 * throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS` on these rather than dropping
 * them, so a caller sending one would kill the request outright.
 */
const HTTP2_FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"http2-settings",
]);

/**
 * Header names the Cursor request sets for itself. A caller copy in ANY casing
 * has to go: the spread below adds the fixed lower-case name regardless, and two
 * spellings of one field are a duplicate rather than an override.
 *
 * `connect-content-encoding` / `connect-accept-encoding` are reserved even on
 * requests that do not set them so a caller can never forge the compression
 * negotiation — the transport owns it.
 */
const CURSOR_RESERVED_HEADERS = new Set([
	"content-type",
	"connect-protocol-version",
	"connect-content-encoding",
	"connect-accept-encoding",
	"te",
	"authorization",
	"x-ghost-mode",
	"x-cursor-client-version",
	"x-cursor-client-type",
	"x-request-id",
	// Transport-owned even though this request never sets it: node's http2 client
	// suppresses the `:authority` it derives from the URL when a plain `host`
	// header is present, so a caller value here silently retargets the request at
	// a different virtual host.
	"host",
	// The Connect body is streamed after the headers (initial frame, heartbeats,
	// tool responses), so no caller-supplied length can describe it and an HTTP/2
	// peer resets the stream once the body diverges.
	"content-length",
]);

/**
 * Reduce caller-supplied headers to what this HTTP/2 request can legally carry.
 *
 * Everything is lower-cased, because HTTP/2 field names are lower-case and node
 * compares them that way. A caller `Authorization` next to the fixed
 * `authorization` does not lose to it, it DUPLICATES it, and node throws
 * `ERR_HTTP2_HEADER_SINGLE_VALUE` before the request goes out. Same for a `TE`
 * that is not `trailers`. Node throws on all three classes here rather than
 * ignoring them, so a miss turns a harmless header into a dead request.
 */
export function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		const field = name.toLowerCase();
		if (field.startsWith(":")) continue;
		if (HTTP2_FORBIDDEN_HEADERS.has(field)) continue;
		if (CURSOR_RESERVED_HEADERS.has(field)) continue;
		sanitized[field] = value;
	}
	return sanitized;
}

/**
 * Build the HTTP/2 request headers for a streaming Cursor Run RPC.
 *
 * Caller headers are additive, and are spread FIRST so the protocol framing,
 * auth, and request id below always win. Two classes are stripped by
 * `sanitizeCursorCallerHeaders` because node's http2 client THROWS on them
 * rather than ignoring them: pseudo-headers, which belong to the transport, and
 * the HTTP/1 connection-specific headers HTTP/2 forbids outright. `te` needs no
 * filtering — HTTP/2 allows it only as `trailers`, which is exactly what the
 * fixed set re-applies over anything a caller sent.
 *
 * Compression is negotiated unconditionally on the accept side and on the
 * content side whenever `gzipRequest`. The transport is the sole owner of the
 * connect-*-encoding fields, so no caller value can reach them.
 */
export function buildCursorRunHeaders(args: {
	apiKey: string;
	requestPath: string;
	callerHeaders?: Record<string, string>;
	gzipRequest: boolean;
}): http2.OutgoingHttpHeaders {
	const callerHeaders = sanitizeCursorCallerHeaders(args.callerHeaders);
	const headers: http2.OutgoingHttpHeaders = {
		...callerHeaders,
		":method": "POST",
		":path": args.requestPath,
		"content-type": "application/connect+proto",
		"connect-protocol-version": "1",
		te: "trailers",
		authorization: `Bearer ${args.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
		"connect-accept-encoding": "gzip",
	};
	if (args.gzipRequest) {
		headers["connect-content-encoding"] = "gzip";
	}
	headers["x-request-id"] = randomUUID();
	return headers;
}

/**
 * Build the headers for the unary `GetUsableModels` RPC used by catalog model
 * discovery. Delegates to the catalog helper so discovery and Run advertise
 * the same client version.
 */
export function buildCursorUnaryHeaders(args: { apiKey: string; clientVersion?: string }): Record<string, string> {
	return buildCatalogCursorUnaryHeaders(args.apiKey, args.clientVersion);
}
