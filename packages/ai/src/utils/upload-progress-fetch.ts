import { isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import { ConnectionLostBeforeResponseError } from "../error";
import type { FetchImpl } from "../types";

/**
 * Bodies at least this large are streamed so a dropped connection can say how
 * far the upload got. A smaller body fits in the socket buffers and is handed
 * off at once, so it could only ever read "written"; it keeps Bun's own body
 * handling.
 */
const UPLOAD_PROGRESS_MIN_BYTES = 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 64 * 1024;

function requestBodyBytes(body: RequestInit["body"]): Uint8Array | undefined {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return undefined;
}

/** The fetch standard's redirect limit, which Bun's `fetch` also applies. */
const MAX_REDIRECTS = 20;
/** Headers the fetch standard drops when a redirect turns the request into a bodiless GET. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
/** Credentials Bun's `fetch` drops when a redirect leaves the origin. */
const ORIGIN_CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Send a large string or byte body through Bun's `fetch` as a stream with an
 * explicit `Content-Length`, counting the bytes Bun pulls as the socket drains.
 * Bun keeps `Content-Length` framing for such a stream (not chunked) and pulls
 * lazily, so the count separates a body still uploading from one fully written.
 * A socket closed before response headers then becomes a
 * {@link ConnectionLostBeforeResponseError} with the original error as
 * `cause`; failures to connect, aborts and other errors keep their own.
 *
 * Bun cannot replay a streamed body to follow a redirect, so when the caller
 * follows redirects they are followed here, as `fetch` would: 307/308 resend
 * the body to the new location, 303 (and 301/302 after a POST) become a GET
 * without it, and credentials are dropped when the location leaves the origin.
 */
export async function fetchWithUploadProgress(
	fetch: FetchImpl,
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<Response> {
	const bytes = requestBodyBytes(init?.body);
	if (input instanceof Request || !bytes || bytes.byteLength < UPLOAD_PROGRESS_MIN_BYTES) return fetch(input, init);
	const startedAt = performance.now();
	const follow = (init?.redirect ?? "follow") === "follow";
	const headers = new Headers(init?.headers);
	headers.set("content-length", String(bytes.byteLength));
	let url = new URL(input);
	for (let redirects = 0; ; redirects++) {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled >= bytes.byteLength) {
					controller.close();
					return;
				}
				const chunk = bytes.subarray(pulled, pulled + UPLOAD_CHUNK_BYTES);
				pulled += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});
		let response: Response;
		try {
			response = await fetch(url, {
				...init,
				body,
				headers,
				duplex: "half",
				redirect: follow ? "manual" : init?.redirect,
			});
		} catch (error) {
			if (init?.signal?.aborted || !(error instanceof Error) || !isUnexpectedSocketCloseMessage(error.message)) {
				throw error;
			}
			throw new ConnectionLostBeforeResponseError(error, {
				bodyBytes: bytes.byteLength,
				bodySent: pulled === bytes.byteLength,
				elapsedMs: performance.now() - startedAt,
			});
		}
		const location = response.headers.get("location");
		if (!follow || response.status < 300 || response.status >= 400 || location === null) return response;
		await response.body?.cancel();
		if (redirects === MAX_REDIRECTS) throw new TypeError(`Too many redirects (more than ${MAX_REDIRECTS})`);
		const next = new URL(location, url);
		if (next.origin !== url.origin) for (const name of ORIGIN_CREDENTIAL_HEADERS) headers.delete(name);
		url = next;
		const method = init?.method?.toUpperCase() ?? "GET";
		if (
			(response.status === 303 && method !== "HEAD") ||
			((response.status === 301 || response.status === 302) && method === "POST")
		) {
			for (const name of BODY_HEADERS) headers.delete(name);
			return fetch(url, { ...init, method: "GET", body: undefined, headers });
		}
	}
}
