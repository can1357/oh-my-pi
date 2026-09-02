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
import type {
	ExtToRelayMessage,
	RelayToExtMessage,
	TabSnapshot,
} from "../../coding-agent/src/tools/browser/relay/protocol";
import {
	consumeRelayInitiatedDetach,
	filterFreshAttachmentState,
	noteAttachmentStateChange,
	snapshotAttachmentState,
} from "./attachment-state";
import {
	nextOrphanSweepDeadline,
	orphanSweepAlarmDelayMinutes,
	orphanSweepSeesRelayDisconnected,
	serializeOrphanSweepDeadlineUpdate,
	shouldProceedWithOrphanSweep,
	shouldRunOrphanSweep,
} from "./orphan-sweep";
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
const KEEPALIVE_ALARM = "omp-relay-keepalive";
const ORPHAN_SWEEP_ALARM = "omp-relay-orphan-sweep";
const ORPHAN_SWEEP_DEADLINE_KEY = "ompOrphanSweepDeadlineMs";

let ws: WebSocket | null = null;
// The socket on which a hello has actually reached the relay. An OPEN socket is
// not enough to declare the relay initialized: `buildHello()` can reject or
// stall (transient tabs/getTargets failure), so orphan-sweep bookkeeping must
// gate on hello delivery, not mere readiness. Compared by identity, so a
// replacement socket reads as uninitialized until it sends its own hello.
let helloDeliveredSocket: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
const pendingAttaches = new Set<Promise<void>>();
const pendingDetaches = new Set<Promise<void>>();
let pendingOperationGeneration = 0;
const pendingAttachTabs = new Set<number>();
const canceledPendingAttachTabs = new Set<number>();
const guardDetachments = new Set<number>();
const attachmentStateEpochs = new Map<number, number>();
// Tabs the relay explicitly asked us to detach. onDetach reports these as
// relay-initiated so the bridge doesn't misclassify them as user cancellations.
const relayInitiatedDetachTabs = new Set<number>();

const RECOVERABLE_TAB_IDS_KEY = "ompRecoverableTabIds";
const recoverableTabIds = new Set<number>();
let orphanSweepDeadlineMs: number | null = null;
// Bumped on every relay disconnect. maybeRunOrphanSweep snapshots this before it
// yields to the alarms/storage APIs so a reconnect+disconnect cycle that arms a
// fresh grace deadline during the await can veto the stale sweep instead of
// letting it cancel the new grace period and detach the just-lost live session.
let connectionGeneration = 0;
let orphanSweepDeadlineGeneration = 0;
const recoverableReady = chrome.storage.session
	.get({ [RECOVERABLE_TAB_IDS_KEY]: [], [ORPHAN_SWEEP_DEADLINE_KEY]: null })
	.then((stored) => {
		const ids = stored[RECOVERABLE_TAB_IDS_KEY];
		if (Array.isArray(ids)) {
			for (const id of ids) {
				if (typeof id === "number") recoverableTabIds.add(id);
			}
		}
		const deadline = stored[ORPHAN_SWEEP_DEADLINE_KEY];
		if (typeof deadline === "number" && Number.isFinite(deadline))
			orphanSweepDeadlineMs = deadline;
	})
	.catch(() => {});
let recoverableUpdates: Promise<void> = recoverableReady;
let orphanSweepDeadlineUpdates: Promise<void> = recoverableReady;

function trackPendingDetach<T>(promise: Promise<T>): Promise<T> {
	pendingOperationGeneration++;
	invalidateHelloRefresh();
	const tracked = promise.finally(() => {
		pendingDetaches.delete(tracked as Promise<void>);
	});
	pendingDetaches.add(tracked as Promise<void>);
	return tracked;
}

function updateRecoverable(update: () => void): Promise<void> {
	recoverableUpdates = recoverableUpdates.then(async () => {
		update();
		await chrome.storage.session
			.set({ [RECOVERABLE_TAB_IDS_KEY]: [...recoverableTabIds] })
			.catch(() => {});
	});
	return recoverableUpdates;
}

function rememberRecoverable(freshTabIds: () => number[]): Promise<void> {
	return updateRecoverable(() => {
		for (const tabId of freshTabIds()) recoverableTabIds.add(tabId);
	});
}

function forgetRecoverable(tabId: number): Promise<void> {
	return updateRecoverable(() => {
		recoverableTabIds.delete(tabId);
	});
}

