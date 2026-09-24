import { useStatsI18n } from "../i18n";

export interface ErrorStateProps {
	error?: Error | null;
	onRetry?: () => void;
	className?: string;
}

export function ErrorState({ error, onRetry, className = "" }: ErrorStateProps) {
	const { i18n } = useStatsI18n();
	return (
		<div className={`stats-error-state ${className}`}>
			<div className="stats-error-state-content">
				<h4 className="stats-error-state-title">{i18n.t("stats.ui.error")}</h4>
				{error && <p className="stats-error-state-message">{error.message}</p>}
				{onRetry && (
					<button
						type="button"
						onClick={onRetry}
						className="stats-button stats-button-secondary stats-error-state-btn"
					>
						{i18n.t("stats.ui.retry")}
					</button>
				)}
			</div>
		</div>
	);
}
