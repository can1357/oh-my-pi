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
	| { op: "forgetRecovery"; tabId: number }
	| {
			op: "send";
			tabId: number;
			sessionId?: string;
			method: string;
			params?: Record<string, unknown>;
	  }
	| { op: "createTab"; url: string }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/** Add tabs to the per-window omp group (created/reused by title), remembering prior membership. */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Return tabs to their pre-omp group (or ungroup); no-op for tabs the relay never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/** Messages sent relay → extension. */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" };

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			userAgent: string;
			browserVersion: string;
			/** Browser-default navigator.hardwareConcurrency for resetting overrides. */
			hardwareConcurrency?: number;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Tabs detached by the extension's orphan guard and therefore safe to restore for surviving sessions. */
			recoverableTabIds?: number[];
			/** Main-frame loader observed when recovery began, keyed by tab id. */
			recoveryLoaderIds?: Record<string, string>;
			/** Attached roots dirtied by guard-only CDP state and requiring detach + replay before reuse. */
			freshRootRequiredTabIds?: number[];
	  }
	| {
			t: "cdpEvent";
			tabId: number;
			sessionId?: string;
			method: string;
			params?: Record<string, unknown>;
	  }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| {
			t: "rpcResult";
			id: number;
			ok: boolean;
			result?: unknown;
			error?: string;
	  }
	| { t: "ping" };
