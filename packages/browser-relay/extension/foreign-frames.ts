/// <reference path="./chrome.d.ts" />
/**
 * While any frame of a tab, cross-site ones included, shows another extension's page, Chrome refuses this
 * extension's debugger there: `attach` and every `sendCommand` fail with "Cannot access a chrome-extension:// URL
 * of different extension". Password managers draw their inline autofill menus as such frames on a focused field.
 * Chrome checks before running the request, so a refused one is retried once every such frame is pointed at an
 * empty document (`srcdoc` outranks `src`, so a vendor that re-points the same frame later loads nothing) and
 * hidden: an inline menu sits over the controls below its field, and emptied it would cover them as a blank box.
 * The relay asks for this only in a tab omp drives, so the user's other tabs keep their menus.
 */

import { FOREIGN_FRAME_REFUSAL, type HiddenFrame } from "../../coding-agent/src/tools/browser/relay/protocol";

/** Waits before each retry: the emptied frames have to commit their blank document first. */
const RETRY_DELAYS_MS = [50, 100, 200, 400];
/** The sweep in flight per tab, which the refused commands of one burst share. */
const sweeps = new Map<number, Promise<number>>();

// Page globals of the function injected below, which runs in the tab's frames, not in this worker.
declare const document: ChromePageRoot & {
	createTreeWalker(root: ChromePageRoot, whatToShow: number): { nextNode(): ChromePageElement | null };
};
declare const NodeFilter: { readonly SHOW_ELEMENT: number };

/** Run a `chrome.debugger` request on `tabId`, emptying other extensions' frames whenever Chrome refuses it for one. */
export async function pastForeignFrames<T>(tabId: number, request: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await request();
		} catch (error) {
			// A vendor may re-show its menu meanwhile, so every refusal sweeps again.
			if (
				attempt === RETRY_DELAYS_MS.length ||
				!FOREIGN_FRAME_REFUSAL.test(String(error)) ||
				(await sweep(tabId)) === 0
			)
				throw error;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
		await promise;
	}
}

function sweep(tabId: number): Promise<number> {
	let pending = sweeps.get(tabId);
	if (!pending) {
		pending = neutralizeForeignFrames(tabId).finally(() => sweeps.delete(tabId));
		sweeps.set(tabId, pending);
	}
	return pending;
}

/** Receives the frames each sweep emptied; the relay tells the agent driving the tab what was hidden. */
let reportHidden: (tabId: number, frames: HiddenFrame[]) => void = () => {};

export function onForeignFramesHidden(report: (tabId: number, frames: HiddenFrame[]) => void): void {
	reportHidden = report;
}

/** Longest page path reported; the `src` is the page's to write. */
const MAX_PATH_LENGTH = 100;
/** Longest page title reported; the title is the other extension's to write. */
const MAX_TITLE_LENGTH = 60;
/** How long a frame's page may take to load for the report. */
const PROBE_TIMEOUT_MS = 500;

/**
 * Report what a sweep emptied, off the sweep's path: the retry and the attach or command waiting on it go on at once,
 * and the relay holds the report for the worker driving the tab, whenever it arrives.
 *
 * Each emptied frame is reported as its extension's id, the page it showed and that page's own title. A frame `src`
 * is page-authored, so a frame is reported only when the document it sits in can load that URL itself: only an
 * installed extension's page that it exposes to the site loads, and no other could have been drawn there. The id and
 * path come from the URL that loaded, never the `src` (`/../` would carry page text). Each is reported once. Pages
 * served under `use_dynamic_url`, frames in sandboxed documents, and frames whose document is gone before its probe
 * runs go unreported.
 */
async function reportEmptied(tabId: number, srcsByFrame: Map<number, string[]>): Promise<void> {
	const probes = await Promise.allSettled(
		Array.from(srcsByFrame, ([frameId, srcs]) =>
			chrome.scripting.executeScript({
				target: { tabId, frameIds: [frameId] },
				// The extension's own world: the page's `fetch` and service worker would answer in its own.
				world: "ISOLATED",
				// A document still parsing (a page that streams forever) would otherwise hold the injection.
				injectImmediately: true,
				args: [srcs, PROBE_TIMEOUT_MS],
				func: async (urls: string[], timeoutMs: number) =>
					await Promise.all(
						urls.map(async url => {
							try {
								const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
								if (!response.ok) return null;
								const title = /<title[^>]*>([^<]*)<\/title>/i.exec(await response.text())?.[1]?.trim();
								return { url: response.url, title };
							} catch {
								return null;
							}
						}),
					),
			}),
		),
	);
	const frames = new Map<string, HiddenFrame>();
	for (const probe of probes) {
		if (probe.status === "rejected") continue;
		for (const loaded of probe.value.flatMap(({ result }) => result ?? [])) {
			if (!loaded?.url.startsWith("chrome-extension://")) continue;
			const { host: extensionId, pathname } = new URL(loaded.url);
			// The relay's own pages load in its own world without being exposed; it never hides them.
			if (!/^[a-p]{32}$/.test(extensionId) || extensionId === chrome.runtime.id) continue;
			const path = pathname.slice(1, 1 + MAX_PATH_LENGTH);
			const title = loaded.title?.slice(0, MAX_TITLE_LENGTH);
			frames.set(`${extensionId}/${path}`, { extensionId, path, ...(title ? { title } : {}) });
		}
	}
	if (frames.size > 0) reportHidden(tabId, [...frames.values()]);
}

/**
 * Empty and hide other extensions' frames in every frame of the tab; the count of such frames found, emptied now or
 * by an earlier sweep, so the retries go on while an emptied frame's blank document has yet to commit. The frames
 * emptied now are reported (`onForeignFramesHidden`).
 */
async function neutralizeForeignFrames(tabId: number): Promise<number> {
	let results: Array<ChromeInjectionResult<{ found: number; emptied: string[] }>>;
	try {
		results = await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			injectImmediately: true,
			args: [chrome.runtime.id],
			func: (self: string) => {
				const swept = { found: 0, emptied: [] as string[] };
				const visit = (root: ChromePageRoot) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
					for (let element = walker.nextNode(); element; element = walker.nextNode()) {
						const tag = element.tagName.toUpperCase();
						if (tag === "IFRAME" || tag === "FRAME") {
							const src = element.getAttribute("src") ?? "";
							if (src.startsWith("chrome-extension://") && !src.startsWith(`chrome-extension://${self}/`)) {
								// `srcdoc` outranks `src`; a `<frame>` has no `srcdoc`. Setting `srcdoc` again would
								// reload the frame and delay the blank document the retry waits for.
								if (tag === "FRAME") {
									element.setAttribute("src", "about:blank");
									swept.emptied.push(src);
								} else if (element.getAttribute("srcdoc") === null) {
									element.setAttribute("srcdoc", "");
									swept.emptied.push(src);
								}
								element.style.setProperty("display", "none", "important");
								swept.found++;
							}
						}
						const shadow = chrome.dom.openOrClosedShadowRoot(element);
						if (shadow) visit(shadow);
					}
				};
				visit(document);
				return swept;
			},
		});
	} catch {
		// A page no extension may script (the Web Store, another extension's page).
		return 0;
	}
	let found = 0;
	const srcsByFrame = new Map<number, string[]>();
	for (const { frameId, result } of results) {
		found += result?.found ?? 0;
		if (result && result.emptied.length > 0) srcsByFrame.set(frameId, result.emptied);
	}
	// A report that fails is dropped; the sweep never waits on it.
	if (srcsByFrame.size > 0) void reportEmptied(tabId, srcsByFrame).catch(() => {});
	return found;
}
