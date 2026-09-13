/**
 * The per-run navigation seams of the tab worker, extracted so they can be
 * exercised against a fake `Page`/`Browser` without loading the worker's
 * runtime (which connects puppeteer, the DOM helpers, and the native addon).
 *
 * Three gaps in the request-time guard make these necessary:
 *
 *  1. The `browser.run` facade is a get-only proxy: it cannot instrument the
 *     page object it hands out, so `page.goto(privateUrl)` from model code
 *     would cross to CDP with no policy check. {@link createRunPageScope}
 *     patches the raw descriptor for the run and restores it on cleanup.
 *  2. `browser.newPage()` returns an unobserved page. {@link
 *     createRunBrowserScope} patches `newPage` on the RAW browser (before the
 *     facade is built) so every page the model creates gets the observer.
 *  3. A server redirect, `meta refresh`, script navigation or iframe commits a
 *     URL that was never the guard's argument. {@link
 *     attachNavigationObserver} watches `framenavigated` for EVERY frame and
 *     runs the async post-commit recheck (`recheckCommittedNavigation`, which
 *     re-resolves hosts the run never vetted — the DNS-rebinding window).
 *
 * Suppression, not prevention: DNS cannot be pinned over CDP (see the url-guard
 * header), so content may already be in the renderer when the load is stopped.
 * What is guaranteed is that the violating result never reaches the model: the
 * load stops, the page is pulled back to `about:blank`, and the caller records
 * the landed URL so the run's reply is failed instead of answered.
 */

import { withTimeout } from "@oh-my-pi/pi-utils/async";
import type { Browser, Page } from "puppeteer-core";
import { ToolError } from "../tool-errors";

/** Cleanup must settle inside the supervisor's 750ms post-run grace window. */
const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;

/**
 * Thrown when the post-run request-interception reset fails. The tab cannot be
 * reused by the next run (interception is still armed), so the supervisor treats
 * this as a recoverable-by-restart condition rather than a model error.
 */
export class RequestInterceptionCleanupError extends ToolError {}

/** The stop hook for a violating load: Puppeteer has no public `stopLoading`,
 * so the worker injects its CDP `Page.stopLoading` sender. */
export type StopNavigation = () => Promise<void>;

/**
 * Attach the committed-navigation observer to ONE page. Every frame — main
 * frame or child iframe, which is how an embedded document reaches an
 * attacker-chosen host — whose landed URL `check` forbids gets the load stopped
 * and the page pulled back to `about:blank`, reporting through `onViolation` so
 * the run's reply can be failed. `check` is async because it may re-resolve an
 * unvetted hostname (the DNS-rebinding window); answers are memoized by the
 * policy's `resolvedHosts`.
 */
export function attachNavigationObserver(
	page: Page,
	check: (url: string) => Promise<boolean>,
	onViolation: (url: string) => void,
	stop: StopNavigation = async () => undefined,
): void {
	page.on("framenavigated", frame => {
		void (async () => {
			const landed = frame.url();
			// `about:blank` is the initial frame and our own quarantine target.
			if (!landed || landed === "about:blank") return;
			if (!(await check(landed))) return;
			onViolation(landed);
			await stop().catch(() => undefined);
			await page.goto("about:blank", { timeout: 5_000 }).catch(() => undefined);
		})();
	});
}

export interface RunBrowserScope {
	browser: Browser;
	cleanup(): Promise<void>;
}

/**
 * Wrap `browser.newPage` for one run so a page the model creates itself gets
 * the same committed-navigation observer as the tab's own page. Without this,
 * `const p = await browser.newPage(); await p.goto(privateUrl)` in `browser.run`
 * would be entirely unobserved — the observer is bound to the tab page only.
 * Patched on the RAW browser before the run facade is built (the facade is a
 * get-only proxy and cannot instrument returned objects) and restored by
 * `cleanup()`.
 */
