/**
 * omp — MV3 service worker.
 *
 * Wires the extension's parts together: the relay link through the native host (`worker/relay.ts`) whose RPCs drive
 * tabs through `chrome.debugger`, the page overlay host, the side panel hub and its request handlers, the
 * worker-owned rpc sessions behind the native host, and the feature modules (schedules, Teach, GIF export). CDP
 * orchestration stays in the relay server; this worker executes its RPCs and streams tab and debugger events back.
 */
import type { WorkerContext } from "./messages";
import { captureVisible } from "./worker/capture";
import { installGifExport } from "./worker/gif";
import { restoreRelayGroups } from "./worker/groups";
import {
	forgetTab,
	installOverlayEvents,
	overlay,
	relayInput,
	restoreAfterNavigation,
	setActivity,
	unmountAll,
} from "./worker/overlay-host";
import { activeTabContext, installPanelHandlers } from "./worker/panel-handlers";
import { PanelHub } from "./worker/panel-hub";
import { connectRelay, relayStatus, setBusy, setRelayHandlers } from "./worker/relay";
import { installRelayEvents } from "./worker/relay-events";
import { runRelayRpc } from "./worker/relay-rpc";
import { RPC_ABORT_LINE, RpcSessions } from "./worker/rpc-sessions";
import { installSchedules } from "./worker/schedules";
import { installSidePanel } from "./worker/side-panel";
import { tabContext } from "./worker/tabs";
import { installTeach } from "./worker/teach";

const hub = new PanelHub((port, windowId) => {
	hub.emitTo(port, { event: "relay", status: relayStatus() });
	void activeTabContext(windowId).then(tab => hub.emitTo(port, { event: "activeTab", windowId, tab }));
});

const rpcSessions = new RpcSessions(
	sessions => {
		setBusy("rpc", sessions.some(session => !session.exited));
		hub.emit({ event: "rpcSessions", sessions });
	},
	(sessionKey, line) => hub.emit({ event: "rpcLine", sessionKey, line }),
);

const ctx: WorkerContext = {
	emit: event => hub.emit(event),
	handle(op, handler) {
		hub.handle(op, handler);
	},
	tabContext,
	captureVisible,
	overlay,
	openRpcSession: options => rpcSessions.open(options),
	sendRpc: (sessionKey, line) => rpcSessions.send(sessionKey, line),
	onRpcLine: listener => rpcSessions.onLine(listener),
	setActivity,
	setBusy,
};

setRelayHandlers({
	rpc: runRelayRpc,
	input: relayInput,
	status: status => hub.emit({ event: "relay", status }),
	disconnected: () => {
		void restoreRelayGroups();
		void unmountAll();
	},
});
installRelayEvents();
installPanelHandlers(ctx, rpcSessions);
installOverlayEvents({
	emit: event => hub.emit(event),
	panelConnected: () => hub.connected,
	abortTab: async tabId => {
		const session = await rpcSessions.forTab(tabId);
		if (!session) return false;
		rpcSessions.send(session.sessionKey, RPC_ABORT_LINE);
		return true;
	},
});
installSidePanel(windowId => hub.hasPanel(windowId));
installSchedules(ctx);
installTeach(ctx);
installGifExport(ctx);

chrome.runtime.onConnect.addListener(port => hub.accept(port));

// ---- panel tab tracking -----------------------------------------------------------

function emitActiveTab(tabId: number, windowId: number): void {
	if (!hub.hasPanel(windowId)) return;
	void tabContext(tabId)
		.then(tab => hub.emit({ event: "activeTab", windowId, tab }))
		.catch(() => {
			// The tab closed before Chrome answered.
		});
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => emitActiveTab(tabId, windowId));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (change.status === "complete") void restoreAfterNavigation(tabId, tab.groupId);
	const visible =
		change.url !== undefined ||
		change.title !== undefined ||
		change.favIconUrl !== undefined ||
		change.groupId !== undefined ||
		change.status === "complete";
	if (tab.active && visible) emitActiveTab(tabId, tab.windowId);
});

chrome.tabs.onRemoved.addListener(tabId => void forgetTab(tabId));

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	// Revives a reaped worker and reconnects a lost native port; a no-op while the port is open.
	if (alarm.name === "omp-relay-keepalive") connectRelay();
});

connectRelay();
