import * as net from "node:net";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ReaderHeader, ReaderResponse } from "@oh-my-pi/pi-natives";
import { errorMessage, sleepLong, untilAborted } from "@oh-my-pi/pi-utils";
import { readBoundedBody } from "@oh-my-pi/pi-utils/bounded-json";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
/** A transient failure is retried quickly or not at all: the caller has other sources to try. */
const MAX_TRANSIENT_DELAY_MS = 2_000;
const DEFAULT_TRANSIENT_DELAY_MS = 500;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-length",
	"content-location",
	"content-type",
	"transfer-encoding",
];
const ORIGIN_HEADERS = ["authorization", "cookie", "host", "proxy-authorization", "referer"];

interface HttpRequest {
	url: string;
	method?: string;
	headers?: ReaderHeader[];
	body?: RequestInit["body"];
	maxBytes?: number;
	/** Skip a final response body based on its lowercased MIME type, without parameters. */
	skipBody?: (contentType: string) => boolean;
	/**
	 * Responses retried once: `rate-limit` (default) waits out a 429's Retry-After, at most 10 s;
	 * `transient` also retries 408 and 5xx after at most 2 s and returns a response asking for
	 * longer as is; `none` never retries.
	 */
	retry?: "none" | "rate-limit" | "transient";
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface StoredCookie {
	pair: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
	expires: number;
}

function httpUrl(input: string, base?: URL): URL {
	const url = new URL(input, base);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Expected an HTTP(S) URL");
	if (url.username || url.password) throw new Error("Credentials in URLs are not permitted");
	return url;
}

function domainMatches(host: string, domain: string): boolean {
	return host === domain || (host.endsWith(`.${domain}`) && net.isIP(host) === 0);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	return (
		requestPath === cookiePath ||
		(requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"))
	);
}

/** Retry-After as a non-negative delay, or undefined when absent or unreadable. */
function retryAfterMs(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
	return Number.isNaN(ms) ? undefined : Math.max(0, ms);
}

/** Delay before retrying `response` under `retry`, or undefined when it is returned as is. */
function retryDelayMs(retry: NonNullable<HttpRequest["retry"]>, response: Response): number | undefined {
	const { status } = response;
	if (retry === "none") return undefined;
	const hint = retryAfterMs(response.headers.get("retry-after"));
	if (retry === "rate-limit") {
		return status === 429 ? Math.min(hint ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS) : undefined;
	}
	if (status !== 408 && status !== 429 && status < 500) return undefined;
	if (hint !== undefined && hint > MAX_TRANSIENT_DELAY_MS) return undefined;
	return hint ?? DEFAULT_TRANSIENT_DELAY_MS;
}

function discard(body?: ReadableStream | null): void {
	void body?.cancel().catch(() => {});
}

/** Manual HTTP transport with an in-memory cookie jar scoped to this instance. */
export class HttpSession {
	readonly #cookies = new Map<string, StoredCookie>();
	readonly #fetch: FetchImpl;

	constructor(fetchImpl: FetchImpl = fetch) {
		this.#fetch = fetchImpl;
	}

	#storeCookies(url: URL, headers: string[]): void {
		const now = Date.now();
		for (const header of headers) {
			let cookie: Bun.Cookie;
			try {
				cookie = Bun.Cookie.parse(header);
			} catch {
				continue;
			}
			if (!cookie.name || (cookie.secure && url.protocol !== "https:")) continue;
			const attribute = cookie.domain?.toLowerCase().replace(/^\./, "");
			const hostOnly = !attribute;
			const domain = attribute || url.hostname;
			if (!domainMatches(url.hostname, domain)) continue;
			// Bun supplies '/' for a missing Path, but the default path is request-relative.
			const path =
				cookie.path.startsWith("/") && /;\s*path\s*=/i.test(header)
					? cookie.path
					: url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
			const expires =
				cookie.maxAge === undefined ? (cookie.expires?.getTime() ?? Infinity) : now + cookie.maxAge * 1000;
			const key = `${hostOnly}\t${domain}\t${path}\t${cookie.name}`;
			if (expires <= now) this.#cookies.delete(key);
			else {
				this.#cookies.set(key, {
					pair: `${cookie.name}=${cookie.value}`,
					domain,
					hostOnly,
					path,
					secure: cookie.secure,
					expires,
				});
			}
		}
	}

	#cookieHeader(url: URL): string {
		const now = Date.now();
		const matches: StoredCookie[] = [];
		for (const [key, cookie] of this.#cookies) {
			if (cookie.expires <= now) this.#cookies.delete(key);
			else if (
				(!cookie.secure || url.protocol === "https:") &&
				(cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain)) &&
				pathMatches(url.pathname, cookie.path)
			) {
				matches.push(cookie);
			}
		}
		return matches
			.sort((a, b) => b.path.length - a.path.length)
			.map(({ pair }) => pair)
			.join("; ");
	}

	/** Follow validated redirects and read at most `maxBytes`; transport failures use status 0. */
	async request(request: HttpRequest): Promise<ReaderResponse> {
		let currentUrl = request.url;
		let body = request.body;
		let signal: AbortSignal | undefined;
		try {
			let url = httpUrl(currentUrl);
			let method = request.method;
			const headers = new Headers(request.headers?.map(({ name, value }) => [name, value]));
			// Cloudflare Markdown-for-Agents can return corrupted bytes when compression is negotiated.
			if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
			const deadline = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
			let redirects = 0;
			let retried = false;

			for (;;) {
				signal.throwIfAborted();
				currentUrl = url.href;
				const hopHeaders = new Headers(headers);
				const cookies = this.#cookieHeader(url);
				if (cookies) {
					const explicit = hopHeaders.get("cookie");
					hopHeaders.set("cookie", explicit ? `${explicit}; ${cookies}` : cookies);
				}
				// A streamed upload needs a second branch in case the server requests a replay.
				let upload = body;
				if (body instanceof ReadableStream) [upload, body] = body.tee();
				let response: Response;
				try {
					response = await untilAborted(signal, () =>
						this.#fetch(currentUrl, { method, body: upload, headers: hopHeaders, redirect: "manual", signal }),
					);
				} finally {
					if (upload instanceof ReadableStream && !upload.locked) discard(upload);
				}
				const { status } = response;
				const setCookies = response.headers.getSetCookie();
				this.#storeCookies(url, setCookies);

				if (REDIRECT_STATUSES.has(status)) {
					discard(response.body);
					if (redirects++ === MAX_REDIRECTS) throw new Error("Too many HTTP redirects");
					const location = response.headers.get("location");
					if (!location) throw new Error("HTTP redirect has no Location");
					const next = httpUrl(location, url);
					if (url.protocol === "https:" && next.protocol === "http:")
						throw new Error("Refusing HTTPS to HTTP redirect");
					const verb = method?.toUpperCase() ?? "GET";
					if (status === 303 || ((status === 301 || status === 302) && verb === "POST")) {
						if (body instanceof ReadableStream) discard(body);
						body = undefined;
						method = "GET";
						for (const name of BODY_HEADERS) headers.delete(name);
					} else if (url.origin !== next.origin && (body != null || (verb !== "GET" && verb !== "HEAD"))) {
						throw new Error(`Refusing to forward ${method} on a cross-origin redirect`);
					}
					if (url.origin !== next.origin) for (const name of ORIGIN_HEADERS) headers.delete(name);
					url = next;
					continue;
				}
				const delayMs = retried ? undefined : retryDelayMs(request.retry ?? "rate-limit", response);
				if (delayMs !== undefined) {
					retried = true;
					discard(response.body);
					await sleepLong(delayMs, signal);
					continue;
				}

				const resultHeaders: ReaderHeader[] = [];
				for (const [name, value] of response.headers) {
					if (name !== "set-cookie") resultHeaders.push({ name, value });
				}
				for (const value of setCookies) resultHeaders.push({ name: "set-cookie", value });
				if (
					request.skipBody?.(response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "")
				) {
					discard(response.body);
					return {
						status,
						url: response.url || currentUrl,
						headers: resultHeaders,
						body: Buffer.alloc(0),
						truncated: false,
					};
				}
				const maxBytes = Math.max(0, Math.floor(request.maxBytes ?? DEFAULT_MAX_BYTES));
				const result = await readBoundedBody(response, maxBytes, { signal });
				const bytes = result?.bytes;
				return {
					status,
					url: response.url || currentUrl,
					headers: resultHeaders,
					body: bytes && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
					truncated: result?.truncated ?? false,
				};
			}
		} catch (error) {
			return {
				status: 0,
				url: currentUrl,
				headers: [],
				error: errorMessage(signal?.aborted ? signal.reason : error),
			};
		} finally {
			if (body instanceof ReadableStream) discard(body);
		}
	}
}
