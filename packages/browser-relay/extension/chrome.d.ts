/**
 * Minimal ambient declarations for the Chrome extension APIs the relay
 * extension uses (promise-based MV3 forms only). Declared as a typed const —
 * not namespaces — because `debugger` is a reserved namespace name. Kept
 * local so the package stays dependency-free; extend as the worker grows.
 */

/** Chrome extension event surface (subset). */
interface ChromeEvent<T extends (...args: never[]) => void> {
	addListener(callback: T): void;
	removeListener(callback: T): void;
}

interface ChromeTab {
	id?: number;
	url?: string;
	pendingUrl?: string;
	title?: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	/** -1 when ungrouped. */
	groupId: number;
}

interface ChromeTabChangeInfo {
	url?: string;
	title?: string;
	status?: string;
}

/** Debuggee with the Chrome 125+ flat-session extension. */
interface ChromeDebuggerSession {
	tabId?: number;
	sessionId?: string;
}

interface ChromeDebuggerTargetInfo {
	id: string;
	type: string;
	attached: boolean;
	tabId?: number;
	title?: string;
	url?: string;
}

declare const chrome: {
	tabs: {
		query(queryInfo: { url?: string; groupId?: number }): Promise<ChromeTab[]>;
		get(tabId: number): Promise<ChromeTab>;
		create(createProperties: { url?: string; active?: boolean }): Promise<ChromeTab>;
		remove(tabId: number): Promise<void>;
		update(tabId: number, updateProperties: { active?: boolean }): Promise<ChromeTab>;
		group(options: { tabIds: number[]; groupId?: number }): Promise<number>;
		ungroup(tabIds: number[]): Promise<void>;
		onCreated: ChromeEvent<(tab: ChromeTab) => void>;
		onUpdated: ChromeEvent<(tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void>;
		onRemoved: ChromeEvent<(tabId: number, removeInfo: { windowId: number }) => void>;
	};
	tabGroups: {
		query(queryInfo: { title?: string; windowId?: number }): Promise<Array<{ id: number; windowId: number; title?: string }>>;
		update(groupId: number, updateProperties: { title?: string; color?: string; collapsed?: boolean }): Promise<unknown>;
	};
	windows: {
		update(windowId: number, updateInfo: { focused?: boolean }): Promise<unknown>;
	};
	debugger: {
		attach(target: ChromeDebuggerSession, requiredVersion: string): Promise<void>;
		detach(target: ChromeDebuggerSession): Promise<void>;
		sendCommand(
			target: ChromeDebuggerSession,
			method: string,
			commandParams?: Record<string, unknown>,
		): Promise<Record<string, unknown> | undefined>;
		getTargets(): Promise<ChromeDebuggerTargetInfo[]>;
		onEvent: ChromeEvent<(source: ChromeDebuggerSession, method: string, params?: Record<string, unknown>) => void>;
		onDetach: ChromeEvent<(source: ChromeDebuggerSession, reason: string) => void>;
	};
	storage: {
		local: {
			get(keys: Record<string, unknown>): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		session: {
			get(keys: Record<string, unknown>): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		onChanged: ChromeEvent<(changes: Record<string, unknown>, areaName: string) => void>;
	};
	alarms: {
		create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void;
		onAlarm: ChromeEvent<(alarm: { name: string }) => void>;
	};
	action: {
		setBadgeText(details: { text: string }): Promise<void>;
		setBadgeBackgroundColor(details: { color: string }): Promise<void>;
		onClicked: ChromeEvent<(tab: ChromeTab) => void>;
	};
	runtime: {
		openOptionsPage(): Promise<void>;
		onInstalled: ChromeEvent<() => void>;
		onStartup: ChromeEvent<() => void>;
	};
};
