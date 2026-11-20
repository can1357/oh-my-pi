/**
 * The worker's websocket to the omp relay (`ws://127.0.0.1:<port>/ext`): dialing and re-dialing, the hello, RPC
 * dispatch, `input` pushes, and extension → relay calls.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the worker alive while connected (Chrome
 * 116+); a chrome.alarms tick revives it and re-dials after Chrome reaps it while disconnected.
 */
import {
	DOWNLOADS_PROTOCOL_VERSION,
	EXTENSION_RELOAD_PROTOCOL_VERSION,
	type ExtToRelayMessage,
	OVERLAY_PROTOCOL_VERSION,
	type OverlayInput,
	PANEL_PROTOCOL_VERSION,
	type PanelCall,
	type RelayRpcRequest,
	type RelayToExtMessage,
	type TabSnapshot,
} from "../../../coding-agent/src/tools/browser/relay/protocol";
import { ownedDebuggerTabs } from "../debugger-ownership";
import type { RelayStatus } from "../messages";
import { RelayCalls } from "./calls";
import { ensureBrowserSession, ensureInstanceId } from "./identity";
import { snapshot } from "./tabs";

/**
 * The omp version that installed this script, declared by the line the installer puts above it
 * (`stampRelayExtensionScript`); undeclared in an unstamped build. Read from the script, not the manifest:
 * after the files change, a Chrome restart re-reads manifest.json but keeps running the old service worker.
 */
declare const OMP_INSTALL_VERSION: string | undefined;
/** The extension build this script belongs to, declared beside `OMP_INSTALL_VERSION`; undeclared when unstamped. */
declare const OMP_INSTALL_BUILD: string | undefined;

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/** What the relay connection hands to the rest of the worker. */
export interface RelayHandlers {
	/** Run one RPC; `origin` is the socket it came in on, which alone can carry its answer. */
	rpc(request: RelayRpcRequest, origin: WebSocket): Promise<unknown>;
	/** An acknowledged input for a tab's overlay. */
	input(tabId: number, input: OverlayInput): void;
	/** The socket opened or closed. */
	status(status: RelayStatus): void;
	/** The socket closed; the relay released everything it drove. */
	disconnected(): void;
}

interface RelaySettings {
	port: number;
	token: string;
}

let handlers: RelayHandlers | null = null;
let ws: WebSocket | null = null;
/** Calls in flight on `ws`. */
let calls = new RelayCalls();
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
let settings: RelaySettings = { port: DEFAULT_PORT, token: "" };
/** Reasons the worker is doing work an extension reload would destroy. */
const busyReasons = new Set<string>();

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({
		port: DEFAULT_PORT,
		token: "",
	});
	const port = Number(stored.port);
	settings = {
		port:
			Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
	return settings;
}

/**
 * Whether a `chrome.storage.onChanged` batch changed the relay connection settings. Only `port` and `token` in
 * `local` do: the worker's own identity writes, panel drafts and settings must never drop the socket.
 */
export function relaySettingsChanged(
	changes: Record<string, unknown>,
	areaName: string,
): boolean {
	return areaName === "local" && ("port" in changes || "token" in changes);
}

/** Send `message` to the relay; false when no socket is open. */
export function post(message: ExtToRelayMessage): boolean {
	if (ws?.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(message));
	return true;
}

/**
 * Mark work under `reason` that an extension reload would destroy, or clear it; the relay hears every change of
 * whether any reason holds, so it defers self-update reloads meanwhile.
 */
export function setBusy(reason: string, busy: boolean): void {
	const before = busyReasons.size > 0;
	if (busy) busyReasons.add(reason);
	else busyReasons.delete(reason);
	const after = busyReasons.size > 0;
	if (after !== before) post({ t: "busy", busy: after });
}

/** Ask the relay for something the side panel needs; rejects when the socket closes or the relay takes too long. */
export function callRelay(call: PanelCall): Promise<unknown> {
	return calls.start(call, post);
}

