/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 */

/** Minimal view of a Chrome tab shared between extension and relay. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	/** Chrome discarded this tab; it reloads when activated. */
	discarded: boolean;
	windowId: number;
	/** Pinned tabs are never grouped (Chrome would silently unpin them). */
	pinned: boolean;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
}

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { op: "createTab"; url: string }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/** Add tabs to the per-window omp group (created/reused by title), remembering prior membership. */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Return tabs to their pre-omp group (or ungroup); no-op for tabs the relay never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/** Messages sent relay → extension. */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** Required capability for safe relay target discovery and auto-attach. */
export const DISCARDED_TABS_PROTOCOL_VERSION = 1;

/**
 * An omp release version as relays and extensions report it. Stricter than
 * `Bun.semver.order`, which ranks strings with trailing text; peers supply
 * these and results quote them.
 */
const OMP_VERSION_PATTERN = /^(?=.{5,64}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/**
 * Whether an omp version a relay or extension reports is older than `than`.
 * Unreported ("") is the oldest; anything else that is not an omp version has
 * no known age, so it ranks after every version and is never older than one.
 */
export function isOlderOmpVersion(version: string, than: string): boolean {
	if (version === "" || than === "") return version === "" && than !== "";
	if (!OMP_VERSION_PATTERN.test(version)) return false;
	if (!OMP_VERSION_PATTERN.test(than)) return true;
	return Bun.semver.order(version, than) < 0;
}

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Present when snapshots include Chrome's discarded state. Absent in older extensions. */
			discardedTabsProtocol?: number;
			/**
			 * Stable per-install browser identity (persisted in `chrome.storage.local`).
			 * Lets the relay serve several browsers at once: tabs are namespaced per
			 * instance, and a service-worker restart with the same id reuses the
			 * existing tab registry instead of replacing another browser's connection.
			 * Absent on older extensions, which share one legacy instance with
			 * latest-wins socket replacement.
			 */
			instanceId?: string;
			/** The omp version that installed this extension (manifest `version_name`). Absent on builds without the stamp. */
			ompVersion?: string;
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
