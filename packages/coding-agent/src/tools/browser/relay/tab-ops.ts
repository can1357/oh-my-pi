/**
 * Tab-lifecycle policy for relay-driven tabs.
 *
 * Runs inside the Chrome extension against `chrome.tabs`, but lives here
 * beside `protocol.ts` (which the extension also imports) because the
 * extension package has no test surface: CI's buckets never load it, so
 * policy that must not silently regress belongs on this side of the wire.
 *
 * One rule: driving a tab must not move the user. Chrome's defaults do the
 * opposite, so both helpers exist to override a default.
 */

/** The `chrome.tabs` subset this policy touches; injected so it is testable without a browser. */
export interface RelayTabsApi<TTab> {
	create(createProperties: { url?: string; active?: boolean }): Promise<TTab>;
	update(tabId: number, updateProperties: { active?: boolean }): Promise<unknown>;
}

/**
 * Open a relay-driven tab in the background. `chrome.tabs.create` foregrounds
 * the new tab by default, which pulls the user off whatever they were reading.
 */
export function createRelayTab<TTab>(tabs: RelayTabsApi<TTab>, url: string): Promise<TTab> {
	return tabs.create({ url, active: false });
}

/**
 * Make a tab the active one in ITS OWN window, without raising that window.
 *
 * Activation is what the compositor-surface screenshot path needs: CDP
 * `Page.captureScreenshot` reads the surface, which follows the active target.
 * Raising the window is not needed for pixels and is what actually disrupts
 * the user: `chrome.windows.update({ focused: true })` (and CDP
 * `Page.bringToFront`, which Chrome implements by activating the tab's
 * window) take OS focus away from whatever they are typing in.
 * `chrome.tabs.update({ active: true })` documents that it does not affect
 * window focus, so it is the whole activation the relay performs.
 */
export async function activateRelayTab(tabs: RelayTabsApi<unknown>, tabId: number): Promise<void> {
	await tabs.update(tabId, { active: true });
}