/** The relay connection as the panel shows it. */
export function relayStatus(): RelayStatus {
	return {
		connected: ws?.readyState === WebSocket.OPEN,
		port: settings.port,
		extensionVersion:
			typeof OMP_INSTALL_VERSION === "string" ? OMP_INSTALL_VERSION : undefined,
	};
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({
			color: connected ? "#1a7f37" : "#8b8b8b",
		});
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const [tabs, targets] = await Promise.all([
		chrome.tabs.query({}),
		chrome.debugger.getTargets(),
	]);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	// `attached` is true for DevTools or another extension too; only our own attachment answers a command.
	const attachedTabIds = await ownedDebuggerTabs(targets, (tabId) =>
		chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"),
	);
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		instanceId: await ensureInstanceId(),
		browserSession: await ensureBrowserSession(),
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		discardedTabsProtocol: 1, // Keep in sync with the relay protocol version.
		ompVersion:
			typeof OMP_INSTALL_VERSION === "string" ? OMP_INSTALL_VERSION : undefined,
		ompBuild:
			typeof OMP_INSTALL_BUILD === "string" ? OMP_INSTALL_BUILD : undefined,
		reloadProtocol: EXTENSION_RELOAD_PROTOCOL_VERSION,
		// A degraded worker (no downloads API) omits the capability, so the relay answers lookups with
		// the actionable "predates download tracking" error instead of a generic not-found.
		downloadsProtocol:
			chrome.downloads === undefined ? undefined : DOWNLOADS_PROTOCOL_VERSION,
		overlayProtocol: OVERLAY_PROTOCOL_VERSION,
		panelProtocol: PANEL_PROTOCOL_VERSION,
		tabs: snapshots,
		attachedTabIds,
	};
}

function handleRelayMessage(
	socket: WebSocket,
	socketCalls: RelayCalls,
	raw: string,
): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	switch (msg.t) {
		case "pong":
			return;
		case "reload":
			// The relay rewrote this extension's files; reloading re-reads them (a Chrome restart would not).
			chrome.runtime.reload();
			return;
		case "input":
			handlers?.input(msg.tabId, msg.input);
			return;
		case "callResult":
			socketCalls.settle(msg);
			return;
		case "rpc": {
			// Answer only on the socket the RPC came in on: RPC ids are local to that connection, and the relay
			// already failed the call when it closed.
			const answer = (reply: ExtToRelayMessage): void => {
				if (socket.readyState === WebSocket.OPEN)
					socket.send(JSON.stringify(reply));
			};
			const { id } = msg;
			const run = handlers
				? handlers.rpc(msg, socket)
				: Promise.reject(new Error("worker not ready"));
			void run
				.then((result) => answer({ t: "rpcResult", id, ok: true, result }))
				.catch((err: unknown) => {
					answer({
						t: "rpcResult",
						id,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			return;
		}
	}
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connectRelay(), delay);
}

/** Dial the relay unless a socket is open or opening. */
export async function connectRelay(): Promise<void> {
	if (
		ws &&
		(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
	)
		return;
	const { port, token } = await loadSettings();
	// Another caller dialed while the settings loaded.
	if (
		ws &&
		(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
	)
		return;
	const url = `ws://127.0.0.1:${port}/ext${token ? `?token=${encodeURIComponent(token)}` : ""}`;
	const socket = new WebSocket(url);
	const socketCalls = new RelayCalls();
	ws = socket;
	calls = socketCalls;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		void buildHello().then((hello) => {
			if (ws !== socket || !post(hello)) return;
			// A new socket starts idle; tell the relay right away when it isn't.
			if (busyReasons.size > 0) post({ t: "busy", busy: true });
		});
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
		handlers?.status(relayStatus());
	};
	socket.onmessage = (event) => {
		if (typeof event.data === "string")
			handleRelayMessage(socket, socketCalls, event.data);
	};
	socket.onclose = () => {
		socketCalls.failAll("omp relay disconnected");
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		handlers?.disconnected();
		handlers?.status(relayStatus());
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

/** Drop the current socket and dial again with fresh settings. */
export function redialRelay(): void {
	ws?.close();
	void connectRelay();
}

/** Route relay traffic to `relayHandlers`; call before the first dial. */
export function setRelayHandlers(relayHandlers: RelayHandlers): void {
	handlers = relayHandlers;
}
