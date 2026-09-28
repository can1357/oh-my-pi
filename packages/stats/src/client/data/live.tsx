/**
 * Live dashboard state streamed from the server (`/api/events`): the data
 * version every query revalidates against, background ingest progress, and
 * the rollup indexing backlog.
 *
 * Any component can `useLive()`; queries (see `useQuery`) refetch whenever
 * `version` advances, so rows ingested in the background repaint the active
 * page without a manual refresh.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { LiveStatus, LiveSyncStatus } from "../types";

export interface LiveState {
	/**
	 * Client-side data version; bumps whenever the server's version changes
	 * (including after reconnecting to a restarted server).
	 */
	version: number;
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

const LiveContext = createContext<LiveState>({
	version: 0,
	sync: IDLE_SYNC,
	indexingHours: 0,
	connected: false,
	requestSync: () => {},
});

export function LiveProvider({ children }: { children: ReactNode }) {
	const [status, setStatus] = useState<{ server: LiveStatus | null; version: number }>({ server: null, version: 0 });
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		const source = new EventSource("/api/events");
		source.onopen = () => setConnected(true);
		source.onerror = () => setConnected(false);
		source.onmessage = event => {
			const next = JSON.parse(event.data) as LiveStatus;
			setStatus(prev => ({
				server: next,
				version: prev.server && prev.server.version === next.version ? prev.version : prev.version + 1,
			}));
		};
		return () => source.close();
	}, []);

	const requestSync = useCallback(() => {
		api.requestSync().catch(() => {});
	}, []);

	const value = useMemo<LiveState>(
		() => ({
			// Start at 0 so the first stream message (version 1) doesn't refetch what just loaded.
			version: Math.max(0, status.version - 1),
			sync: status.server?.sync ?? IDLE_SYNC,
			indexingHours: status.server?.indexingHours ?? 0,
			connected,
			requestSync,
		}),
		[status, connected, requestSync],
	);
	return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
	return useContext(LiveContext);
}