async function setOrphanSweepDeadline(
	deadlineMs: number | null,
): Promise<void> {
	const generation = ++orphanSweepDeadlineGeneration;
	orphanSweepDeadlineMs = deadlineMs;
	let alarmUpdate: Promise<unknown> = Promise.resolve();
	if (deadlineMs === null) {
		// Start the clear immediately: onSuspend cannot rely on work deferred to a
		// promise continuation. The serialized completion below prevents this
		// clear from later persisting null over a newer deadline.
		alarmUpdate = chrome.alarms.clear(ORPHAN_SWEEP_ALARM);
	} else {
		chrome.alarms.create(ORPHAN_SWEEP_ALARM, {
			delayInMinutes: orphanSweepAlarmDelayMinutes(deadlineMs, Date.now()),
		});
	}
	orphanSweepDeadlineUpdates = serializeOrphanSweepDeadlineUpdate(
		orphanSweepDeadlineUpdates,
		alarmUpdate,
		() => generation === orphanSweepDeadlineGeneration,
		() =>
			chrome.storage.session.set({
				[ORPHAN_SWEEP_DEADLINE_KEY]: deadlineMs,
			}),
		() => {
			// A stale clear may have raced a newer create in Chrome. Re-arm the
			// current deadline as well as suppressing the stale storage write.
			if (orphanSweepDeadlineMs !== null) {
				chrome.alarms.create(ORPHAN_SWEEP_ALARM, {
					delayInMinutes: orphanSweepAlarmDelayMinutes(
						orphanSweepDeadlineMs,
						Date.now(),
					),
				});
			}
		},
	);
	await orphanSweepDeadlineUpdates;
}

async function maybeScheduleOrphanSweep(
	forceDisconnected = false,
): Promise<void> {
	await recoverableUpdates;
	const nextDeadlineMs = computeNextOrphanSweepDeadline(forceDisconnected);
	if (nextDeadlineMs !== orphanSweepDeadlineMs)
		await setOrphanSweepDeadline(nextDeadlineMs);
}

/**
 * Ready-state to feed the orphan-sweep disconnect check. Reports OPEN only when
 * the live socket has actually delivered a hello; an open-but-uninitialized
 * socket (post-restart, before/without a successful `buildHello()`) reads as
 * disconnected so the sweep stays armed until the relay owns reconciliation.
 */
function relayInitializedReadyState(): number | null | undefined {
	if (ws !== null && ws === helloDeliveredSocket) return ws.readyState;
	return null;
}

function computeNextOrphanSweepDeadline(
	forceDisconnected: boolean,
): number | null {
	const disconnected = orphanSweepSeesRelayDisconnected({
		socketReadyState: relayInitializedReadyState(),
		openReadyState: WebSocket.OPEN,
		forceDisconnected,
	});
	return nextOrphanSweepDeadline({
		nowMs: Date.now(),
		graceMs: ORPHAN_GRACE_MS,
		disconnected,
		hasTrackedAttachments: attachmentGuard.attachedTabIds().length > 0,
		existingDeadlineMs: orphanSweepDeadlineMs,
	});
}

/**
 * Arm the orphan sweep from `runtime.onSuspend` without yielding first.
 *
 * Chrome does not guarantee any asynchronous work once an `onSuspend` listener
 * returns, so `maybeScheduleOrphanSweep()`'s leading `await recoverableUpdates`
 * can let the worker terminate before `chrome.alarms.create` ever runs, leaving
 * surviving debugger attachments with no future sweep. Recoverable ids and
 * tracked attachments are already in memory (`trackAttachments` persists ids
 * before handing them to the guard), so the deadline can be computed
 * synchronously. `setOrphanSweepDeadline` fires `chrome.alarms.create` before
 * its first await, so the alarm is registered even if the trailing storage
 * write loses the race with worker termination.
 */
function scheduleOrphanSweepBeforeSuspend(): void {
	const nextDeadlineMs = computeNextOrphanSweepDeadline(true);
	if (nextDeadlineMs !== orphanSweepDeadlineMs)
		void setOrphanSweepDeadline(nextDeadlineMs);
}

