import { ptree } from "@oh-my-pi/pi-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import { sharedHttpSession } from "../read";
import { MAX_BYTES } from "./types";

export interface BinaryFetchSuccess {
	ok: true;
	buffer: Uint8Array;
	contentDisposition?: string;
	/** Full Content-Type header, including charset, when the server supplies one. */
	contentType?: string;
}

export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

/** Fetch binary content without decoding or formatting it. */
export async function fetchBinary(url: string, timeout = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
	const response = await sharedHttpSession.request({ url, timeoutMs: timeout * 1000, maxBytes: MAX_BYTES, signal });
	if (signal?.aborted) throw new ToolAbortError();
	if (response.status < 200 || response.status >= 300) {
		return { ok: false, error: response.error ?? `HTTP ${response.status}` };
	}
	if (response.truncated) return { ok: false, error: `response exceeds ${MAX_BYTES} bytes` };
	return {
		ok: true,
		buffer: response.body ?? new Uint8Array(0),
		contentDisposition: response.headers.find(({ name }) => name.toLowerCase() === "content-disposition")?.value,
		contentType: response.headers.find(({ name }) => name.toLowerCase() === "content-type")?.value,
	};
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
