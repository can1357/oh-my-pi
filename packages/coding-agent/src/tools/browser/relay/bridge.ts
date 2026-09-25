/**
 * CDP façade over `chrome.debugger`.
 *
 * Puppeteer clients (the omp browser tool: one supervisor connection plus one
 * per tab worker) connect to this bridge as if it were Chrome's browser
 * debugging endpoint. Chrome only allows a single debugger attachment per tab,
 * so the bridge owns ONE `chrome.debugger` attachment per tab (via the
 * extension) and multiplexes every downstream connection over it with minted
 * per-connection session ids.
 *
 * Emulated surface (everything else is forwarded to `chrome.debugger`):
 * - the browser target (`/json/version` handshake, `Browser.getVersion`)
 * - the `Target.*` domain, including puppeteer's tab → page auto-attach
 *   hierarchy (see puppeteer-core `cdp/ExtensionTransport.ts`, the reference
 *   implementation for this emulation)
 *
 * Session id namespaces seen by a downstream connection:
 * - minted tab pseudo-sessions (`ST<tab>.<conn>.<n>`) — Target emulation only
 * - minted page pseudo-sessions (`SP<tab>.<conn>.<n>`) — forwarded to the
 *   tab's root debugger session
 * - real child session ids (OOPIFs, workers) — created by Chrome under the
 *   shared root session and passed through verbatim
 */
import { createHash } from "node:crypto";
import type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./protocol";

/** Transport-agnostic websocket surface the bridge writes to. */
export interface RelaySocket {
	send(text: string): void;
	close(): void;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

/**
 * Per-pseudo-session Runtime domain state.
 * - `default`: never toggled Runtime — still receives the relay's legacy
 *   root-event fan-out, so omp's own patched-puppeteer client (which
 *   pull-acquires contexts and never sends `Runtime.enable`) keeps getting
 *   `Runtime.executionContextCreated`.
 * - `enabled`: ran `Runtime.enable`; gets the existing-context replay.
 * - `disabled`: explicitly ran `Runtime.disable`; silenced until it re-enables.
 */
type RuntimeState = "default" | "enabled" | "disabled";

interface SessionRef {
	kind: "tab" | "page";
	/** Registry key of the owning tab (`<instance code>:<chrome tabId>`). */
	tabKey: string;
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
}

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
}

class CdpConnection {
	discover = false;
	autoAttach = false;
	/** Minted pseudo-sessions owned by this connection. */
	readonly sessions = new Map<string, SessionRef>();
	/** Tabs this connection claimed as drive targets (`OMP.claimTarget` / `Target.createTarget`). */
	readonly claims = new Set<string>();

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabKey: string, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabKey === tabKey && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

/** Transport replacement is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

/** A connected extension browser instance; one per browser/profile. */
interface ExtInstance {
	instanceId: string;
	/** Stable short code derived from the instance id; names target ids (`TAB<code>.<tabId>`). */
	code: string;
	socket: RelaySocket | null;
	info: { userAgent: string; browserVersion: string } | null;
}

/** Deterministic per-instance code for target ids: stable across relay restarts. */
function instanceCode(instanceId: string): string {
	return createHash("sha256").update(instanceId).digest("base64url").slice(0, 8);
}

function tabKeyOf(extCode: string, tabId: number): string {
	return `${extCode}:${tabId}`;
}

function tabTargetIdFromKey(key: string): string {
	return `TAB${key.replace(":", ".")}`;
}

function pageTargetIdFromKey(key: string): string {
	return `PAGE${key.replace(":", ".")}`;
}

function parseTargetId(targetId: string): { key: string; kind: "tab" | "page" } | null {
	const match = /^(TAB|PAGE)([^.]+)\.(\d+)$/.exec(targetId);
	if (!match) return null;
	const kind: "tab" | "page" = match[1] === "TAB" ? "tab" : "page";
	return { key: `${match[2]}:${match[3]}`, kind };
}

class TabState {
	/** Assigned in the constructor body from the owning instance. */
	readonly tabKey: string;
	url: string;
	title: string;
	active: boolean;
	/** Discarded tabs cannot answer debugger calls. */
	discarded: boolean;
	windowId: number;
	pinned: boolean;
	/** Chrome tab group id from the last snapshot; -1 when ungrouped. */
	groupId: number;
	/** Whether `chrome.debugger` is currently attached to this tab. */
	attached = false;
	/** Set when attach failed or the user cancelled the debugger; cleared on navigation. */
	banned = false;
	/** Whether targets for this tab were announced to discovering connections. */
	announced = false;
	attaching: Promise<boolean> | null = null;
	/** Relay-initiated detach in flight; reattach serializes behind it. */
	detaching: Promise<void> | null = null;
	/** A successful attach completed after the most recently requested relay detach. */
	reattachedAfterDetach = false;
	/** True after the relay put this tab in the omp group; `ompGroupId` holds that group. */
	grouped = false;
	/** Group RPC in flight — suppresses duplicate requests from load-time tabUpdated bursts. */
	grouping = false;
	ompGroupId: number | undefined;
	/** User pulled the tab out of the omp group — never re-group it. */
	groupOptOut = false;
	/** Real Chrome session ids (OOPIF/worker children) living under this tab's root session. */
	readonly realSessions = new Set<string>();
	/** Live execution contexts from the shared root debugger session. */
	readonly runtimeContexts = new Map<number, Record<string, unknown>>();
	/** Whether the shared root Runtime domain has been enabled by the bridge. */
	rootRuntimeEnabled = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;

