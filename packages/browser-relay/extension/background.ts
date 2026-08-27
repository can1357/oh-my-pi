/**
 * OMP Browser Relay — MV3 service worker.
 *
 * Dumb pipe by design: all CDP orchestration lives in the relay server. This
 * worker (1) keeps a websocket to the relay, (2) executes its RPCs against
 * `chrome.debugger`/`chrome.tabs`, and (3) streams tab + debugger events back.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected.
 */
import { AttachmentGuard } from "../../coding-agent/src/tools/browser/relay/attachment-guard";
import type { ExtToRelayMessage, RelayToExtMessage, TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";
import { snapshotAfterPendingOperationsSettle } from "./pending-ops";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/**
 * How long the relay may stay disconnected before we reclaim our debugger
 * attachments. Covers a couple of reconnect backoff cycles so a brief relay
 * restart doesn't strip a live session, but a dead relay no longer orphans the
 * "started debugging this browser" infobar forever (#8930).
 */
const ORPHAN_GRACE_MS = 30_000;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
const pendingAttaches = new Set<Promise<void>>();
const pendingDetaches = new Set<Promise<void>>();
let pendingOperationGeneration = 0;
const pendingAttachTabs = new Set<number>();
const canceledPendingAttachTabs = new Set<number>();
const guardDetachments = new Set<number>();
// Tabs the relay explicitly asked us to detach. onDetach reports these as
// relay-initiated so the bridge doesn't misclassify them as user cancellations.
const relayInitiatedDetachTabs = new Set<number>();

const RECOVERABLE_TAB_IDS_KEY = "ompRecoverableTabIds";
const recoverableTabIds = new Set<number>();
const recoverableReady = chrome.storage.session
	.get({ [RECOVERABLE_TAB_IDS_KEY]: [] })
	.then(stored => {
		const ids = stored[RECOVERABLE_TAB_IDS_KEY];
		if (!Array.isArray(ids)) return;
		for (const id of ids) {
			if (typeof id === "number") recoverableTabIds.add(id);
		}
	})
	.catch(() => {});
let recoverableUpdates: Promise<void> = recoverableReady;

function trackPendingDetach<T>(promise: Promise<T>): Promise<T> {
	pendingOperationGeneration++;
	const tracked = promise.finally(() => {
		pendingDetaches.delete(tracked as Promise<void>);
	});
	pendingDetaches.add(tracked as Promise<void>);
	return tracked;
}

function updateRecoverable(update: () => void): Promise<void> {
	recoverableUpdates = recoverableUpdates.then(async () => {
		update();
		await chrome.storage.session.set({ [RECOVERABLE_TAB_IDS_KEY]: [...recoverableTabIds] }).catch(() => {});
	});
	return recoverableUpdates;
}

function rememberRecoverable(tabIds: number[], isFresh: () => boolean = () => true): Promise<void> {
	return updateRecoverable(() => {
		if (!isFresh()) return;
		for (const tabId of tabIds) recoverableTabIds.add(tabId);
	});
}

function forgetRecoverable(tabId: number): Promise<void> {
	return updateRecoverable(() => {
		recoverableTabIds.delete(tabId);
	});
}

/**
 * The extension owns its `chrome.debugger` attachments: it outlives the relay,
 * so it must detach tabs the relay can no longer speak for. The relay reconciles
 * live attachments from the next `hello` and re-attaches any tab that still has
 * session holders, so an early detach is safe.
 */
const attachmentGuard = new AttachmentGuard<NodeJS.Timeout>({
	graceMs: ORPHAN_GRACE_MS,
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: handle => clearTimeout(handle),
	detachAll: tabIds => {
		// trackAttachments persisted every id before handing it to the guard, so
		// onSuspend can start these detaches without depending on a last-moment
		// storage write that MV3 may terminate with the worker.
		for (const tabId of tabIds) {
			guardDetachments.add(tabId);
			void trackPendingDetach(
				chrome.debugger.detach({ tabId }).catch(async () => {
					guardDetachments.delete(tabId);
					// The detach rejected. If Chrome still reports the tab attached, the
					// #sweep() that fired this already dropped it from the guard's tracked
					// set, so no later reconnect failure would retry it and the debugger
					// attachment (and its infobar) would stay orphaned. Re-track only when
					// the attachment truly survived so a subsequent sweep reclaims it;
					// otherwise the onDetach listener already forgot it.
					const targets = await chrome.debugger.getTargets().catch(() => []);
					if (targets.some(target => target.tabId === tabId && target.attached)) {
						void trackAttachments([tabId]);
					}
				}),
			);
		}
	},
});

/** Persist recovery authorization before a tab becomes eligible for a sweep. */
async function trackAttachments(tabIds: number[], isFresh: () => boolean = () => true): Promise<void> {
	if (tabIds.length === 0) return;
	await rememberRecoverable(tabIds, isFresh);
	if (!isFresh()) return;
	for (const tabId of tabIds) attachmentGuard.track(tabId);
}

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/** Title of the omp tab group; mirrored to session storage so a restarted service worker can still dissolve it. */
let ompGroupTitle: string | null = null;

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not
 * atomic: two concurrent runs both miss the not-yet-titled group and mint
 * duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}