async function maybeRunOrphanSweep(): Promise<void> {
	if (
		!shouldRunOrphanSweep({
			nowMs: Date.now(),
			deadlineMs: orphanSweepDeadlineMs,
			disconnected: orphanSweepSeesRelayDisconnected({
				socketReadyState: relayInitializedReadyState(),
				openReadyState: WebSocket.OPEN,
			}),
			hasTrackedAttachments: attachmentGuard.attachedTabIds().length > 0,
		})
	) {
		await maybeScheduleOrphanSweep();
		return;
	}
	// Capture the connection generation before yielding to the alarms/storage
	// APIs. A reconnect that delivers a hello and disconnects again while
	// setOrphanSweepDeadline(null) is in flight arms a brand-new grace deadline;
	// this stale invocation must not resume and cancel it. The disconnected +
	// hasTrackedAttachments recheck below cannot catch that case because the new
	// cycle also ends disconnected with the same tabs still attached.
	const sweepGeneration = connectionGeneration;
	await setOrphanSweepDeadline(null);
	if (
		!shouldProceedWithOrphanSweep({
			disconnected: orphanSweepSeesRelayDisconnected({
				socketReadyState: relayInitializedReadyState(),
				openReadyState: WebSocket.OPEN,
			}),
			hasTrackedAttachments: attachmentGuard.attachedTabIds().length > 0,
			connectionReplaced: connectionGeneration !== sweepGeneration,
		})
	) {
		await maybeScheduleOrphanSweep();
		return;
	}
	attachmentGuard.onSuspend();
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
	clearTimer: (handle) => clearTimeout(handle),
	detachAll: (tabIds) => {
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
					if (
						targets.some((target) => target.tabId === tabId && target.attached)
					) {
						void trackAttachments([tabId]);
					}
				}),
			);
		}
	},
});

/** Persist recovery authorization before a tab becomes eligible for a sweep. */
async function trackAttachments(
	tabIds: number[],
	isFresh: () => boolean = () => true,
	attachmentState = snapshotAttachmentState(attachmentStateEpochs, tabIds),
): Promise<void> {
	if (tabIds.length === 0) return;
	const freshTabIds = (): number[] =>
		isFresh()
			? filterFreshAttachmentState(
					attachmentStateEpochs,
					attachmentState,
					tabIds,
				)
			: [];
	await rememberRecoverable(freshTabIds);
	for (const tabId of freshTabIds()) attachmentGuard.track(tabId);
}

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({
		port: DEFAULT_PORT,
		token: "",
	});
	const port = Number(stored.port);
	return {
		port:
			Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
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
async function groupTabs(
	tabIds: number[],
	title: string,
	color: string,
): Promise<{ grouped: Record<string, number> }> {
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
				const dupeIds = dupeTabs
					.map((tab) => tab.id)
					.filter((id) => id !== undefined);
				if (dupeIds.length > 0)
					await chrome.tabs.group({ tabIds: dupeIds, groupId });
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
		const stored = await chrome.storage.session
			.get({ ompGroupTitle: "" })
			.catch(() => ({ ompGroupTitle: "" }));
		ompGroupTitle =
			typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle
				? stored.ompGroupTitle
				: null;
	}
	if (!ompGroupTitle) return;
	const groups = await chrome.tabGroups
		.query({ title: ompGroupTitle })
		.catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map((tab) => tab.id).filter((id) => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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

let helloRefresh: {
	socket: WebSocket;
	done: Promise<void>;
	dirty: boolean;
	afterSend: (() => void) | null;
} | null = null;

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
function refreshHello(onSent?: () => void): void {
	const socket = ws;
	if (!socket || socket.readyState !== WebSocket.OPEN) return;
	if (helloRefresh?.socket === socket) {
		// A refresh is already running for this socket; its snapshot may predate
		// this change. Rebuild after it settles instead of discarding the refresh.
		helloRefresh.dirty = true;
		// Carry a caller's post-send callback onto the in-flight refresh so a
		// coalesced hello (e.g. the reconnect's own refresh) still runs it once the
		// authoritative hello is actually sent.
		if (onSent) helloRefresh.afterSend = onSent;
		return;
	}
	const startRefresh = (afterSend: (() => void) | null): void => {
		const entry: {
			socket: WebSocket;
			done: Promise<void>;
			dirty: boolean;
			afterSend: (() => void) | null;
		} = {
			socket,
			dirty: false,
			done: Promise.resolve(),
			afterSend,
		};
		entry.done = buildHello()
			.then(async (hello) => {
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
					() =>
						helloRefresh === entry &&
						!entry.dirty &&
						ws === socket &&
						socket.readyState === WebSocket.OPEN,
				);
				if (entry.dirty) return;
				if (ws === socket && socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(hello));
					// The relay has now received our attachment state, so it owns
					// reconciliation. Only now is it safe to cancel the orphan sweep the
					// disconnected worker armed; clearing it at `onopen` (before the
					// hello is built/sent) would strand surviving attachments whenever
					// `buildHello()` rejected or the socket never delivered a hello.
					const done = entry.afterSend;
					entry.afterSend = null;
					done?.();
				}
			})
			.catch(() => {
				// `buildHello()` (or the attachment-state persistence it awaits) can
				// reject when `chrome.tabs.query()` / `chrome.debugger.getTargets()`
				// transiently fail. The socket stays OPEN, so keepalive `connect()`
				// short-circuits on the live socket and never retries — the relay
				// never receives a hello and the extension is stuck unusable. Close
				// the socket so `onclose` runs the normal reconnect path
				// (`scheduleReconnect()`), which opens a fresh socket and rebuilds the
				// hello. The disconnected-armed orphan sweep is left intact because we
				// never reached the post-send callback that cancels it.
				if (ws === socket && socket.readyState === WebSocket.OPEN) {
					socket.close();
				}
			})
			.finally(() => {
				if (helloRefresh !== entry) return;
				if (
					entry.dirty &&
					ws === socket &&
					socket.readyState === WebSocket.OPEN
				) {
					// A refresh arrived while this one was in flight; its snapshot may be
					// stale, so rebuild to capture the change it observed. Carry any
					// not-yet-run post-send callback onto the rebuild.
					startRefresh(entry.afterSend);
				} else {
					helloRefresh = null;
				}
			});
		helloRefresh = entry;
	};
	startRefresh(onSent ?? null);
}

