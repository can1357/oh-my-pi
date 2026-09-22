import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import * as stream from "node:stream";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

/** `host/path` for logging; query strings can carry keys. */
function logTarget(input: string | URL | Request): string {
	try {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		return `${url.host}${url.pathname}`;
	} catch {
		return "<unparseable>";
	}
}

/** Proxy host of a request init, or `"none"` when the request goes out direct. */
function initProxy(init: RequestInit | undefined): string {
	if (!init || !("proxy" in init) || typeof init.proxy !== "string") return "none";
	try {
		return new URL(init.proxy).host;
	} catch {
		return "<unparseable>";
	}
}

type CoworkTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
	serverName?: string;
	ciphers?: string;
};

type CoworkRequestInit = RequestInit & {
	proxy?: string;
	tls?: CoworkTlsOptions;
};

type RequestBody = string | Uint8Array;

/**
 * Per-host socket ceiling for the shared keepalive pool. `https.Agent` defaults
 * to `Infinity`, and every request on this transport parks its socket for the
 * whole streaming response — so one process fanning out subagents
 * (`task.maxConcurrency` is 32 by default and offers 64 at the top of its
 * presets) plus its main loop, speculation, compaction and advisor traffic
 * opens a socket per concurrent turn against one host, with nothing bounding
 * the total. 128 is twice the widest preset fan-out, so a fully fanned-out
 * session still dials everything at once, and it bounds file descriptors and
 * per-connection TLS state.
 *
 * Past the ceiling the agent queues FIFO: those requests wait with no timeout
 * and no indicator anywhere in the UI, exactly the silence #12319 is about.
 * The headroom above the fan-out is what keeps that queue empty in practice;
 * surfacing the wait itself (a `providerRetryWait`-style event while a request
 * sits in the pool queue) is a deliberate follow-up, not this change.
 *
 * `PI_ANTHROPIC_MAX_SOCKETS` overrides it (positive integer; anything else is
 * ignored with a debug log), following the `PI_CODEX_WEBSOCKET_*` precedent in
 * this package. There is no settings knob: `packages/ai` has no settings seam
 * for a per-host socket budget.
 */
export const DEFAULT_MAX_SOCKETS_PER_HOST = 128;

/** Resolves the per-host cap from its env override, falling back to the default. */
export function resolveMaxSocketsPerHost(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_MAX_SOCKETS_PER_HOST;
	const value = Number(raw);
	if (Number.isInteger(value) && value > 0) return value;
	logger.debug("Ignoring PI_ANTHROPIC_MAX_SOCKETS: not a positive integer", { raw });
	return DEFAULT_MAX_SOCKETS_PER_HOST;
}

export const MAX_SOCKETS_PER_HOST = resolveMaxSocketsPerHost($env.PI_ANTHROPIC_MAX_SOCKETS);

/** Exported so tests can read the pool's socket and queue books. */
export const directAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS_PER_HOST });

/**
 * Drops a still-queued request from its per-host FIFO inside the agent.
 *
 * `destroy()` alone does not: a queued request has no socket to carry the error
 * through, so it stays parked until the pool hands it a freed socket — which,
 * with every socket held by a long streaming response, may be minutes away.
 * The caller's abort would not settle until then, which is the opposite of what
 * cancelling a request means. Removing it here settles the abort in the same
 * tick and leaves the queue holding only requests that still want a socket.
 *
 * The queues are scanned by request identity rather than keyed by
 * `agent.getName`: that key folds in TLS material and drops `servername` when
 * it matches the host, so recomputing it from the request options here would
 * miss the bucket the request is actually parked in.
 */