/** Move tabs into the per-window omp group, creating or reusing it by title. */
async function groupTabs(tabIds: number[], title: string, color: string): Promise<{ grouped: Record<string, number> }> {
	ompGroupTitle = title;
	void chrome.storage.session.set({ ompGroupTitle: title });
	const byWindow = new Map<number, number[]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// Grouping silently unpins; never touch pinned tabs.
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {
			// Tab already closed.
		}
	}
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of byWindow) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId: number;
		if (existing[0]) {
			groupId = existing[0].id;
			// Heal duplicate same-title groups left behind by older races.
			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map(tab => tab.id).filter(id => id !== undefined);
				if (dupeIds.length > 0) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}

/** Dissolve every omp-titled group (relay disconnected or asked us to release tabs). */
async function restoreGroups(): Promise<void> {
	if (!ompGroupTitle) {
		// Service worker restarted since the last group op; recover the title.
		const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
		ompGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
	}
	if (!ompGroupTitle) return;
	const groups = await chrome.tabGroups.query({ title: ompGroupTitle }).catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map(tab => tab.id).filter(id => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

let helloRefresh: { socket: WebSocket; done: Promise<void>; dirty: boolean } | null = null;

/**
 * Send a fresh hello for the live socket, coalescing concurrent callers.
 *
 * A guard detach can resolve during a fast reconnect while the new socket's
 * `onopen` is already awaiting `buildHello()`. Firing a second hello from the
 * detach handler lets both reach `RelayBridge.#onHello()` before the recovery
 * attach settles; each hello clears `tab.attaching` and launches a separate
 * `chrome.debugger.attach()`, so one loses the race as "already attached" and
 * its failure retracts the target the other just recovered. `buildHello()`
 * already waits for pending attaches to settle, so a single coalesced refresh
 * captures the final attachment state. Coalescing is scoped to the live socket:
 * a refresh already queued for a socket that has since been replaced never
 * suppresses the replacement's own hello.
 *
 * A concurrent caller cannot simply be dropped, though: the in-flight refresh
 * may have already snapshotted `getTargets()` before the newer detach/attach
 * landed, so its hello would report the just-detached tab as still attached and
 * `RelayBridge.#onHello()` would preserve the stale session instead of
 * recovering it. Rather than dropping the request, mark the active refresh
 * dirty and rebuild once it settles, so the follow-up hello reflects the final
 * attachment state.
 */
function refreshHello(): void {
	const socket = ws;
	if (!socket || socket.readyState !== WebSocket.OPEN) return;
	if (helloRefresh?.socket === socket) {
		// A refresh is already running for this socket; its snapshot may predate
		// this change. Rebuild after it settles instead of discarding the refresh.
		helloRefresh.dirty = true;
		return;
	}
	const startRefresh = (): void => {
		const entry: { socket: WebSocket; done: Promise<void>; dirty: boolean } = {
			socket,
			dirty: false,
			done: Promise.resolve(),
		};
			entry.done = buildHello()
				.then(async hello => {
				// Suppress a hello whose snapshot was invalidated before it could be
				// sent. A guard detach that marks this refresh `dirty` in flight means
				// `getTargets()` may predate the detach, so this hello can report a
				// just-detached tab as still attached; `RelayBridge.#onHello()` would
				// then preserve the stale session and start recovery, while the rebuilt
				// follow-up hello clears `tab.attaching` and launches a competing
				// attach. Skip the stale send and let the dirty rebuild below emit the
				// single authoritative hello.
				if (entry.dirty) return;
					// Persist recovery markers only for the hello that is still current.
					// A detach can invalidate this refresh after `buildHello()` snapshots
					// targets but before the queued storage write runs; gating the write on
					// the live refresh prevents a stale hello from re-adding a just-forgotten
					// recoverable tab after `forgetRecoverable()` already queued the fix.
					await trackAttachments(
						hello.attachedTabIds,
						() => helloRefresh === entry && !entry.dirty && ws === socket && socket.readyState === WebSocket.OPEN,
					);
					if (entry.dirty) return;
				if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(hello));
			})
			.finally(() => {
				if (helloRefresh !== entry) return;
				if (entry.dirty && ws === socket && socket.readyState === WebSocket.OPEN) {
					// A refresh arrived while this one was in flight; its snapshot may be
					// stale, so rebuild to capture the change it observed.
					startRefresh();
				} else {
					helloRefresh = null;
				}
			});
		helloRefresh = entry;
	};
	startRefresh();
}

async function buildHello(): Promise<Extract<ExtToRelayMessage, { t: "hello" }>> {
	// An attach requested by the previous socket can finish during a fast
	// reconnect. Guard/internal detaches can be in flight for the same window,
	// too. Wait until the pending attach/detach set stays stable through the
	// target snapshot; otherwise a same-socket refresh can still capture stale
	// attached state, clear `tab.attaching`, and trigger a second recovery attach.
	await recoverableUpdates;
	const [tabs, targets] = await snapshotAfterPendingOperationsSettle(
		() => pendingOperationGeneration,
		() => [...pendingAttaches, ...pendingDetaches],
		() => Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]),
	);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	const attachedTabIds: number[] = [];
	for (const target of targets) {
		if (target.attached && target.tabId !== undefined) {
			attachedTabIds.push(target.tabId);
		}
	}
	const recoverableSnapshot = new Set(recoverableTabIds);
	for (const tabId of attachedTabIds) recoverableSnapshot.add(tabId);
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		tabs: snapshots,
		attachedTabIds,
		recoverableTabIds: [...recoverableSnapshot],
	};
}

