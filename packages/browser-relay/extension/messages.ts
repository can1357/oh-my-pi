/**
 * Messages between the extension's contexts: side panel ↔ service worker (a `chrome.runtime` port named
 * {@link PANEL_PORT}), service worker ↔ page overlay and Teach recorder (`chrome.tabs.sendMessage` /
 * `chrome.runtime.sendMessage`), and service worker ↔ the omp native host (`chrome.runtime.connectNative`).
 *
 * The relay protocol (worker ↔ omp relay socket) lives in `coding-agent/src/tools/browser/relay/protocol.ts`;
 * this file only re-exports the shapes the panel and overlay share with it.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import type { OverlayInput, PanelCollabHost, PanelInstall } from "../../coding-agent/src/tools/browser/relay/protocol";

export { OVERLAY_HOST_TAG } from "../../coding-agent/src/tools/browser/relay/protocol";
export type { OverlayInput, PanelCollabHost, PanelInstall };

// ---- shared shapes -------------------------------------------------------------

/** Name of the long-lived port each side panel opens to the worker. */
export const PANEL_PORT = "omp-panel";

/** Native messaging host name registered by `omp browser-relay install`. */
export const NATIVE_HOST = "sh.omp.browser";

/** chrome.storage.local key holding the saved {@link Shortcut} list. */
export const SHORTCUTS_KEY = "omp.shortcuts";

/** chrome.storage.local key holding per-host starter prompts: `Record<hostname, string[]>`. */
export const SUGGESTIONS_KEY = "omp.suggestions";

/** chrome.storage.local key holding {@link PanelSettings}. */
export const SETTINGS_KEY = "omp.settings";

/** A rectangle in viewport CSS pixels. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A viewport size in CSS pixels. */
export interface Size {
	width: number;
	height: number;
}

/** What the panel knows about a tab, and how the agent addresses it through the relay. */
export interface TabContext {
	tabId: number;
	windowId: number;
	url: string;
	title: string;
	favIconUrl?: string;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
	/** Page viewport in CSS pixels (tab size divided by its zoom factor); null when Chrome doesn't report a size. */
	viewport: Size | null;
	/**
	 * The relay's page target id, `PAGE<code>.<tabId>` (`browser.open({ app: "relay", target })` matches it exactly);
	 * `<code>` is the first 8 base64url chars of SHA-256(`${instanceId}/${browserSession}`). Null while the worker has
	 * no instance identity yet.
	 */
	targetId: string | null;
}

/** A picked or captured image of a tab, ready to send as a prompt image. */
export interface Capture {
	image: ImageContent;
	/** Image size in pixels. */
	width: number;
	height: number;
	tabId: number;
	url: string;
	/** Element descriptor for element picks, e.g. `<button#merge>`; absent for regions and viewports. */
	caption?: string;
}

/** What a panel conversation is doing in a tab; drives the page overlay's edge, tag and favicon. */
export type TabActivity =
	| { state: "idle" }
	/** `label` is the live verb shown in the tag (“Clicking”); `canStop` shows the Stop control. */
	| { state: "working"; session: string; label?: string; canStop: boolean }
	/** The agent asked a question or finished waiting on the user. */
	| { state: "waiting"; session: string };

/** Relay connection status as the worker sees it. */
export interface RelayStatus {
	connected: boolean;
	port: number;
	/** omp version stamped into the running worker script; undefined in an unstamped dev build. */
	extensionVersion: string | undefined;
}

/** A worker-owned `omp --mode rpc` session behind the native host. */
export interface RpcSessionInfo {
	sessionKey: string;
	cwd: string;
	title: string;
	startedAt: number;
	/** Tabs this conversation works in; the first is its main tab. */
	tabIds: number[];
	/** Set once the native host process exited. */
	exited?: { code: number | null; stderr: string };
}

/** One recorded Teach step. */
export interface TeachStep {
	kind: "click" | "type" | "key" | "select" | "navigate";
	url: string;
	title: string;
	/** Accessible role and name of the target element, when there is one. */
	role?: string;
	name?: string;
	/** A CSS selector that matched the element when it was recorded. */
	selector?: string;
	/** Visible text of or near the element, trimmed to 120 chars. */
	text?: string;
	/** Typed text or selected option; never recorded for password fields. */
	value?: string;
	/** Key name for `key` steps, e.g. `Enter`. */
	key?: string;
	/** Click point in viewport CSS pixels. */
	x?: number;
	y?: number;
	viewport: Size;
	at: number;
	/** Viewport screenshot taken right after the step, added by the worker. */
	screenshot?: ImageContent;
	/** Narration spoken while this step was current. */
	narration?: string;
}