export function createRunBrowserScope(browser: Browser, attach: (page: Page) => void): RunBrowserScope {
	const newPageDescriptor = Object.getOwnPropertyDescriptor(browser, "newPage");
	const rawNewPage = (newPageDescriptor?.value ?? browser.newPage) as Browser["newPage"];
	Object.defineProperty(browser, "newPage", {
		configurable: true,
		value: async (...args: Parameters<Browser["newPage"]>) => {
			const page = await Reflect.apply(rawNewPage, browser, args);
			attach(page);
			return page;
		},
	});
	return {
		browser,
		async cleanup() {
			if (newPageDescriptor) Object.defineProperty(browser, "newPage", newPageDescriptor);
			else Reflect.deleteProperty(browser, "newPage");
		},
	};
}

export interface RunPageScope {
	page: Page;
	cleanup(): Promise<void>;
}

/**
 * Expose the tab page while retaining the request handlers created by this run.
 * Puppeteer's Page wraps an internal emitter, so `removeAllListeners("request")`
 * would also remove its forwarding listener; the facade removes only user handlers.
 *
 * `guard` additionally wraps `page.goto`, because the run facade hands the model
 * the page object itself: `page.goto(privateUrl)` otherwise crosses to CDP with
 * no policy check at all (the `tab.goto` op guard covers only the tab helper).
 */
export function createRunPageScope(page: Page, guard?: (url: string) => Promise<void>): RunPageScope {
	const requestHandlers: unknown[] = [];
	const on = page.on;
	const off = page.off;
	const once = page.once;
	const removeAllListeners = page.removeAllListeners;
	const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
	const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
	const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
	const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");
	const gotoDescriptor = Object.getOwnPropertyDescriptor(page, "goto");
	let gotoPatched = false;
	if (guard) {
		const rawGoto = (gotoDescriptor?.value ?? page.goto) as Page["goto"];
		Object.defineProperty(page, "goto", {
			configurable: true,
			value: async (url: string, opts?: Parameters<Page["goto"]>[1]) => {
				await guard(url);
				return Reflect.apply(rawGoto, page, [url, opts]);
			},
		});
		gotoPatched = true;
	}

	Object.defineProperties(page, {
		on: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				Reflect.apply(on, page, [type, handler]);
				if (type === "request") requestHandlers.push(handler);
				return page;
			},
		},
		once: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (type !== "request" || typeof handler !== "function") {
					Reflect.apply(once, page, [type, handler]);
					return page;
				}
				const wrapper = (event: unknown): void => {
					const index = requestHandlers.lastIndexOf(wrapper);
					if (index >= 0) requestHandlers.splice(index, 1);
					Reflect.apply(off, page, ["request", wrapper]);
					Reflect.apply(handler, page, [event]);
				};
				requestHandlers.push(wrapper);
				Reflect.apply(on, page, [type, wrapper]);
				return page;
			},
		},
		off: {
			configurable: true,
			value: (type: unknown, handler?: unknown): Page => {
				Reflect.apply(off, page, [type, handler]);
				if (type === "request") {
					if (handler === undefined) requestHandlers.length = 0;
					else {
						const index = requestHandlers.lastIndexOf(handler);
						if (index >= 0) requestHandlers.splice(index, 1);
					}
				}
				return page;
			},
		},
		removeAllListeners: {
			configurable: true,
			value: (type?: unknown): Page => {
				Reflect.apply(removeAllListeners, page, [type]);
				if (type === undefined || type === "request") requestHandlers.length = 0;
				return page;
			},
		},
	});

	return {
		page,
		async cleanup() {
			if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
			else Reflect.deleteProperty(page, "on");
			if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
			else Reflect.deleteProperty(page, "off");
			if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
			else Reflect.deleteProperty(page, "once");
			if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
			else Reflect.deleteProperty(page, "removeAllListeners");
			if (gotoPatched) {
				if (gotoDescriptor) Object.defineProperty(page, "goto", gotoDescriptor);
				else Reflect.deleteProperty(page, "goto");
			}
			for (const handler of requestHandlers) Reflect.apply(off, page, ["request", handler]);
			requestHandlers.length = 0;
			try {
				await withTimeout(
					page.setRequestInterception(false),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out clearing browser request interception",
				);
			} catch (error) {
				throw new RequestInterceptionCleanupError(
					"Failed to clear browser request interception after browser.run",
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		},
	};
}
