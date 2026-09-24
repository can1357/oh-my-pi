import { Inbox, type LucideIcon } from "lucide-react";
import { useStatsI18n } from "../i18n";

export interface EmptyStateProps {
	message?: string;
	icon?: LucideIcon;
	className?: string;
}

export function EmptyState({ message, icon: Icon = Inbox, className = "" }: EmptyStateProps) {
	const { i18n } = useStatsI18n();
	return (
		<div className={`stats-empty-state ${className}`}>
			<Icon size={24} className="stats-empty-state-icon" aria-hidden="true" />
			<p className="stats-empty-state-message">{message ?? i18n.t("stats.ui.empty")}</p>
		</div>
	);
}
