import { isRecord, ptree, tryParseJson } from "@oh-my-pi/pi-utils";

export { isRecord };

import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import type { LoadPageResult } from "./types";
import { MAX_BYTES } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

const PLATFORM_PROBE_CACHE_LIMIT = 256;

/**
 * Whether an HTTP status settles "is this origin platform X?". Transport
 * failures (no status), auth/bot walls, timeouts, rate limits and server errors
 * may be transient, so they never produce a memoized verdict.
 */
export function isConclusiveProbeStatus(status: number | undefined): boolean {
	return status !== undefined && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429;
}

/**
 * True when a failed request to a platform's JSON API settles that the origin
 * does not run that platform: a conclusive status with a non-JSON body (the
 * site's own HTML 404 page, say). Platforms answer API errors with JSON.
 */
export function isNonJsonApiResponse(result: LoadPageResult): boolean {
	return isConclusiveProbeStatus(result.status) && tryParseJson(result.content) === null;
}

/** How long a negative verdict stands; a transient non-JSON error page must not disable a host for good. */
const NEGATIVE_VERDICT_TTL_MS = 10 * 60_000;

interface ProbeVerdict {
	verdict: Promise<boolean>;
	/** `performance.now()` deadline; positive and still-pending verdicts never expire. */
	expiresAt: number;
}

/**
 * Bounded per-origin memo of platform-detection verdicts, negatives included,
 * so generic URL shapes (`/@user`, `/post/N`, `/t/slug/N`) do not re-probe a
 * known host on every fetch. Concurrent lookups share one in-flight probe.
 * Negative verdicts expire after {@link NEGATIVE_VERDICT_TTL_MS}.
 */
export class PlatformProbeCache {
	readonly #verdicts: LRUCache<string, ProbeVerdict>;

	constructor(max = PLATFORM_PROBE_CACHE_LIMIT) {
		this.#verdicts = new LRUCache({ max });
	}

	/** Memoized (possibly still pending) verdict for `origin`. */
	get(origin: string): Promise<boolean> | undefined {
		const entry = this.#verdicts.get(origin);
		if (!entry) return undefined;
		if (performance.now() < entry.expiresAt) return entry.verdict;
		this.#verdicts.delete(origin);
		return undefined;
	}

	/**
	 * Return the memoized verdict, or run `probe` once for `origin`. A probe
	 * resolving `undefined` is inconclusive: callers see `false` and the next
	 * lookup probes again.
	 */
	resolve(origin: string, probe: () => Promise<boolean | undefined>): Promise<boolean> {
		const cached = this.get(origin);
		if (cached) return cached;
		const entry: ProbeVerdict = { verdict: Promise.resolve(false), expiresAt: Number.POSITIVE_INFINITY };
		entry.verdict = probe().then(
			verdict => {
				if (verdict === undefined) this.#forget(origin, entry);
				else if (!verdict) entry.expiresAt = performance.now() + NEGATIVE_VERDICT_TTL_MS;
				return verdict ?? false;
			},
			(error: unknown) => {
				this.#forget(origin, entry);
				throw error;
			},
		);
		this.#verdicts.set(origin, entry);
		return entry.verdict;
	}

	/** Memoize a verdict learned from a regular request to `origin`. */
	record(origin: string, verdict: boolean): void {
		this.#verdicts.set(origin, {
			verdict: Promise.resolve(verdict),
			expiresAt: verdict ? Number.POSITIVE_INFINITY : performance.now() + NEGATIVE_VERDICT_TTL_MS,
		});
	}

	#forget(origin: string, entry: ProbeVerdict): void {
		if (this.#verdicts.peek(origin) === entry) this.#verdicts.delete(origin);
	}
}

export function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BinaryFetchSuccess {
	ok: true;
	buffer: Uint8Array;
	contentDisposition?: string;
}

export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

async function readResponseWithLimit(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
	expectedBytes = 0,
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	// With a trustworthy Content-Length, chunks are copied straight into the
	// final buffer so each one can be released as soon as it is consumed.
	// If the body outgrows the declared length, fall back to collecting chunks.
	let preallocated = expectedBytes > 0 && expectedBytes <= maxBytes ? new Uint8Array(expectedBytes) : undefined;
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new ToolAbortError();
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;

			const offset = totalBytes;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`response exceeds ${maxBytes} bytes`);
			}

			if (preallocated) {
				if (totalBytes <= preallocated.byteLength) {
					preallocated.set(value, offset);
					continue;
				}
				chunks.push(preallocated.subarray(0, offset));
				preallocated = undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	if (preallocated) {
		return totalBytes === preallocated.byteLength ? preallocated : preallocated.slice(0, totalBytes);
	}
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

/**
 * Fetch binary content from a URL
 */
export async function fetchBinary(url: string, timeout: number = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
	const requestSignal = ptree.combineSignals(signal, timeout * 1000);
	try {
		const response = await fetch(url, {
			signal: requestSignal,
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; TextBot/1.0)",
			},
			redirect: "follow",
		});

		if (!response.ok) {
			return { ok: false, error: `HTTP ${response.status}` };
		}

		const contentDisposition = response.headers.get("content-disposition") || undefined;
		const contentLength = response.headers.get("content-length");
		let expectedBytes = 0;
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_BYTES) {
				return { ok: false, error: `content-length ${size} exceeds ${MAX_BYTES}` };
			}
			// Content-Length describes the encoded body; only trust it for identity encoding.
			if (Number.isFinite(size) && size > 0 && !response.headers.has("content-encoding")) {
				expectedBytes = size;
			}
		}
		const buffer = await readResponseWithLimit(response, MAX_BYTES, requestSignal, expectedBytes);
		return { ok: true, buffer, contentDisposition };
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		if (requestSignal?.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: err instanceof Error ? err.message : "Failed to fetch binary" };
	}
}

/**
 * Convert binary content to markdown using markit.
 */
export async function convertWithMarkit(
	buffer: Uint8Array,
	extension: string,
	timeout: number = 20,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean; error?: string }> {
	const conversionSignal = ptree.combineSignals(signal, timeout * 1000);
	return convertBufferWithMarkit(buffer, extension, conversionSignal);
}
