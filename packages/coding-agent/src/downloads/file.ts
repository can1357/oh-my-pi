import * as fs from "node:fs";
import { fetchWithRetry, ptree } from "@oh-my-pi/pi-utils";

const TOOL_DOWNLOAD_TIMEOUT_MS = 120_000;

type BodyReadResult = Bun.ReadableStreamDefaultReadResult<Uint8Array>;
type BodyReader = {
	read(): Promise<BodyReadResult>;
	cancel(reason?: unknown): Promise<void>;
};

function isAbortLikeError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readBodyChunk(reader: BodyReader, signal: AbortSignal | undefined): Promise<BodyReadResult> {
	if (!signal) return await reader.read();
	if (signal.aborted) throw abortReason(signal);

	const abort = Promise.withResolvers<BodyReadResult>();
	const onAbort = () => abort.reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function writeResponseBody(
	dest: string,
	body: NonNullable<Response["body"]>,
	signal: AbortSignal | undefined,
	onChunk: ((bytes: number) => void) | undefined,
): Promise<void> {
	const reader = body.getReader();
	const sink = Bun.file(dest).writer();
	let completed = false;

	try {
		while (true) {
			const { done, value } = await readBodyChunk(reader, signal);
			if (done) break;
			if (value) {
				await sink.write(value);
				onChunk?.(value.byteLength);
			}
		}
		await sink.end();
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => {});
			await Promise.resolve(sink.end()).catch(() => {});
			await fs.promises.rm(dest, { force: true }).catch(() => {});
		}
	}
}

/** Options for {@link downloadFile}. */
export interface DownloadFileOptions {
	signal?: AbortSignal;
	/** Bound on the whole transfer (default 2 minutes; raise it for large model weights). */
	timeoutMs?: number;
	/** Bytes written so far and the `Content-Length` total (undefined when the server omits it). */
	onProgress?: (loaded: number, total: number | undefined) => void;
}

/**
 * Download a tool asset without handing the streaming Response to Bun.write.
 * Transient failures (5xx, 408, 429, network errors) are retried within `timeoutMs`.
 */
export async function downloadFile(url: string, dest: string, options: DownloadFileOptions = {}): Promise<void> {
	const { signal, timeoutMs = TOOL_DOWNLOAD_TIMEOUT_MS, onProgress } = options;
	const downloadSignal = ptree.combineSignals(signal, timeoutMs);
	let response: Response;
	try {
		response = await fetchWithRetry(url, { signal: downloadSignal, maxAttempts: 4, maxDelayMs: 8_000 });
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		} else if (!response.body) {
			throw new Error("No response body");
		}
		const length = Number(response.headers.get("content-length"));
		const total = Number.isFinite(length) && length > 0 ? length : undefined;
		let loaded = 0;
		await writeResponseBody(
			dest,
			response.body,
			downloadSignal,
			onProgress &&
				(bytes => {
					loaded += bytes;
					onProgress(loaded, total);
				}),
		);
	} catch (err) {
		if (isAbortLikeError(err) || downloadSignal?.aborted) {
			throw new Error(`Download timed out: ${url}`);
		}
		throw err;
	}
}
