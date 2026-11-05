/**
 * Live dashboard state streamed from the server (`/api/events`): the data
 * version every query revalidates against, background ingest progress, and
 * the rollup indexing backlog.
 *
 * The state lives in a module store read through narrow selectors, so a
 * progress tick only re-renders what shows progress: `useLiveVersion()` for
 * queries (see `useQuery`), `useLiveStatus()` for the chrome.
 */

import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import * as api from "../api";
import type { LiveStatus, LiveSyncStatus } from "../types";

/** Ingest status shown by the chrome. */
export interface LiveStatusView {
	sync: LiveSyncStatus;
	/** Hours whose rollups are still being built; wide ranges may be incomplete. */
	indexingHours: number;
	/** The event stream is open. */
	connected: boolean;
	/** Ask the server to ingest new session data now. */
	requestSync: () => void;
}

const IDLE_SYNC: LiveSyncStatus = {
	phase: "idle",
	current: 0,
	total: 0,
	processed: 0,
	lastSyncedAt: null,
	error: null,
};

function requestSync(): void {
	api.requestSync().catch(() => {});
}

let lastServerVersion: number | null = null;
/** Distinct server versions seen (including across server restarts). */
let seenVersions = 0;
/**
 * Client-side data version; bumps whenever the server's version changes.
 * Lags `seenVersions` by one so the first stream message doesn't refetch what
 * just loaded.
 */
let version = 0;
let status: LiveStatusView = { sync: IDLE_SYNC, indexingHours: 0, connected: false, requestSync };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit(): void {
	for (const listener of listeners) listener();
}

function sameSync(a: LiveSyncStatus, b: LiveSyncStatus): boolean {
	return (
		a.phase === b.phase &&
		a.current === b.current &&
		a.total === b.total &&
		a.processed === b.processed &&
		a.lastSyncedAt === b.lastSyncedAt &&
		a.error === b.error
	);
}

function receive(next: LiveStatus): void {
	if (lastServerVersion !== next.version) {
		lastServerVersion = next.version;
		seenVersions++;
	}
	const nextVersion = Math.max(0, seenVersions - 1);
	const statusChanged = next.indexingHours !== status.indexingHours || !sameSync(next.sync, status.sync);
	if (!statusChanged && nextVersion === version) return;
	version = nextVersion;
	if (statusChanged) status = { ...status, sync: next.sync, indexingHours: next.indexingHours };
	emit();
}

function setConnected(connected: boolean): void {
	if (connected === status.connected) return;
	status = { ...status, connected };
	emit();
}

const getStatus = (): LiveStatusView => status;
const getVersion = (): number => version;
const getDisabledVersion = (): number => -1;

/** Current data version, read outside render (e.g. when a fetch starts). */
export function currentLiveVersion(): number {
	return version;
}

/** Owns the `/api/events` stream; mount once at the app root. */
export function LiveProvider({ children }: { children: ReactNode }) {
	useEffect(() => {
		const source = new EventSource("/api/events");
		source.onopen = () => setConnected(true);
		source.onerror = () => setConnected(false);
		source.onmessage = event => receive(JSON.parse(event.data) as LiveStatus);
		return () => {
			source.close();
			setConnected(false);
		};
	}, []);
	return children;
}

/** Ingest status for the chrome; data-version bumps alone don't re-render. */
export function useLiveStatus(): LiveStatusView {
	return useSyncExternalStore(subscribe, getStatus);
}

/**
 * Data version for queries. Disabled (hidden) consumers read a constant -1 so
 * live traffic never re-renders them.
 */
export function useLiveVersion(enabled = true): number {
	return useSyncExternalStore(subscribe, enabled ? getVersion : getDisabledVersion);
}
