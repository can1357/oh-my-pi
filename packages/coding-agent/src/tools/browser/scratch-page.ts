/**
 * A short-lived page on the project's shared headless Chromium, for work that
 * needs a real browser for one navigation: a web search's fallback, the
 * screenshot of an `<iframe>`. {@link withScratchPage} opens the page, lends
 * it to the caller and closes it whatever happens; meanwhile the page is
 * claimed for the orphan reaper, so a process that dies leaves none behind.
 */
import { getProjectDir, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { browserConnection, privateTargetId } from "./launch";
import {
	closeSharedTargetUntilGone,
	forgetSharedTarget,
	markSharedTargetUnclosed,
	recordSharedTarget,
	retryUnclosedSharedTargets,
} from "./orphan-registry";
import {
	acquireBrowser,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
	sharedTargetScopeOf,
} from "./registry";

/**
 * Upper bound on a scratch page's teardown; a close still unconfirmed by then
 * finishes in the background under its own browser hold. A wedged connection
 * can leave CDP calls pending forever (issue #8865).
 */
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Bound on a scratch page's `Target.createTarget`, overriding the 60 s protocol timeout: a timed-out
 * create still opens its target, with no id to close it by. This bounds a stalled Chromium.
 */
const CREATE_TARGET_TIMEOUT_MS = 5 * 60_000;

/**
 * Run `use` with a fresh page of the shared headless Chromium and close the
 * page afterwards, also when `use` throws or `signal` aborts.
 *
 * Rejects with what `use` rejects with, when the browser cannot be acquired
 * (no Chromium, broker down), or when `signal` aborts before the page opens.
 */
export async function withScratchPage<T>(
	signal: AbortSignal,
	use: (page: Page, handle: PuppeteerBrowserHandle) => Promise<T>,
): Promise<T> {
	const handle = await untilAborted(signal, () =>
		acquireBrowser({ kind: "headless", headless: true }, { cwd: getProjectDir(), signal }),
	);
	if (!("browser" in handle)) {
		await releaseBrowser(handle, { kill: false });
		throw new Error("Headless browser acquisition returned a non-Puppeteer browser");
	}
	const scope = sharedTargetScopeOf(handle);
	// The orphan reaper skips this live process, so retry earlier pages' unconfirmed closes here.
	if (scope) void whileHeld(handle, () => retryUnclosedSharedTargets(handle.browser, scope));

	holdBrowser(handle);
	let targetId: string | undefined;
	try {
		targetId = await createTarget(handle, signal);
		return await use(await openPage(handle, targetId, signal), handle);
	} finally {
		// Teardown must complete even when the caller's signal already fired
		// (a wedged connection leaves CDP calls pending), so bound it with a
		// fresh deadline instead of reusing `signal`.
		if (targetId) {
			const closing = whileHeld(handle, () => closePage(handle, targetId!));
			await untilAborted(AbortSignal.timeout(PAGE_CLOSE_TIMEOUT_MS), closing).catch(() => undefined);
		}
		await releaseBrowser(handle, { kill: false });
	}
}

/** Claim a scratch page so the orphan reaper closes it if this process dies first (issue #10022). */
function recordPage(handle: PuppeteerBrowserHandle, targetId: string): void {
	const scope = sharedTargetScopeOf(handle);
	if (scope) void recordSharedTarget(scope, targetId);
}

/**
 * Close a scratch page by target id and settle its ownership record; never rejects.
 * Not `page.close()`: on a connection that outlives the page's use it can wait forever.
 */
async function closePage(handle: PuppeteerBrowserHandle, targetId: string): Promise<void> {
	const scope = sharedTargetScopeOf(handle);
	if (await closeSharedTargetUntilGone(handle.browser, targetId)) {
		if (scope) void forgetSharedTarget(scope, targetId);
		return;
	}
	if (handle.browser.connected) {
		logger.warn("Could not confirm a scratch browser page was closed; it may still be open", { targetId });
	} else {
		// The page most likely died with the browser; the next scratch page's retry confirms it.
		logger.debug("Lost the browser connection before a scratch browser page close was confirmed", { targetId });
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
 * Create and claim a scratch page's target. Not `newPage()`: it can reject after creating the target,
 * leaving no id to close. An abort does not cancel the create, so a late target is closed under its
 * own hold (unlike `untilAbortedOrReleased`, which cannot hold the browser while it waits), bounded
 * by the create's own timeout.
 */
async function createTarget(handle: PuppeteerBrowserHandle, signal: AbortSignal): Promise<string> {
	// What `newPage()` sends for the default context.
	const created = browserConnection(handle.browser).send(
		"Target.createTarget",
		{ url: "about:blank" },
		{ timeout: CREATE_TARGET_TIMEOUT_MS },
	);
	try {
		const { targetId } = await untilAborted(signal, created);
		recordPage(handle, targetId);
		return targetId;
	} catch (error) {
		if (signal.aborted) {
			void whileHeld(handle, () =>
				created.then(
					({ targetId }) => {
						recordPage(handle, targetId);
						return closePage(handle, targetId);
					},
					error =>
						logger.debug("An abandoned scratch browser page create failed; its target may still be open", {
							error: error instanceof Error ? error.message : String(error),
						}),
				),
			);
		}
		throw error;
	}
}

/** The `Page` of a created target, resolved as `newPage()` does. */
async function openPage(handle: PuppeteerBrowserHandle, targetId: string, signal: AbortSignal): Promise<Page> {
	const target = await untilAborted(signal, () =>
		handle.browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, { signal }),
	);
	const page = await untilAborted(signal, () => target.page());
	if (!page) throw new Error(`Browser target ${targetId} exposed no page`);
	return page;
}
