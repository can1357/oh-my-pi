/**
 * One screenshot of a web page, for an `<iframe>` in an assistant reply: a
 * terminal cannot embed a live page, so the transcript shows this still over
 * a link to the page.
 */
import { untilAborted } from "@oh-my-pi/pi-utils";
import { applyStealthPatches, applyViewport, chromiumNeedsDownload, isPuppeteerTimeout } from "./launch";
import { withScratchPage } from "./scratch-page";

/** Longest the page may take to go quiet; one still busy then is captured as it stands. */
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * A PNG of the first screenful of `url` (http(s) or `file:`), taken in the
 * shared headless Chromium at its default viewport.
 *
 * Rejects when no Chromium is installed (a still is not worth a browser
 * download), the browser cannot be reached, the navigation fails, or
 * `signal` aborts.
 */
export async function capturePage(url: string, signal: AbortSignal): Promise<Uint8Array> {
	if (await chromiumNeedsDownload()) throw new Error("no Chromium installed");
	return withScratchPage(signal, async (page, handle) => {
		await untilAborted(signal, () => applyViewport(page));
		await untilAborted(signal, () => applyStealthPatches(handle.browser, page, handle.stealth));
		try {
			await untilAborted(signal, () => page.goto(url, { waitUntil: "networkidle2", timeout: SETTLE_TIMEOUT_MS }));
		} catch (error) {
			// A page that polls or streams never goes quiet.
			if (!isPuppeteerTimeout(error)) throw error;
		}
		return await untilAborted(signal, () => page.screenshot({ type: "png" }));
	});
}
