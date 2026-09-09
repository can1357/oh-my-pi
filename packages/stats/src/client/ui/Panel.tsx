import type React from "react";

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
	title?: React.ReactNode;
	subtitle?: React.ReactNode;
	actions?: React.ReactNode;
}

export function Panel({ title, subtitle, actions, children, className = "", ...props }: PanelProps) {
	return (
		<div className={`stats-panel ${className}`} {...props}>
			{(title || subtitle || actions) && (
				<div className="stats-panel-header">
					<div className="stats-panel-header-titles">
						{title && <h3 className="stats-panel-title">{title}</h3>}
						{subtitle && <p className="stats-panel-subtitle">{subtitle}</p>}
					</div>
					{actions && <div className="stats-panel-actions">{actions}</div>}
				</div>
			)}
			<div className="stats-panel-body">{children}</div>
		</div>
	);
}
