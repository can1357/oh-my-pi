import type { FetchImpl } from "../types";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** The fetch standard's redirect limit. */
const MAX_REDIRECTS = 20;
/** What the platform drops on a cross-origin redirect; following by hand must drop it too. */
const CROSS_ORIGIN_CREDENTIALS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Request headers that may only be sent to one origin. */
export interface OriginLockedHeaders {
	/** Origin (scheme, host and port) the headers are locked to. */
	origin: string;
	/** Header names, in any casing. */
	names: readonly string[];
}

type RequestHeaders = RequestInit["headers"];

/** `headers` without the entries whose lower-cased name is in `names`, in the caller's container. */
function withoutHeaders(headers: RequestHeaders, names: ReadonlySet<string>): RequestHeaders {
	if (!headers) return headers;
	if (headers instanceof Headers) {
		const copy = new Headers(headers);
		for (const name of names) copy.delete(name);
		return copy;
	}
	if (Array.isArray(headers)) return headers.filter(([name]) => !names.has(name.toLowerCase()));
	const copy: Record<string, string | readonly string[]> = {};
	for (const name in headers) {
		if (!names.has(name.toLowerCase())) copy[name] = headers[name];
	}
	return copy;
}

/** A body the next hop can send again; a stream is consumed by the first. */
function isReplayable(body: RequestInit["body"]): boolean {
	return (
		body === undefined ||
		body === null ||
		typeof body === "string" ||
		ArrayBuffer.isView(body) ||
		body instanceof ArrayBuffer ||
		body instanceof Blob ||
		body instanceof URLSearchParams ||
		body instanceof FormData
	);
}

/**
 * Follows redirects by hand so headers locked to one origin are never sent to
 * another. The platform's own redirect handling drops credentials on a
 * cross-origin hop but keeps every custom header, so a 307/308 from the locked
 * origin would carry them to whatever host the `Location` names, plaintext
 * included.
 *
 * Every hop goes back through `base`, so the transport layers (proxy, CA,
 * request debugging) apply to each one. The locked headers go only to the
 * locked origin; a hop to another origin also drops the credentials the
 * platform would have dropped. A redirect is returned unfollowed, for the
 * caller to surface as an HTTP error, when following it would rewrite the
 * request: a 301/302/303 of a non-GET request (the platform turns it into a
 * body-less GET), a body that cannot be sent twice, or a `Request` input.
 */
export function wrapFetchForOriginLockedHeaders(base: FetchImpl, lock: OriginLockedHeaders): FetchImpl {
	const locked = new Set(lock.names.map(name => name.toLowerCase()));
	const wrapped: FetchImpl = async (input, init) => {
		const mode = init?.redirect ?? "follow";
		if (input instanceof Request) return base(input, { ...init, redirect: mode === "follow" ? "manual" : mode });
		if (mode !== "follow") return base(input, init);

		const method = (init?.method ?? "GET").toUpperCase();
		let url = new URL(input);
		let headers = init?.headers;
		for (let hop = 0; ; hop++) {
			if (url.origin !== lock.origin) headers = withoutHeaders(headers, locked);
			const response = await base(url.href, { ...init, headers, redirect: "manual" });
			if (!REDIRECT_STATUSES.has(response.status)) return response;
			const location = response.headers.get("location");
			if (!location || hop >= MAX_REDIRECTS) return response;
			const keepsMethod =
				response.status === 307 || response.status === 308 || method === "GET" || method === "HEAD";
			if (!keepsMethod || !isReplayable(init?.body)) return response;

			let next: URL;
			try {
				next = new URL(location, url);
			} catch {
				return response;
			}
			if (next.origin !== url.origin) headers = withoutHeaders(headers, CROSS_ORIGIN_CREDENTIALS);
			await response.body?.cancel().catch(() => {});
			url = next;
		}
	};
	if (base.preconnect) wrapped.preconnect = base.preconnect;
	return wrapped;
}
