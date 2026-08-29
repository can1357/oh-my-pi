import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import * as stream from "node:stream";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { logger } from "@oh-my-pi/pi-utils";
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

const directAgent = new https.Agent({ keepAlive: true });

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
	let request: ClientRequest | undefined;
	const release = (): void => {
		signal?.removeEventListener("abort", abort);
	};
	const abort = (): void => {
		const reason = signal?.reason;
		request?.destroy(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
	};
	if (signal?.aborted) {
		release();
		signal.throwIfAborted();
	}
	signal?.addEventListener("abort", abort, { once: true });
	request = https.request(
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
