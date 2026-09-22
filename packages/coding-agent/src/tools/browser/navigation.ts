import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";

/** Navigation lifecycle accepted by history traversal and reload helpers. */
export type NavigationWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

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

/** Navigate through session history and return the resulting page URL. */
export async function traverseHistory(
	page: Page,
	direction: "back" | "forward",
	waitUntil: NavigationWaitUntil,
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	const navigate = direction === "back" ? page.goBack.bind(page) : page.goForward.bind(page);
	await untilAborted(signal, () =>
		navigate({
			waitUntil,
			timeout,
		}),
	);
	return page.url();
}

/** Reload the current document and return the resulting page URL. */
export async function reloadPage(
	page: Page,
	waitUntil: NavigationWaitUntil,
	timeout: number,
	signal?: AbortSignal,
): Promise<string> {
	await untilAborted(signal, () => page.reload({ waitUntil, timeout }));
	return page.url();
}

/** Perform client-side navigation through Next.js when available, otherwise the History API. */
export async function pushState(page: Page, url: string, signal?: AbortSignal): Promise<string> {
	return await untilAborted(signal, () => page.evaluate(pushStateInPage, url));
}
