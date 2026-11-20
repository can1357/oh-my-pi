/**
 * Tab groups: the relay's per-window omp group (found by title) and the panel's titled conversation groups.
 */

/** Title of the relay's omp tab group; mirrored to session storage so a restarted service worker can still dissolve it. */
let relayGroupTitle: string | null = null;

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not atomic: two concurrent runs both miss the
 * not-yet-titled group and mint duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();

/** Whether `ids` has an element, as `chrome.tabs.group`/`ungroup` require. */
export function isNonEmpty<T>(ids: T[]): ids is [T, ...T[]] {
	return ids.length > 0;
}

/** Run `fn` after every group mutation queued before it. */
export function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}

async function loadRelayGroupTitle(): Promise<string | null> {
	if (relayGroupTitle) return relayGroupTitle;
	// Service worker restarted since the last group op; recover the title.
	const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
	relayGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
	return relayGroupTitle;
}

/** Unpinned tabs among `tabIds`, by window; grouping silently unpins, so pinned tabs are never touched. */
async function groupableByWindow(tabIds: number[]): Promise<Map<number, [number, ...number[]]>> {
	const byWindow = new Map<number, [number, ...number[]]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId);
			if (bucket) bucket.push(tab.id);
			else byWindow.set(tab.windowId, [tab.id]);
		} catch {
			// Tab already closed.
		}
	}
	return byWindow;
}

type GroupColor = `${chrome.tabGroups.Color}`;
const GROUP_COLORS: readonly GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function isGroupColor(color: string): color is GroupColor {
	return GROUP_COLORS.some(known => known === color);
}

/** Move tabs into the per-window relay group, creating or reusing it by title (relay `group` RPC). */
export async function groupRelayTabs(
	tabIds: number[],
	title: string,
	color: string,
): Promise<{ grouped: Record<string, number> }> {
	if (!isGroupColor(color)) throw new Error(`unknown tab group color: ${color}`);
	relayGroupTitle = title;
	void chrome.storage.session.set({ ompGroupTitle: title });
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of await groupableByWindow(tabIds)) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId: number;
		if (existing[0]) {
			groupId = existing[0].id;
			// Heal duplicate same-title groups left behind by older races.
			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map(tab => tab.id).filter(id => id !== undefined);
				if (isNonEmpty(dupeIds)) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}

/** Dissolve every relay-titled group (relay disconnected). */
export async function restoreRelayGroups(): Promise<void> {
	const title = await loadRelayGroupTitle();
	if (!title) return;
	const groups = await chrome.tabGroups.query({ title }).catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map(tab => tab.id).filter(id => id !== undefined);
		if (isNonEmpty(ids)) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

/**
 * Group a panel conversation's tabs under `title`, into `groupId` when given and still open. Never reuses a group by
 * title, and never the relay's omp group: dissolving that one on disconnect would scatter the conversation.
 */
export async function groupPanelTabs(tabIds: number[], title: string, groupId?: number): Promise<{ groupId: number }> {
	const ids = [...(await groupableByWindow(tabIds)).values()].flat();
	if (!isNonEmpty(ids)) throw new Error("no groupable tabs (closed or pinned)");
	const relayTitle = await loadRelayGroupTitle();
	const reuse = groupId === undefined ? null : await chrome.tabGroups.get(groupId).catch(() => null);
	let target: number;
	if (reuse && reuse.title !== relayTitle) {
		target = await chrome.tabs.group({ tabIds: ids, groupId: reuse.id });
	} else {
		const first = await chrome.tabs.get(ids[0]);
		target = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: first.windowId } });
	}
	await chrome.tabGroups.update(target, { title });
	return { groupId: target };
}
