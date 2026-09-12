import { isRecord, ptree, readBoundedBytes } from "@oh-my-pi/pi-utils";

export { isRecord };

import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import { MAX_BYTES } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
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
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_BYTES) {
				return { ok: false, error: `content-length ${size} exceeds ${MAX_BYTES}` };
			}
		}
		const { value: buffer, truncated } = await readBoundedBytes(response.body, MAX_BYTES, requestSignal);
		if (truncated) return { ok: false, error: `response exceeds ${MAX_BYTES} bytes` };
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
