import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page, WaitForOptions } from "puppeteer-core";

declare module "puppeteer-core" {
	interface Frame {
		/** CDP lifecycle events the frame's current document has reached (`@internal` upstream, stripped from published types). */
		readonly _lifecycleEvents: ReadonlySet<string>;
	}
}

/** Navigation lifecycle accepted by history traversal and reload helpers. */
export type NavigationWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** CDP lifecycle event behind each `waitUntil` that is read from the main frame alone. */
const MAIN_FRAME_LIFECYCLE_EVENTS = { load: "load", domcontentloaded: "DOMContentLoaded" } as const;
/** How often the main-frame wait re-reads the frame's lifecycle events. */
const MAIN_FRAME_POLL_MS = 50;

/** Puppeteer-compatible timeout error; built by name so this module keeps `puppeteer-core` type-only. */
function navigationTimeoutError(timeout: number): Error {
	const error = new Error(`Navigation timeout of ${timeout} ms exceeded`);
	error.name = "TimeoutError";
	return error;
}

interface PageNavigationGlobal {
	next?: { router?: { push?: (target: string) => unknown } };
	history: {
		back(): void;
		forward(): void;
		pushState(data: unknown, unused: string, url: string): void;
		readonly state: unknown;
	};
	location: {
		readonly href: string;
		reload(): void;
	};
	dispatchEvent(event: unknown): boolean;
	Event: new (type: string) => unknown;
	PopStateEvent: new (type: string, init: { state: unknown }) => unknown;
}

/** Invoke `history.back()` inside a browser page. */
export function historyBackInPage(): void {
	(globalThis as unknown as PageNavigationGlobal).history.back();
}

/** Invoke `history.forward()` inside a browser page. */
export function historyForwardInPage(): void {
	(globalThis as unknown as PageNavigationGlobal).history.forward();
}

/** Invoke `location.reload()` inside a browser page. */
export function reloadInPage(): void {
	(globalThis as unknown as PageNavigationGlobal).location.reload();
}

/** Read `location.href` inside a browser page. */
export function locationHrefInPage(): string {
	return (globalThis as unknown as PageNavigationGlobal).location.href;
}

/** Perform Next.js or History API navigation inside a browser page. */
export async function pushStateInPage(destination: string): Promise<string> {
	const root = globalThis as unknown as PageNavigationGlobal;
	const routerPush = root.next?.router?.push;
	if (typeof routerPush === "function") {
		await routerPush.call(root.next?.router, destination);
	} else {
		root.history.pushState({}, "", destination);
		root.dispatchEvent(new root.PopStateEvent("popstate", { state: root.history.state }));
		root.dispatchEvent(new root.Event("navigate"));
	}
	return root.location.href;
}

/**
 * Run `navigate` and wait for the main document to reach `waitUntil`.
 *
 * Puppeteer's `load` and `domcontentloaded` also wait for that event in every child frame
 * that started loading, so one iframe that never finishes (ad, chat widget, challenge) times
 * out a page whose own document is ready. Puppeteer therefore only waits for the commit, and
 * the main frame's lifecycle events, which Puppeteer's own wait reads too, decide the rest.
 * Any other `waitUntil` (`networkidle*`, arrays, invalid values) keeps Puppeteer's own wait,
 * which also validates the value.
 */
export async function navigateMainFrame(
	page: Page,
	waitUntil: NonNullable<WaitForOptions["waitUntil"]>,
	timeout: number,
	signal: AbortSignal | undefined,
	navigate: (options: WaitForOptions) => Promise<unknown>,
): Promise<void> {
	if (waitUntil !== "load" && waitUntil !== "domcontentloaded") {
		await untilAborted(signal, () => navigate({ waitUntil, timeout }));
		return;
	}
	const deadline = Date.now() + timeout;
	await untilAborted(signal, () => navigate({ waitUntil: [], timeout }));
	const event = MAIN_FRAME_LIFECYCLE_EVENTS[waitUntil];
	for (;;) {
		if (page.isClosed() || !page.browser().connected) throw new Error("Navigating frame was detached");
		const frame = page.mainFrame();
		if (frame.detached) throw new Error("Navigating frame was detached");
		if (frame._lifecycleEvents.has(event)) return;
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw navigationTimeoutError(timeout);
		// The last read lands on the deadline, so an event that arrives after it is a timeout.
		await untilAborted(signal, () => Bun.sleep(Math.min(MAIN_FRAME_POLL_MS, remaining)));
	}
}

/** Navigate through session history and return the resulting page URL. */
export async function traverseHistory(
	page: Page,
	direction: "back" | "forward",
	waitUntil: NavigationWaitUntil,
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	const navigate = direction === "back" ? page.goBack.bind(page) : page.goForward.bind(page);
	await navigateMainFrame(page, waitUntil, timeout, signal, navigate);
	return page.url();
}

/** Reload the current document and return the resulting page URL. */
export async function reloadPage(
	page: Page,
	waitUntil: NavigationWaitUntil,
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	await navigateMainFrame(page, waitUntil, timeout, signal, options => page.reload(options));
	return page.url();
}

/** Perform client-side navigation through Next.js when available, otherwise the History API. */
export async function pushState(page: Page, url: string, signal?: AbortSignal): Promise<string> {
	return await untilAborted(signal, () => page.evaluate(pushStateInPage, url));
}
