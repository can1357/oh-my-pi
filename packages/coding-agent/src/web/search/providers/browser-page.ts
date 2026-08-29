import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { getProjectDir, untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport } from "../../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../../tools/browser/registry";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

interface BrowserFallbackOptions {
	homeUrl?: string;
	ready?: { selector: string; timeoutMs: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback: (page: LoadedHtmlPage) => boolean;
	attempts?: number;
	retryDelayMs?: number;
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

/**
 * Upper bound on `page.close()` during teardown. A dead CDP session leaves
 * puppeteer's close pending forever; `.catch()` only covers rejection, not a
 * hang, so cleanup needs its own deadline (issue #8865).
 */
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

async function fetchHtmlPage(url: string, options: BrowserFetchOptions, fetchImpl: FetchImpl): Promise<LoadedHtmlPage> {
	const response = await fetchImpl(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}

async function browseHtmlPage(
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
	timeoutMs = SEARCH_HARD_TIMEOUT_MS,
): Promise<LoadedHtmlPage> {
	const { homeUrl, ready } = options;
	const attempts = Math.max(1, options.attempts ?? 1);
	const handle = await untilAborted(signal, () =>
		acquireBrowser(
			{ kind: "headless", headless: true },
			{
				cwd: getProjectDir(),
				signal,
			},
		),
	);
	if (!("browser" in handle)) {
		await releaseBrowser(handle, { kill: false });
		throw new Error("Headless browser acquisition returned a non-Puppeteer browser");
	}

	holdBrowser(handle);
	let page: Page | undefined;
	try {
		const activePage = await untilAborted(signal, () => handle.browser.newPage());
		page = activePage;
		// Viewport and stealth setup talk to the same CDP session as the
		// navigations below but were previously awaited raw. When the shared
		// daemon or the page's target dies mid-setup, those puppeteer calls
		// never settle and the provider promise hangs past
		// SEARCH_HARD_TIMEOUT_MS — the abort signal had no listener at these
		// await points (issue #8865).
		await untilAborted(signal, () => applyViewport(activePage));
		await untilAborted(signal, () => applyStealthPatches(handle.browser, activePage, handle.stealth));
		if (homeUrl) {
			await untilAborted(signal, () =>
				activePage.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			);
		}
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0 && options.retryDelayMs) await Bun.sleep(options.retryDelayMs);

			const response = await untilAborted(signal, () =>
				activePage.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
			);
			if (options.afterNavigation) await options.afterNavigation(activePage, signal);
			if (ready) {
				await untilAborted(signal, () =>
					activePage.waitForSelector(ready.selector, { timeout: ready.timeoutMs }).catch(() => null),
				);
			}
			const loaded = {
				html: await untilAborted(signal, () => activePage.content()),
				status: response?.status() ?? 200,
				url: activePage.url(),
			};
			if (!options.shouldFallback(loaded) || attempt === attempts - 1) return loaded;
		}
		throw new Error("Browser fallback exhausted without a response");
	} finally {
		// Teardown must complete even when the caller's signal already fired
		// (navigating away from a dead session leaves `close()` pending), so
		// bound it with a fresh deadline instead of reusing `signal`.
		if (page) {
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), () => page!.close()).catch(() => undefined);
		}
		await releaseBrowser(handle, { kill: false });
	}
}

/** Fetch with a fresh browser profile, escalating rejected production responses to the stealth browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	let page: LoadedHtmlPage;
	try {
		page = await fetchHtmlPage(url, options, fetchImpl);
	} catch (error) {
		if (options.fetch || !options.browser) throw error;
		return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs);
	}

	if (!options.browser || options.fetch) return page;
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (isSuccessful && !options.browser.shouldFallback(page)) return page;
	return browseHtmlPage(url, options.browser, options.signal, options.timeoutMs);
}
