/**
 * Live state of every open session, for the sidebar.
 *
 * The sidebar is the session list — there is no tab strip — so it has to show
 * what each session is doing, but the streaming flag lives inside each session's
 * bridge, several components away. A module-level store beats threading
 * callbacks through the router's outlet context, and it stays correct with many
 * sessions open.
 *
 * Shaped like the bridge's own store (`subscribe` / `getSnapshot` with a cached
 * immutable snapshot) so `useSyncExternalStore` can consume it directly.
 */

export type TabState = "working" | "attention" | "done" | "idle";

interface Activity {
	streaming: boolean;
	attention: boolean;
	/** A turn finished and nobody has looked at the result yet. */
	done: boolean;
}

const activity = new Map<string, Activity>();
const listeners = new Set<() => void>();

let snapshot: ReadonlyMap<string, TabState> = new Map();
let dirty = true;

function resolve(entry: Activity): TabState {
	// Order matters: a session that needs an answer is more urgent than one that
	// is merely busy, and a finished one only counts while it is still unread.
	if (entry.attention) return "attention";
	if (entry.streaming) return "working";
	if (entry.done) return "done";
	return "idle";
}

function notify(): void {
	dirty = true;
	for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSnapshot(): ReadonlyMap<string, TabState> {
	if (dirty) {
		const next = new Map<string, TabState>();
		for (const [tabId, entry] of activity) next.set(tabId, resolve(entry));
		snapshot = next;
		dirty = false;
	}
	return snapshot;
}

/** A session not in the store has never been opened, so it is idle. */
export function tabState(tabId: string): TabState {
	return getSnapshot().get(tabId) ?? "idle";
}

/**
 * Publish what a session is doing. `done` latches on the falling edge of
 * `streaming` — the same edge that fires the native notification — and is only
 * cleared by {@link markViewed}.
 */
export function setTabActivity(tabId: string, next: { streaming: boolean; attention: boolean }): void {
	const previous = activity.get(tabId);
	const finished = previous?.streaming === true && !next.streaming;

	const entry: Activity = {
		streaming: next.streaming,
		attention: next.attention,
		done: finished || (previous?.done ?? false),
	};

	if (
		previous &&
		previous.streaming === entry.streaming &&
		previous.attention === entry.attention &&
		previous.done === entry.done
	) {
		return; // nothing changed; do not wake every subscriber
	}

	activity.set(tabId, entry);
	notify();
}

/** Opening a session clears its unread "finished" mark. */
export function markViewed(tabId: string): void {
	const entry = activity.get(tabId);
	if (!entry) {
		activity.set(tabId, { streaming: false, attention: false, done: false });
		notify();
		return;
	}
	if (!entry.done) return;
	activity.set(tabId, { ...entry, done: false });
	notify();
}

export function forgetTab(tabId: string): void {
	if (activity.delete(tabId)) notify();
}

/** Used by the close guard: is any agent mid-turn? */
export function anyTabBusy(): boolean {
	for (const entry of activity.values()) if (entry.streaming) return true;
	return false;
}

export function busyTabs(): string[] {
	return [...activity].filter(([, entry]) => entry.streaming).map(([tabId]) => tabId);
}
