/**
 * The worker's link to the omp relay: one long-lived native messaging port to the omp native host
 * ({@link NATIVE_HOST}), which serves the relay for this browser or joins the one another browser's host serves. Over
 * it run the hello, RPC dispatch, `input` pushes, and extension → relay calls.
 *
 * Each `linked` from the host starts a link epoch, ended by `unlinked` (the relay went away; the host finds or becomes
 * the next one and links again by itself) or by losing the port (the host exited; the worker reconnects with
 * backoff). RPC ids and calls belong to one epoch. An attempt the host never answers is dropped after
 * {@link LINK_DEADLINE_MS} and retried, so a port Chrome kept alive past its host cannot block the relay forever.
 *
 * Service-worker lifetime: the open native port keeps the worker alive; a chrome.alarms tick revives it and
 * reconnects after Chrome reaps it.
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
import {
	type FromNativeHost,
	NATIVE_HOST,
	type RelayStatus,
	type ToNativeHost,
} from "../messages";
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

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/** How long a link attempt may stay unlinked before the worker drops it and retries. */
const LINK_DEADLINE_MS = 15_000;


/** One link epoch, from a `linked` to the next `unlinked` or port loss; open while it lasts. */
export interface RelayLink {
	readonly open: boolean;
}

/** What the relay link hands to the rest of the worker. */
export interface RelayHandlers {
	/** Run one RPC; `origin` is the link epoch it came in on, which alone can carry its answer. */
	rpc(request: RelayRpcRequest, origin: RelayLink): Promise<unknown>;
	/** An acknowledged input for a tab's overlay. */
	input(tabId: number, input: OverlayInput): void;
	/** The link opened or ended. */
	status(status: RelayStatus): void;
	/** The link ended; the relay released everything it drove. */
	disconnected(): void;
}

/** A link epoch and the extension → relay calls in flight on it. */
class Link implements RelayLink {
	readonly calls = new RelayCalls();
	#open = true;

	get open(): boolean {
		return this.#open;
	}

	/** End the epoch; its pending calls fail with `reason`. */
	close(reason: string): void {
		this.#open = false;
		this.calls.failAll(reason);
	}
}

let handlers: RelayHandlers | null = null;
/** The port to the native host, while it is connected. */
let hostPort: chrome.runtime.Port | null = null;
/** The current link epoch, while a relay listens for this browser. */
let link: Link | null = null;
/** The browser's reason the last native host port closed; cleared by a link. See {@link RelayStatus.hostError}. */
let hostError: string | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: NodeJS.Timeout | null = null;
let deadlineTimer: NodeJS.Timeout | null = null;
/** Reasons the worker is doing work an extension reload would destroy. */
const busyReasons = new Set<string>();

/** Send `message` to the relay; false while unlinked. */
export function post(message: ExtToRelayMessage): boolean {
	if (!link || !hostPort) return false;
	const frame: ToNativeHost = { t: "relay", line: JSON.stringify(message) };
	try {
		hostPort.postMessage(frame);
		return true;
	} catch {
		// The host is gone; its onDisconnect ends the link.
		return false;
	}
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

/** Ask the relay for something the side panel needs; rejects when the link ends or the relay takes too long. */
export function callRelay(call: PanelCall): Promise<unknown> {
	if (!link) return Promise.reject(new Error("omp relay is not connected"));
	return link.calls.start(call, post);
}

/** The relay link as the panel shows it. */
export function relayStatus(): RelayStatus {
	return {
		connected: link !== null,
		extensionVersion:
			typeof OMP_INSTALL_VERSION === "string" ? OMP_INSTALL_VERSION : undefined,
		hostError,
	};
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "" });
		await chrome.action.setTitle({ title: connected ? "omp · Terminal browser relay connected" : "omp · Terminal browser relay disconnected" });
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