/** A saved prompt, optionally scheduled. */
export interface Shortcut {
	id: string;
	/** Slash name without the slash: `[a-z0-9_-]+`. */
	name: string;
	prompt: string;
	/** Page a scheduled run opens before sending the prompt. */
	startUrl?: string;
	schedule?: Schedule;
	/** `provider/id`; the session default when absent. */
	model?: string;
	/** Directory the scheduled run's omp session starts in; settings default when absent. */
	cwd?: string;
	uses: number;
	createdAt: number;
	/** Epoch ms of the next scheduled run; maintained by the worker. */
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunError?: string;
}

/** When a shortcut runs on its own. Times are local wall-clock `HH:MM`. */
export type Schedule =
	| { kind: "once"; date: string; time: string }
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; time: string }
	| { kind: "monthly"; day: number; time: string }
	| { kind: "yearly"; month: number; day: number; time: string };

/** Panel preferences stored under {@link SETTINGS_KEY}. */
export interface PanelSettings {
	theme: "system" | "light" | "dark";
	/** Directory new panel sessions start in. */
	defaultCwd: string;
	/** Where “New chat” goes: the newest running omp session, or a new panel session. */
	newChat: "attach" | "panel";
	overlay: { enabled: boolean; arrow: boolean; edge: boolean };
}

/** One frame of an exported run GIF. */
export interface GifFrame {
	image: ImageContent;
	/** Viewport the screenshot pictured, for scaling markers. */
	viewport: Size;
	/** Marker to draw on this frame. */
	action?:
		| { kind: "click"; x: number; y: number; label?: string }
		| { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; label?: string }
		| { kind: "scroll"; x: number; y: number; label?: string }
		| { kind: "type"; label: string };
	/** Display time in ms; defaults by action kind. */
	delayMs?: number;
}

// ---- panel ↔ worker ---------------------------------------------------------------

/** Request name → [request fields, result]. */
export interface PanelRequestMap {
	relayStatus: [{}, RelayStatus];
	collabHosts: [{}, PanelCollabHost[]];
	collabLink: [{ instanceId: string }, { url: string }];
	/** Forwarded to the relay as the `installs` call. */
	installs: [{}, PanelInstall[]];
	activeTab: [{ windowId: number }, TabContext | null];
	tabContext: [{ tabId: number }, TabContext];
	/** Null when the user cancelled the pick. Region and element picks run the overlay picker first. */
	capture: [{ tabId: number; mode: "viewport" | "region" | "element" }, Capture | null];
	/** Cancel a region or element pick still running in `tabId`; its `capture` resolves null. */
	cancelCapture: [{ tabId: number }, void];
	setActivity: [{ tabId: number; activity: TabActivity }, void];
	focusTab: [{ tabId: number }, void];
	/** Group tabs under `title`, reusing `groupId` when given. */
	groupTabs: [{ tabIds: number[]; title: string; groupId?: number }, { groupId: number }];
	rpcOpen: [{ cwd: string; title: string; tabIds: number[] }, RpcSessionInfo];
	/** One rpc JSON command line for the session's `omp --mode rpc` stdin. */
	rpcSend: [{ sessionKey: string; line: string }, void];
	rpcClose: [{ sessionKey: string }, void];
	rpcSessions: [{}, RpcSessionInfo[]];
	teachStart: [{ tabId: number }, void];
	/** Stops recording and returns every step since `teachStart`. */
	teachStop: [{}, TeachStep[]];
	exportGif: [{ frames: GifFrame[] }, { filename: string }];
	/** Run a saved shortcut now, as its schedule would. */
	runShortcut: [{ shortcutId: string }, RpcSessionInfo];
}

export type PanelRequestOp = keyof PanelRequestMap;
export type PanelRequest = { [Op in PanelRequestOp]: { op: Op } & PanelRequestMap[Op][0] }[PanelRequestOp];
export type PanelResult<Op extends PanelRequestOp> = PanelRequestMap[Op][1];

/** Pushed by the worker to every connected panel. */
export type PanelEvent =
	| { event: "relay"; status: RelayStatus }
	/** The active tab of `windowId` changed, navigated, or was retitled. */
	| { event: "activeTab"; windowId: number; tab: TabContext | null }
	/** The user pressed Stop or Open on a tab's page overlay. */
	| { event: "overlay"; tabId: number; action: "stop" | "open" }
	| { event: "rpcLine"; sessionKey: string; line: string }
	| { event: "rpcSessions"; sessions: RpcSessionInfo[] }
	| { event: "teachStep"; step: TeachStep }
	/** A schedule fired and started a session; open it if the panel is showing nothing else. */
	| { event: "scheduledRun"; shortcutId: string; session: RpcSessionInfo };

/** Panel → worker frames on the {@link PANEL_PORT} port. The first frame is always `hello`. */
export type PanelToWorker =
	| { kind: "hello"; windowId: number }
	| { kind: "request"; id: number; request: PanelRequest };

