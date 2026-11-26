import * as fs from "node:fs";
import { $which, fetchWithRetry, logger, ptree, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import { trackDownload } from "../downloads/activity";

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

// Install a Python package via uv (preferred) or pip
async function installPythonPackage(pkg: string, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	try {
		// Try uv first (faster, better isolation)
		const uv = $which("uv");
		if (uv) {
			const result = await ptree.exec([uv, "tool", "install", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			if (result.exitCode === 0) return true;
			if (signal?.aborted) return false;
		}

		// Fall back to pip
		const pip = $which("pip3") || $which("pip");
		if (pip) {
			const result = await ptree.exec([pip, "install", "--user", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			return result.exitCode === 0;
		}

		return false;
	} catch (error) {
		logger.warn(`Failed to install Python package ${pkg}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/** Options for {@link ensureTool}. */
export interface EnsureToolOptions {
	signal?: AbortSignal;
	/** Suppress install/failure log lines. */
	silent?: boolean;
}

/** Locates Trafilatura on PATH or installs it via uv or pip. */
export async function ensureTool(tool: "trafilatura", options: EnsureToolOptions = {}): Promise<string | undefined> {
	const { signal, silent = false } = options;
	const existing = $which(tool);
	if (existing || signal?.aborted) return existing ?? undefined;

	if (!silent) logger.debug(`${tool} not found. Installing via uv/pip...`);
	const tracker = trackDownload(tool, { detail: "installing" });
	const success = await installPythonPackage(tool, signal);
	if (signal?.aborted) {
		tracker.done();
		return undefined;
	}
	const installedPath = success ? $which(tool, { cache: WhichCachePolicy.Fresh }) : undefined;
	if (installedPath) {
		tracker.done();
		return installedPath;
	}
	tracker.fail(new Error(`could not install ${tool} with uv or pip`));
	if (!silent) logger.warn(`Failed to install ${tool}`);
	return undefined;
}
