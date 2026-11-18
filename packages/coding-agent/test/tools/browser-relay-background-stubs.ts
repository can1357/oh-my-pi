/**
 * Stubs for the relay extension worker's `chrome` and `WebSocket` globals, installed when this module
 * loads. The probe entry imports it before the worker, so the worker's top level runs against them.
 * `PROBE_DOWNLOADS=1` exposes a `chrome.downloads` API; without it the worker sees none, as in a
 * browser whose permission set predates `downloads`.
 */
type Listener = (...args: unknown[]) => void;

export const probe = {
	listeners: {} as Record<string, Listener[]>,
	sockets: [] as FakeWebSocket[],
	sent: [] as Array<Record<string, unknown>>,
	searchCalls: [] as unknown[],
	downloadItemState: "complete",
};

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

const event = (name: string) => ({
	addListener(callback: Listener): void {
		(probe.listeners[name] ??= []).push(callback);
	},
});

const globals = globalThis as Record<string, unknown>;
// The worker's ping timer would keep the probe process alive; the probe never needs it to fire.
globals.setInterval = () => 0;
globals.clearInterval = () => {};
globals.WebSocket = FakeWebSocket;
globals.chrome = {
	runtime: {
		id: "a".repeat(32),
		reload() {},
		openOptionsPage: async () => {},
		onInstalled: event("runtimeOnInstalled"),
		onStartup: event("runtimeOnStartup"),
	},
	action: {
		onClicked: event("actionClicked"),
		setBadgeText: async () => {},
		setBadgeBackgroundColor: async () => {},
	},
	storage: {
		local: { get: async (defaults: Record<string, unknown>) => ({ ...defaults }), set: async () => {} },
		session: { get: async (defaults: Record<string, unknown>) => ({ ...defaults }), set: async () => {} },
		onChanged: event("storageChanged"),
	},
	alarms: { create() {}, onAlarm: event("alarm") },
	tabs: {
		onCreated: event("tabsCreated"),
		onUpdated: event("tabsUpdated"),
		onActivated: event("tabsActivated"),
		onRemoved: event("tabsRemoved"),
		query: async () => [],
		get: async (id: number) => ({ id }),
	},
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
						return [{ id: 7, filename: "/tmp/report.pdf", state: probe.downloadItemState }];
					},
					onCreated: event("downloadsOnCreated"),
					onChanged: event("downloadsOnChanged"),
				},
			}
		: {}),
};