function invalidateHelloRefresh(): void {
	if (helloRefresh) helloRefresh.dirty = true;
}

async function buildHello(): Promise<
	Extract<ExtToRelayMessage, { t: "hello" }>
> {
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
	const hardwareConcurrency =
		Number.isInteger(navigator.hardwareConcurrency) &&
		navigator.hardwareConcurrency > 0
			? navigator.hardwareConcurrency
			: undefined;
	return {
		t: "hello",
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		hardwareConcurrency,
		tabs: snapshots,
		attachedTabIds,
		recoverableTabIds: [...recoverableSnapshot],
	};
}

async function attachTab(tabId: number, socket: WebSocket): Promise<void> {
	pendingAttachTabs.add(tabId);
	const pending = attachTabOperation(tabId, socket);
	pendingOperationGeneration++;
	invalidateHelloRefresh();
	pendingAttaches.add(pending);
	try {
		await pending;
	} finally {
		pendingAttaches.delete(pending);
		pendingAttachTabs.delete(tabId);
		canceledPendingAttachTabs.delete(tabId);
	}
}

async function attachTabOperation(
	tabId: number,
	socket: WebSocket,
): Promise<void> {
	await chrome.debugger.attach({ tabId }, "1.3");
	noteAttachmentStateChange(attachmentStateEpochs, tabId);
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
				if (
					targets.some((target) => target.tabId === tabId && target.attached)
				) {
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

async function runRpc(
	msg: Extract<RelayToExtMessage, { t: "rpc" }>,
	socket: WebSocket,
): Promise<unknown> {
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
				msg.sessionId
					? { tabId: msg.tabId, sessionId: msg.sessionId }
					: { tabId: msg.tabId },
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
			return await enqueueGroupOp(() =>
				groupTabs(msg.tabIds, msg.title, msg.color),
			);
		case "ungroup":
			await enqueueGroupOp(() =>
				chrome.tabs.ungroup(msg.tabIds).catch(() => {}),
			);
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
		.then((result) => {
			if (ws === socket && socket.readyState === WebSocket.OPEN) {
				socket.send(
					JSON.stringify({
						t: "rpcResult",
						id: msg.id,
						ok: true,
						result,
					} satisfies ExtToRelayMessage),
				);
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
	// Snapshot every known epoch before awaiting getTargets so a detach that
	// lands during the await bumps the epoch past this baseline and is filtered
	// out of the re-track. The attached tab set is only known after getTargets,
	// so seed the snapshot from the currently tracked tab ids (absent ids read
	// as epoch 0, matching filterFreshAttachmentState's default).
	const attachmentState = snapshotAttachmentState(attachmentStateEpochs, [
		...attachmentStateEpochs.keys(),
	]);
	// A getTargets() rejection is not an authoritative "no attachments" answer.
	// Treating a transient failure as an empty snapshot would fall through to
	// setOrphanSweepDeadline(null) below and discard the only persisted reclaim
	// alarm even though debugger attachments may still exist — an MV3 suspension
	// could then strand the debugging infobar until a later successful pass.
	// Leave any existing deadline intact and let the next alarm/startup retry.
	const targets = await chrome.debugger.getTargets().catch(() => null);
	if (targets === null) return;
	const attachedTabIds: number[] = [];
	for (const target of targets) {
		if (target.attached && target.tabId !== undefined) {
			attachedTabIds.push(target.tabId);
		}
	}
	await trackAttachments(attachedTabIds, () => true, attachmentState);
	// Only a socket that has actually delivered a hello owns reconciliation. A
	// merely OPEN (or CONNECTING) socket may still stall/fail in `buildHello()`
	// before any hello reaches the relay, so the persisted deadline must stay
	// armed — and the guard treated as disconnected — until hello delivery is
	// proven. Gating on readiness alone would clear the sweep for an
	// open-but-uninitialized socket and strand the surviving attachment.
	if (
		attachedTabIds.length > 0 &&
		orphanSweepSeesRelayDisconnected({
			socketReadyState: relayInitializedReadyState(),
			openReadyState: WebSocket.OPEN,
		})
	) {
		attachmentGuard.onDisconnected();
		await maybeRunOrphanSweep();
		return;
	}
	await setOrphanSweepDeadline(null);
}

async function connect(): Promise<void> {
	if (
		ws &&
		(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
	)
		return;
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		// Do not mark the guard connected or clear the persisted orphan-sweep
		// deadline yet: the relay has not received any attachment state. If
		// `buildHello()` rejects or the hello is never delivered (a transient
		// tabs/getTargets failure), the socket stays open and pinging with no retry
		// path, so eagerly cancelling the sweep here would strand surviving debugger
		// attachments. Keep the disconnected-armed sweep intact and cancel it only
		// from the refresh's post-send callback, once the hello has actually been
		// sent and the relay owns reconciliation.
		refreshHello(() => {
			helloDeliveredSocket = socket;
			attachmentGuard.onConnected();
			void setOrphanSweepDeadline(null);
		});
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = (event) => {
		if (typeof event.data === "string") handleRelayMessage(socket, event.data);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (helloDeliveredSocket === socket) helloDeliveredSocket = null;
		// A new disconnect cycle: invalidate any orphan sweep that already yielded
		// to the alarms/storage APIs so its stale resume cannot cancel the fresh
		// grace deadline armed below.
		connectionGeneration++;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		void restoreGroups();
		attachmentGuard.onDisconnected();
		void maybeScheduleOrphanSweep();
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({
		t: "cdpEvent",
		tabId: source.tabId,
		sessionId: source.sessionId,
		method,
		params,
	});
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	noteAttachmentStateChange(attachmentStateEpochs, source.tabId);
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
	const userDetach =
		reason === "canceled_by_user" || reason === "replaced_with_devtools";
	if (guardMarked && !userDetach) {
		// A reconnect can win the race with the asynchronous guard detach. Do not
		// report it as a user detach (which bans the tab); refresh hello so the
		// relay can restore only this guard-authorized attachment. Coalesce with
		// the reconnect's own hello so a single recovery attach is launched.
		refreshHello();
		return;
	}
	// A relay-requested detach is attributed explicitly so the bridge can
	// reconcile the stale snapshot instead of treating it as a user cancel.
	// A fresh user cancellation / DevTools takeover wins even when it races an
	// in-flight relay detach. Consume the stale marker, but report user intent to
	// the bridge so it bans/retracts the tab instead of reattaching it.
	const relayInitiated = consumeRelayInitiatedDetach(
		relayInitiatedDetachTabs,
		source.tabId,
		reason,
	);
	if (!relayInitiated && pendingAttachTabs.has(source.tabId))
		canceledPendingAttachTabs.add(source.tabId);
	void forgetRecoverable(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
	// A detach can land after buildHello() snapshots getTargets() while that
	// refresh is still persisting its recovery markers. Invalidate the stale
	// snapshot so the follow-up hello reports the real detached state. This
	// includes relay-initiated detaches whose old RPC result may be suppressed
	// after a socket replacement.
	refreshHello();
});

chrome.tabs.onCreated.addListener((tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onRemoved.addListener((tabId) => {
	void forgetRecoverable(tabId);
	post({ t: "tabRemoved", tabId });
});

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === KEEPALIVE_ALARM) {
		void reconcileOrphans();
		void connect();
		return;
	}
	if (alarm.name === ORPHAN_SWEEP_ALARM) void maybeRunOrphanSweep();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;
	// Settings changed: drop the current connection and re-dial with new ones.
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(
	() => void chrome.runtime.openOptionsPage(),
);
chrome.runtime.onInstalled.addListener(() => {
	void reconcileOrphans();
	void connect();
});
chrome.runtime.onStartup.addListener(() => {
	void reconcileOrphans();
	void connect();
});
// `runtime.onSuspend` cannot rely on async `chrome.debugger.detach()` calls:
// Chrome may terminate the worker before they complete. Persist the orphan
// deadline and let the next normal alarm/startup event perform the actual
// reclaim if the relay stayed down through the full grace period.
chrome.runtime.onSuspend.addListener(() => {
	scheduleOrphanSweepBeforeSuspend();
});

void reconcileOrphans();
void connect();