function dropFromAgentQueue(agent: https.Agent, request: ClientRequest): void {
	// Agent internals, so shape drift is possible; an abort handler is the last
	// place that may throw, and destroy + reject below still cancel correctly.
	try {
		const queues = agent.requests as Record<string, ClientRequest[] | undefined>;
		for (const [name, queue] of Object.entries(queues)) {
			if (queue === undefined) continue;
			const index = queue.indexOf(request);
			if (index < 0) continue;
			queue.splice(index, 1);
			// Mirrors the agent's own bookkeeping, which drops the key with its last entry.
			if (queue.length === 0) delete queues[name];
			return;
		}
	} catch (error) {
		logger.debug("cowork transport could not dequeue an aborted request", { error });
	}
}

/** Resolved at call time, so a proxy wrapper installed after this module loads is honored. */
const fallbackFetch: FetchImpl = (input, init) => globalThis.fetch(input, init as RequestInit);

function isHeaderRecord(headers: RequestInit["headers"]): headers is Record<string, string> {
	return headers !== undefined && !(headers instanceof Headers) && !Array.isArray(headers);
}

function resolveBody(body: RequestInit["body"]): RequestBody | undefined {
	if (typeof body === "string" || body instanceof Uint8Array) return body;
	return undefined;
}

function buildOrderedHeaders(
	url: URL,
	source: Record<string, string>,
	body: RequestBody | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	let hasHost = false;
	let hasContentLength = false;
	for (const name in source) {
		const lowerName = name.toLowerCase();
		if (lowerName === "host") hasHost = true;
		if (lowerName === "content-length") hasContentLength = true;
		if (lowerName === "accept-encoding" && !hasHost) {
			headers.Host = url.host;
			hasHost = true;
		}
		headers[name] = source[name];
	}
	if (!hasHost) headers.Host = url.host;
	const length = typeof body === "string" ? Buffer.byteLength(body) : body?.byteLength;
	if (!hasContentLength && length !== undefined) headers["Content-Length"] = String(length);
	return headers;
}

function resolveTlsOptions(url: URL, options: CoworkTlsOptions | undefined): tls.ConnectionOptions {
	const resolved: tls.ConnectionOptions = {
		ALPNProtocols: ["http/1.1"],
		ciphers: options?.ciphers ?? tls.DEFAULT_CIPHERS,
		rejectUnauthorized: options?.rejectUnauthorized ?? true,
		servername: options?.serverName ?? url.hostname,
	};
	if (options?.ca !== undefined) resolved.ca = options.ca;
	if (options?.cert !== undefined) resolved.cert = options.cert;
	if (options?.key !== undefined) resolved.key = options.key;
	return resolved;
}

function responseHeaders(message: IncomingMessage): Headers {
	const headers = new Headers();
	for (let index = 0; index < message.rawHeaders.length; index += 2) {
		headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
	}
	return headers;
}

function decodedResponseStream(message: IncomingMessage): stream.Readable {
	const rawEncoding = message.headers["content-encoding"];
	const encoding = (Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding)?.trim().toLowerCase();
	switch (encoding) {
		case "gzip":
			return message.pipe(zlib.createGunzip());
		case "deflate":
			return message.pipe(zlib.createInflate());
		case "br":
			return message.pipe(zlib.createBrotliDecompress());
		case "zstd":
			return message.pipe(zlib.createZstdDecompress());
		default:
			return message;
	}
}

function createResponse(message: IncomingMessage, method: string): Response {
	const status = message.statusCode;
	if (status === undefined) throw new Error("Cowork transport received a response without an HTTP status.");
	const hasBody = method !== "HEAD" && status !== 204 && status !== 304;
	const body = hasBody ? stream.Readable.toWeb(decodedResponseStream(message)) : null;
	return new Response(body, {
		status,
		statusText: message.statusMessage,
		headers: responseHeaders(message),
	});
}

/** Response headers worth naming when a provider rejects a request; `cf-ray` names the edge PoP. */
const DIAGNOSTIC_HEADERS = ["cf-ray", "cf-mitigated", "server", "request-id", "retry-after", "x-should-retry"];

