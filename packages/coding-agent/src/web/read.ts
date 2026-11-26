import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	Reader,
	type ReaderHeader,
	type ReaderOptions,
	type ReaderOutput,
	type ReaderResponse,
} from "@oh-my-pi/pi-natives";
import { ToolAbortError } from "../tools/tool-errors";
import { browse } from "./browse";
import { HttpSession } from "./http-session";

/** Default cookie jar for reads without an explicit session or transport. */
export const sharedHttpSession = new HttpSession((input, init) => fetch(input, init));

interface ReadOptions extends ReaderOptions {
	session?: HttpSession;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	headers?: ReaderHeader[];
	method?: string;
	body?: RequestInit["body"];
	maxBytes?: number;
	skipBody?: (contentType: string) => boolean;
}

/** Native output with the transport metadata needed by site handlers and blob converters. */
export type ReadOutput = ReaderOutput & {
	bytes?: Uint8Array;
	responseHeaders: ReaderHeader[];
	error?: string;
	errorBody?: Uint8Array;
};

/** Execute the native reader's transport requests, retaining bytes when it hands off a blob. */
export async function readUrl(url: string, options: ReadOptions): Promise<ReadOutput> {
	const {
		session,
		signal,
		timeoutMs,
		fetch: fetchOverride,
		headers,
		method,
		body,
		maxBytes,
		skipBody,
		...readerOptions
	} = options;
	const http = session ?? (fetchOverride ? new HttpSession(fetchOverride) : sharedHttpSession);
	const callerHeaders = new Headers(headers?.map(({ name, value }) => [name, value]));
	const userAgent = callerHeaders.get("user-agent");
	callerHeaders.delete("user-agent");
	const reader = new Reader({
		...readerOptions,
		browser: !fetchOverride && readerOptions.browser,
		userAgents: userAgent === null ? readerOptions.userAgents : [userAgent],
	});
	let step = reader.open(url);
	let source: ReaderResponse | undefined;
	let pageStatus: number | undefined;
	while (step.kind !== "done") {
		if (signal?.aborted) throw new ToolAbortError();
		const target = step.url;
		if (!target) throw new Error(`Web reader ${step.kind} step is missing its URL`);
		let response: ReaderResponse;
		if (step.kind === "browse") {
			response = await browse(target, signal ?? new AbortController().signal, timeoutMs);
			pageStatus = response.status;
		} else {
			// A compressed refetch repeats the caller's own request.
			const initial = step.purpose === "page" || step.purpose === "refetch";
			let requestHeaders = step.headers;
			if (initial && callerHeaders.entries().next().done !== true) {
				const merged = new Headers(step.headers?.map(({ name, value }) => [name, value]));
				for (const [name, value] of callerHeaders) merged.set(name, value);
				requestHeaders = Array.from(merged, ([name, value]) => ({ name, value }));
			}
			const cap = maxBytes === undefined ? step.maxBytes : Math.min(step.maxBytes ?? maxBytes, maxBytes);
			response = await http.request({
				url: target,
				method: initial ? (method ?? step.method) : step.method,
				headers: requestHeaders,
				body: initial ? (body ?? step.body) : step.body,
				maxBytes: cap,
				skipBody,
				retry: step.retry,
				timeoutMs,
				signal,
			});
			if (initial || step.purpose === "ua-retry" || step.purpose === "refresh") pageStatus = response.status;
		}
		if (signal?.aborted) throw new ToolAbortError();
		// A remote reply can stand in for the page's content, not its transport metadata.
		if (step.purpose !== "remote") source = response;
		step = await reader.resolve(response);
	}
	if (!step.output) throw new Error("Web reader done step is missing its output");
	return {
		...step.output,
		status: step.output.status ?? pageStatus,
		truncated: step.output.truncated ?? source?.truncated,
		responseHeaders: source?.headers ?? [],
		error: source?.error,
		errorBody: readerOptions.raw && step.output.kind === "failed" ? source?.body : undefined,
		bytes: step.output.kind === "blob" ? source?.body : undefined,
	};
}
