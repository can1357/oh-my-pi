import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
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
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting"
					? __ompTranslate("Connecting to relay…")
					: __ompTranslate("Joining session…{0}", `${progress}`)}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{__ompTranslate("Reconnecting…{0}", `${progress}`)}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label={__ompTranslate("session ended")}>
				<div className="sh-ended-card">
					<div className="sh-ended-title">{__ompTranslate("Session ended")}</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							{__ompTranslate("Rejoin")}
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							{__ompTranslate("New link")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