async function sendCoworkRequest(
	url: URL,
	init: CoworkRequestInit,
	sourceHeaders: Record<string, string>,
	body: RequestBody | undefined,
): Promise<Response> {
	const method = init.method ?? "GET";
	const signal = init.signal ?? undefined;
	const tlsOptions = resolveTlsOptions(url, init.tls);
	const headers = buildOrderedHeaders(url, sourceHeaders, body);
	const result = Promise.withResolvers<Response>();
	const release = (): void => {
		signal?.removeEventListener("abort", abort);
	};
	const abort = (): void => {
		const reason = signal?.reason;
		const error = reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
		// Order matters: the queue has to let go of the request before it is
		// destroyed, and the caller is settled here because a queued request
		// never reaches the `error` handler below.
		dropFromAgentQueue(directAgent, request);
		request?.destroy(error);
		result.reject(error);
	};
	if (signal?.aborted) {
		release();
		signal.throwIfAborted();
	}
	signal?.addEventListener("abort", abort, { once: true });
	const request = https.request(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port || 443,
			path: `${url.pathname}${url.search}`,
			method,
			headers,
			agent: directAgent,
			...tlsOptions,
		},
		message => {
			message.once("close", release);
			const status = message.statusCode ?? 0;
			if (status >= 400) {
				logger.debug("cowork transport rejected", {
					url: `${url.host}${url.pathname}`,
					status,
					headers: Object.fromEntries(
						DIAGNOSTIC_HEADERS.filter(name => message.headers[name] !== undefined).map(name => [
							name,
							String(message.headers[name]),
						]),
					),
				});
			}
			try {
				result.resolve(createResponse(message, method));
			} catch (error) {
				message.destroy();
				release();
				result.reject(error);
			}
		},
	);
	request.once("error", error => {
		release();
		result.reject(error);
	});
	request.end(body);
	return result.promise;
}

/**
 * Sends Cowork-profiled HTTPS requests with stable header order, HTTP/1.1, and streaming decompression.
 *
 * Proxied requests deliberately leave this transport. It runs on `node:https`,
 * and Bun's shim ignores both `agent.createConnection` and
 * `options.createConnection`: a CONNECT tunnel handed to it is silently
 * discarded and the request dials the provider directly. That turned every
 * `PI_PROXY` / `HTTPS_PROXY` setting into a no-op for Anthropic inference —
 * the proxy looked configured, the traffic left on the default route, and a
 * region-blocked egress answered `403 Request not allowed`. Bun's own `fetch`
 * honors `init.proxy`, so a configured proxy wins over the Cowork profile.
 */
export const coworkFetch: FetchImpl = async (input, init) => {
	if (
		init === undefined ||
		input instanceof Request ||
		!isHeaderRecord(init.headers) ||
		("proxy" in init && Boolean(init.proxy))
	) {
		// Reason is logged because the switch changes both the TLS fingerprint and
		// who applies the proxy.
		const reason =
			init === undefined
				? "no-init"
				: input instanceof Request
					? "request-object-input"
					: !isHeaderRecord(init.headers)
						? "headers-not-record"
						: "proxy-configured";
		logger.debug("cowork transport bypassed", { url: logTarget(input), reason, proxy: initProxy(init) });
		return fallbackFetch(input, init);
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		logger.debug("cowork transport bypassed", { url: "<unparseable>", reason: "unparseable-url" });
		return fallbackFetch(input, init);
	}
	if (url.protocol !== "https:") {
		logger.debug("cowork transport bypassed", { url: `${url.host}${url.pathname}`, reason: "not-https" });
		return fallbackFetch(input, init);
	}
	const body = resolveBody(init.body);
	if (init.body != null && body === undefined) {
		logger.debug("cowork transport bypassed", { url: `${url.host}${url.pathname}`, reason: "unsupported-body" });
		return fallbackFetch(input, init);
	}
	return sendCoworkRequest(url, init, init.headers, body);
};