function handleRelayLine(raw: string, origin: Link, sendReply: (message: ExtToRelayMessage) => void): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	switch (msg.t) {
		case "reload":
			// The relay rewrote this extension's files; reloading re-reads them (a Chrome restart would not).
			chrome.runtime.reload();
			return;
		case "input":
			handlers?.input(msg.tabId, msg.input);
			return;
		case "callResult":
			origin.calls.settle(msg);
			return;
		case "rpc": {
			// Answer only within the epoch the RPC came in on: RPC ids are local to it, and the relay already failed
			// the call when it ended.
			const answer = (reply: ExtToRelayMessage): void => {
				if (origin.open) sendReply(reply);
			};
			const { id } = msg;
			const run = handlers
				? handlers.rpc(msg, origin)
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

const chatLinks = new Set<(message: ExtToRelayMessage) => void>();

/** Forward browser lifecycle events to each bridge tracking this Chrome profile. */
export function broadcastRelayEvent(message: ExtToRelayMessage): void {
	post(message);
	for (const send of chatLinks) send(message);
}

/** Bind browser traffic to an already-open chat port, independently of the discovery relay. */
export function connectChatRelay(port: chrome.runtime.Port): { receive(line: string): void; close(): void } {
	const origin = new Link();
	const send = (message: ExtToRelayMessage): void => {
		if (!origin.open) return;
		try {
			port.postMessage({ t: "relay", line: JSON.stringify(message) } satisfies ToNativeHost);
		} catch {
			close();
		}
	};
	const close = (): void => {
		origin.close("chat relay disconnected");
		chatLinks.delete(send);
	};
	void buildHello().then(hello => {
		if (!origin.open) return;
		chatLinks.add(send);
		send(hello);
	}).catch(() => port.disconnect());
	return { receive: line => handleRelayLine(line, origin, send), close };
}

/** A relay listens for this browser: start a new epoch and say hello. */
function linked(): void {
	if (link) unlinked("omp relay changed");
	clearLinkDeadline();
	reconnectDelay = RECONNECT_MIN_MS;
	hostError = undefined;
	const epoch = new Link();
	link = epoch;
	void setBadge(true);
	void buildHello().then((hello) => {
		if (link !== epoch || !post(hello)) return;
		// A new link starts idle; tell the relay right away when it isn't.
		if (busyReasons.size > 0) post({ t: "busy", busy: true });
	});
	handlers?.status(relayStatus());
}

/** The relay went away: end the epoch, failing its calls with `reason`. */
function unlinked(reason: string): void {
	clearLinkDeadline();
	const epoch = link;
	link = null;
	void setBadge(false);
	if (!epoch) return;
	epoch.close(reason);
	handlers?.disconnected();
	handlers?.status(relayStatus());
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	clearTimeout(reconnectTimer ?? undefined);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectRelay();
	}, delay);
}

function clearLinkDeadline(): void {
	clearTimeout(deadlineTimer ?? undefined);
	deadlineTimer = null;
}

function enforceLinkDeadline(port: chrome.runtime.Port): void {
	clearLinkDeadline();
	deadlineTimer = setTimeout(() => {
		deadlineTimer = null;
		if (link || hostPort !== port) return;
		hostPort = null;
		port.disconnect();
		scheduleReconnect();
	}, LINK_DEADLINE_MS);
}

/** Open the port to the native host and ask it to link this browser, unless the port is open. */
export function connectRelay(): void {
	if (hostPort) return;
	const port = chrome.runtime.connectNative(NATIVE_HOST);
	hostPort = port;
	enforceLinkDeadline(port);
	/** Partial oversized relay lines by chunk id. */
	const chunks = new Map<number, string[]>();
	port.onMessage.addListener((message: FromNativeHost) => {
		if (hostPort !== port) return;
		switch (message.t) {
			case "linked":
				linked();
				return;
			case "unlinked":
				unlinked(message.reason);
				return;
			case "relay":
				if (link) handleRelayLine(message.line, link, post);
				return;
			case "chunk": {
				const parts = chunks.get(message.id) ?? [];
				parts[message.index] = message.data;
				if (!message.last) {
					chunks.set(message.id, parts);
					return;
				}
				chunks.delete(message.id);
				if (link) handleRelayLine(parts.join(""), link, post);
				return;
			}
		}
	});
	port.onDisconnect.addListener(() => {
		// Reading lastError marks it checked; it says why the host is gone (not installed, crashed).
		const detail = chrome.runtime.lastError?.message;
		if (hostPort !== port) return;
		hostPort = null;
		clearLinkDeadline();
		const hadLink = link !== null;
		unlinked(
			detail
				? `omp native host disconnected: ${detail}`
				: "omp native host disconnected",
		);
		// A port that never linked was refused by the browser (host missing, blocked by policy): `unlinked` reported
		// nothing, so publish the browser's reason. A linked host's exit ("Native host has exited.") is no such refusal.
		if (!hadLink && detail !== hostError) {
			hostError = detail;
			handlers?.status(relayStatus());
		}
		scheduleReconnect();
	});
	const request: ToNativeHost = { t: "link", extensionId: chrome.runtime.id };
	port.postMessage(request);
}

/** Route relay traffic to `relayHandlers`; call before the first connect. */
export function setRelayHandlers(relayHandlers: RelayHandlers): void {
	handlers = relayHandlers;
}
