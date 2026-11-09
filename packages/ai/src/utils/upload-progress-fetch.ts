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

/**
 * Send a large string or byte body through Bun's `fetch` as a stream with an
 * explicit `Content-Length`, counting the bytes Bun pulls as the socket drains.
 * Bun keeps `Content-Length` framing for such a stream (not chunked) and pulls
 * lazily, so the count separates a body still uploading from one fully written.
 * A socket closed before response headers then becomes a
 * {@link ConnectionLostBeforeResponseError} with the original error as
 * `cause`; failures to connect, aborts and other errors keep their own.
 *
 * Bun cannot replay a streamed body to follow a redirect, so redirects are
 * taken manually and, when the caller follows them, the request is sent again
 * with the original body for Bun to follow.
 */
export async function fetchWithUploadProgress(
	fetch: FetchImpl,
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<Response> {
	const bytes = input instanceof Request ? undefined : requestBodyBytes(init?.body);
	if (!bytes || bytes.byteLength < UPLOAD_PROGRESS_MIN_BYTES) return fetch(input, init);
	const startedAt = performance.now();
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
	const headers = new Headers(init?.headers);
	headers.set("content-length", String(bytes.byteLength));
	const follow = (init?.redirect ?? "follow") === "follow";
	let response: Response;
	try {
		response = await fetch(input, {
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
	if (!follow || response.status < 300 || response.status >= 400 || !response.headers.has("location")) return response;
	await response.body?.cancel();
	return fetch(input, init);
}
