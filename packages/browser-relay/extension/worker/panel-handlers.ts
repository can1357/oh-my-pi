/**
 * The worker's own panel request handlers: relay status and calls, tabs, captures, activity, groups and rpc sessions.
 * Feature modules (schedules, Teach, GIF export) register theirs through the same {@link WorkerContext}.
 */
import type { PanelCollabHost, PanelInstall } from "../../../coding-agent/src/tools/browser/relay/protocol";
import type { TabContext, WorkerContext } from "../messages";
import { captureTab } from "./capture";
import { enqueueGroupOp, groupPanelTabs } from "./groups";
import { callRelay, relayStatus } from "./relay";
import type { RpcSessions } from "./rpc-sessions";
import { contextOf, focusTab, tabContext } from "./tabs";

function hasString<K extends string>(value: unknown, key: K): value is Record<K, string> {
	return typeof value === "object" && value !== null && key in value && typeof Reflect.get(value, key) === "string";
}

function isCollabHosts(value: unknown): value is PanelCollabHost[] {
	return Array.isArray(value) && value.every(host => hasString(host, "instanceId") && hasString(host, "cwd"));
}

function isInstalls(value: unknown): value is PanelInstall[] {
	return Array.isArray(value) && value.every(install => hasString(install, "dir"));
}

/** The panel context of `windowId`'s active tab; null when the window has none (or is gone). */
export async function activeTabContext(windowId: number): Promise<TabContext | null> {
	const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
	return tab?.id === undefined ? null : await contextOf({ ...tab, id: tab.id });
}

/** Register the worker's panel request handlers on `ctx`. */
export function installPanelHandlers(ctx: WorkerContext, rpcSessions: RpcSessions): void {
	ctx.handle("relayStatus", async () => relayStatus());
	ctx.handle("collabHosts", async () => {
		const hosts = await callRelay({ op: "collabHosts" });
		if (!isCollabHosts(hosts)) throw new Error("omp relay answered collabHosts with an unexpected shape");
		return hosts;
	});
	ctx.handle("collabLink", async ({ instanceId }) => {
		const link = await callRelay({ op: "collabLink", instanceId });
		if (!hasString(link, "url")) throw new Error("omp relay answered collabLink without a url");
		return { url: link.url };
	});
	ctx.handle("installs", async () => {
		const installs = await callRelay({ op: "installs" });
		if (!isInstalls(installs)) throw new Error("omp relay answered installs with an unexpected shape");
		return installs;
	});
	ctx.handle("activeTab", ({ windowId }) => activeTabContext(windowId));
	ctx.handle("tabContext", ({ tabId }) => tabContext(tabId));
	ctx.handle("capture", ({ tabId, mode }) => captureTab(tabId, mode));
	ctx.handle("cancelCapture", async ({ tabId }) => {
		// No overlay listening means no pick is running.
		await chrome.tabs.sendMessage(tabId, { omp: "overlay", op: "cancelPick" }, { frameId: 0 }).catch(() => {});
	});
	ctx.handle("setActivity", ({ tabId, activity }) => ctx.setActivity(tabId, activity));
	ctx.handle("focusTab", ({ tabId }) => focusTab(tabId));
	ctx.handle("groupTabs", ({ tabIds, title, groupId }) => enqueueGroupOp(() => groupPanelTabs(tabIds, title, groupId)));
	ctx.handle("rpcOpen", ({ cwd, title, tabIds }) => rpcSessions.open({ cwd, title, tabIds }));
	ctx.handle("rpcSend", async ({ sessionKey, line }) => rpcSessions.send(sessionKey, line));
	ctx.handle("rpcClose", ({ sessionKey }) => rpcSessions.close(sessionKey));
	ctx.handle("rpcSessions", () => rpcSessions.list());
}
