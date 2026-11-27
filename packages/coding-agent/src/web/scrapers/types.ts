import { readUrl } from "../read";
import { decodeBody } from "../response-body";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	/** True when the response body was cut mid-stream at {@link MAX_BYTES}. */
	truncated: boolean;
	notes: string[];
}

/** Network read bound for a fetched body; the only size limit on rendered URL content. */
export const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Collapse blank-line runs and trim. Never shortens content: URL reads page the preview
 * themselves, and selectors, artifacts, and URL search must see the whole body.
 */
export function finalizeOutput(content: string): string {
	return content.replace(/\n{3,}/g, "\n\n").trim();
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	/** True when the body was cut mid-stream at maxBytes. */
	truncated?: boolean;
	/** Last transport-level error message when ok is false. */
	error?: string;
	/**
	 * Bot protection that answered with its challenge or block page instead of the page. Such a
	 * response is never `ok`, whatever its status, so a caller checking `ok` does not take it as content.
	 */
	blockedBy?: string;
}

/** Fetch a page without formatting its body. */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers, maxBytes = MAX_BYTES, signal, method, body } = options;
	const output = await readUrl(url, {
		raw: true,
		browser: false,
		timeoutMs: timeout * 1000,
		headers: headers && Object.entries(headers).map(([name, value]) => ({ name, value })),
		maxBytes,
		signal,
		method,
		body,
	});
	const contentTypeHeader = output.responseHeaders.find(({ name }) => name.toLowerCase() === "content-type")?.value;
	const contentType = output.contentType ?? output.mime ?? contentTypeHeader ?? "";
	const blockedBy = output.verdict === "wall" ? (output.wall ?? "bot protection") : undefined;
	return {
		content:
			output.content ??
			(output.errorBody && !blockedBy ? decodeBody(output.errorBody, contentTypeHeader ?? "") : ""),
		contentType: contentType.split(";", 1)[0].trim().toLowerCase(),
		finalUrl: output.url || url,
		ok: output.kind !== "failed" && !blockedBy,
		status: output.status || undefined,
		truncated: output.truncated,
		error: output.error,
		blockedBy,
	};
}
