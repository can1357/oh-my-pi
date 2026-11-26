import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ReaderHeader, ReaderResponse } from "@oh-my-pi/pi-natives";
import { AbortError } from "@oh-my-pi/pi-utils/abortable";
import { type BrowseHooks, browse, type LoadedHtmlPage } from "../../browse";
import { HttpSession } from "../../http-session";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

export type { LoadedHtmlPage } from "../../browse";

interface BrowserFallbackOptions extends BrowseHooks {
	shouldFallback: (page: LoadedHtmlPage) => boolean;
}

/** Controls a browser-profiled fetch and its optional headless-browser fallback. */
export interface BrowserFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	timeoutMs?: number;
	randomizeHeaders?: boolean;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
	browser?: BrowserFallbackOptions;
}

function htmlPage(response: ReaderResponse, signal: AbortSignal): LoadedHtmlPage {
	if (response.status === 0) {
		if (signal.aborted) throw new AbortError(signal);
		throw new Error(response.error);
	}
	return {
		html: new TextDecoder().decode(response.body),
		status: response.status,
		url: response.url,
	};
}

async function browseHtmlPage(
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
	timeoutMs = SEARCH_HARD_TIMEOUT_MS,
): Promise<LoadedHtmlPage> {
	return htmlPage(await browse(url, signal, timeoutMs, options), signal);
}

/** Fetch with a fresh browser profile, escalating rejected production responses to the stealth browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const { signal, timeoutMs } = options;
	const profile: Record<string, string> = {
		...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
		...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
		...options.headers,
	};
	const headers: ReaderHeader[] = [];
	for (const name in profile) {
		const value = profile[name];
		if (value !== undefined) headers.push({ name, value });
	}
	const fetchImpl = options.fetch ?? fetch;
	const http = new HttpSession(
		options.init ? (input, init) => fetchImpl(input, { ...options.init, ...init }) : fetchImpl,
	);
	const response = await http.request({
		url,
		headers,
		signal,
		timeoutMs: timeoutMs ?? SEARCH_HARD_TIMEOUT_MS,
		method: options.init?.method,
		body: options.init?.body ?? undefined,
	});

	const fallback = !options.fetch && options.browser;
	if (response.status === 0 && fallback && !signal.aborted) return browseHtmlPage(url, fallback, signal, timeoutMs);
	const page = htmlPage(response, signal);
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (!fallback || (isSuccessful && !fallback.shouldFallback(page))) return page;
	return browseHtmlPage(url, fallback, signal, timeoutMs);
}
