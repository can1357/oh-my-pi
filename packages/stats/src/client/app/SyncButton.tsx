import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { sync } from "../api";

export interface SyncButtonProps {
	onSyncStart?: () => void;
	onSyncComplete?: (result: {
		success: boolean;
		data?: { processed: number; files: number; totalMessages: number };
		error?: string;
	}) => void;
	className?: string;
}

export function SyncButton({ onSyncStart, onSyncComplete, className = "" }: SyncButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

	const handleSync = async () => {
		if (syncing) return;

		setSyncing(true);
		setStatus(null);
		if (onSyncStart) {
			onSyncStart();
		}

		try {
			const data = await sync();
			const result = {
				processed: typeof data?.processed === "number" ? data.processed : 0,
				files: typeof data?.files === "number" ? data.files : 0,
				totalMessages: typeof data?.totalMessages === "number" ? data.totalMessages : 0,
			};
			setStatus({
				type: "success",
				message: `Synced: ${result.processed} new request${result.processed === 1 ? "" : "s"} found.`,
			});
			if (onSyncComplete) {
				onSyncComplete({ success: true, data: result });
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			setStatus({
				type: "error",
				message: `Sync failed: ${errorMessage}`,
			});
			if (onSyncComplete) {
				onSyncComplete({ success: false, error: errorMessage });
			}
		} finally {
			setSyncing(false);
		}
	};

	return (
		<div className={`stats-sync-container ${className}`}>
			{status && (
				<span className="stats-sync-status-msg" data-type={status.type}>
					{status.message}
				</span>
			)}
			<button
				type="button"
				onClick={handleSync}
				disabled={syncing}
				className="stats-button stats-button-primary stats-sync-btn"
				aria-busy={syncing}
			>
				<RefreshCw size={14} className={`stats-sync-icon ${syncing ? "stats-spin" : ""}`} />
				{syncing ? "Syncing..." : "Sync DB"}
			</button>
		</div>
	);
}
