import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatInteger } from "../data/formatters";
import { useLive } from "../data/live";
import { Dot } from "../ui";

/** Topbar ingest status; click to sync now. */
export function LiveChip() {
	const { sync, indexingHours, connected, requestSync } = useLive();
	const now = useNow(sync.phase === "idle" ? 15_000 : null);

	let body: ReactNode;
	let title: string;
	if (!connected) {
		body = (
			<>
				<Dot tone="warn" />
				<span>Reconnecting</span>
			</>
		);
		title = "Lost the live connection to the stats server; retrying";
	} else if (sync.phase === "syncing") {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>Syncing</span>
				{sync.total > 0 && (
					<span className="live-chip-count">
						{formatInteger(sync.current)}/{formatInteger(sync.total)}
					</span>
				)}
			</>
		);
		title = "Ingesting session files";
	} else if (sync.phase === "error") {
		body = (
			<>
				<Dot tone="bad" />
				<span>Sync failed</span>
			</>
		);
		title = `${sync.error ?? "Sync failed"} — click to retry`;
	} else if (indexingHours > INDEXING_VISIBLE_HOURS) {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>Indexing</span>
				<span className="live-chip-count">{formatInteger(indexingHours)}h left</span>
			</>
		);
		title = "Building hourly rollups; older ranges fill in as it goes";
	} else {
		body = (
			<>
				<Dot tone="live" pulse />
				<span>Live</span>
				{sync.lastSyncedAt !== null && <span className="live-chip-count">{ago(now - sync.lastSyncedAt)}</span>}
			</>
		);
		title = "Click to sync session files now";
	}

	return (
		<button
			type="button"
			className="live-chip"
			onClick={requestSync}
			disabled={sync.phase === "syncing"}
			title={title}
		>
			{body}
		</button>
	);
}

/** A handful of dirty hours is normal live churn; only a real backlog is worth showing. */
const INDEXING_VISIBLE_HOURS = 24;

function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
