import type { ReactNode } from "react";
import type { ConnectionPhase } from "../../lib/client";
import { useCollabI18n } from "../../lib/i18n";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, onRejoin, onNewLink }: BannersProps): ReactNode {
	const { i18n } = useCollabI18n();
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting" ? i18n.t("collab.shell.connecting") : i18n.t("collab.shell.join")}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{i18n.t("collab.shell.reconnecting")}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label={i18n.t("collab.shell.sessionEnded")}>
				<div className="sh-ended-card">
					<div className="sh-ended-title">{i18n.t("collab.shell.sessionEnded")}</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							{i18n.t("collab.shell.rejoin")}
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							{i18n.t("collab.shell.newLink")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
