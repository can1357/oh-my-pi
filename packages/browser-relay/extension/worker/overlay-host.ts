/**
 * The worker's side of the page overlay (`overlay.js`, a content script injected on demand): relay `overlay` RPCs
 * and `input` pushes, panel activity (edge, tag, favicon, group pill), and the overlay's Stop/Open/Dismiss events.
 */
import type { OverlayAction, OverlayInput } from "../../../coding-agent/src/tools/browser/relay/protocol";
import type { OverlayCommand, OverlayEvent, PanelEvent, TabActivity } from "../messages";
import { setBusy } from "./relay";
import { SessionValue } from "./session-store";

/** The overlay bundle, relative to the extension root. */
const OVERLAY_SCRIPT = "overlay.js";

/** What a tab's overlay was last told to show. */
interface StoredActivity {
	activity: Exclude<TabActivity, { state: "idle" }>;
	role: "main" | "secondary";
}

/** Tabs the relay mounted the overlay in (its driver's claims). */
const mounted = new SessionValue<number[]>("omp.overlayMounted", () => []);
/** Non-idle activity per tab id. */
const activities = new SessionValue<Record<string, StoredActivity>>("omp.tabActivity", () => ({}));
/** Groups whose secondary-tab pill the user dismissed. */
const dismissedGroups = new SessionValue<number[]>("omp.dismissedGroups", () => []);

/** A reload mid-turn would strand a working tab's tag; tell the relay while any tab is working. */
function reportWorking(stored: Record<string, StoredActivity>): void {
	let working = false;
	for (const tabId in stored) {
		if (stored[tabId]?.activity.state !== "working") continue;
		working = true;
		break;
	}
	setBusy("activity", working);
}

/** Chrome's error for a message to a tab with no overlay listening (never injected, or gone with a navigation). */
function isNoReceiver(error: unknown): boolean {
	return /Receiving end does not exist/.test(String(error));
}

function send<T>(tabId: number, command: OverlayCommand): Promise<T> {
	return chrome.tabs.sendMessage<OverlayCommand, T>(tabId, command, { frameId: 0 });
}

/** Ensure the overlay runs in `tabId`'s top frame and send it `command`; resolves with the overlay's answer. */
export async function overlay<T = unknown>(tabId: number, command: OverlayCommand): Promise<T> {
	try {
		return await send<T>(tabId, command);
	} catch (error) {
		if (!isNoReceiver(error)) throw error;
	}
	// The script is idempotent: a concurrent injection into the same document reuses the first one's host.
	await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [OVERLAY_SCRIPT] });
	return await send<T>(tabId, command);
}

/** Send `command` only where an overlay already runs; `absent` when none does. */
async function overlayIfPresent<T>(tabId: number, command: OverlayCommand, absent: T): Promise<T> {
	try {
		return await send<T>(tabId, command);
	} catch (error) {
		if (isNoReceiver(error)) return absent;
		throw error;
	}
}

/** Answer a relay `overlay` RPC. `hide` settles only after the overlay is invisible on screen. */
export async function relayOverlay(tabId: number, action: OverlayAction): Promise<{}> {
	const tabs = await mounted.get();
	switch (action) {
		case "mount":
			await overlay(tabId, { omp: "overlay", op: "mount" });
			if (!tabs.includes(tabId)) {
				tabs.push(tabId);
				void mounted.save();
			}
			break;
		case "unmount": {
			const index = tabs.indexOf(tabId);
			if (index >= 0) {
				tabs.splice(index, 1);
				void mounted.save();
			}
			await overlayIfPresent(tabId, { omp: "overlay", op: "unmount" }, true);
			break;
		}
		case "hide":
		case "show":
			// Nothing to hide where no overlay runs.
			await overlayIfPresent(tabId, { omp: "overlay", op: action }, true);
			break;
	}
	return {};
}

/** Forward an acknowledged input to the tab's overlay, if the relay mounted one there. */
export function relayInput(tabId: number, input: OverlayInput): void {
	void mounted.get().then(tabs => {
		if (!tabs.includes(tabId)) return;
		void overlay(tabId, { omp: "overlay", op: "input", input }).catch(() => {
			// Drawing is cosmetic; the input already happened.
		});
	});
}

/** Remove every relay-mounted overlay: the relay that drove them is gone. */
export async function unmountAll(): Promise<void> {
	const tabs = await mounted.get();
	const released = tabs.splice(0);
	void mounted.save();
	await Promise.allSettled(released.map(tabId => overlayIfPresent(tabId, { omp: "overlay", op: "unmount" }, true)));
}

/**
 * Show a panel conversation's activity in `tabId` (edge, tag, favicon) and, as the group pill, in the other tabs of
 * its group. Pages no extension may script (chrome://, the Web Store) show nothing: the overlay is decoration.
 */
