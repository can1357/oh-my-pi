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

import { FOREIGN_FRAME_REFUSAL } from "../../coding-agent/src/tools/browser/relay/protocol";

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

/**
 * Empty and hide other extensions' frames in every frame of the tab; the count of such frames found, emptied now or
 * by an earlier sweep, so the retries go on while an emptied frame's blank document has yet to commit.
 */
async function neutralizeForeignFrames(tabId: number): Promise<number> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			injectImmediately: true,
			args: [chrome.runtime.id],
			func: (self: string) => {
				let found = 0;
				const visit = (root: ChromePageRoot) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
					for (let element = walker.nextNode(); element; element = walker.nextNode()) {
						const tag = element.tagName.toUpperCase();
						if (tag === "IFRAME" || tag === "FRAME") {
							const src = element.getAttribute("src") ?? "";
							if (src.startsWith("chrome-extension://") && !src.startsWith(`chrome-extension://${self}/`)) {
								// `srcdoc` outranks `src`; a `<frame>` has no `srcdoc`. Setting `srcdoc` again would
								// reload the frame and delay the blank document the retry waits for.
								if (tag === "FRAME") element.setAttribute("src", "about:blank");
								else if (element.getAttribute("srcdoc") === null) element.setAttribute("srcdoc", "");
								element.style.setProperty("display", "none", "important");
								found++;
							}
						}
						const shadow = chrome.dom.openOrClosedShadowRoot(element);
						if (shadow) visit(shadow);
					}
				};
				visit(document);
				return found;
			},
		});
		return results.reduce((total, frame) => total + (frame.result ?? 0), 0);
	} catch {
		// A page no extension may script (the Web Store, another extension's page).
		return 0;
	}
}
