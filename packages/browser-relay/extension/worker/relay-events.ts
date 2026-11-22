/**
 * Streams tab, debugger and download events to the relay, and pairs page download reports with Chrome's items.
 */
import type { FoundDownload } from "../../../coding-agent/src/tools/browser/relay/protocol";
import { DownloadPairing } from "../download-pairing";
import { onForeignFramesHidden } from "../foreign-frames";
import { broadcastRelayEvent } from "./relay";
import { snapshot } from "./tabs";

/** Tabs whose debugger detach the relay asked for, so their `detached` event says so. */
export const relayInitiatedDetachTabs = new Set<number>();

/** Pairs the downloads driven tabs' pages report with Chrome's download items. */
const downloads = new DownloadPairing();

/** Where Chrome saved the download a driven page reported as `guid` (relay `findDownload`). */
export async function findDownload(guid: string): Promise<FoundDownload> {
	// With no downloads API there is nothing to pair against; answer "not found" instead of throwing mid-RPC.
	if (chrome.downloads === undefined) return null;
	const id = downloads.idFor(guid);
	const [item] = id === undefined ? [] : await chrome.downloads.search({ id });
	if (item && item.state !== "in_progress") downloads.forget(guid);
	return item ? { filename: item.filename, state: item.state } : null;
}

/** Register the listeners that forward browser events to the relay. */
export function installRelayEvents(): void {
	// A browser that runs this script without having granted `downloads` exposes no API here (the permission set
	// rides the loaded manifest, the script re-reads from disk); degrade to no download pairing, never to a dead worker.
	chrome.downloads?.onCreated.addListener(item => downloads.created(item.id, item.finalUrl));
	chrome.downloads?.onChanged.addListener(delta => {
		const state = delta.state?.current;
		if (state === "complete" || state === "interrupted") downloads.finished(delta.id, state);
	});

	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (source.tabId === undefined) return;
		if (method === "Page.downloadWillBegin" && typeof params?.guid === "string" && typeof params.url === "string") {
			downloads.report(params.guid, params.url);
		}
		broadcastRelayEvent({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
	});

	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
		broadcastRelayEvent({ t: "detached", tabId: source.tabId, reason, relayInitiated });
	});

	onForeignFramesHidden((tabId, frames) => broadcastRelayEvent({ t: "framesHidden", tabId, frames }));

	chrome.tabs.onCreated.addListener(tab => {
		const snap = snapshot(tab);
		if (snap) broadcastRelayEvent({ t: "tabCreated", tab: snap });
	});

	chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
		const snap = snapshot(tab);
		if (snap) broadcastRelayEvent({ t: "tabUpdated", tab: snap });
	});

	chrome.tabs.onActivated.addListener(({ tabId }) => {
		void chrome.tabs
			.get(tabId)
			.then(tab => {
				const snap = snapshot(tab);
				if (snap) broadcastRelayEvent({ t: "tabUpdated", tab: snap });
			})
			.catch(() => {
				// The tab may have closed before Chrome answered.
			});
	});

	chrome.tabs.onRemoved.addListener(tabId => {
		broadcastRelayEvent({ t: "tabRemoved", tabId });
	});
}