export async function setActivity(tabId: number, activity: TabActivity): Promise<void> {
	const [stored, dismissed, tab] = await Promise.all([activities.get(), dismissedGroups.get(), chrome.tabs.get(tabId)]);
	const peers =
		tab.groupId === -1
			? []
			: (await chrome.tabs.query({ groupId: tab.groupId })).flatMap(peer =>
					peer.id === undefined || peer.id === tabId ? [] : [peer.id],
				);
	const deliveries: Promise<unknown>[] = [];
	if (activity.state === "idle") {
		delete stored[tabId];
		deliveries.push(overlayIfPresent(tabId, { omp: "overlay", op: "activity", activity, role: "main" }, true));
		for (const peer of peers) {
			if (stored[peer]?.role !== "secondary") continue;
			delete stored[peer];
			deliveries.push(overlayIfPresent(peer, { omp: "overlay", op: "activity", activity, role: "secondary" }, true));
		}
		// The next conversation in this group shows its pill again.
		const index = dismissed.indexOf(tab.groupId);
		if (index >= 0) {
			dismissed.splice(index, 1);
			void dismissedGroups.save();
		}
	} else {
		stored[tabId] = { activity, role: "main" };
		deliveries.push(overlay(tabId, { omp: "overlay", op: "activity", activity, role: "main" }));
		for (const peer of peers) {
			if (stored[peer]?.role === "main") continue;
			stored[peer] = { activity, role: "secondary" };
			if (dismissed.includes(tab.groupId)) continue;
			deliveries.push(overlay(peer, { omp: "overlay", op: "activity", activity, role: "secondary" }));
		}
	}
	void activities.save();
	reportWorking(stored);
	await Promise.allSettled(deliveries);
}

/** A tab finished loading a new document, which lost the overlay: restore what it showed. */
export async function restoreAfterNavigation(tabId: number, groupId: number): Promise<void> {
	const [tabs, stored, dismissed] = await Promise.all([mounted.get(), activities.get(), dismissedGroups.get()]);
	const restores: Promise<unknown>[] = [];
	// Mounting now, not at the next input, keeps the host's insertion out of a click's delivery check.
	if (tabs.includes(tabId)) restores.push(overlay(tabId, { omp: "overlay", op: "mount" }));
	const shown = stored[tabId];
	if (shown && !(shown.role === "secondary" && dismissed.includes(groupId))) {
		restores.push(overlay(tabId, { omp: "overlay", op: "activity", activity: shown.activity, role: shown.role }));
	}
	await Promise.allSettled(restores);
}

/** Forget a closed tab's overlay state. */
export async function forgetTab(tabId: number): Promise<void> {
	const [tabs, stored] = await Promise.all([mounted.get(), activities.get()]);
	const index = tabs.indexOf(tabId);
	if (index >= 0) {
		tabs.splice(index, 1);
		void mounted.save();
	}
	if (stored[tabId]) {
		delete stored[tabId];
		void activities.save();
		reportWorking(stored);
	}
}

/** What the overlay's controls reach in the rest of the worker. */
export interface OverlayEventDeps {
	emit(event: PanelEvent): void;
	/** Whether any side panel is connected to hear a Stop. */
	panelConnected(): boolean;
	/** Stop the worker-owned rpc session working in `tabId` directly; false when none does. */
	abortTab(tabId: number): Promise<boolean>;
}

function isOverlayEvent(message: unknown): message is OverlayEvent {
	return (
		typeof message === "object" &&
		message !== null &&
		"omp" in message &&
		message.omp === "overlay-event" &&
		"op" in message &&
		(message.op === "stop" || message.op === "open" || message.op === "dismiss")
	);
}

/** Handle Stop, Open and Dismiss from page overlays. */
export function installOverlayEvents(deps: OverlayEventDeps): void {
	// Activity stored before a worker restart is still on screen.
	void activities.get().then(reportWorking);
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!isOverlayEvent(message)) return;
		const tab = sender.tab;
		if (tab?.id === undefined || sender.id !== chrome.runtime.id) return;
		const tabId = tab.id;
		switch (message.op) {
			case "open":
				// Called synchronously so the click in the page still counts as the user gesture `open` requires.
				chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
				deps.emit({ event: "overlay", tabId, action: "open" });
				break;
			case "stop": {
				deps.emit({ event: "overlay", tabId, action: "stop" });
				const toPanel = deps.panelConnected();
				void (toPanel ? Promise.resolve(true) : deps.abortTab(tabId))
					.catch(() => false)
					.then(delivered => overlayIfPresent(tabId, { omp: "overlay", op: "stopAck", delivered }, true))
					.catch(() => {});
				break;
			}
			case "dismiss":
				if (tab.groupId !== -1) {
					const groupId = tab.groupId;
					void dismissedGroups.get().then(groups => {
						if (groups.includes(groupId)) return;
						groups.push(groupId);
						void dismissedGroups.save();
					});
				}
				break;
		}
		sendResponse(true);
	});
}
