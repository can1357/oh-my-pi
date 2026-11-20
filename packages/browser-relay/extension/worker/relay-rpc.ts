/**
 * Runs the relay's RPCs against `chrome.debugger`, `chrome.tabs`, tab groups, downloads and the page overlay.
 */
import type { RelayRpcRequest } from "../../../coding-agent/src/tools/browser/relay/protocol";
import { pastForeignFrames } from "../foreign-frames";
import { enqueueGroupOp, groupRelayTabs, isNonEmpty } from "./groups";
import { relayOverlay } from "./overlay-host";
import type { RelayLink } from "./relay";
import { findDownload, relayInitiatedDetachTabs } from "./relay-events";
import { focusTab, removeTab, snapshot } from "./tabs";

/** Run one relay RPC; `origin` is the link epoch it came in on, which alone can carry its answer. */
export async function runRelayRpc(request: RelayRpcRequest, origin: RelayLink): Promise<unknown> {
	switch (request.op) {
		case "attach": {
			const attach = () => chrome.debugger.attach({ tabId: request.tabId }, "1.3");
			await (request.clearForeignFrames ? pastForeignFrames(request.tabId, attach) : attach());
			return {};
		}
		case "detach":
			relayInitiatedDetachTabs.add(request.tabId);
			try {
				await chrome.debugger.detach({ tabId: request.tabId });
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(request.tabId);
				throw error;
			}
		case "send": {
			const send = () =>
				chrome.debugger.sendCommand(
					request.sessionId ? { tabId: request.tabId, sessionId: request.sessionId } : { tabId: request.tabId },
					request.method,
					request.params,
				);
			return await (request.clearForeignFrames ? pastForeignFrames(request.tabId, send) : send());
		}
		case "createTab": {
			const tab = await chrome.tabs.create({ url: request.url, active: request.active ?? true });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			// The relay failed this call when its link ended, so nobody learns this tab's id to close it later.
			if (!origin.open) void removeTab(snap.tabId).catch(() => {});
			return { tab: snap };
		}
		case "removeTab":
			await removeTab(request.tabId);
			return {};
		case "activateTab":
			await focusTab(request.tabId);
			return {};
		case "group":
			return await enqueueGroupOp(() => groupRelayTabs(request.tabIds, request.title, request.color));
		case "ungroup": {
			const { tabIds } = request;
			if (isNonEmpty(tabIds)) await enqueueGroupOp(() => chrome.tabs.ungroup(tabIds).catch(() => {}));
			return {};
		}
		case "findDownload":
			return await findDownload(request.guid);
		case "overlay":
			return await relayOverlay(request.tabId, request.action);
	}
}