async function attachTab(tabId: number, socket: WebSocket): Promise<void> {
	pendingAttachTabs.add(tabId);
	const pending = attachTabOperation(tabId, socket);
	pendingOperationGeneration++;
	pendingAttaches.add(pending);
	try {
		await pending;
	} finally {
		pendingAttaches.delete(pending);
		pendingAttachTabs.delete(tabId);
		canceledPendingAttachTabs.delete(tabId);
	}
}

async function attachTabOperation(tabId: number, socket: WebSocket): Promise<void> {
	await chrome.debugger.attach({ tabId }, "1.3");
	// The relay that requested this attachment disappeared while Chrome was
	// still resolving attach(). Its pending RPC was rejected by RelayBridge,
	// so no downstream session can own the resulting debugger attachment.
	// Mark the cleanup detach as guard-internal: a replacement socket may
	// already be live, and an unmarked onDetach would post a user-style
	// `detached` that bans the tab and drops its recovery bit instead of
	// letting the surviving relay reconcile it from the next hello.
	if (ws !== socket) {
		guardDetachments.add(tabId);
		await trackPendingDetach(
			chrome.debugger.detach({ tabId }).catch(async () => {
				guardDetachments.delete(tabId);
				// The cleanup detach rejected. If Chrome still reports the tab
				// attached, nothing else tracks it: the requesting socket is gone, so
				// no downstream session and no guard entry hold it, and if the relay
				// stays unavailable no later hello reseeds the guard. Mirror the guard
				// sweep's failure path and re-track only when the attachment truly
				// survived, so a subsequent sweep reclaims it instead of leaving the
				// debugger infobar orphaned indefinitely.
				const targets = await chrome.debugger.getTargets().catch(() => []);
				if (targets.some(target => target.tabId === tabId && target.attached)) {
					void trackAttachments([tabId]);
				}
			}),
		);
		return;
	}
	await trackAttachments([tabId]);
	if (canceledPendingAttachTabs.delete(tabId)) {
		// onDetach ran while the recovery marker was being persisted. Undo the
		// delayed track and fail the RPC: returning success would make the bridge
		// mint a session for a Chrome root the user already canceled.
		attachmentGuard.untrack(tabId);
		await forgetRecoverable(tabId);
		throw new Error("debugger attachment detached before attach completed");
	}
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>, socket: WebSocket): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await attachTab(msg.tabId, socket);
			return {};
		case "detach":
			relayInitiatedDetachTabs.add(msg.tabId);
			try {
				await trackPendingDetach(chrome.debugger.detach({ tabId: msg.tabId }));
				attachmentGuard.untrack(msg.tabId);
				await forgetRecoverable(msg.tabId);
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(msg.tabId);
				throw error;
			}
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			return { tab: snap };
		}
		case "removeTab":
			await chrome.tabs.remove(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
	}
}

