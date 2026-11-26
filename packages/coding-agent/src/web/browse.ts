import type { ReaderResponse } from "@oh-my-pi/pi-natives";
import { errorMessage, sleepLong, untilAborted } from "@oh-my-pi/pi-utils";
import type { HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport, isPuppeteerTimeout } from "../tools/browser/launch";
import { isNavigatedContextError, readyStateInPage } from "../tools/browser/navigation";
import { withScratchPage } from "../tools/browser/scratch-page";

const DOCUMENT_SETTLE_MS = 2_000;

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

/** Optional navigation, readiness and retry hooks for search providers. */
export interface BrowseHooks {
	homeUrl?: string;
	ready?: { selector: string; timeoutMs: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback?: (page: LoadedHtmlPage) => boolean;
	attempts?: number;
	retryDelayMs?: number;
}

async function settledDocument(
	page: Page,
	signal: AbortSignal,
	pending: () => boolean = () => false,
	revision: () => number = () => 0,
): Promise<Pick<LoadedHtmlPage, "html" | "url">> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(DOCUMENT_SETTLE_MS)]);
	// A challenge form can submit just after DOMContentLoaded. Give it a brief
	// quiet window, but do not let analytics or streaming requests block the read.
	await untilAborted(deadline, () =>
		page.waitForNetworkIdle({ idleTime: 300, timeout: 750, signal: deadline }).catch(error => {
			if (!isPuppeteerTimeout(error)) throw error;
		}),
	);
	for (;;) {
		const url = page.url();
		const epoch = revision();
		if (!pending()) {
			try {
				const state = await untilAborted(deadline, () => page.evaluate(readyStateInPage));
				if (state !== "loading") {
					const html = await untilAborted(deadline, () => page.content());
					if (html.length && !pending() && epoch === revision() && url === page.url()) return { html, url };
				}
			} catch (error) {
				if (!isNavigatedContextError(error)) throw error;
			}
		}
		await sleepLong(50, deadline);
	}
}

async function readNavigatingPage(
	page: Page,
	navigate: () => Promise<HTTPResponse | null>,
	signal: AbortSignal,
): Promise<LoadedHtmlPage> {
	let pending: HTTPRequest | undefined;
	let revision = 0;
	let status: number | undefined;
	const onRequest = (request: HTTPRequest) => {
		if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
			pending = request;
			revision++;
		}
	};
	const onResponse = (response: HTTPResponse) => {
		if (response.request() === pending) status = response.status();
	};
	const onEnd = (request: HTTPRequest) => {
		if (request === pending) pending = undefined;
	};
	page.on("request", onRequest);
	page.on("response", onResponse);
	page.on("requestfinished", onEnd);
	page.on("requestfailed", onEnd);
	try {
		const initial = await navigate();
		const document = await settledDocument(
			page,
			signal,
			() => pending !== undefined,
			() => revision,
		);
		return { ...document, status: status ?? initial?.status() ?? 200 };
	} finally {
		page.off("request", onRequest);
		page.off("response", onResponse);
		page.off("requestfinished", onEnd);
		page.off("requestfailed", onEnd);
	}
}

async function readProviderDocument(page: Page, signal: AbortSignal): Promise<Pick<LoadedHtmlPage, "html" | "url">> {
	const url = page.url();
	try {
		const html = await untilAborted(signal, () => page.content());
		if (html.length && url === page.url()) return { html, url };
	} catch (error) {
		if (!isNavigatedContextError(error)) throw error;
	}
	return settledDocument(page, signal);
}

/** Navigate a fresh headless page and return its rendered DOM as UTF-8 bytes. */
export async function browse(
	url: string,
	signal: AbortSignal,
	timeoutMs = 20_000,
	hooks?: BrowseHooks,
): Promise<ReaderResponse> {
	try {
		const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const page = await withScratchPage(deadline, async (activePage, handle) => {
			// Setup calls use the same CDP session as navigation and can also stall (#8865).
			await untilAborted(deadline, () => applyViewport(activePage));
			await untilAborted(deadline, () => applyStealthPatches(handle.browser, activePage, handle.stealth));
			const navigate = (target: string) =>
				untilAborted(deadline, () =>
					activePage.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
				);
			if (!hooks) return readNavigatingPage(activePage, () => navigate(url), deadline);
			if (hooks.homeUrl) await navigate(hooks.homeUrl);

			const attempts = Math.max(1, hooks.attempts ?? 1);
			const { ready, afterNavigation } = hooks;
			for (let attempt = 0; ; attempt++) {
				if (attempt > 0 && hooks.retryDelayMs) await sleepLong(hooks.retryDelayMs, deadline);
				const response = await navigate(url);
				if (afterNavigation) await untilAborted(deadline, () => afterNavigation(activePage, deadline));
				if (ready) {
					await untilAborted(deadline, () =>
						activePage.waitForSelector(ready.selector, { timeout: ready.timeoutMs }).catch(() => null),
					);
				}
				const loaded = {
					...(await readProviderDocument(activePage, deadline)),
					status: response?.status() ?? 200,
				};
				if (!hooks.shouldFallback?.(loaded) || attempt + 1 >= attempts) return loaded;
			}
		});
		return {
			status: page.status,
			url: page.url,
			headers: [{ name: "content-type", value: "text/html; charset=utf-8" }],
			body: Buffer.from(page.html),
		};
	} catch (error) {
		return { status: 0, url, headers: [], error: errorMessage(error) };
	}
}