/** Worker → panel frames on the {@link PANEL_PORT} port. */
export type WorkerToPanel =
	| { kind: "response"; id: number; ok: true; result: unknown }
	| { kind: "response"; id: number; ok: false; error: string }
	| { kind: "event"; event: PanelEvent };

// ---- worker ↔ page overlay ------------------------------------------------------------

/** What an overlay pick resolved to; the overlay has already removed its picker visuals from screen. */
export type PickResult =
	| { kind: "viewport"; viewport: Size }
	| { kind: "region"; rect: Rect; viewport: Size }
	| { kind: "element"; rect: Rect; viewport: Size; descriptor: string };

/**
 * Worker → overlay (`chrome.tabs.sendMessage(tabId, command, { frameId: 0 })`). Every command answers through
 * `sendResponse`: `hide` only after the overlay is invisible on screen (two animation frames later), `pick` with a
 * {@link PickResult} or null when cancelled, everything else with `true`.
 */
export type OverlayCommand =
	| { omp: "overlay"; op: "mount" }
	| { omp: "overlay"; op: "unmount" }
	| { omp: "overlay"; op: "input"; input: OverlayInput }
	/** `role: "main"` draws edge, tag and favicon; `"secondary"` draws the group pill. */
	| { omp: "overlay"; op: "activity"; activity: TabActivity; role: "main" | "secondary" }
	| { omp: "overlay"; op: "hide" }
	| { omp: "overlay"; op: "show" }
	| { omp: "overlay"; op: "pick"; mode: "element" | "region" }
	/** End a running pick as if the user pressed Esc in the page; the pending `pick` resolves null. */
	| { omp: "overlay"; op: "cancelPick" }
	/** Stop reached the session (`delivered`) or not; the overlay shows “Stop didn’t reach omp” on false. */
	| { omp: "overlay"; op: "stopAck"; delivered: boolean };

/** Overlay → worker (`chrome.runtime.sendMessage`); the sender tab identifies the tab. */
export type OverlayEvent = { omp: "overlay-event"; op: "stop" | "open" | "dismiss" };

// ---- worker ↔ Teach recorder ------------------------------------------------------------

/** Worker → recorder content script. */
export type TeachCommand = { omp: "teach"; op: "start" | "stop" };

/** Recorder → worker, one per user action; the worker adds the screenshot. */
export type TeachEvent = { omp: "teach-step"; step: Omit<TeachStep, "screenshot" | "narration"> };

// ---- worker ↔ native host -------------------------------------------------------------------

/** Extension → native host. `open` is first: the host starts `omp --mode rpc` in `cwd`. */
export type ToNativeHost = { t: "open"; cwd: string } | { t: "rpc"; line: string };

/**
 * Native host → extension. Lines over Chrome's 1 MiB host→extension limit arrive as `chunk`s with one `id`,
 * concatenated in `index` order up to the `last` one.
 */
export type FromNativeHost =
	| { t: "ready"; pid: number }
	| { t: "rpc"; line: string }
	| { t: "chunk"; id: number; index: number; last: boolean; data: string }
	| { t: "exit"; code: number | null; stderr: string };

// ---- worker modules ---------------------------------------------------------------------------

/** Handler for one panel request op. */
export type PanelHandler<Op extends PanelRequestOp> = (
	request: Extract<PanelRequest, { op: Op }>,
) => Promise<PanelResult<Op>>;

/** What `background.ts` gives feature modules (schedules, Teach, GIF export) so they never touch its internals. */
export interface WorkerContext {
	/** Broadcast to every connected panel. */
	emit(event: PanelEvent): void;
	/** Serve a panel request op; one handler per op. */
	handle<Op extends PanelRequestOp>(op: Op, handler: PanelHandler<Op>): void;
	tabContext(tabId: number): Promise<TabContext>;
	/** PNG of the visible area of `windowId`'s active tab. */
	captureVisible(windowId: number): Promise<{ image: ImageContent; width: number; height: number }>;
	/** Ensure the overlay script runs in `tabId` and send it a command. */
	overlay<T = unknown>(tabId: number, command: OverlayCommand): Promise<T>;
	openRpcSession(options: { cwd: string; title: string; tabIds: number[] }): Promise<RpcSessionInfo>;
	sendRpc(sessionKey: string, line: string): void;
	/** Every stdout line of every rpc session; returns an unsubscribe. */
	onRpcLine(listener: (sessionKey: string, line: string) => void): () => void;
	setActivity(tabId: number, activity: TabActivity): Promise<void>;
	/**
	 * Mark work under `reason` (e.g. `teach`, `gif`) that an extension reload would destroy, or clear it. The worker
	 * ORs every reason with its own (rpc sessions alive, panel turns running) and reports the relay `busy` message.
	 */
	setBusy(reason: string, busy: boolean): void;
}