function handleRelayMessage(socket: WebSocket, raw: string): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	void runRpc(msg, socket)
		.then(result => {
			if (ws === socket && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ t: "rpcResult", id: msg.id, ok: true, result } satisfies ExtToRelayMessage));
			}
		})
		.catch((err: unknown) => {
			if (ws === socket && socket.readyState === WebSocket.OPEN) {
				socket.send(
					JSON.stringify({
						t: "rpcResult",
						id: msg.id,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					} satisfies ExtToRelayMessage),
				);
			}
		});
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

/**
 * Seed the guard from attachments that survived a service-worker restart and,
 * when the relay is still unreachable, arm an orphan sweep independent of a
 * successful connection. Without this, a worker recreated during a relay outage
 * only re-seeds the guard inside `buildHello()` (which runs after `onopen`), so
 * a failed reconnect calls `onDisconnected()` on an empty guard and never
 * reclaims the surviving `chrome.debugger` infobar.
 */
async function reconcileOrphans(): Promise<void> {
	const targets = await chrome.debugger.getTargets().catch(() => []);
	const attachedTabIds: number[] = [];
	for (const target of targets) {
		if (target.attached && target.tabId !== undefined) {
			attachedTabIds.push(target.tabId);
		}
	}
	await trackAttachments(attachedTabIds);
	// A live/pending socket owns reconciliation via hello; only arm a
	// standalone sweep when nothing is connecting to reclaim these tabs.
	if (
		attachedTabIds.length > 0 &&
		!(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
	) {
		attachmentGuard.onDisconnected();
	}
}

async function connect(): Promise<void> {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		attachmentGuard.onConnected();
		void setBadge(true);
		refreshHello();
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = event => {
		if (typeof event.data === "string") handleRelayMessage(socket, event.data);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		void restoreGroups();
		attachmentGuard.onDisconnected();
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	// The attachment is gone (user clicked Cancel, tab navigated to a
	// non-attachable target, or Chrome tore it down); stop tracking it so a
	// later orphan sweep never tries to detach a tab we no longer own.
	attachmentGuard.untrack(source.tabId);
	// A user cancellation can race the orphan sweep: the guard calls
	// chrome.debugger.detach() and adds the tab to guardDetachments, but Chrome
	// then delivers the user's own Cancel as this onDetach. Trust Chrome's reason
	// over the in-memory marker — "canceled_by_user" is the user revoking the
	// attachment, so clear any stale guard/recovery bit and report it as a real
	// user detach (which bans the tab) instead of silently reattaching it.
	const guardMarked = guardDetachments.delete(source.tabId);
	if (guardMarked && reason !== "canceled_by_user") {
		// A reconnect can win the race with the asynchronous guard detach. Do not
		// report it as a user detach (which bans the tab); refresh hello so the
		// relay can restore only this guard-authorized attachment. Coalesce with
		// the reconnect's own hello so a single recovery attach is launched.
		refreshHello();
		return;
	}
	// A relay-requested detach is attributed explicitly so the bridge can
	// reconcile the stale snapshot instead of treating it as a user cancel.
	const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
	if (!relayInitiated && pendingAttachTabs.has(source.tabId)) canceledPendingAttachTabs.add(source.tabId);
	void forgetRecoverable(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
	// A detach can land after buildHello() snapshots getTargets() while that
	// refresh is still persisting its recovery markers. Invalidate the stale
	// snapshot so the follow-up hello reports the real detached state. This
	// includes relay-initiated detaches whose old RPC result may be suppressed
	// after a socket replacement.
	refreshHello();
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onRemoved.addListener(tabId => {
	void forgetRecoverable(tabId);
	post({ t: "tabRemoved", tabId });
});

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "omp-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;
	// Settings changed: drop the current connection and re-dial with new ones.
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => {
	void reconcileOrphans();
	void connect();
});
chrome.runtime.onStartup.addListener(() => {
	void reconcileOrphans();
	void connect();
});
// Clean teardown: detach any tab we still own before the worker is suspended,
// so the debugger infobar never survives the extension going idle.
chrome.runtime.onSuspend.addListener(() => attachmentGuard.onSuspend());

void reconcileOrphans();
void connect();
