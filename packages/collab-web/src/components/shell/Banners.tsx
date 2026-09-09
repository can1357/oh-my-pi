import type { ReactNode } from "react";
import type { ConnectionPhase } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, onRejoin, onNewLink }: BannersProps): ReactNode {
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting" ? "connecting to relay…" : "joining session…"}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				reconnecting…
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="session ended">
				<div className="sh-ended-card">
					<div className="sh-ended-title">session ended</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
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
