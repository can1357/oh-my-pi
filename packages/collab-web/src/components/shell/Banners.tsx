import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	loading: GuestSnapshot["loading"];
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, loading, onRejoin, onNewLink }: BannersProps): ReactNode {
	const progress = loading && loading.total > 0 ? ` ${Math.floor((loading.received / loading.total) * 100)}%` : "";
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status" aria-live="polite">
				<span className="sh-banner-dot" aria-hidden="true" />
				<span>{phase === "connecting" ? "Connecting to relay…" : `Joining session…${progress}`}</span>
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status" aria-live="polite">
				<span className="sh-banner-dot" aria-hidden="true" />
				<span>{`Reconnecting…${progress}`}</span>
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-modal="true" aria-labelledby="sh-ended-title">
				<div className="sh-ended-card">
					<h2 id="sh-ended-title" className="sh-ended-title">
						Session ended
					</h2>
					{endedReason && <p className="sh-ended-reason">{endedReason}</p>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							Rejoin
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							New link
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
