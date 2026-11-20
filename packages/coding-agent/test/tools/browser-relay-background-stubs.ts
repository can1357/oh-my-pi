/**
 * Stubs for the extension service worker's `chrome` and `WebSocket` globals, installed when this module loads. The
 * probe entry imports it before the worker, so the worker's top level runs against them. `PROBE_DOWNLOADS=1` exposes
 * a `chrome.downloads` API; without it the worker sees none, as in a browser whose permission set predates `downloads`.
 */
type Listener = (...args: never[]) => unknown;

/** A page tab as the stubbed `chrome.tabs` reports it. */
export interface StubTab {
	id: number;
	windowId: number;
	url: string;
	title: string;
	active: boolean;
	pinned: boolean;
	groupId: number;
	width?: number;
	height?: number;
}

/** What the worker did against the stubs, for the probe to report. */
export const probe = {
	listeners: {} as Record<string, Listener[]>,
	sockets: [] as FakeWebSocket[],
	sent: [] as Array<Record<string, unknown>>,
	searchCalls: [] as unknown[],
	/** `chrome.tabs.sendMessage` calls: tab and message. */
	tabMessages: [] as Array<{ tabId: number; message: unknown }>,
	/** `chrome.scripting.executeScript` calls that injected files. */
	injected: [] as Array<{ tabId: number; files: string[] }>,
	tabs: new Map<number, StubTab>(),
	zoom: 1,
};

/** Tabs whose page runs a content script that answers `chrome.tabs.sendMessage`. */
const scripted = new Set<number>();

/** The relay socket the worker dials; the probe opens it and plays the relay. */
export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		probe.sockets.push(this);
	}
	close(): void {
		this.readyState = 3;
	}
	send(data: string): void {
		probe.sent.push(JSON.parse(data));
	}
}

/** A `chrome.runtime.Port` the probe drives as a side panel. */
export class FakePort {
	readonly name: string;
	readonly received: unknown[] = [];
	readonly #messageListeners: Array<(message: unknown) => void> = [];
	readonly onMessage = {
		addListener: (listener: (message: unknown) => void) => this.#messageListeners.push(listener),
	};
	readonly onDisconnect = { addListener: () => {} };
	constructor(name: string) {
		this.name = name;
	}
	postMessage(message: unknown): void {
		this.received.push(message);
	}
	/** Deliver `message` to the worker, as the panel's `postMessage` would. */
	deliver(message: unknown): void {
		for (const listener of this.#messageListeners) listener(message);
	}
}

const event = (name: string) => ({
	addListener(callback: Listener): void {
		(probe.listeners[name] ??= []).push(callback);
	},
	removeListener(): void {},
});

/** `chrome.storage` area over a map, honoring the key shapes `get` accepts. */
function storageArea() {
	const items = new Map<string, unknown>();
	return {
		onChanged: event("storageAreaChanged"),
		async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
			if (keys === undefined || keys === null) return Object.fromEntries(items);
			if (typeof keys === "string") keys = [keys];
			if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => items.has(key)).map(key => [key, items.get(key)]));
			const found: Record<string, unknown> = {};
			for (const key in keys) found[key] = items.has(key) ? items.get(key) : keys[key];
			return found;
		},
		async set(values: Record<string, unknown>): Promise<void> {
			for (const key in values) items.set(key, values[key]);
		},
	};
}

/** The stubbed `chrome.storage.local`, which the probe writes the way the options page would. */
export const stubLocalStorage = storageArea();

function tabFor(id: number): StubTab {
	return (
		probe.tabs.get(id) ?? {
			id,
			windowId: 1,
			url: "https://example.com/",
			title: "Example",
			active: true,
			pinned: false,
			groupId: -1,
		}
	);
}

const globals = globalThis as Record<string, unknown>;
// The worker's ping timer would keep the probe process alive; the probe never needs it to fire.
globals.setInterval = () => 0;
globals.clearInterval = () => {};
globals.WebSocket = FakeWebSocket;
globals.chrome = {
	runtime: {
		id: "a".repeat(32),
		lastError: undefined,
		ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
		reload() {},
		getURL: (path: string) => `chrome-extension://${"a".repeat(32)}/${path}`,
		getContexts: async () => [],
		sendMessage: async () => undefined,
		connectNative: () => {
			throw new Error("Specified native messaging host not found.");
		},
		onInstalled: event("runtimeOnInstalled"),
		onStartup: event("runtimeOnStartup"),
		onConnect: event("runtimeOnConnect"),
		onMessage: event("runtimeOnMessage"),
	},
	action: {
		onClicked: event("actionClicked"),
		setBadgeText: async () => {},
		setBadgeBackgroundColor: async () => {},
	},
	storage: {
		local: stubLocalStorage,
		session: storageArea(),
		onChanged: event("storageChanged"),
	},
	alarms: { create: async () => {}, clear: async () => true, getAll: async () => [], onAlarm: event("alarm") },
	tabs: {
		onCreated: event("tabsCreated"),
		onUpdated: event("tabsUpdated"),
		onActivated: event("tabsActivated"),
		onRemoved: event("tabsRemoved"),
		query: async () => [],
		get: async (id: number) => tabFor(id),
		getZoom: async () => probe.zoom,
		update: async (id: number) => tabFor(id),
		sendMessage: async (tabId: number, message: unknown) => {
			probe.tabMessages.push({ tabId, message });
			if (!scripted.has(tabId)) throw new Error("Could not establish connection. Receiving end does not exist.");
			return true;
		},
	},
	tabGroups: { query: async () => [], get: async () => ({}), update: async () => ({}) },
	windows: { update: async () => ({}), getLastFocused: async () => ({ id: 1 }) },
	scripting: {
		executeScript: async (injection: { target: { tabId: number }; files?: string[] }) => {
			if (injection.files) {
				probe.injected.push({ tabId: injection.target.tabId, files: injection.files });
				scripted.add(injection.target.tabId);
			}
			return [{ frameId: 0, documentId: "doc", result: undefined }];
		},
	},
	sidePanel: { setPanelBehavior: async () => {}, open: async () => {}, close: async () => {} },
	commands: { onCommand: event("commandsOnCommand") },
	notifications: { create: async () => "", clear: async () => true, onClicked: event("notificationsOnClicked") },
	debugger: {
		onEvent: event("debuggerOnEvent"),
		onDetach: event("debuggerOnDetach"),
		getTargets: async () => [],
	},
	...(Bun.env.PROBE_DOWNLOADS === "1"
		? {
				downloads: {
					search: async (query: unknown) => {
						probe.searchCalls.push(query);
						return [{ id: 7, filename: "/tmp/report.pdf", state: "complete" }];
					},
					onCreated: event("downloadsOnCreated"),
					onChanged: event("downloadsOnChanged"),
				},
			}
		: {}),
};
