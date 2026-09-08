import { pathToFileURL } from "node:url";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import type { BrowserHandle } from "./browser/registry";
import type { ScreenshotResult } from "./browser/tab-protocol";
import { ToolAbortError, ToolError } from "./tool-errors";

const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_PAGE_MEMBER_RE = /^(?:p|page[-_]?)(\d+)(?:[-_].*)?\.png$/i;
const PDF_RENDER_TIMEOUT_MS = 30_000;

// Chromium's PDF plugin paints in an out-of-process frame after navigation has
// completed. Wait for document dimensions, then cross compositor boundaries
// before capturing; otherwise the screenshot can contain only the viewer shell.
const PDF_SCREENSHOT_CODE = `
let viewerFrame;
await wait(async () => {
	for (const frame of page.frames()) {
		try {
			const loaded = await frame.evaluate(() => {
				const viewer = document.querySelector("pdf-viewer");
				const toolbar = viewer?.shadowRoot?.querySelector("viewer-toolbar");
				const pageLength = toolbar
					?.shadowRoot?.querySelector("viewer-page-selector")
					?.shadowRoot?.querySelector("#pagelength")
					?.textContent;
				if (Number(pageLength) > 0 && !toolbar?.hasAttribute("loading_")) return true;

				const plugin = document.querySelector('embed[type="application/x-google-chrome-pdf"]');
				const sizer = document.querySelector("#sizer");
				return plugin !== null && sizer !== null && sizer.clientWidth > 0 && sizer.clientHeight > 0;
			});
			if (loaded) {
				viewerFrame = frame;
				return true;
			}
		} catch {}
	}
	return false;
});
await page.screenshot({ type: "png" });
await viewerFrame.evaluate(() => {
	const { promise, resolve } = Promise.withResolvers();
	requestAnimationFrame(() =>
		requestAnimationFrame(() =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		),
	);
	return promise;
});
return await tab.screenshot({ fullPage: true, silent: true });
`;

/** A legacy PDF image-member path interpreted as a page screenshot request. */
export interface PdfImageReadTarget {
	/** PDF path before the member delimiter. */
	pdfPath: string;
	/** Original member text after the delimiter. */
	member: string;
	/** One-indexed page inferred from names such as `p2-img0.png`; defaults to page 1. */
	page: number;
}

/** Parse a former PDF image-member path as a Chromium page screenshot request. */
export function splitPdfImageReadPath(readPath: string): PdfImageReadTarget | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	const pdfPath = match?.[1];
	const member = match?.[2];
	if (!pdfPath || member === undefined) return null;
	const pageText = PDF_PAGE_MEMBER_RE.exec(member)?.[1];
	const parsedPage = pageText === undefined ? 1 : Number(pageText);
	const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
	return { pdfPath, member, page };
}

/** Render one PDF page through the browser capability's shared headless Chromium. */
export async function renderPdfPageScreenshot(
	session: ToolSession,
	absolutePdfPath: string,
	page: number,
	signal?: AbortSignal,
): Promise<ScreenshotResult> {
	const [{ acquireBrowser, holdBrowser, releaseBrowser }, { acquireTab, releaseTab, runInTab }] = await Promise.all([
		import("./browser/registry"),
		import("./browser/tab-supervisor"),
	]);
	// Capture the render deadline start so `acquireTab` counts its
	// worker-init time against this same budget (browser acquisition above
	// already consumed part of it) instead of restarting the clock.
	const deadlineStart = performance.now();
	const timeoutSignal = AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS);
	const renderSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const tabName = `read-pdf-${Bun.randomUUIDv7()}`;
	const url = pathToFileURL(absolutePdfPath);
	url.hash = `page=${page}&toolbar=0&navpanes=0&view=Fit`;

	let browserLease = false;
	let tabOpened = false;
	let browser: BrowserHandle | undefined;
	try {
		const acquiredBrowser = await untilAborted(renderSignal, () =>
			acquireBrowser({ kind: "headless", headless: true }, { cwd: session.cwd, signal: renderSignal }),
		);
		browser = acquiredBrowser;
		holdBrowser(acquiredBrowser);
		browserLease = true;
		await untilAborted(renderSignal, () =>
			acquireTab(tabName, acquiredBrowser, {
				url: url.href,
				waitUntil: "load",
				timeoutMs: PDF_RENDER_TIMEOUT_MS,
				deadlineStartMs: deadlineStart,
				signal: renderSignal,
				ownerSessionId: session.getSessionId?.() ?? undefined,
			}),
		);
		tabOpened = true;
		await releaseBrowser(acquiredBrowser, { kill: false });
		browserLease = false;

		const result = await runInTab(tabName, {
			code: PDF_SCREENSHOT_CODE,
			timeoutMs: PDF_RENDER_TIMEOUT_MS,
			signal: renderSignal,
			session,
		});
		const screenshot = result.screenshots.at(-1);
		if (!screenshot) throw new ToolError(`Chromium did not capture PDF page ${page}.`);
		return screenshot;
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`Timed out rendering PDF page ${page} in Chromium.`);
		}
		throw error;
	} finally {
		if (tabOpened) await releaseTab(tabName, { kill: false });
		if (browserLease && browser) await releaseBrowser(browser, { kill: false });
	}
}
