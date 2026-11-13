import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { getProjectDir, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport, browserConnection, privateTargetId } from "../../../tools/browser/launch";
import {
	closeSharedTargetUntilGone,
	forgetSharedTarget,
	markSharedTargetUnclosed,
	recordSharedTarget,
	retryUnclosedSharedTargets,
} from "../../../tools/browser/orphan-registry";
import {
	acquireBrowser,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
	sharedTargetScopeOf,
} from "../../../tools/browser/registry";
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
 * Upper bound on a search's page teardown; a close still unconfirmed by then
 * finishes in the background under its own browser hold. A wedged connection
 * can leave CDP calls pending forever (issue #8865).
 */
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Bound on a search page's `Target.createTarget`, overriding the 60 s protocol timeout: a timed-out
 * create still opens its target, with no id to close it by. This bounds a stalled Chromium.
 */
const CREATE_TARGET_TIMEOUT_MS = 5 * 60_000;

/** Claim a search page so the orphan reaper closes it if this process dies first (issue #10022). */
function recordSearchPage(handle: PuppeteerBrowserHandle, targetId: string): void {
	const scope = sharedTargetScopeOf(handle);
	if (scope) void recordSharedTarget(scope, targetId);
}

/**
 * Close a search page by target id and settle its ownership record; never rejects.
 * Not `page.close()`: on a connection that outlives the search it can wait forever.
 */
async function closeSearchPage(handle: PuppeteerBrowserHandle, targetId: string): Promise<void> {
	const scope = sharedTargetScopeOf(handle);
	if (await closeSharedTargetUntilGone(handle.browser, targetId)) {
		if (scope) void forgetSharedTarget(scope, targetId);
		return;
	}
	if (handle.browser.connected) {
		logger.warn("Could not confirm a web search page was closed; it may still be open", { targetId });
	} else {
		// The page most likely died with the browser; the next search's retry confirms it.
		logger.debug("Lost the browser connection before a web search page close was confirmed", { targetId });
	}
	// Keep the record for a later retry. Unlike browser-tool tabs, never recheck (and maybe
	// stop) the shared browser: that would close every other session's tabs.
	if (scope) markSharedTargetUnclosed(scope, targetId);
}

/** Run `task` under its own browser hold, so the caller's last release cannot disconnect mid-task. */
function whileHeld<T>(handle: PuppeteerBrowserHandle, task: () => Promise<T>): Promise<T> {
	holdBrowser(handle);
	return task().finally(() => releaseBrowser(handle, { kill: false }).catch(() => undefined));
}

/**
 * Create and claim a search page's target. Not `newPage()`: it can reject after creating the target,
 * leaving no id to close. An abort does not cancel the create, so a late target is closed under its
 * own hold (unlike `untilAbortedOrReleased`, which cannot hold the browser while it waits), bounded
 * by the create's own timeout.
 */
async function createSearchTarget(handle: PuppeteerBrowserHandle, signal: AbortSignal): Promise<string> {
	// What `newPage()` sends for the default context.
	const created = browserConnection(handle.browser).send(
		"Target.createTarget",
		{ url: "about:blank" },
		{ timeout: CREATE_TARGET_TIMEOUT_MS },
	);
	try {
		const { targetId } = await untilAborted(signal, created);
		recordSearchPage(handle, targetId);
		return targetId;
	} catch (error) {
		if (signal.aborted) {
			void whileHeld(handle, () =>
				created.then(
					({ targetId }) => {
						recordSearchPage(handle, targetId);
						return closeSearchPage(handle, targetId);
					},
					error =>
						logger.debug("An abandoned web search page create failed; its target may still be open", {
							error: error instanceof Error ? error.message : String(error),
						}),
				),
			);
		}
		throw error;
	}
}

/** The `Page` of a created search target, resolved as `newPage()` does. */
async function openSearchPage(handle: PuppeteerBrowserHandle, targetId: string, signal: AbortSignal): Promise<Page> {
	const target = await untilAborted(signal, () =>
		handle.browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, { signal }),
	);
	const page = await untilAborted(signal, () => target.page());
	if (!page) throw new Error(`Web search target ${targetId} exposed no page`);
	return page;
}

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
	const scope = sharedTargetScopeOf(handle);
	// The orphan reaper skips this live process, so retry earlier searches' unconfirmed closes here.
	if (scope) void whileHeld(handle, () => retryUnclosedSharedTargets(handle.browser, scope));

	holdBrowser(handle);
	let targetId: string | undefined;
	try {
		targetId = await createSearchTarget(handle, signal);
		const activePage = await openSearchPage(handle, targetId, signal);
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
		// (a wedged connection leaves CDP calls pending), so bound it with a
		// fresh deadline instead of reusing `signal`.
		if (targetId) {
			const closing = whileHeld(handle, () => closeSearchPage(handle, targetId!));
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), closing).catch(() => undefined);
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
