/**
 * Tab helpers shared by the relay RPCs and the panel: wire snapshots, panel tab contexts, and tab closing/focusing.
 */
import type { TabSnapshot } from "../../../coding-agent/src/tools/browser/relay/protocol";
import type { Size, TabContext } from "../messages";
import { pageTargetId } from "./identity";

const REMOVE_TAB_ATTEMPTS = 3;
const REMOVE_TAB_RETRY_MS = 500;

/** The relay's view of a Chrome tab; null for a tab without an id (devtools windows). */
export function snapshot(tab: chrome.tabs.Tab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		discarded: tab.discarded === true,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/** The panel's view of a Chrome tab, with the relay target id the agent opens it by. */
export async function contextOf(tab: chrome.tabs.Tab & { id: number }): Promise<TabContext> {
	return {
		tabId: tab.id,
		windowId: tab.windowId,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
		groupId: tab.groupId,
		targetId: await pageTargetId(tab.id),
		viewport: await viewportOf(tab),
	};
}

/** The page viewport in CSS pixels: the tab's size over its zoom factor; null when Chrome reports no size. */
async function viewportOf(tab: chrome.tabs.Tab & { id: number }): Promise<Size | null> {
	if (!tab.width || !tab.height) return null;
	const zoom = await chrome.tabs.getZoom(tab.id).catch(() => 1);
	const factor = zoom > 0 ? zoom : 1;
	return { width: Math.round(tab.width / factor), height: Math.round(tab.height / factor) };
}

/** {@link contextOf} for a tab id. */
export async function tabContext(tabId: number): Promise<TabContext> {
	const tab = await chrome.tabs.get(tabId);
	return await contextOf({ ...tab, id: tabId });
}

/** Chrome can refuse a tab close for a moment (a tab being dragged, an unload in progress); try again before failing. */
export async function removeTab(tabId: number): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await chrome.tabs.remove(tabId);
			return;
		} catch (error) {
			// Already closed: the close the relay asked for has happened.
			if (/No tab with id/.test(String(error))) return;
			if (attempt >= REMOVE_TAB_ATTEMPTS) throw error;
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, REMOVE_TAB_RETRY_MS);
			await pause.promise;
		}
	}
}

/** Bring `tabId` to the front: focus its window and select it. */
export async function focusTab(tabId: number): Promise<void> {
	const tab = await chrome.tabs.get(tabId);
	await chrome.windows.update(tab.windowId, { focused: true });
	await chrome.tabs.update(tabId, { active: true });
}