	constructor(
		readonly instanceId: string,
		readonly extCode: string,
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.tabKey = tabKeyOf(extCode, tabId);
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}
}

/** URLs `chrome.debugger` cannot attach to; hidden from downstream discovery entirely. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	/** Tab registries keyed by `<instance code>:<chrome tabId>`; one namespace per browser instance. */
	#tabs = new Map<string, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	/** Connected extension browser instances, keyed by stable instance id. */
	#instances = new Map<string, ExtInstance>();
	#socketInstance = new Map<RelaySocket, string>();
	/** Instance whose hello ran last: answers browser-wide requests and owns created tabs. */
	#lastHelloInstance: string | null = null;
	#extensionSeen = false;
	#pendingRpc = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();
	/** Real child session id → owning tab key, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, string>();
	#log: (message: string, data?: Record<string, unknown>) => void;
	/** Tab-group appearance for driven tabs; null disables grouping. */
	#group: { title: string; color: string } | null;
	/** Tabs awaiting the next group RPC; drained one batch at a time. */
	#groupQueue: TabState[] = [];
	/** True while {@link #drainGroupQueue} runs — group RPCs must never overlap. */
	#groupDraining = false;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;
			/** Group tabs the agent actively drives under one per-window Chrome tab group. */
			group?: { title: string; color: string } | null;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#group = opts.group ?? null;
	}

	/** True once the extension has completed its hello handshake. */
	get ready(): boolean {
		for (const inst of this.#instances.values()) {
			if (inst.socket && inst.info) return true;
		}
		return false;
	}

	/** The instance whose hello ran last (browser-wide requests route there). */
	#lastHello(): ExtInstance | undefined {
		if (this.#lastHelloInstance) {
			const inst = this.#instances.get(this.#lastHelloInstance);
			if (inst?.socket) return inst;
		}
		for (const inst of this.#instances.values()) {
			if (inst.socket) return inst;
		}
		return undefined;
	}

	/** True after the first hello, and stays true: separates a reaped service worker from an absent extension. */
	get extensionSeen(): boolean {
		return this.#extensionSeen;
	}

	/** Payload for `GET /json/version`. */
	versionInfo(wsUrl: string): Record<string, string> {
		const info = this.#lastHello()?.info;
		const ua = info?.userAgent ?? "";
		return {
			Browser: info?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
		};
	}

	/** Payload for `GET /json/list` (debugging aid; per-target endpoints are not served). */
	listTargets(): Array<Record<string, string>> {
		const out: Array<Record<string, string>> = [];
		for (const tab of this.#tabs.values()) {
			if (!this.#eligible(tab)) continue;
			out.push({
				id: pageTargetIdFromKey(tab.tabKey),
				type: "page",
				title: tab.title,
				url: tab.url,
				active: String(tab.active),
				discarded: String(tab.discarded),
			});
		}
		return out;
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(instanceId: string, error: Error): void {
		const prefix = `${instanceId}:`;
		for (const [key, pending] of this.#pendingRpc) {
			if (!key.startsWith(prefix)) continue;
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pendingRpc.delete(key);
		}
	}

	/** A new extension socket connected; its hello assigns (or reuses) a browser instance. */
	extConnected(_socket: RelaySocket): void {
		this.#log("extension socket connected");
	}

	extClosed(socket: RelaySocket): void {
		const instanceId = this.#socketInstance.get(socket);
		if (instanceId === undefined) return;
		this.#socketInstance.delete(socket);
		const inst = this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		inst.socket = null;
		this.#rejectPendingExtensionRpcs(instanceId, new Error("relay extension disconnected"));
		// Keep the instance's tabs listed (the browser may reconnect), but drop
		// debugger state: the attachment died with the service worker.
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== instanceId) continue;
			tab.attached = false;
			tab.attaching = null;
			this.#resetRuntime(tab);
			// The extension dissolves omp groups on disconnect (or died along
			// with them); grouping state is unknowable until the next hello.
			tab.grouped = false;
			tab.grouping = false;
			tab.ompGroupId = undefined;
		}
		this.#groupQueue = this.#groupQueue.filter(tab => tab.instanceId !== instanceId);
	}

	extMessage(socket: RelaySocket, raw: string): void {
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		if (msg.t === "hello") {
			this.#onHello(socket, msg);
			return;
		}
		const instanceId = this.#socketInstance.get(socket);
		if (instanceId === undefined) return;
		const inst = this.#instances.get(instanceId);
		if (!inst || inst.socket !== socket) return;
		switch (msg.t) {
			case "rpcResult": {
				const key = `${instanceId}:${msg.id}`;
				const pending = this.#pendingRpc.get(key);
				if (!pending) return;
				this.#pendingRpc.delete(key);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(tabKeyOf(inst.code, msg.tabId), msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(tabKeyOf(inst.code, msg.tabId), msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab, instanceId);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab, instanceId);
				return;
			case "tabRemoved":
				this.#onTabRemoved(tabKeyOf(inst.code, msg.tabId));
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	#onHello(socket: RelaySocket, msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		// Hellos without an instance id (legacy extension builds) share one anon
		// instance and keep the historical latest-wins replacement semantics.
		const instanceId = typeof msg.instanceId === "string" && msg.instanceId.length > 0 ? msg.instanceId : "anon";
		let inst = this.#instances.get(instanceId);
		if (!inst) {
			inst = { instanceId, code: instanceCode(instanceId), socket: null, info: null };
			this.#instances.set(instanceId, inst);
		} else if (inst.socket && inst.socket !== socket) {
			// Same browser reconnected (service-worker restart): retire the old
			// socket. Debugger-derived state dies with the old attachment, so
			// reset runtime state exactly like the old single-slot replace did;
			// the hello's attachedTabIds reconciliation runs right after.
			for (const tab of this.#tabs.values()) {
				if (tab.instanceId === instanceId) this.#resetRuntime(tab);
			}
			this.#rejectPendingExtensionRpcs(instanceId, new ExtensionReplacedError());
			this.#socketInstance.delete(inst.socket);
			inst.socket.close();
		}
		inst.socket = socket;
		this.#socketInstance.set(socket, instanceId);
		inst.info = { userAgent: msg.userAgent, browserVersion: msg.browserVersion };
		this.#lastHelloInstance = instanceId;
		this.#extensionSeen = true;
		// The hello GC is scoped to this instance: another browser's tabs are
		// untouched, which is what lets Chrome and Edge share one relay.
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, instanceId, { silent: true });
		}
		for (const [key, tab] of this.#tabs) {
			if (tab.instanceId !== instanceId || seen.has(tab.tabId)) continue;
			this.#onTabRemoved(key);
		}
		for (const tab of this.#tabs.values()) {
			if (tab.instanceId !== instanceId) continue;
			const wasAttached = tab.attached;
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A service-worker restart can drop attachments while downstream
			// connections still hold sessions: restore them best-effort.
			if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabKey).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) this.#onTabDetached(tab.tabKey, "reattach_failed", false);
				});
			}
		}
		this.#syncGrouping();
		this.#log("extension connected", {
			instanceId,
			tabs: msg.tabs.length,
			version: msg.browserVersion,
		});
	}

	// ---- downstream (puppeteer) lifecycle -------------------------------------

	/** Register a downstream CDP websocket; returns the connection id. */
	cdpConnected(socket: RelaySocket): number {
		const conn = new CdpConnection(++this.#connSeq, socket);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		const touched = new Set<string>();
		for (const ref of conn.sessions.values()) touched.add(ref.tabKey);
		conn.sessions.clear();
		// Tabs this client claimed leave the omp group unless another claimant
		// remains — session holders don't count: the long-lived registry
		// connection holds sessions on every tab without driving any of them.
		for (const tabId of conn.claims) {
			const tab = this.#tabs.get(tabId);
			if (tab) this.#syncTabGrouping(tab);
		}
		conn.claims.clear();
		// Drop the debugger (and its infobar) from tabs nobody drives anymore.
		for (const tabKey of touched) this.#detachIfUnheld(tabKey);
		this.#log("cdp client closed", { conn: connId });
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.#handleCdpCommand(conn, msg).catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	// ---- command routing -------------------------------------------------------

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			await this.#handlePageSessionCommand(conn, msg, sessionId, ref);
			return;
		}
		const realTabKey = this.#realSessionTabs.get(sessionId);
		if (realTabKey !== undefined) {
			await this.#forwardToTab(conn, msg, realTabKey, sessionId);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	async #handlePageSessionCommand(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		if (msg.method === "Runtime.disable") {
			ref.runtimeState = "disabled";
			ref.runtimeEpoch++;
			ref.runtimeContexts.clear();
			// Abandon any in-flight enable's ownership: a later enable starts fresh
			// rather than joining a cycle that predates this disable.
			ref.runtimeEnabling = null;
			this.#reply(conn, msg, {});
			return;
		}
		if (msg.method !== "Runtime.enable") {
			await this.#forwardToTab(conn, msg, ref.tabKey, undefined);
			return;
		}
		// A pipelined duplicate must await the in-flight enable, never ack early:
		// the root cycle may still fail, and success must trail the context replay.
		if (ref.runtimeEnabling) {
			await this.#awaitEnable(conn, msg, ref.runtimeEnabling);
			return;
		}
		if (ref.runtimeState === "enabled") {
			this.#reply(conn, msg, {});
			return;
		}
		const enabling = this.#enableSessionRuntime(conn, sessionId, ref);
		ref.runtimeEnabling = enabling;
		try {
			await this.#awaitEnable(conn, msg, enabling);
		} finally {
			if (ref.runtimeEnabling === enabling) ref.runtimeEnabling = null;
		}
	}

	/** Reply to one `Runtime.enable` command with the shared enable's outcome. */
	async #awaitEnable(conn: CdpConnection, msg: CdpCommand, enabling: Promise<void>): Promise<void> {
		try {
			await enabling;
			this.#reply(conn, msg, {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Drive the shared root `Runtime.enable` for a session and replay the live
	 * contexts to it. Rejects if the root cycle fails so every joined caller
	 * observes the failure instead of a spurious success.
	 */
	async #enableSessionRuntime(conn: CdpConnection, sessionId: string, ref: SessionRef): Promise<void> {
		const prev = ref.runtimeState;
		const epoch = ++ref.runtimeEpoch;
		ref.runtimeState = "enabled";
		const tab = this.#tabs.get(ref.tabKey);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab ${ref.tabKey}`);
		}
		try {
			await this.#ensureRuntimeEnabled(tab);
			// A disable or newer enable may have taken ownership while the root
			// RPC was in flight; only the latest enable may replay or roll back.
			if (conn.sessions.get(sessionId) === ref && ref.runtimeEpoch === epoch && ref.runtimeState === "enabled") {
				this.#replayRuntimeContexts(conn, sessionId, ref, tab);
			}
		} catch (err) {
			if (ref.runtimeEpoch === epoch) {
				ref.runtimeState = prev;
				ref.runtimeContexts.clear();
			}
			throw err;
		}
	}

	async #ensureRuntimeEnabled(tab: TabState): Promise<void> {
		if (tab.rootRuntimeEnabled) return;
		if (tab.rootRuntimeEnabling) return await tab.rootRuntimeEnabling;

		const enabling = this.#cycleRuntime(tab);
		tab.rootRuntimeEnabling = enabling;
		const generation = tab.runtimeGeneration;
		try {
			await enabling;
			if (tab.runtimeGeneration === generation) tab.rootRuntimeEnabled = true;
		} finally {
			if (tab.rootRuntimeEnabling === enabling) tab.rootRuntimeEnabling = null;
		}
	}

	async #cycleRuntime(tab: TabState): Promise<void> {
		const inst = this.#instanceFor(tab);
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.disable" }, inst);
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" }, inst);
	}

	#replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
		for (const [contextId, params] of tab.runtimeContexts) {
			if (ref.runtimeContexts.has(contextId)) continue;
			ref.runtimeContexts.add(contextId);
			conn.socket.send(JSON.stringify({ sessionId, method: "Runtime.executionContextCreated", params }));
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabKey: string,
		realSessionId: string | undefined,
	): Promise<void> {
		// Guard rail: a page session must never take the whole browser down.
		if (msg.method === "Browser.close") {
			this.#reply(conn, msg, {});
			return;
		}
		// Relay-private claim: the omp tab worker marks the page it was spawned
		// to drive. Never forwarded — real Chrome rejects the unknown method.
		if (msg.method === "OMP.claimTarget") {
			this.#claimTab(conn, tabKey);
			this.#reply(conn, msg, {});
			return;
		}
		const tab = this.#tabs.get(tabKey);
		if (!tab) {
			this.#replyError(conn, msg, `No tab with key ${tabKey}`);
			return;
		}
		const inst = this.#instances.get(tab.instanceId);
		if (!inst || !inst.socket) {
			this.#replyError(conn, msg, "relay extension is not connected");
			return;
		}
		try {
			const result = await this.#rpc(
				{
					op: "send",
					tabId: tab.tabId,
					sessionId: realSessionId,
					method: msg.method,
					params: msg.params,
				},
				inst,
			);
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Record `conn` as a driver of the tab and reconcile grouping. Claims are
	 * explicit (worker adoption or tab creation) rather than inferred from
	 * command traffic: target discovery scans every page with the same
	 * commands a driver sends, so inference would sweep all tabs.
	 */
	#claimTab(conn: CdpConnection, tabKey: string): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		if (!conn.claims.has(tabKey)) {
			conn.claims.add(tabKey);
			this.#log("tab claimed", { conn: conn.id, tabKey });
		}
		this.#syncTabGrouping(tab);
	}

	/** True while any downstream connection claims the tab as its drive target. */
	#claimed(tabKey: string): boolean {
		for (const conn of this.#conns.values()) {
			if (conn.claims.has(tabKey)) return true;
		}
		return false;
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabKey);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabKey} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		switch (msg.method) {
			case "Browser.getVersion": {
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#lastHello()?.info?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#lastHello()?.info?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.getTargets": {
				const targetInfos: TargetInfo[] = [];
				for (const tab of this.#tabs.values()) {
					if (this.#eligible(tab)) targetInfos.push(this.#pageInfo(tab, tab.attached));
				}
				this.#reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				// Discarded tabs can stall debugger calls. Retract targets already
				// announced by Target.setDiscoverTargets so Puppeteer can connect().
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab) && !tab.discarded);
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached || tab.discarded || !this.#eligible(tab)) {
						// Failed or newly discarded tabs must not hold up connect().
						this.#retractTab(tab);
						this.#detachIfUnheld(tab.tabKey);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				for (const tab of this.#tabs.values()) {
					if (tab.announced && tab.discarded && this.#eligible(tab)) {
						this.#retractTab(tab);
						this.#detachIfUnheld(tab.tabKey);
					}
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabKey} (${tab.url})`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(conn, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, undefined);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				const inst = this.#lastHello();
				if (!inst || !inst.socket) {
					this.#replyError(conn, msg, "relay extension is not connected");
					return;
				}
				const result = (await this.#rpc({ op: "createTab", url }, inst)) as { tab: TabSnapshot };
				this.#onTabUpsert(result.tab, inst.instanceId);
				// Creating a tab is an explicit act of driving it.
				const createdKey = tabKeyOf(inst.code, result.tab.tabId);
				this.#claimTab(conn, createdKey);
				this.#reply(conn, msg, { targetId: pageTargetIdFromKey(createdKey) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				const removedTab = this.#tabs.get(parsed.key);
				if (!removedTab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#rpc({ op: "removeTab", tabId: removedTab.tabId }, this.#instanceFor(removedTab));
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const activatedTab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (parsed && activatedTab) {
					await this.#rpc({ op: "activateTab", tabId: activatedTab.tabId }, this.#instanceFor(activatedTab));
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.key) : undefined;
				if (parsed && tab) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#reply(conn, msg, {
					targetInfo: {
						targetId: "relay-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					} satisfies TargetInfo,
				});
				return;
			}
			case "Browser.close":
				// Never close the user's browser; acknowledge and ignore.
				this.#log("refusing Browser.close from downstream client", { conn: conn.id });
				this.#reply(conn, msg, {});
				return;
			case "Browser.setDownloadBehavior":
				this.#reply(conn, msg, {});
				return;
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the omp browser relay");
				return;
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	// ---- extension events -------------------------------------------------------

	#onCdpEvent(
		tabKey: string,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(child, tabKey);
			}
		} else if (method === "Target.detachedFromTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.delete(child);
				this.#realSessionTabs.delete(child);
			}
		}
		if (sourceSessionId) {
			// Event from a real child session: pass through verbatim to every
			// connection that observes this tab.
			const payload = JSON.stringify({ sessionId: sourceSessionId, method, params });
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabKey, "page").length > 0) conn.socket.send(payload);
			}
			return;
		}
		if (method.startsWith("Runtime.")) {
			const createdContext = method === "Runtime.executionContextCreated" ? params?.context : undefined;
			const createdContextId =
				createdContext &&
				typeof createdContext === "object" &&
				"id" in createdContext &&
				typeof createdContext.id === "number"
					? createdContext.id
					: undefined;
			const destroyedContextId =
				method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number"
					? params.executionContextId
					: undefined;
			if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
			if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
			if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

			for (const conn of this.#conns.values()) {
				for (const [pageSession, ref] of conn.sessions) {
					if (ref.kind !== "page" || ref.tabKey !== tabKey) continue;
					if (destroyedContextId !== undefined) ref.runtimeContexts.delete(destroyedContextId);
					if (method === "Runtime.executionContextsCleared") ref.runtimeContexts.clear();
					// `default` sessions never enabled Runtime but still get the
					// legacy fan-out; only an explicit `Runtime.disable` silences one.
					if (ref.runtimeState === "disabled") continue;
					if (createdContextId !== undefined) {
						if (ref.runtimeContexts.has(createdContextId)) continue;
						ref.runtimeContexts.add(createdContextId);
					}
					conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
				}
			}
			return;
		}
		// Other root-session events fan out once per minted page session.
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabKey, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
			}
		}
	}

	#onTabDetached(tabKey: string, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		// Explicit source attribution comes from the extension that executed
		// chrome.debugger.detach, so socket replacement cannot confuse this
		// with a user cancellation or mutate an unrelated attach promise.
		if (relayInitiated) {
			// A replacement hello can observe the old attachment before the
			// pending detach completes. Reconcile that stale snapshot unless a
			// later attach has already superseded this detach.
			if (!tab.reattachedAfterDetach) tab.attached = false;
			return;
		}
		this.#log("tab detached", { tabKey, reason });
		tab.attached = false;
		tab.attaching = null;
		this.#resetRuntime(tab);
		tab.banned = true;
		// The user dismissed the debugger infobar (or the attach was torn
		// down): release the tab's omp-group membership too.
		this.#syncTabGrouping(tab);
		this.#retractTab(tab);
	}

	#onTabRemoved(tabKey: string): void {
		const tab = this.#tabs.get(tabKey);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabKey);
		for (const conn of this.#conns.values()) conn.claims.delete(tabKey);
	}

	#onTabUpsert(snap: TabSnapshot, instanceId: string, opts: { silent?: boolean } = {}): void {
		const inst = this.#instances.get(instanceId);
		if (!inst) return;
		const key = tabKeyOf(inst.code, snap.tabId);
		let tab = this.#tabs.get(key);
		const becameActive = snap.active && (!tab || !tab.active || tab.windowId !== snap.windowId);
		if (!tab) {
			tab = new TabState(instanceId, inst.code, snap.tabId, snap);
			this.#tabs.set(key, tab);
		} else {
			if (tab.url !== snap.url) tab.banned = false;
			// The user dragging a tab out of the omp group is an opt-out; the
			// relay never fights the user over grouping.
			if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
				tab.grouped = false;
				tab.groupOptOut = true;
			}
			tab.update(snap);
		}
		if (becameActive) {
			for (const other of this.#tabs.values()) {
				if (other !== tab && other.instanceId === instanceId && other.windowId === snap.windowId)
					other.active = false;
			}
		}
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		this.#syncTabGrouping(tab);
		if (eligible && !tab.announced && !tab.discarded) {
			tab.announced = true;
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
			for (const conn of this.#conns.values()) {
				if (!conn.autoAttach) continue;
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) return;
					if (tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabKey) !== tab) {
						this.#retractTab(tab);
						this.#detachIfUnheld(tab.tabKey);
						return;
					}
					this.#emitTabAttached(conn, tab);
				});
			}
			return;
		}
		if ((!eligible || tab.discarded) && tab.announced) {
			// Puppeteer waits for attachments to announced targets.
			this.#retractTab(tab);
			this.#detachIfUnheld(tab.tabKey);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
		}
	}

	// ---- tab grouping -----------------------------------------------------------

	/** A tab belongs in the omp group when claimed by a client, controllable, unpinned, not user-opted-out, and not already in a user group. */
	#groupWorthy(tab: TabState): boolean {
		if (!this.#claimed(tab.tabKey) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
		return tab.grouped || tab.groupId === -1;
	}

	/** Re-group every claimed tab (extension hello / reconnect). */
	#syncGrouping(): void {
		if (!this.#group) return;
		const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping);
		if (worthy.length > 0) this.#requestGroup(worthy);
	}

	/** Reconcile one tab's group membership after a lifecycle event. */
	#syncTabGrouping(tab: TabState): void {
		if (!this.#group) return;
		if (this.#groupWorthy(tab)) {
			if (!tab.grouped && !tab.grouping) this.#requestGroup([tab]);
			return;
		}
		if (tab.grouped) {
			tab.grouped = false;
			tab.ompGroupId = undefined;
			void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }, this.#instanceFor(tab)).catch(() => {});
		}
	}

	/**
	 * Queue tabs for grouping and drain serially. Overlapping group RPCs race
	 * the extension's non-atomic query→create→set-title sequence and mint
	 * duplicate omp groups, so at most one group RPC is ever in flight.
	 */
	#requestGroup(tabs: TabState[]): void {
		if (!this.#group) return;
		for (const tab of tabs) {
			tab.grouping = true;
			this.#groupQueue.push(tab);
		}
		if (!this.#groupDraining) void this.#drainGroupQueue();
	}

	async #drainGroupQueue(): Promise<void> {
		const group = this.#group;
		if (!group) return;
		this.#groupDraining = true;
		try {
			while (this.#groupQueue.length > 0) {
				const batch = this.#groupQueue.splice(0);
				// Group RPCs address tabs by chrome tabId within one browser
				// instance, so a mixed batch is split per instance.
				const byInstance = new Map<string, TabState[]>();
				for (const tab of batch) {
					const tabs = byInstance.get(tab.instanceId);
					if (tabs) tabs.push(tab);
					else byInstance.set(tab.instanceId, [tab]);
				}
				for (const [instanceId, tabs] of byInstance) {
					const inst = this.#instances.get(instanceId);
					if (!inst?.socket) {
						for (const tab of tabs) tab.grouping = false;
						continue;
					}
					const tabIds = tabs.map(tab => tab.tabId);
					try {
						const result = await this.#rpc({ op: "group", tabIds, title: group.title, color: group.color }, inst);
						// Extension replies { grouped: { [tabId]: groupId } }; validate per entry.
						const grouped: Record<string, unknown> =
							result &&
							typeof result === "object" &&
							"grouped" in result &&
							result.grouped &&
							typeof result.grouped === "object"
								? (result.grouped as Record<string, unknown>)
								: {};
						for (const tab of tabs) {
							const groupId = grouped[String(tab.tabId)];
							if (typeof groupId !== "number") continue;
							tab.grouped = true;
							tab.ompGroupId = groupId;
						}
						this.#log("grouped tabs", { instanceId, tabIds, grouped });
					} catch (err) {
						this.#log("tab grouping failed", { error: err instanceof Error ? err.message : String(err) });
					} finally {
						for (const tab of tabs) tab.grouping = false;
					}
				}
			}
		} finally {
			this.#groupDraining = false;
		}
	}

	/** Tear a tab out of every downstream connection (closed, detached, or now ineligible). */
	#retractTab(tab: TabState): void {
		for (const realSession of tab.realSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabKey, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabKey, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetIdFromKey(tab.tabKey) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", {
					sessionId: tabSession,
					targetId: tabTargetIdFromKey(tab.tabKey),
				});
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetIdFromKey(tab.tabKey) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetIdFromKey(tab.tabKey) });
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tab: TabState): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tab.tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabKey: tab.tabKey,
			tabId: tab.tabId,
			runtimeState: "default",
			runtimeContexts: new Set(),
			runtimeEnabling: null,
			runtimeEpoch: 0,
		});
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		const targetId = ref.kind === "tab" ? tabTargetIdFromKey(ref.tabKey) : pageTargetIdFromKey(ref.tabKey);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabKey);
	}

	/**
	 * Release the tab's chrome.debugger attachment once no downstream session
	 * holds it. Inert while the long-lived registry connection still holds one.
	 */
	#detachIfUnheld(tabKey: string): void {
		if (this.#sessionHolders(tabKey).length > 0) return;
		const tab = this.#tabs.get(tabKey);
		if (!tab?.attached) return;
		tab.attached = false;
		this.#resetRuntime(tab);
		tab.reattachedAfterDetach = false;
		const done = this.#rpc({ op: "detach", tabId: tab.tabId }, this.#instanceFor(tab))
			.then(() => {})
			.catch(() => {})
			.finally(() => {
				if (tab.detaching === done) tab.detaching = null;
			});
		tab.detaching = done;
	}

	#resetRuntime(tab: TabState): void {
		tab.runtimeContexts.clear();
		tab.rootRuntimeEnabled = false;
		tab.rootRuntimeEnabling = null;
		tab.runtimeGeneration++;
	}

	/** Connections currently holding any session on a tab. */
	#sessionHolders(tabKey: string): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabKey).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (conn.sessionsForTab(tab.tabKey, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab);
		this.#emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.#tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	async #ensureAttached(tab: TabState): Promise<boolean> {
		// The extension emits the detach echo before resolving the RPC. Awaiting
		// prevents a replacement attach racing either operation.
		while (tab.detaching) await tab.detaching;
		if (tab.attached) return true;
		const inst = this.#instances.get(tab.instanceId);
		if (tab.banned || !inst?.socket) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId }, inst)
			.then(() => {
				tab.attached = true;
				tab.reattachedAfterDetach = true;
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabKey: tab.tabKey,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!(err instanceof ExtensionReplacedError)) tab.banned = true;
				return false;
			})
			.finally(() => {
				tab.attaching = null;
			});
		tab.attaching = attempt;
		return await attempt;
	}

	#eligible(tab: TabState): boolean {
		if (tab.banned) return false;
		// A browser whose extension socket is gone cannot be driven; hide its
		// tabs from discovery until the instance reconnects.
		if (!this.#instances.get(tab.instanceId)?.socket) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetIdFromKey(tab.tabKey),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetIdFromKey(tab.tabKey),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	// ---- plumbing ---------------------------------------------------------------

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	/** The extension instance a tab belongs to; throws if the browser vanished. */
	#instanceFor(tab: TabState): ExtInstance {
		const inst = this.#instances.get(tab.instanceId);
		if (!inst) throw new Error("relay extension is not connected");
		return inst;
	}

	#rpc(req: RelayRpcRequest, inst: ExtInstance, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		if (!inst.socket) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(`${inst.instanceId}:${id}`);
			reject(new Error(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(`${inst.instanceId}:${id}`, { resolve, reject, timer });
		inst.socket.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
