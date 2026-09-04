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
	tabId: number;
	runtimeState: RuntimeState;
	/** Context ids already announced to this pseudo-session. */
	readonly runtimeContexts: Set<number>;
	/** In-flight `Runtime.enable` for this session; duplicates await it. */
	runtimeEnabling: Promise<void> | null;
	/** Monotonic ownership token for enable rollback and replay. */
	runtimeEpoch: number;
}

interface SessionRootSubscription {
	method: string;
	params?: Record<string, unknown>;
	ownerSessionId: string;
	/** Preserves the original cross-session command order during recovery replay. */
	sequence: number;
	/** Field-level update order for partial setters like Emulation.setEmulatedMedia. */
	fieldSequences?: Record<string, number>;
}

interface PreservedPreloadScript {
	ownerSessionId: string;
	/** Stable identifier returned to the downstream page session. */
	clientIdentifier: string;
	/** Current root-side identifier, remapped after recovery replay. */
	rootIdentifier: string;
	params?: Record<string, unknown>;
	/** Main-frame document that already received an immediate invocation. */
	loaderId?: string;
	sequence: number;
}

function subscriptionKey(method: string): string {
	switch (method) {
		case "Emulation.setTouchEmulationEnabled":
		case "Page.setTouchEmulationEnabled":
			return "TouchEmulationEnabled";
		case "Emulation.setDeviceMetricsOverride":
		case "Page.setDeviceMetricsOverride":
		case "Emulation.clearDeviceMetricsOverride":
		case "Page.clearDeviceMetricsOverride":
			return "DeviceMetricsOverride";
		case "Emulation.setGeolocationOverride":
		case "Page.setGeolocationOverride":
		case "Emulation.clearGeolocationOverride":
		case "Page.clearGeolocationOverride":
			return "GeolocationOverride";
		case "Emulation.clearIdleOverride":
			return "Emulation.setIdleOverride";
		case "Emulation.resetPageScaleFactor":
			return "Emulation.setPageScaleFactor";
		case "Network.setUserAgentOverride":
		case "Emulation.setUserAgentOverride":
			return "UserAgentOverride";
		case "Network.clearAcceptedEncodings":
			return "Network.setAcceptedEncodings";
		default:
			return method;
	}
}

function mergeSubscriptionParams(
	key: string,
	previous: Record<string, unknown> | undefined,
	next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (key !== "Emulation.setEmulatedMedia") return next;
	return { ...previous, ...next };
}

function mergeSubscriptionFieldSequences(
	key: string,
	previous: Record<string, number> | undefined,
	nextParams: Record<string, unknown> | undefined,
	sequence: number,
): Record<string, number> | undefined {
	if (key !== "Emulation.setEmulatedMedia" || !nextParams) return previous;
	const merged = { ...previous };
	for (const field of Object.keys(nextParams)) merged[field] = sequence;
	return merged;
}

function isNeutralNetworkConditions(params: Record<string, unknown> | undefined): boolean {
	if (!params) return false;
	return (
		params.offline === false &&
		params.latency === 0 &&
		params.downloadThroughput === -1 &&
		params.uploadThroughput === -1 &&
		(params.connectionType === undefined || params.connectionType === "none") &&
		(params.packetLoss === undefined || params.packetLoss === 0) &&
		(params.packetQueueLength === undefined || params.packetQueueLength === 0) &&
		(params.packetReordering === undefined || params.packetReordering === false)
	);
}

function isEmptyUserAgentOverride(params: Record<string, unknown> | undefined): boolean {
	return typeof params?.userAgent === "string" && params.userAgent === "";
}

function isDefaultHardwareConcurrency(
	params: Record<string, unknown> | undefined,
	defaultHardwareConcurrency: number | undefined,
): boolean {
	return (
		typeof defaultHardwareConcurrency === "number" &&
		Number.isInteger(defaultHardwareConcurrency) &&
		defaultHardwareConcurrency > 0 &&
		params?.hardwareConcurrency === defaultHardwareConcurrency
	);
}

function subscriptionClearedFields(
	key: string,
	params: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
	if (key !== "Emulation.setEmulatedMedia" || !params) return undefined;
	const cleared: Record<string, number> = {};
	if ("media" in params && params.media === "") cleared.media = 0;
	if ("features" in params && Array.isArray(params.features) && params.features.length === 0) cleared.features = 0;
	return Object.keys(cleared).length > 0 ? cleared : undefined;
}

function applySubscriptionUpdate(
	key: string,
	base: Record<string, unknown> | undefined,
	update: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (key !== "Emulation.setEmulatedMedia") return update ?? base;
	const merged = { ...base };
	for (const [field, value] of Object.entries(update ?? {})) {
		if (field === "media" && value === "") {
			delete merged.media;
			continue;
		}
		if (field === "features" && Array.isArray(value) && value.length === 0) {
			delete merged.features;
			continue;
		}
		merged[field] = value;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function reconcileSubscriptionParams(
	key: string,
	previous: Record<string, unknown> | undefined,
	next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (key !== "Emulation.setEmulatedMedia") return next;
	const params = { ...next };
	if (previous && "media" in previous && (!next || !("media" in next))) params.media = "";
	if (previous && "features" in previous && (!next || !("features" in next))) params.features = [];
	return Object.keys(params).length > 0 ? params : undefined;
}

function subscriptionParamsEqual(
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown> | undefined,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function subscriptionEquals(
	left: SessionRootSubscription | undefined,
	right: SessionRootSubscription | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.method === right.method &&
		left.ownerSessionId === right.ownerSessionId &&
		left.sequence === right.sequence &&
		subscriptionParamsEqual(left.params, right.params)
	);
}

function mergeSubscriptionChanges(
	existing: Array<{
		key: string;
		previous: SessionRootSubscription | undefined;
		next: SessionRootSubscription | undefined;
	}>,
	incoming: Array<{
		key: string;
		previous: SessionRootSubscription | undefined;
		next: SessionRootSubscription | undefined;
	}>,
): Array<{
	key: string;
	previous: SessionRootSubscription | undefined;
	next: SessionRootSubscription | undefined;
}> {
	const merged = new Map<
		string,
		{
			key: string;
			previous: SessionRootSubscription | undefined;
			next: SessionRootSubscription | undefined;
		}
	>();
	for (const change of existing) merged.set(change.key, change);
	for (const change of incoming) {
		const prior = merged.get(change.key);
		merged.set(change.key, {
			key: change.key,
			previous: prior?.previous ?? change.previous,
			next: change.next,
		});
	}
	return [...merged.values()];
}

function subscriptionChangeEquals(
	left: {
		previous: SessionRootSubscription | undefined;
		next: SessionRootSubscription | undefined;
	},
	right: {
		previous: SessionRootSubscription | undefined;
		next: SessionRootSubscription | undefined;
	},
): boolean {
	return subscriptionEquals(left.previous, right.previous) && subscriptionEquals(left.next, right.next);
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
	readonly claims = new Set<number>();

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabId: number, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

/** Transport loss is retryable and must not permanently ban a tab. */
class ExtensionReplacedError extends Error {}

/** A timed-out RPC may already have mutated Chrome even though its result was lost. */
class ExtensionRpcTimeoutError extends Error {}

function isExtensionTransportInterrupted(error: unknown): boolean {
	return (
		error instanceof ExtensionReplacedError ||
		error instanceof ExtensionRpcTimeoutError ||
		(error instanceof Error && error.message === "relay extension disconnected")
	);
}

class TabState {
	url: string;
	title: string;
	active: boolean;
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
	/** Root Runtime was enabled before a detach and must be restored for default sessions. */
	restoreRootRuntime = false;
	rootRuntimeEnabling: Promise<void> | null = null;
	/** Invalidates an in-flight Runtime enable when the debugger detaches. */
	runtimeGeneration = 0;
	/** Increments whenever Chrome reports a newly created JavaScript context. */
	contextGeneration = 0;
	/** Monotonic main-frame navigation token independent of Runtime events. */
	mainFrameNavigationGeneration = 0;
	/** URL observed before an extension outage, for navigation-aware recovery. */
	recoveryStartUrl: string | null = null;
	/** Main-frame loader observed by the extension when recovery began. */
	recoveryStartLoaderId: string | undefined;
	/** Replays preserved page-session subscriptions after a guard-authorized attach. */
	restoring: Promise<void> | null = null;
	/** Extension socket the in-flight `restoring` replay is bound to (null when idle). */
	restoringExt: RelaySocket | null = null;
	/** Serializes live root-state cleanup after owner loss while the tab stays attached. */
	subscriptionReconciling: Promise<void> | null = null;
	/** Live root-state cleanup interrupted by extension replacement; retry on the next hello. */
	pendingSubscriptionReconcile: Array<{
		key: string;
		previous: SessionRootSubscription | undefined;
		next: SessionRootSubscription | undefined;
	}> = [];
	/** Replacement recovery needs one post-replay retry for a queued live cleanup. */
	resumeSubscriptionReconcileAfterRestore = false;
	/** Recovery replay must complete, including after an extension socket replacement. */
	restorePending = false;
	/** Retry preload replay on a fresh Chrome root after an ambiguous transport swap. */
	forceFreshRootBeforeReplay = false;
	/**
	 * A relay-initiated refresh detach was actually issued and its result was lost
	 * to a socket drop. Distinct from {@link forceFreshRootBeforeReplay}, which is
	 * armed the moment an ambiguous RPC is interrupted — before any refresh detach
	 * runs. Only an in-flight refresh detach explains why the extension dropped the
	 * tab from `recoverableTabIds`; without it, a non-recoverable signal is a
	 * genuine user detach that must be honored.
	 */
	refreshDetachInFlight = false;
	/** Effective root-domain state by subscription key and owning page pseudo-session. */
	readonly subscriptions = new Map<string, Map<string, SessionRootSubscription>>();
	/** Tab-wide clear tombstones for partial setters like Emulation.setEmulatedMedia. */
	readonly subscriptionClears = new Map<string, Record<string, number>>();
	/** In-flight root-state commands by subscription key. */
	readonly pendingSubscriptions = new Map<string, Set<Promise<void>>>();
	/** Preserved per-session preload scripts from Page.addScriptToEvaluateOnNewDocument. */
	readonly preloadScripts = new Map<string, Map<string, PreservedPreloadScript>>();
	/** Live cleanup of replayed preload scripts whose owner disappeared. */
	preloadScriptCleaning: Promise<void> | null = null;
	/** Root identifiers that must be removed once recovery / attach settles. */
	pendingPreloadScriptCleanup: PreservedPreloadScript[] = [];

	constructor(
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
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

function _platformFromUserAgent(userAgent: string): string | undefined {
	if (!userAgent) return undefined;
	if (userAgent.includes("Android")) return "Android";
	if (userAgent.includes("Mac OS X")) return "MacIntel";
	if (userAgent.includes("Linux")) return "Linux";
	if (userAgent.includes("Windows")) return "Win32";
	return undefined;
}

function hasObjectKeys(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function tabTargetId(tabId: number): string {
	return `TAB${tabId}`;
}

function pageTargetId(tabId: number): string {
	return `PAGE${tabId}`;
}

/** Reverse of {@link tabTargetId}/{@link pageTargetId}; null for foreign ids. */
function parseTargetId(targetId: string): { kind: "tab" | "page"; tabId: number } | null {
	const match = /^(TAB|PAGE)(\d+)$/.exec(targetId);
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

/**
 * Multiplexing CDP bridge between downstream puppeteer connections and the
 * relay extension. One instance per relay server; all state lives here so an
 * extension service-worker restart only has to re-handshake.
 */
export class RelayBridge {
	#tabs = new Map<number, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#subscriptionSeq = 0;
	#rpcSeq = 0;
	#ext: RelaySocket | null = null;
	#extInfo: {
		userAgent: string;
		browserVersion: string;
		hardwareConcurrency?: number;
	} | null = null;
	#pendingRpc = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout;
		}
	>();
	/** Real child session id → owning tab, learned from `Target.attachedToTarget` events. */
	#realSessionTabs = new Map<string, number>();
	/** Waiters released when the next extension hello completes (or the socket drops). */
	#helloWaiters: Array<() => void> = [];
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
		return this.#ext !== null && this.#extInfo !== null;
	}

	/** Payload for `GET /json/version`. */
	versionInfo(wsUrl: string): Record<string, string> {
		const ua = this.#extInfo?.userAgent ?? "";
		return {
			Browser: this.#extInfo?.browserVersion ?? "Chrome/unknown",
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
				id: pageTargetId(tab.tabId),
				type: "page",
				title: tab.title,
				url: tab.url,
			});
		}
		return out;
	}

	// ---- extension lifecycle -------------------------------------------------

	#rejectPendingExtensionRpcs(error: Error): void {
		for (const pending of this.#pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pendingRpc.clear();
	}

	/** A new extension socket connected; replaces any previous one. */
	extConnected(socket: RelaySocket): void {
		if (this.#ext && this.#ext !== socket) {
			this.#log("replacing extension socket");
			for (const tab of this.#tabs.values()) {
				tab.recoveryStartUrl = tab.url;
				if (tab.rootRuntimeEnabled) tab.restoreRootRuntime = true;
				this.#resetRuntime(tab);
			}
			this.#rejectPendingExtensionRpcs(new ExtensionReplacedError());
			this.#ext.close();
			// The replacement's hello has not landed yet, so its handshake state is
			// unknown until then. Drop the previous socket's `#extInfo` now: a later
			// `extClosed(oldSocket)` is ignored (`this.#ext !== socket`), so this is
			// the only point that clears the stale handshake. Without it,
			// `#forwardToTab`'s hello gate (`this.#ext && !this.#extInfo`) still sees
			// the old info and forwards a surviving-session command onto the
			// not-yet-recovered target, which Chrome rejects after an orphan sweep.
			this.#extInfo = null;
		}
		this.#ext = socket;
	}

	extClosed(socket: RelaySocket): void {
		if (this.#ext !== socket) return;
		this.#ext = null;
		this.#extInfo = null;
		this.#rejectPendingExtensionRpcs(new Error("relay extension disconnected"));
		for (const tab of this.#tabs.values()) {
			tab.recoveryStartUrl = tab.url;
			if (tab.rootRuntimeEnabled) tab.restoreRootRuntime = true;
			tab.attached = false;
			tab.attaching = null;
			tab.restoring = null;
			tab.restoringExt = null;
			tab.subscriptionReconciling = null;
			this.#resetRuntime(tab);
			// The extension dissolves omp groups on disconnect (or died along
			// with them); grouping state is unknowable until the next hello.
			// Without this reset, the next hello's groupId=-1 snapshots would
			// read as the user dragging every tab out (permanent opt-out).
			tab.grouped = false;
			tab.grouping = false;
			tab.ompGroupId = undefined;
		}
		this.#groupQueue.length = 0;
		// A fresh socket may reconnect and deliver its hello; a command that raced
		// in during the gap should re-evaluate against the reconnect state rather
		// than block forever. Wake current waiters — #forwardToTab re-checks
		// readiness and either proceeds or re-waits on the next socket.
		const waiters = this.#helloWaiters;
		this.#helloWaiters = [];
		for (const wake of waiters) wake();
	}

	extMessage(socket: RelaySocket, raw: string): void {
		if (socket !== this.#ext) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		switch (msg.t) {
			case "hello":
				this.#onHello(msg);
				return;
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending) return;
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(msg.tabId, msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabRemoved":
				this.#onTabRemoved(msg.tabId);
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	#onHello(msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		this.#extInfo = {
			userAgent: msg.userAgent,
			browserVersion: msg.browserVersion,
			hardwareConcurrency: msg.hardwareConcurrency,
		};
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		// An older extension predates the orphan guard and omits `recoverableTabIds`
		// entirely. Absent metadata is not the same as an explicitly empty recovery
		// list: with no signal either way we must not treat a dropped-but-held
		// attachment as a user detach (banning the tab). Fall back to the legacy
		// best-effort reattach for absent metadata; only an explicit list lets us
		// distinguish a real user detach from a guard detach.
		const hasRecoveryMetadata = msg.recoverableTabIds !== undefined;
		const recoverableNow = new Set(msg.recoverableTabIds ?? []);
		const freshRootRequiredNow = new Set(msg.freshRootRequiredTabIds ?? []);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, { silent: true });
		}
		for (const tabId of Array.from(this.#tabs.keys())) {
			if (!seen.has(tabId)) this.#onTabRemoved(tabId);
		}
		for (const tab of this.#tabs.values()) {
			tab.attached = attachedNow.has(tab.tabId);
			tab.attaching = null;
			// A same-socket hello (another tab's delayed guard detach triggering a
			// refresh) can land while this tab's replay is still in flight. A real
			// socket replacement rejects the in-flight RPCs (ExtensionReplacedError),
			// but its `restoring.finally` clears the pointer only on a later microtask,
			// so `tab.restoring` may still be set here. Distinguish by the socket the
			// replay is bound to: keep an active same-socket replay (do not relaunch a
			// second, concurrent one below); reset only when the socket actually
			// changed, so the replacement hello restarts the interrupted replay.
			const sameSocketReplay = tab.restoring !== null && tab.restoringExt === this.#ext;
			if (!sameSocketReplay) tab.recoveryStartLoaderId = msg.recoveryLoaderIds?.[String(tab.tabId)];
			if (!sameSocketReplay) tab.restoring = null;
			const holders = this.#sessionHolders(tab.tabId);
			const preserve = holders.filter(conn => !conn.autoAttach && conn.sessionsForTab(tab.tabId).length > 0);
			if (freshRootRequiredNow.has(tab.tabId) && holders.length > 0) {
				tab.forceFreshRootBeforeReplay = true;
				tab.restorePending = true;
			}
			if (tab.attached) {
				// An interrupted preload add/remove can leave Chrome's surviving root
				// carrying an orphaned (or already-removed) registration we cannot
				// dedupe. The reconnect hello still reports the debugger attached, so
				// the stale root would otherwise be reused as-is: honor the pending
				// fresh-root request here too, not just an in-flight replay resume.
				const needsRecoveryReplay = (tab.restorePending || tab.forceFreshRootBeforeReplay) && !sameSocketReplay;
				tab.resumeSubscriptionReconcileAfterRestore =
					needsRecoveryReplay && tab.pendingSubscriptionReconcile.length > 0;
				if (tab.pendingSubscriptionReconcile.length > 0) {
					this.#scheduleLiveSubscriptionReconcile(tab, tab.pendingSubscriptionReconcile);
				}
				this.#scheduleLivePreloadScriptCleanup(tab);
				if (holders.length === 0 && (!hasRecoveryMetadata || recoverableNow.has(tab.tabId))) {
					this.#detachIfUnheld(tab.tabId);
					continue;
				}
				if (needsRecoveryReplay) {
					// A socket replacement can interrupt replay after Chrome accepted only
					// part of it. The replacement hello still reports the debugger attached,
					// so resume the pending journal instead of treating the root as ready.
					// A forced fresh root must also replay the surviving holders' state
					// onto the new root, so mark the journal pending before recovery.
					if (tab.forceFreshRootBeforeReplay) tab.restorePending = true;
					this.#pruneSubscriptions(tab, preserve);
					this.#prunePreloadScripts(tab, preserve);
					this.#startTabRecovery(tab, false, preserve);
				}
				continue;
			}
			if (holders.length === 0) {
				// No downstream session can need recovery anymore. If the orphan
				// guard already detached this root, consume any stale fresh-root
				// authorization now so a future holder is not detached on a later
				// hello for work that belonged to the departed owner.
				tab.forceFreshRootBeforeReplay = false;
				tab.refreshDetachInFlight = false;
				tab.restorePending = false;
				tab.recoveryStartUrl = null;
				tab.recoveryStartLoaderId = undefined;
				if (hasRecoveryMetadata && recoverableNow.has(tab.tabId)) {
					void this.#rpc({ op: "forgetRecovery", tabId: tab.tabId }).catch(err => {
						this.#log("failed to release unheld recovery marker", {
							tabId: tab.tabId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
				continue;
			}
			// A relay-initiated detach can trigger a same-socket hello before the
			// original recovery task receives its detach RPC result. That task already
			// owns the reattach and journal replay; starting another here would replay
			// additive state twice. Let the active same-socket task continue.
			if (sameSocketReplay) continue;
			if (!hasRecoveryMetadata) {
				// Legacy extension without orphan-guard metadata: a service-worker
				// restart can drop attachments while downstream connections still
				// hold sessions. Restore them best-effort — the same behavior this
				// reconciliation replaced — instead of misreading a dropped hold as a
				// user detach.
				tab.restorePending = preserve.length > 0;
				this.#retractTab(tab, preserve);
				this.#announceTab(tab, true, preserve);
				continue;
			}
			if (!recoverableNow.has(tab.tabId)) {
				// A forced-root refresh performs its own relay-initiated detach, which
				// removes the tab from the extension's `recoverableTabIds`. If the
				// socket then drops after that detach but before the reattach, the
				// replacement hello lands here with an unattached, non-recoverable tab
				// even though recovery is still in progress. Only an actually-issued
				// refresh detach (`refreshDetachInFlight`) explains that missing
				// recovery signal: preserve the sessions and finish the reattach below.
				// A bare `forceFreshRootBeforeReplay` (armed the instant an ambiguous
				// RPC was interrupted, before any refresh detach ran) does NOT, so a
				// user Cancel / DevTools takeover during that window is still honored.
				if (!tab.refreshDetachInFlight) {
					// The user detached while the extension socket was down. Invalidate
					// the relay's stale sessions without fighting the explicit opt-out.
					tab.forceFreshRootBeforeReplay = false;
					this.#onTabDetached(tab.tabId, "detached_while_disconnected", false);
					continue;
				}
			}
			// A guard detach creates a fresh Chrome root session, so every real child
			// session (OOPIF/worker) tied to the old root must be torn down. But any
			// Target.attachToTarget holder that never enabled setAutoAttach keeps a
			// long-lived page pseudo-session routed by tabId (not the old Chrome root
			// id), so it stays valid across the re-attach and Chrome never re-emits a
			// replacement for it. This holds whether or not the holder also called
			// setDiscoverTargets: only auto-attach clients expect a freshly minted
			// replacement session (via the autoAttachConns path below). Preserve those
			// page sessions through the retract: dropping them makes the holder's next
			// command fail "Unknown session id", and with no session left in
			// `conn.sessions` `cdpClosed` can no longer detach the debugger —
			// re-orphaning the very attachment this recovery is restoring.
			tab.restorePending = preserve.length > 0;
			this.#retractTab(tab, preserve);
			this.#announceTab(tab, true, preserve);
		}
		this.#syncGrouping();
		this.#log("extension connected", {
			tabs: this.#tabs.size,
			version: msg.browserVersion,
		});
		// Release any commands that arrived on surviving sessions after the socket
		// reopened but before this hello was processed — recovery bookkeeping
		// (retract/reattach, tab.attaching) is now in place, so they route correctly.
		const waiters = this.#helloWaiters;
		this.#helloWaiters = [];
		for (const wake of waiters) wake();
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
		const touched = new Set<number>();
		for (const [sessionId, ref] of conn.sessions) {
			touched.add(ref.tabId);
			if (ref.kind === "page") {
				this.#forgetSessionSubscriptions(ref.tabId, [sessionId]);
				this.#forgetSessionPreloadScripts(ref.tabId, [sessionId]);
			}
		}
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
		for (const tabId of touched) this.#detachIfUnheld(tabId);
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
		const realTab = this.#realSessionTabs.get(sessionId);
		if (realTab !== undefined) {
			await this.#forwardToTab(conn, msg, realTab, sessionId);
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
		if (msg.method === "Page.addScriptToEvaluateOnNewDocument") {
			await this.#handlePreloadScriptAdd(conn, msg, sessionId, ref);
			return;
		}
		if (msg.method === "Page.removeScriptToEvaluateOnNewDocument") {
			await this.#handlePreloadScriptRemove(conn, msg, sessionId, ref);
			return;
		}
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
			await this.#forwardToTab(conn, msg, ref.tabId, undefined, ref);
			return;
		}
		// A preserved page session can repeat `Runtime.enable` in the reconnect
		// window — after the replacement socket opened but before its hello lands.
		// At that point `ref.runtimeState` still reflects the pre-outage `enabled`,
		// so the fast path below would ack without re-cycling; recovery then resets
		// the fresh root (Runtime disabled) and drops this ref back to `default`,
		// leaving the client silently un-enabled with no execution-context events.
		// Gate on the complete recovery (hello, attach, and subscription replay) so
		// the state read below is current and an enabled fast-path cannot outrun the
		// fresh root's Runtime.enable.
		await this.#awaitTabReady(ref.tabId);
		if (conn.sessions.get(sessionId) !== ref) {
			this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
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

	async #handlePreloadScriptAdd(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		await this.#awaitTabReady(ref.tabId);
		if (conn.sessions.get(sessionId) !== ref) {
			this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
			return;
		}
		const tab = this.#tabs.get(ref.tabId);
		if (!tab) {
			this.#replyError(conn, msg, `No tab with id ${ref.tabId}`);
			return;
		}
		const loaderId =
			msg.params?.runImmediately === true
				? await this.#mainFrameLoaderId(ref.tabId).catch(() => undefined)
				: undefined;
		let result: Record<string, unknown> | undefined;
		try {
			result = (await this.#rpc({
				op: "send",
				tabId: ref.tabId,
				method: msg.method,
				params: msg.params,
			})) as Record<string, unknown> | undefined;
		} catch (err) {
			// Chrome may have accepted this initial additive registration before the
			// socket dropped and the result never reached us. We never learned its
			// root identifier, so the registration is active but unjournaled — a
			// retry would install a duplicate and closing the owner cannot remove an
			// unknown script. Force the tab back to a known root on the next
			// recovery so the orphaned registration is dropped before any replay.
			if (isExtensionTransportInterrupted(err)) tab.forceFreshRootBeforeReplay = true;
			throw err;
		}
		const rootIdentifier = result?.identifier;
		if (typeof rootIdentifier !== "string") {
			this.#replyError(conn, msg, "Page.addScriptToEvaluateOnNewDocument did not return an identifier");
			return;
		}
		if (conn.sessions.get(sessionId) !== ref) {
			this.#enqueuePreloadScriptCleanup(tab, [
				{
					ownerSessionId: sessionId,
					clientIdentifier: rootIdentifier,
					rootIdentifier,
					params: msg.params,
					sequence: 0,
				},
			]);
			this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
			return;
		}
		const clientIdentifier = `preload:${ref.tabId}:${++this.#sessionSeq}`;
		this.#rememberPreloadScript(tab, sessionId, clientIdentifier, rootIdentifier, msg.params, loaderId);
		this.#reply(conn, msg, { ...result, identifier: clientIdentifier });
	}

	async #handlePreloadScriptRemove(
		conn: CdpConnection,
		msg: CdpCommand,
		sessionId: string,
		ref: SessionRef,
	): Promise<void> {
		await this.#awaitTabReady(ref.tabId);
		if (conn.sessions.get(sessionId) !== ref) {
			this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
			return;
		}
		const tab = this.#tabs.get(ref.tabId);
		if (!tab) {
			this.#replyError(conn, msg, `No tab with id ${ref.tabId}`);
			return;
		}
		const clientIdentifier = typeof msg.params?.identifier === "string" ? msg.params.identifier : undefined;
		const script = clientIdentifier ? this.#preloadScript(tab, sessionId, clientIdentifier) : undefined;
		const params = script && clientIdentifier ? { ...msg.params, identifier: script.rootIdentifier } : msg.params;
		try {
			await this.#rpc({
				op: "send",
				tabId: ref.tabId,
				method: msg.method,
				params,
			});
		} catch (err) {
			// Chrome may have accepted this removal before the socket dropped and
			// the result never reached us. The stable client identifier now points
			// at a root identifier Chrome has already dropped, so retries fail and a
			// later guard recovery would replay the stale journal entry and
			// resurrect the explicitly removed script. Treat the interrupted
			// transport as ambiguous: forget the entry so recovery cannot revive it,
			// and force a fresh root so the tab returns to a known registration set.
			if (isExtensionTransportInterrupted(err)) {
				if (script && clientIdentifier) this.#forgetPreloadScript(tab, sessionId, clientIdentifier);
				tab.forceFreshRootBeforeReplay = true;
			}
			throw err;
		}
		if (script && clientIdentifier) this.#forgetPreloadScript(tab, sessionId, clientIdentifier);
		this.#reply(conn, msg, {});
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
		const tab = this.#tabs.get(ref.tabId);
		if (!tab) {
			ref.runtimeState = prev;
			throw new Error(`No tab with id ${ref.tabId}`);
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
		// Same reconnect ordering hazard as #forwardToTab: a preserved page session
		// can drive Runtime.enable before the replacement hello lands or before the
		// recovery attach resolves. These are direct `send` RPCs, so without the gate
		// Chrome receives Runtime.disable/enable on a still-detached target and
		// rejects the initialization. Wait for the tab to settle (hello + attach,
		// looping across any socket swap) before cycling.
		await this.#awaitTabReady(tab.tabId);
		await this.#rpc({
			op: "send",
			tabId: tab.tabId,
			method: "Runtime.disable",
		});
		await this.#rpc({ op: "send", tabId: tab.tabId, method: "Runtime.enable" });
	}

	#replayRuntimeContexts(conn: CdpConnection, sessionId: string, ref: SessionRef, tab: TabState): void {
		for (const [contextId, params] of tab.runtimeContexts) {
			if (ref.runtimeContexts.has(contextId)) continue;
			ref.runtimeContexts.add(contextId);
			conn.socket.send(
				JSON.stringify({
					sessionId,
					method: "Runtime.executionContextCreated",
					params,
				}),
			);
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabId: number,
		realSessionId: string | undefined,
		pageRef?: SessionRef,
	): Promise<void> {
		// Guard rail: a page session must never take the whole browser down.
		if (msg.method === "Browser.close") {
			this.#reply(conn, msg, {});
			return;
		}
		// A preserved page session can outlive a Chrome root swap. Two ordering
		// hazards follow a reconnect, both of which would forward this command onto
		// a detached Chrome target and get it rejected:
		//   1. The replacement socket has opened but its hello has not reached the
		//      bridge yet, so recovery bookkeeping (retract/reattach) has not run and
		//      `tab.attaching` is still null — the attach-gate below would be skipped.
		//   2. The hello ran and armed a debugger reattach (#ensureAttached sets
		//      `tab.attaching`) that resolves asynchronously; forwarding now would
		//      race chrome.debugger.attach().
		// A third, compounding hazard: while we await attach A a *second* socket can
		// replace the connection and arm a new hello + attach B. Awaiting only A and
		// then sending would still race B's chrome.debugger.attach(). Loop until the
		// tab settles against the current socket (hello delivered, attach quiesced).
		await this.#awaitTabReady(tabId);
		if (!this.#forwardingSessionIsCurrent(conn, msg, tabId, realSessionId, pageRef)) {
			this.#replyError(conn, msg, `Unknown session id ${String(msg.sessionId)}`);
			return;
		}
		// Relay-private claim: the omp tab worker marks the page it was spawned
		// to drive. Never forwarded — real Chrome rejects the unknown method. It
		// still waits for recovery and revalidates above so a retracted auto-attach
		// session cannot claim the tab after a replacement hello.
		if (msg.method === "OMP.claimTarget") {
			this.#claimTab(conn, tabId);
			this.#reply(conn, msg, {});
			return;
		}
		const pendingSubscription = pageRef && msg.sessionId ? this.#trackPendingSubscription(tabId, msg) : null;
		try {
			const result = await this.#rpc({
				op: "send",
				tabId,
				sessionId: realSessionId,
				method: msg.method,
				params: msg.params,
			});
			const forwardingSessionIsCurrent = this.#forwardingSessionIsCurrent(conn, msg, tabId, realSessionId, pageRef);
			if (pageRef && msg.sessionId) {
				this.#recordSubscription(tabId, msg, msg.sessionId, forwardingSessionIsCurrent);
			}
			pendingSubscription?.resolve();
			if (pageRef && msg.sessionId && !forwardingSessionIsCurrent) {
				await this.#cleanupOrphanedCompletedSubscription(tabId, msg);
			}
			if (!forwardingSessionIsCurrent) {
				this.#replyError(conn, msg, `Unknown session id ${String(msg.sessionId)}`);
				return;
			}
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
		} catch (err) {
			pendingSubscription?.resolve();
			// Chrome may have accepted a tracked shared-root setter (e.g.
			// `Fetch.enable`) before the socket dropped and its result never reached
			// us. Because #recordSubscription runs only on the success path above,
			// the journal never learns about that state: a quick reconnect would
			// reuse a root carrying an untracked subscription that owner cleanup
			// cannot disable and recovery cannot reproduce. Treat the interrupted
			// tracked setter as ambiguous and force a fresh-root reconciliation, as
			// the preload handlers already do for interrupted registrations.
			if (pendingSubscription && isExtensionTransportInterrupted(err)) {
				const tab = this.#tabs.get(tabId);
				if (tab) {
					// A tab-wide clear (a `<domain>.disable`, an explicit clear/reset, a
					// removed binding, or a neutral-value setter) is doubly ambiguous when
					// interrupted: Chrome may have already applied it while the journal
					// still records the prior enable/override under the same key. Because
					// #recordSubscription runs only on the success path, that stale entry
					// survives, and a fresh-root replay would resurrect the very state the
					// caller explicitly cleared. Forget the journal entry so recovery
					// cannot revive it before forcing the fresh root below.
					const clearedKey = this.#interruptedClearKey(msg);
					if (clearedKey) {
						this.#forgetTabSubscription(tab, clearedKey);
					} else {
						// Emulation.setEmulatedMedia can clear one field while leaving
						// another intact. Preserve those field-level tombstones when the
						// result is interrupted so fresh-root replay cannot resurrect the
						// caller's explicitly cleared media or features value.
						const key = this.#subscriptionTrackingKey(msg);
						if (key) {
							const clears = subscriptionClearedFields(key, msg.params);
							if (clears) this.#rememberTabSubscriptionClear(tab, key, clears, ++this.#subscriptionSeq);
						}
					}
					tab.forceFreshRootBeforeReplay = true;
				}
			}
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		}
	}

	#trackPendingSubscription(tabId: number, msg: CdpCommand): { resolve: () => void } | null {
		const tab = this.#tabs.get(tabId);
		const key = this.#subscriptionTrackingKey(msg);
		if (!tab || !key) return null;
		const { promise, resolve } = Promise.withResolvers<void>();
		let pending = tab.pendingSubscriptions.get(key);
		if (!pending) {
			pending = new Set();
			tab.pendingSubscriptions.set(key, pending);
		}
		pending.add(promise);
		return {
			resolve: () => {
				resolve();
				pending?.delete(promise);
				if (pending && pending.size === 0) tab.pendingSubscriptions.delete(key);
			},
		};
	}

	async #cleanupOrphanedCompletedSubscription(tabId: number, msg: CdpCommand): Promise<void> {
		const tab = this.#tabs.get(tabId);
		const key = this.#subscriptionTrackingKey(msg);
		if (!tab || !key) return;
		if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tabId).length === 0) return;
		const expectedExt = this.#ext;
		if (!expectedExt) return;
		const orphaned = {
			method: msg.method,
			params: msg.params,
			ownerSessionId: typeof msg.sessionId === "string" ? msg.sessionId : "",
			sequence: 0,
		} satisfies SessionRootSubscription;
		const disable = this.#subscriptionDisableCommand(orphaned);
		if (!disable) return;
		await this.#awaitPendingSubscriptions(tab, key);
		if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tabId).length === 0) return;
		const current = this.#latestSubscriptionForKey(tab, key);
		const previous =
			key === "Emulation.setEmulatedMedia"
				? {
						...orphaned,
						params: applySubscriptionUpdate(key, current?.params, orphaned.params),
					}
				: orphaned;
		this.#scheduleLiveSubscriptionReconcile(tab, [{ key, previous, next: current }]);
	}

	#forwardingSessionIsCurrent(
		conn: CdpConnection,
		msg: CdpCommand,
		tabId: number,
		realSessionId: string | undefined,
		pageRef: SessionRef | undefined,
	): boolean {
		if (pageRef) return typeof msg.sessionId === "string" && conn.sessions.get(msg.sessionId) === pageRef;
		if (realSessionId) return this.#realSessionTabs.get(realSessionId) === tabId;
		return true;
	}

	/**
	 * Remember successful commands that changed the shared Chrome root state.
	 *
	 * Tab-wide clears/disables must still win even if the issuing pseudo-session
	 * vanished before the RPC reply came back: Chrome already applied the change
	 * to the shared debugger root, so recovery must not replay older state.
	 * Owner-bound enables/setters, however, should only be journaled while the
	 * originating pseudo-session is still live.
	 */
	#recordSubscription(tabId: number, msg: CdpCommand, ownerSessionId: string, ownerIsCurrent: boolean): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		const separator = msg.method.indexOf(".");
		const domain = separator > 0 ? msg.method.slice(0, separator) : "";
		const command = separator > 0 ? msg.method.slice(separator + 1) : "";
		if (domain && domain !== "Runtime" && (command === "enable" || command === "disable")) {
			const key = `${domain}.enable`;
			if (command === "disable") {
				tab.subscriptions.delete(key);
			} else if (ownerIsCurrent) {
				this.#rememberSessionSubscription(tab, key, ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
			}
			return;
		}

		// Runtime.addBinding installs a named binding on the shared debugger root
		// (Puppeteer's page.exposeFunction pairs it with a preload wrapper script).
		// The preload half is already journaled, but without tracking the binding a
		// guard-authorized root replacement replays the wrapper onto a fresh root
		// that never re-registers the binding, so the exposed function silently
		// stops firing. Track each binding by name so it can be replayed, and treat
		// Runtime.removeBinding as its tab-wide clear.
		if (msg.method === "Runtime.addBinding" || msg.method === "Runtime.removeBinding") {
			const name = typeof msg.params?.name === "string" ? msg.params.name : undefined;
			if (!name) return;
			const key = `Runtime.addBinding:${name}`;
			if (msg.method === "Runtime.removeBinding") {
				this.#forgetTabSubscription(tab, key);
				return;
			}
			if (!ownerIsCurrent) return;
			this.#rememberSessionSubscription(tab, key, ownerSessionId, {
				method: msg.method,
				params: msg.params,
				ownerSessionId,
				sequence: ++this.#subscriptionSeq,
			});
			return;
		}

		let enabled: boolean | undefined;
		switch (msg.method) {
			case "Target.setAutoAttach":
				enabled = msg.params?.autoAttach === true;
				break;
			case "Target.setDiscoverTargets":
				enabled = msg.params?.discover === true;
				break;
			case "Page.setLifecycleEventsEnabled":
				enabled = msg.params?.enabled === true;
				break;
			case "Network.setCacheDisabled":
				enabled = msg.params?.cacheDisabled === true;
				break;
			case "Page.setBypassCSP":
			case "Emulation.setTouchEmulationEnabled":
			case "Page.setTouchEmulationEnabled":
			case "Input.setInterceptDrags":
			case "Page.setInterceptFileChooserDialog":
			case "Emulation.setAutomationOverride":
				enabled = msg.params?.enabled === true;
				break;
			case "Network.setExtraHTTPHeaders": {
				const headers = msg.params?.headers;
				if (!hasObjectKeys(headers)) {
					this.#forgetTabSubscription(tab, msg.method);
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, msg.method, ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			}
			case "Network.setBlockedURLs": {
				const urls = msg.params?.urls;
				const urlPatterns = msg.params?.urlPatterns;
				if (
					(!Array.isArray(urls) || urls.length === 0) &&
					(!Array.isArray(urlPatterns) || urlPatterns.length === 0)
				) {
					this.#forgetTabSubscription(tab, msg.method);
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, msg.method, ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			}
			case "Emulation.setEmulatedMedia":
			case "Emulation.setLocaleOverride":
			case "Emulation.setFocusEmulationEnabled":
			case "Emulation.setScrollbarsHidden":
			case "Emulation.setEmulatedVisionDeficiency": {
				if (
					!hasObjectKeys(msg.params) ||
					(msg.method === "Emulation.setFocusEmulationEnabled" && msg.params?.enabled === false) ||
					(msg.method === "Emulation.setScrollbarsHidden" && msg.params?.hidden === false) ||
					(msg.method === "Emulation.setLocaleOverride" && msg.params?.locale === "") ||
					(msg.method === "Emulation.setEmulatedVisionDeficiency" && msg.params?.type === "none")
				) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				const key = subscriptionKey(msg.method);
				const sequence = ++this.#subscriptionSeq;
				if (msg.method === "Emulation.setEmulatedMedia") {
					const clears = subscriptionClearedFields(key, msg.params);
					if (clears) this.#rememberTabSubscriptionClear(tab, key, clears, sequence);
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, key, ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence,
				});
				return;
			}
			case "Emulation.setTimezoneOverride":
				if (msg.params?.timezoneId === "") {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Emulation.setCPUThrottlingRate":
				if (msg.params?.rate === 1) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Emulation.setScriptExecutionDisabled":
				if (msg.params?.value === false) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Emulation.clearDeviceMetricsOverride":
			case "Page.clearDeviceMetricsOverride":
				this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
				return;
			case "Emulation.clearGeolocationOverride":
			case "Page.clearGeolocationOverride":
			case "Emulation.clearIdleOverride":
			case "Emulation.resetPageScaleFactor":
				this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
				return;
			case "Network.setBypassServiceWorker":
				if (msg.params?.bypass === false) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Security.setIgnoreCertificateErrors":
				if (msg.params?.ignore === false) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Emulation.setDeviceMetricsOverride":
			case "Page.setDeviceMetricsOverride":
			case "Emulation.setGeolocationOverride":
			case "Page.setGeolocationOverride":
			case "Emulation.setIdleOverride":
			case "Emulation.setHardwareConcurrencyOverride":
			case "Network.setUserAgentOverride":
			case "Emulation.setUserAgentOverride":
			case "Emulation.setDefaultBackgroundColorOverride":
			case "Emulation.setPageScaleFactor":
			case "Network.setAcceptedEncodings":
				// Persistent root setters survive as long as the shared debugger root.
				// When a guard-authorized detach swaps that root, replay the latest
				// winning command for each setter so preserved pseudo-sessions keep the
				// state they previously established.
				if (
					(msg.method === "Network.setUserAgentOverride" || msg.method === "Emulation.setUserAgentOverride") &&
					isEmptyUserAgentOverride(msg.params)
				) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (
					msg.method === "Emulation.setHardwareConcurrencyOverride" &&
					isDefaultHardwareConcurrency(msg.params, this.#extInfo?.hardwareConcurrency)
				) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (msg.method === "Emulation.setDefaultBackgroundColorOverride" && !hasObjectKeys(msg.params)) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			case "Network.clearAcceptedEncodings":
				this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
				return;
			case "Network.emulateNetworkConditions":
				// Chrome keeps a single throttling profile on the shared root, so a
				// neutral restore (online, no latency, unlimited throughput) resets the
				// whole tab regardless of which session sent it. Treat it as a tab-wide
				// clear so a departed owner's stale offline/throttled state cannot be
				// revived from another session's journal after the neutral command won.
				if (isNeutralNetworkConditions(msg.params)) {
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					return;
				}
				if (!ownerIsCurrent) return;
				this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
					method: msg.method,
					params: msg.params,
					ownerSessionId,
					sequence: ++this.#subscriptionSeq,
				});
				return;
			default:
				return;
		}
		if (!enabled) {
			switch (msg.method) {
				case "Target.setAutoAttach":
				case "Target.setDiscoverTargets":
				case "Page.setLifecycleEventsEnabled":
				case "Network.setCacheDisabled":
				case "Page.setBypassCSP":
				case "Emulation.setTouchEmulationEnabled":
				case "Page.setTouchEmulationEnabled":
				case "Input.setInterceptDrags":
				case "Page.setInterceptFileChooserDialog":
				case "Emulation.setAutomationOverride":
					this.#forgetTabSubscription(tab, subscriptionKey(msg.method));
					break;
				default:
					this.#forgetSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId);
					break;
			}
			return;
		}
		if (!ownerIsCurrent) return;
		this.#rememberSessionSubscription(tab, subscriptionKey(msg.method), ownerSessionId, {
			method: msg.method,
			params: msg.params,
			ownerSessionId,
			sequence: ++this.#subscriptionSeq,
		});
	}

	#rememberSessionSubscription(
		tab: TabState,
		key: string,
		ownerSessionId: string,
		subscription: SessionRootSubscription,
	): void {
		let owners = tab.subscriptions.get(key);
		if (!owners) {
			owners = new Map();
			tab.subscriptions.set(key, owners);
		}
		const previous = owners.get(ownerSessionId);
		owners.set(ownerSessionId, {
			...subscription,
			params: mergeSubscriptionParams(key, previous?.params, subscription.params),
			fieldSequences: mergeSubscriptionFieldSequences(
				key,
				previous?.fieldSequences,
				subscription.params,
				subscription.sequence,
			),
		});
	}

	#rememberTabSubscriptionClear(tab: TabState, key: string, clears: Record<string, number>, sequence: number): void {
		const merged = { ...tab.subscriptionClears.get(key) };
		for (const field of Object.keys(clears)) merged[field] = sequence;
		tab.subscriptionClears.set(key, merged);
	}

	#forgetSessionSubscription(tab: TabState, key: string, ownerSessionId: string): void {
		const owners = tab.subscriptions.get(key);
		if (!owners) return;
		owners.delete(ownerSessionId);
		if (owners.size === 0) tab.subscriptions.delete(key);
	}

	#forgetTabSubscription(tab: TabState, key: string): void {
		tab.subscriptions.delete(key);
		tab.subscriptionClears.delete(key);
	}

	#rememberPreloadScript(
		tab: TabState,
		ownerSessionId: string,
		clientIdentifier: string,
		rootIdentifier: string,
		params: Record<string, unknown> | undefined,
		loaderId?: string,
	): void {
		let scripts = tab.preloadScripts.get(ownerSessionId);
		if (!scripts) {
			scripts = new Map();
			tab.preloadScripts.set(ownerSessionId, scripts);
		}
		scripts.set(clientIdentifier, {
			ownerSessionId,
			clientIdentifier,
			rootIdentifier,
			params,
			loaderId,
			sequence: ++this.#subscriptionSeq,
		});
	}

	#preloadScript(tab: TabState, ownerSessionId: string, clientIdentifier: string): PreservedPreloadScript | undefined {
		return tab.preloadScripts.get(ownerSessionId)?.get(clientIdentifier);
	}

	#forgetPreloadScript(
		tab: TabState,
		ownerSessionId: string,
		clientIdentifier: string,
	): PreservedPreloadScript | undefined {
		const scripts = tab.preloadScripts.get(ownerSessionId);
		if (!scripts) return undefined;
		const script = scripts.get(clientIdentifier);
		if (!script) return undefined;
		scripts.delete(clientIdentifier);
		if (scripts.size === 0) tab.preloadScripts.delete(ownerSessionId);
		return script;
	}

	#enqueuePreloadScriptCleanup(tab: TabState, scripts: PreservedPreloadScript[]): void {
		if (scripts.length === 0) return;
		tab.pendingPreloadScriptCleanup.push(...scripts);
		this.#scheduleLivePreloadScriptCleanup(tab);
	}

	#scheduleLivePreloadScriptCleanup(tab: TabState): void {
		if (tab.pendingPreloadScriptCleanup.length === 0) return;
		if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tab.tabId).length === 0) return;
		const expectedExt = this.#ext;
		if (!expectedExt) return;
		const prior = tab.preloadScriptCleaning ?? Promise.resolve();
		const task = prior
			.catch(() => {})
			.then(async () => {
				while (true) {
					if (tab.pendingPreloadScriptCleanup.length === 0) return;
					if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tab.tabId).length === 0)
						return;
					const script = tab.pendingPreloadScriptCleanup[0];
					this.#assertExtensionCurrent(expectedExt);
					try {
						await this.#rpc({
							op: "send",
							tabId: tab.tabId,
							method: "Page.removeScriptToEvaluateOnNewDocument",
							params: { identifier: script.rootIdentifier },
						});
					} catch (err) {
						// A transport swap must abort the whole loop so the pending
						// queue survives for the replacement hello to retry.
						if (isExtensionTransportInterrupted(err)) throw err;
						// A single identifier can legitimately fail to remove — e.g. a
						// stale old-root identifier queued before a recovery replay
						// minted a fresh one on the new root. Drop only that entry and
						// keep draining the rest; clearing the entire queue here would
						// strand later, still-valid cleanups (such as the freshly
						// replayed script) active without an owner.
						this.#assertExtensionCurrent(expectedExt);
						if (tab.pendingPreloadScriptCleanup[0] === script) tab.pendingPreloadScriptCleanup.shift();
						this.#log("preload script cleanup entry failed", {
							tabId: tab.tabId,
							identifier: script.rootIdentifier,
							error: err instanceof Error ? err.message : String(err),
						});
						continue;
					}
					this.#assertExtensionCurrent(expectedExt);
					if (tab.pendingPreloadScriptCleanup[0] === script) tab.pendingPreloadScriptCleanup.shift();
				}
			})
			.catch(err => {
				if (isExtensionTransportInterrupted(err)) return;
				tab.pendingPreloadScriptCleanup = [];
				this.#log("preload script cleanup failed", {
					tabId: tab.tabId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		tab.preloadScriptCleaning = task.finally(() => {
			if (tab.preloadScriptCleaning === task) tab.preloadScriptCleaning = null;
		});
	}

	#forgetSessionPreloadScripts(tabId: number, sessionIds: Iterable<string>): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		const removed: PreservedPreloadScript[] = [];
		for (const sessionId of sessionIds) {
			const scripts = tab.preloadScripts.get(sessionId);
			if (!scripts) continue;
			removed.push(...scripts.values());
			tab.preloadScripts.delete(sessionId);
		}
		this.#enqueuePreloadScriptCleanup(tab, removed);
	}

	#forgetSessionSubscriptions(tabId: number, sessionIds: Iterable<string>): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		const previousByKey = new Map<string, SessionRootSubscription | undefined>();
		for (const key of tab.subscriptions.keys()) {
			previousByKey.set(key, this.#latestSubscriptionForKey(tab, key));
		}
		for (const sessionId of sessionIds) {
			for (const [key, owners] of tab.subscriptions) {
				owners.delete(sessionId);
				if (owners.size === 0) tab.subscriptions.delete(key);
			}
		}
		const changes = [...previousByKey.entries()]
			.map(([key, previous]) => ({
				key,
				previous,
				next: this.#latestSubscriptionForKey(tab, key),
			}))
			.filter(({ previous, next }) => !subscriptionEquals(previous, next));
		this.#scheduleLiveSubscriptionReconcile(tab, changes);
	}

	#scheduleLiveSubscriptionReconcile(
		tab: TabState,
		changes: Array<{
			key: string;
			previous: SessionRootSubscription | undefined;
			next: SessionRootSubscription | undefined;
		}>,
	): void {
		if (changes.length === 0) return;
		tab.pendingSubscriptionReconcile = mergeSubscriptionChanges(tab.pendingSubscriptionReconcile, changes);
		if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tab.tabId).length === 0) return;
		const expectedExt = this.#ext;
		if (!expectedExt) return;
		const prior = tab.subscriptionReconciling ?? Promise.resolve();
		const task = prior
			.catch(() => {})
			.then(async () => {
				while (true) {
					if (!tab.attached || tab.detaching || tab.restoring || this.#sessionHolders(tab.tabId).length === 0)
						return;
					this.#assertExtensionCurrent(expectedExt);
					const change = [...tab.pendingSubscriptionReconcile].sort((left, right) => {
						const leftSeq = left.next?.sequence ?? left.previous?.sequence ?? Number.MAX_SAFE_INTEGER;
						const rightSeq = right.next?.sequence ?? right.previous?.sequence ?? Number.MAX_SAFE_INTEGER;
						return leftSeq - rightSeq;
					})[0];
					if (!change) return;
					await this.#awaitPendingSubscriptions(tab, change.key);
					const queued = tab.pendingSubscriptionReconcile.find(candidate => candidate.key === change.key);
					if (!queued) continue;
					const current = this.#latestSubscriptionForKey(tab, change.key);
					if (!subscriptionEquals(current, queued.next)) {
						if (subscriptionChangeEquals(queued, change)) {
							tab.pendingSubscriptionReconcile = tab.pendingSubscriptionReconcile.filter(
								candidate => candidate.key !== change.key,
							);
						}
						continue;
					}
					const command = this.#subscriptionReconcileCommand(queued.previous, current);
					if (!command) {
						if (subscriptionChangeEquals(queued, change)) {
							tab.pendingSubscriptionReconcile = tab.pendingSubscriptionReconcile.filter(
								candidate => candidate.key !== change.key,
							);
						}
						continue;
					}
					this.#assertExtensionCurrent(expectedExt);
					try {
						await this.#rpc({
							op: "send",
							tabId: tab.tabId,
							method: command.method,
							params: command.params,
						});
					} catch (err) {
						// A transport swap must abort the loop so every queued change
						// survives for the replacement hello. A normal CDP failure only
						// invalidates the attempted key; keep draining unrelated cleanup.
						if (isExtensionTransportInterrupted(err)) throw err;
						this.#assertExtensionCurrent(expectedExt);
						const failed = tab.pendingSubscriptionReconcile.find(candidate => candidate.key === change.key);
						if (failed && subscriptionChangeEquals(failed, queued)) {
							tab.pendingSubscriptionReconcile = tab.pendingSubscriptionReconcile.filter(
								candidate => candidate.key !== change.key,
							);
						}
						this.#log("live subscription cleanup entry failed", {
							tabId: tab.tabId,
							key: change.key,
							error: err instanceof Error ? err.message : String(err),
						});
						continue;
					}
					this.#assertExtensionCurrent(expectedExt);
					const after = tab.pendingSubscriptionReconcile.find(candidate => candidate.key === change.key);
					if (after && subscriptionChangeEquals(after, queued)) {
						tab.pendingSubscriptionReconcile = tab.pendingSubscriptionReconcile.filter(
							candidate => candidate.key !== change.key,
						);
					}
				}
			})
			.catch(err => {
				if (isExtensionTransportInterrupted(err)) return;
				tab.pendingSubscriptionReconcile = [];
				this.#log("live subscription cleanup failed", {
					tabId: tab.tabId,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		tab.subscriptionReconciling = task.finally(() => {
			if (tab.subscriptionReconciling === task) tab.subscriptionReconciling = null;
		});
	}

	#pruneSubscriptions(tab: TabState, keepPageSessions: CdpConnection[]): void {
		const liveSessions = new Set<string>();
		for (const conn of keepPageSessions) {
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) liveSessions.add(pageSession);
		}
		if (liveSessions.size === 0) {
			tab.subscriptions.clear();
			return;
		}
		for (const [key, owners] of tab.subscriptions) {
			for (const ownerSessionId of owners.keys()) {
				if (!liveSessions.has(ownerSessionId)) owners.delete(ownerSessionId);
			}
			if (owners.size === 0) tab.subscriptions.delete(key);
		}
	}

	#prunePreloadScripts(tab: TabState, keepPageSessions: CdpConnection[]): void {
		const liveSessions = new Set<string>();
		for (const conn of keepPageSessions) {
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) liveSessions.add(pageSession);
		}
		if (liveSessions.size === 0) {
			tab.preloadScripts.clear();
			tab.pendingPreloadScriptCleanup = [];
			return;
		}
		const removed: PreservedPreloadScript[] = [];
		for (const [ownerSessionId, scripts] of tab.preloadScripts) {
			if (liveSessions.has(ownerSessionId)) continue;
			removed.push(...scripts.values());
			tab.preloadScripts.delete(ownerSessionId);
		}
		this.#enqueuePreloadScriptCleanup(tab, removed);
	}

	#sessionOwnsTab(conn: CdpConnection, tabId: number, sessionId: string): boolean {
		const ref = conn.sessions.get(sessionId);
		return ref?.kind === "page" && ref.tabId === tabId;
	}

	#latestSubscriptionForKey(tab: TabState, key: string): SessionRootSubscription | undefined {
		const owners = tab.subscriptions.get(key);
		if (!owners && !tab.subscriptionClears.has(key)) return undefined;
		if (!owners) return undefined;
		const ordered = [...owners.values()].sort((left, right) => left.sequence - right.sequence);
		const latest = ordered.at(-1);
		if (!latest) return undefined;
		if (key !== "Emulation.setEmulatedMedia") return latest;
		const params: Record<string, unknown> = {};
		const fieldSequences: Record<string, number> = {};
		const fieldOwners: Record<string, string> = {};
		for (const subscription of ordered) {
			for (const [field, sequence] of Object.entries(subscription.fieldSequences ?? {})) {
				const existingSequence = fieldSequences[field];
				if (existingSequence !== undefined && existingSequence >= sequence) continue;
				if (subscription.params && field in subscription.params) {
					params[field] = subscription.params[field];
					fieldSequences[field] = sequence;
					fieldOwners[field] = subscription.ownerSessionId;
				}
			}
		}
		for (const [field, sequence] of Object.entries(tab.subscriptionClears.get(key) ?? {})) {
			const existingSequence = fieldSequences[field];
			if (existingSequence === undefined || existingSequence <= sequence) {
				delete params[field];
				delete fieldSequences[field];
				delete fieldOwners[field];
			}
		}
		if (Object.keys(params).length === 0) return undefined;
		const latestField = Object.entries(fieldSequences)
			.sort((left, right) => left[1] - right[1])
			.at(-1);
		return {
			...latest,
			ownerSessionId: latestField ? fieldOwners[latestField[0]] : latest.ownerSessionId,
			sequence: latestField?.[1] ?? latest.sequence,
			params: Object.keys(params).length > 0 ? params : undefined,
			fieldSequences: Object.keys(fieldSequences).length > 0 ? fieldSequences : undefined,
		};
	}

	async #awaitPendingSubscriptions(tab: TabState, key: string): Promise<void> {
		while (true) {
			const pending = tab.pendingSubscriptions.get(key);
			if (!pending || pending.size === 0) return;
			await Promise.allSettled(pending);
		}
	}

	#subscriptionTrackingKey(msg: CdpCommand): string | undefined {
		const separator = msg.method.indexOf(".");
		const domain = separator > 0 ? msg.method.slice(0, separator) : "";
		const command = separator > 0 ? msg.method.slice(separator + 1) : "";
		if (domain && domain !== "Runtime" && (command === "enable" || command === "disable")) {
			return `${domain}.enable`;
		}
		if (msg.method === "Runtime.addBinding" || msg.method === "Runtime.removeBinding") {
			const name = typeof msg.params?.name === "string" ? msg.params.name : undefined;
			return name ? `Runtime.addBinding:${name}` : undefined;
		}
		switch (msg.method) {
			case "Target.setAutoAttach":
			case "Target.setDiscoverTargets":
			case "Page.setLifecycleEventsEnabled":
			case "Network.setCacheDisabled":
			case "Page.setBypassCSP":
			case "Emulation.setTouchEmulationEnabled":
			case "Page.setTouchEmulationEnabled":
			case "Input.setInterceptDrags":
			case "Page.setInterceptFileChooserDialog":
			case "Emulation.setAutomationOverride":
			case "Network.setExtraHTTPHeaders":
			case "Network.setBlockedURLs":
			case "Emulation.setEmulatedMedia":
			case "Emulation.setLocaleOverride":
			case "Emulation.setTimezoneOverride":
			case "Emulation.setFocusEmulationEnabled":
			case "Emulation.setScrollbarsHidden":
			case "Emulation.setDefaultBackgroundColorOverride":
			case "Emulation.setPageScaleFactor":
			case "Emulation.resetPageScaleFactor":
			case "Emulation.setHardwareConcurrencyOverride":
			case "Emulation.setEmulatedVisionDeficiency":
			case "Emulation.setCPUThrottlingRate":
			case "Emulation.setScriptExecutionDisabled":
			case "Emulation.clearDeviceMetricsOverride":
			case "Page.clearDeviceMetricsOverride":
			case "Emulation.clearGeolocationOverride":
			case "Page.clearGeolocationOverride":
			case "Emulation.clearIdleOverride":
			case "Emulation.setDeviceMetricsOverride":
			case "Page.setDeviceMetricsOverride":
			case "Emulation.setGeolocationOverride":
			case "Page.setGeolocationOverride":
			case "Emulation.setIdleOverride":
			case "Network.emulateNetworkConditions":
			case "Network.setBypassServiceWorker":
			case "Network.setUserAgentOverride":
			case "Emulation.setUserAgentOverride":
			case "Network.setAcceptedEncodings":
			case "Network.clearAcceptedEncodings":
			case "Security.setIgnoreCertificateErrors":
				return subscriptionKey(msg.method);
			default:
				return undefined;
		}
	}

	// Mirrors the tab-wide "forget" branches of #recordSubscription: returns the
	// journal key a command clears (its `<domain>.enable`, per-name binding, or
	// tracked setter key) when the command resets tab state rather than
	// establishing it. Used by the interruption handler so an interrupted clear
	// forgets the prior enable/override it was meant to undo, since
	// #recordSubscription never ran to record the clear itself.
	#interruptedClearKey(msg: CdpCommand): string | undefined {
		const separator = msg.method.indexOf(".");
		const domain = separator > 0 ? msg.method.slice(0, separator) : "";
		const command = separator > 0 ? msg.method.slice(separator + 1) : "";
		if (domain && domain !== "Runtime" && command === "disable") {
			return this.#subscriptionTrackingKey(msg);
		}
		if (msg.method === "Runtime.removeBinding") {
			return this.#subscriptionTrackingKey(msg);
		}
		let cleared: boolean;
		switch (msg.method) {
			case "Emulation.clearDeviceMetricsOverride":
			case "Page.clearDeviceMetricsOverride":
			case "Emulation.clearGeolocationOverride":
			case "Page.clearGeolocationOverride":
			case "Emulation.clearIdleOverride":
			case "Emulation.resetPageScaleFactor":
			case "Network.clearAcceptedEncodings":
				cleared = true;
				break;
			case "Target.setAutoAttach":
				cleared = msg.params?.autoAttach !== true;
				break;
			case "Target.setDiscoverTargets":
				cleared = msg.params?.discover !== true;
				break;
			case "Page.setLifecycleEventsEnabled":
				cleared = msg.params?.enabled !== true;
				break;
			case "Network.setCacheDisabled":
				cleared = msg.params?.cacheDisabled !== true;
				break;
			case "Page.setBypassCSP":
			case "Emulation.setTouchEmulationEnabled":
			case "Page.setTouchEmulationEnabled":
			case "Input.setInterceptDrags":
			case "Page.setInterceptFileChooserDialog":
			case "Emulation.setAutomationOverride":
				cleared = msg.params?.enabled !== true;
				break;
			case "Network.setExtraHTTPHeaders":
				cleared = !hasObjectKeys(msg.params?.headers);
				break;
			case "Network.setBlockedURLs": {
				const urls = msg.params?.urls;
				const urlPatterns = msg.params?.urlPatterns;
				cleared =
					(!Array.isArray(urls) || urls.length === 0) && (!Array.isArray(urlPatterns) || urlPatterns.length === 0);
				break;
			}
			case "Emulation.setEmulatedMedia":
			case "Emulation.setLocaleOverride":
			case "Emulation.setFocusEmulationEnabled":
			case "Emulation.setScrollbarsHidden":
			case "Emulation.setEmulatedVisionDeficiency":
				cleared =
					!hasObjectKeys(msg.params) ||
					(msg.method === "Emulation.setFocusEmulationEnabled" && msg.params?.enabled === false) ||
					(msg.method === "Emulation.setScrollbarsHidden" && msg.params?.hidden === false) ||
					(msg.method === "Emulation.setLocaleOverride" && msg.params?.locale === "") ||
					(msg.method === "Emulation.setEmulatedVisionDeficiency" && msg.params?.type === "none");
				break;
			case "Emulation.setTimezoneOverride":
				cleared = msg.params?.timezoneId === "";
				break;
			case "Emulation.setCPUThrottlingRate":
				cleared = msg.params?.rate === 1;
				break;
			case "Emulation.setScriptExecutionDisabled":
				cleared = msg.params?.value === false;
				break;
			case "Network.setBypassServiceWorker":
				cleared = msg.params?.bypass === false;
				break;
			case "Security.setIgnoreCertificateErrors":
				cleared = msg.params?.ignore === false;
				break;
			case "Network.setUserAgentOverride":
			case "Emulation.setUserAgentOverride":
				cleared = isEmptyUserAgentOverride(msg.params);
				break;
			case "Emulation.setHardwareConcurrencyOverride":
				cleared = isDefaultHardwareConcurrency(msg.params, this.#extInfo?.hardwareConcurrency);
				break;
			case "Emulation.setDefaultBackgroundColorOverride":
				cleared = !hasObjectKeys(msg.params);
				break;
			case "Network.emulateNetworkConditions":
				cleared = isNeutralNetworkConditions(msg.params);
				break;
			default:
				cleared = false;
				break;
		}
		return cleared ? this.#subscriptionTrackingKey(msg) : undefined;
	}

	#isCurrentPreservedSubscription(
		tab: TabState,
		key: string,
		subscription: SessionRootSubscription,
		conns: CdpConnection[],
	): boolean {
		if (!subscriptionEquals(this.#latestSubscriptionForKey(tab, key), subscription)) return false;
		return conns.some(conn => this.#sessionOwnsTab(conn, tab.tabId, subscription.ownerSessionId));
	}

	#nextPreservedSubscription(
		tab: TabState,
		conns: CdpConnection[],
		replayed: Map<string, SessionRootSubscription>,
	): { key: string; subscription: SessionRootSubscription } | undefined {
		const subscriptions: Array<{
			key: string;
			subscription: SessionRootSubscription;
		}> = [];
		for (const key of tab.subscriptions.keys()) {
			const subscription = this.#latestSubscriptionForKey(tab, key);
			if (!subscription) continue;
			if (subscriptionEquals(replayed.get(key), subscription)) continue;
			if (!conns.some(conn => this.#sessionOwnsTab(conn, tab.tabId, subscription.ownerSessionId))) continue;
			subscriptions.push({ key, subscription });
		}
		subscriptions.sort((a, b) => a.subscription.sequence - b.subscription.sequence);
		return subscriptions[0];
	}

	async #cleanupReplayedPreservedSubscriptions(
		tab: TabState,
		conns: CdpConnection[],
		expectedExt: RelaySocket | null,
		replayed: Map<string, SessionRootSubscription>,
	): Promise<void> {
		const stale = [...replayed.entries()]
			.filter(([key, subscription]) => !this.#isCurrentPreservedSubscription(tab, key, subscription, conns))
			.sort((a, b) => a[1].sequence - b[1].sequence);
		for (const [key, subscription] of stale) {
			replayed.delete(key);
			const current = this.#latestSubscriptionForKey(tab, key);
			const command = this.#subscriptionReconcileCommand(subscription, current);
			if (!command) continue;
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({
				op: "send",
				tabId: tab.tabId,
				method: command.method,
				params: command.params,
			});
			this.#assertExtensionCurrent(expectedExt);
		}
	}

	#subscriptionReconcileCommand(
		previous: SessionRootSubscription | undefined,
		next: SessionRootSubscription | undefined,
	): { method: string; params?: Record<string, unknown> } | null {
		if (next) {
			if (previous && subscriptionEquals(next, previous)) return null;
			return {
				method: next.method,
				params: reconcileSubscriptionParams(subscriptionKey(next.method), previous?.params, next.params),
			};
		}
		return previous ? this.#subscriptionDisableCommand(previous) : null;
	}

	#subscriptionDisableCommand(
		subscription: SessionRootSubscription,
	): { method: string; params?: Record<string, unknown> } | null {
		if (subscription.method.endsWith(".enable")) {
			return {
				method: `${subscription.method.slice(0, -".enable".length)}.disable`,
			};
		}
		switch (subscription.method) {
			case "Runtime.addBinding": {
				// A binding installed on the shared root clears with its name; when the
				// preserved owner disappears after replay, remove it so surviving
				// holders do not inherit an orphaned binding on the fresh root.
				const name = typeof subscription.params?.name === "string" ? subscription.params.name : undefined;
				if (!name) return null;
				return { method: "Runtime.removeBinding", params: { name } };
			}
			case "Target.setAutoAttach": {
				// CDP requires `waitForDebuggerOnStart` on every Target.setAutoAttach
				// call, even when flipping autoAttach back off during recovery cleanup.
				// Preserve the original replay shape so owner loss does not turn the
				// cleanup into a protocol error that aborts recovery for other holders.
				const params = subscription.params ?? {};
				return {
					method: subscription.method,
					params: {
						...params,
						autoAttach: false,
						waitForDebuggerOnStart:
							typeof params.waitForDebuggerOnStart === "boolean" ? params.waitForDebuggerOnStart : false,
					},
				};
			}
			case "Target.setDiscoverTargets":
				return { method: subscription.method, params: { discover: false } };
			case "Page.setLifecycleEventsEnabled":
				return { method: subscription.method, params: { enabled: false } };
			case "Network.setUserAgentOverride":
			case "Emulation.setUserAgentOverride": {
				// These setters clear with the protocol's empty-userAgent sentinel.
				// Reconstructing a guessed default UA/platform pair can itself leave
				// an observable override behind on Chrome's shared root.
				return { method: subscription.method, params: { userAgent: "" } };
			}
			case "Network.emulateNetworkConditions":
				// Chrome keeps the throttling profile on the shared root until another
				// emulateNetworkConditions call replaces it. When the replay owner
				// disappears mid-recovery, reset the root back to neutral conditions so
				// surviving holders do not inherit an orphaned offline/throttled state.
				return {
					method: subscription.method,
					params: {
						offline: false,
						latency: 0,
						downloadThroughput: -1,
						uploadThroughput: -1,
					},
				};
			case "Network.setExtraHTTPHeaders":
				return { method: subscription.method, params: { headers: {} } };
			case "Network.setBlockedURLs":
				return {
					method: subscription.method,
					params: { urls: [], urlPatterns: [] },
				};
			case "Network.setCacheDisabled":
				return {
					method: subscription.method,
					params: { cacheDisabled: false },
				};
			case "Network.setBypassServiceWorker":
				return { method: subscription.method, params: { bypass: false } };
			case "Network.setAcceptedEncodings":
				return { method: "Network.clearAcceptedEncodings" };
			case "Security.setIgnoreCertificateErrors":
				return { method: subscription.method, params: { ignore: false } };
			case "Page.setBypassCSP":
			case "Emulation.setTouchEmulationEnabled":
			case "Page.setTouchEmulationEnabled":
			case "Input.setInterceptDrags":
			case "Page.setInterceptFileChooserDialog":
			case "Emulation.setFocusEmulationEnabled":
			case "Emulation.setAutomationOverride":
				return { method: subscription.method, params: { enabled: false } };
			case "Emulation.setScrollbarsHidden":
				return { method: subscription.method, params: { hidden: false } };
			case "Emulation.setEmulatedMedia":
				return {
					method: subscription.method,
					params:
						reconcileSubscriptionParams(subscriptionKey(subscription.method), subscription.params, undefined) ??
						{},
				};
			case "Emulation.setLocaleOverride":
				return { method: subscription.method, params: {} };
			case "Emulation.setTimezoneOverride":
				// Timezone override is another persistent root setter without a paired
				// disable RPC. When its preserved owner disappears after replay, reset
				// the shared root back to the browser default timezone.
				return { method: subscription.method, params: { timezoneId: "" } };
			case "Emulation.setDefaultBackgroundColorOverride":
				return { method: subscription.method };
			case "Emulation.setPageScaleFactor":
				return { method: "Emulation.resetPageScaleFactor" };
			case "Emulation.setHardwareConcurrencyOverride":
				if (
					typeof this.#extInfo?.hardwareConcurrency === "number" &&
					Number.isInteger(this.#extInfo.hardwareConcurrency) &&
					this.#extInfo.hardwareConcurrency > 0
				) {
					return {
						method: subscription.method,
						params: { hardwareConcurrency: this.#extInfo.hardwareConcurrency },
					};
				}
				return null;
			case "Emulation.setEmulatedVisionDeficiency":
				return { method: subscription.method, params: { type: "none" } };
			case "Emulation.setIdleOverride":
				return { method: "Emulation.clearIdleOverride" };
			case "Emulation.setCPUThrottlingRate":
				// CPU throttling is another persistent root setter without a paired
				// disable RPC. When its preserved owner disappears after replay, reset
				// the shared root back to the default no-throttle rate.
				return { method: subscription.method, params: { rate: 1 } };
			case "Emulation.setScriptExecutionDisabled":
				return { method: subscription.method, params: { value: false } };
			case "Emulation.setDeviceMetricsOverride":
				return { method: "Emulation.clearDeviceMetricsOverride" };
			case "Page.setDeviceMetricsOverride":
				return { method: "Page.clearDeviceMetricsOverride" };
			case "Emulation.setGeolocationOverride":
				return { method: "Emulation.clearGeolocationOverride" };
			case "Page.setGeolocationOverride":
				return { method: "Page.clearGeolocationOverride" };
			default:
				return null;
		}
	}

	/**
	 * Record `conn` as a driver of the tab and reconcile grouping. Claims are
	 * explicit (worker adoption or tab creation) rather than inferred from
	 * command traffic: target discovery scans every page with the same
	 * commands a driver sends, so inference would sweep all tabs.
	 */
	#claimTab(conn: CdpConnection, tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		if (!conn.claims.has(tabId)) {
			conn.claims.add(tabId);
			this.#log("tab claimed", { conn: conn.id, tabId });
		}
		this.#syncTabGrouping(tab);
	}

	/** True while any downstream connection claims the tab as its drive target. */
	#claimed(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			if (conn.claims.has(tabId)) return true;
		}
		return false;
	}

	/** Tab pseudo-sessions only exist to satisfy puppeteer's Target hierarchy. */
	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}
				// Emit before replying: puppeteer's TargetManager counts page
				// children attached before the setAutoAttach response resolves.
				const pageSession = this.#mintSession(conn, "page", tab.tabId);
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
					product: this.#extInfo?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#extInfo?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", {
						targetInfo: this.#tabInfo(tab, tab.attached),
					});
					this.#emit(conn, "Target.targetCreated", {
						targetInfo: this.#pageInfo(tab, tab.attached),
					});
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				// A replacement extension socket can open before its hello arrives.
				// Reconcile every previously known tab before an attachment command can
				// create a fresh debugger root and make the hello skip recovery.
				await Promise.all([...this.#tabs.values()].map(tab => this.#awaitTabReady(tab.tabId)));
				conn.autoAttach = true;
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab));
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab)));
				for (const tab of tabs) {
					if (!tab.attached) {
						// Attach failed (DevTools open, another debugger, …): retract
						// the target so puppeteer's init never waits on it.
						this.#retractTab(tab);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#awaitTabReady(tab.tabId);
				const currentTab = this.#tabs.get(parsed.tabId);
				if (!currentTab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (!(await this.#ensureAttached(currentTab))) {
					this.#replyError(conn, msg, `Cannot attach to tab ${currentTab.tabId} (${currentTab.url})`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, currentTab.tabId);
				const info = parsed.kind === "tab" ? this.#tabInfo(currentTab, true) : this.#pageInfo(currentTab, true);
				this.#emit(conn, "Target.attachedToTarget", {
					sessionId,
					targetInfo: info,
					waitingForDebugger: false,
				});
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
				const result = (await this.#rpc({ op: "createTab", url })) as {
					tab: TabSnapshot;
				};
				this.#onTabUpsert(result.tab);
				// Creating a tab is an explicit act of driving it.
				this.#claimTab(conn, result.tab.tabId);
				this.#reply(conn, msg, { targetId: pageTargetId(result.tab.tabId) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#rpc({ op: "removeTab", tabId: parsed.tabId });
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed) await this.#rpc({ op: "activateTab", tabId: parsed.tabId });
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
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
				this.#log("refusing Browser.close from downstream client", {
					conn: conn.id,
				});
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
		tabId: number,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		// Track real child sessions so downstream commands can route back.
		if (method === "Target.attachedToTarget") {
			const child = params?.sessionId;
			if (typeof child === "string") {
				tab.realSessions.add(child);
				this.#realSessionTabs.set(child, tabId);
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
			const payload = JSON.stringify({
				sessionId: sourceSessionId,
				method,
				params,
			});
			for (const conn of this.#conns.values()) {
				if (conn.sessionsForTab(tabId, "page").length > 0) conn.socket.send(payload);
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
			if (createdContextId !== undefined) tab.contextGeneration++;
			if (createdContextId !== undefined && params) tab.runtimeContexts.set(createdContextId, params);
			if (destroyedContextId !== undefined) tab.runtimeContexts.delete(destroyedContextId);
			if (method === "Runtime.executionContextsCleared") tab.runtimeContexts.clear();

			for (const conn of this.#conns.values()) {
				for (const [pageSession, ref] of conn.sessions) {
					if (ref.kind !== "page" || ref.tabId !== tabId) continue;
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
			for (const pageSession of conn.sessionsForTab(tabId, "page")) {
				conn.socket.send(JSON.stringify({ sessionId: pageSession, method, params }));
			}
		}
		if (method === "Page.frameNavigated") {
			const frame = params?.frame;
			if (frame && typeof frame === "object" && !("parentId" in frame)) tab.mainFrameNavigationGeneration++;
		}
	}

	#onTabDetached(tabId: number, reason: string, relayInitiated: boolean): void {
		const tab = this.#tabs.get(tabId);
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
		this.#log("tab detached", { tabId, reason });
		tab.attached = false;
		tab.attaching = null;
		tab.forceFreshRootBeforeReplay = false;
		tab.refreshDetachInFlight = false;
		this.#resetRuntime(tab);
		tab.restoreRootRuntime = false;
		tab.banned = true;
		// The user dismissed the debugger infobar (or the attach was torn
		// down): release the tab's omp-group membership too.
		this.#syncTabGrouping(tab);
		this.#retractTab(tab);
	}

	#onTabRemoved(tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabId);
		for (const conn of this.#conns.values()) conn.claims.delete(tabId);
	}

	#onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
		let tab = this.#tabs.get(snap.tabId);
		if (!tab) {
			tab = new TabState(snap.tabId, snap);
			this.#tabs.set(snap.tabId, tab);
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
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		this.#syncTabGrouping(tab);
		if (eligible && !tab.announced) {
			this.#announceTab(tab);
			return;
		}
		if (!eligible && tab.announced) {
			this.#retractTab(tab);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetInfoChanged", {
					targetInfo: this.#tabInfo(tab, tab.attached),
				});
				this.#emit(conn, "Target.targetInfoChanged", {
					targetInfo: this.#pageInfo(tab, tab.attached),
				});
			}
		}
	}

	#announceTab(tab: TabState, forceAttach = false, keepPageSessions: CdpConnection[] = []): void {
		tab.announced = true;
		for (const conn of this.#conns.values()) {
			if (!conn.discover) continue;
			// A connection whose page session was preserved through the paired
			// #retractTab never saw a Target.targetDestroyed, so re-announcing here
			// would duplicate a targetCreated for a target it still holds. Skip it:
			// its consumer-visible page lifecycle is unbroken by design.
			if (keepPageSessions.includes(conn)) continue;
			this.#emit(conn, "Target.targetCreated", {
				targetInfo: this.#tabInfo(tab, tab.attached),
			});
			this.#emit(conn, "Target.targetCreated", {
				targetInfo: this.#pageInfo(tab, tab.attached),
			});
		}
		const autoAttachConns = [...this.#conns.values()].filter(conn => conn.autoAttach);
		// Ensure the underlying debugger attachment whenever a client actually needs
		// it: auto-attach connections expect a replacement session, and recovery of a
		// still-claimed tab (forceAttach, set by #onHello) must restore the Chrome
		// attachment even when no connection uses setAutoAttach — e.g. a holder that
		// attached through Target.attachToTarget. Otherwise the guard-authorized tab
		// is re-announced but left detached, and the holder's next command fails with
		// no live attachment behind it.
		if (autoAttachConns.length === 0 && !forceAttach) return;
		this.#startTabRecovery(tab, true, keepPageSessions);
	}

	/** Attach if needed, replay pending root state, then expose replacement sessions. */
	#startTabRecovery(tab: TabState, attach: boolean, keepPageSessions: CdpConnection[]): void {
		const autoAttachConns = [...this.#conns.values()].filter(conn => conn.autoAttach);
		// Capture the socket driving this recovery. If it is replaced (or dropped)
		// while the attach is in flight, the replacement's hello re-runs
		// reconciliation, so a `false` here is a retryable transport swap — not a
		// terminal attach failure — and must not retract preserved sessions.
		const ext = this.#ext;
		let refreshedRoot = false;
		let forceFreshRoot = false;
		const contextGenerationBeforeRecovery = tab.contextGeneration;
		const urlBeforeRecovery = tab.recoveryStartUrl ?? tab.url;
		const restoring = (async () => {
			let ok: boolean;
			try {
				forceFreshRoot = tab.forceFreshRootBeforeReplay;
				refreshedRoot = forceFreshRoot || (attach && !tab.attached);
				ok = refreshedRoot
					? await this.#refreshRootForRecovery(tab, ext)
					: !attach || (await this.#ensureAttached(tab));
			} catch (err) {
				// #refreshRootForRecovery issues a relay-initiated detach whose RPC
				// rejects (ExtensionReplacedError or "relay extension disconnected")
				// when the socket drops mid-refresh — after Chrome may have already
				// executed the detach but before its result returns. That is a
				// retryable transport swap, not a terminal failure: leave the
				// preserved sessions and the recovery authorization
				// (forceFreshRootBeforeReplay) intact so the replacement hello can
				// finish the reattach instead of stranding the holder.
				if (isExtensionTransportInterrupted(err)) return;
				this.#log("fresh-root recovery detach failed", {
					tabId: tab.tabId,
					error: err instanceof Error ? err.message : String(err),
				});
				// The live extension rejected the forced detach, so this recovery cannot
				// establish a known root. Fail closed: consume the stale authorization,
				// retract every session that depended on it, and retry best-effort cleanup
				// only after no downstream holder remains.
				tab.forceFreshRootBeforeReplay = false;
				tab.restorePending = false;
				tab.refreshDetachInFlight = false;
				tab.banned = true;
				this.#retractTab(tab);
				this.#detachIfUnheld(tab.tabId, true);
				return;
			}
			if (!ok) {
				if (this.#ext !== ext) {
					// The extension socket was replaced (or closed) mid-attach: the
					// RPC rejected with ExtensionReplacedError or "relay extension
					// disconnected", not a real attach failure. Retracting now would
					// delete a preserved bare Target.attachToTarget page session before
					// the replacement hello can recover it, permanently stranding the
					// holder on "Unknown session id". Leave the sessions for that
					// hello's reconciliation to restore.
					//
					// #ensureAttached only exempts ExtensionReplacedError from banning,
					// so an ordinary "relay extension disconnected" leaves tab.banned
					// set. Clear that transient ban before returning: otherwise the
					// replacement hello's re-attach of the same-URL tab is refused and
					// the preserved sessions are ultimately retracted anyway.
					tab.banned = false;
					return;
				}
				// Reattachment failed (DevTools or another debugger claimed the tab
				// during the outage). Mirror the Target.setAutoAttach path and retract
				// the just-announced target so a discovering client never retains a
				// recreated target it can neither initialize nor drive.
				tab.forceFreshRootBeforeReplay = false;
				tab.restorePending = false;
				// The forced detach committed but this reattach failed terminally, so
				// the recovery authorization is spent. Clear refreshDetachInFlight too:
				// leaving it set would let a later genuine user detach (after a
				// navigation clears tab.banned and a fresh client attaches) be
				// misclassified by #onHello as this stale relay-initiated refresh and
				// reattached against the user's intent.
				tab.refreshDetachInFlight = false;
				this.#retractTab(tab);
				return;
			}
			if (tab.restorePending) {
				try {
					await this.#restorePreservedSubscriptions(
						tab,
						keepPageSessions,
						ext,
						refreshedRoot &&
							(tab.contextGeneration !== contextGenerationBeforeRecovery || tab.url !== urlBeforeRecovery),
						tab.recoveryStartLoaderId,
					);
				} catch (err) {
					// A replacement keeps the journal pending. Its hello restarts the
					// complete replay even when Chrome still reports the root attached,
					// repairing interruptions such as Runtime.disable without enable.
					if (this.#ext !== ext || err instanceof ExtensionReplacedError) return;
					this.#log("subscription recovery failed", {
						tabId: tab.tabId,
						error: err instanceof Error ? err.message : String(err),
					});
					// The preserved session can no longer uphold its pre-detach CDP
					// contract. Surface a real session teardown instead of leaving the
					// client silently subscribed to domains that are disabled on Chrome's
					// fresh root.
					tab.forceFreshRootBeforeReplay = false;
					tab.restorePending = false;
					this.#retractTab(tab);
					this.#detachIfUnheld(tab.tabId, true);
					return;
				}
				tab.forceFreshRootBeforeReplay = false;
				tab.restorePending = false;
				tab.recoveryStartUrl = null;
				tab.recoveryStartLoaderId = undefined;
			}
			// The user can cancel the debugger attachment while the final replay RPC
			// is in flight: #onTabDetached then bans the tab and retracts its
			// sessions, but this continuation's resolved RPC would otherwise mint
			// fresh auto-attach sessions for a now-detached tab. Those sessions look
			// usable but every forwarded command fails, and they keep the tab
			// recorded as held. Revalidate against the live state before emitting.
			if (this.#tabs.get(tab.tabId) !== tab || tab.banned || !tab.attached || this.#ext !== ext) {
				this.#detachIfUnheld(tab.tabId);
				return;
			}
			for (const conn of autoAttachConns) {
				if (this.#conns.has(conn.id)) this.#emitTabAttached(conn, tab);
			}
			// A preserved holder can disconnect while this forced recovery attach is
			// in flight: cdpClosed()'s #detachIfUnheld then runs while tab.attached is
			// still false and returns without detaching. Recheck now that the
			// attachment is live (auto-attach sessions, if any, were just minted
			// above) so a tab nobody holds anymore doesn't keep an orphaned debugger
			// attachment and its infobar.
			this.#detachIfUnheld(tab.tabId);
		})();
		const task = restoring.finally(() => {
			if (tab.restoring === task) {
				const resumeQueuedCleanup = tab.resumeSubscriptionReconcileAfterRestore;
				tab.restoring = null;
				tab.restoringExt = null;
				tab.resumeSubscriptionReconcileAfterRestore = false;
				if (resumeQueuedCleanup && tab.pendingSubscriptionReconcile.length > 0) {
					this.#scheduleLiveSubscriptionReconcile(tab, tab.pendingSubscriptionReconcile);
				}
				if (tab.pendingPreloadScriptCleanup.length > 0) this.#scheduleLivePreloadScriptCleanup(tab);
			}
		});
		tab.restoring = task;
		tab.restoringExt = ext;
	}

	/**
	 * A preload replay whose RPC result is lost across a socket swap may already
	 * have mutated Chrome, but without the returned identifier we cannot dedupe a
	 * retry on the same root. Force a fresh debugger root before replaying again.
	 */
	async #refreshRootForRecovery(tab: TabState, expectedExt: RelaySocket | null): Promise<boolean> {
		if (!tab.attached) {
			// A prior forced-root detach may have committed on the extension but lost
			// its RPC result to a socket drop, leaving `refreshDetachInFlight` set
			// while the replacement hello reports the tab unattached. The detach we
			// were authorizing has already been observed (the tab is gone), so once
			// this recovery attach settles the authorization is spent: leaving the
			// flag set would misclassify a later genuine user Cancel / DevTools
			// takeover as that stale relay-initiated detach and reattach against the
			// user's intent. Clear it only on a successful reattach so a failed
			// attempt still retries under the same authorization.
			const attached = await this.#ensureAttached(tab);
			if (attached) tab.refreshDetachInFlight = false;
			return attached;
		}
		while (tab.detaching) await tab.detaching;
		const staleRealSessions = [...tab.realSessions];
		for (const realSession of staleRealSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				const ref = conn.sessions.get(pageSession);
				if (!ref) continue;
				for (const realSession of staleRealSessions) {
					this.#emit(conn, "Target.detachedFromTarget", { sessionId: realSession }, pageSession);
				}
				ref.runtimeContexts.clear();
				ref.runtimeEnabling = null;
				ref.runtimeEpoch++;
			}
		}
		if (tab.rootRuntimeEnabled) tab.restoreRootRuntime = true;
		tab.reattachedAfterDetach = false;
		// Record that a relay-initiated detach is now committed: if its result is
		// lost to a socket drop, the extension will have dropped the tab from
		// `recoverableTabIds`, and only this flag distinguishes that guard-detach
		// side effect from a genuine user detach at the next hello.
		tab.refreshDetachInFlight = true;
		const done = (async () => {
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({ op: "detach", tabId: tab.tabId });
			this.#assertExtensionCurrent(expectedExt);
			tab.attached = false;
			this.#resetRuntime(tab);
		})().finally(() => {
			if (tab.detaching === done) tab.detaching = null;
		});
		tab.detaching = done;
		await done;
		// The forced detach committed, but the reattach can still be interrupted
		// before the extension persists a fresh recovery marker. Keep
		// `refreshDetachInFlight` set until `#ensureAttached()` succeeds so a
		// replacement hello arriving mid-reattach — tab unattached, dropped from
		// `recoverableTabIds` by this relay-initiated detach — is still recognized as
		// the in-flight refresh and preserves the sessions, instead of retracting
		// them as a user detach. This mirrors the already-unattached shortcut above.
		const attached = await this.#ensureAttached(tab);
		if (attached) tab.refreshDetachInFlight = false;
		return attached;
	}

	/** Restore root-domain state promised by page sessions preserved across recovery. */
	async #restorePreservedSubscriptions(
		tab: TabState,
		conns: CdpConnection[],
		expectedExt: RelaySocket | null,
		runImmediatePreloads: boolean,
		recoveryLoaderId?: string,
	): Promise<void> {
		const refs: SessionRef[] = [];
		for (const conn of conns) {
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				const ref = conn.sessions.get(pageSession);
				if (ref) refs.push(ref);
			}
		}
		const needsRuntimeRestore =
			refs.some(ref => ref.runtimeState === "enabled") ||
			(tab.restoreRootRuntime && refs.some(ref => ref.runtimeState === "default"));
		if (needsRuntimeRestore) {
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({
				op: "send",
				tabId: tab.tabId,
				method: "Runtime.disable",
			});
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({
				op: "send",
				tabId: tab.tabId,
				method: "Runtime.enable",
			});
			this.#assertExtensionCurrent(expectedExt);
			tab.rootRuntimeEnabled = true;
		}
		tab.restoreRootRuntime = false;
		const replayed = new Map<string, SessionRootSubscription>();
		while (true) {
			await this.#cleanupReplayedPreservedSubscriptions(tab, conns, expectedExt, replayed);
			const next = this.#nextPreservedSubscription(tab, conns, replayed);
			if (!next) break;
			const { key, subscription } = next;
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({
				op: "send",
				tabId: tab.tabId,
				method: subscription.method,
				params: subscription.params,
			});
			this.#assertExtensionCurrent(expectedExt);
			if (this.#isCurrentPreservedSubscription(tab, key, subscription, conns)) {
				replayed.set(key, subscription);
				continue;
			}
			const current = this.#latestSubscriptionForKey(tab, key);
			const command = this.#subscriptionReconcileCommand(subscription, current);
			if (!command) continue;
			this.#assertExtensionCurrent(expectedExt);
			await this.#rpc({
				op: "send",
				tabId: tab.tabId,
				method: command.method,
				params: command.params,
			});
			this.#assertExtensionCurrent(expectedExt);
		}
		await this.#cleanupReplayedPreservedSubscriptions(tab, conns, expectedExt, replayed);
		const preloadScripts = [...tab.preloadScripts.values()]
			.flatMap(scripts => [...scripts.values()])
			.filter(script => conns.some(conn => this.#sessionOwnsTab(conn, tab.tabId, script.ownerSessionId)))
			.sort((left, right) => left.sequence - right.sequence);
		const hasImmediatePreload = preloadScripts.some(script => script.params?.runImmediately === true);
		// Loader snapshots alone cannot tell whether a navigation happened before
		// or after Chrome acknowledged a non-immediate preload registration. Keep
		// Page events observable across that window even when no preserved client
		// enabled the domain; otherwise a post-ack navigation can be mistaken for a
		// missed invocation and the retry executes non-idempotent setup twice.
		const temporarilyObserveNavigations =
			hasImmediatePreload && this.#latestSubscriptionForKey(tab, "Page.enable") === undefined;
		const enablePageEvents = temporarilyObserveNavigations
			? this.#rpc({ op: "send", tabId: tab.tabId, method: "Page.enable" })
			: Promise.resolve();
		const currentLoaderPromise = hasImmediatePreload
			? this.#mainFrameLoaderId(tab.tabId).catch(() => undefined)
			: Promise.resolve(undefined);
		const [, currentLoaderId] = await Promise.all([enablePageEvents, currentLoaderPromise]);
		for (const script of preloadScripts) {
			this.#assertExtensionCurrent(expectedExt);
			const runImmediately =
				script.params?.runImmediately === true &&
				(recoveryLoaderId !== undefined && currentLoaderId !== undefined
					? recoveryLoaderId !== currentLoaderId
					: runImmediatePreloads);
			const replayParams =
				script.params && typeof script.params === "object" && "runImmediately" in script.params
					? {
							...script.params,
							runImmediately,
						}
					: script.params;
			let result: Record<string, unknown> | undefined;
			try {
				result = (await this.#rpc({
					op: "send",
					tabId: tab.tabId,
					method: "Page.addScriptToEvaluateOnNewDocument",
					params: replayParams,
				})) as Record<string, unknown> | undefined;
			} catch (err) {
				// Chrome may have accepted this additive registration before the
				// socket dropped and the result never reached us. An ordinary
				// `relay extension disconnected` is just as ambiguous as an
				// `ExtensionReplacedError` here: replaying on the surviving root
				// would leave an untracked duplicate registration that runs on every
				// future document. Force a fresh root before the next replay for any
				// interrupted transport, not just socket replacement.
				if (isExtensionTransportInterrupted(err)) tab.forceFreshRootBeforeReplay = true;
				throw err;
			}
			this.#assertExtensionCurrent(expectedExt);
			const identifier = result?.identifier;
			if (typeof identifier !== "string") {
				throw new Error("Page.addScriptToEvaluateOnNewDocument replay did not return an identifier");
			}
			let rootIdentifier = identifier;
			const contextGenerationAfterRegistration = tab.contextGeneration;
			const navigationGenerationAfterRegistration = tab.mainFrameNavigationGeneration;
			if (script.params?.runImmediately === true && !runImmediately) {
				const loaderAfterRegistration = await this.#mainFrameLoaderId(tab.tabId).catch(() => undefined);
				if (
					currentLoaderId !== undefined &&
					loaderAfterRegistration !== undefined &&
					loaderAfterRegistration !== currentLoaderId &&
					// A context created after Chrome acknowledged the registration is
					// already covered by that registration. Only retry when the loader
					// changed before acknowledgement; otherwise runImmediately would
					// execute non-idempotent preload code twice in the new document.
					tab.contextGeneration === contextGenerationAfterRegistration &&
					tab.mainFrameNavigationGeneration === navigationGenerationAfterRegistration
				) {
					let retry: Record<string, unknown> | undefined;
					try {
						await this.#rpc({
							op: "send",
							tabId: tab.tabId,
							method: "Page.removeScriptToEvaluateOnNewDocument",
							params: { identifier: rootIdentifier },
						});
						retry = (await this.#rpc({
							op: "send",
							tabId: tab.tabId,
							method: "Page.addScriptToEvaluateOnNewDocument",
							params: { ...script.params, runImmediately: true },
						})) as Record<string, unknown> | undefined;
					} catch (err) {
						if (isExtensionTransportInterrupted(err)) tab.forceFreshRootBeforeReplay = true;
						throw err;
					}
					if (typeof retry?.identifier !== "string")
						throw new Error("Page.addScriptToEvaluateOnNewDocument replay did not return an identifier");
					rootIdentifier = retry.identifier;
				}
			}
			const current = this.#preloadScript(tab, script.ownerSessionId, script.clientIdentifier);
			if (!current) {
				this.#enqueuePreloadScriptCleanup(tab, [{ ...script, rootIdentifier }]);
				continue;
			}
			current.rootIdentifier = rootIdentifier;
			if (currentLoaderId !== undefined) current.loaderId = currentLoaderId;
		}
		if (temporarilyObserveNavigations) {
			try {
				this.#assertExtensionCurrent(expectedExt);
				await this.#rpc({
					op: "send",
					tabId: tab.tabId,
					method: "Page.disable",
				});
			} catch (err) {
				// The preload replay already mutated this root. If the cleanup result
				// is lost, retry only after replacing the root so the additive
				// registration cannot be duplicated.
				if (isExtensionTransportInterrupted(err)) tab.forceFreshRootBeforeReplay = true;
				throw err;
			}
		}
		this.#scheduleLivePreloadScriptCleanup(tab);
	}

	async #mainFrameLoaderId(tabId: number): Promise<string | undefined> {
		const result = (await this.#rpc({
			op: "send",
			tabId,
			method: "Page.getFrameTree",
		})) as { frameTree?: { frame?: { loaderId?: unknown } } } | undefined;
		const loaderId = result?.frameTree?.frame?.loaderId;
		return typeof loaderId === "string" ? loaderId : undefined;
	}

	#assertExtensionCurrent(expected: RelaySocket | null): void {
		if (this.#ext !== expected) throw new ExtensionReplacedError();
	}

	// ---- tab grouping -----------------------------------------------------------

	/** A tab belongs in the omp group when claimed by a client, controllable, unpinned, not user-opted-out, and not already in a user group. */
	#groupWorthy(tab: TabState): boolean {
		if (!this.#claimed(tab.tabId) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
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
			void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }).catch(() => {});
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
				const tabIds = batch.map(tab => tab.tabId);
				try {
					const result = await this.#rpc({
						op: "group",
						tabIds,
						title: group.title,
						color: group.color,
					});
					// Extension replies { grouped: { [tabId]: groupId } }; validate per entry.
					const grouped: Record<string, unknown> =
						result &&
						typeof result === "object" &&
						"grouped" in result &&
						result.grouped &&
						typeof result.grouped === "object"
							? (result.grouped as Record<string, unknown>)
							: {};
					for (const tab of batch) {
						const groupId = grouped[String(tab.tabId)];
						if (typeof groupId !== "number") continue;
						tab.grouped = true;
						tab.ompGroupId = groupId;
					}
					this.#log("grouped tabs", { tabIds, grouped });
				} catch (err) {
					this.#log("tab grouping failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				} finally {
					for (const tab of batch) tab.grouping = false;
				}
			}
		} finally {
			this.#groupDraining = false;
		}
	}

	/**
	 * Tear a tab out of every downstream connection (closed, detached, or now
	 * ineligible). Connections in `keepPageSessions` retain their page
	 * pseudo-session: a bare attachToTarget holder routes by tabId, so its
	 * session survives a Chrome root swap and must not be destroyed on recovery.
	 */
	#retractTab(tab: TabState, keepPageSessions: CdpConnection[] = []): void {
		this.#pruneSubscriptions(tab, keepPageSessions);
		this.#prunePreloadScripts(tab, keepPageSessions);
		if (keepPageSessions.length === 0) tab.restorePending = false;
		if (keepPageSessions.length === 0) tab.restoreRootRuntime = false;
		const staleRealSessions = [...tab.realSessions];
		for (const realSession of staleRealSessions) this.#realSessionTabs.delete(realSession);
		tab.realSessions.clear();
		for (const conn of this.#conns.values()) {
			const preservePages = keepPageSessions.includes(conn);
			const tabSessions = conn.sessionsForTab(tab.tabId, "tab");
			if (!preservePages) {
				const pageSessions = conn.sessionsForTab(tab.tabId, "page");
				this.#forgetSessionSubscriptions(tab.tabId, pageSessions);
				for (const pageSession of pageSessions) {
					conn.sessions.delete(pageSession);
					this.#emit(
						conn,
						"Target.detachedFromTarget",
						{ sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
						tabSessions[0],
					);
				}
			} else {
				// The page session survives, but the Chrome root it was riding was
				// swapped by the guard detach. Explicitly invalidate real child sessions
				// from that old root, then clear Runtime context bookkeeping and abandon
				// any in-flight enable. Keep the session's enabled/disabled intent: the
				// recovery continuation replays enabled domains on the fresh root before
				// forwarding another command, while an explicit Runtime.disable remains
				// a per-session opt-out.
				for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
					const ref = conn.sessions.get(pageSession);
					if (!ref) continue;
					for (const realSession of staleRealSessions) {
						this.#emit(conn, "Target.detachedFromTarget", { sessionId: realSession }, pageSession);
					}
					ref.runtimeContexts.clear();
					ref.runtimeEnabling = null;
					ref.runtimeEpoch++;
				}
			}
			// A bare Target.attachToTarget holder can own a TAB<n> pseudo-session
			// instead of (or as well as) a PAGE<n> one. Like the page session, it is
			// routed by tabId rather than the swapped Chrome root, so Chrome mints no
			// replacement for it — dropping it strands the holder on "Unknown session
			// id" and, once its last session is gone, prevents cdpClosed from ever
			// detaching the debugger. Preserve it through the retract for a preserved
			// connection; only tear down tab sessions on connections being reset.
			if (!preservePages) {
				for (const tabSession of tabSessions) {
					conn.sessions.delete(tabSession);
					this.#emit(conn, "Target.detachedFromTarget", {
						sessionId: tabSession,
						targetId: tabTargetId(tab.tabId),
					});
				}
			}
			if (conn.discover && tab.announced && !preservePages) {
				this.#emit(conn, "Target.targetDestroyed", {
					targetId: pageTargetId(tab.tabId),
				});
				this.#emit(conn, "Target.targetDestroyed", {
					targetId: tabTargetId(tab.tabId),
				});
			}
		}
		tab.announced = false;
	}

	// ---- session + attach bookkeeping --------------------------------------------

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tabId: number): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, {
			kind,
			tabId,
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
		if (ref.kind === "page") {
			this.#forgetSessionSubscriptions(ref.tabId, [sessionId]);
			this.#forgetSessionPreloadScripts(ref.tabId, [sessionId]);
		}
		const targetId = ref.kind === "tab" ? tabTargetId(ref.tabId) : pageTargetId(ref.tabId);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
		// An explicit release of the last session must drop the attachment too,
		// or it outlives every downstream session: the infobar stays up, and
		// dismissing it bans the tab for the rest of the epoch.
		this.#detachIfUnheld(ref.tabId);
	}

	/**
	 * Release the tab's chrome.debugger attachment once no downstream session
	 * holds it. Inert while the long-lived registry connection still holds one.
	 */
	#detachIfUnheld(tabId: number, reconnectOnFailure = false): void {
		if (this.#sessionHolders(tabId).length > 0) return;
		const tab = this.#tabs.get(tabId);
		if (!tab?.attached) return;
		if (tab.detaching) return;
		tab.reattachedAfterDetach = false;
		const ext = this.#ext;
		const done = this.#rpc({ op: "detach", tabId })
			.then(() => {
				tab.attached = false;
				tab.forceFreshRootBeforeReplay = false;
				tab.restorePending = false;
				tab.subscriptionReconciling = null;
				tab.subscriptions.clear();
				tab.preloadScripts.clear();
				tab.pendingPreloadScriptCleanup = [];
				this.#resetRuntime(tab);
			})
			.catch(err => {
				this.#log("detach failed", {
					tabId,
					error: err instanceof Error ? err.message : String(err),
				});
				// Recovery already failed and this best-effort cleanup could not
				// confirm detachment either. Force the extension into its disconnected
				// orphan-sweep path so a surviving debugger attachment is retried.
				if (reconnectOnFailure && this.#ext === ext && ext) {
					ext.close();
					this.extClosed(ext);
				}
			})
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
	#sessionHolders(tabId: number): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabId).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (conn.sessionsForTab(tab.tabId, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab.tabId);
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
		if (tab.banned || !this.#ext) return false;
		if (tab.attaching) return await tab.attaching;
		const attempt = this.#rpc({ op: "attach", tabId: tab.tabId })
			.then(() => {
				tab.attached = true;
				tab.reattachedAfterDetach = true;
				return true;
			})
			.catch(err => {
				this.#log("attach failed", {
					tabId: tab.tabId,
					url: tab.url,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!isExtensionTransportInterrupted(err)) tab.banned = true;
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
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetId(tab.tabId),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetId(tab.tabId),
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
		conn.socket.send(
			JSON.stringify({
				id: msg.id,
				sessionId: msg.sessionId,
				error: { code, message },
			}),
		);
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	/**
	 * Resolve once the current extension socket completes its hello handshake, or
	 * immediately if the socket dropped (the caller re-checks and either proceeds
	 * or errors). Used to hold a surviving session's command through the window
	 * between a reconnect opening and its hello landing.
	 */
	#awaitHello(): Promise<void> {
		if (this.#extInfo || !this.#ext) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#helloWaiters.push(resolve);
		return promise;
	}

	/**
	 * Hold until a tab is safe to forward to: the current extension socket has
	 * completed its hello (recovery bookkeeping has run) and any armed debugger
	 * reattach has settled. Loops because a socket can be replaced mid-wait —
	 * awaiting a single hello/attach pair would still race the *next* socket's
	 * chrome.debugger.attach(). Each iteration re-reads `#extInfo`/`tab.attaching`
	 * against the latest socket; it settles once neither a pending hello nor a
	 * pending attach remains (or the extension is gone, in which case the caller's
	 * RPC fails fast rather than hanging).
	 */
	async #awaitTabReady(tabId: number): Promise<void> {
		// Bounded so a pathological reconnect storm can't spin forever; each real
		// swap resolves one hello + one attach, so this comfortably exceeds any
		// realistic burst before falling through to let the RPC surface the error.
		for (let i = 0; i < 100; i++) {
			if (this.#ext && !this.#extInfo) {
				await this.#awaitHello();
				continue;
			}
			const tab = this.#tabs.get(tabId);
			if (tab?.attaching) {
				await tab.attaching;
				continue;
			}
			if (tab?.restoring) {
				await tab.restoring;
				continue;
			}
			return;
		}
	}

	#rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
		const ext = this.#ext;
		if (!ext) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			const error = new ExtensionRpcTimeoutError(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`);
			reject(error);
			// Chrome may have applied this RPC even though its result missed the
			// deadline. Replace the transport so the next hello reconciles every
			// mutation that treats this typed timeout as an ambiguous interruption.
			if (this.#ext === ext) {
				ext.close();
				this.extClosed(ext);
			}
		}, timeoutMs);
		this.#pendingRpc.set(id, { resolve, reject, timer });
		ext.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		return promise;
	}
}
